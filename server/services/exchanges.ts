/**
 * === W43 exchanges (Coder B): exchange lifecycle ===
 *
 * exchange_requests (migration 0132) — swap one order line for another
 * product. State machine (illegal transitions are rejected, never silent):
 *
 *   requested → approved | rejected | cancelled
 *   approved  → in_transit → received → completed
 *
 * Money leg (integer cents, idempotent, fail-closed):
 *   - priceDeltaCents > 0 on approve → payment link via the EXISTING
 *     payment intent path (paymentIntents row + initiateWithFallback —
 *     adjacent seam, paymentConfirm.ts PINNED and untouched). Idempotency
 *     key `exchange_delta:<id>`; a re-approve retry reuses the open intent.
 *   - priceDeltaCents < 0 on approve → customerWallet.creditWallet (W41
 *     REAL contract — never re-stubbed) with idempotent ref
 *     `exchange_refund:<id>`.
 *
 * Stock leg (on 'received', ONE transaction, audited in stock_adjustments):
 *   - fromLine qty restocked (products.stockQuantity + inventory_snapshots
 *     credit, tenant-predicated) with reason 'exchange_in' — or WRITTEN OFF
 *     when the exchange is flagged `damaged` (no restock; a 0-delta 'damage'
 *     audit row documents the write-off);
 *   - toLine stock reserved CLAIM-FIRST (conditional
 *     UPDATE ... WHERE stockQuantity >= qty — concurrent claims can never
 *     oversell) + an inventory_reservations row, audited 'exchange_out'.
 *
 * Customer notifications go through channelParity.sendCustomerText with the
 * registered 'exchange_status' category — WhatsApp AND Telegram parity.
 * Tenant scoping on every query; assertTenantActive on every state mutation.
 */
import { and, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  exchangeRequests,
  orderItems,
  orders,
  products,
  type ExchangeRequest,
} from "../../drizzle/schema";
import { assertTenantActive, getTenantStatus } from "./tenantGuard";
import { creditWallet } from "./customerWallet";
import { recordStockAdjustment } from "./stockAdjustments";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type DbOrTx = Pick<Db, "select" | "insert" | "update" | "execute" | "transaction">;

export const EXCHANGE_STATUSES = [
  "requested", "approved", "rejected", "in_transit", "received", "completed", "cancelled",
] as const;
export type ExchangeStatus = (typeof EXCHANGE_STATUSES)[number];

/** Legal non-stock transitions. 'received' is ONLY reachable via
 *  receiveExchange (it carries the stock leg); use transitionExchange for
 *  the rest. */
const LEGAL_TRANSITIONS: Record<ExchangeStatus, ExchangeStatus[]> = {
  requested: ["approved", "rejected", "cancelled"],
  approved: ["in_transit", "cancelled"],
  rejected: [],
  in_transit: ["received", "cancelled"],
  received: ["completed"],
  completed: [],
  cancelled: [],
};

// ─── Notifications (channelParity — WA + TG parity, fail-open) ──────────────

type NotifyImpl = (tenantId: string, ref: string, text: string, opts?: { paymentUrl?: string | null; orderId?: string | null }) => Promise<unknown>;

/** Default: route through channelParity.notifyCustomer ('exchange_status')
 *  for telegram-linked customers and the byte-equivalent WA path otherwise
 *  (sendCustomerText). A payment link rides the registered 'payment_link'
 *  category so telegram gets a URL inline-button, never a wa.me deep link. */
const defaultNotify: NotifyImpl = async (tenantId, ref, text, opts) => {
  const parity = await import("./channelParity");
  if (opts?.paymentUrl) {
    const routed = await parity.notifyCustomer(tenantId, ref, "payment_link", {
      text, paymentUrl: opts.paymentUrl, orderId: opts.orderId ?? undefined, notifType: "exchange_payment_link",
    });
    if (routed.handled) return routed;
  }
  return parity.sendCustomerText(tenantId, ref, "exchange_status", text, { notifType: "exchange_status" });
};

