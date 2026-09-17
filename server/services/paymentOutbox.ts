/**
 * === W45 money-ledger ===
 * server/services/paymentOutbox.ts — transactional outbox for post-commit
 * external money legs (PAY-16 FX Mojaloop delivery, PAY-18 PoT TigerBeetle
 * transfers).
 *
 * Doctrine:
 *  - The PG money mutation (wallet debit / facility decrement / loan
 *    settlement) and its outbox row commit in ONE transaction — the
 *    external rail is NEVER called in-tx. After commit, the
 *    processPaymentOutbox worker delivers the leg asynchronously with
 *    bounded retry. A rail outage therefore can never strand PG-vs-rail
 *    state silently: worst case the row sits pending/dead with a CRITICAL
 *    observability event for ops.
 *  - Exactly-once by the deterministic unique `reference`
 *    (payment_outbox_reference_uniq): enqueue replays are no-ops and the
 *    rail-side idempotency key derives from the same reference.
 *  - Claim-first: delivery claims a row pending→delivering (guarded
 *    UPDATE … RETURNING) so concurrent workers never double-deliver. A
 *    stale 'delivering' row (crash mid-delivery, PAY-11 pattern) is reaped
 *    to 'pending' by the same sweep after STALE_DELIVERING_MS.
 *  - Delivery dispatch by kind via lazy imports (no module cycles):
 *      mojaloop_transfer → fxPayouts.deliverMojaloopOutboxLeg
 *      ledger_transfer   → payOverTime.deliverLedgerOutboxLeg
 *  - Retry policy: unknown/5xx/unreachable errors retry up to
 *    MAX_PAYMENT_OUTBOX_ATTEMPTS then 'dead' + CRITICAL capture. A deliverer
 *    may throw an error with `definitive: true` (rail-side 4xx rejection) →
 *    'failed' immediately + CRITICAL capture (ops must compensate).
 */
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { paymentOutbox, type PaymentOutboxEvent } from "../../drizzle/schema";
import { captureException } from "./observability";

export const MAX_PAYMENT_OUTBOX_ATTEMPTS = 8;
/** Crash mid-delivery reap window (PAY-11 pattern). */
export const STALE_DELIVERING_MS = 10 * 60 * 1000;

export type PaymentOutboxKind = "mojaloop_transfer" | "ledger_transfer";

export interface EnqueuePaymentOutboxInput {
  tenantId: string;
  kind: PaymentOutboxKind;
  /** Deterministic exactly-once key — replays no-op on the unique index. */
  reference: string;
  payload: Record<string, unknown>;
}

/**
 * Insert one outbox row (call INSIDE the money transaction so the leg cannot
 * be lost). Returns the row id, or null when the reference already exists
 * (replay-safe no-op).
 */
export async function enqueuePaymentOutbox(
  db: any,
  input: EnqueuePaymentOutboxInput,
): Promise<string | null> {
  const now = new Date();
  const rows = await db
    .insert(paymentOutbox)
    .values({
      tenantId: input.tenantId,
      kind: input.kind,
      reference: input.reference.slice(0, 160),
      payload: input.payload,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: paymentOutbox.id });
  return rows[0]?.id ?? null;
}

export class OutboxDefinitiveError extends Error {
  definitive = true;
}

/** True when a delivery failure is definitively rejected by the rail (no retry). */
function isDefinitive(err: any): boolean {
  return err?.definitive === true;
}

/** Default per-kind deliverer (lazy imports — no module-init cycles). */
export async function deliverPaymentOutboxEvent(event: PaymentOutboxEvent): Promise<void> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.kind as PaymentOutboxKind) {
    case "mojaloop_transfer": {
      const { deliverMojaloopOutboxLeg } = await import("./fxPayouts");
      await deliverMojaloopOutboxLeg(payload as any);
      return;
    }
    case "ledger_transfer": {
      const { deliverLedgerOutboxLeg } = await import("./payOverTime");
      await deliverLedgerOutboxLeg(payload as any);
      return;
    }
    default:
      throw new OutboxDefinitiveError(`payment_outbox: unknown kind ${event.kind}`);
  }
}

export interface ProcessPaymentOutboxResult {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
  dead: number;
  reapedStale: number;
}

