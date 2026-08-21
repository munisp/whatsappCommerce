/**
 * server/services/loyalty.ts — W27 loyalty points (ledger-backed).
 *
 * FROZEN CONTRACT exports (SPEC_W27):
 *   awardPoints({tenantId, customerPhone, points, reason, orderId?}, db)
 *   redeemPoints({tenantId, customerPhone, points, reason, orderId?}, db)
 *
 * Design:
 * - Double-entry style ledger rows (loyalty_ledger): every movement records
 *   (debitAccount, creditAccount); earn credits the customer account from the
 *   platform points-liability account, redeem debits the customer back to the
 *   liability account. `balanceAfter` snapshots the running balance so
 *   balance reads are O(1).
 * - Per-tenant earn/burn rules (loyalty_rules, merchant-configurable):
 *   earn pointsPerUnit points per unitValueCents spent (default 1 pt / ₦100),
 *   redemption discount capped at redemptionCapPercent % of the order total,
 *   each point worth pointsValueCents integer cents (default ₦0.01 → 100 pts
 *   = ₦1 ... merchants typically raise this).
 * - Idempotency: earn rows are unique per (tenantId, orderId, 'earn') — the
 *   same order can never award twice, so the delivered-order sweep is safe
 *   to run repeatedly.
 * - Points and money are INTEGER (points, cents) throughout.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { loyaltyLedger, loyaltyRules, orders } from "../../drizzle/schema";
import { toMinorUnitsExact } from "../../shared/escrowAmounts";
import type { getDb } from "../db";

export type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface LoyaltyRules {
  enabled: boolean;
  pointsPerUnit: number;
  unitValueCents: number;
  pointsValueCents: number;
  redemptionCapPercent: number;
}

export const DEFAULT_LOYALTY_RULES: LoyaltyRules = {
  enabled: true,
  pointsPerUnit: 1,
  unitValueCents: 10_000, // 1 point per ₦100
  pointsValueCents: 100, // 1 point = ₦1 at redemption
  redemptionCapPercent: 20, // discount capped at 20% of order total
};

const LIABILITY_ACCOUNT = "liability:points";
const customerAccount = (phone: string) => `customer:${phone}`;

/** Load the tenant's rules; falls back to DEFAULT_LOYALTY_RULES. */
export async function getLoyaltyRules(db: Db, tenantId: string): Promise<LoyaltyRules> {
  const [row] = await db.select().from(loyaltyRules)
    .where(eq(loyaltyRules.tenantId, tenantId)).limit(1).catch(() => []);
  if (!row) return { ...DEFAULT_LOYALTY_RULES };
  return {
    enabled: row.enabled,
    pointsPerUnit: row.pointsPerUnit,
    unitValueCents: row.unitValueCents,
    pointsValueCents: row.pointsValueCents,
    redemptionCapPercent: row.redemptionCapPercent,
  };
}

/** Upsert the tenant's earn/burn rules (merchant portal). */
export async function upsertLoyaltyRules(
  db: Db,
  tenantId: string,
  rules: Partial<LoyaltyRules>,
): Promise<LoyaltyRules> {
  const current = await getLoyaltyRules(db, tenantId);
  const next: LoyaltyRules = {
    enabled: rules.enabled ?? current.enabled,
    pointsPerUnit: Math.max(0, Math.floor(rules.pointsPerUnit ?? current.pointsPerUnit)),
    unitValueCents: Math.max(1, Math.floor(rules.unitValueCents ?? current.unitValueCents)),
    pointsValueCents: Math.max(0, Math.floor(rules.pointsValueCents ?? current.pointsValueCents)),
    redemptionCapPercent: Math.min(100, Math.max(0, Math.floor(rules.redemptionCapPercent ?? current.redemptionCapPercent))),
  };
  await db.insert(loyaltyRules).values({ tenantId, ...next })
    .onConflictDoUpdate({ target: [loyaltyRules.tenantId], set: { ...next, updatedAt: new Date() } });
  return next;
}

/** Current points balance for a customer (0 when no ledger rows). */
export async function getBalance(db: Db, tenantId: string, customerPhone: string): Promise<number> {
  const [row] = await db.select({ balanceAfter: loyaltyLedger.balanceAfter })
    .from(loyaltyLedger)
    .where(and(eq(loyaltyLedger.tenantId, tenantId), eq(loyaltyLedger.customerPhone, customerPhone)))
    .orderBy(desc(loyaltyLedger.createdAt), desc(loyaltyLedger.id))
    .limit(1).catch(() => []);
  return row?.balanceAfter ?? 0;
}

