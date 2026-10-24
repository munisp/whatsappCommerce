// === W66 learning ===
/**
 * disputeOutcomeFeatures.ts — R8(b) dispute outcomes → risk features.
 *
 * On dispute resolution (escrow.review), writes ONE additive feature row to
 * dispute_outcome_features (0184): parties, amounts (integer cents),
 * resolution, days-to-resolve. Consumed by creditScoring / antiGaming as an
 * extra signal via disputeRiskSignal().
 *
 * Idempotent: unique(dispute_id) + ON CONFLICT DO NOTHING — a replayed
 * resolution hook never double-writes. Fail-open (telemetry only); the
 * money path in escrow.review is untouched and stays fail-closed.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { disputeOutcomeFeatures } from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface DisputeOutcomeInput {
  tenantId: string;
  disputeId: string;
  orderId?: string | null;
  escrowTxId?: string | null;
  raisedBy?: string | null;
  reason?: string | null;
  resolution?: string | null;
  /** resolved_merchant | resolved_buyer */
  outcome: string;
  /** Integer cents. */
  escrowAmountCents?: number | null;
  refundAmountCents?: number | null;
  disputeCreatedAt?: Date | string | null;
  resolvedAt?: Date | string | null;
}

function daysBetween(a?: Date | string | null, b?: Date | string | null): number | null {
  if (!a || !b) return null;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.max(0, Math.round((tb - ta) / (24 * 3600_000)));
}

/** Record the outcome feature row. Never throws; returns written flag. */
export async function recordDisputeOutcome(db: Db, input: DisputeOutcomeInput): Promise<{ written: boolean }> {
  try {
    const res = await db.execute(sql`
      INSERT INTO dispute_outcome_features
        (tenant_id, dispute_id, order_id, escrow_tx_id, raised_by, reason,
         resolution, outcome, escrow_amount_cents, refund_amount_cents,
         days_to_resolve)
      VALUES
        (${input.tenantId}, ${input.disputeId}, ${input.orderId ?? null},
         ${input.escrowTxId ?? null}, ${input.raisedBy ?? null}, ${input.reason ?? null},
         ${input.resolution ?? null}, ${input.outcome},
         ${input.escrowAmountCents ?? null}, ${input.refundAmountCents ?? null},
         ${daysBetween(input.disputeCreatedAt, input.resolvedAt)})
      ON CONFLICT (dispute_id) DO NOTHING
      RETURNING id
    `).then((r: any) => (r.rows ?? r));
    return { written: ((res as any[]) ?? []).length === 1 };
  } catch (e: any) {
    console.warn("[dispute-features] record failed (fail-open):", e?.message);
    return { written: false };
  }
}

export interface DisputeRiskSignal {
  total: number;
  buyerLost: number;
  merchantLost: number;
  refundCents: number;
  avgDaysToResolve: number | null;
}

/**
 * Additive risk signal for creditScoring / antiGaming: aggregate a tenant's
 * dispute outcomes. Fail-open → null (callers skip the signal).
 */
export async function disputeRiskSignal(db: Db, tenantId: string): Promise<DisputeRiskSignal | null> {
  try {
    const rows = await db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE outcome = 'resolved_buyer')::int AS merchant_lost,
             count(*) FILTER (WHERE outcome = 'resolved_merchant')::int AS buyer_lost,
             COALESCE(sum(refund_amount_cents), 0)::bigint AS refund_cents,
             avg(days_to_resolve)::float AS avg_days
      FROM dispute_outcome_features
      WHERE tenant_id = ${tenantId}
    `).then((r: any) => (r.rows ?? r));
    const row = (rows as any[])[0];
    if (!row) return null;
    return {
      total: Number(row.total ?? 0),
      buyerLost: Number(row.buyer_lost ?? 0),
      merchantLost: Number(row.merchant_lost ?? 0),
      refundCents: Number(row.refund_cents ?? 0),
      avgDaysToResolve: row.avg_days == null ? null : Number(row.avg_days),
    };
  } catch (e: any) {
    console.warn("[dispute-features] signal failed (fail-open):", e?.message);
    return null;
  }
}

/** Exported for tests; also handy for one-off backfills. */
export async function getDisputeOutcome(db: Db, disputeId: string) {
  const [row] = await db.select().from(disputeOutcomeFeatures)
    .where(eq(disputeOutcomeFeatures.disputeId, disputeId)).limit(1);
  return row ?? null;
}
// === END W66 learning ===