/**
 * One worker tick: reap stale 'delivering' claims, then claim pending rows
 * (claim-first) and deliver each via the kind deliverer. Never throws into
 * the caller — per-row failures are recorded on the row and surfaced via
 * captureException at exhaustion/definitive failure.
 */
export async function processPaymentOutbox(
  db: any,
  opts: { batch?: number; deliver?: (event: PaymentOutboxEvent) => Promise<void>; now?: Date } = {},
): Promise<ProcessPaymentOutboxResult> {
  const now = opts.now ?? new Date();
  const deliver = opts.deliver ?? deliverPaymentOutboxEvent;
  const result: ProcessPaymentOutboxResult = { claimed: 0, delivered: 0, retried: 0, failed: 0, dead: 0, reapedStale: 0 };

  // Reap stale 'delivering' claims (crash mid-delivery) back to 'pending'.
  const reaped = await db
    .update(paymentOutbox)
    .set({ status: "pending", updatedAt: now })
    .where(and(
      eq(paymentOutbox.status, "delivering"),
      lt(paymentOutbox.updatedAt, new Date(now.getTime() - STALE_DELIVERING_MS)),
    ))
    .returning({ id: paymentOutbox.id })
    .catch(() => [] as any[]);
  result.reapedStale = reaped.length;

  const pending = (await db
    .select()
    .from(paymentOutbox)
    .where(eq(paymentOutbox.status, "pending"))
    .orderBy(asc(paymentOutbox.createdAt))
    .limit(Math.max(1, Math.min(opts.batch ?? 50, 200)))
    .catch(() => [] as any[])) as PaymentOutboxEvent[];

  for (const row of pending) {
    // Claim-first: exactly one worker flips pending → delivering.
    const [claim] = await db
      .update(paymentOutbox)
      .set({ status: "delivering", updatedAt: now })
      .where(and(eq(paymentOutbox.id, row.id), eq(paymentOutbox.status, "pending")))
      .returning();
    if (!claim) continue; // another worker won
    result.claimed += 1;
    try {
      await deliver(claim);
      await db
        .update(paymentOutbox)
        .set({ status: "delivered", lastError: null, processedAt: new Date(), updatedAt: new Date() })
        .where(eq(paymentOutbox.id, claim.id));
      result.delivered += 1;
    } catch (err: any) {
      const attempts = (row.attempts ?? 0) + 1;
      const message = String(err?.message ?? err).slice(0, 1000);
      const status: "pending" | "failed" | "dead" = isDefinitive(err)
        ? "failed"
        : attempts >= MAX_PAYMENT_OUTBOX_ATTEMPTS
          ? "dead"
          : "pending";
      await db
        .update(paymentOutbox)
        .set({ status, attempts, lastError: message, updatedAt: new Date() })
        .where(eq(paymentOutbox.id, claim.id));
      if (status === "pending") {
        result.retried += 1;
      } else {
        if (status === "dead") result.dead += 1;
        else result.failed += 1;
        // Retry exhaustion / definitive rail rejection on a MONEY leg is a
        // pageable event — the PG side already committed.
        captureException(err, {
          service: "paymentOutbox",
          operation: `deliver.${row.kind}`,
          tenantId: row.tenantId,
          severity: "critical",
          extra: { eventId: row.id, reference: row.reference, kind: row.kind, attempts, status },
        });
      }
    }
  }
  return result;
}

/** Count outbox rows per status (ops surface). */
export async function countPaymentOutboxByStatus(db: any): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: paymentOutbox.status, count: sql<number>`count(*)::int` })
    .from(paymentOutbox)
    .groupBy(paymentOutbox.status)
    .catch(() => [] as any[]);
  const out: Record<string, number> = { pending: 0, delivering: 0, delivered: 0, failed: 0, dead: 0 };
  for (const r of rows) out[r.status] = Number(r.count);
  return out;
}

/** Load an outbox row by its deterministic reference (tests/ops). */
export async function getPaymentOutboxByReference(db: any, reference: string): Promise<PaymentOutboxEvent | null> {
  const [row] = await db.select().from(paymentOutbox).where(eq(paymentOutbox.reference, reference)).limit(1).catch(() => []);
  return row ?? null;
}
// === END W45 money-ledger ===
