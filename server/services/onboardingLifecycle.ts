// === W47 merchant ===
/**
 * onboardingLifecycle.ts — single source of truth for tenant go-live and
 * the paid-order-intake lifecycle gate (W47 merchant findings).
 *
 * ONB-M-1 / ONB-M-2: there were THREE un-gated go-live paths (legacy
 * onboarding.complete, chat-copilot goLive, web activate) with different
 * security postures. `goLiveTenant()` is now the ONLY way a tenant flips
 * to live: it enforces passed validation AND the hard KYB precondition
 * (services/kycGate, fail-closed in production) regardless of entry point.
 *
 * ONB-M-5 / ONB-M-8: paid order intake is gated on lifecycle. A tenant may
 * only receive commerce traffic when tenants.status === 'active' AND the
 * onboarding state is 'live' AND — for previously-live tenants — KYB is
 * approved or inside the re-verification grace window (KYB_GRACE_DAYS).
 * Blocked buyers get an honest auto-reply on BOTH channels (WhatsApp via
 * the webhook dispatcher, Telegram via dispatchToNlp) instead of a silent
 * dead-end.
 *
 * ONB-M-14: initial payout-destination capture during onboarding
 * (setInitialPayoutBank) — only writes when the wallet has no bank details
 * yet; changes after that stay behind escrow.updatePayoutBankDetails
 * (step-up OTP).
 *
 * ONB-M-18: sweepAbandonedOnboardingTenants reaps draft/configuring/failed
 * tenants (nudge at NUDGE_AFTER_DAYS, churn at CHURN_AFTER_DAYS when the
 * tenant has no orders), idempotent via the onboarding_reengagement_log
 * ledger (mig 0164). Cascade-abandons copilot-created tenants the same way.
 */
import { eq, and, inArray, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  tenants,
  kycApplications,
  merchantWallets,
  orders,
  onboardingReengagementLog,
} from "../../drizzle/schema";
import type { TenantSettings } from "../../shared/tenantConfig";
import {
  getOnboardingState,
  setOnboardingStatus,
  updateTenantSettings,
  type OnboardingState,
} from "./onboarding";
import { requireApprovedKyb } from "./kycGate";
import { writeAuditLog } from "../routers/audit";
import { notifyTenantAdminWhatsApp } from "./adminAlerts";

type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Re-verification grace for a LIVE tenant whose KYB lapses (ONB-M-8). */
export const KYB_GRACE_DAYS = 14;
/** Abandoned-onboarding sweep cadence (ONB-M-18). */
export const NUDGE_AFTER_DAYS = 7;
export const CHURN_AFTER_DAYS = 45;

// ─── Go-live (ONB-M-1 / ONB-M-2) ─────────────────────────────────────────────

export interface GoLiveOptions {
  actorId?: string | null;
  actorRole?: string | null;
  /** Entry point for the audit row: "web-activate" | "legacy-complete" | "chat-copilot". */
  source: string;
}

/**
 * The single go-live gate. Throws PRECONDITION_FAILED when validation has
 * not passed and FORBIDDEN (via requireApprovedKyb) without an approved KYB
 * application. Idempotent: an already-live tenant returns its state.
 */
