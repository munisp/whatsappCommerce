// === W65 conversational ===
/**
 * smartDefaults.ts — R10 smart defaults engine.
 *
 * One service, one router, every form/chat flow consumes it: given
 * (tenantId, userId, context) return the platform's best predicted value so
 * the user CONFIRMS instead of typing:
 *
 *   delivery_address — buyer's last-used shipping address (orders history)
 *   payout_account   — W59 primary merchant_payout_accounts row
 *   price_band       — catalogAI in-tenant comparables (suggestPriceCents)
 *   quantity         — order cadence from order_items history (median qty)
 *   payment_terms    — W56 credit-grade terms bands
 *
 * Corrections are LEARNING EVENTS: recordCorrection() inserts into the W62/
 * W64 ui_events table with action 'default_corrected' carrying
 * {context, suggested, actual} so future waves can retrain defaults.
 *
 * Everything here is read-only + ui_events inserts — fail-open telemetry,
 * never on the money path's critical section.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  creditScores,
  merchantPayoutAccounts,
  orderItems,
  orders,
  uiEvents,
} from "../../drizzle/schema";
import { captureException } from "./observability";

export const SMART_DEFAULT_CONTEXTS = [
  "delivery_address",
  "payout_account",
  "price_band",
  "quantity",
  "payment_terms",
] as const;
export type SmartDefaultContext = (typeof SMART_DEFAULT_CONTEXTS)[number];

/** W56 grade bands → suggested net payment terms (days; 0 = pay-now). */
export const GRADE_TERMS_DAYS: Record<string, number> = {
  A: 30,
  B: 21,
  C: 14,
  D: 7,
  E: 0,
};

export interface SmartDefaultResult<T = unknown> {
  context: SmartDefaultContext;
  /** null when the platform has no signal — the form stays manual. */
  value: T | null;
  /** 0..1 heuristic confidence; UI shows "suggested" badge when ≥ 0.5. */
  confidence: number;
  /** Human-readable provenance ("last order #…", "primary payout account"). */
  basis: string;
}

// ─── Per-context resolvers ───────────────────────────────────────────────────

async function deliveryAddressDefault(
  tenantId: string,
  userId: string | null,
): Promise<SmartDefaultResult> {
  const db = await getDb();
  if (!db) return { context: "delivery_address", value: null, confidence: 0, basis: "db unavailable" };
  const conds = [eq(orders.tenantId, tenantId), sql`${orders.shippingAddress} IS NOT NULL`];
  if (userId) conds.push(eq(orders.customerId, userId));
  const rows = await db
    .select({ shippingAddress: orders.shippingAddress, orderNumber: orders.orderNumber, customerId: orders.customerId })
    .from(orders)
    .where(and(...conds))
    .orderBy(desc(orders.createdAt))
    .limit(1)
    .catch(() => [] as any[]);
  // Fall back to the tenant's most recent address when the buyer has none.
  const rowsAny = rows.length > 0 ? rows : await db
    .select({ shippingAddress: orders.shippingAddress, orderNumber: orders.orderNumber })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), sql`${orders.shippingAddress} IS NOT NULL`))
    .orderBy(desc(orders.createdAt))
    .limit(1)
    .catch(() => [] as any[]);
  const row = rows[0] ?? rowsAny[0];
  if (!row?.shippingAddress) {
    return { context: "delivery_address", value: null, confidence: 0, basis: "no prior orders" };
  }
  const own = rows.length > 0;
  return {
    context: "delivery_address",
    value: row.shippingAddress,
    confidence: own ? 0.9 : 0.4,
    basis: `last used on order ${row.orderNumber}${own ? "" : " (tenant fallback)"}`,
  };
}

async function payoutAccountDefault(tenantId: string): Promise<SmartDefaultResult> {
  const db = await getDb();
  if (!db) return { context: "payout_account", value: null, confidence: 0, basis: "db unavailable" };
  const [row] = await db
    .select()
    .from(merchantPayoutAccounts)
    .where(and(
      eq(merchantPayoutAccounts.tenantId, tenantId),
      eq(merchantPayoutAccounts.isPrimary, true),
      eq(merchantPayoutAccounts.status, "active"),
    ))
    .limit(1)
    .catch(() => [] as any[]);
  if (!row) return { context: "payout_account", value: null, confidence: 0, basis: "no primary payout account" };
  return {
    context: "payout_account",
    value: {
      payoutAccountId: row.id,
      bankCode: row.bankCode,
      accountNumber: row.accountNumber,
      accountName: row.accountName,
      provider: row.provider,
      label: row.label,
    },
    confidence: 0.95,
    basis: "W59 primary payout account",
  };
}