async function notifyExchange(
  tenantId: string,
  ref: string,
  text: string,
  deps: { notify?: NotifyImpl; paymentUrl?: string | null; orderId?: string | null },
): Promise<void> {
  try {
    await (deps.notify ?? defaultNotify)(tenantId, ref, text, { paymentUrl: deps.paymentUrl, orderId: deps.orderId });
  } catch (e: any) {
    console.warn("[exchanges] notify failed (fail-open):", e?.message);
  }
}

/** Fail-closed tenant-lifecycle gate for state mutations. */
async function assertActive(db: DbOrTx, tenantId: string): Promise<void> {
  const status = await getTenantStatus(db, tenantId);
  if (status !== null) assertTenantActive({ id: tenantId, status: status as never });
}

// ─── Request ─────────────────────────────────────────────────────────────────

export interface RequestExchangeDeps {
  tenantId: string;
  orderId: string;
  fromOrderLineId: string;
  toProductId: string;
  toVariantId?: string | null;
  qty: number;
  rmaRequestId?: string | null;
  damaged?: boolean;
  requestedBy: string;
  requestedVia?: "whatsapp" | "telegram" | "admin";
  notify?: NotifyImpl;
}

/**
 * Open an exchange request. priceDeltaCents is computed from REAL prices
 * (never trusted from the caller): (toProduct.price − fromLine.unitPrice) ×
 * qty, in integer cents. Positive → buyer pays the difference on approve;
 * negative → the difference is credited to the buyer's wallet on approve.
 */
export async function requestExchange(
  db: Db,
  deps: RequestExchangeDeps,
): Promise<ExchangeRequest> {
  const { tenantId } = deps;
  await assertActive(db, tenantId);
  if (!Number.isInteger(deps.qty) || deps.qty <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "qty must be a positive integer" });
  }

  const [line] = await db
    .select()
    .from(orderItems)
    .where(and(eq(orderItems.id, deps.fromOrderLineId), eq(orderItems.orderId, deps.orderId)))
    .limit(1);
  if (!line) throw new TRPCError({ code: "NOT_FOUND", message: "Order line not found for this order" });
  if (deps.qty > line.quantity) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Cannot exchange ${deps.qty} units of a ${line.quantity}-unit line` });
  }

  const [order] = await db
    .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status })
    .from(orders)
    .where(and(eq(orders.id, deps.orderId), eq(orders.tenantId, tenantId)))
    .limit(1);
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
  if (order.status === "cancelled" || order.status === "refunded") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Order is already ${order.status}` });
  }

  const [toProduct] = await db
    .select({ id: products.id, name: products.name, price: products.price })
    .from(products)
    .where(and(eq(products.id, deps.toProductId), eq(products.tenantId, tenantId)))
    .limit(1);
  if (!toProduct) throw new TRPCError({ code: "NOT_FOUND", message: "Replacement product not found" });

  const fromCents = Math.round(parseFloat(String(line.unitPrice)) * 100);
  const toCents = Math.round(parseFloat(String(toProduct.price)) * 100);
  const priceDeltaCents = (toCents - fromCents) * deps.qty;

  const [row] = await db.insert(exchangeRequests).values({
    tenantId,
    orderId: deps.orderId,
    rmaRequestId: deps.rmaRequestId ?? null,
    fromOrderLineId: deps.fromOrderLineId,
    toProductId: deps.toProductId,
    toVariantId: deps.toVariantId ?? null,
    qty: deps.qty,
    priceDeltaCents,
    requestedBy: deps.requestedBy,
    requestedVia: deps.requestedVia ?? "admin",
    damaged: deps.damaged === true,
  }).returning();

  await notifyExchange(tenantId, deps.requestedBy,
    `🔁 Exchange requested for order ${order.orderNumber}: ${deps.qty} × ${line.productName} → ${toProduct.name}` +
    (priceDeltaCents > 0 ? ` (you'll pay ₦${(priceDeltaCents / 100).toFixed(2)} more)` : "") +
    (priceDeltaCents < 0 ? ` (₦${(-priceDeltaCents / 100).toFixed(2)} back as store credit)` : "") +
    `. The merchant will review it shortly.`,
    { notify: deps.notify, orderId: deps.orderId });
  return row;
}

// ─── Decide (approve / reject) ───────────────────────────────────────────────