export interface LoyaltyEntryResult {
  id: string | null;
  balanceAfter: number;
  /** False when the call was an idempotent no-op (duplicate earn for an order). */
  applied: boolean;
}

/** FROZEN CONTRACT — credit points to a customer (earn). */
export async function awardPoints(
  input: { tenantId: string; customerPhone: string; points: number; reason: string; orderId?: string },
  db: Db,
): Promise<LoyaltyEntryResult> {
  const points = Math.floor(input.points);
  if (!Number.isFinite(points) || points <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "points must be a positive integer" });
  }
  return db.transaction(async (tx) => {
    // Idempotency: one earn row per (tenant, order).
    if (input.orderId) {
      const [dup] = await tx.select({ id: loyaltyLedger.id, balanceAfter: loyaltyLedger.balanceAfter })
        .from(loyaltyLedger)
        .where(and(
          eq(loyaltyLedger.tenantId, input.tenantId),
          eq(loyaltyLedger.orderId, input.orderId),
          eq(loyaltyLedger.entryType, "earn"),
        )).limit(1);
      if (dup) return { id: dup.id, balanceAfter: dup.balanceAfter, applied: false };
    }
    const [latest] = await tx.select({ balanceAfter: loyaltyLedger.balanceAfter })
      .from(loyaltyLedger)
      .where(and(eq(loyaltyLedger.tenantId, input.tenantId), eq(loyaltyLedger.customerPhone, input.customerPhone)))
      .orderBy(desc(loyaltyLedger.createdAt), desc(loyaltyLedger.id)).limit(1);
    const balanceAfter = (latest?.balanceAfter ?? 0) + points;
    const [row] = await tx.insert(loyaltyLedger).values({
      tenantId: input.tenantId,
      customerPhone: input.customerPhone,
      entryType: "earn",
      points,
      debitAccount: LIABILITY_ACCOUNT,
      creditAccount: customerAccount(input.customerPhone),
      balanceAfter,
      reason: input.reason.slice(0, 255),
      orderId: input.orderId ?? null,
    }).returning({ id: loyaltyLedger.id });
    return { id: row?.id ?? null, balanceAfter, applied: true };
  });
}

/** FROZEN CONTRACT — burn points from a customer (redemption). */
export async function redeemPoints(
  input: { tenantId: string; customerPhone: string; points: number; reason: string; orderId?: string },
  db: Db,
): Promise<LoyaltyEntryResult> {
  const points = Math.floor(input.points);
  if (!Number.isFinite(points) || points <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "points must be a positive integer" });
  }
  return db.transaction(async (tx) => {
    if (input.orderId) {
      const [dup] = await tx.select({ id: loyaltyLedger.id, balanceAfter: loyaltyLedger.balanceAfter })
        .from(loyaltyLedger)
        .where(and(
          eq(loyaltyLedger.tenantId, input.tenantId),
          eq(loyaltyLedger.orderId, input.orderId),
          eq(loyaltyLedger.entryType, "redeem"),
        )).limit(1);
      if (dup) return { id: dup.id, balanceAfter: dup.balanceAfter, applied: false };
    }
    const [latest] = await tx.select({ balanceAfter: loyaltyLedger.balanceAfter })
      .from(loyaltyLedger)
      .where(and(eq(loyaltyLedger.tenantId, input.tenantId), eq(loyaltyLedger.customerPhone, input.customerPhone)))
      .orderBy(desc(loyaltyLedger.createdAt), desc(loyaltyLedger.id)).limit(1);
    const balance = latest?.balanceAfter ?? 0;
    if (balance < points) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `Insufficient points balance (${balance})` });
    }
    const balanceAfter = balance - points;
    const [row] = await tx.insert(loyaltyLedger).values({
      tenantId: input.tenantId,
      customerPhone: input.customerPhone,
      entryType: "redeem",
      points,
      debitAccount: customerAccount(input.customerPhone),
      creditAccount: LIABILITY_ACCOUNT,
      balanceAfter,
      reason: input.reason.slice(0, 255),
      orderId: input.orderId ?? null,
    }).returning({ id: loyaltyLedger.id });
    return { id: row?.id ?? null, balanceAfter, applied: true };
  });
}

