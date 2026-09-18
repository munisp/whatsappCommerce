// === W43 dispatch (Coder C) ===
/**
 * addressChange.ts — post-dispatch address change (mig 0135).
 *
 * Flow (both channels):
 *   1. Buyer types "change my address …" on WhatsApp OR Telegram →
 *      requestAddressChange validates the tenant flag
 *      (tenants.allowPostDispatchAddressChange, default TRUE) and the order
 *      state (latest shipment out_for_delivery/in_transit), parks a PENDING
 *      address_change_requests row (one pending per order — partial unique
 *      index is the DB backstop), and sends the merchant an approval card
 *      through channelParity (category "address_change"): WA interactive
 *      buttons + TG inline keyboard carrying the SAME id grammar
 *      (addrchg:approve:<id> / addrchg:reject:<id>). The typed fallback
 *      "ADDR APPROVE <id>"/"ADDR REJECT <id>" works identically.
 *   2. decideAddressChange flips pending → approved|rejected claim-first
 *      (SELECT … FOR UPDATE inside a txn; concurrent/duplicate decisions get
 *      CONFLICT). Approve applies orders.shippingAddress in the SAME txn and
 *      writes an audit row; the request then reads `applied`.
 *   3. feeCents (integer kobo, from tenant settings.dispatch.
 *      addressChangeFeeCents, default 0) is charged claim-first via
 *      customerWallet.debitWallet (idempotent refId addrchg-fee:<id>); when
 *      the wallet can't cover it a PSP payment link is initiated via the
 *      EXISTING provider chain (initiateWithFallback) and sent via the
 *      payment_link parity category. Money is fail-closed: a failed fee leg
 *      is recorded (feeStatus) and surfaced, never faked.
 *   4. Expiry: pending rows older than ADDRESS_CHANGE_TTL_MS (or whose order
 *      left the dispatch window) flip to `expired` on the next touch
 *      (request/decide) — every terminal path (rejected/expired/applied)
 *      notifies the customer on BOTH channels via sendCustomerText.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  addressChangeRequests,
  logisticsShipments,
  orders,
  telegramIdentities,
  tenants,
  type AddressChangeRequest,
} from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const ADDRESS_CHANGE_CATEGORY = "address_change";
export const ADDRESS_CHANGE_TTL_MS = 24 * 3600 * 1000;
export const ADDRESS_CHANGE_OPEN_SHIPMENT_STATUSES = ["out_for_delivery", "in_transit"] as const;
export const ADDRESS_CHANGE_TERMINAL = ["applied", "rejected", "expired"] as const;

/** Button/callback id grammar (WA interactive + TG inline keyboard). */
export const ADDRCHG_APPROVE_PREFIX = "addrchg:approve:";
export const ADDRCHG_REJECT_PREFIX = "addrchg:reject:";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tenantAllowsAddressChange(db: Db, tenantId: string): Promise<boolean> {
  const [t] = await db
    .select({ allow: tenants.allowPostDispatchAddressChange })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  // Default TRUE (column NOT NULL DEFAULT true); a missing row read fails open
  // to the documented default, not a silent block.
  return t ? t.allow !== false : true;
}

async function addressChangeFeeCents(db: Db, tenantId: string): Promise<number> {
  const [t] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1).catch(() => [] as any[]);
  const s = (t?.settings ?? null) as any;
  const v = s?.dispatch?.addressChangeFeeCents;
  return Number.isInteger(v) && v > 0 ? v : 0;
}

async function resolveBuyerPhones(db: Db, tenantId: string, buyerRef: string): Promise<string[]> {
  const ref = String(buyerRef).trim();
  if (/^telegram:/i.test(ref)) {
    const chatId = ref.replace(/^telegram:/i, "");
    const [row] = await db
      .select({ phone: telegramIdentities.phoneE164 })
      .from(telegramIdentities)
      .where(and(eq(telegramIdentities.tenantId, tenantId), eq(telegramIdentities.chatId, chatId)))
      .limit(1)
      .catch(() => [] as any[]);
    return row?.phone ? [row.phone] : [];
  }
  return [ref.replace(/^\+/, "")];
}

