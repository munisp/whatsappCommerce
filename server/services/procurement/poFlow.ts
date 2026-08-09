/**
 * procurement/poFlow.ts — Purchase-order lifecycle + WhatsApp buyer/supplier
 * flows.
 *
 * Lifecycle (status enum: draft|submitted|approved|rejected|fulfilled|invoiced|paid):
 *
 *   draft ──submit──▶ submitted ──approve──▶ invoiced (credit: drawOnCredit ok, due_date set)
 *                      │            └──────▶ approved (paynow: payment link sent)
 *                      ├─reject──▶ rejected        approved ──payment confirmed──▶ paid
 *                      └─cancel──▶ (draft row deleted; buyer only)
 *                     invoiced|paid ──delivered──▶ fulfilled
 *
 * Supplier approval arrives as a WhatsApp action card (Approve/Reject buttons,
 * reply ids `po_approve:<poId>` / `po_reject:<poId>`) sent to the supplier
 * tenant's admin phone. Auto-approve when subtotal <= the supplier profile's
 * auto_approve_below_cents (the credit draw guard still runs).
 */
import { and, desc, eq } from "drizzle-orm";
import {
  poItems,
  purchaseOrders,
  tenants,
  type PoItem,
  type PurchaseOrder,
} from "../../../drizzle/schema";
import { sendWhatsAppInteractive, sendWhatsAppText, type SendInteractiveInput } from "../waSender";
import { drawOnCredit, getCreditAccount, suggestLimit } from "../tradeCredit";
import { getActiveSupplierProfile, type DbHandle } from "./directory";

// ── Formatting helpers ───────────────────────────────────────────────────────

