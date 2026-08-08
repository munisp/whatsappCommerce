/**
 * chatDispute.ts — WhatsApp chat dispute self-service.
 *
 * Triggered by a "dispute"/"complaint" intent (or support escalation). The
 * buyer's most recent order is resolved from chat context (raw phone or
 * customers.id in orders.customerId, like logistics.resolveBuyerPhone). When
 * that order has an escrow transaction, the dispute goes through the SHARED
 * raiseEscrowDispute service (single source of validation — the same path the
 * escrow router uses). Orders without escrow get a merchant notification
 * (type "dispute_opened", orderId + reason) so the complaint is still tracked
 * on an existing table. Either way the tenant admin phone is notified via
 * WhatsApp and the buyer gets a confirmation.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { customers, escrowTransactions, orders, tenants } from "../../drizzle/schema";
import { raiseEscrowDispute, DISPUTABLE_ESCROW_STATES, type DisputeReason } from "./disputes";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface ChatDisputeResult {
  status: "created" | "notification_only" | "no_order" | "not_disputable";
  orderId?: string;
  orderNumber?: string;
  disputeId?: string;
  escrowTxId?: string;
  escrowState?: string;
  reason: DisputeReason;
}

const REASON_KEYWORDS: Array<[RegExp, DisputeReason]> = [
  [/not received|never arrived|didn'?t (get|receive)|no delivery|haven'?t received/i, "not_received"],
  [/wrong item|wrong order|not what i ordered|different item/i, "wrong_item"],
  [/damaged|broken|spoilt|bad condition|expired/i, "damaged"],
  [/partial|incomplete|missing item|some items/i, "partial_delivery"],
];

/** Map free-text complaint to the dispute reason enum (default "other"). */
export function classifyDisputeReason(text: string): DisputeReason {
  for (const [re, reason] of REASON_KEYWORDS) {
    if (re.test(text)) return reason;
  }
  return "other";
}

/** The buyer's most recent order for this tenant (any status). */
async function findLatestOrder(
  db: Db,
  tenantId: string,
  phone: string,
): Promise<{ id: string; orderNumber: string } | null> {
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, phone)))
    .limit(1)
    .catch(() => [] as any[]);
  const candidates = customer ? [customer.id, phone] : [phone];
  const [order] = await db
    .select({ id: orders.id, orderNumber: orders.orderNumber })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), inArray(orders.customerId, candidates)))
    .orderBy(desc(orders.createdAt))
    .limit(1)
    .catch(() => [] as any[]);
  return order ?? null;
}

export interface RaiseChatDisputeDeps {
  db: Db;
  tenantId: string;
  phone: string;
  /** Free-text complaint from the buyer. */
  complaintText: string;
  /** Explicit order id from conversation context, when known. */
  orderId?: string | null;
  customerName?: string;
  /** Injectable for tests; defaults to waSender.sendWhatsAppText. */
  notifyAdminImpl?: (tenantId: string, adminPhone: string, body: string) => Promise<unknown>;
  /** Injectable for tests; defaults to a tenant settings lookup. */
  adminPhone?: string | null;
}

/**
 * Raise (or log) a dispute from a chat message and notify the tenant admin.
 * Never throws for business-flow reasons — returns a status instead.
 */
