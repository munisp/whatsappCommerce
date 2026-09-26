/**
 * Shared provider payment confirmation (Paystack/Flutterwave webhooks,
 * receipt-screenshot verification, and any other payment confirmation path).
 *
 * Extracted from server/_core/index.ts so ALL confirmation paths — provider
 * webhooks AND the WhatsApp receipt-scan pipeline — run through the SAME
 * money logic. Never duplicate this logic elsewhere.
 *
 * PIN CHANGE LOG: this file was byte-locked at md5
 * d86c3c3ba52e2ff780166080ba2d1d39. That pin was RETIRED DELIBERATELY for the
 * Wave 26 audit (F1b): (1) the order-confirmation UPDATE is now scoped by
 * tenantId so a cross-tenant orderId can never be transitioned; (2) the
 * webhook amount check is now an EXACT integer minor-unit comparison (the
 * ₦0.01 tolerance is gone). New pin hash is recorded in the commit message
 * and the Wave 26 audit trail.
 */
import { eq, and, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { getDb } from "../db";
import {
  paymentTransactions, paymentIntents, orders,
  escrowConfig, escrowTransactions, merchantWallets, walletTransactions,
  inventoryReservations, logisticsShipments,
} from "../../drizzle/schema";
import { splitEscrowAmounts } from "../../shared/escrowAmounts";
import { syncLocalChange } from "./integrations/outbox";
import { creditWalletTopUp } from "../routers/escrow";
import { markInvoicePaidFromPaymentIntent } from "../routers/invoice";
import { commitReservations, reserveStock, InsufficientStockError } from "./inventory";
import { captureException } from "./observability";
import { ledgerBridgeRequest, postDirectLedgerLeg, LedgerBridgeError } from "./ledgerBridge";
import { toMinorUnits } from "./payments/currencyExponent";

/**
 * Settle a completed payment intent's TigerBeetle reservation. This is the fix for a real gap found
 * against a live ledger (QA-033/034): payment.initiate RESERVES funds and stores ledgerPendingId, but
 * this webhook path used to mark the intent "completed" in Postgres WITHOUT ever committing that
 * reservation — the money stayed pending in TigerBeetle and auto-voided ~15 min later
 * (pending_timeout_secs), silently disagreeing with a payment we had already told everyone succeeded.
 * recon-worker's orphan repair does not cover this: it only scans 'pending'/'failed'/'cancelled'
 * intents, never 'completed' ones (rust/recon-worker/src/main.rs).
 *
 * Called on EVERY confirmation path, including replays — commit and postDirectLedgerLeg are both
 * idempotent on their key, so a repeat call is a safe no-op (`replayed: true`), which is also this
 * function's retry story: a webhook replay from the provider is what heals a first attempt that failed
 * because the ledger was briefly unavailable. Never throws: the DB row is already committed and the
 * provider already has the money, so a ledger hiccup must not turn into a failed webhook response
 * (which the provider would retry, hitting the same "already completed" branch) or a customer-visible
 * failure — it's logged loudly instead, same as the other best-effort hooks in this file.
 */
async function settleIntentLedger(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  intent: {
    id: string; tenantId: string; customerId: string | null; amount: string; currency: string | null; ledgerPendingId: string | null;
  },
): Promise<void> {
  try {
    if (intent.ledgerPendingId) {
      await ledgerBridgeRequest("/ledger/commit", "POST", { pending_id: intent.ledgerPendingId });
    } else if (intent.customerId) {
      const minor = toMinorUnits(parseFloat(intent.amount), intent.currency ?? "NGN");
      await postDirectLedgerLeg({
        debit_ref: `customer:${intent.customerId}`, credit_ref: `escrow:${intent.tenantId}`,
        amount: minor, idempotency_key: `settle-in:${intent.id}`,
      });
      await postDirectLedgerLeg({
        debit_ref: `escrow:${intent.tenantId}`, credit_ref: `merchant:${intent.tenantId}`,
        amount: minor, idempotency_key: `settle:${intent.id}`, code: 2,
      });
      // AF-05: an intent settled by direct legs has no ledgerPendingId, and
      // recon-worker used to alert on it every pass ("completed without
      // ledger tracking") even though both legs were posted. Record where
      // the money went so recon can tell tracked from untracked.
      await db.update(paymentIntents)
        .set({
          metadata: sql`COALESCE(${paymentIntents.metadata}, '{}'::jsonb) || ${JSON.stringify({
            ledgerSettle: { mode: "direct", idempotencyKeys: [`settle-in:${intent.id}`, `settle:${intent.id}`], amountMinor: minor },
          })}::jsonb`,
        })
        .where(eq(paymentIntents.id, intent.id));
    }
  } catch (err: any) {
    const detail = err instanceof LedgerBridgeError ? `${err.status ?? "unreachable"}: ${err.message}` : String(err?.message ?? err);
    console.error(`[payment-confirm] LEDGER SETTLE FAILED for completed intent ${intent.id} (tenant ${intent.tenantId}) — Postgres says paid, TigerBeetle does not yet agree; will retry on the next webhook delivery: ${detail}`);
    captureException(err, { service: "paymentConfirm", operation: "settleIntentLedger", tenantId: intent.tenantId, severity: "critical", extra: { intentId: intent.id, ledgerPendingId: intent.ledgerPendingId } });
  }
}

// Found live 2026-09-26 (user: "let's fix it and include it in the message after the user has paid"):
// receipts.ts's sendOrderReceipt has ALWAYS been ready to show a delivery PIN — it reads
// logisticsShipments.deliveryPin and slots it into the receipt message — but nothing ever created a
// shipment for a chat-originated order, so that slot was permanently empty. The only shipment-creation
// path in the whole app (logistics.createShipment) is a heavy Shipbubble-style booking mutation with no
// UI caller anywhere (verified: zero client references) and requires structured sender/recipient address
// data chat checkout never collects — not something to fabricate. This creates the lightweight shipment
// record the PIN system actually needs (every field it touches — senderName, senderAddress, etc. — is
// nullable in the schema; only orderId/tenantId are required), scoped to delivery-fulfillment orders
// only, and returns the PLAINTEXT pin so the receipt can show it in the SAME message the buyer already
// gets after paying — the stored copy is hashed immediately, same as createShipment's own convention.
async function ensureDeliveryShipment(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  orderId: string,
  tenantId: string,
): Promise<string | null> {
  try {
    const [order] = await db.select({ metadata: orders.metadata }).from(orders).where(eq(orders.id, orderId)).limit(1);
    const fulfillment = (order?.metadata as Record<string, unknown> | null)?.fulfillment;
    if (fulfillment !== "delivery") return null;

    const [existing] = await db.select({ id: logisticsShipments.id }).from(logisticsShipments)
      .where(eq(logisticsShipments.orderId, orderId)).limit(1);
    if (existing) return null; // already has a shipment (or PIN was already issued) — never re-issue

    const { generateDeliveryPin, hashDeliveryPin } = await import("../routers/logistics");
    const id = randomUUID();
    const pin = generateDeliveryPin();
    await db.insert(logisticsShipments).values({
      id, orderId, tenantId,
      provider: "manual",
      status: "pending",
      deliveryPin: hashDeliveryPin(pin, id),
    }).onConflictDoNothing();
    return pin;
  } catch (err: any) {
    console.error(`[payment-confirm] ensureDeliveryShipment failed for order ${orderId} (non-fatal — receipt sends without a PIN):`, err?.message);
    return null;
  }
}

/**
 * failureReason prefix stamped on a payment that arrived for an order that
 * could no longer take it (AF-01). A replay of the same provider event sees
 * the prefix and returns the same verdict instead of re-evaluating — so a
 * payment that was already quarantined + refunded can never later confirm
 * the order (e.g. once stock is replenished).
 */
export const ORDER_NOT_PAYABLE_PREFIX = "order-not-payable";

/**
 * AF-01: may this order still be confirmed by a payment landing NOW?
 *
 *  - cancelled / refunded order → no: its stock was already restocked and
 *    the merchant has stopped expecting it. Confirming it would resurrect a
 *    dead order that holds no stock (oversell) and open an escrow hold.
 *  - every reservation of the order was RELEASED (the expiry sweeper gave
 *    the stock back after RESERVATION_MAX_AGE) → re-reserve the same lines
 *    claim-first; if the stock is gone the order cannot be fulfilled → no.
 *  - otherwise (still reserved, already committed, or never stock-tracked)
 *    → yes.
 *
 * The order row is locked FOR UPDATE so two concurrent deliveries cannot
 * both re-reserve; the loser sees the winner's 'reserved' rows. A shortage
 * throws out of the transaction so a multi-line partial re-reserve rolls
 * back as a whole.
 */
async function ensureOrderPayable(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  tenantId: string,
  orderId: string,
  now: Date,
): Promise<{ payable: true } | { payable: false; reason: string }> {
  try {
    return await db.transaction(async (tx) => {
      const [order] = await tx
        .select({ status: orders.status })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
        .for("update");
      if (!order) return { payable: true as const };
      if (order.status === "cancelled" || order.status === "refunded") {
        return { payable: false as const, reason: `order is ${order.status}` };
      }
      const rows = await tx
        .select()
        .from(inventoryReservations)
        .where(and(eq(inventoryReservations.orderId, orderId), eq(inventoryReservations.tenantId, tenantId)));
      if (rows.length === 0 || rows.some((r) => r.status === "reserved" || r.status === "committed")) {
        return { payable: true as const };
      }
      await reserveStock(
        tx,
        tenantId,
        orderId,
        rows.map((r) => ({ productId: r.productId, qty: r.qty, variantId: r.variantId ?? undefined })),
        now,
      );
      console.log(`[payment-confirm] order ${orderId}: reservation had expired — stock re-reserved for the late payment`);
      return { payable: true as const };
    });
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      return { payable: false, reason: `stock reservation expired and the stock is no longer available (${err.message})` };
    }
    throw err;
  }
}

