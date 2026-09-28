/**
 * PSP charge-success processing for the Paystack / Flutterwave webhooks, run AFTER the 200 ack (W48 PERF-API-1).
 *
 * Acking first stops PSP retry storms, but it also means the PSP never redelivers when processing fails — and the
 * AF-06 escrow-hold heal depended on exactly that redelivery (the webhook used to answer 500 so the PSP retried).
 * So a failed run is retried HERE instead: a few in-process attempts with backoff, and the event is recorded in
 * webhook_events (status "failed") so the scheduled sweep (/api/scheduled/psp-confirm-retry) replays it even across
 * a restart. Replaying is safe: confirmProviderPayment is claim-first/idempotent (an already-completed intent only
 * heals what is missing — ledger settle, escrow hold) and every post-confirm hook is exactly-once.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { getDb } from "../../db";
import { paymentIntents, paymentTransactions, webhookEvents } from "../../../drizzle/schema";
import { confirmProviderPayment } from "../paymentConfirm";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type PspChargeProvider = "paystack" | "flutterwave";

export interface PspChargeEvent {
  provider: PspChargeProvider;
  reference: string;
  amountMajor: number | null;
  currency: string | null;
  rawPayload: unknown;
}

/** webhook_events.eventType of a charge whose post-ack processing failed and is awaiting a retry. */
export const PSP_CONFIRM_RETRY_EVENT = "charge.confirm_retry";

const LOG_TAG: Record<PspChargeProvider, string> = { paystack: "paystack-webhook", flutterwave: "flutterwave-webhook" };

/** Confirm the payment, run the mismatch-quarantine seam, then the independent post-confirm hooks. Throws only when the confirm itself fails. */
export async function processPspChargeSuccess(db: Db, ev: PspChargeEvent): Promise<void> {
  const tag = LOG_TAG[ev.provider];
  const result = await confirmProviderPayment(db, {
    provider: ev.provider,
    reference: ev.reference,
    amountMajor: ev.amountMajor,
    currency: ev.currency,
    rawPayload: ev.rawPayload,
  });
  if (!result.ok) {
    console.warn(`[${tag}] ref=${ev.reference} → ${result.action}${result.detail ? `: ${result.detail}` : ""}`);
  }
  // === W45 money-intents seam (PAY-13) — paymentConfirm.ts PINNED ===
  // Quarantine + ops alert + auto-refund when the confirm rejected a PSP mismatch with money in hand. Never throws.
  {
    const { runPaymentMismatchQuarantineHook } = await import("./paymentMismatchQuarantine");
    await runPaymentMismatchQuarantineHook(db, {
      provider: ev.provider,
      reference: ev.reference,
      result,
      amountMajor: ev.amountMajor,
      currency: ev.currency,
      rawPayload: ev.rawPayload,
    });
  }
  if (!result.ok) return;
  // === W48 PERF-API-1: the independent post-confirm hooks run in PARALLEL. Each is exactly-once + never-throws:
  // W31 AR invoices, W41 buyer credit (installment activation + consented token save), W44 gift cards + referral
  // rewards, W44 appointment deposits + digital PIN allocation. ===
  const { provider, reference } = ev;
  const settled = await Promise.allSettled([
    (async () => {
      const { runArInvoiceWebhookHook } = await import("../arInvoices");
      await runArInvoiceWebhookHook(db, { provider, reference });
    })(),
    (async () => {
      const { runBuyerCreditWebhookHook } = await import("../buyerInstallments");
      await runBuyerCreditWebhookHook(db, { provider, reference, rawPayload: ev.rawPayload });
    })(),
    (async () => {
      const { runGiftCardPurchaseWebhookHook } = await import("../giftCards");
      await runGiftCardPurchaseWebhookHook(db, { provider, reference });
    })(),
    (async () => {
      const { runReferralRewardWebhookHook } = await import("../referrals");
      await runReferralRewardWebhookHook(db, { provider, reference });
    })(),
    (async () => {
      const { runAppointmentWebhookHook } = await import("../appointments");
      await runAppointmentWebhookHook(db, { provider, reference });
    })(),
    (async () => {
      const { runDigitalPinWebhookHook } = await import("../digitalPins");
      await runDigitalPinWebhookHook(db, { provider, reference });
    })(),
  ]);
  for (const s of settled) {
    if (s.status === "rejected") {
      console.error(`[${tag}] post-confirm hook failed for ref=${reference}:`, (s.reason as any)?.message ?? s.reason);
    }
  }
}

