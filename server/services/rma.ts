/**
 * rma.ts — W41 (Coder C) returns/RMA lifecycle (ORD-6 ≡ UC-4).
 *
 * State machine (rma_requests, mig 0129):
 *   requested → approved | rejected          (merchant: admin router or WA cmd)
 *   approved  → received → restocked → refunded | closed
 *
 * REUSE, not reinvent:
 *   - restock leg: same tenant-predicated inventory_snapshots credit as
 *     orderCancel.cancelOrder + W38 releaseCommittedReservations (claim-first,
 *     idempotent — a double "received" can't double-restock).
 *   - refund leg: W38 refundEscrowAtomic (remaining-balance caps, guarded
 *     state transition) OR customer-wallet credit (SPEC_W41 Coder B seam —
 *     wallet credits count toward the cumulative refunded total via
 *     refundedCents, never exceeding the escrow remaining balance).
 *   - escrow interplay: settleEscrowAtomic refuses to release while an RMA
 *     is open (see routers/escrow.ts guard) — release is paused, not lost.
 *
 * Status notifications go out on BOTH channels (WhatsApp + Telegram,
 * best-effort, fail-open) on every transition.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  customers,
  escrowTransactions,
  orderItems,
  orders,
  rmaRequests,
  telegramIdentities,
  tenants,
  type RmaRequest,
} from "../../drizzle/schema";
import { releaseCommittedReservations } from "./inventory";
// === W43 exchanges (Coder B): stock-adjustment audit (return restock leg) ===
import { recordStockAdjustment } from "./stockAdjustments";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const RMA_OPEN_STATUSES = ["requested", "approved", "received"] as const;
export const RMA_TERMINAL_STATUSES = ["rejected", "restocked", "refunded", "closed"] as const;

export type RmaItem = { productId: string; quantity: number };

// ─── Notifications (both channels, best-effort) ──────────────────────────────

type SendText = (tenantId: string, to: string, body: string) => Promise<unknown>;

async function defaultWaSend(tenantId: string, to: string, body: string) {
  const { sendWhatsAppText } = await import("./waSender");
  return sendWhatsAppText(tenantId, to, body, { notifType: "rma_status" });
}
async function defaultTgSend(tenantId: string, chatId: string, body: string) {
  const { sendTelegramText } = await import("./telegramSender");
  return sendTelegramText(tenantId, chatId, body, { parseMode: "HTML", disablePreview: true });
}

async function notifyRmaStatus(
  db: Db,
  rma: Pick<RmaRequest, "tenantId" | "buyerRef" | "requestedVia" | "orderId">,
  body: string,
  deps: { waSend?: SendText; tgSend?: SendText; adminPhone?: string | null } = {},
): Promise<void> {
  const waSend = deps.waSend ?? defaultWaSend;
  const tgSend = deps.tgSend ?? defaultTgSend;
  const sends: Promise<unknown>[] = [];
  // Buyer: WhatsApp when the ref looks like a phone, Telegram when it looks
  // like a chat id; ALSO try the linked telegram identity for phone buyers
  // (both-channel parity).
  if (/^\d{7,15}$/.test(rma.buyerRef)) {
    sends.push(waSend(rma.tenantId, rma.buyerRef, body));
    const [tg] = await db
      .select({ chatId: telegramIdentities.chatId })
      .from(telegramIdentities)
      .where(and(eq(telegramIdentities.tenantId, rma.tenantId), eq(telegramIdentities.phoneE164, rma.buyerRef)))
      .limit(1)
      .catch(() => [] as any[]);
    if (tg?.chatId) sends.push(tgSend(rma.tenantId, tg.chatId, body));
  } else {
    sends.push(tgSend(rma.tenantId, rma.buyerRef, body));
  }
  // Merchant/admin heads-up on WA.
  let adminPhone = deps.adminPhone;
  if (adminPhone === undefined) {
    const [tenant] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, rma.tenantId))
      .limit(1)
      .catch(() => [] as any[]);
    const s = (tenant?.settings ?? null) as any;
    const cand = s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone;
    adminPhone = typeof cand === "string" && cand.trim() ? cand.trim() : null;
  }
  if (adminPhone) sends.push(waSend(rma.tenantId, adminPhone, body));
  const results = await Promise.allSettled(sends);
  for (const r of results) {
    if (r.status === "rejected") console.warn("[rma] notify failed:", (r.reason as Error)?.message);
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export interface RequestReturnDeps {
  tenantId: string;
  buyerRef: string;
  orderId?: string | null;
  reason: string;
  evidenceMediaId?: string | null;
  requestedVia?: "whatsapp" | "telegram" | "admin";
  items?: RmaItem[];
  waSend?: SendText;
  tgSend?: SendText;
}

/**
 * Buyer initiates a return ("return order X" on WA/TG). Resolves the order
 * (explicit id, else the buyer's most recent), refuses duplicates while an
 * RMA is already open, and notifies the merchant to approve/reject.
 */
