// === W46 uc-money ===
/**
 * orderAmendments.ts — UC-26: pre-confirmation order amendment (mig 0153).
 *
 * A buyer (or merchant on their behalf) amends an order BEFORE confirmation:
 * "CHANGE ORDER <orderRef> <product> x<qty>" in chat (BOTH channels), or the
 * ucMoney.amendOrder router procedure. amendOrder:
 *   1. Claims the order row FOR UPDATE; only pre-confirmation states are
 *      amendable (status pending/confirmed, never shipped/delivered/
 *      cancelled/completed) — post-confirmation changes go through the W43
 *      exchange/return machinery instead.
 *   2. Recomputes the total in INTEGER MINOR UNITS via shared/escrowAmounts
 *      (toMinorUnitsExact per line, summed) — never float math.
 *   3. Writes the new items + total and an append-only order_amendments row
 *      (prev/new/delta + items snapshot + actor) + writeAuditLog entry.
 *   4. Settles the delta honestly:
 *      - unpaid order: total just changes; the next payment link charges the
 *        new amount (status 'applied').
 *      - PAID order, delta > 0: a delta payment link is minted via the
 *        EXISTING paymentIntents + initiateWithFallback chain (idempotency
 *        key amend-delta:<amendmentId>) and sent on the buyer's channel
 *        (status 'delta_link_sent').
 *      - PAID order, delta < 0: a partial refund for |delta| via
 *        payments/refunds.executeProviderRefund (status 'refund_initiated'
 *        or 'refund_failed' — honest vocabulary, never faked).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "crypto";
import { getDb } from "../db";
import {
  orderAmendments,
  orderItems,
  orders,
  paymentIntents,
  products,
  tenants,
  type OrderAmendment,
} from "../../drizzle/schema";
import { toMinorUnitsExact, minorUnitsToString } from "../../shared/escrowAmounts";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const AMENDMENT_CATEGORY = "order_amendment";

/** Pre-confirmation states where amendment is allowed. */
export const AMENDABLE_STATUSES = ["pending", "confirmed"] as const;

export interface AmendLine {
  productId: string;
  qty: number;
}

export interface AmendOrderInput {
  tenantId: string;
  orderId: string;
  /** Replacement line set (full recompute, not a patch). */
  lines: AmendLine[];
  reason?: string | null;
  actorId?: string | null;
  /** WA phone or telegram:<chatId> of the buyer (for the delta link notice). */
  customerRef?: string | null;
}

async function assertActiveTenant(db: Db, tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("./tenantGuard");
  assertTenantActive(tenant);
  return tenant;
}