// ── Shared provider payment confirmation (Paystack/Flutterwave webhooks) ────
// Fixes the split-brain where payment.initiate wrote paymentIntents rows
// (PAY-… references stored in providerPaymentId) while the webhooks only
// updated paymentTransactions (WC-… references from paymentGateway.initiate),
// so payment.initiate payments could never be confirmed. This resolver looks
// the reference up in BOTH tables, verifies the provider-reported
// amount/currency against the stored record BEFORE mutating, and drives order
// confirmation + escrow hold creation from either path. Idempotent: replaying
// the same webhook never double-confirms, double-credits, or double-creates
// the escrow hold.
export async function confirmProviderPayment(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  opts: {
    provider: string;
    reference: string;
    amountMajor: number | null; // provider-reported amount in MAJOR currency units
    currency: string | null;
    rawPayload: unknown;
  },
): Promise<{ ok: boolean; action: string; detail?: string }> {
  const { reference } = opts;
  if (!reference) return { ok: false, action: "no-reference" };
  const now = new Date();

  // ── Resolve the reference in either table ─────────────────────────────────
  let kind: "transaction" | "intent";
  let rowId: string;
  let tenantId: string;
  let orderId: string | null;
  let customerId: string | null;
  let expectedAmount: number;
  let expectedCurrency: string;
  let currentStatus: string;
  let currentFailureReason: string | null;
  // Metadata of the matched paymentIntents row (intent path only) — drives the
  // wallet top-up credit below when metadata.type === "wallet_topup".
  let intentMetadata: Record<string, unknown> | null = null;
  // Intent path only — drives settleIntentLedger below.
  let intentLedgerPendingId: string | null = null;
  let intentAmount: string | null = null;
  let intentCurrency: string | null = null;

  const [tx] = await db.select().from(paymentTransactions)
    .where(eq(paymentTransactions.providerRef, reference)).limit(1);
  if (tx) {
    kind = "transaction";
    rowId = tx.id;
    tenantId = tx.tenantId;
    orderId = tx.orderId ?? null;
    customerId = tx.customerId ?? null;
    expectedAmount = parseFloat(tx.amount);
    expectedCurrency = (tx.currency ?? "").toUpperCase();
    currentStatus = tx.status;
    currentFailureReason = tx.failureReason ?? null;
  } else {
    const [intent] = await db.select().from(paymentIntents)
      .where(eq(paymentIntents.providerPaymentId, reference)).limit(1);
    if (!intent) {
      console.warn(`[payment-confirm] ${opts.provider} ref=${reference} matched no paymentTransactions or paymentIntents row`);
      return { ok: false, action: "not-found", detail: reference };
    }
    kind = "intent";
    rowId = intent.id;
    tenantId = intent.tenantId;
    orderId = intent.orderId ?? null;
    customerId = intent.customerId ?? null;
    expectedAmount = parseFloat(intent.amount);
    expectedCurrency = (intent.currency ?? "").toUpperCase();
    currentStatus = intent.status;
    currentFailureReason = intent.failureReason ?? null;
    intentMetadata = (intent.metadata as Record<string, unknown> | null) ?? null;
    intentLedgerPendingId = intent.ledgerPendingId ?? null;
    intentAmount = intent.amount;
    intentCurrency = intent.currency ?? null;
  }
  // Idempotent (commit / postDirectLedgerLeg both replay-safe): settling the ledger is safe to call on
  // every confirmation path for this intent, including replays, which is how a first attempt that hit a
  // ledger hiccup gets retried and healed.
  const settleLedgerNow = () => kind === "intent"
    ? settleIntentLedger(db, { id: rowId, tenantId, customerId, amount: intentAmount!, currency: intentCurrency, ledgerPendingId: intentLedgerPendingId })
    : Promise.resolve();

  // ── Wallet top-up credit (completed wallet_topup payment intents) ─────────
  // creditWalletTopUp is idempotent: the credit is claimed atomically via a
  // conditional UPDATE stamping metadata.creditedAt, so webhook replays and
  // reconciliation runs can never double-credit.
  const maybeCreditWalletTopUp = async () => {
    if (kind !== "intent" || intentMetadata?.type !== "wallet_topup") return;
    try {
      const result = await creditWalletTopUp(db, rowId);
      if (!result.credited) {
        console.warn(`[payment-confirm] wallet top-up credit skipped for intent ${rowId}: ${result.reason ?? "unknown"}`);
      }
    } catch (err: any) {
      // Never fail the webhook on a wallet-credit error — the reconciliation
      // sweep retries completed-but-uncredited top-ups.
      console.error(`[payment-confirm] wallet top-up credit failed for intent ${rowId}:`, err?.message);
      captureException(err, {
        service: "paymentConfirm",
        operation: "walletTopUpCredit",
        tenantId,
        severity: "critical",
        extra: { intentId: rowId, reference },
      });
    }
  };

  // ── Credit repayment hook (w8 B2B) ────────────────────────────────────────
  // A confirmed repayment-link payment (intent metadata.kind ===
  // 'credit_repayment') pays down the buyer's trade-credit account. Mirrors
  // the wallet top-up pattern: runs on the claim-first success path AND on
  // replay/race paths, but runCreditRepaymentHook claims the
  // processed_webhook_events dedupe ledger before applying, so a replayed
  // webhook can never double-apply. The hook NEVER throws — it returns
  // { applied, reason } — the payment itself is already confirmed.
  const maybeApplyCreditRepayment = async () => {
    if (kind !== "intent" || intentMetadata?.kind !== "credit_repayment") return;
    const { runCreditRepaymentHook } = await import("./creditRepayLink");
    const result = await runCreditRepaymentHook(db, {
      tenantId,
      reference,
      amountMajor: expectedAmount,
      metadata: intentMetadata,
    });
    if (!result.applied && result.reason !== "duplicate") {
      console.warn(`[payment-confirm] credit repayment not applied for ref=${reference}: ${result.reason ?? "unknown"}`);
      captureException(new Error(`credit repayment hook: ${result.reason ?? "unknown"}`), {
        service: "paymentConfirm",
        operation: "creditRepaymentHook",
        tenantId,
        severity: "critical",
        extra: { reference, intentId: rowId },
      });
    }
  };

  // ── Invoice payment hook (platform billing a tenant, e.g. subscription) ──
  // A confirmed invoice-payment intent (metadata.type === 'invoice_payment',
  // created by invoice.initiatePaystackPayment, charged to the PLATFORM's own
  // Paystack account) marks the invoice paid. Idempotent via the same
  // claim-first pattern as maybeCreditWalletTopUp — never throws.
  const maybeMarkInvoicePaid = async () => {
    if (kind !== "intent" || intentMetadata?.type !== "invoice_payment") return;
    try {
      const result = await markInvoicePaidFromPaymentIntent(db, rowId);
      if (!result.paid) {
        console.warn(`[payment-confirm] invoice payment not applied for intent ${rowId}: ${result.reason ?? "unknown"}`);
      }
    } catch (err: any) {
      console.error(`[payment-confirm] invoice payment hook failed for intent ${rowId}:`, err?.message);
      captureException(err, {
        service: "paymentConfirm",
        operation: "invoicePaymentHook",
        tenantId,
        severity: "critical",
        extra: { intentId: rowId, reference },
      });
    }
  };

  // ── PO payment hook (w8 B2B procurement) ─────────────────────────────────
  // A confirmed paynow purchase-order payment (intent metadata.type ===
  // 'po_payment', created by procurement/poFlow.createPoPaymentLink) moves the
  // PO approved → paid and notifies both sides. handlePoPaymentConfirmed is
  // idempotent ('already_paid' on replay). Failures are logged, never thrown.
  const maybeSettlePoPayment = async () => {
    if (kind !== "intent" || intentMetadata?.type !== "po_payment") return;
    const poId = intentMetadata?.poId;
    if (typeof poId !== "string" || !poId) return;
    try {
      const { handlePoPaymentConfirmed } = await import("./procurement/poFlow");
      await handlePoPaymentConfirmed(db, { poId, reference });
    } catch (err: any) {
      console.error(`[payment-confirm] PO payment hook failed for ref=${reference}:`, err?.message);
      captureException(err, {
        service: "paymentConfirm",
        operation: "poPaymentHook",
        tenantId,
        severity: "critical",
        extra: { reference, poId },
      });
    }
  };

  // ── Escrow hold for a paid order (idempotent) ────────────────────────────
  // Runs on the claiming call AND on every replay: if the first attempt died
  // after the payment claim (AF-06), the provider's redelivery creates the
  // missing hold instead of skipping it as "already-completed".
  const ensureEscrowHold = async (oid: string) => {
    const [existingEscrow] = await db.select({ id: escrowTransactions.id })
      .from(escrowTransactions)
      .where(eq(escrowTransactions.orderId, oid))
      .limit(1);
    if (!existingEscrow) {
      const [cfg] = await db.select().from(escrowConfig).where(eq(escrowConfig.id, 1));
      const confirmWindowHours = cfg?.buyerConfirmWindowHours ?? 24;
      const custodyMode = (cfg?.custodyMode ?? "pssp") as "pssp" | "psp";
      // Integer minor-units split (shared/escrowAmounts) — same invariant as
      // escrow.createHold: platformFee + netMerchantAmount == amount always.
      const split = splitEscrowAmounts(expectedAmount, cfg?.platformFeeRate ?? "0.03125");
      const escrowId = randomUUID();
      // AF-06: the hold, the PSP-mode wallet transaction and the wallet
      // balance move together or not at all. Before, a crash between them
      // left a hold whose wallet was never credited, and every replay then
      // skipped (the hold already existed) — the gap could never heal.
      await db.transaction(async (tx) => {
        const inserted = await tx.insert(escrowTransactions).values({
          id: escrowId,
          orderId: oid,
          tenantId,
          customerId,
          amount: split.gross,
          platformFee: split.fee,
          netMerchantAmount: split.net,
          currency: expectedCurrency || "NGN",
          custodyMode,
          state: "escrow_held",
          buyerConfirmDeadline: new Date(Date.now() + confirmWindowHours * 3600 * 1000),
          idempotencyKey: `escrow-hold:${oid}`,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing().returning({ id: escrowTransactions.id });

        if (inserted.length > 0 && custodyMode === "psp") {
          // PSP mode: credit the merchant's escrow wallet (mirrors escrow.createHold)
          let [wallet] = await tx.select().from(merchantWallets)
            .where(eq(merchantWallets.tenantId, tenantId));
          if (!wallet) {
            const walletId = randomUUID();
            await tx.insert(merchantWallets).values({
              id: walletId, tenantId, currency: expectedCurrency || "NGN",
              availableBalance: "0", escrowBalance: "0", totalEarned: "0", totalWithdrawn: "0",
              custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
            }).onConflictDoNothing();
            [wallet] = await tx.select().from(merchantWallets)
              .where(eq(merchantWallets.tenantId, tenantId));
          }
          // Found live 2026-09-26 (user: "everything should be naira"): this used to credit
          // `split.gross` — the ORDER's amount in the ORDER's own currency (expectedCurrency, which can
          // legitimately differ from the wallet's, e.g. one of this tenant's leftover USD orders from the
          // earlier currency bug) — straight into escrowBalance, then labeled the ledger row with
          // `wallet.currency` regardless. A $9,500 payment would have silently become "₦9,500" in the
          // wallet: the raw number carried over, the currency label did not. Wallets are single-currency
          // by design (getOrCreateWallet/getOrCreatePlatformFeeWallet in escrow.ts always create "NGN"),
          // so a mismatch here is never a legitimate multi-currency wallet — it's corruption. Refuse to
          // credit rather than fabricate a conversion; the escrow_transactions row above already recorded
          // its own correct currency, so the money isn't lost, just not auto-reconciled into the wallet.
          const walletCurrency = wallet?.currency ?? "NGN";
          const orderCurrency = expectedCurrency || "NGN";
          if (wallet && orderCurrency !== walletCurrency) {
            console.error(`[payment-confirm] REFUSING wallet credit for order ${oid}: payment currency ${orderCurrency} does not match wallet currency ${walletCurrency} (tenant ${tenantId}) — escrow hold recorded correctly, but the wallet ledger was NOT touched. Needs manual reconciliation.`);
          } else if (wallet) {
            const before = parseFloat(wallet.escrowBalance);
            const after = before + split.grossMinor / 100;
            const walletTxId = randomUUID();
            await tx.insert(walletTransactions).values({
              id: walletTxId,
              walletId: wallet.id,
              tenantId,
              type: "escrow_credit",
              amount: split.gross,
              balanceBefore: before.toFixed(2),
              balanceAfter: after.toFixed(2),
              currency: wallet.currency,
              orderId: oid,
              escrowTxId: escrowId,
              description: `Escrow hold for order ${oid} (${opts.provider} webhook confirmation)`,
              reference,
              createdAt: now,
            });
            await tx.update(merchantWallets).set({
              escrowBalance: sql`${merchantWallets.escrowBalance} + ${split.gross}`,
              updatedAt: now,
            }).where(eq(merchantWallets.id, wallet.id));
            await tx.update(escrowTransactions)
              .set({ buyerWalletTxId: walletTxId, updatedAt: now })
              .where(eq(escrowTransactions.id, escrowId));
          }
        }
      });
    }
  };
  const ensureEscrowHoldOnReplay = async () => {
    if (!orderId) return;
    const [paid] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(
        eq(orders.id, orderId),
        eq(orders.tenantId, tenantId),
        eq(orders.paymentStatus, "completed"),
        sql`${orders.status} NOT IN ('cancelled', 'refunded')`,
      ))
      .limit(1);
    if (!paid) return;
    try {
      await ensureEscrowHold(orderId);
    } catch (err: any) {
      console.error(`[payment-confirm] escrow hold retry failed for order ${orderId}:`, err?.message);
      captureException(err, { service: "paymentConfirm", operation: "escrowHoldRetry", tenantId, severity: "critical", extra: { orderId, reference } });
    }
  };

  // ── Amount/currency verification (BEFORE any state mutation) ─────────────
  // Wave 26 audit F1b: EXACT integer minor-unit comparison — no ₦0.01
  // tolerance. A webhook reporting even 1 kobo off the expected amount is
  // rejected.
  const amountMismatch =
    opts.amountMajor == null ||
    !Number.isFinite(opts.amountMajor) ||
    Math.round(opts.amountMajor * 100) !== Math.round(expectedAmount * 100);
  const currencyMismatch =
    !opts.currency || !expectedCurrency || opts.currency.toUpperCase() !== expectedCurrency;
  if (amountMismatch || currencyMismatch) {
    const reason = `webhook ${amountMismatch ? "amount" : "currency"} mismatch: provider=${opts.amountMajor ?? "?"} ${opts.currency ?? "?"}, expected=${expectedAmount} ${expectedCurrency}`;
    console.error(`[payment-confirm] REJECTED ${opts.provider} ref=${reference}: ${reason}`);
    if (currentStatus !== "completed") {
      const failedAt = now;
      if (kind === "transaction") {
        await db.update(paymentTransactions)
          .set({ status: "failed", failureReason: reason, callbackData: opts.rawPayload as any, updatedAt: failedAt })
          .where(and(eq(paymentTransactions.id, rowId), sql`${paymentTransactions.status} <> 'completed'`));
      } else {
        await db.update(paymentIntents)
          .set({ status: "failed", failureReason: reason, updatedAt: failedAt })
          .where(and(eq(paymentIntents.id, rowId), sql`${paymentIntents.status} <> 'completed'`));
      }
    }
    return { ok: false, action: "amount-currency-mismatch", detail: reason };
  }

  // AF-01: this reference was already judged unpayable (and handed to the
  // quarantine + auto-refund seam) — a replay must return the same verdict.
  if (currentStatus !== "completed" && currentFailureReason?.startsWith(ORDER_NOT_PAYABLE_PREFIX)) {
    return { ok: false, action: "order-not-payable", detail: currentFailureReason };
  }

  // ── Idempotent guarded transition to completed ────────────────────────────
  if (currentStatus === "completed") {
    // Webhook replay of an already-completed intent — still ensure the wallet
    // top-up credit landed (idempotent no-op when it already did), and retry
    // the ledger settle in case an earlier attempt failed (see settleIntentLedger).
    await settleLedgerNow();
    await ensureEscrowHoldOnReplay();
    await maybeCreditWalletTopUp();
    await maybeApplyCreditRepayment();
    await maybeSettlePoPayment();
    await maybeMarkInvoicePaid();
    return { ok: true, action: "already-completed" };
  }
  let transitioned = false;
  if (kind === "transaction") {
    const updated = await db.update(paymentTransactions)
      .set({ status: "completed", paidAt: now, callbackData: opts.rawPayload as any, updatedAt: now })
      .where(and(eq(paymentTransactions.id, rowId), sql`${paymentTransactions.status} <> 'completed'`))
      .returning({ id: paymentTransactions.id });
    transitioned = updated.length > 0;
  } else {
    const updated = await db.update(paymentIntents)
      .set({
        status: "completed",
        completedAt: now,
        metadata: sql`COALESCE(${paymentIntents.metadata}, '{}'::jsonb) || ${JSON.stringify({ providerWebhook: opts.rawPayload })}::jsonb`,
        updatedAt: now,
      })
      .where(and(eq(paymentIntents.id, rowId), sql`${paymentIntents.status} <> 'completed'`))
      .returning({ id: paymentIntents.id });
    transitioned = updated.length > 0;
  }
  if (!transitioned) {
    // Lost a race with a concurrent webhook delivery — already handled.
    await settleLedgerNow();
    await ensureEscrowHoldOnReplay();
    await maybeCreditWalletTopUp();
    await maybeApplyCreditRepayment();
    await maybeSettlePoPayment();
    await maybeMarkInvoicePaid();
    return { ok: true, action: "already-completed" };
  }
  // ── Drive order confirmation + escrow hold creation (either path) ─────────
  // Wave-8 B2B intents reuse paymentIntents.orderId for NON-storefront
  // references: po_payment intents carry the purchase-order uuid and
  // credit_repayment intents carry the PO / credit-account uuid. Treating
  // those as orders.id violates the escrow_transactions
  // (order_id → orders.id) FK and 500s the webhook BEFORE the PO/repayment
  // hooks below run — so only drive order confirmation for references that
  // really are orders rows.
  if (orderId) {
    // Tenant-scoped: an orderId pointing at ANOTHER tenant's order is treated
    // as a non-order reference (Wave 26 audit F1b).
    const [orderRow] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!orderRow) orderId = null;
  }

  // AF-01: a payment for an order that was cancelled, or whose stock was
  // released and is now gone, must not confirm it. This call won the claim,
  // so it alone hands the payment back: status → failed with the
  // ORDER_NOT_PAYABLE_PREFIX reason, ledger reservation left to auto-void,
  // and the webhook seam (runPaymentMismatchQuarantineHook) quarantines and
  // auto-refunds the collected amount.
  if (orderId) {
    const gate = await ensureOrderPayable(db, tenantId, orderId, now);
    if (!gate.payable) {
      const reason = `${ORDER_NOT_PAYABLE_PREFIX}: ${gate.reason}`;
      console.error(`[payment-confirm] REJECTED ${opts.provider} ref=${reference} for order ${orderId}: ${reason}`);
      if (kind === "transaction") {
        await db.update(paymentTransactions)
          .set({ status: "failed", failureReason: reason.slice(0, 500), updatedAt: now })
          .where(eq(paymentTransactions.id, rowId));
      } else {
        await db.update(paymentIntents)
          .set({ status: "failed", failureReason: reason, updatedAt: now })
          .where(eq(paymentIntents.id, rowId));
      }
      captureException(new Error(`[AF-01] payment for unpayable order: ${reason}`), {
        service: "paymentConfirm",
        operation: "orderNotPayable",
        tenantId,
        severity: "critical",
        extra: { orderId, reference, provider: opts.provider },
      });
      return { ok: false, action: "order-not-payable", detail: reason };
    }
  }

  // The intent/transaction just transitioned to completed on THIS call — settle its TigerBeetle
  // reservation now (see settleIntentLedger for why this must never have been skippable).
  await settleLedgerNow();

  if (orderId) {
    // Wave 26 audit F1b: tenant-scoped update — the order lookup/transition
    // must never touch a row outside the payment's own tenant.
    await db.update(orders)
      .set({ paymentStatus: "completed", status: "confirmed", updatedAt: now })
      .where(and(
        eq(orders.id, orderId),
        eq(orders.tenantId, tenantId),
        sql`${orders.paymentStatus} <> 'completed'`,
        // AF-01: never resurrect a terminal order, even if it was cancelled
        // between ensureOrderPayable and here.
        sql`${orders.status} NOT IN ('cancelled', 'refunded')`,
      ));

    // Payment confirmed → commit the stock reservations made at order
    // creation (reserved → committed; stock stays decremented). Runs ONLY on
    // this claimed success path — failure / non-claim / amount-mismatch paths
    // return above without touching reservations. Idempotent: replays find
    // no 'reserved' rows left.
    try {
      const committed = await commitReservations(db, orderId);
      if (committed > 0) {
        console.log(`[payment-confirm] committed ${committed} stock reservation(s) for order ${orderId}`);
      }
    } catch (err: any) {
      // Never fail a confirmed payment on the reservation book-keeping — the
      // expiry sweeper skips paid orders, so rows can't leak back to stock.
      console.error(`[payment-confirm] commitReservations failed for order ${orderId}:`, err?.message);
      captureException(err, {
        service: "paymentConfirm",
        operation: "commitReservations",
        tenantId,
        severity: "error",
        extra: { orderId, reference },
      });
    }

    // Digital receipt to the buyer (additive, non-throwing): exact figures
    // from the confirmed order row — business name, itemized lines, discount,
    // delivery fee, total paid, payment ref, delivery PIN, tracking link.
    try {
      // Delivery-fulfillment orders get a shipment (+ fresh PIN) created right here, right after
      // payment — see ensureDeliveryShipment's own comment for why nothing did this before.
      const freshPin = await ensureDeliveryShipment(db, orderId, tenantId);
      const { sendOrderReceipt } = await import("./receipts");
      const receipt = await sendOrderReceipt(db, orderId, reference, freshPin);
      if (!receipt.sent) {
        console.warn(`[payment-confirm] receipt skipped for order ${orderId}: ${receipt.reason}`);
      }
    } catch (err: any) {
      console.error(`[payment-confirm] receipt send failed for order ${orderId}:`, err?.message);
      captureException(err, {
        service: "paymentConfirm",
        operation: "receiptSend",
        tenantId,
        severity: "warn",
        extra: { orderId, reference },
      });
    }

    await ensureEscrowHold(orderId);
  }

  // Credit the merchant wallet for wallet_topup payment intents (idempotent).
  await maybeCreditWalletTopUp();
  // Apply the trade-credit repayment for credit_repayment intents (dedupe-guarded).
  await maybeApplyCreditRepayment();
  // Settle paynow purchase orders for po_payment intents (idempotent).
  await maybeSettlePoPayment();
  // Mark the invoice paid for invoice_payment intents (idempotent).
  await maybeMarkInvoicePaid();

  // Transactional outbox: enqueue Medusa/Odoo sync for the confirmed order.
  // Enqueue failures are logged but never fail the payment confirmation.
  if (orderId) {
    try {
      await syncLocalChange(db, {
        tenantId,
        entity: "order",
        entityId: orderId,
        action: "confirmed",
        data: {
          customerId,
          currency: expectedCurrency || "NGN",
          totalAmount: expectedAmount,
          paymentProvider: opts.provider,
          paymentReference: reference,
        },
      });
    } catch (e: unknown) {
      console.error("[payment-confirm] integration outbox enqueue failed:", (e as Error)?.message);
    }
  }

  // Usage metering (platform ops): a confirmed payment means an order was
  // created/converted — count it against the tenant's monthly orders quota.
  // Additive + never blocking: recordUsage swallows its own errors and a
  // metering outage must never fail a confirmed payment.
  if (orderId) {
    try {
      const { recordUsage, METRIC_ORDERS_CREATED } = await import("./metering");
      await recordUsage(db, tenantId, METRIC_ORDERS_CREATED);
    } catch (e: unknown) {
      console.error("[payment-confirm] usage metering failed:", (e as Error)?.message);
    }
  }

  console.log(`[payment-confirm] ${opts.provider} ref=${reference} confirmed via ${kind} row ${rowId}`);
  return { ok: true, action: "confirmed" };
}
