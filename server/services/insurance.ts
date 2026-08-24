/**
 * server/services/insurance.ts — W27 micro-insurance service.
 *
 * Checkout integration: `quoteForOrder` prices an opt-in add-on (delivery
 * insurance, stock cover, …) in INTEGER CENTS against the order total;
 * `bindQuote` turns an accepted quote into a policy and persists the premium
 * onto the order's metadata.addOns (additive — orderCrud.ts is pinned).
 * The premium is therefore part of the customer's payable total via the same
 * metadata path other add-ons use.
 *
 * Parametric claim trigger hook: `handleParametricEvent` is an event-based
 * stub. A downstream event (e.g. {type: 'delivery_failed', orderId}) finds the
 * active policy bound to that order and files + auto-approves a claim for the
 * full coverage amount. Wire real event sources (courier webhooks, weather
 * feeds) by calling this function from the relevant webhook handlers.
 *
 * The partner adapter (services/insurance/adapters.ts, FROZEN CONTRACT) is
 * resolved per call from INSURANCE_ADAPTER (default 'mock').
 */
import { and, desc, eq } from "drizzle-orm";
import {
  insuranceClaims,
  insurancePolicies,
  insuranceProducts,
  insuranceQuotes,
  orders,
} from "../../drizzle/schema";
import {
  getInsuranceAdapterName,
  MockInsuranceAdapter,
  type InsuranceAdapter,
  type PartnerClaim,
  type PartnerPolicy,
  type PremiumQuote,
  type QuoteContext,
} from "./insurance/adapters";

export type Db = any;

export { computePremiumCents, getInsuranceAdapterName } from "./insurance/adapters";
export type { InsuranceAdapter, PremiumQuote, QuoteContext, PartnerPolicy, PartnerClaim };

/**
 * W30 (V1#2): honest deployment guard. The mock underwriter fabricates
 * approvals — fine for dev/test, never acceptable in production. When only
 * the mock adapter is available, the premium add-on is DISABLED in
 * production (fail honestly at quote time) instead of selling cover whose
 * claims can never really be paid by an underwriter.
 */
export function isMockOnlyDeployment(): boolean {
  return getInsuranceAdapterName() === "mock";
}

export function insuranceAddonDisabledReason(): string | null {
  // Read NODE_ENV dynamically so tests/ops can exercise the guard.
  const prod = (process.env.NODE_ENV ?? "").trim() === "production";
  if (isMockOnlyDeployment() && prod) {
    return "Insurance add-ons are unavailable in this deployment — no underwriter is configured (INSURANCE_ADAPTER=mock).";
  }
  return null;
}

function assertAddonEnabled(): void {
  const reason = insuranceAddonDisabledReason();
  if (reason) throw new Error(reason);
}

async function loadAdapter(db: Db, tenantId: string): Promise<InsuranceAdapter> {
  const name = getInsuranceAdapterName();
  if (name !== "mock") throw new Error(`insurance adapter not available: ${name}`);
  const products = await db.select().from(insuranceProducts).where(eq(insuranceProducts.tenantId, tenantId));
  const quotes = await db.select().from(insuranceQuotes).where(eq(insuranceQuotes.tenantId, tenantId));
  const policies = await db.select().from(insurancePolicies).where(eq(insurancePolicies.tenantId, tenantId));
  return new MockInsuranceAdapter(
    new Map(products.map((p: any) => [p.id, p])),
    new Map(quotes.map((q: any) => [q.id, {
      quoteRef: q.id, productId: q.productId, premiumCents: q.premiumCents,
      coverageCents: q.coverageCents, currency: q.currency, expiresAt: q.expiresAt,
      tenantId: q.tenantId, orderId: q.orderId ?? undefined, holderPhone: q.holderPhone ?? undefined,
    }])),
    new Map(policies.map((p: any) => [p.id, {
      policyNumber: p.policyNumber, quoteRef: p.quoteId, productId: p.productId,
      premiumCents: p.premiumCents, coverageCents: p.coverageCents, currency: p.currency, status: "active" as const,
    }])),
  );
}