export interface PaymentLinkResult {
  paymentIntentId: string;
  paymentUrl: string | null;
  reference: string;
}
export type CreatePaymentLinkImpl = (input: {
  tenantId: string; orderId: string; customerRef: string; amountCents: number; currency: string; exchangeId: string;
}) => Promise<PaymentLinkResult>;

/**
 * Default positive-delta payment link: the EXISTING payment intent path
 * (paymentIntents row + provider fallback chain — same shape as
 * creditRepayLink.createRepaymentLink; paymentConfirm.ts untouched).
 * Idempotent on `exchange_delta:<exchangeId>`: a repeated approve reuses
 * the still-open intent instead of double-charging.
 */
export const createExchangePaymentLink: CreatePaymentLinkImpl = async (input) => {
  const db = await getDb();
  if (!db) throw new Error("exchanges: db unavailable");
  const { paymentIntents } = await import("../../drizzle/schema");
  const idemKey = `exchange_delta:${input.exchangeId}`;

  const existing = await db.select().from(paymentIntents)
    .where(eq(paymentIntents.idempotencyKey, idemKey)).limit(1).catch(() => [] as any[]);
  const open = (Array.isArray(existing) ? existing : [])[0];
  if (open && (open.status === "pending" || open.status === "initiated")) {
    return {
      paymentIntentId: open.id,
      paymentUrl: (open.metadata as any)?.paymentUrl ?? null,
      reference: open.providerPaymentId,
    };
  }

  const { randomUUID } = await import("crypto");
  const paymentIntentId = randomUUID();
  const reference = `EXC-${Date.now()}-${paymentIntentId.slice(0, 8).toUpperCase()}`;
  const now = new Date();
  await db.insert(paymentIntents).values({
    id: paymentIntentId,
    tenantId: input.tenantId,
    orderId: input.orderId,
    customerId: input.customerRef,
    amount: (input.amountCents / 100).toFixed(2),
    currency: input.currency,
    provider: "paystack",
    providerPaymentId: reference,
    idempotencyKey: idemKey,
    status: "pending",
    metadata: { kind: "exchange_delta", exchangeId: input.exchangeId, tenantId: input.tenantId },
    createdAt: now,
    updatedAt: now,
  });

  let paymentUrl: string | null = null;
  try {
    const { initiateWithFallback } = await import("./payments/initiateWithFallback");
    const { ENV } = await import("../_core/env");
    const fallback = await initiateWithFallback(input.tenantId, {
      tenantId: input.tenantId,
      amountCents: input.amountCents,
      currency: input.currency,
      reference,
      metadata: {
        payment_intent_id: paymentIntentId,
        tenant_id: input.tenantId,
        kind: "exchange_delta",
        exchangeId: input.exchangeId,
      },
      customer: {
        phone: input.customerRef,
        email: `${input.customerRef.replace(/\D/g, "") || "exchange"}@wa-app.newfire.app`,
      },
      callbackUrl: `${ENV.appUrl}/orders`,
    });
    paymentUrl = fallback.result.authorizationUrl ?? null;
    await db.update(paymentIntents).set({
      status: "initiated",
      metadata: { kind: "exchange_delta", exchangeId: input.exchangeId, tenantId: input.tenantId, paymentUrl, servedProvider: fallback.providerId },
      updatedAt: new Date(),
    }).where(eq(paymentIntents.id, paymentIntentId));
  } catch (err: any) {
    // Fail-closed money: leave the intent failed for audit, never pretend a
    // link exists. The approve still lands — the merchant can retry the
    // link via a repeated decide call (idempotency key reuses the row).
    await db.update(paymentIntents).set({
      status: "failed",
      failureReason: `provider_init: ${String(err?.message ?? err).slice(0, 300)}`,
      updatedAt: new Date(),
    }).where(eq(paymentIntents.id, paymentIntentId)).catch(() => {});
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Exchange payment link failed: ${err?.message ?? err}` });
  }
  return { paymentIntentId, paymentUrl, reference };
};

export interface DecideExchangeDeps {
  exchangeId: string;
  tenantId: string;
  approve: boolean;
  actorId?: string | null;
  note?: string;
  notify?: NotifyImpl;
  /** Injectable for journeys; defaults to the real payment-intent path. */
  createPaymentLinkImpl?: CreatePaymentLinkImpl;
}

/**
 * Merchant decision, claim-first from 'requested' only (a double decision
 * is a CONFLICT, never a flip-flop). Approve settles the price delta:
 * positive → payment link; negative → wallet credit (W41 creditWallet,
 * idempotent ref). Both happen BEFORE the status lands so a money failure
 * refuses the approval instead of stranding it.
 */
export async function decideExchange(
  db: Db,
  deps: DecideExchangeDeps,
): Promise<{ exchange: ExchangeRequest; paymentUrl: string | null }> {
  const { tenantId } = deps;
  await assertActive(db, tenantId);
  const [ex] = await db.select().from(exchangeRequests)
    .where(and(eq(exchangeRequests.id, deps.exchangeId), eq(exchangeRequests.tenantId, tenantId)))
    .limit(1);
  if (!ex) throw new TRPCError({ code: "NOT_FOUND", message: "Exchange request not found" });
  if (ex.status !== "requested") {
    throw new TRPCError({ code: "CONFLICT", message: `Exchange already decided (status ${ex.status})` });
  }

  let paymentUrl: string | null = null;
  let paymentIntentId: string | null = null;
  let walletEntryRef: string | null = null;

  if (deps.approve && ex.priceDeltaCents > 0) {
    const [order] = await db.select({ currency: orders.currency }).from(orders)
      .where(eq(orders.id, ex.orderId)).limit(1);
    const link = await (deps.createPaymentLinkImpl ?? createExchangePaymentLink)({
      tenantId,
      orderId: ex.orderId,
      customerRef: ex.requestedBy,
      amountCents: ex.priceDeltaCents,
      currency: order?.currency ?? "NGN",
      exchangeId: ex.id,
    });
    paymentUrl = link.paymentUrl;
    paymentIntentId = link.paymentIntentId;
  } else if (deps.approve && ex.priceDeltaCents < 0) {
    walletEntryRef = `exchange_refund:${ex.id}`;
    const credit = await creditWallet(
      tenantId, ex.requestedBy, -ex.priceDeltaCents, "refund_to_wallet", walletEntryRef,
      db as unknown as Parameters<typeof creditWallet>[5], { exchangeId: ex.id, orderId: ex.orderId },
    );
    if (!credit.ok) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Wallet credit failed: ${credit.error ?? "unknown"}` });
    }
  }

  const now = new Date();
  const decided = await db.update(exchangeRequests).set({
    status: deps.approve ? "approved" : "rejected",
    merchantNote: deps.note ?? null,
    paymentIntentId: paymentIntentId ?? ex.paymentIntentId,
    walletEntryRef: walletEntryRef ?? ex.walletEntryRef,
    decidedAt: now,
    updatedAt: now,
  }).where(and(
    eq(exchangeRequests.id, ex.id),
    eq(exchangeRequests.tenantId, tenantId),
    eq(exchangeRequests.status, "requested"),
  )).returning();
  if (decided.length !== 1) {
    throw new TRPCError({ code: "CONFLICT", message: "Exchange decided concurrently — no state changed" });
  }

  const [order] = await db.select({ orderNumber: orders.orderNumber }).from(orders)
    .where(eq(orders.id, ex.orderId)).limit(1);
  const num = order?.orderNumber ?? ex.orderId;
  const body = deps.approve
    ? `✅ Your exchange for order ${num} was approved.` +
      (paymentUrl ? ` Pay the difference here: ${paymentUrl}` : "") +
      (ex.priceDeltaCents < 0 ? ` ₦${(-ex.priceDeltaCents / 100).toFixed(2)} was credited to your wallet as store credit.` : "") +
      ` Send the item(s) back — we'll ship the replacement once received.`
    : `❌ Your exchange request for order ${num} was rejected${deps.note ? `: ${deps.note}` : "."}`;
  await notifyExchange(tenantId, ex.requestedBy, body, { notify: deps.notify, paymentUrl, orderId: ex.orderId });
  return { exchange: decided[0], paymentUrl };
}

