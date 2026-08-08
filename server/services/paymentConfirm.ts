/**
 * Shared provider payment confirmation (Paystack/Flutterwave webhooks,
 * receipt-screenshot verification, and any other payment confirmation path).
 *
 * Extracted from server/_core/index.ts so ALL confirmation paths — provider
 * webhooks AND the WhatsApp receipt-scan pipeline — run through the SAME
 * money logic. Never duplicate this logic elsewhere.
 */
import { eq, and, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { getDb } from "../db";
import {
  paymentTransactions, paymentIntents, orders,
  escrowConfig, escrowTransactions, merchantWallets, walletTransactions,
} from "../../drizzle/schema";
import { splitEscrowAmounts } from "../../shared/escrowAmounts";
import { syncLocalChange } from "./integrations/outbox";
import { creditWalletTopUp } from "../routers/escrow";
import { commitReservations } from "./inventory";

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
  // Metadata of the matched paymentIntents row (intent path only) — drives the
  // wallet top-up credit below when metadata.type === "wallet_topup".
  let intentMetadata: Record<string, unknown> | null = null;

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
    intentMetadata = (intent.metadata as Record<string, unknown> | null) ?? null;
  }

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
    }
  };

  // ── Amount/currency verification (BEFORE any state mutation) ─────────────
  const amountMismatch =
    opts.amountMajor == null ||
    !Number.isFinite(opts.amountMajor) ||
    Math.abs(opts.amountMajor - expectedAmount) > 0.01;
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

  // ── Idempotent guarded transition to completed ────────────────────────────
  if (currentStatus === "completed") {
    // Webhook replay of an already-completed intent — still ensure the wallet
    // top-up credit landed (idempotent no-op when it already did).
    await maybeCreditWalletTopUp();
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
    await maybeCreditWalletTopUp();
    return { ok: true, action: "already-completed" };
  }

  // ── Drive order confirmation + escrow hold creation (either path) ─────────
  if (orderId) {
    await db.update(orders)
      .set({ paymentStatus: "completed", status: "confirmed", updatedAt: now })
      .where(and(eq(orders.id, orderId), sql`${orders.paymentStatus} <> 'completed'`));

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
    }

    // Digital receipt to the buyer (additive, non-throwing): exact figures
    // from the confirmed order row — business name, itemized lines, discount,
    // delivery fee, total paid, payment ref, delivery PIN, tracking link.
    try {
      const { sendOrderReceipt } = await import("./receipts");
      const receipt = await sendOrderReceipt(db, orderId, reference);
      if (!receipt.sent) {
        console.warn(`[payment-confirm] receipt skipped for order ${orderId}: ${receipt.reason}`);
      }
    } catch (err: any) {
      console.error(`[payment-confirm] receipt send failed for order ${orderId}:`, err?.message);
    }

    const [existingEscrow] = await db.select({ id: escrowTransactions.id })
      .from(escrowTransactions)
      .where(eq(escrowTransactions.orderId, orderId))
      .limit(1);
    if (!existingEscrow) {
      const [cfg] = await db.select().from(escrowConfig).where(eq(escrowConfig.id, 1));
      const confirmWindowHours = cfg?.buyerConfirmWindowHours ?? 24;
      const custodyMode = (cfg?.custodyMode ?? "pssp") as "pssp" | "psp";
      // Integer minor-units split (shared/escrowAmounts) — same invariant as
      // escrow.createHold: platformFee + netMerchantAmount == amount always.
      const split = splitEscrowAmounts(expectedAmount, cfg?.platformFeeRate ?? "0.03125");
      const escrowId = randomUUID();
      const inserted = await db.insert(escrowTransactions).values({
        id: escrowId,
        orderId,
        tenantId,
        customerId,
        amount: split.gross,
        platformFee: split.fee,
        netMerchantAmount: split.net,
        currency: expectedCurrency || "NGN",
        custodyMode,
        state: "escrow_held",
        buyerConfirmDeadline: new Date(Date.now() + confirmWindowHours * 3600 * 1000),
        idempotencyKey: `escrow-hold:${orderId}`,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().returning({ id: escrowTransactions.id });

      if (inserted.length > 0 && custodyMode === "psp") {
        // PSP mode: credit the merchant's escrow wallet (mirrors escrow.createHold)
        let [wallet] = await db.select().from(merchantWallets)
          .where(eq(merchantWallets.tenantId, tenantId));
        if (!wallet) {
          const walletId = randomUUID();
          await db.insert(merchantWallets).values({
            id: walletId, tenantId, currency: expectedCurrency || "NGN",
            availableBalance: "0", escrowBalance: "0", totalEarned: "0", totalWithdrawn: "0",
            custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
          }).onConflictDoNothing();
          [wallet] = await db.select().from(merchantWallets)
            .where(eq(merchantWallets.tenantId, tenantId));
        }
        if (wallet) {
          const before = parseFloat(wallet.escrowBalance);
          const after = before + split.grossMinor / 100;
          const walletTxId = randomUUID();
          await db.insert(walletTransactions).values({
            id: walletTxId,
            walletId: wallet.id,
            tenantId,
            type: "escrow_credit",
            amount: split.gross,
            balanceBefore: before.toFixed(2),
            balanceAfter: after.toFixed(2),
            currency: wallet.currency,
            orderId,
            escrowTxId: escrowId,
            description: `Escrow hold for order ${orderId} (${opts.provider} webhook confirmation)`,
            reference,
            createdAt: now,
          });
          await db.update(merchantWallets).set({
            escrowBalance: sql`${merchantWallets.escrowBalance} + ${split.gross}`,
            updatedAt: now,
          }).where(eq(merchantWallets.id, wallet.id));
          await db.update(escrowTransactions)
            .set({ buyerWalletTxId: walletTxId, updatedAt: now })
            .where(eq(escrowTransactions.id, escrowId));
        }
      }
    }
  }

  // Credit the merchant wallet for wallet_topup payment intents (idempotent).
  await maybeCreditWalletTopUp();

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

  console.log(`[payment-confirm] ${opts.provider} ref=${reference} confirmed via ${kind} row ${rowId}`);
  return { ok: true, action: "confirmed" };
}