export async function upsertProduct(db: Db, input: {
  tenantId: string; id: string; name: string; description?: string;
  premiumBps?: number; flatPremiumCents?: number; coverageCents: number; active?: boolean;
}) {
  if (!Number.isInteger(input.coverageCents) || input.coverageCents <= 0) throw new Error("coverageCents must be a positive integer");
  await db.insert(insuranceProducts).values({
    id: input.id, tenantId: input.tenantId, name: input.name,
    description: input.description ?? null,
    premiumBps: input.premiumBps ?? 0, flatPremiumCents: input.flatPremiumCents ?? 0,
    coverageCents: input.coverageCents, active: input.active ?? true,
  }).onConflictDoUpdate({
    target: insuranceProducts.id,
    set: {
      name: input.name, description: input.description ?? null,
      premiumBps: input.premiumBps ?? 0, flatPremiumCents: input.flatPremiumCents ?? 0,
      coverageCents: input.coverageCents, active: input.active ?? true,
    },
  });
  const [product] = await db.select().from(insuranceProducts).where(eq(insuranceProducts.id, input.id)).limit(1);
  return product;
}

export async function listProducts(db: Db, tenantId: string, activeOnly = true) {
  const rows = await db.select().from(insuranceProducts).where(eq(insuranceProducts.tenantId, tenantId));
  return activeOnly ? rows.filter((p: any) => p.active) : rows;
}

/** Price an opt-in add-on for an order. Premium in integer cents. */
export async function quoteForOrder(db: Db, input: {
  tenantId: string; productId: string; orderId?: string; holderPhone?: string;
  orderAmountCents: number; currency?: string;
}) {
  assertAddonEnabled(); // W30: mock-only production deployment fails honestly at quote time
  const adapter = await loadAdapter(db, input.tenantId);
  const q = await adapter.quote(input.productId, {
    tenantId: input.tenantId, orderId: input.orderId, holderPhone: input.holderPhone,
    orderAmountCents: input.orderAmountCents, currency: input.currency,
  });
  const [row] = await db.insert(insuranceQuotes).values({
    tenantId: input.tenantId, productId: input.productId, orderId: input.orderId ?? null,
    holderPhone: input.holderPhone ?? null,
    contextJson: { orderAmountCents: input.orderAmountCents, quoteRef: q.quoteRef } as any,
    premiumCents: q.premiumCents, coverageCents: q.coverageCents, currency: q.currency,
    expiresAt: q.expiresAt,
  }).returning();
  return row;
}

/**
 * Bind a quote → policy, and attach the premium to the order as an add-on
 * (metadata.addOns entry + metadata.insurancePremiumCents) so checkout totals
 * include it in integer cents. Idempotent per quote: rebinding a bound quote
 * returns the existing policy.
 */
export async function bindQuote(db: Db, input: { tenantId: string; quoteId: string }) {
  const [quote] = await db.select().from(insuranceQuotes).where(and(
    eq(insuranceQuotes.id, input.quoteId), eq(insuranceQuotes.tenantId, input.tenantId),
  )).limit(1);
  if (!quote) throw new Error("quote not found");
  if (quote.status === "bound") {
    const [existing] = await db.select().from(insurancePolicies).where(eq(insurancePolicies.quoteId, quote.id)).limit(1);
    return { policy: existing, alreadyBound: true };
  }
  if (quote.status !== "quoted") throw new Error(`quote is ${quote.status}`);

  const adapter = await loadAdapter(db, input.tenantId);
  const partner = await adapter.bind(quote.id);
  const [policy] = await db.insert(insurancePolicies).values({
    tenantId: input.tenantId, policyNumber: partner.policyNumber, quoteId: quote.id,
    productId: quote.productId, orderId: quote.orderId, holderPhone: quote.holderPhone,
    premiumCents: quote.premiumCents, coverageCents: quote.coverageCents, currency: quote.currency,
  }).returning();
  await db.update(insuranceQuotes).set({ status: "bound" }).where(eq(insuranceQuotes.id, quote.id));

  if (quote.orderId) {
    const [order] = await db.select().from(orders).where(eq(orders.id, quote.orderId)).limit(1).catch(() => []);
    if (order) {
      const meta = ((order.metadata as Record<string, unknown> | null) ?? {});
      const addOns = Array.isArray(meta.addOns) ? [...(meta.addOns as any[])] : [];
      if (!addOns.some((a: any) => a?.kind === "insurance" && a?.policyId === policy.id)) {
        addOns.push({
          kind: "insurance", policyId: policy.id, policyNumber: policy.policyNumber,
          productId: policy.productId, premiumCents: policy.premiumCents, coverageCents: policy.coverageCents,
        });
      }
      const premiumTotal = addOns
        .filter((a: any) => a?.kind === "insurance")
        .reduce((s: number, a: any) => s + (Number(a.premiumCents) || 0), 0);
      await db.update(orders).set({
        metadata: { ...meta, addOns, insurancePremiumCents: premiumTotal } as any,
      }).where(eq(orders.id, order.id));
    }
  }
  return { policy, alreadyBound: false };
}