/** Points earned for an order total under the given rules (integer math). */
export function computeEarnPoints(rules: LoyaltyRules, orderTotalCents: number): number {
  if (!rules.enabled || orderTotalCents <= 0) return 0;
  return Math.floor(orderTotalCents / rules.unitValueCents) * rules.pointsPerUnit;
}

export interface RedemptionPreview {
  points: number;
  discountCents: number;
  capCents: number;
  balance: number;
}

/**
 * Compute the redemption for a checkout: burn as many points as possible up
 * to the merchant's cap (% of order total, integer cents, floor division).
 */
export function previewRedemption(
  rules: LoyaltyRules,
  balance: number,
  orderTotalCents: number,
): RedemptionPreview {
  const capCents = Math.floor((orderTotalCents * rules.redemptionCapPercent) / 100);
  const maxByBalance = balance * rules.pointsValueCents;
  const discountCents = Math.max(0, Math.min(capCents, maxByBalance, orderTotalCents));
  const points = rules.pointsValueCents > 0 ? Math.floor(discountCents / rules.pointsValueCents) : 0;
  return { points, discountCents: points * rules.pointsValueCents, capCents, balance };
}

/**
 * Award earn-points for one order (idempotent). Only delivered/completed
 * orders earn — points vest when the sale is final, not at checkout.
 */
export async function awardPointsForOrder(
  db: Db,
  tenantId: string,
  orderId: string,
): Promise<{ awarded: number; balanceAfter: number | null }> {
  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId))).limit(1);
  if (!order || order.status !== "delivered") return { awarded: 0, balanceAfter: null };
  const rules = await getLoyaltyRules(db, tenantId);
  const points = computeEarnPoints(rules, toMinorUnitsExact(order.totalAmount));
  if (points <= 0) return { awarded: 0, balanceAfter: null };
  const res = await awardPoints({
    tenantId,
    customerPhone: order.customerId,
    points,
    reason: `Earned on order ${order.orderNumber}`,
    orderId: order.id,
  }, db);
  return { awarded: res.applied ? points : 0, balanceAfter: res.balanceAfter };
}

/**
 * Sweep: award points for every delivered order that has no earn row yet.
 * This is the EVENT/SWEEP tie-in for orders completed outside the delivery
 * aggregator (COD settlement, manual status flips) — safe to run from cron;
 * earn idempotency makes re-runs no-ops.
 */
export async function sweepAwardPointsForDeliveredOrders(
  db: Db,
  tenantId?: string,
): Promise<{ scanned: number; awarded: number; points: number }> {
  const earned = await db.select({ orderId: loyaltyLedger.orderId })
    .from(loyaltyLedger)
    .where(and(
      eq(loyaltyLedger.entryType, "earn"),
      ...(tenantId ? [eq(loyaltyLedger.tenantId, tenantId)] : []),
    )).catch(() => []);
  const earnedOrderIds = new Set(earned.map((r) => r.orderId).filter((x): x is string => !!x));

  const delivered = await db.select({ id: orders.id, tenantId: orders.tenantId })
    .from(orders)
    .where(and(
      eq(orders.status, "delivered"),
      ...(tenantId ? [eq(orders.tenantId, tenantId)] : []),
    )).catch(() => []);

  let awarded = 0;
  let points = 0;
  for (const o of delivered) {
    if (earnedOrderIds.has(o.id)) continue;
    const res = await awardPointsForOrder(db, o.tenantId, o.id).catch(() => ({ awarded: 0, balanceAfter: null }));
    if (res.awarded > 0) {
      awarded += 1;
      points += res.awarded;
    }
  }
  return { scanned: delivered.length, awarded, points };
}

/** Ledger history for the portal (newest first). */
export async function listLedger(
  db: Db,
  tenantId: string,
  opts: { customerPhone?: string; limit?: number } = {},
) {
  return db.select().from(loyaltyLedger)
    .where(and(
      eq(loyaltyLedger.tenantId, tenantId),
      ...(opts.customerPhone ? [eq(loyaltyLedger.customerPhone, opts.customerPhone)] : []),
    ))
    .orderBy(desc(loyaltyLedger.createdAt))
    .limit(Math.min(200, opts.limit ?? 50));
}
