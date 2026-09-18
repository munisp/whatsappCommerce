/**
 * === W46 orders-p2 (Coder G, ORD-22) ===
 * recalls.ts — product recall tool: targeted order-notification broadcast.
 *
 * Previously there was NO way to reach just the buyers of a recalled product
 * (residual-backlog ORD-22: "grep recall → ML metrics only"). This module:
 *
 *   1. createRecall — registers the recall (product + order date range +
 *      reason) under the merchant's tenant.
 *   2. dispatchRecall — resolves the affected buyers from order_items joined
 *      to orders (productId + optional created-at range, tenant-scoped,
 *      non-cancelled orders only), then sends each a plain-text recall
 *      notice via notifyCustomer (W37 channelParity category
 *      "recall_notice": WhatsApp + Telegram parity).
 *
 * OPT-OUT LOGGING (the hard requirement): every affected order gets a
 * durable recall_recipients row. Buyers with NO current granted consent (or
 * a withdrawn consent) are NEVER sent — their row is stamped
 * status='skipped_opt_out' with sentAt NULL, so the opt-out is provable
 * rather than silent. Sent/failed outcomes are stamped on the same row.
 *
 * Exactly-once: recall_recipients has UNIQUE(recall_id, order_id); the
 * recipient row is inserted claim-first inside the dispatch (ON CONFLICT DO
 * NOTHING via a guarded insert), so a repeated dispatch of the same recall
 * never re-sends a buyer. Sends are best-effort per recipient — one failure
 * never blocks the rest of the fan-out.
 */
import { and, desc, eq, gte, lte, ne, sql } from "drizzle-orm";
import {
  orderItems,
  orders,
  productRecalls,
  recallRecipients,
  type ProductRecall,
} from "../../drizzle/schema";
import { TRPCError } from "@trpc/server";

type Db = any;

export interface CreateRecallInput {
  tenantId: string;
  productId: string;
  reason: string;
  fromDate?: Date | null;
  toDate?: Date | null;
  createdBy?: string | null;
}

export async function createRecall(db: Db, input: CreateRecallInput): Promise<ProductRecall> {
  if (!input.reason?.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Recall reason is required" });
  }
  const [row] = await db.insert(productRecalls).values({
    tenantId: input.tenantId,
    productId: input.productId,
    reason: input.reason.trim(),
    fromDate: input.fromDate ?? null,
    toDate: input.toDate ?? null,
    createdBy: input.createdBy ?? null,
  }).returning();
  return row;
}

/** Phones (digits-only) with a CURRENT granted whatsapp/telegram consent. */
async function consentedRefs(db: Db, tenantId: string): Promise<Set<string>> {
  try {
    const res: any = await db.execute(
      sql`SELECT phone, channel FROM consents WHERE tenant_id = ${tenantId} AND granted = true AND withdrawn_at IS NULL`,
    );
    const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
    return new Set(rows.map((r) => String(r?.phone ?? "").replace(/^\+/, "")).filter(Boolean));
  } catch (e: any) {
    // Fail-closed: a consent lookup failure means NOBODY is consented.
    console.warn("[recalls] consent lookup failed (treating all as opted out):", e?.message);
    return new Set();
  }
}

export interface RecallDispatchResult {
  recallId: string;
  affectedOrders: number;
  sent: number;
  failed: number;
  /** Buyers not contacted because consent is absent/withdrawn — LOGGED. */
  skippedOptOut: number;
}

/**
 * Resolve affected orders + fan out the recall notice. Idempotent per
 * (recall, order) via the recall_recipients unique index.
 */