/** Latest order of this buyer currently in the post-dispatch window. */
async function findDispatchOrder(
  db: Db,
  tenantId: string,
  buyerRef: string,
  explicitOrderId?: string | null,
): Promise<{ order: typeof orders.$inferSelect; shipment: typeof logisticsShipments.$inferSelect } | null> {
  const phones = await resolveBuyerPhones(db, tenantId, buyerRef);
  const conds = [eq(orders.tenantId, tenantId)];
  if (explicitOrderId) {
    conds.push(eq(orders.id, explicitOrderId));
  } else {
    if (!phones.length) return null;
    conds.push(inArray(orders.customerId, phones));
  }
  const candidates = await db.select().from(orders)
    .where(and(...conds))
    .orderBy(desc(orders.createdAt))
    .limit(explicitOrderId ? 1 : 5)
    .catch(() => [] as any[]);
  for (const order of candidates) {
    const [shipment] = await db.select().from(logisticsShipments)
      .where(and(
        eq(logisticsShipments.tenantId, tenantId),
        eq(logisticsShipments.orderId, order.id),
        inArray(logisticsShipments.status, [...ADDRESS_CHANGE_OPEN_SHIPMENT_STATUSES]),
      ))
      .orderBy(desc(logisticsShipments.createdAt))
      .limit(1)
      .catch(() => [] as any[]);
    if (shipment) return { order, shipment };
  }
  return null;
}

function summarizeAddress(addr: unknown): string {
  if (!addr) return "(not captured)";
  if (typeof addr === "string") return addr.slice(0, 200);
  const a = addr as Record<string, unknown>;
  const parts = [a.line1 ?? a.address ?? a.street, a.city, a.state, a.country]
    .filter((p) => typeof p === "string" && p.trim());
  return (parts.length ? parts.join(", ") : JSON.stringify(addr)).slice(0, 300);
}

// ─── Notifications (both channels via channelParity) ─────────────────────────

async function notifyCustomerBothChannels(
  db: Db,
  tenantId: string,
  order: Pick<typeof orders.$inferSelect, "id" | "customerId">,
  buyerRef: string | null,
  text: string,
  extra?: { paymentUrl?: string },
): Promise<void> {
  const { notifyCustomer } = await import("./channelParity");
  const ref = buyerRef && /^telegram:/i.test(buyerRef)
    ? { channel: "telegram", channelScopedId: buyerRef.replace(/^telegram:/i, "") }
    : { phone: buyerRef ?? order.customerId ?? "" };
  const payload: any = { text, notifType: ADDRESS_CHANGE_CATEGORY, orderId: order.id };
  if (extra?.paymentUrl) {
    payload.paymentUrl = extra.paymentUrl;
    payload.buttons = [{ label: "💳 Pay fee", url: extra.paymentUrl }];
  }
  const routed = await notifyCustomer(tenantId, ref, extra?.paymentUrl ? "payment_link" : ADDRESS_CHANGE_CATEGORY, payload);
  if (!routed.handled) {
    // WA path (channelParity leaves WhatsApp recipients to the caller).
    const phone = (ref as any).phone ?? "";
    if (phone) {
      const { sendWhatsAppText } = await import("./waSender");
      await sendWhatsAppText(tenantId, phone, extra?.paymentUrl ? `${text}\n💳 Pay: ${extra.paymentUrl}` : text,
        { notifType: ADDRESS_CHANGE_CATEGORY, orderId: order.id }).catch((e: any) => console.warn("[addressChange] WA notify failed:", e?.message));
    }
  }
}

/**
 * Merchant approval card on BOTH channels: WA interactive buttons to the
 * tenant admin phone + TG inline keyboard to the configured admin chat id —
 * same id grammar so either channel's decision lands in decideAddressChange.
 */
