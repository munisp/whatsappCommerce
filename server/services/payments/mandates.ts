/**
 * Payment mandates (W13) — repayment-at-source authorization lifecycle.
 *
 * A mandate is a buyer tenant's standing authorization letting the platform
 * debit them at source for trade-credit repayments. This module owns the
 * payment_mandates persistence + provider orchestration; the provider-side
 * contract (createMandate / chargeMandate / revokeMandate optional members on
 * PaymentProvider) is implemented by the payments wave — we code against the
 * OPTIONAL members structurally and fail closed whenever the resolved
 * provider does not implement them.
 *
 * FAIL-CLOSED / NEVER-THROW contract: every public function returns a result
 * object; provider errors, missing config and unknown mandate refs all
 * resolve to { ok: false, error } — callers never see an exception from the
 * money path here.
 *
 * DEV ESCAPE: when NO mandate-capable provider is configured, a fake
 * mandate ('fake' provider) is issued ONLY outside production
 * (NODE_ENV=development|test), so local/dev flows stay exercisable. In
 * production the absence of a mandate-capable provider fails closed.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { paymentMandates, type PaymentMandate } from "../../../drizzle/schema";
import { isProd } from "../../_core/env";
import { getMandateCapableProviders as registryMandateCapable } from "./providers/registry";
import type { TenantProviderEntry } from "./providers/registry";
import type { PaymentProvider } from "./providers/types";

export type {
  MandateChargeCtx,
  MandateChargeResult,
  MandateCreateCtx,
  MandateCreateResult,
} from "./providers/types";

/** PaymentProvider with the (optional) mandate capability present. */
export type MandateCapableProvider = PaymentProvider;

export type MandateProviderEntry = TenantProviderEntry;

/**
 * Resolve mandate-capable providers for a tenant via the registry helper
 * (provider-side wave). Fail-closed: any registry error resolves to an
 * empty list.
 */
export async function getMandateCapableProviders(tenantId: string): Promise<MandateProviderEntry[]> {
  try {
    const entries = await registryMandateCapable(tenantId);
    return (entries ?? []).filter(
      (e) => e?.provider?.supportsMandates === true && typeof e.provider.createMandate === "function",
    );
  } catch (err: any) {
    console.error("[payments/mandates] provider resolution failed:", err?.message);
    return [];
  }
}

/** Test hook: inject a fixed mandate-capable provider chain. */
let providerOverride: ((tenantId: string) => Promise<MandateProviderEntry[]>) | null = null;
export function __setMandateProvidersForTests(
  fn: ((tenantId: string) => Promise<MandateProviderEntry[]>) | null,
): void {
  providerOverride = fn;
}
async function resolveProviders(tenantId: string): Promise<MandateProviderEntry[]> {
  if (providerOverride) return providerOverride(tenantId);
  return getMandateCapableProviders(tenantId);
}

// ── Types ────────────────────────────────────────────────────────────────────
export type MandateStatus = "pending" | "active" | "revoked" | "failed";

export interface CreateMandateArgs {
  tenantId: string;
  customerRef?: string;
  amountLimitCents?: number;
  currency?: string;
  email?: string;
  phone?: string;
  metadata?: Record<string, unknown>;
}
export interface CreateMandateResult {
  ok: boolean;
  mandateId?: string;
  mandateRef?: string;
  /** 'pending' needs authorization; 'active' only for dev fake mandates. */
  status?: MandateStatus;
  authorizationUrl?: string;
  instructions?: string;
  provider?: string;
  error?: string;
}

export interface ChargeMandateArgs {
  tenantId: string;
  /** payment_mandates.id (preferred) or a raw provider mandateRef. */
  mandateId?: string;
  mandateRef?: string;
  amountCents: number;
  currency?: string;
  reference: string;
  metadata?: Record<string, unknown>;
}
export interface ChargeMandateResult {
  ok: boolean;
  reference?: string;
  status?: "success" | "pending" | "failed";
  provider?: string;
  error?: string;
}

// ── Row helpers ──────────────────────────────────────────────────────────────
export async function getMandateByIdTx(db: any, mandateId: string): Promise<PaymentMandate | null> {
  const [row] = await db.select().from(paymentMandates).where(eq(paymentMandates.id, mandateId)).limit(1);
  return row ?? null;
}

/** Latest ACTIVE mandate for a tenant (any provider), or null. */
export async function getActiveMandateForTenantTx(db: any, tenantId: string): Promise<PaymentMandate | null> {
  const rows = await db
    .select()
    .from(paymentMandates)
    .where(and(eq(paymentMandates.tenantId, tenantId), eq(paymentMandates.status, "active")))
    .limit(1);
  return rows[0] ?? null;
}