export async function requestReturn(
  db: Db,
  deps: RequestReturnDeps,
): Promise<{ rma: RmaRequest; orderNumber: string }> {
  const { tenantId, buyerRef } = deps;
  // Resolve the order.
  let order: { id: string; orderNumber: string; status: string } | undefined;
  if (deps.orderId) {
    [order] = await db
      .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status })
      .from(orders)
      .where(and(eq(orders.id, deps.orderId), eq(orders.tenantId, tenantId)))
      .limit(1);
  }
  if (!order) {
    // Resolve like chatDispute: customers row by WA phone, then match orders
    // by either the customer id or the raw phone.
    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, buyerRef)))
      .limit(1)
      .catch(() => [] as any[]);
    const candidates = customer ? [customer.id, buyerRef] : [buyerRef];
    [order] = await db
      .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), inArray(orders.customerId, candidates)))
      .orderBy(desc(orders.createdAt))
      .limit(1);
  }
  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No order found for this buyer" });
  }
  if (order.status === "cancelled" || order.status === "refunded") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Order is already ${order.status}` });
  }

  // One open RMA per order at a time.
  const [open] = await db
    .select({ id: rmaRequests.id, status: rmaRequests.status })
    .from(rmaRequests)
    .where(and(
      eq(rmaRequests.orderId, order.id),
      eq(rmaRequests.tenantId, tenantId),
      inArray(rmaRequests.status, [...RMA_OPEN_STATUSES]),
    ))
    .limit(1);
  if (open) {
    throw new TRPCError({ code: "CONFLICT", message: `A return request is already ${open.status} for this order` });
  }

  // Default to the full order contents when no item list is given.
  let items = deps.items ?? [];
  if (items.length === 0) {
    const rows = await db
      .select({ productId: orderItems.productId, quantity: orderItems.quantity })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));
    items = rows.map((r) => ({ productId: r.productId, quantity: r.quantity }));
  }

  const [rma] = await db.insert(rmaRequests).values({
    tenantId,
    orderId: order.id,
    buyerRef,
    items: items as unknown as any,
    reason: deps.reason.slice(0, 2000),
    evidenceMediaId: deps.evidenceMediaId ?? null,
    requestedVia: deps.requestedVia ?? "whatsapp",
  }).returning();

  await notifyRmaStatus(db, rma,
    `📦 Return requested for order ${order.orderNumber} (reason: ${deps.reason.slice(0, 200)}). ` +
    `The merchant will review it shortly.`,
  );
  return { rma, orderNumber: order.orderNumber };
}

/**
 * Merchant approve/reject (admin router or WA merchant command). Guarded
 * update from 'requested' only — a double decision is a CONFLICT, never a
 * flip-flop.
 */
export async function decideReturn(
  db: Db,
  opts: { rmaId: string; tenantId: string; approve: boolean; note?: string; waSend?: SendText; tgSend?: SendText },
): Promise<RmaRequest> {
  const now = new Date();
  const decided = await db.update(rmaRequests).set({
    status: opts.approve ? "approved" : "rejected",
    merchantNote: opts.note ?? null,
    decidedAt: now,
    updatedAt: now,
  }).where(and(
    eq(rmaRequests.id, opts.rmaId),
    eq(rmaRequests.tenantId, opts.tenantId),
    eq(rmaRequests.status, "requested"),
  )).returning();
  if (decided.length !== 1) {
    throw new TRPCError({ code: "CONFLICT", message: "RMA already decided or not found" });
  }
  const rma = decided[0];
  const [order] = await db.select({ orderNumber: orders.orderNumber }).from(orders)
    .where(eq(orders.id, rma.orderId)).limit(1);
  const body = opts.approve
    ? `✅ Your return for order ${order?.orderNumber ?? rma.orderId} was approved. ` +
      `Please drop off or ship the item(s) back to the store and keep your receipt — ` +
      `we'll confirm once received and process your refund.`
    : `❌ Your return request for order ${order?.orderNumber ?? rma.orderId} was rejected` +
      `${opts.note ? `: ${opts.note}` : "."} Reply here if you need help.`;
  await notifyRmaStatus(db, rma, body, { waSend: opts.waSend, tgSend: opts.tgSend });
  return rma;
}

/**
 * Merchant marks the returned goods received → restock leg.
 * Reuses the W38 primitives: tenant-predicated inventory_snapshots credit
 * (same shape as orderCancel's stock leg) + claim-first committed-reservation
 * release. Guarded approved→received→restocked in one transaction.
 */