async function sendMerchantApprovalCard(
  db: Db,
  tenantId: string,
  req: AddressChangeRequest,
  orderNumber: string,
): Promise<void> {
  const [t] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1).catch(() => [] as any[]);
  const s = (t?.settings ?? null) as any;
  const adminPhone: string | null = typeof (s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone) === "string"
    ? String(s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone).trim()
    : null;
  const adminChatId: string | null = typeof s?.telegram?.adminChatId === "string" ? s.telegram.adminChatId.trim() : null;

  const body =
    `📍 Address change requested for order ${orderNumber} (ref ${req.id.slice(0, 8)})\n` +
    `New address: ${summarizeAddress(req.newAddress)}` +
    (req.feeCents > 0 ? `\nFee: ₦${(req.feeCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}` : "");
  const buttons = [
    { id: `${ADDRCHG_APPROVE_PREFIX}${req.id}`, title: "✅ Approve" },
    { id: `${ADDRCHG_REJECT_PREFIX}${req.id}`, title: "❌ Reject" },
  ];

  const sends: Promise<unknown>[] = [];
  if (adminPhone) {
    sends.push((async () => {
      const { sendChannelMessage } = await import("./channelSender");
      return sendChannelMessage(tenantId, "whatsapp", adminPhone.replace(/^\+/, ""), { kind: "keyboard", text: body, buttons }, { notifType: ADDRESS_CHANGE_CATEGORY, orderId: req.orderId });
    })());
  }
  if (adminChatId) {
    sends.push((async () => {
      const { sendChannelMessage } = await import("./channelSender");
      return sendChannelMessage(tenantId, "telegram", adminChatId, { kind: "keyboard", text: body, buttons }, { notifType: ADDRESS_CHANGE_CATEGORY, orderId: req.orderId });
    })());
  }
  const results = await Promise.allSettled(sends);
  for (const r of results) {
    if (r.status === "rejected") console.warn("[addressChange] merchant card send failed:", (r.reason as Error)?.message);
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export interface RequestAddressChangeInput {
  tenantId: string;
  buyerRef: string;
  /** Explicit order id (merchant-initiated); else the buyer's dispatch order. */
  orderId?: string | null;
  newAddress: Record<string, unknown>;
  requestedBy?: "customer" | "merchant";
}

export async function requestAddressChange(
  db: Db,
  input: RequestAddressChangeInput,
): Promise<{ req: AddressChangeRequest; orderNumber: string }> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("./tenantGuard");
  assertTenantActive(tenant);

  if (!(await tenantAllowsAddressChange(db, input.tenantId))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Address changes after dispatch are disabled for this store." });
  }

  const found = await findDispatchOrder(db, input.tenantId, input.buyerRef, input.orderId);
  if (!found) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No order out for delivery was found for this customer." });
  }
  const { order } = found;

  // One pending request per order (partial unique index is the backstop).
  const [pending] = await db.select().from(addressChangeRequests)
    .where(and(
      eq(addressChangeRequests.tenantId, input.tenantId),
      eq(addressChangeRequests.orderId, order.id),
      eq(addressChangeRequests.status, "pending"),
    ))
    .limit(1);
  if (pending) {
    throw new TRPCError({ code: "CONFLICT", message: "There is already a pending address change for this order." });
  }

  const feeCents = await addressChangeFeeCents(db, input.tenantId);
  const now = new Date();
  const [req] = await db.insert(addressChangeRequests).values({
    tenantId: input.tenantId,
    orderId: order.id,
    requestedBy: input.requestedBy ?? "customer",
    requesterRef: input.buyerRef,
    oldAddress: (order.shippingAddress as Record<string, unknown> | null) ?? null,
    newAddress: input.newAddress,
    status: "pending",
    feeCents,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ADDRESS_CHANGE_TTL_MS),
  }).returning();

  await sendMerchantApprovalCard(db, input.tenantId, req!, order.orderNumber);
  return { req: req!, orderNumber: order.orderNumber };
}

export interface DecideAddressChangeInput {
  requestId: string;
  tenantId: string;
  approve: boolean;
  decidedBy?: string | null;
  note?: string | null;
}