// ── Create ───────────────────────────────────────────────────────────────────
/**
 * Create a mandate for a tenant via the first mandate-capable provider and
 * persist the payment_mandates row ('pending'; the authorization callback /
 * confirmMandateTx flips it to 'active'). Dev escape: with no capable
 * provider and NODE_ENV != production, issue a locally-'active' fake mandate.
 */
export async function createMandateForTenant(
  db: any,
  args: CreateMandateArgs,
): Promise<CreateMandateResult> {
  try {
    const currency = (args.currency ?? "NGN").toUpperCase();
    const chain = await resolveProviders(args.tenantId);
    const entry = chain[0];
    if (!entry || typeof entry.provider.createMandate !== "function") {
      if (isProd) {
        return { ok: false, error: "no_mandate_capable_provider" };
      }
      // Dev/test-only fake mandate — keeps local flows exercisable.
      const mandateRef = `fake-${randomUUID()}`;
      const [row] = await db
        .insert(paymentMandates)
        .values({
          tenantId: args.tenantId,
          provider: "fake",
          mandateRef,
          customerRef: args.customerRef ?? null,
          status: "active",
          metadata: { ...(args.metadata ?? {}), devFakeMandate: true },
        })
        .returning();
      console.warn(`[payments/mandates] dev fake mandate issued for tenant ${args.tenantId} (no mandate-capable provider)`);
      return { ok: true, mandateId: row.id, mandateRef, status: "active", provider: "fake" };
    }

    const res = await entry.provider.createMandate(
      {
        tenantId: args.tenantId,
        customerRef: args.customerRef ?? args.tenantId,
        amountLimitCents: args.amountLimitCents,
        currency,
        email: args.email,
        phone: args.phone,
        metadata: args.metadata,
      },
      entry.creds,
    );
    if (!res?.ok || !res.mandateRef) {
      return { ok: false, provider: entry.provider.id, error: res?.error ?? "mandate_create_failed" };
    }
    const [row] = await db
      .insert(paymentMandates)
      .values({
        tenantId: args.tenantId,
        provider: entry.provider.id,
        mandateRef: res.mandateRef,
        customerRef: args.customerRef ?? null,
        status: "pending",
        metadata: args.metadata ?? null,
      })
      .returning();
    return {
      ok: true,
      mandateId: row.id,
      mandateRef: res.mandateRef,
      status: "pending",
      authorizationUrl: res.authorizationUrl,
      instructions: res.instructions,
      provider: entry.provider.id,
    };
  } catch (err: any) {
    console.error("[payments/mandates] createMandateForTenant failed:", err?.message);
    return { ok: false, error: err?.message ?? "mandate_create_error" };
  }
}

/**
 * Confirm a pending mandate (explicit user confirm or authorization
 * callback/webhook): claim-first pending → active. Returns the updated row,
 * or null when the mandate does not belong to the tenant / is not pending.
 */
export async function confirmMandateTx(
  db: any,
  args: { tenantId: string; mandateId: string },
): Promise<PaymentMandate | null> {
  const [row] = await db
    .update(paymentMandates)
    .set({ status: "active", updatedAt: new Date() })
    .where(
      and(
        eq(paymentMandates.id, args.mandateId),
        eq(paymentMandates.tenantId, args.tenantId),
        eq(paymentMandates.status, "pending"),
      ),
    )
    .returning();
  return row ?? null;
}

// ── Charge ───────────────────────────────────────────────────────────────────
/**
 * Charge an active mandate. NEVER throws; fail-closed on every doubt
 * (unknown/inactive mandate, provider missing or not mandate-capable,
 * provider error). 'pending' charges return ok:true with status 'pending'
 * so callers can reconcile later; only 'success' means money moved.
 */