export async function dispatchRecall(db: Db, opts: { tenantId: string; recallId: string }): Promise<RecallDispatchResult> {
  const [recall] = await db.select().from(productRecalls)
    .where(and(eq(productRecalls.id, opts.recallId), eq(productRecalls.tenantId, opts.tenantId)))
    .limit(1);
  if (!recall) throw new TRPCError({ code: "NOT_FOUND", message: "Recall not found" });

  // Claim the campaign: draft|sending → sending. A completed campaign is
  // still dispatchable for retry (per-recipient rows make that exactly-once).
  await db.update(productRecalls).set({ status: "sending", updatedAt: new Date() })
    .where(and(eq(productRecalls.id, recall.id), ne(productRecalls.status, "completed")));

  const predicates = [
    eq(orderItems.productId, recall.productId),
    eq(orders.tenantId, recall.tenantId),
    ne(orders.status, "cancelled"),
  ];
  if (recall.fromDate) predicates.push(gte(orders.createdAt, recall.fromDate));
  if (recall.toDate) predicates.push(lte(orders.createdAt, recall.toDate));
  const affected = await db
    .selectDistinct({ orderId: orders.id, customerId: orders.customerId })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(...predicates));

  const consented = await consentedRefs(db, recall.tenantId);
  const { notifyCustomer } = await import("./channelParity");
  const result: RecallDispatchResult = {
    recallId: recall.id,
    affectedOrders: affected.length,
    sent: 0,
    failed: 0,
    skippedOptOut: 0,
  };

  for (const row of affected) {
    const phone = String(row.customerId ?? "").replace(/^\+/, "");
    // Claim-first recipient insert — exactly-once per (recall, order).
    const [recipient] = await db.insert(recallRecipients).values({
      recallId: recall.id,
      tenantId: recall.tenantId,
      orderId: row.orderId,
      phone: phone || "unknown",
      status: "pending",
    }).onConflictDoNothing().returning();
    if (!recipient) continue; // already dispatched by an earlier run

    if (!phone || !consented.has(phone)) {
      // OPT-OUT LOGGING: durable, queryable — never sent, never silent.
      await db.update(recallRecipients).set({ status: "skipped_opt_out" })
        .where(eq(recallRecipients.id, recipient.id));
      result.skippedOptOut += 1;
      continue;
    }
    const text =
      `⚠️ *Product recall notice*\n\n` +
      `A product you ordered (order ${row.orderId}) has been recalled by the merchant.\n\n` +
      `Reason: ${recall.reason}\n\n` +
      `Please stop using the item and reply here to arrange a return or refund.`;
    try {
      const routed = await notifyCustomer(recall.tenantId, phone, "recall_notice", { text, notifType: "recall" })
        .catch(() => ({ handled: false }) as any);
      if (!routed?.handled) {
        const { sendWhatsAppText } = await import("./waSender");
        await sendWhatsAppText(recall.tenantId, phone, text, { notifType: "recall" });
      }
      await db.update(recallRecipients).set({
        status: "sent",
        channel: (routed as any)?.channel ?? "whatsapp",
        sentAt: new Date(),
      }).where(eq(recallRecipients.id, recipient.id));
      result.sent += 1;
    } catch (e: any) {
      await db.update(recallRecipients).set({ status: "failed", error: e?.message ?? String(e) })
        .where(eq(recallRecipients.id, recipient.id));
      result.failed += 1;
    }
  }

  await db.update(productRecalls).set({ status: "completed", updatedAt: new Date() })
    .where(eq(productRecalls.id, recall.id));
  return result;
}

/** Recall detail + per-status recipient counts (merchant dashboard). */
export async function getRecallStats(db: Db, opts: { tenantId: string; recallId: string }) {
  const [recall] = await db.select().from(productRecalls)
    .where(and(eq(productRecalls.id, opts.recallId), eq(productRecalls.tenantId, opts.tenantId)))
    .limit(1);
  if (!recall) throw new TRPCError({ code: "NOT_FOUND", message: "Recall not found" });
  const rows = await db.select({ status: recallRecipients.status, n: sql<number>`count(*)::int` })
    .from(recallRecipients)
    .where(eq(recallRecipients.recallId, recall.id))
    .groupBy(recallRecipients.status);
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[String(r.status)] = Number(r.n);
  return { recall, recipients: byStatus };
}

export async function listRecalls(db: Db, tenantId: string, limit = 50) {
  return db.select().from(productRecalls)
    .where(eq(productRecalls.tenantId, tenantId))
    .orderBy(desc(productRecalls.createdAt))
    .limit(Math.min(200, Math.max(1, limit)));
}
// === END W46 orders-p2 ===