/** In-process retry backoff; PSP_CONFIRM_RETRY_DELAYS_MS (comma-separated ms) overrides it. */
function retryDelaysMs(): number[] {
  const raw = process.env.PSP_CONFIRM_RETRY_DELAYS_MS;
  const parsed = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length ? parsed : [5_000, 30_000, 120_000, 600_000];
}

/** The tenant a PSP reference belongs to — an order payment (payment_transactions) or a payment intent. */
async function tenantForReference(db: Db, reference: string): Promise<string> {
  const [tx] = await db.select({ tenantId: paymentTransactions.tenantId }).from(paymentTransactions)
    .where(eq(paymentTransactions.providerRef, reference)).limit(1).catch(() => [] as any[]);
  if (tx?.tenantId) return tx.tenantId;
  const [intent] = await db.select({ tenantId: paymentIntents.tenantId }).from(paymentIntents)
    .where(eq(paymentIntents.providerPaymentId, reference)).limit(1).catch(() => [] as any[]);
  return intent?.tenantId ?? "unknown";
}

async function markRetry(db: Db, id: string, err: unknown | null): Promise<void> {
  await db.update(webhookEvents).set(err
    ? { status: "failed", processingError: String((err as any)?.message ?? err).slice(0, 2000) }
    : { status: "processed", processingError: null, processedAt: new Date() },
  ).where(eq(webhookEvents.id, id)).catch((e: any) => console.error("[psp-confirm-retry] could not update retry row:", e?.message));
}

/**
 * Process a charge post-ack. On failure the event is recorded for the scheduled sweep and retried in-process with
 * backoff. Never throws — the 200 is already on the wire.
 */
export async function processPspChargeSuccessWithRetry(db: Db, ev: PspChargeEvent): Promise<void> {
  const tag = LOG_TAG[ev.provider];
  try {
    await processPspChargeSuccess(db, ev);
    return;
  } catch (err: any) {
    console.error(`[${tag}] post-ack processing failed for ref=${ev.reference} — queued for retry:`, err?.message);
    const id = randomUUID();
    try {
      await db.insert(webhookEvents).values({
        id,
        tenantId: await tenantForReference(db, ev.reference),
        source: ev.provider,
        eventType: PSP_CONFIRM_RETRY_EVENT,
        status: "failed",
        payload: ev as unknown as Record<string, unknown>,
        processingError: String(err?.message ?? err).slice(0, 2000),
      });
    } catch (e: any) {
      // Even without the durable row, the in-process retries below still run.
      console.error(`[${tag}] could not record retry for ref=${ev.reference}:`, e?.message);
    }
    scheduleRetry(db, ev, id, 0);
  }
}

function scheduleRetry(db: Db, ev: PspChargeEvent, rowId: string, attempt: number): void {
  const delays = retryDelaysMs();
  if (attempt >= delays.length) return; // the scheduled sweep takes it from here
  const timer = setTimeout(async () => {
    // The sweep (or a PSP redelivery) may already have healed it.
    const [row] = await db.select({ status: webhookEvents.status }).from(webhookEvents)
      .where(eq(webhookEvents.id, rowId)).limit(1).catch(() => [] as any[]);
    if (row?.status === "processed") return;
    try {
      await processPspChargeSuccess(db, ev);
      await markRetry(db, rowId, null);
      console.log(`[${LOG_TAG[ev.provider]}] retry ${attempt + 1} healed ref=${ev.reference}`);
    } catch (err: any) {
      await markRetry(db, rowId, err);
      scheduleRetry(db, ev, rowId, attempt + 1);
    }
  }, delays[attempt]);
  timer.unref?.();
}

/** Replay every recorded charge whose post-ack processing has not yet succeeded (oldest first). */
export async function sweepPspConfirmRetries(db: Db, opts: { limit?: number } = {}): Promise<{ attempted: number; healed: number }> {
  const rows = await db.select().from(webhookEvents)
    .where(and(
      eq(webhookEvents.eventType, PSP_CONFIRM_RETRY_EVENT),
      inArray(webhookEvents.status, ["failed", "received"]),
    ))
    .orderBy(asc(webhookEvents.createdAt))
    .limit(opts.limit ?? 100);
  let healed = 0;
  for (const row of rows) {
    const ev = row.payload as unknown as PspChargeEvent | null;
    if (!ev?.provider || !ev.reference) {
      await markRetry(db, row.id, new Error("retry row has no replayable payload"));
      continue;
    }
    try {
      await processPspChargeSuccess(db, ev);
      await markRetry(db, row.id, null);
      healed++;
    } catch (err) {
      await markRetry(db, row.id, err);
    }
  }
  return { attempted: rows.length, healed };
}