export async function chargeOnMandate(db: any, args: ChargeMandateArgs): Promise<ChargeMandateResult> {
  try {
    const amountCents = Math.round(args.amountCents);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return { ok: false, error: "invalid_amount" };
    }
    let mandate: PaymentMandate | null = null;
    if (args.mandateId) {
      mandate = await getMandateByIdTx(db, args.mandateId);
      if (mandate && mandate.tenantId !== args.tenantId) mandate = null; // tenant scoping
    } else if (args.mandateRef) {
      const [row] = await db
        .select()
        .from(paymentMandates)
        .where(and(eq(paymentMandates.tenantId, args.tenantId), eq(paymentMandates.mandateRef, args.mandateRef)))
        .limit(1);
      mandate = row ?? null;
    }
    if (!mandate) return { ok: false, error: "mandate_not_found" };
    if (mandate.status !== "active") return { ok: false, error: `mandate_not_active:${mandate.status}` };

    // Dev fake mandates "charge" locally — success without provider I/O.
    if (mandate.provider === "fake" && !isProd) {
      return { ok: true, reference: args.reference, status: "success", provider: "fake" };
    }

    const chain = await resolveProviders(args.tenantId);
    const entry = chain.find(
      (e) => e.provider.id === mandate!.provider && typeof e.provider.chargeMandate === "function",
    );
    if (!entry || typeof entry.provider.chargeMandate !== "function") {
      return { ok: false, error: "provider_not_mandate_capable", provider: mandate.provider };
    }
    const res = await entry.provider.chargeMandate(
      {
        mandateRef: mandate.mandateRef,
        amountCents,
        currency: (args.currency ?? "NGN").toUpperCase(),
        reference: args.reference,
        metadata: args.metadata,
      },
      entry.creds,
    );
    if (!res?.ok) {
      return { ok: false, provider: entry.provider.id, status: "failed", error: res?.error ?? "mandate_charge_failed" };
    }
    return { ok: true, reference: res.reference ?? args.reference, status: res.status, provider: entry.provider.id };
  } catch (err: any) {
    console.error("[payments/mandates] chargeOnMandate failed:", err?.message);
    return { ok: false, error: err?.message ?? "mandate_charge_error" };
  }
}

// ── Charge status probe (A1-02/F-03) ─────────────────────────────────────────
/**
 * Read-only status lookup for a previously attempted mandate charge. Used by
 * the pending-charge reconciler (tradeCredit/capture.reconcilePendingMandateCharges)
 * — the ONLY production caller of provider fetchStatus. NEVER re-charges.
 * Returns 'unknown' on any failure (provider missing, not mandate-capable,
 * timeout, network error) so the reconciler leaves the row for the next
 * sweep instead of guessing.
 */
export async function fetchMandateChargeStatus(
  tenantId: string,
  args: { provider: string; reference: string; timeoutMs?: number },
): Promise<{ status: "pending" | "success" | "failed" | "unknown"; amountCents?: number }> {
  const timeoutMs = args.timeoutMs ?? 10_000;
  try {
    const chain = await resolveProviders(tenantId);
    const entry = chain.find((e) => e.provider.id === args.provider);
    if (!entry || typeof entry.provider.fetchStatus !== "function") {
      return { status: "unknown" };
    }
    const res = await Promise.race([
      entry.provider.fetchStatus(args.reference, entry.creds),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("fetch_status_timeout")), timeoutMs)),
    ]);
    if (!res || (res.status !== "success" && res.status !== "failed" && res.status !== "pending")) {
      return { status: "unknown" };
    }
    return { status: res.status, amountCents: res.amountCents };
  } catch (err: any) {
    console.warn(`[payments/mandates] fetchMandateChargeStatus ${args.reference}: ${err?.message}`);
    return { status: "unknown" };
  }
}

// ── Revoke ───────────────────────────────────────────────────────────────────
/**
 * Revoke a mandate: best-effort provider revoke, then claim-first local
 * status flip (active|pending → revoked). Never throws.
 */
export async function revokeMandate(
  db: any,
  args: { tenantId: string; mandateId: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const mandate = await getMandateByIdTx(db, args.mandateId);
    if (!mandate || mandate.tenantId !== args.tenantId) return { ok: false, error: "mandate_not_found" };
    if (mandate.status === "revoked") return { ok: true };

    if (mandate.provider !== "fake") {
      try {
        const chain = await resolveProviders(args.tenantId);
        const entry = chain.find(
          (e) => e.provider.id === mandate.provider && typeof e.provider.revokeMandate === "function",
        );
        if (entry?.provider.revokeMandate) {
          const res = await entry.provider.revokeMandate(mandate.mandateRef, entry.creds);
          if (!res?.ok) {
            console.warn(`[payments/mandates] provider revoke failed for ${mandate.mandateRef} — revoking locally anyway`);
          }
        }
      } catch (err: any) {
        console.warn(`[payments/mandates] provider revoke error for ${mandate.mandateRef}: ${err?.message}`);
      }
    }

    const [row] = await db
      .update(paymentMandates)
      .set({ status: "revoked", updatedAt: new Date() })
      .where(and(eq(paymentMandates.id, mandate.id), eq(paymentMandates.status, mandate.status)))
      .returning({ id: paymentMandates.id });
    return row ? { ok: true } : { ok: false, error: "revoke_claim_failed" };
  } catch (err: any) {
    console.error("[payments/mandates] revokeMandate failed:", err?.message);
    return { ok: false, error: err?.message ?? "mandate_revoke_error" };
  }
}