async function priceBandDefault(
  tenantId: string,
  category: string | null,
): Promise<SmartDefaultResult> {
  const db = await getDb();
  if (!db) return { context: "price_band", value: null, confidence: 0, basis: "db unavailable" };
  try {
    const { suggestPriceCents } = await import("./catalogAI");
    const suggestion = await suggestPriceCents(db, tenantId, category);
    if (suggestion.suggestedPriceCents == null) {
      return { context: "price_band", value: null, confidence: 0, basis: "no comparable products" };
    }
    return {
      context: "price_band",
      value: suggestion,
      confidence: suggestion.basis === "tenant_category" ? 0.8 : 0.6,
      basis: `catalogAI comparables (${suggestion.basis}, n=${suggestion.sampleSize})`,
    };
  } catch (e) {
    captureException(e, { service: "smartDefaults", operation: "priceBand", tenantId });
    return { context: "price_band", value: null, confidence: 0, basis: "comparables unavailable" };
  }
}

async function quantityDefault(
  tenantId: string,
  productId: string | null,
): Promise<SmartDefaultResult> {
  const db = await getDb();
  if (!db) return { context: "quantity", value: null, confidence: 0, basis: "db unavailable" };
  if (!productId) return { context: "quantity", value: null, confidence: 0, basis: "no product given" };
  // Order cadence: median line qty over the product's last 50 order lines.
  const rows = await db
    .select({ quantity: orderItems.quantity })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(eq(orders.tenantId, tenantId), eq(orderItems.productId, productId)))
    .orderBy(desc(orders.createdAt))
    .limit(50)
    .catch(() => [] as any[]);
  if (rows.length === 0) return { context: "quantity", value: null, confidence: 0, basis: "no order history" };
  const qtys = rows.map((r) => r.quantity).sort((a, b) => a - b);
  const median = qtys[Math.floor(qtys.length / 2)];
  return {
    context: "quantity",
    value: { productId, quantity: median, sampleSize: rows.length },
    confidence: rows.length >= 10 ? 0.8 : 0.5,
    basis: `median of last ${rows.length} order lines`,
  };
}

async function paymentTermsDefault(
  tenantId: string,
  subjectId: string | null,
): Promise<SmartDefaultResult> {
  const db = await getDb();
  if (!db) return { context: "payment_terms", value: null, confidence: 0, basis: "db unavailable" };
  if (!subjectId) return { context: "payment_terms", value: null, confidence: 0, basis: "no subject given" };
  const [row] = await db
    .select({ grade: creditScores.grade, score: creditScores.score })
    .from(creditScores)
    .where(and(
      eq(creditScores.tenantId, tenantId),
      eq(creditScores.subjectType, "buyer"),
      eq(creditScores.subjectId, subjectId),
    ))
    .limit(1)
    .catch(() => [] as any[]);
  if (!row) return { context: "payment_terms", value: null, confidence: 0, basis: "no credit score" };
  const termsDays = GRADE_TERMS_DAYS[row.grade] ?? 0;
  return {
    context: "payment_terms",
    value: { grade: row.grade, score: row.score, termsDays, paymentMode: termsDays > 0 ? "credit" : "paynow" },
    confidence: 0.85,
    basis: `W56 grade ${row.grade} band → net ${termsDays}d`,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getDefaults(args: {
  tenantId: string;
  userId?: string | null;
  context: SmartDefaultContext;
  /** Context-specific selectors. */
  category?: string | null;
  productId?: string | null;
  subjectId?: string | null;
}): Promise<SmartDefaultResult> {
  const { tenantId, userId = null, context } = args;
  try {
    switch (context) {
      case "delivery_address": return await deliveryAddressDefault(tenantId, userId);
      case "payout_account": return await payoutAccountDefault(tenantId);
      case "price_band": return await priceBandDefault(tenantId, args.category ?? null);
      case "quantity": return await quantityDefault(tenantId, args.productId ?? null);
      case "payment_terms": return await paymentTermsDefault(tenantId, args.subjectId ?? null);
    }
  } catch (e) {
    // Fail-open: a defaults outage must never block a form.
    captureException(e, { service: "smartDefaults", operation: "getDefaults", tenantId });
    return { context, value: null, confidence: 0, basis: "defaults engine error" };
  }
}

/**
 * Learning event: the user changed a suggested default. Inserted into
 * ui_events (W62/W64 clickstream table) with action 'default_corrected';
 * fail-open (a lost learning event must never fail the underlying form).
 */
export async function recordCorrection(args: {
  tenantId: string | null;
  userId: string | null;
  sessionId?: string | null;
  app?: string | null;
  context: SmartDefaultContext;
  suggested: unknown;
  actual: unknown;
}): Promise<{ recorded: boolean }> {
  try {
    const db = await getDb();
    if (!db) return { recorded: false };
    await db.insert(uiEvents).values({
      tenantId: args.tenantId,
      userId: args.userId,
      sessionId: args.sessionId ?? null,
      app: args.app ?? null,
      page: `smartDefaults/${args.context}`,
      action: "default_corrected",
      metadata: { context: args.context, suggested: args.suggested ?? null, actual: args.actual ?? null },
    });
    return { recorded: true };
  } catch (e) {
    captureException(e, { service: "smartDefaults", operation: "recordCorrection", tenantId: args.tenantId ?? undefined });
    return { recorded: false };
  }
}