export async function goLiveTenant(tenantId: string, opts: GoLiveOptions): Promise<OnboardingState> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const [tenant] = await db
    .select({ id: tenants.id, settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
  const state = getOnboardingState(tenant.settings);
  if (state.status === "live") return state;
  if (state.status !== "validating" || !state.validationPassed) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Cannot go live: validation has not passed (status=${state.status}). Run onboarding.validate first.`,
    });
  }
  // Hard KYB gate — identical for web activate, legacy complete and the
  // chat copilot. Fails closed in production (services/kycGate).
  await requireApprovedKyb(tenantId, db);
  const next = await setOnboardingStatus(tenantId, "live");
  await db
    .update(tenants)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(tenants.id, tenantId));
  await writeAuditLog({
    actorId: opts.actorId ?? null,
    actorRole: opts.actorRole ?? null,
    action: "onboarding.go_live",
    entityType: "tenant",
    entityId: tenantId,
    tenantId,
    summary: `Tenant ${tenantId} went live via ${opts.source} (validation passed + KYB approved)`,
    before: { onboardingStatus: state.status, tenantStatus: "trial" },
    after: { onboardingStatus: "live", tenantStatus: "active" },
  });
  return next;
}

// ─── Paid-order-intake gate (ONB-M-5 / ONB-M-8) ─────────────────────────────

export type IntakeBlockReason = "not_open" | "kyb_lapsed";

export interface OrderIntakeDecision {
  allowed: boolean;
  reason: IntakeBlockReason | null;
  /** Honest, buyer-facing explanation for blocked stores. */
  buyerMessage: string | null;
}

export function buyerMessageFor(reason: IntakeBlockReason): string {
  if (reason === "kyb_lapsed") {
    return (
      "Thanks for reaching out! This store is temporarily paused while the owner renews " +
      "their business verification — no new orders can be taken right now. Please try again " +
      "in a few days. 🙏"
    );
  }
  return (
    "Thanks for reaching out! This store isn't open for orders yet — the owner is still " +
    "setting things up. Please check back soon. 🙏"
  );
}

/**
 * Pure lifecycle evaluation (no db): tenants that are not 'active' or whose
 * onboarding state is not 'live' may not receive paid orders.
 */
export function evaluateLifecycleIntake(tenant: {
  id: string;
  status: string | null;
  settings: unknown;
}): OrderIntakeDecision {
  const state = getOnboardingState(tenant.settings);
  if (tenant.status !== "active" || state.status !== "live") {
    return { allowed: false, reason: "not_open", buyerMessage: buyerMessageFor("not_open") };
  }
  return { allowed: true, reason: null, buyerMessage: null };
}

/**
 * Full intake decision for a live-looking tenant: lifecycle check plus KYB
 * lapse handling (ONB-M-8). A live tenant with an expired/rejected KYB gets
 * KYB_GRACE_DAYS from the restriction stamp (settings.onboarding.kybRestrictedAt)
 * to re-verify; after that, new order intake stops with an honest buyer
 * message. Payouts of earned funds are unaffected (kycGate only blocks new
 * withdrawals).
 *
 * Failure doctrine: a definitive "no approved KYB" blocks after grace; a db
 * ERROR on the KYB lookup fails OPEN (logged) — the tenant was KYB-approved
 * at go-live and a transient read failure must not halt all commerce.
 */
export async function checkOrderIntakeAllowed(
  db: DbHandle,
  tenant: { id: string; status: string | null; settings: unknown },
): Promise<OrderIntakeDecision> {
  const lifecycle = evaluateLifecycleIntake(tenant);
  if (!lifecycle.allowed) return lifecycle;

  // Live tenant: is there still an approved KYB?
  let rows: { status: string }[] = [];
  try {
    rows = await db
      .select({ status: kycApplications.status })
      .from(kycApplications)
      .where(and(eq(kycApplications.tenantId, tenant.id), eq(kycApplications.type, "kyb")))
      .orderBy(desc(kycApplications.createdAt))
      .limit(5);
  } catch (e: any) {
    console.error(`[intake-gate] KYB lookup failed for tenant ${tenant.id} — allowing (fail-open):`, e?.message);
    return { allowed: true, reason: null, buyerMessage: null };
  }
  if (rows.some((r) => r.status === "approved")) {
    return { allowed: true, reason: null, buyerMessage: null };
  }
  // KYB lapsed — grace window from the restriction stamp (or from now when
  // the stamp is missing, so legacy live tenants are not hard-cut overnight).
  const settings = (tenant.settings ?? {}) as TenantSettings;
  const ob = (settings.onboarding ?? {}) as Record<string, unknown>;
  const restrictedAt = typeof ob.kybRestrictedAt === "string" ? Date.parse(ob.kybRestrictedAt) : NaN;
  const graceStart = Number.isFinite(restrictedAt) ? restrictedAt : Date.now();
  if (Date.now() < graceStart + KYB_GRACE_DAYS * 86_400_000) {
    return { allowed: true, reason: null, buyerMessage: null };
  }
  return { allowed: false, reason: "kyb_lapsed", buyerMessage: buyerMessageFor("kyb_lapsed") };
}

/**
 * Stamp the KYB-restriction grace window on a LIVE tenant (ONB-M-8): called
 * when a KYB application for a live tenant is rejected or expires. Audited;
 * the tenant admin is notified over WhatsApp. Intake keeps flowing for
 * KYB_GRACE_DAYS, then checkOrderIntakeAllowed blocks new orders.
 */
export async function applyKybRestriction(
  db: DbHandle,
  tenantId: string,
  reason: "rejected" | "expired",
): Promise<void> {
  const [tenant] = await db
    .select({ id: tenants.id, status: tenants.status, settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  if (!tenant || tenant.status !== "active") return; // only live tenants need the grace stamp
  const state = getOnboardingState(tenant.settings);
  if (state.status !== "live") return;
  const already = (tenant.settings as TenantSettings | null)?.onboarding as Record<string, unknown> | undefined;
  if (typeof already?.kybRestrictedAt === "string") return; // stamp once — don't extend by re-stamping
  const now = new Date();
  await updateTenantSettings(tenantId, (s) => {
    s.onboarding = {
      ...(s.onboarding ?? { status: "live" }),
      kybRestrictedAt: now.toISOString(),
      kybRestrictionReason: reason,
    };
  });
  await writeAuditLog({
    actorId: null,
    actorRole: "system",
    action: "onboarding.kyb_restriction",
    entityType: "tenant",
    entityId: tenantId,
    tenantId,
    summary: `KYB ${reason} for live tenant ${tenantId} — ${KYB_GRACE_DAYS}d re-verification grace started; new order intake blocks after ${new Date(now.getTime() + KYB_GRACE_DAYS * 86_400_000).toISOString()} unless KYB is re-approved`,
    before: null,
    after: { kybRestrictedAt: now.toISOString(), reason },
  });
  await notifyTenantAdminWhatsApp(
    db,
    tenantId,
    `⚠️ Your business verification (KYB) was ${reason}. You have ${KYB_GRACE_DAYS} days to re-verify from the portal before your store stops accepting new orders. Payouts of earned funds are not affected.`,
  );
}

/** Clear the KYB grace stamp when a fresh approval lands (re-verification). */
export async function clearKybRestriction(db: DbHandle, tenantId: string): Promise<void> {
  await updateTenantSettings(tenantId, (s) => {
    const ob = (s.onboarding ?? {}) as Record<string, unknown>;
    if (ob.kybRestrictedAt) {
      delete ob.kybRestrictedAt;
      delete ob.kybRestrictionReason;
      s.onboarding = ob as TenantSettings["onboarding"];
    }
  });
}

// ─── Initial payout capture (ONB-M-14) ──────────────────────────────────────
/**
 * Onboarding-time initial payout-destination capture. Only writes when the
 * tenant's wallet has NO bank details yet — any later change must go through
 * escrow.updatePayoutBankDetails (step-up OTP). Creates the wallet row when
 * missing (same lazy shape as escrow.getOrCreateWallet).
 */
export async function setInitialPayoutBank(
  tenantId: string,
  details: { bankAccountName: string; bankAccountNumber: string; bankCode: string },
): Promise<{ ok: true; alreadyConfigured: boolean }> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const [wallet] = await db
    .select()
    .from(merchantWallets)
    .where(eq(merchantWallets.tenantId, tenantId))
    .limit(1);
  if (wallet?.bankAccountNumber) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Payout bank details are already configured — use the escrow payout settings (step-up verification required).",
    });
  }
  if (wallet) {
    await db
      .update(merchantWallets)
      .set({
        bankAccountName: details.bankAccountName,
        bankAccountNumber: details.bankAccountNumber,
        bankCode: details.bankCode,
        updatedAt: new Date(),
      })
      .where(eq(merchantWallets.tenantId, tenantId));
  } else {
    await db.insert(merchantWallets).values({
      tenantId,
      bankAccountName: details.bankAccountName,
      bankAccountNumber: details.bankAccountNumber,
      bankCode: details.bankCode,
    });
  }
  await writeAuditLog({
    actorId: null,
    actorRole: null,
    action: "onboarding.payout_bank_set",
    entityType: "tenant",
    entityId: tenantId,
    tenantId,
    summary: `Initial payout bank details captured during onboarding for tenant ${tenantId} (bank ${details.bankCode}, acct …${details.bankAccountNumber.slice(-4)})`,
    before: null,
    after: { bankCode: details.bankCode },
  });
  return { ok: true, alreadyConfigured: false };
}

/** Readiness flag for getStatus/dashboard (ONB-M-14). */
export async function isPayoutConfigured(db: DbHandle, tenantId: string): Promise<boolean> {
  const [wallet] = await db
    .select({ bankAccountNumber: merchantWallets.bankAccountNumber })
    .from(merchantWallets)
    .where(eq(merchantWallets.tenantId, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  return Boolean(wallet?.bankAccountNumber);
}

// ─── Abandoned-onboarding sweep (ONB-M-18) ──────────────────────────────────

export interface AbandonedSweepResult {
  nudged: number;
  churned: number;
  skipped: number;
}

/**
 * Reap half-onboarded tenants: nudge the admin at NUDGE_AFTER_DAYS, churn at
 * CHURN_AFTER_DAYS when the tenant has never taken an order. Idempotent via
 * the onboarding_reengagement_log ledger (one row per tenant+kind, insert-
 * first claim). Live tenants are never touched; copilot-created tenants that
 * abandoned mid-chat are the same draft rows and are swept identically.
 */
export async function sweepAbandonedOnboardingTenants(
  db: DbHandle,
  now: Date = new Date(),
): Promise<AbandonedSweepResult> {
  const result: AbandonedSweepResult = { nudged: 0, churned: 0, skipped: 0 };
  const candidates = await db
    .select({
      id: tenants.id,
      status: tenants.status,
      settings: tenants.settings,
      createdAt: tenants.createdAt,
    })
    .from(tenants)
    .where(inArray(tenants.status, ["trial"]))
    .catch(() => [] as any[]);

  for (const t of candidates) {
    const state = getOnboardingState(t.settings);
    if (state.status === "live") { result.skipped++; continue; }
    const ageMs = now.getTime() - new Date(t.createdAt).getTime();
    const ageDays = ageMs / 86_400_000;
    if (ageDays < NUDGE_AFTER_DAYS) { result.skipped++; continue; }

    // Never churn a tenant that has actually traded.
    const [orderRow] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.tenantId, t.id))
      .limit(1)
      .catch(() => [] as any[]);
    const hasOrders = Boolean(orderRow);
    const kind = !hasOrders && ageDays >= CHURN_AFTER_DAYS ? "churn45d" : "nudge7d";

    // Claim-first: one ledger row per (tenant, kind) — a re-run is a no-op.
    const claimed = await db
      .insert(onboardingReengagementLog)
      .values({ tenantId: t.id, kind, sentAt: now })
      .onConflictDoNothing()
      .returning({ tenantId: onboardingReengagementLog.tenantId })
      .catch((e: any) => {
        console.error(`[onboarding-sweep] ledger insert failed for ${t.id}/${kind}:`, e?.message);
        return [] as any[];
      });
    if (!claimed.length) { result.skipped++; continue; }

    if (kind === "churn45d") {
      await db
        .update(tenants)
        .set({ status: "churned", updatedAt: now })
        .where(and(eq(tenants.id, t.id), eq(tenants.status, "trial")));
      await writeAuditLog({
        actorId: null,
        actorRole: "system",
        action: "onboarding.abandoned_churn",
        entityType: "tenant",
        entityId: t.id,
        tenantId: t.id,
        summary: `Abandoned onboarding: tenant ${t.id} churned after ${Math.floor(ageDays)}d in '${state.status}' with no orders`,
        before: { status: "trial", onboardingStatus: state.status },
        after: { status: "churned" },
      });
      result.churned++;
    } else {
      await notifyTenantAdminWhatsApp(
        db,
        t.id,
        "👋 Your store setup isn't finished yet — complete onboarding from your portal to start accepting orders. Need help? Just reply here.",
      );
      result.nudged++;
    }
  }
  return result;
}