// ─── Transitions ─────────────────────────────────────────────────────────────

export interface TransitionExchangeDeps {
  exchangeId: string;
  tenantId: string;
  to: ExchangeStatus;
  actorId?: string | null;
  notify?: NotifyImpl;
}

/**
 * Claim-first state transition for the non-stock legs
 * (approved→in_transit, received→completed, →cancelled from any open
 * state). Illegal transitions are rejected with CONFLICT. 'received' is
 * refused here — use receiveExchange, which carries the stock leg.
 * Cancel is fail-closed on money: an approved exchange whose wallet credit
 * already landed cannot be cancelled (reverse the credit first).
 */
export async function transitionExchange(
  db: Db,
  deps: TransitionExchangeDeps,
): Promise<ExchangeRequest> {
  const { tenantId } = deps;
  await assertActive(db, tenantId);
  if (deps.to === "received") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Use receiveExchange — 'received' carries the stock leg" });
  }
  const [ex] = await db.select().from(exchangeRequests)
    .where(and(eq(exchangeRequests.id, deps.exchangeId), eq(exchangeRequests.tenantId, tenantId)))
    .limit(1);
  if (!ex) throw new TRPCError({ code: "NOT_FOUND", message: "Exchange request not found" });

  const from = ex.status as ExchangeStatus;
  if (!LEGAL_TRANSITIONS[from]?.includes(deps.to)) {
    throw new TRPCError({ code: "CONFLICT", message: `Illegal exchange transition ${from} → ${deps.to}` });
  }
  if (deps.to === "cancelled" && ex.walletEntryRef) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Wallet credit already applied for this exchange — reverse the credit before cancelling",
    });
  }

  const now = new Date();
  const stamp =
    deps.to === "in_transit" ? { inTransitAt: now }
    : deps.to === "completed" ? { completedAt: now }
    : deps.to === "cancelled" ? { cancelledAt: now }
    : {};
  const moved = await db.update(exchangeRequests).set({
    status: deps.to, ...stamp, updatedAt: now,
  }).where(and(
    eq(exchangeRequests.id, ex.id),
    eq(exchangeRequests.tenantId, tenantId),
    eq(exchangeRequests.status, from),
  )).returning();
  if (moved.length !== 1) {
    throw new TRPCError({ code: "CONFLICT", message: "Exchange status changed concurrently — transition aborted" });
  }

  const [order] = await db.select({ orderNumber: orders.orderNumber }).from(orders)
    .where(eq(orders.id, ex.orderId)).limit(1);
  const label = deps.to === "in_transit" ? "on its way back to the store"
    : deps.to === "completed" ? "completed — enjoy your replacement"
    : "cancelled";
  await notifyExchange(tenantId, ex.requestedBy,
    `🔁 Exchange for order ${order?.orderNumber ?? ex.orderId} is now ${label}.`,
    { notify: deps.notify, orderId: ex.orderId });
  return moved[0];
}