/** 123456 cents → "₦1,234.56". */
export function formatNaira(cents: number): string {
  return `₦${(cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const PO_STATUSES = ["draft", "submitted", "approved", "rejected", "fulfilled", "invoiced", "paid"] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

// ── PO numbers ───────────────────────────────────────────────────────────────

const PO_SUFFIX_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — human-readable

/**
 * PO number: `PO-YYYYMMDD-XXXX` — deterministic date prefix + random
 * human-safe suffix, collision-checked against existing rows (retried).
 */
export async function generatePoNumber(db: DbHandle, now: Date = new Date()): Promise<string> {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  for (let attempt = 0; attempt < 8; attempt++) {
    let suffix = "";
    for (let i = 0; i < 4; i++) {
      suffix += PO_SUFFIX_ALPHABET[Math.floor(Math.random() * PO_SUFFIX_ALPHABET.length)];
    }
    const candidate = `PO-${y}${m}${d}-${suffix}`;
    const existing = await db
      .select({ id: purchaseOrders.id })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.poNumber, candidate))
      .limit(1)
      .catch(() => [] as any[]);
    if (!existing || existing.length === 0) return candidate;
  }
  // Astronomically unlikely; fall back to a longer suffix still within varchar(32).
  const long = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `PO-${y}${m}${d}-${long}`;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getPoById(db: DbHandle, poId: string): Promise<PurchaseOrder | null> {
  const [po] = await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, poId))
    .limit(1)
    .catch(() => [] as PurchaseOrder[]);
  return po ?? null;
}

export async function getPoItems(db: DbHandle, poId: string): Promise<PoItem[]> {
  const rows = await db.select().from(poItems).where(eq(poItems.poId, poId)).catch(() => [] as PoItem[]);
  return rows ?? [];
}

export async function listPos(
  db: DbHandle,
  opts: { tenantId: string; role: "buyer" | "supplier"; status?: PoStatus; limit?: number },
): Promise<PurchaseOrder[]> {
  const col = opts.role === "buyer" ? purchaseOrders.buyerTenantId : purchaseOrders.supplierTenantId;
  const conds = [eq(col, opts.tenantId)];
  if (opts.status) conds.push(eq(purchaseOrders.status, opts.status));
  const rows = await db
    .select()
    .from(purchaseOrders)
    .where(and(...conds))
    .orderBy(desc(purchaseOrders.createdAt))
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200))
    .catch(() => [] as PurchaseOrder[]);
  return rows ?? [];
}

// ── Notification plumbing ────────────────────────────────────────────────────

function adminPhoneFromSettings(settings: unknown): string | null {
  const s = settings as any;
  const cand = s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone;
  return typeof cand === "string" && cand.trim() ? cand.trim() : null;
}

async function tenantNameOf(db: DbHandle, tenantId: string): Promise<string> {
  const [t] = await db
    .select({ name: tenants.name, settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  return t?.name ?? tenantId;
}

async function tenantAdminPhone(db: DbHandle, tenantId: string): Promise<string | null> {
  const [t] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  return adminPhoneFromSettings(t?.settings);
}

/** Best-effort WhatsApp text to a tenant's admin phone. Never throws. */
export async function notifyTenantAdminPhone(
  db: DbHandle,
  tenantId: string,
  message: string,
  interactive?: SendInteractiveInput,
): Promise<void> {
  const phone = await tenantAdminPhone(db, tenantId);
  if (!phone) {
    console.info(`[procurement] no admin phone for tenant ${tenantId} — notification skipped`);
    return;
  }
  const send = interactive ? sendWhatsAppInteractive : sendWhatsAppText;
  await (send as any)(tenantId, phone, interactive ?? message, { notifType: "admin_alert" })
    .catch((e: any) => console.warn("[procurement] admin notify failed:", e?.message));
}

/** Best-effort WhatsApp text to the buyer contact stored on the PO. Never throws. */
export async function notifyBuyer(db: DbHandle, po: PurchaseOrder, message: string): Promise<void> {
  if (!po.buyerPhone) {
    console.info(`[procurement] PO ${po.poNumber} has no buyerPhone — buyer notification skipped`);
    return;
  }
  await sendWhatsAppText(po.buyerTenantId, po.buyerPhone, message, { notifType: "po_update" })
    .catch((e: any) => console.warn("[procurement] buyer notify failed:", e?.message));
}

// ── Supplier action card (Approve / Reject) ──────────────────────────────────

export type PoCardAction = "approve" | "reject";

/** Interactive reply id for a supplier PO action button: `po_<action>:<poId>`. */
export function poActionReplyId(action: PoCardAction, poId: string): string {
  return `po_${action}:${poId}`;
}

/** Parse an interactive reply id back into a PO action (or null). */
export function parsePoActionReplyId(id: string): { action: PoCardAction; poId: string } | null {
  const m = /^po_(approve|reject):(\S+)$/.exec(id.trim());
  return m ? { action: m[1] as PoCardAction, poId: m[2] } : null;
}

/**
 * The interactive card the supplier's admin receives on PO submission:
 * "PO #… from {buyer} — ₦X — net {terms}d" with Approve / Reject buttons.
 */
export function buildSupplierPoCard(opts: {
  poId: string;
  poNumber: string;
  buyerName: string;
  subtotalCents: number;
  paymentMode: string;
  termsDays: number | null;
}): SendInteractiveInput {
  const terms =
    opts.paymentMode === "credit"
      ? ` — net ${opts.termsDays ?? "?"}d`
      : " — pay now";
  return {
    bodyText: `📦 ${opts.poNumber} from ${opts.buyerName} — ${formatNaira(opts.subtotalCents)}${terms}`,
    footerText: "Approve to accept this purchase order.",
    action: {
      type: "button",
      buttons: [
        { id: poActionReplyId("approve", opts.poId), title: "Approve" },
        { id: poActionReplyId("reject", opts.poId), title: "Reject" },
      ],
    },
  };
}

// ── Submit / approve / reject / pay / fulfill / cancel ──────────────────────

export interface PoLineInput {
  productRef?: string | null;
  name: string;
  qty: number;
  unitPriceCents: number;
}

export interface SubmitPoResult {
  ok: boolean;
  reason?: "supplier_inactive" | "empty" | "below_moq";
  moqCents?: number;
  po?: PurchaseOrder;
  autoApproved?: boolean;
}

/**
 * Create + submit a purchase order (status 'submitted'), then notify the
 * supplier's admin with the Approve/Reject action card. Auto-approves when
 * subtotal <= the supplier's auto_approve_below_cents (credit draw guard
 * still runs via approvePurchaseOrder).
 */
export async function submitPurchaseOrder(
  db: DbHandle,
  opts: {
    buyerTenantId: string;
    supplierTenantId: string;
    buyerPhone?: string | null;
    lines: PoLineInput[];
    paymentMode: "credit" | "paynow";
    termsDays?: number | null;
    notes?: string | null;
  },
): Promise<SubmitPoResult> {
  const profile = await getActiveSupplierProfile(db, opts.supplierTenantId);
  if (!profile) return { ok: false, reason: "supplier_inactive" };
  const lines = (opts.lines ?? []).filter((l) => l.qty > 0 && l.unitPriceCents >= 0 && l.name.trim());
  if (lines.length === 0) return { ok: false, reason: "empty" };
  const subtotalCents = lines.reduce((s, l) => s + l.qty * l.unitPriceCents, 0);
  const moqCents = Number(profile.moqCents ?? 0);
  if (subtotalCents < moqCents) return { ok: false, reason: "below_moq", moqCents };

  const termsDays =
    opts.paymentMode === "credit"
      ? opts.termsDays ?? Number(profile.defaultTermsDays ?? 14)
      : null;
  const now = new Date();
  const poNumber = await generatePoNumber(db, now);
  const poId = crypto.randomUUID();
  await db.insert(purchaseOrders).values({
    id: poId,
    poNumber,
    buyerTenantId: opts.buyerTenantId,
    supplierTenantId: opts.supplierTenantId,
    status: "submitted",
    subtotalCents,
    paymentMode: opts.paymentMode,
    termsDays,
    buyerPhone: opts.buyerPhone ?? null,
    notes: opts.notes ?? null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(poItems).values(
    lines.map((l) => ({
      id: crypto.randomUUID(),
      poId,
      productRef: l.productRef ?? null,
      name: l.name,
      qty: l.qty,
      unitPriceCents: l.unitPriceCents,
      lineTotalCents: l.qty * l.unitPriceCents,
    })),
  );
  const po = (await getPoById(db, poId))!;

  // Auto-approve small POs (credit draw guard still applies).
  const autoBelow = profile.autoApproveBelowCents;
  if (autoBelow != null && subtotalCents <= Number(autoBelow)) {
    const result = await approvePurchaseOrder(db, { poId });
    if (result.ok) {
    await notifyBuyer(
      db,
      (await getPoById(db, poId)) ?? po,
      `✅ ${poNumber} was auto-approved by the supplier${result.status === "invoiced" ? ` on credit — due ${result.dueDate?.toDateString()}` : ""}.`,
    );
    return { ok: true, po: (await getPoById(db, poId)) ?? po, autoApproved: true };
    }
    // Auto-approve failed the credit guard → fall through to manual approval card.
    console.info(`[procurement] auto-approve skipped for ${poNumber}: ${result.ok === false ? result.reason : "unknown"}`);
  }

  const buyerName = await tenantNameOf(db, opts.buyerTenantId);
  const card = buildSupplierPoCard({
    poId,
    poNumber,
    buyerName,
    subtotalCents,
    paymentMode: opts.paymentMode,
    termsDays,
  });
  await notifyTenantAdminPhone(db, opts.supplierTenantId, "", card);
  return { ok: true, po, autoApproved: false };
}

export type ApprovePoResult =
  | { ok: true; status: "invoiced"; dueDate: Date; outstandingAfter: number }
  | { ok: true; status: "approved"; paymentUrl: string | null }
  | { ok: false; reason: "not_found" | "wrong_status" | "over_limit" | "no_account" | "frozen" | "closed" };

/**
 * Supplier-side approval. Credit POs draw on the buyer's trade-credit account
 * (S1 engine); a successful draw moves the PO straight to 'invoiced' with
 * due_date = now + termsDays. Paynow POs move to 'approved' and a payment
 * link is created for the buyer.
 */
export async function approvePurchaseOrder(
  db: DbHandle,
  opts: { poId: string; termsDays?: number },
): Promise<ApprovePoResult> {
  const po = await getPoById(db, opts.poId);
  if (!po) return { ok: false, reason: "not_found" };
  if (po.status !== "submitted") return { ok: false, reason: "wrong_status" };
  const now = new Date();

  if (po.paymentMode === "credit") {
    const account = await getCreditAccount(po.supplierTenantId, po.buyerTenantId).catch(() => null);
    const termsDays = opts.termsDays ?? po.termsDays ?? Number((account as any)?.termsDays ?? 14);
    const draw = await drawOnCredit({
      supplierTenantId: po.supplierTenantId,
      buyerTenantId: po.buyerTenantId,
      amountCents: Number(po.subtotalCents),
      poId: po.id,
      termsDays,
    });
    if (!draw.ok) return { ok: false, reason: draw.reason };
    const dueDate = new Date(now.getTime() + termsDays * 24 * 60 * 60 * 1000);
    await db.update(purchaseOrders).set({
      status: "invoiced",
      creditAccountId: (account as any)?.id ?? null,
      termsDays,
      dueDate,
      updatedAt: now,
    }).where(eq(purchaseOrders.id, po.id));
    return { ok: true, status: "invoiced", dueDate, outstandingAfter: draw.outstandingAfter };
  }

  // paynow — approved pending payment; create the payment link for the buyer.
  await db.update(purchaseOrders).set({ status: "approved", updatedAt: now })
    .where(eq(purchaseOrders.id, po.id));
  const paymentUrl = await createPoPaymentLink(db, po).catch((e: any) => {
    console.warn("[procurement] payment link creation failed:", e?.message);
    return null;
  });
  return { ok: true, status: "approved", paymentUrl };
}

/**
 * Existing payment-link flow for paynow POs: reuses payment.initiate (paystack
 * default) with metadata.poId so confirmProviderPayment can settle the PO.
 * Returns null when no link could be created (supplier shares details offline).
 */
export async function createPoPaymentLink(db: DbHandle, po: PurchaseOrder): Promise<string | null> {
  const { appRouter } = await import("../../routers");
  const caller = appRouter.createCaller({ user: { role: "admin", id: "procurement-po" } } as any);
  const result = await caller.payment.initiate({
    tenantId: po.supplierTenantId,
    orderId: po.id,
    amount: Number(po.subtotalCents) / 100,
    currency: "NGN",
    provider: "paystack",
    customerPhone: po.buyerPhone ?? "procurement@wa.commerce",
    metadata: { type: "po_payment", poId: po.id, poNumber: po.poNumber },
  });
  return (result as any)?.paymentUrl ?? null;
}

/** Reject a submitted PO; the buyer is notified (reason included when given). */
export async function rejectPurchaseOrder(
  db: DbHandle,
  opts: { poId: string; reason?: string | null },
): Promise<{ ok: boolean; reason?: "not_found" | "wrong_status" }> {
  const po = await getPoById(db, opts.poId);
  if (!po) return { ok: false, reason: "not_found" };
  if (po.status !== "submitted") return { ok: false, reason: "wrong_status" };
  await db.update(purchaseOrders).set({
    status: "rejected",
    notes: opts.reason?.trim() ? `Rejected: ${opts.reason.trim()}` : po.notes,
    updatedAt: new Date(),
  }).where(eq(purchaseOrders.id, po.id));
  await notifyBuyer(
    db,
    po,
    `❌ ${po.poNumber} was rejected by the supplier${opts.reason?.trim() ? `: ${opts.reason.trim()}` : "."} Type "menu" to start a new order.`,
  );
  return { ok: true };
}

/**
 * Record the reason a supplier rejected a PO (WhatsApp reject follow-up
 * prompt) and forward it to the buyer.
 */
export async function recordPoRejectionReason(db: DbHandle, poId: string, reason: string): Promise<void> {
  const po = await getPoById(db, poId);
  if (!po) return;
  await db.update(purchaseOrders).set({ notes: `Rejected: ${reason.trim()}`, updatedAt: new Date() })
    .where(eq(purchaseOrders.id, po.id));
  await notifyBuyer(db, po, `ℹ️ ${po.poNumber} rejection reason: ${reason.trim()}`);
}

/**
 * Credit-draw failure fallback: the buyer switches the PO to pay-now and the
 * supplier's approval continues down the payment-link path.
 */
export async function switchPoToPayNow(db: DbHandle, poId: string): Promise<PurchaseOrder | null> {
  await db.update(purchaseOrders).set({ paymentMode: "paynow", termsDays: null, updatedAt: new Date() })
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.status, "submitted")));
  return getPoById(db, poId);
}

/** Payment confirmed (provider webhook or supplier manual confirm) → 'paid'. */
export async function handlePoPaymentConfirmed(
  db: DbHandle,
  opts: { poId: string; reference?: string },
): Promise<{ ok: boolean; action: string }> {
  const po = await getPoById(db, opts.poId);
  if (!po) return { ok: false, action: "not_found" };
  if (po.status === "paid") return { ok: true, action: "already_paid" };
  if (po.status !== "approved") return { ok: false, action: `wrong_status:${po.status}` };
  await db.update(purchaseOrders).set({
    status: "paid",
    notes: opts.reference ? `Paid via ${opts.reference}` : po.notes,
    updatedAt: new Date(),
  }).where(eq(purchaseOrders.id, po.id));
  await notifyBuyer(db, po, `✅ Payment received for ${po.poNumber} (${formatNaira(Number(po.subtotalCents))}). The supplier will fulfil your order shortly.`);
  await notifyTenantAdminPhone(db, po.supplierTenantId, `💰 ${po.poNumber} is now PAID (${formatNaira(Number(po.subtotalCents))}). Please fulfil the order.`);
  return { ok: true, action: "paid" };
}

/** Supplier marks an approved/invoiced/paid PO as fulfilled (goods delivered). */
export async function markPoFulfilled(
  db: DbHandle,
  opts: { poId: string },
): Promise<{ ok: boolean; reason?: "not_found" | "wrong_status" }> {
  const po = await getPoById(db, opts.poId);
  if (!po) return { ok: false, reason: "not_found" };
  if (!["approved", "invoiced", "paid"].includes(po.status)) return { ok: false, reason: "wrong_status" };
  await db.update(purchaseOrders).set({ status: "fulfilled", updatedAt: new Date() })
    .where(eq(purchaseOrders.id, po.id));
  await notifyBuyer(db, po, `🚚 ${po.poNumber} has been fulfilled by the supplier. Thanks for your business!`);
  return { ok: true };
}

/** Buyer cancels a DRAFT PO — hard-deletes the draft + its items. */
export async function cancelDraftPo(
  db: DbHandle,
  opts: { poId: string; buyerTenantId: string },
): Promise<{ ok: boolean; reason?: "not_found" | "forbidden" | "wrong_status" }> {
  const po = await getPoById(db, opts.poId);
  if (!po) return { ok: false, reason: "not_found" };
  if (po.buyerTenantId !== opts.buyerTenantId) return { ok: false, reason: "forbidden" };
  if (po.status !== "draft") return { ok: false, reason: "wrong_status" };
  await db.delete(poItems).where(eq(poItems.poId, po.id));
  await db.delete(purchaseOrders).where(eq(purchaseOrders.id, po.id));
  return { ok: true };
}

// ── WhatsApp conversational flow (buyer + supplier sides) ───────────────────

import type { ChatSession } from "../chatSession";
import { saveSession } from "../chatSession";
import { listSuppliers } from "./directory";
import { getWholesaleCatalog } from "./b2bCatalog";

export interface ProcurementChatCtx {
  db: DbHandle;
  tenantId: string;
  phone: string;
  customerName?: string;
  tenantSettings?: Record<string, unknown> | null;
  businessName?: string;
}

export interface ProcurementChatOutcome {
  reply: string;
  nextState: Partial<ChatSession> | null;
}

interface CartLine { ref: string | null; name: string; qty: number; unitPriceCents: number }
interface CatalogEntry { ref: string; name: string; priceCents: number; minQty: number }

const PROCUREMENT_ID = "procurement" as ChatSession["activeUseCase"];

function state(step: string, data: Record<string, unknown>): Partial<ChatSession> {
  return { mode: "usecase", activeUseCase: PROCUREMENT_ID, step, data };
}

function cartSubtotal(cart: CartLine[]): number {
  return cart.reduce((s, l) => s + l.qty * l.unitPriceCents, 0);
}

function renderCart(cart: CartLine[]): string {
  return cart
    .map((l, i) => `${i + 1}. ${l.name} × ${l.qty} — ${formatNaira(l.qty * l.unitPriceCents)}`)
    .join("\n");
}

function renderPoList(pos: PurchaseOrder[], emptyText: string): string {
  if (pos.length === 0) return emptyText;
  const lines = pos.map(
    (p) => `• ${p.poNumber} — ${p.status} — ${formatNaira(Number(p.subtotalCents))} (${p.paymentMode === "credit" ? `net ${p.termsDays ?? "?"}d` : "pay now"})`,
  );
  return lines.join("\n");
}

const BROWSE_HELP =
  "Reply with:\n• *add <item#> <qty>* to add (e.g. add 2 10)\n• *remove <line#>* to drop a cart line\n• *cart* to review\n• *done* to check out\n• *cancel* to exit";

/**
 * The "procurement" use-case handler (buyer-side restock flow + supplier-side
 * wholesale-orders inbox). Driven from useCases.ts with the shared session
 * engine; every reply is plain WhatsApp text.
 */
export async function handleProcurementChat(
  ctx: ProcurementChatCtx,
  session: Pick<ChatSession, "step" | "data">,
  input: string,
): Promise<ProcurementChatOutcome> {
  const { db, tenantId, phone } = ctx;
  const data = (session.data ?? {}) as Record<string, any>;
  const text = input.trim();
  const lower = text.toLowerCase();

  // ── Supplier-side: reject reason follow-up ────────────────────────────────
  if (session.step === "po_reject_reason") {
    const poId = String(data.poId ?? "");
    if (!poId) return { reply: "That rejection session expired — the PO was already rejected.", nextState: null };
    if (lower === "skip") {
      return { reply: "OK — the buyer was notified of the rejection.", nextState: null };
    }
    await recordPoRejectionReason(db, poId, text);
    return { reply: "Reason recorded and sent to the buyer. ✅", nextState: null };
  }

  // ── Buyer-side: credit-draw failure fallback (pay now / limit increase) ───
  if (session.step === "po_credit_fallback") {
    const poId = String(data.poId ?? "");
    const po = poId ? await getPoById(db, poId) : null;
    if (!po || po.status !== "submitted") {
      return { reply: "That purchase order is no longer awaiting approval.", nextState: null };
    }
    if (lower === "1" || lower === "pay now" || lower === "paynow") {
      const switched = await switchPoToPayNow(db, po.id);
      if (!switched) return { reply: "Sorry, that PO can no longer be changed.", nextState: null };
      const buyerName = await tenantNameOf(db, po.buyerTenantId);
      const card = buildSupplierPoCard({
        poId: po.id,
        poNumber: po.poNumber,
        buyerName,
        subtotalCents: Number(po.subtotalCents),
        paymentMode: "paynow",
        termsDays: null,
      });
      await notifyTenantAdminPhone(db, po.supplierTenantId, "", card);
      return {
        reply: `Done — ${po.poNumber} now requests *pay now*. The supplier has been asked to approve it again.`,
        nextState: null,
      };
    }
    if (lower === "2" || lower === "limit" || lower === "credit") {
      const suggestion = await suggestLimit(po.buyerTenantId, po.supplierTenantId)
        .catch(() => null);
      const buyerName = await tenantNameOf(db, po.buyerTenantId);
      const suggestionLine = suggestion
        ? `\nSuggested limit: ${formatNaira(suggestion.suggestedLimitCents)} (score ${suggestion.score}).`
        : "";
      await notifyTenantAdminPhone(
        db,
        po.supplierTenantId,
        `📈 ${buyerName} requests a credit limit increase to cover ${po.poNumber} (${formatNaira(Number(po.subtotalCents))}).${suggestionLine}\nReview it in the trade-credit dashboard.`,
      );
      return {
        reply: "Request sent ✅ — the supplier will review your credit limit. We'll message you when there's an update.",
        nextState: null,
      };
    }
    if (lower === "3" || lower === "cancel") {
      return { reply: "OK — the PO stays with the supplier for now. Type \"menu\" anytime to start over.", nextState: null };
    }
    return {
      reply: "Reply with:\n1. Pay now instead\n2. Request a credit limit increase\n3. Leave it for now",
      nextState: state("po_credit_fallback", data),
    };
  }

  // ── Entry: buyer restock + supplier wholesale inbox ───────────────────────
  if (session.step !== "choose_supplier" && session.step !== "browse" &&
      session.step !== "choose_payment" && session.step !== "choose_terms" &&
      session.step !== "confirm" && session.step !== "entry") {
    const supplierProfile = await getActiveSupplierProfile(db, tenantId);
    const opts = ["1. 🏭 Browse suppliers & restock", "2. 📋 My purchase orders"];
    if (supplierProfile) opts.push("3. 📥 Incoming wholesale orders");
    return {
      reply: `*Restock / Buy supplies*\n\n${opts.join("\n")}\n\nReply with a number, or \"cancel\" to exit.`,
      nextState: state("entry", { hasSupplierInbox: !!supplierProfile }),
    };
  }

  if (lower === "cancel" || lower === "exit") {
    return { reply: "Procurement cancelled. Type \"menu\" anytime to start again.", nextState: null };
  }

  if (session.step === "entry") {
    const pick = /^\d{1,2}$/.test(lower) ? parseInt(lower, 10) : 0;
    if (pick === 2) {
      const pos = await listPos(db, { tenantId, role: "buyer", limit: 10 });
      return {
        reply: `*Your purchase orders:*\n${renderPoList(pos, "No purchase orders yet — reply 1 to browse suppliers.")}`,
        nextState: null,
      };
    }
    if (pick === 3 && data.hasSupplierInbox) {
      const pos = await listPos(db, { tenantId, role: "supplier", status: "submitted", limit: 10 });
      return {
        reply: `*Incoming wholesale orders (awaiting your approval):*\n${renderPoList(pos, "None pending right now. 🎉")}\n\nNew orders arrive here with Approve/Reject buttons.`,
        nextState: null,
      };
    }
    if (pick !== 1) {
      return { reply: "Please reply 1 (browse suppliers), 2 (my purchase orders) or \"cancel\".", nextState: state("entry", data) };
    }
    const suppliers = await listSuppliers(db, { buyerTenantId: tenantId, limit: 9 });
    if (suppliers.length === 0) {
      return {
        reply: "No suppliers are available on the network yet. Please check back soon!",
        nextState: null,
      };
    }
    const lines = suppliers.map((s, i) => {
      const credit = s.credit && s.credit.status === "active"
        ? ` — credit: ${formatNaira(s.credit.limitCents - s.credit.outstandingCents)} avail (net ${s.credit.termsDays}d)`
        : "";
      const moq = s.moqCents > 0 ? ` · MOQ ${formatNaira(s.moqCents)}` : "";
      return `${i + 1}. ${s.name ?? "Supplier"} — lead ${s.leadTimeDays}d${moq}${credit}`;
    });
    return {
      reply: `*Choose a supplier:*\n\n${lines.join("\n")}\n\nReply with a number.`,
      nextState: state("choose_supplier", {
        supplierIds: suppliers.map((s) => s.tenantId),
        supplierNames: suppliers.map((s) => s.name ?? "Supplier"),
      }),
    };
  }

  if (session.step === "choose_supplier") {
    const ids = (data.supplierIds ?? []) as string[];
    const names = (data.supplierNames ?? []) as string[];
    const idx = /^\d{1,2}$/.test(lower) ? parseInt(lower, 10) - 1 : -1;
    if (idx < 0 || idx >= ids.length) {
      return { reply: "Please reply with the number of the supplier you want to buy from.", nextState: state("choose_supplier", data) };
    }
    const catalog = await getWholesaleCatalog(db, { supplierTenantId: ids[idx], limit: 20 });
    if (!catalog || catalog.items.length === 0) {
      return {
        reply: `${names[idx]} has no wholesale items listed right now. Pick another supplier (or \"cancel\").`,
        nextState: state("choose_supplier", data),
      };
    }
    const lines = catalog.items.map(
      (it, i) => `${i + 1}. ${it.name} — ${formatNaira(it.unitPriceCents)}${it.minQty > 1 ? ` (min ${it.minQty})` : ""}`,
    );
    const moqLine = catalog.moqCents > 0 ? `\nMinimum order: ${formatNaira(catalog.moqCents)}.` : "";
    return {
      reply: `*${names[idx]} — wholesale catalog* (lead time ${catalog.leadTimeDays}d)${moqLine}\n\n${lines.join("\n")}\n\n${BROWSE_HELP}`,
      nextState: state("browse", {
        supplierId: ids[idx],
        supplierName: names[idx],
        moqCents: catalog.moqCents,
        termsOffered: catalog.termsOffered,
        defaultTermsDays: catalog.defaultTermsDays,
        catalog: catalog.items.map((it) => ({ ref: it.productRef, name: it.name, priceCents: it.unitPriceCents, minQty: it.minQty })),
        cart: [],
      }),
    };
  }

  if (session.step === "browse") {
    const catalog = (data.catalog ?? []) as CatalogEntry[];
    const cart = (data.cart ?? []) as CartLine[];

    if (lower === "cart") {
      const body = cart.length === 0 ? "Your cart is empty." : `${renderCart(cart)}\n\nSubtotal: ${formatNaira(cartSubtotal(cart))}`;
      return { reply: `${body}\n\n${BROWSE_HELP}`, nextState: state("browse", data) };
    }
    if (lower === "done" || lower === "checkout") {
      if (cart.length === 0) {
        return { reply: `Your cart is empty — add something first.\n\n${BROWSE_HELP}`, nextState: state("browse", data) };
      }
      const subtotal = cartSubtotal(cart);
      const moq = Number(data.moqCents ?? 0);
      if (subtotal < moq) {
        return {
          reply: `⚠️ Minimum order for ${data.supplierName} is ${formatNaira(moq)} — your subtotal is ${formatNaira(subtotal)}. Add more items or \"cancel\".\n\n${BROWSE_HELP}`,
          nextState: state("browse", data),
        };
      }
      // Review card + payment options. Credit is offered ONLY when the buyer
      // has an ACTIVE credit account with this supplier (S1 engine).
      const account = await getCreditAccount(String(data.supplierId), tenantId).catch(() => null);
      const creditAvailable = !!account && (account as any).status === "active";
      const termsOffered = Array.isArray(data.termsOffered) ? (data.termsOffered as number[]) : [];
      const termsOptions = termsOffered.length > 0
        ? termsOffered
        : [Number(data.defaultTermsDays ?? 14)];
      const payLines: string[] = [];
      if (creditAvailable) payLines.push(`1. Pay on credit (net ${termsOptions.join("/")}d) — ${formatNaira(Number((account as any).limitCents ?? 0) - Number((account as any).outstandingCents ?? 0))} available`);
      payLines.push(`${creditAvailable ? 2 : 1}. Pay now`);
      return {
        reply: `*Review your PO — ${data.supplierName}*\n\n${renderCart(cart)}\n\nSubtotal: ${formatNaira(subtotal)}\n\nHow would you like to pay?\n${payLines.join("\n")}`,
        nextState: state("choose_payment", { ...data, creditAvailable, termsOptions }),
      };
    }
    const rm = /^remove\s+(\d{1,2})$/.exec(lower);
    if (rm) {
      const ci = parseInt(rm[1], 10) - 1;
      if (ci < 0 || ci >= cart.length) {
        return { reply: "That cart line number doesn't exist — reply *cart* to see your lines.", nextState: state("browse", data) };
      }
      const [removed] = cart.splice(ci, 1);
      return { reply: `Removed ${removed.name}. Subtotal: ${formatNaira(cartSubtotal(cart))}\n\n${BROWSE_HELP}`, nextState: state("browse", { ...data, cart }) };
    }
    const add = /^(?:add\s+)?(\d{1,2})(?:\s*[x× ]\s*|\s+)?(\d{1,5})?$/.exec(lower);
    if (add && (lower.startsWith("add") || /^\d/.test(lower))) {
      const itemIdx = parseInt(add[1], 10) - 1;
      const item = catalog[itemIdx];
      if (!item) {
        return { reply: "Unknown item number — reply with the catalog number you want.", nextState: state("browse", data) };
      }
      const qty = add[2] ? parseInt(add[2], 10) : Math.max(1, item.minQty);
      if (!Number.isFinite(qty) || qty <= 0) {
        return { reply: "Quantity must be a positive number, e.g. add 2 10.", nextState: state("browse", data) };
      }
      if (qty < item.minQty) {
        return { reply: `⚠️ ${item.name} has a minimum quantity of ${item.minQty}.`, nextState: state("browse", data) };
      }
      const existing = cart.find((l) => l.ref === item.ref);
      if (existing) existing.qty += qty;
      else cart.push({ ref: item.ref, name: item.name, qty, unitPriceCents: item.priceCents });
      return {
        reply: `Added ${item.name} × ${qty}. Subtotal: ${formatNaira(cartSubtotal(cart))}\nReply \"done\" to check out, or keep adding.`,
        nextState: state("browse", { ...data, cart }),
      };
    }
    return { reply: BROWSE_HELP, nextState: state("browse", data) };
  }

  if (session.step === "choose_payment") {
    const creditAvailable = !!data.creditAvailable;
    const wantsCredit = creditAvailable && (lower === "1" || lower.includes("credit"));
    const wantsPaynow = creditAvailable ? (lower === "2" || lower.includes("pay now") || lower === "paynow")
                                        : (lower === "1" || lower.includes("pay"));
    if (!wantsCredit && !wantsPaynow) {
      return { reply: "Please reply with the number of your payment choice (or \"cancel\").", nextState: state("choose_payment", data) };
    }
    if (wantsCredit) {
      const termsOptions = (data.termsOptions ?? [14]) as number[];
      if (termsOptions.length > 1) {
        return {
          reply: `Choose your credit terms:\n${termsOptions.map((t, i) => `${i + 1}. Net ${t} days`).join("\n")}`,
          nextState: state("choose_terms", { ...data, paymentMode: "credit" }),
        };
      }
      return {
        reply: `Pay on credit — net ${termsOptions[0]} days.\n\nReply *CONFIRM* to submit the PO, or \"cancel\".`,
        nextState: state("confirm", { ...data, paymentMode: "credit", termsDays: termsOptions[0] }),
      };
    }
    return {
      reply: "Pay now — you'll receive a payment link once the supplier approves.\n\nReply *CONFIRM* to submit the PO, or \"cancel\".",
      nextState: state("confirm", { ...data, paymentMode: "paynow", termsDays: null }),
    };
  }

  if (session.step === "choose_terms") {
    const termsOptions = (data.termsOptions ?? []) as number[];
    const idx = /^\d{1,2}$/.test(lower) ? parseInt(lower, 10) - 1 : -1;
    if (idx < 0 || idx >= termsOptions.length) {
      return { reply: "Please reply with the number of the terms you want.", nextState: state("choose_terms", data) };
    }
    return {
      reply: `Pay on credit — net ${termsOptions[idx]} days.\n\nReply *CONFIRM* to submit the PO, or \"cancel\".`,
      nextState: state("confirm", { ...data, paymentMode: "credit", termsDays: termsOptions[idx] }),
    };
  }

  // confirm
  if (lower !== "confirm" && lower !== "yes") {
    return { reply: "Reply *CONFIRM* to submit the PO, or \"cancel\" to exit.", nextState: state("confirm", data) };
  }
  const cart = (data.cart ?? []) as CartLine[];
  const result = await submitPurchaseOrder(db, {
    buyerTenantId: tenantId,
    supplierTenantId: String(data.supplierId),
    buyerPhone: phone,
    lines: cart.map((l) => ({ productRef: l.ref, name: l.name, qty: l.qty, unitPriceCents: l.unitPriceCents })),
    paymentMode: data.paymentMode === "paynow" ? "paynow" : "credit",
    termsDays: typeof data.termsDays === "number" ? data.termsDays : null,
    notes: ctx.customerName ? `Placed via WhatsApp by ${ctx.customerName}` : "Placed via WhatsApp",
  });
  if (!result.ok) {
    if (result.reason === "below_moq") {
      return {
        reply: `⚠️ This supplier's minimum order is ${formatNaira(result.moqCents ?? 0)}. Your subtotal is too low — the PO was not submitted.`,
        nextState: null,
      };
    }
    return { reply: "Sorry, that supplier isn't available for procurement right now.", nextState: null };
  }
  const po = result.po!;
  if (result.autoApproved) {
    return {
      reply: `✅ *${po.poNumber}* submitted and auto-approved (${formatNaira(Number(po.subtotalCents))}, ${po.paymentMode === "credit" ? `net ${po.termsDays}d` : "pay now"}). You'll get fulfilment updates here.`,
      nextState: null,
    };
  }
  return {
    reply: `✅ *${po.poNumber}* submitted to ${data.supplierName} (${formatNaira(Number(po.subtotalCents))}, ${po.paymentMode === "credit" ? `net ${po.termsDays}d` : "pay now"}). We'll message you as soon as they approve or reject it.`,
    nextState: null,
  };
}