export async function receiveAndRestock(
  db: Db,
  opts: { rmaId: string; tenantId: string; waSend?: SendText; tgSend?: SendText },
): Promise<RmaRequest> {
  const now = new Date();
  const rma = await db.transaction(async (tx) => {
    const received = await tx.update(rmaRequests).set({
      status: "received", receivedAt: now, updatedAt: now,
    }).where(and(
      eq(rmaRequests.id, opts.rmaId),
      eq(rmaRequests.tenantId, opts.tenantId),
      eq(rmaRequests.status, "approved"),
    )).returning();
    if (received.length !== 1) {
      throw new TRPCError({ code: "CONFLICT", message: "RMA is not awaiting receipt (or not found)" });
    }
    const row = received[0];
    const items = (Array.isArray(row.items) ? row.items : []) as RmaItem[];
    // Stock leg — identical to orderCancel.cancelOrder's snapshot credit:
    // tenant-predicated, reservedQty↓ / availableQty↑ per returned item.
    for (const item of items) {
      if (!item?.productId || !(item.quantity > 0)) continue;
      await tx.execute(sql`
        UPDATE inventory_snapshots
        SET "reservedQty" = GREATEST(0, CAST("reservedQty" AS NUMERIC) - ${item.quantity}),
            "availableQty" = CAST("availableQty" AS NUMERIC) + ${item.quantity}
        WHERE "productId" = ${item.productId} AND "tenantId" = ${row.tenantId}
      `);
      // === W43 exchanges (Coder B): audit the return restock in the SAME
      // txn as the snapshot credit. ===
      await recordStockAdjustment(tx, {
        tenantId: row.tenantId,
        productId: item.productId,
        deltaQty: item.quantity,
        reason: "restock",
        refType: "rma",
        refId: row.id,
        note: `RMA ${row.id}: returned units restocked`,
      });
      // === END W43 exchanges ===
    }
    const restocked = await tx.update(rmaRequests).set({
      status: "restocked", restockedAt: now, updatedAt: now,
    }).where(and(eq(rmaRequests.id, row.id), eq(rmaRequests.status, "received")))
      .returning();
    return restocked[0] ?? row;
  });

  // Committed-reservation release is claim-first and idempotent (W38) — safe
  // outside the tx and safe to replay.
  await releaseCommittedReservations(db, rma.orderId, now)
    .catch((e: unknown) => console.error("[rma] committed-reservation release error:", (e as Error)?.message));

  const [order] = await db.select({ orderNumber: orders.orderNumber }).from(orders)
    .where(eq(orders.id, rma.orderId)).limit(1);
  await notifyRmaStatus(db, rma,
    `📥 We received your return for order ${order?.orderNumber ?? rma.orderId} and restocked the item(s). ` +
    `Your refund is next — we'll message you once it's processed.`,
    { waSend: opts.waSend, tgSend: opts.tgSend });
  return rma;
}

/**
 * Refund leg. method "psp" → W38 refundEscrowAtomic (caps + idempotency);
 * method "wallet" → customer-wallet credit via the Coder B seam. Both count
 * toward the cumulative refunded total: refundEscrowAtomic caps against the
 * escrow remaining balance, and wallet credits are refused when the escrow
 * can no longer cover them (checked under the same refundedAmount metadata).
 */