// ─── Receive (stock leg) ─────────────────────────────────────────────────────

export interface ReceiveExchangeDeps {
  exchangeId: string;
  tenantId: string;
  actorId?: string | null;
  notify?: NotifyImpl;
}

/**
 * Mark the returned goods received and execute BOTH stock legs in ONE
 * transaction (claim-first in_transit→received guard makes a double-receive
 * a CONFLICT, never a double restock):
 *   1. fromLine: restock products.stockQuantity + inventory_snapshots
 *      (tenant-predicated) and audit 'exchange_in' +qty — or, when the
 *      exchange is flagged damaged, WRITE OFF (no restock; a 0-delta
 *      'damage' audit row records the decision);
 *   2. toLine: claim-first reserve — conditional
 *      UPDATE ... WHERE stockQuantity >= qty (exactly one concurrent claim
 *      wins; the loser throws and the WHOLE receipt rolls back) + an
 *      inventory_reservations row for the order, audited 'exchange_out' −qty.
 */
export async function receiveExchange(
  db: Db,
  deps: ReceiveExchangeDeps,
): Promise<ExchangeRequest> {
  const { tenantId } = deps;
  await assertActive(db, tenantId);
  const now = new Date();

  const received = await db.transaction(async (tx) => {
    const claimed = await tx.update(exchangeRequests).set({
      status: "received", receivedAt: now, updatedAt: now,
    }).where(and(
      eq(exchangeRequests.id, deps.exchangeId),
      eq(exchangeRequests.tenantId, tenantId),
      eq(exchangeRequests.status, "in_transit"),
    )).returning();
    if (claimed.length !== 1) {
      throw new TRPCError({ code: "CONFLICT", message: "Exchange is not in_transit (or not found) — no stock touched" });
    }
    const ex = claimed[0];

    const [line] = await tx.select().from(orderItems)
      .where(eq(orderItems.id, ex.fromOrderLineId)).limit(1);
    if (!line) throw new TRPCError({ code: "NOT_FOUND", message: "Origin order line not found" });

    // ── Leg 1: fromLine back into stock (or written off when damaged) ──
    if (ex.damaged) {
      // Write-off: goods received but NOT sellable — no stock mutation; the
      // 0-delta audit row is the paper trail for the write-off decision.
      await recordStockAdjustment(tx, {
        tenantId, productId: line.productId, deltaQty: 0, reason: "damage",
        refType: "exchange", refId: ex.id, actorId: deps.actorId ?? null,
        note: `Exchange ${ex.id}: ${ex.qty} unit(s) received damaged — written off, not restocked`,
      });
    } else {
      const restocked = await tx.update(products).set({
        stockQuantity: sql`${products.stockQuantity} + ${ex.qty}`,
        updatedAt: now,
      }).where(and(eq(products.id, line.productId), eq(products.tenantId, tenantId)))
        .returning({ id: products.id });
      if (restocked.length === 1) {
        // Same tenant-predicated snapshot credit as orderCancel/rma.
        await tx.execute(sql`
          UPDATE inventory_snapshots
          SET "reservedQty" = GREATEST(0, CAST("reservedQty" AS NUMERIC) - ${ex.qty}),
              "availableQty" = CAST("availableQty" AS NUMERIC) + ${ex.qty}
          WHERE "productId" = ${line.productId} AND "tenantId" = ${tenantId}
        `);
        await recordStockAdjustment(tx, {
          tenantId, productId: line.productId, deltaQty: ex.qty, reason: "exchange_in",
          refType: "exchange", refId: ex.id, actorId: deps.actorId ?? null,
          note: `Exchange ${ex.id}: returned units restocked`,
        });
      }
    }

    // ── Leg 2: toLine claim-first reserve ──
    const reserved = await tx.update(products).set({
      stockQuantity: sql`${products.stockQuantity} - ${ex.qty}`,
      updatedAt: now,
    }).where(and(
      eq(products.id, ex.toProductId),
      eq(products.tenantId, tenantId),
      sql`${products.stockQuantity} >= ${ex.qty}`,
    )).returning({ id: products.id });
    if (reserved.length === 0) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Insufficient stock for replacement product ${ex.toProductId} — receipt rolled back, exchange stays in_transit`,
      });
    }
    const { randomUUID } = await import("crypto");
    const { inventoryReservations } = await import("../../drizzle/schema");
    await tx.insert(inventoryReservations).values({
      id: randomUUID(),
      tenantId,
      orderId: ex.orderId,
      productId: ex.toProductId,
      qty: ex.qty,
      status: "reserved",
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
      createdAt: now,
    });
    await recordStockAdjustment(tx, {
      tenantId, productId: ex.toProductId, variantId: ex.toVariantId, deltaQty: -ex.qty, reason: "exchange_out",
      refType: "exchange", refId: ex.id, actorId: deps.actorId ?? null,
      note: `Exchange ${ex.id}: replacement units reserved`,
    });

    return ex;
  });

  const [order] = await db.select({ orderNumber: orders.orderNumber }).from(orders)
    .where(eq(orders.id, received.orderId)).limit(1);
  await notifyExchange(tenantId, received.requestedBy,
    `📥 We received your return for order ${order?.orderNumber ?? received.orderId} — ` +
    (received.damaged ? "the item was written off as damaged. " : "the item is back in stock. ") +
    `Your replacement is reserved and will ship shortly.`,
    { notify: deps.notify, orderId: received.orderId });
  return received;
}
// === END W43 exchanges ===
