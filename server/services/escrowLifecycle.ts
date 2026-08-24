/**
 * Shared escrow lifecycle helpers (W30 Coder B).
 *
 * === W30 escrow-lifecycle ===
 *
 * confirmEscrowDelivery — THE single code path every automated delivery
 * channel (shipbubble webhook, logistics simulate/update, medusa orderBridge,
 * local delivery service) uses to advance escrow_held → delivery_confirmed.
 *
 * verify-v1 finding #14: before W30, only the manual escrow.confirmDelivery
 * endpoint reset `buyerConfirmDeadline`; every automated path flipped the
 * state WITHOUT resetting it, so the buyer-protection window (which starts
 * at payment time) could be ~zero by the time delivery actually happened —
 * the escrow became settleable the instant it flipped. This helper ALWAYS
 * sets/resets the deadline to now + buyerConfirmWindowHours at the moment of
 * delivery confirmation.
 */
import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../db";
import { escrowTransactions, escrowConfig } from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type DbOrTx = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

const DEFAULT_BUYER_CONFIRM_WINDOW_HOURS = 24;

/** Read the configured buyer-protection window (hours); falls back to 24h. */
export async function getBuyerConfirmWindowHours(db: DbOrTx): Promise<number> {
  const [cfg] = await db.select({ buyerConfirmWindowHours: escrowConfig.buyerConfirmWindowHours })
    .from(escrowConfig)
    .where(eq(escrowConfig.id, 1));
  const hours = cfg?.buyerConfirmWindowHours;
  return typeof hours === "number" && hours > 0 ? hours : DEFAULT_BUYER_CONFIRM_WINDOW_HOURS;
}

/**
 * Atomically advance escrow(s) to delivery_confirmed AND reset the
 * buyer-protection deadline. Guarded to `escrow_held` so replays and
 * out-of-order events are no-ops. Returns the ids that transitioned.
 *
 * Exactly one of `escrowTxId` / `orderId` must be provided.
 */
export async function confirmEscrowDelivery(
  db: Db,
  opts: {
    escrowTxId?: string;
    orderId?: string;
    shipmentId?: string;
    at?: Date;
    /**
     * W30 hotfix (verify-v1 #11): pass false when the delivery confirmation
     * comes from a mock/local/merchant-self-reported courier in a
     * production-like deployment. The escrow still advances to
     * delivery_confirmed (so the REAL buyer can confirm and settle), but it
     * is flagged metadata.buyerProtection="courier_unverified" and the SLA
     * scan / auto-confirm cron will NEVER auto-settle it — they skip and
     * alert instead. Default true (fail-closed callers pass false).
     */
    courierVerified?: boolean;
  },
): Promise<{ transitioned: string[]; buyerConfirmDeadline: Date }> {
  const at = opts.at ?? new Date();
  const windowHours = await getBuyerConfirmWindowHours(db);
  const buyerConfirmDeadline = new Date(at.getTime() + windowHours * 3600 * 1000);

  const match = opts.escrowTxId
    ? eq(escrowTransactions.id, opts.escrowTxId)
    : eq(escrowTransactions.orderId, opts.orderId!);

  const rows = await db.update(escrowTransactions).set({
    state: "delivery_confirmed",
    deliveryConfirmedAt: at,
    buyerConfirmDeadline,
    ...(opts.shipmentId ? { shipmentId: opts.shipmentId } : {}),
    ...(opts.courierVerified === false
      ? {
          metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
            buyerProtection: "courier_unverified",
            courierUnverifiedAt: at.toISOString(),
          })}::jsonb`,
        }
      : {}),
    updatedAt: new Date(),
  }).where(and(match, eq(escrowTransactions.state, "escrow_held")))
    .returning({ id: escrowTransactions.id });

  return { transitioned: rows.map((r) => r.id), buyerConfirmDeadline };
}