export async function raiseChatDispute(deps: RaiseChatDisputeDeps): Promise<ChatDisputeResult> {
  const { db, tenantId, phone } = deps;
  const reason = classifyDisputeReason(deps.complaintText);

  // Resolve the order: explicit context id wins, else most recent.
  let order: { id: string; orderNumber: string } | null = null;
  if (deps.orderId) {
    const [row] = await db
      .select({ id: orders.id, orderNumber: orders.orderNumber })
      .from(orders)
      .where(and(eq(orders.id, deps.orderId), eq(orders.tenantId, tenantId)))
      .limit(1)
      .catch(() => [] as any[]);
    order = row ?? null;
  }
  if (!order) order = await findLatestOrder(db, tenantId, phone);

  const notifyAdmin = async (body: string) => {
    let adminPhone = deps.adminPhone;
    if (adminPhone === undefined) {
      const [tenant] = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1)
        .catch(() => [] as any[]);
      const s = (tenant?.settings ?? null) as any;
      const cand = s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone;
      adminPhone = typeof cand === "string" && cand.trim() ? cand.trim() : null;
    }
    if (!adminPhone) return;
    const send = deps.notifyAdminImpl ?? (async (t: string, p: string, b: string) => {
      const { sendWhatsAppText } = await import("./waSender");
      return sendWhatsAppText(t, p, b, { notifType: "admin_alert" });
    });
    await send(tenantId, adminPhone, body).catch((e: any) =>
      console.warn("[chatDispute] admin notify failed:", e?.message));
  };

  if (!order) {
    await notifyAdmin(
      `⚠️ Complaint from ${phone}${deps.customerName ? ` (${deps.customerName})` : ""} (no order found):\n${deps.complaintText}`,
    );
    return { status: "no_order", reason };
  }

  // Escrow-backed order → shared dispute path (validation is NOT duplicated).
  const [escrow] = await db
    .select({ id: escrowTransactions.id, state: escrowTransactions.state })
    .from(escrowTransactions)
    .where(and(eq(escrowTransactions.orderId, order.id), eq(escrowTransactions.tenantId, tenantId)))
    .orderBy(desc(escrowTransactions.createdAt))
    .limit(1)
    .catch(() => [] as any[]);

  let disputeId: string | undefined;
  let status: ChatDisputeResult["status"] = "notification_only";

  if (escrow && (DISPUTABLE_ESCROW_STATES as readonly string[]).includes(escrow.state)) {
    const dispute = await raiseEscrowDispute(db, {
      escrowTxId: escrow.id,
      orderId: order.id,
      tenantId,
      raisedBy: "buyer",
      reason,
      description: deps.complaintText.slice(0, 2000),
    });
    disputeId = dispute.id;
    status = "created";
  } else if (escrow) {
    // Escrow exists but is in a terminal state — still notify, don't freeze.
    status = "not_disputable";
  }

  if (status !== "created") {
    // No escrow (or terminal escrow): log the complaint as a merchant
    // notification on the existing merchant_notifications table.
    const { emitNotification } = await import("../routers/notifications");
    await emitNotification({
      id: crypto.randomUUID(),
      tenantId,
      type: "dispute_opened",
      title: "Customer Complaint via WhatsApp",
      body: `Complaint from ${phone} on order ${order.orderNumber} (${reason.replace(/_/g, " ")}): ${deps.complaintText.slice(0, 500)}`,
      metadata: { orderId: order.id, source: "whatsapp_chat", reason },
      read: false,
      readAt: null,
      createdAt: new Date(),
    }).catch(() => {});
  }

  await notifyAdmin(
    `⚠️ New dispute/complaint from ${phone}${deps.customerName ? ` (${deps.customerName})` : ""} ` +
    `on order ${order.orderNumber} (${reason.replace(/_/g, " ")}):\n${deps.complaintText.slice(0, 500)}`,
  );

  return {
    status,
    orderId: order.id,
    orderNumber: order.orderNumber,
    disputeId,
    escrowTxId: escrow?.id,
    escrowState: escrow?.state,
    reason,
  };
}

/** Buyer-facing confirmation after a chat dispute is logged. */
export function buildDisputeReply(result: ChatDisputeResult): string {
  if (result.status === "no_order") {
    return "We've logged your complaint and notified our team — we couldn't find a recent order on this number, so please share your order number if you have it. 🙏";
  }
  const ref = result.orderNumber ? ` (order ${result.orderNumber})` : "";
  return `Your complaint${ref} has been logged as a dispute and our team has been notified. We'll get back to you shortly. 🙏`;
}