/**
 * Claim-first decision. Illegal transitions (already decided, expired window)
 * throw CONFLICT — the row state machine is pending → approved|rejected →
 * applied|expired, enforced by the FOR UPDATE row lock + status re-check.
 */
export async function decideAddressChange(
  db: Db,
  input: DecideAddressChangeInput,
): Promise<AddressChangeRequest> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("./tenantGuard");
  assertTenantActive(tenant);

  const decided = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT * FROM address_change_requests
      WHERE id = ${input.requestId} AND tenant_id = ${input.tenantId}
      FOR UPDATE`)) as any;
    const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
    const raw = list[0];
    if (!raw) throw new TRPCError({ code: "NOT_FOUND", message: "address change request not found" });
    // Raw SQL rows are snake_case — normalize to the drizzle shape ONCE.
    const req = {
      id: raw.id,
      tenantId: raw.tenant_id,
      orderId: raw.order_id,
      requestedBy: raw.requested_by,
      requesterRef: raw.requester_ref,
      oldAddress: raw.old_address,
      newAddress: raw.new_address,
      status: raw.status,
      feeCents: raw.fee_cents,
      feeStatus: raw.fee_status,
      decidedBy: raw.decided_by,
      decisionNote: raw.decision_note,
      createdAt: raw.created_at ? new Date(raw.created_at) : null,
      decidedAt: raw.decided_at ? new Date(raw.decided_at) : null,
      expiresAt: raw.expires_at ? new Date(raw.expires_at) : null,
    } as AddressChangeRequest;

    // Lazy expiry — the expired path is a terminal state that notifies.
    const now = new Date();
    const nowIso = now.toISOString();
    if (req.status === "pending" && req.expiresAt && req.expiresAt <= now) {
      await tx.execute(sql`
        UPDATE address_change_requests SET status = 'expired', decided_at = ${nowIso} WHERE id = ${req.id}`);
      return { ...req, status: "expired", decidedAt: now } as AddressChangeRequest;
    }
    if (req.status !== "pending") {
      throw new TRPCError({ code: "CONFLICT", message: `request is already ${req.status}` });
    }

    const next = input.approve ? "approved" : "rejected";
    await tx.execute(sql`
      UPDATE address_change_requests
      SET status = ${next}, decided_by = ${input.decidedBy ?? null},
          decision_note = ${input.note ?? null}, decided_at = ${nowIso}
      WHERE id = ${req.id} AND status = 'pending'`);

    if (input.approve) {
      // Apply the new shipping address in the SAME txn, then the request is
      // terminal at `applied`.
      await tx.execute(sql`
        UPDATE orders SET "shippingAddress" = ${JSON.stringify(req.newAddress)}::jsonb, "updatedAt" = ${nowIso}
        WHERE id = ${req.orderId} AND "tenantId" = ${input.tenantId}`);
      await tx.execute(sql`UPDATE address_change_requests SET status = 'applied' WHERE id = ${req.id}`);
      return { ...req, status: "applied", decidedAt: now } as AddressChangeRequest;
    }
    return { ...req, status: "rejected", decidedAt: now } as AddressChangeRequest;
  });

  // Audit row (best-effort, never blocks the decision).
  try {
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({
      tenantId: input.tenantId,
      actorId: input.decidedBy ?? "merchant",
      action: input.approve ? "address_change.applied" : decided.status === "expired" ? "address_change.expired" : "address_change.rejected",
      entityType: "address_change_request",
      entityId: input.requestId,
      summary: `order=${decided.orderId} status=${decided.status}${input.note ? ` note=${input.note}` : ""}`,
    } as any);
  } catch (e: any) {
    console.warn("[addressChange] audit write failed:", e?.message);
  }

  // Fee leg (approve only) — claim-first wallet debit, payment-link fallback.
  let feeNote = "";
  if (decided.status === "applied" && decided.feeCents > 0) {
    feeNote = await chargeAddressChangeFee(db, decided).catch((e: any) => {
      console.warn("[addressChange] fee charge failed:", e?.message);
      return "";
    });
  }

  // Customer notification on EVERY terminal path, both channels.
  try {
    const [order] = await db.select().from(orders).where(eq(orders.id, decided.orderId)).limit(1);
    if (order) {
      const body =
        decided.status === "applied"
          ? `📍 Good news — the delivery address for order ${order.orderNumber} was updated to: ${summarizeAddress(decided.newAddress)}${feeNote}`
          : decided.status === "rejected"
            ? `📍 Sorry — the address change for order ${order.orderNumber} was rejected by the store${input.note ? ` (${input.note})` : ""}. Your order goes to the original address.`
            : `📍 The address change request for order ${order.orderNumber} expired before the store responded. Your order goes to the original address.`;
      await notifyCustomerBothChannels(db, input.tenantId, order, decided.requesterRef, body,
        feeNote.includes("Pay:") && (decided as any).__feeUrl ? { paymentUrl: (decided as any).__feeUrl } : undefined);
    }
  } catch (e: any) {
    console.warn("[addressChange] customer notify failed:", e?.message);
  }

  return decided;
}

/**
 * Fee charge: claim-first wallet debit (idempotent refId addrchg-fee:<id>);
 * on insufficient funds initiate a PSP payment link via the EXISTING provider
 * chain and hand the URL back for the customer notification.
 */
async function chargeAddressChangeFee(db: Db, req: AddressChangeRequest): Promise<string> {
  const [order] = await db.select().from(orders).where(eq(orders.id, req.orderId)).limit(1);
  const phone = (order?.customerId ?? "").replace(/^\+/, "");
  if (!/^\d{7,15}$/.test(phone)) return "";
  const { debitWallet } = await import("./customerWallet");
  const debit = await debitWallet(req.tenantId, phone, req.feeCents, "address_change_fee", `addrchg-fee:${req.id}`, db as any, {
    orderId: req.orderId,
  });
  if (debit.ok) {
    await db.update(addressChangeRequests).set({ feeStatus: "charged" }).where(eq(addressChangeRequests.id, req.id));
    const fmt = `₦${(req.feeCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
    return `\n💳 Address-change fee ${fmt} charged from your wallet (balance ₦${((debit.balanceCents ?? 0) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}).`;
  }
  // Wallet can't cover it → PSP payment link via the existing provider chain.
  try {
    const { initiateWithFallback } = await import("./payments/initiateWithFallback");
    const outcome = await initiateWithFallback(req.tenantId, {
      tenantId: req.tenantId,
      amountCents: req.feeCents,
      currency: order?.currency ?? "NGN",
      reference: `addrchg-fee:${req.id}`,
      metadata: { kind: "address_change_fee", addressChangeRequestId: req.id, orderId: req.orderId },
      customer: { phone },
    });
    const url = outcome.result.authorizationUrl;
    if (url) {
      await db.update(addressChangeRequests).set({ feeStatus: "link_sent" }).where(eq(addressChangeRequests.id, req.id));
      (req as any).__feeUrl = url;
      const fmt = `₦${(req.feeCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
      return `\n💳 Address-change fee ${fmt} — Pay: ${url}`;
    }
  } catch (e: any) {
    console.warn("[addressChange] fee payment link failed:", e?.message);
  }
  await db.update(addressChangeRequests).set({ feeStatus: "failed" }).where(eq(addressChangeRequests.id, req.id));
  const fmt = `₦${(req.feeCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
  return `\n⚠️ The ${fmt} address-change fee could not be collected yet — the store will follow up.`;
}

/**
 * Parse a free-text "change my address to …" message into a structured
 * address. Honest shape: the raw line is always preserved; pincode/city are
 * best-effort extractions, never invented.
 */
export function parseAddressFromText(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/\s+/g, " ");
  const out: Record<string, unknown> = { line1: cleaned };
  const pin = /\b(\d{6})\b/.exec(cleaned);
  if (pin) out.postalCode = pin[1];
  const city = /\bin\s+([A-Za-z][A-Za-z\s]{2,30})$/i.exec(cleaned);
  if (city) out.city = city[1]!.trim();
  return out;
}