export async function refundReturn(
  db: Db,
  opts: {
    rmaId: string;
    tenantId: string;
    method: "psp" | "wallet";
    amountCents?: number;
    waSend?: SendText;
    tgSend?: SendText;
    /** Injectable for tests; defaults to the (stubbed/real) wallet seam. */
    creditWalletImpl?: (tenant: string, customerRef: string, amountCents: number, reason: string, refId: string) => Promise<{ credited: boolean; reason?: string }>;
  },
): Promise<{ rma: RmaRequest; refundedCents: number; method: "psp" | "wallet" }> {
  const [rma] = await db.select().from(rmaRequests)
    .where(and(eq(rmaRequests.id, opts.rmaId), eq(rmaRequests.tenantId, opts.tenantId)))
    .limit(1);
  if (!rma) throw new TRPCError({ code: "NOT_FOUND", message: "RMA not found" });
  if (rma.status === "refunded") throw new TRPCError({ code: "CONFLICT", message: "RMA already refunded" });
  if (rma.status !== "restocked" && rma.status !== "received") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Cannot refund from status ${rma.status}` });
  }

  const [order] = await db.select().from(orders).where(eq(orders.id, rma.orderId)).limit(1);
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
  const amountCents = opts.amountCents ?? Math.round(parseFloat(String(order.totalAmount)) * 100);
  if (!(amountCents > 0)) throw new TRPCError({ code: "BAD_REQUEST", message: "Refund amount must be positive" });

  if (opts.method === "psp") {
    const [escrow] = await db.select().from(escrowTransactions)
      .where(and(eq(escrowTransactions.orderId, rma.orderId), eq(escrowTransactions.tenantId, opts.tenantId)))
      .orderBy(desc(escrowTransactions.createdAt))
      .limit(1);
    if (!escrow) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No escrow for this order — refund manually" });
    const { refundEscrowAtomic } = await import("../routers/escrow");
    const result = await refundEscrowAtomic(db, escrow.id, {
      reason: `RMA ${rma.id}: ${rma.reason.slice(0, 200)}`,
      // refundEscrowAtomic works in major units; caps at remaining balance.
      refundAmount: amountCents / 100,
    });
    if (!result.success) {
      throw new TRPCError({ code: "CONFLICT", message: `Refund refused: ${result.error}` });
    }
  } else {
    // Wallet credit — must not exceed what the escrow could still refund
    // (cumulative cap parity with the PSP path).
    const [escrow] = await db.select().from(escrowTransactions)
      .where(and(eq(escrowTransactions.orderId, rma.orderId), eq(escrowTransactions.tenantId, opts.tenantId)))
      .orderBy(desc(escrowTransactions.createdAt))
      .limit(1);
    if (escrow) {
      const total = parseFloat(String(escrow.amount));
      const already = parseFloat(String((escrow.metadata as any)?.refundedAmount ?? "0")) || 0;
      const remainingCents = Math.round((total - already) * 100);
      if (amountCents > remainingCents) {
        throw new TRPCError({ code: "CONFLICT", message: `Wallet credit exceeds refundable balance (${remainingCents} kobo left)` });
      }
    }
    // === W41 merger === Coder B's REAL customerWallet.creditWallet is wired
    // here (branch stub removed); the contract shape { credited, reason } is
    // adapted here so the rest of this flow is unchanged. Idempotency ref is
    // namespaced per RMA; the ledger reason is the shared refund_to_wallet
    // vocabulary (counts toward W38 cumulative caps in B's ledger too).
    const credit = opts.creditWalletImpl ?? (async (tenant: string, customerRef: string, cents: number, _reason: string, refId: string) => {
      const r = await (await import("./customerWallet")).creditWallet(
        tenant, customerRef, cents, "refund_to_wallet", refId, undefined, { rmaId: rma.id },
      );
      return { credited: r.ok, reason: r.error, balanceCentsAfter: r.balanceCents };
    });
    const result = await credit(opts.tenantId, rma.buyerRef, amountCents, "refund_to_wallet", `rma_refund:${rma.id}`);
    if (!result.credited) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Wallet credit failed: ${result.reason ?? "unknown"}` });
    }
    // Wallet credit counts toward the cumulative refunded total on the escrow.
    if (escrow) {
      const already = parseFloat(String((escrow.metadata as any)?.refundedAmount ?? "0")) || 0;
      await db.update(escrowTransactions).set({
        metadata: sql`COALESCE(${escrowTransactions.metadata}, '{}'::jsonb) || ${JSON.stringify({ refundedAmount: (already + amountCents / 100).toFixed(2) })}::jsonb`,
        updatedAt: new Date(),
      }).where(eq(escrowTransactions.id, escrow.id));
    }
  }

  const [updated] = await db.update(rmaRequests).set({
    status: "refunded",
    refundMethod: opts.method,
    refundedCents: amountCents,
    refundedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(rmaRequests.id, rma.id), eq(rmaRequests.status, rma.status as any)))
    .returning();

  await notifyRmaStatus(db, rma,
    `💸 Your refund for order ${order.orderNumber} was processed ` +
    `(${opts.method === "wallet" ? "store credit to your wallet" : "back to your payment method"}). ` +
    `Amount: ₦${(amountCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}. Thanks for your patience.`,
    { waSend: opts.waSend, tgSend: opts.tgSend });
  return { rma: updated ?? { ...rma, status: "refunded" }, refundedCents: amountCents, method: opts.method };
}

/** True while any non-terminal RMA exists for the order (escrow pause). */
export async function hasOpenRma(
  db: Pick<Db, "select">,
  tenantId: string,
  orderId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: rmaRequests.id })
    .from(rmaRequests)
    .where(and(
      eq(rmaRequests.tenantId, tenantId),
      eq(rmaRequests.orderId, orderId),
      inArray(rmaRequests.status, [...RMA_OPEN_STATUSES]),
    ))
    .limit(1)
    .catch(() => [] as any[]);
  return rows.length > 0;
}