// ── Supplier action-card handler (Approve / Reject buttons) ─────────────────

/**
 * Execute a supplier's Approve/Reject button tap. The interactive reply
 * arrives on the SUPPLIER tenant's channel, so `tenantId` must match the
 * PO's supplierTenantId — otherwise nothing happens (ownership probe-safe).
 */
export async function handlePoAction(opts: {
  db: DbHandle;
  tenantId: string;
  phone: string;
  action: PoCardAction;
  poId: string;
}): Promise<{ reply: string; reasonPrompt?: { poId: string } }> {
  const { db, tenantId, action, poId } = opts;
  const po = await getPoById(db, poId);
  if (!po || po.supplierTenantId !== tenantId) {
    return { reply: "Sorry, I couldn't find that purchase order." };
  }
  if (po.status !== "submitted") {
    return { reply: `${po.poNumber} is ${po.status} — no action needed.` };
  }

  if (action === "reject") {
    await rejectPurchaseOrder(db, { poId: po.id });
    return {
      reply: `❌ ${po.poNumber} rejected. Reply with a reason to forward to the buyer (or \"skip\").`,
      reasonPrompt: { poId: po.id },
    };
  }

  const result = await approvePurchaseOrder(db, { poId: po.id });
  if (result.ok && result.status === "invoiced") {
    const fresh = (await getPoById(db, po.id)) ?? po;
    await notifyBuyer(
      db,
      fresh,
      `✅ ${po.poNumber} approved on credit — ${formatNaira(Number(po.subtotalCents))}, due ${result.dueDate.toDateString()} (net ${fresh.termsDays}d). Outstanding on your account: ${formatNaira(result.outstandingAfter)}.`,
    );
    return {
      reply: `✅ ${po.poNumber} approved on credit — due ${result.dueDate.toDateString()}. Buyer outstanding: ${formatNaira(result.outstandingAfter)}.`,
    };
  }
  if (result.ok) {
    const linkLine = result.paymentUrl
      ? `Payment link sent to the buyer:\n${result.paymentUrl}`
      : "No payment link could be created automatically — please share payment details with the buyer directly.";
    if (result.paymentUrl) {
      await notifyBuyer(db, po, `✅ ${po.poNumber} approved! Complete payment (${formatNaira(Number(po.subtotalCents))}):\n${result.paymentUrl}`);
    } else {
      await notifyBuyer(db, po, `✅ ${po.poNumber} approved! The supplier will share payment details with you here shortly.`);
    }
    return { reply: `✅ ${po.poNumber} approved (pay now). ${linkLine}` };
  }

  // Credit draw failed → offer the buyer the fallback path.
  const reasonText: Record<string, string> = {
    over_limit: "the buyer's credit limit is too low for this amount",
    no_account: "the buyer has no credit account with you",
    frozen: "the buyer's credit account is frozen",
    closed: "the buyer's credit account is closed",
    not_found: "the PO no longer exists",
    wrong_status: "the PO is no longer awaiting approval",
  };
  if (result.reason === "over_limit" || result.reason === "no_account" ||
      result.reason === "frozen" || result.reason === "closed") {
    if (po.buyerPhone) {
      await saveSession({
        tenantId: po.buyerTenantId,
        phone: po.buyerPhone,
        mode: "usecase",
        activeUseCase: PROCUREMENT_ID,
        step: "po_credit_fallback",
        data: { poId: po.id },
        updatedAt: Date.now(),
      } as ChatSession);
      await notifyBuyer(
        db,
        po,
        `⚠️ ${po.poNumber} couldn't be approved on credit (${reasonText[result.reason]}).\n\nReply with:\n1. Pay now instead\n2. Request a credit limit increase\n3. Leave it for now`,
      );
    }
  }
  return {
    reply: `⚠️ Can't approve ${po.poNumber} on credit — ${reasonText[result.reason] ?? "unknown reason"}. The buyer has been offered pay-now / limit-increase options.`,
  };
}
