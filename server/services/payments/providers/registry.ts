/**
 * server/services/payments/providers/registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave-11 provider registry (P3 interim implementation of the P1 contract).
 *
 * EXPORTS (contract — P1 owns the final implementation; these signatures are
 * frozen so surfaces/routers never change when P1/P2 land):
 *
 *   listProviderAdapters() → the catalog of known provider adapters.
 *   getProviderForTenant(tenantId) → the tenant's ENABLED providers, ordered
 *     by ascending priority (1 = primary, 2 = first fallback, …).
 *
 * Resolution order:
 *   1. paymentGatewayConfigs rows for the tenant (isActive=true), priority
 *      from row metadata.priority (default 100). Creds are decrypted
 *      transparently (w10 envelope; legacy plaintext passes through).
 *   2. If the tenant has NO configured rows, the platform default Paystack
 *      adapter backed by PAYSTACK_SECRET_KEY (env) is returned at priority 0 —
 *      preserving pre-registry behavior for every existing tenant.
 *
 * Provider ids: "paystack" | "flutterwave" | "stripe" | "monnify" |
 * "manual" | "custom". A tenant "custom" row carries its settlement
 * instructions in metadata.instructions (validated by the router).
 */

import { eq, and } from "drizzle-orm";
import { getDb } from "../../../db";
import { paymentGatewayConfigs } from "../../../../drizzle/schema";
import { ENV } from "../../../_core/env";
import { decryptSecret } from "../../crypto/secrets";
import type {
  PaymentInitiateCtx,
  PaymentInitiateResult,
  PaymentProvider,
  TenantProviderCreds,
} from "./types";

// ── Built-in adapters ────────────────────────────────────────────────────────

function emailFor(ctx: PaymentInitiateCtx): string {
  return ctx.customer.email ?? `${ctx.customer.phone.replace(/\D/g, "") || "buyer"}@wa.commerce`;
}

const paystackAdapter: PaymentProvider = {
  id: "paystack",
  displayName: "Paystack",
  async initiate(ctx, creds) {
    const c = (creds ?? {}) as TenantProviderCreds;
    const secretKey = c.secretKey ?? ENV.paystackSecretKey;
    if (!secretKey) return { ok: false, reference: ctx.reference, provider: "paystack", error: "secret key not configured" };
    const res = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: emailFor(ctx),
        amount: ctx.amountCents, // Paystack minor units (kobo) == cents
        currency: ctx.currency,
        reference: ctx.reference,
        metadata: ctx.metadata,
        callback_url: ctx.callbackUrl ?? c.callbackUrl ?? `${ENV.appUrl}/api/webhooks/paystack/callback`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, reference: ctx.reference, provider: "paystack",
        error: `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}` };
    }
    const data = (await res.json()) as { status: boolean; data?: { authorization_url?: string } };
    if (!data.status || !data.data?.authorization_url) {
      return { ok: false, reference: ctx.reference, provider: "paystack", error: "Paystack returned status=false" };
    }
    return { ok: true, reference: ctx.reference, provider: "paystack",
      authorizationUrl: data.data.authorization_url, raw: data.data as Record<string, unknown> };
  },
};

const flutterwaveAdapter: PaymentProvider = {
  id: "flutterwave",
  displayName: "Flutterwave",
  async initiate(ctx, creds) {
    const c = (creds ?? {}) as TenantProviderCreds;
    const secretKey = c.secretKey ?? ENV.flwSecretKey;
    if (!secretKey) return { ok: false, reference: ctx.reference, provider: "flutterwave", error: "secret key not configured" };
    const res = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_ref: ctx.reference,
        amount: ctx.amountCents / 100, // Flutterwave takes major units
        currency: ctx.currency,
        redirect_url: ctx.callbackUrl ?? `${ENV.appUrl}/api/webhooks/flutterwave/callback`,
        customer: { email: emailFor(ctx), phonenumber: ctx.customer.phone },
        meta: ctx.metadata,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, reference: ctx.reference, provider: "flutterwave",
        error: `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}` };
    }
    const data = (await res.json()) as { status?: string; data?: { link?: string } };
    if (!data.data?.link) {
      return { ok: false, reference: ctx.reference, provider: "flutterwave", error: "Flutterwave returned no link" };
    }
    return { ok: true, reference: ctx.reference, provider: "flutterwave",
      authorizationUrl: data.data.link, raw: data.data as Record<string, unknown> };
  },
};

/** Offline settlement adapters (manual / custom): no network call — the buyer
 * receives human-readable instructions and ops reconciles via the existing
 * receipt-confirmation path. */
function instructionsAdapter(id: string, displayName: string): PaymentProvider {
  return {
    id,
    displayName,
    async initiate(ctx, creds) {
      const c = (creds ?? {}) as TenantProviderCreds;
      const instructions =
        (typeof c.metadata?.instructions === "string" && c.metadata.instructions.trim()) ||
        `Please pay ${(ctx.amountCents / 100).toFixed(2)} ${ctx.currency} quoting reference ${ctx.reference}. ` +
          `Send your receipt here to confirm.`;
      return { ok: true, reference: ctx.reference, provider: id, instructions };
    },
  };
}

const ADAPTERS: PaymentProvider[] = [
  paystackAdapter,
  flutterwaveAdapter,
  // stripe/monnify adapters land with P2 — listed so the catalog/UI is stable.
  instructionsAdapter("stripe", "Stripe"),
  instructionsAdapter("monnify", "Monnify"),
  instructionsAdapter("manual", "Manual / Bank Transfer"),
  instructionsAdapter("custom", "Custom Gateway"),
];

/** Frozen P1 contract: catalog of provider adapters. */
export function listProviderAdapters(): { id: string; displayName: string }[] {
  return ADAPTERS.map(({ id, displayName }) => ({ id, displayName }));
}

export interface TenantProviderEntry {
  provider: PaymentProvider;
  creds: unknown;
  config: { priority: number };
}

/** Frozen P1 contract: enabled, priority-ordered fallback chain for a tenant. */
export async function getProviderForTenant(tenantId: string): Promise<TenantProviderEntry[]> {
  const db = await getDb();
  if (db) {
    const rows = await db
      .select()
      .from(paymentGatewayConfigs)
      .where(and(eq(paymentGatewayConfigs.tenantId, tenantId), eq(paymentGatewayConfigs.isActive, true)))
      .catch(() => [] as typeof paymentGatewayConfigs.$inferSelect[]);
    const entries: TenantProviderEntry[] = [];
    for (const row of rows) {
      const adapter = ADAPTERS.find((a) => a.id === row.provider);
      if (!adapter) continue;
      const meta = (row.metadata as Record<string, unknown> | null) ?? {};
      const priority = typeof meta.priority === "number" && meta.priority > 0 ? meta.priority : 100;
      entries.push({
        provider: adapter,
        creds: {
          publicKey: row.publicKey,
          // Stored encrypted (v1:) since w10 — decryptSecret passes legacy
          // plaintext through unchanged.
          secretKey: row.secretKey ? decryptSecret(row.secretKey) : null,
          webhookSecret: row.webhookSecret ? decryptSecret(row.webhookSecret) : null,
          callbackUrl: row.callbackUrl,
          metadata: meta,
        } satisfies TenantProviderCreds,
        config: { priority },
      });
    }
    if (entries.length > 0) {
      entries.sort((a, b) => a.config.priority - b.config.priority);
      return entries;
    }
  }
  // Platform default: env-backed Paystack (pre-registry behavior).
  if (ENV.paystackSecretKey) {
    return [{ provider: paystackAdapter, creds: null, config: { priority: 0 } }];
  }
  return [];
}