/** File a claim (manual trigger) via the partner adapter. */
export async function fileClaim(db: Db, input: {
  tenantId: string; policyId: string; reason: string; trigger?: "manual" | "parametric";
}) {
  const [policy] = await db.select().from(insurancePolicies).where(and(
    eq(insurancePolicies.id, input.policyId), eq(insurancePolicies.tenantId, input.tenantId),
  )).limit(1);
  if (!policy) throw new Error("policy not found");
  if (policy.status !== "active") throw new Error(`policy is ${policy.status}`);

  const adapter = await loadAdapter(db, input.tenantId);
  const result = await adapter.claim(policy.id, input.reason);
  const payoutCents = result.status === "approved" ? result.payoutCents : null;
  // W30 (V1#2): an approved claim is NOT a paid claim. No money moves here —
  // the mock adapter's "approved" becomes `pending_payout` (honest vocab) and
  // the payout only lands via a real underwriter adapter or a manual ops
  // confirm (confirmClaimPayout). resolvedAt stays null until then.
  const [claim] = await db.insert(insuranceClaims).values({
    tenantId: input.tenantId, policyId: policy.id, reason: input.reason,
    trigger: input.trigger ?? "manual",
    status: result.status === "approved" ? "pending_payout" : result.status,
    payoutCents,
  }).returning();
  await db.update(insurancePolicies).set({ status: "claimed" }).where(eq(insurancePolicies.id, policy.id));
  return { claim, policy };
}

/**
 * Manual ops payout confirm (W30): marks a `pending_payout` claim paid after
 * ops has actually disbursed out-of-band. Guarded flip — only a pending
 * claim can be confirmed, exactly once. `note` records the evidence
 * (disbursement reference) for audit.
 */
export async function confirmClaimPayout(db: Db, input: {
  tenantId: string; claimId: string; note: string;
}) {
  if (!input.note?.trim()) throw new Error("payout evidence note required");
  const [claim] = await db.update(insuranceClaims).set({
    status: "paid",
    resolvedAt: new Date(),
  }).where(and(
    eq(insuranceClaims.id, input.claimId),
    eq(insuranceClaims.tenantId, input.tenantId),
    eq(insuranceClaims.status, "pending_payout"),
  )).returning();
  if (!claim) throw new Error("claim not found or not pending payout");
  return claim;
}

/**
 * Parametric claim trigger hook (event-based stub).
 *
 * Contract: `event` is a deterministic domain event, e.g.
 *   { type: 'delivery_failed', orderId }   → auto-claim on the order's policy
 *   { type: 'weather_shock', orderId }     → same path
 * The stub resolves the active policy bound to event.orderId and files a
 * parametric claim (auto-approved at full coverage by the mock adapter).
 * Returns null when no active policy matches (event ignored). Real triggers
 * call this from courier/weather webhook handlers; it is idempotent because
 * a claimed policy is no longer 'active'.
 */
export async function handleParametricEvent(db: Db, input: {
  tenantId: string; event: { type: string; orderId?: string };
}) {
  const { event } = input;
  if (!event.orderId) return null;
  const [policy] = await db.select().from(insurancePolicies).where(and(
    eq(insurancePolicies.tenantId, input.tenantId),
    eq(insurancePolicies.orderId, event.orderId),
    eq(insurancePolicies.status, "active"),
  )).limit(1);
  if (!policy) return null;
  return fileClaim(db, {
    tenantId: input.tenantId, policyId: policy.id,
    reason: `parametric:${event.type}`, trigger: "parametric",
  });
}

export async function listPolicies(db: Db, tenantId: string, holderPhone?: string) {
  const conds = [eq(insurancePolicies.tenantId, tenantId)];
  if (holderPhone) conds.push(eq(insurancePolicies.holderPhone, holderPhone));
  return db.select().from(insurancePolicies).where(and(...conds)).orderBy(desc(insurancePolicies.createdAt));
}

export async function listClaims(db: Db, tenantId: string, policyId?: string) {
  const conds = [eq(insuranceClaims.tenantId, tenantId)];
  if (policyId) conds.push(eq(insuranceClaims.policyId, policyId));
  return db.select().from(insuranceClaims).where(and(...conds)).orderBy(desc(insuranceClaims.createdAt));
}
