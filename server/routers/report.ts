import { z } from "zod";
import { sql } from "drizzle-orm";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { escrowTransactions } from "../../drizzle/schema";

export interface TenantMonthAggregate {
  tenantId: string;
  grossVolume: number;
  platformFees: number;
  netMerchantPayouts: number;
  refundTotals: number;
}

export interface TenantSettlementReport extends TenantMonthAggregate {
  escrowInFlight: number;
  deltas: {
    grossVolumePct: number | null;
    platformFeesPct: number | null;
    netMerchantPayoutsPct: number | null;
    refundTotalsPct: number | null;
  };
}

/** Month-over-month percentage delta; null when the previous month was zero. */
export function momDelta(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 10000) / 100;
}

/**
 * Pure merge of current/previous month aggregates + in-flight escrow into the
 * report shape — exported so seeded-row tests can verify the math against
 * hand-computed expectations without a live database.
 */
export function buildSettlementReport(
  current: TenantMonthAggregate[],
  previous: TenantMonthAggregate[],
  inFlight: Map<string, number>,
): TenantSettlementReport[] {
  const prevByTenant = new Map(previous.map((p) => [p.tenantId, p]));
  const tenantIds = new Set<string>([
    ...current.map((c) => c.tenantId),
    ...previous.map((p) => p.tenantId),
    ...Array.from(inFlight.keys()),
  ]);
  const zero = (tenantId: string): TenantMonthAggregate => ({
    tenantId, grossVolume: 0, platformFees: 0, netMerchantPayouts: 0, refundTotals: 0,
  });
  return Array.from(tenantIds).sort().map((tenantId) => {
    const cur = current.find((c) => c.tenantId === tenantId) ?? zero(tenantId);
    const prev = prevByTenant.get(tenantId) ?? zero(tenantId);
    return {
      ...cur,
      escrowInFlight: inFlight.get(tenantId) ?? 0,
      deltas: {
        grossVolumePct: momDelta(cur.grossVolume, prev.grossVolume),
        platformFeesPct: momDelta(cur.platformFees, prev.platformFees),
        netMerchantPayoutsPct: momDelta(cur.netMerchantPayouts, prev.netMerchantPayouts),
        refundTotalsPct: momDelta(cur.refundTotals, prev.refundTotals),
      },
    };
  });
}

function monthRange(month: string): { start: Date; end: Date; prevStart: Date } {
  // month: "YYYY-MM" (validated by zod regex)
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  const prevStart = new Date(Date.UTC(y, m - 2, 1));
  return { start, end, prevStart };
}

export const reportRouter = router({
  /**
   * Monthly settlement / fee report (admin). Per tenant: gross volume,
   * platform fees, net merchant payouts, refund totals, escrow in-flight and
   * month-over-month deltas. All figures computed from escrow_transactions
   * via SQL aggregates — no application-side summing of money.
   */
  monthlySettlement: adminProcedure
    .input(z.object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM"),
    }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const { start, end, prevStart } = monthRange(input.month);

      const aggregate = (from: Date, to: Date) =>
        db.select({
          tenantId: escrowTransactions.tenantId,
          // Gross: all escrows whose hold was created in the month.
          grossVolume: sql<string>`coalesce(sum(${escrowTransactions.amount}) filter (where ${escrowTransactions.createdAt} >= ${from} and ${escrowTransactions.createdAt} < ${to}), 0)`,
          // Fees + payouts: escrows that SETTLED in the month.
          platformFees: sql<string>`coalesce(sum(${escrowTransactions.platformFee}) filter (where ${escrowTransactions.settledAt} >= ${from} and ${escrowTransactions.settledAt} < ${to}), 0)`,
          netMerchantPayouts: sql<string>`coalesce(sum(${escrowTransactions.netMerchantAmount}) filter (where ${escrowTransactions.settledAt} >= ${from} and ${escrowTransactions.settledAt} < ${to}), 0)`,
          // Refunds: escrows refunded in the month.
          refundTotals: sql<string>`coalesce(sum(${escrowTransactions.amount}) filter (where ${escrowTransactions.refundedAt} >= ${from} and ${escrowTransactions.refundedAt} < ${to}), 0)`,
        })
          .from(escrowTransactions)
          .groupBy(escrowTransactions.tenantId);

      const [curRows, prevRows, inFlightRows] = await Promise.all([
        aggregate(start, end),
        aggregate(prevStart, start),
        db.select({
          tenantId: escrowTransactions.tenantId,
          inFlight: sql<string>`coalesce(sum(${escrowTransactions.amount}), 0)`,
        })
          .from(escrowTransactions)
          .where(sql`${escrowTransactions.state} not in ('settled', 'refunded', 'expired')`)
          .groupBy(escrowTransactions.tenantId),
      ]);

      const toNum = (r: { tenantId: string; grossVolume: string; platformFees: string; netMerchantPayouts: string; refundTotals: string }): TenantMonthAggregate => ({
        tenantId: r.tenantId,
        grossVolume: parseFloat(r.grossVolume),
        platformFees: parseFloat(r.platformFees),
        netMerchantPayouts: parseFloat(r.netMerchantPayouts),
        refundTotals: parseFloat(r.refundTotals),
      });

      const tenants = buildSettlementReport(
        curRows.map(toNum),
        prevRows.map(toNum),
        new Map(inFlightRows.map((r) => [r.tenantId, parseFloat(r.inFlight)])),
      );

      return { month: input.month, generatedAt: new Date().toISOString(), tenants };
    }),
});