export async function amendOrder(
  db: Db,
  input: AmendOrderInput,
): Promise<{ amendment: OrderAmendment; deltaPaymentUrl: string | null; refundStatus: string | null }> {
  await assertActiveTenant(db, input.tenantId);
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Amendment needs at least one line." });
  }
  for (const l of input.lines) {
    if (!l.productId || !Number.isInteger(l.qty) || l.qty <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Each line needs a productId and a positive whole qty." });
    }
  }

  // Resolve replacement prices tenant-scoped BEFORE touching the order.
  // W46 merger fix (J401): `= ANY(${array})` binds a non-array on the
  // PGlite/postgres.js stack ("op ANY/ALL requires array") — use inArray.
  const productIds = Array.from(new Set(input.lines.map((l) => l.productId)));
  const prows = await db.select().from(products)
    .where(and(eq(products.tenantId, input.tenantId), inArray(products.id, productIds)));
  const priceById = new Map(prows.map((p) => [p.id, p] as const));
  for (const l of input.lines) {
    if (!priceById.has(l.productId)) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Product ${l.productId} is not in this store's catalog.` });
    }
  }
  const newLines = input.lines.map((l) => {
    const p = priceById.get(l.productId)!;
    const unitCents = toMinorUnitsExact(String(p.price));
    return { productId: p.id, productName: p.name, qty: l.qty, unitPriceCents: unitCents, lineCents: unitCents * l.qty, currency: p.currency ?? "NGN" };
  });
  // Integer minor-units recompute (shared/escrowAmounts helpers).
  const newTotalCents = newLines.reduce((s, l) => s + l.lineCents, 0);

  const { amendment, order } = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT * FROM orders WHERE id = ${input.orderId} AND "tenantId" = ${input.tenantId} FOR UPDATE
    `)) as any;
    const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
    const o = list[0];
    if (!o) throw new TRPCError({ code: "NOT_FOUND", message: "order not found" });
    if (!(AMENDABLE_STATUSES as readonly string[]).includes(o.status)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `Order ${o.orderNumber} is ${o.status} — amendments are only possible before confirmation/fulfilment. Use the exchange/return flow instead.`,
      });
    }
    const prevTotalCents = toMinorUnitsExact(String(o.totalAmount));
    const deltaCents = newTotalCents - prevTotalCents;
    const now = new Date();
    const amendmentId = randomUUID();

    await tx.update(orders).set({
      items: newLines.map((l) => ({ productId: l.productId, productName: l.productName, quantity: l.qty, unitPrice: l.unitPriceCents / 100 })),
      totalAmount: minorUnitsToString(newTotalCents),
      updatedAt: now,
    }).where(eq(orders.id, o.id));
    await tx.delete(orderItems).where(eq(orderItems.orderId, o.id));
    for (const l of newLines) {
      await tx.insert(orderItems).values({
        id: randomUUID(),
        orderId: o.id,
        productId: l.productId,
        productName: l.productName,
        quantity: l.qty,
        unitPrice: (l.unitPriceCents / 100).toFixed(2),
        currency: l.currency,
      });
    }
    const [row] = await tx.insert(orderAmendments).values({
      id: amendmentId,
      tenantId: input.tenantId,
      orderId: o.id,
      prevTotalCents,
      newTotalCents,
      deltaCents,
      items: newLines.map((l) => ({ productId: l.productId, qty: l.qty, unitPriceCents: l.unitPriceCents })),
      reason: input.reason ?? null,
      status: "applied",
      actor: input.actorId ?? null,
      createdAt: now,
    }).returning();
    return { amendment: row!, order: o as any };
  });

  // Audit trail (best-effort; the order_amendments row is the durable record).
  try {
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({
      tenantId: input.tenantId,
      actorId: input.actorId ?? "system",
      action: "order.amended",
      entityType: "order",
      entityId: input.orderId,
      summary: `amendment=${amendment.id} prev=${amendment.prevTotalCents} new=${amendment.newTotalCents} delta=${amendment.deltaCents} lines=${input.lines.length}`,
    } as any);
  } catch (e: any) {
    console.warn("[orderAmendments] audit write failed:", e?.message);
  }

  // Delta settlement for PAID orders.
  let deltaPaymentUrl: string | null = null;
  let refundStatus: string | null = null;
  const paid = order.paymentStatus === "completed" || order.paymentStatus === "paid";
  if (paid && amendment.deltaCents > 0) {
    deltaPaymentUrl = await mintDeltaLink(db, amendment, order, input.customerRef ?? order.customerId);
  } else if (paid && amendment.deltaCents < 0) {
    const { executeProviderRefund } = await import("./payments/refunds");
    const outcome = await executeProviderRefund(db, {
      tenantId: input.tenantId,
      orderId: order.id,
      amountCents: -amendment.deltaCents,
      currency: order.currency ?? "NGN",
      reason: `order amendment ${amendment.id}: ${input.reason ?? "pre-confirmation change"}`,
      refundId: `amend-refund:${amendment.id}`,
    });
    refundStatus = outcome.status;
    await db.update(orderAmendments).set({
      status: outcome.executed ? "refund_initiated" : "refund_failed",
    }).where(eq(orderAmendments.id, amendment.id));
    amendment.status = outcome.executed ? "refund_initiated" : "refund_failed";
  }
  return { amendment, deltaPaymentUrl, refundStatus };
}

/** Delta payment link for an upward amendment on a PAID order. */
async function mintDeltaLink(db: Db, amendment: OrderAmendment, order: any, customerRef: string): Promise<string | null> {
  const idemKey = `amend-delta:${amendment.id}`;
  const [existing] = await db.select().from(paymentIntents)
    .where(eq(paymentIntents.idempotencyKey, idemKey)).limit(1).catch(() => [] as any[]);
  if (existing) return (existing.metadata as any)?.paymentUrl ?? null;
  const now = new Date();
  const paymentIntentId = randomUUID();
  const reference = `AMD-${now.getTime()}-${paymentIntentId.slice(0, 8).toUpperCase()}`;
  await db.insert(paymentIntents).values({
    id: paymentIntentId,
    tenantId: amendment.tenantId,
    orderId: order.id,
    customerId: customerRef,
    amount: (amendment.deltaCents / 100).toFixed(2),
    currency: order.currency ?? "NGN",
    provider: "paystack",
    providerPaymentId: reference,
    idempotencyKey: idemKey,
    status: "pending",
    metadata: { kind: "order_amendment_delta", amendmentId: amendment.id, tenantId: amendment.tenantId },
    createdAt: now,
    updatedAt: now,
  });
  let paymentUrl: string | null = null;
  try {
    const { initiateWithFallback } = await import("./payments/initiateWithFallback");
    const { ENV } = await import("../_core/env");
    const fallback = await initiateWithFallback(amendment.tenantId, {
      tenantId: amendment.tenantId,
      amountCents: amendment.deltaCents,
      currency: order.currency ?? "NGN",
      reference,
      metadata: { payment_intent_id: paymentIntentId, tenant_id: amendment.tenantId, kind: "order_amendment_delta", amendmentId: amendment.id },
      customer: { phone: customerRef.replace(/^telegram:/i, "") },
      callbackUrl: `${ENV.appUrl}/orders`,
    });
    paymentUrl = fallback.result.authorizationUrl ?? null;
    await db.update(paymentIntents).set({
      status: "initiated",
      metadata: { kind: "order_amendment_delta", amendmentId: amendment.id, tenantId: amendment.tenantId, paymentUrl, servedProvider: fallback.providerId },
      updatedAt: new Date(),
    }).where(eq(paymentIntents.id, paymentIntentId));
  } catch (e: any) {
    await db.update(paymentIntents).set({
      status: "failed",
      failureReason: `provider_init: ${String(e?.message ?? e).slice(0, 300)}`,
      updatedAt: new Date(),
    }).where(eq(paymentIntents.id, paymentIntentId)).catch(() => {});
    console.warn("[orderAmendments] delta link failed:", e?.message);
  }
  await db.update(orderAmendments).set({ status: "delta_link_sent", paymentIntentId })
    .where(eq(orderAmendments.id, amendment.id));
  amendment.status = "delta_link_sent";

  // Notify the buyer on their channel (payment_link parity category).
  const { notifyCustomer } = await import("./channelParity");
  const ref = /^telegram:/i.test(customerRef)
    ? { channel: "telegram", channelScopedId: customerRef.replace(/^telegram:/i, "") }
    : { phone: customerRef };
  const text = `📝 Order ${order.orderNumber} was updated — there's an extra ` +
    `₦${(amendment.deltaCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} to pay.`;
  const routed = await notifyCustomer(amendment.tenantId, ref as any, "payment_link", {
    text, paymentUrl: paymentUrl ?? undefined,
    buttons: paymentUrl ? [{ label: "💳 Pay difference", url: paymentUrl }] : undefined,
    notifType: AMENDMENT_CATEGORY, orderId: order.id,
  } as any);
  if (!routed.handled && (ref as any).phone) {
    const { sendWhatsAppText } = await import("./waSender");
    await sendWhatsAppText(amendment.tenantId, (ref as any).phone,
      paymentUrl ? `${text}\n💳 Pay: ${paymentUrl}` : `${text} (link pending — the store will follow up)`,
      { notifType: AMENDMENT_CATEGORY, orderId: order.id })
      .catch((e: any) => console.warn("[orderAmendments] WA notify failed:", e?.message));
  }
  return paymentUrl;
}
// === END W46 uc-money (order amendments) ===
