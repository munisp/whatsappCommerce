/**
 * === W37 telegram (Coder C) ===
 * channelParity.ts — channel-agnostic customer notification routing with
 * WhatsApp/Telegram parity.
 *
 * Per the W37 surface map (wa-surface-map.md §8) every business-message
 * category that fires on WhatsApp must also fire on Telegram. This module is
 * the single seam the migrated callers use:
 *
 *   - `PARITY_CATEGORIES`    — the 15-category parity registry (J246 snapshot).
 *   - `notifyCustomer(...)`  — resolve the customer's channel and route the
 *                              message through the channelSender facade
 *                              (telegram) or report `handled:false` so the
 *                              caller continues its unchanged WA path.
 *   - `sendCustomerText(...)`— one-line mechanical replacement for
 *                              `sendWhatsAppText`: WA recipients go through
 *                              the ORIGINAL waSender call (byte-equivalent),
 *                              telegram recipients through channelSender.
 *   - `requiresSessionWindow`/`canSendFreeform` — the 24h service window is a
 *                              WhatsApp concept (sessionWindow.ts); Telegram
 *                              has NONE, so cron nudges (cart recovery,
 *                              dunning) must never suppress telegram sends.
 *   - `adaptForChannel(...)` — per-category payload adapters (e.g. payment
 *                              links become URL inline-buttons on telegram —
 *                              never wa.me deep links).
 *
 * Fail-open doctrine: any resolution/routing error logs a warning and falls
 * back to the WhatsApp path (or a simulated telegram result); this module
 * NEVER throws into a business flow.
 */

import { sql } from "drizzle-orm";
import { getDb } from "../db";

// ─── Channel primitives ──────────────────────────────────────────────────────

export type Channel = "whatsapp" | "telegram";

export const TELEGRAM_CHANNEL = "telegram" as const;
export const WHATSAPP_CHANNEL = "whatsapp" as const;

/** Telegram Bot API fair-use limit used by broadcast fan-out (30 msg/s). */
export const TELEGRAM_BROADCAST_RATE_PER_SEC = 30;
export const TELEGRAM_BROADCAST_MIN_INTERVAL_MS = Math.ceil(1000 / TELEGRAM_BROADCAST_RATE_PER_SEC);

/**
 * The 24h customer-service window (services/sessionWindow.ts, WA_WINDOW_MS)
 * is a WhatsApp Business Platform concept. Telegram bots may message a chat
 * at any time after the user started the bot — there is NO window.
 */
export function requiresSessionWindow(channel: string): boolean {
  return channel !== TELEGRAM_CHANNEL;
}

/**
 * May a free-form (non-template) message be sent on this channel right now?
 * WA: only inside the 24h window. Telegram: always.
 */
export function canSendFreeform(channel: string, windowOpen: boolean): boolean {
  return !requiresSessionWindow(channel) || windowOpen;
}

// ─── Parity category registry (15 categories — J246 snapshot) ────────────────

export interface ParityCategory {
  /** Stable id used in notifyCustomer + notifType mapping. */
  id: string;
  description: string;
  /** full = native telegram path; adapter = rendered differently (e.g. URL button); wa-only = genuinely channel-specific (MUST be justified). */
  telegram: "full" | "adapter" | "wa-only";
  notes: string;
}

export const PARITY_CATEGORIES: readonly ParityCategory[] = [
  { id: "order_status",        description: "Order confirmations / status updates (template-rendered)", telegram: "adapter", notes: "WA sends an approved Meta template; telegram renders the same {{1..4}} params as formatted text (no approval flow, template name still logged for analytics parity)." },
  { id: "payment_receipt",     description: "Buyer payment receipt after payment confirmation", telegram: "full", notes: "Same receipt text; seam in receipts.ts (paymentConfirm.ts stays PINNED — seam is in its caller chain only)." },
  { id: "payment_link",        description: "Checkout / credit-repay payment links", telegram: "adapter", notes: "Telegram gets a URL inline-button to the PSP checkout URL — NEVER a wa.me deep link (wa.me redirects are WA-specific)." },
  { id: "delivery_pin",        description: "Delivery PIN message at shipment creation", telegram: "full", notes: "Same PIN text; telegram renders the *bold* WA markdown as HTML <b>." },
  { id: "delivery_status",     description: "Shipment/delivery status updates (picked_up … delivered/failed)", telegram: "full", notes: "GAP (documented): Telegram bots receive no delivered/read callbacks, so log rows stay 'sent' — no delivery-receipt pipeline exists for telegram." },
  { id: "po_approval",         description: "PO approval notify (merchant/admin-side, B2B procurement)", telegram: "full", notes: "poFlow.notifyTenantAdminPhone / notifyBuyer seams; APPROVE/REJECT replies arrive via Coder B's telegram inbound normalization." },
  { id: "cart_abandonment",    description: "Cart-abandonment recovery nudge", telegram: "full", notes: "Consent-gated per channel; NOT subject to the 24h window on telegram (requiresSessionWindow('telegram') === false)." },
  { id: "broadcast",           description: "Broadcast / campaign message", telegram: "adapter", notes: "Telegram has no template requirement; fan-out throttled at 30 msg/s (TELEGRAM_BROADCAST_RATE_PER_SEC) per Bot API fair-use." },
  { id: "dunning",             description: "Credit / AR dunning reminder", telegram: "full", notes: "Telegram always free-form (no window); WA keeps the window→template fallback unchanged." },
  { id: "escalation",          description: "Escalation / agent handoff reply", telegram: "full", notes: "conversations.channel routes the reply; channel_messages row records channel='telegram'." },
  { id: "finance_qa",          description: "financeQa reply", telegram: "full", notes: "financeQa returns plain {handled, reply} text with no waSender import — parity is delivered by the inbound engine seam (Coder B); this module routes any proactive financeQa notice." },
  { id: "ops_alert",           description: "Low-stock / quota / dead-letter merchant ops alerts", telegram: "full", notes: "Admin recipients need a telegram chat id in tenant settings (settings.telegram.adminChatId); without one the WA adminPhone path is used unchanged." },
  { id: "annual_statement",    description: "Annual supplier tax statement document", telegram: "full", notes: "Telegram sendDocument carries the same PDF; falls back to WA when no telegram identity is linked." },
  { id: "installment_receipt", description: "Installment / scheduled-payment receipt", telegram: "full", notes: "scheduledPayments seam; same text body." },
  { id: "refund",              description: "Refund notice", telegram: "full", notes: "Plain-text notice; routed via notifyCustomer like every other category." },
  // === W43 fulfillment (Coder A): partial fulfillment + backorders =========
  { id: "partial_fulfillment", description: "Partial fulfillment / fulfillment tracking notice", telegram: "full", notes: "Plain-text notice sent by orderFulfill.fulfillOrderLines; routed via sendCustomerText so WA takes the original sendWhatsAppText path and telegram goes through channelSender." },
  { id: "backorder_filled",    description: "Backorder auto-filled on restock", telegram: "full", notes: "Plain-text notice sent by backorders.restockAndFillBackorders / fillBackordersAfterRestock; both channels via sendCustomerText." },
  // === END W43 fulfillment ===
  // === W43 exchanges (Coder B): exchange lifecycle notices (additive) ===
  { id: "exchange_status",     description: "Exchange request status updates (requested/approved/rejected/received/completed)", telegram: "full", notes: "Plain-text notice via sendCustomerText/notifyCustomer; a positive price-delta checkout rides the payment_link adapter (URL button on telegram, never wa.me)." },
  // === END W43 exchanges ===
  // === W43 dispatch ===
  { id: "delivery_proof",      description: "Proof-of-delivery captured / order delivered notice", telegram: "full", notes: "Same delivered text both channels; POD photo itself is served on the tracking timeline (media URL in order timeline), text notice routed via sendCustomerText." },
  { id: "address_change",      description: "Post-dispatch address change: merchant approval card + terminal status notices", telegram: "full", notes: "Merchant card: WA interactive buttons / TG inline keyboard with the SAME addrchg:approve|reject:<id> grammar via channelSender keyboard payload; customer terminal-path notices (applied/rejected/expired) via sendCustomerText." },
  // === END W43 dispatch ===
  // === W44 giftcards-referrals (Coder A): gift cards + referrals ============
  { id: "gift_card",          description: "Gift card purchase link / activation with code / issue notice", telegram: "full", notes: "Plain-text notices via sendCustomerText; the purchase checkout URL rides the payment_link adapter (URL button on telegram, never wa.me). Balance replies come from the shared NLP engine on BOTH channels." },
  { id: "referral",           description: "Referral reward credit notice to the referrer", telegram: "full", notes: "Plain-text notice via sendCustomerText when a referee's first order is PAID and tenants.referralRewardCents > 0; attribution + code minting run in the shared NLP engine on BOTH channels." },
  // === END W44 giftcards-referrals ===
  // === W44 preorders-offers (Coder B): pre-order availability + haggling ===
  { id: "preorder_status",    description: "Pre-order availability flip + pre-availability cancel/refund notices", telegram: "full", notes: "Plain-text notice via sendCustomerText from preorders.sweepDuePreorders (lines flip 'preorder'→'ordered') and preorders.cancelPreorder (full refund); both channels identical." },
  { id: "custom_offer",       description: "Haggling: merchant offer approval card + counter-offer card + terminal status notices", telegram: "full", notes: "Merchant card: WA interactive buttons / TG inline keyboard with the SAME offer:accept|reject|counter:<id> grammar via channelSender keyboard payload; customer counter card offer:caccept|cdecline:<id>; the accepted-offer priced checkout rides the payment_link adapter (URL button on telegram, never wa.me)." },
  // === END W44 preorders-offers ===
  // === W44 deposits-subs-digital (Coder C): appointments + subscriptions + PINs (additive; J246 subset semantics) ===
  { id: "appointment",         description: "Appointment booking lifecycle: deposit link (payment_link adapter), deposit/remainder confirmations, cancel (refund/forfeit) + no-show notices", telegram: "full", notes: "Plain-text notices via notifyCustomer/sendCustomerText; deposit/remainder payment URLs ride the payment_link adapter (TG URL inline button, never wa.me). Booking/cancel commands arrive via the shared nlp engine on both channels." },
  { id: "subscription_status", description: "Subscription billing receipts + pause/resume/cancel confirmations", telegram: "full", notes: "Success receipt via sendCustomerText after the billing tick order leg; failure dunning rides the EXISTING dunning category. Chat commands (pause/resume/cancel) handled by the shared nlp engine on both channels." },
  { id: "digital_pin",         description: "Digital PIN delivery + reveal-again", telegram: "full", notes: "PIN text delivered via notifyCustomer (decrypted server-side ONLY at delivery); reveal-again re-sends the SAME pin with an audit row on every reveal." },
  // === END W44 deposits-subs-digital ===
  // === W45 messaging-services (Coder A2): image pipeline fail-soft (MSG-24) ===
  { id: "image_pipeline_failed", description: "Fail-soft 'couldn't process that photo' reply when an inbound non-receipt image pipeline errors terminally", telegram: "full", notes: "Plain-text localized reply (i18n imageProcessingFailed) via notifyCustomer/sendCustomerText on BOTH channels; terminal catch of the receipt/visual-search chain in the WA webhook calls replyImagePipelineFailed (A2 helper, A1 owns the index.ts call site)." },
  // === END W45 messaging-services ===
  // === W45 money-scheduled (Coder B1): stale-escrow buyer prompt ==========
  { id: "escrow_stale_prompt", description: "Stale-escrow 'confirm receipt or dispute' buyer prompt (paid-but-undelivered orders past the SLA deadline)", telegram: "full", notes: "Plain-text prompt via sendCustomerText from routers/sla.ts handleStaleEscrow (PAY-22); identical body on both channels, telegram-linked buyers route via channelSender, WA buyers unchanged." },
  // === END W45 money-scheduled ===
  // === W45 money-ledger (Coder B3): pay-over-time lifecycle (additive; J246 subset semantics) ===
  { id: "pot_plan",            description: "Pay-over-time plan lifecycle: mandate-revocation pause + re-link CTA (manual payment link rides the paymentUrl field as text), resume, admin cancel/restructure, manual-settle receipt", telegram: "full", notes: "Plain-text notices via notifyCustomer/sendWhatsAppText from payOverTime.notifyPotMerchant (tenant admin phone); telegram-linked admins route via channelSender. Manual payment URL is appended to the text body on BOTH channels (never a wa.me link)." },
  // === END W45 money-ledger ===
  // === W46 uc-money (Coder C): auctions + tips + donations + amendments (additive; J246 subset semantics) ===
  { id: "auction_status",    description: "Auction lifecycle: outbid notice, winner invoice link, loser/reserve close notices", telegram: "full", notes: "Plain-text notices via notifyCustomer (WA text / TG channelSender); the winner's invoice URL rides the payment_link adapter (TG URL inline button, never wa.me). BID commands arrive via the shared nlp engine on both channels." },
  { id: "tip_prompt",        description: "Tip prompt at checkout + tip confirmation", telegram: "full", notes: "Prompt line rendered inside the shared nlp order summary (buildOrderSummary) on BOTH channels when tenant settings.tipping.enabled; TIP <amount> command handled by the shared nlp engine; tip rides the order total through the existing escrow hold/release unchanged." },
  { id: "donation_link",     description: "Open-amount/donation buyer-entered amount checkout link", telegram: "full", notes: "Checkout URL rides the payment_link adapter (TG URL inline button, never wa.me); DONATE <amount> TO <product> command handled by the shared nlp engine on both channels; min-amount guard in donations.openAmountOk." },
  { id: "order_amendment",   description: "Pre-confirmation order amendment: delta payment link / refund notice", telegram: "full", notes: "Delta URL rides the payment_link adapter; refund notices are plain text via notifyCustomer; amendments recompute in integer minor units via shared/escrowAmounts and write order_amendments + audit rows." },
  // === END W46 uc-money ===
  // === W46 uc-docs (Coder D): statements / proformas / agent commissions (additive; J246 subset semantics) ===
  { id: "customer_statement",  description: "UC-12 per-customer statement of account document", telegram: "full", notes: "PDF chat document: telegram sendDocument via channelSender media (buffer upload); WA document push via the existing waSender media path (link) — same as the annual_statement category." },
  { id: "proforma_invoice",    description: "UC-19 proforma invoice / quotation document", telegram: "full", notes: "PDF chat document on both channels via ucDocsPdf.sendChatDocument (notifyCustomer media route → telegram sendDocument; waSender document fallback). Convert-to-order confirm rides plain-text/keyboard notices." },
  { id: "agent_commission",    description: "UC-20 agent commission statement document + payout notice", telegram: "full", notes: "PDF chat document to the agent's phone on both channels via ucDocsPdf.sendChatDocument; payout rides the customer-wallet rail (creditWallet 'agent_commission') with a plain-text paid notice." },
  // === W47 stakeholders === ONB-S-16: secondary-role status notices ===
  { id: "staff_membership",    description: "Staff invite/add/remove + rider approval notices to secondary stakeholders", telegram: "full", notes: "Plain-text notices via sendCustomerText on BOTH channels; phone-bound invite acceptance and rider updates use phone_identity proofs." },
  // === END W47 stakeholders ===
  // === END W46 uc-docs ===
  // === W46 uc-ux (Coder E): UC-17/21/23/24 (additive; J246 subset semantics) ===
  { id: "venue_order",        description: "Venue-table QR order notices (kitchen board confirmation to buyer)", telegram: "full", notes: "TABLE:<token> deep-link grammar is identical on both channels via the shared nlp engine; notices via sendCustomerText." },
  { id: "delivery_slot",      description: "Delivery slot picker + slot-booked confirmation", telegram: "full", notes: "Slot picker list + confirmation via the shared nlp engine / sendCustomerText; SLOT <n> grammar identical on both channels." },
  { id: "price_drop_alert",   description: "Wishlist price-drop alert", telegram: "full", notes: "Plain-text alert via sendCustomerText from wishlists.sweepWishlistPriceDrops; telegram always free-form (no session window), WA keeps the existing window behavior." },
  { id: "gift_order",         description: "Gift recipient notice (prices hidden) + gift checkout annotation", telegram: "full", notes: "Recipient gift receipt via sendCustomerText with prices suppressed (giftOrders.renderGiftReceipt); buyer's own receipt unchanged." },
  // === END W46 uc-ux ===
  // === W46 inventory-depth (ORD-21): batch expiry admin alert (additive; J246 subset semantics) ===
  { id: "inventory_alert",    description: "Inventory expiry sweep alert: expired/expiring-soon batches to the tenant admin", telegram: "full", notes: "Plain-text alert via sendCustomerText from inventoryDepth.sweepExpiringBatches (cron /api/scheduled/inventory-expiry-sweep + merchant-triggered runExpirySweep); identical body on both channels, telegram-linked admins route via channelSender." },
  // === END W46 inventory-depth ===
  // === W46 orders-p2 (Coder G): recall + merge notices (additive; J246 subset semantics) ===
  { id: "recall_notice",       description: "Product recall notice to affected buyers (ORD-22 targeted broadcast)", telegram: "full", notes: "Plain-text safety notice via notifyCustomer from recalls.dispatchRecall; opt-outs are NEVER sent (consent withdrawn/absent) and durably logged as recall_recipients status='skipped_opt_out'. Identical body on both channels." },
  { id: "order_merge",         description: "Order-merge notice to the buyer (ORD-23)", telegram: "full", notes: "Plain-text notice via sendCustomerText from orderMerge.mergeOrders after two pre-ship orders combine into one shipment; identical body on both channels." },
  // === END W46 orders-p2 ===
  // === W46 privacy-consent (Coder B): age attestation + consent prompts (additive; J246 subset semantics) ===
  { id: "age_attestation",     description: "Age-restricted checkout attestation prompt (TEN-15) — 'confirm you are N+' reply request", telegram: "full", notes: "Plain-text prompt rendered by buildAgeAttestationPrompt inside the SHARED nlp checkout flow (createChatOrder); both channels route through the same engine and the buyer's affirmative reply is parsed identically (AGE_AFFIRM_RE) — no channel-specific affordance." },
  { id: "kyb_sla",             description: "KYB review-queue SLA breach/escalation notice to the tenant admin (TEN-22)", telegram: "full", notes: "Plain-text notice via sendAdminOpsAlert → waSender on WA; telegram-linked admins route via the ops_alert category seam. Log-only when no admin phone is configured (unchanged ops_alert doctrine)." },
  // === END W46 privacy-consent ===
] as const;

export const PARITY_CATEGORY_IDS: readonly string[] = PARITY_CATEGORIES.map((c) => c.id);

export function getParityCategory(id: string): ParityCategory | undefined {
  return PARITY_CATEGORIES.find((c) => c.id === id);
}

// ─── Customer reference + channel resolution ─────────────────────────────────

/**
 * A customer reference as seen by callers. Most legacy callers only have an
 * E.164 phone; telegram-native conversations carry channel/channelScopedId
 * (chat_id) or a `telegram:<chat_id>` session key.
 */
export type CustomerRef =
  | string
  | {
      phone?: string | null;
      channel?: string | null;
      channelScopedId?: string | null;
    };

export interface ResolvedRoute {
  channel: Channel;
  /** Recipient address on that channel: E.164 digits for WA, chat_id for telegram. */
  to: string;
  /** True when the telegram route came from an explicit conversation/ref (not a phone→identity lookup). */
  explicit: boolean;
}

/** Normalize a raw ref string: `telegram:<chat_id>` stays; phones are digit-normalized. */
export function normalizeRefString(ref: string): { phone?: string; chatId?: string } {
  const v = String(ref).trim();
  if (/^telegram:/i.test(v)) return { chatId: v.replace(/^telegram:/i, "") };
  return { phone: v.replace(/^\+/, "") };
}

/**
 * Resolve which channel a customer is reachable on. Fail-open to WhatsApp —
 * a resolution failure must NEVER change existing WA behavior.
 *
 * Order:
 *   1. Explicit telegram ref (conversation channel / `telegram:` session key).
 *   2. Reverse identity lookup: telegram_identities.phone_e164 → chat_id
 *      (table is created by migration 0118; absent table → WA, no throw).
 *   3. Default: WhatsApp.
 */
export async function resolveCustomerChannel(tenantId: string, ref: CustomerRef): Promise<ResolvedRoute> {
  let channel: string | null | undefined;
  let channelScopedId: string | null | undefined;
  let phone: string | null | undefined;
  if (typeof ref === "string") {
    const n = normalizeRefString(ref);
    channel = n.chatId ? TELEGRAM_CHANNEL : null;
    channelScopedId = n.chatId ?? null;
    phone = n.phone ?? null;
  } else {
    channel = ref.channel;
    channelScopedId = ref.channelScopedId;
    phone = ref.phone;
  }

  if (channel === TELEGRAM_CHANNEL) {
    const chatId = (channelScopedId ?? "").replace(/^telegram:/i, "");
    if (chatId) return { channel: TELEGRAM_CHANNEL, to: chatId, explicit: true };
  }
  if (phone) {
    try {
      const db = await getDb();
      if (db) {
        const rows = (await db.execute(
          sql`select chat_id from telegram_identities where tenant_id = ${tenantId} and phone_e164 = ${phone.replace(/\D/g, "")} limit 1`,
        )) as any;
        const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
        const chatId = list[0]?.chat_id ?? list[0]?.chatId;
        if (chatId) {
          return { channel: TELEGRAM_CHANNEL, to: String(chatId), explicit: false };
        }
      }
    } catch (e: any) {
      // Fail-open: table missing (pre-0118) or db down → stay on WhatsApp.
      console.warn("[channelParity] telegram identity lookup failed (falling back to WA):", e?.message);
    }
    return { channel: WHATSAPP_CHANNEL, to: phone.replace(/^\+/, ""), explicit: false };
  }

  // No usable address at all — report WA so callers take their existing
  // "no phone" branch.
  return { channel: WHATSAPP_CHANNEL, to: "", explicit: false };
}

// ─── Payload types + category adapters ───────────────────────────────────────

export interface ChannelButton {
  /** Callback id using the EXISTING grammar (menu_<n>, order_*, catalog_ai:*). */
  id?: string;
  label: string;
  /** URL button (telegram inline keyboard) — used for payment links. */
  url?: string;
}

export interface NotifyPayload {
  text: string;
  notifType?: string;
  orderId?: string;
  buttons?: ChannelButton[];
  /** Payment-link category: PSP checkout URL + the legacy wa.me callback. */
  paymentUrl?: string;
  waMeUrl?: string;
  /** Media (annual statement doc, product images). */
  media?: { type: "photo" | "document" | "voice"; url?: string; buffer?: Buffer; caption?: string; filename?: string };
}

/**
 * Adapt a category payload for the target channel. WA is byte-equivalent
 * (returned untouched); telegram gets honest degrade:
 *   - payment_link → URL inline-button, wa.me stripped from text.
 *   - templates (order_status etc.) → plain formatted text.
 */
export function adaptForChannel(category: string, channel: Channel, payload: NotifyPayload): NotifyPayload {
  if (channel !== TELEGRAM_CHANNEL) return payload;
  const out: NotifyPayload = { ...payload, buttons: payload.buttons ? [...payload.buttons] : undefined };
  if (category === "payment_link") {
    const url = payload.paymentUrl ?? payload.waMeUrl ?? "";
    // Strip WA-specific deep links from the text body — telegram customers
    // tap the URL button instead of being bounced into WhatsApp.
    out.text = out.text.replace(/https?:\/\/wa\.me\/\S+/g, "").trim();
    if (url && !url.includes("wa.me")) {
      out.buttons = [...(out.buttons ?? []), { label: "💳 Pay now", url }];
    } else if (payload.paymentUrl) {
      out.buttons = [...(out.buttons ?? []), { label: "💳 Pay now", url: payload.paymentUrl }];
    }
  }
  return out;
}

/** Telegram inline-keyboard payload shape (mirrors Bot API inline_keyboard). */
export function toTelegramInlineKeyboard(buttons: ChannelButton[]): Array<Array<{ text: string; callback_data?: string; url?: string }>> {
  return buttons.map((b) => [
    b.url ? { text: b.label, url: b.url } : { text: b.label, callback_data: b.id ?? b.label },
  ]);
}

// === W37 merger ===
/**
 * Map an adapted NotifyPayload onto Coder A's real ChannelMessagePayload
 * union (channelSender.ts): media → media kind; buttons → keyboard kind
 * (ChannelButton{id,label,url} → {id,title,url}, callback id grammar
 * preserved verbatim, URL buttons kept as URL buttons); else plain text.
 */
export function toChannelMessagePayload(
  adapted: NotifyPayload,
  notifType: string,
): { payload: import("./channelSender").ChannelMessagePayload; notifType: string } {
  if (adapted.media) {
    const m = adapted.media;
    return {
      notifType,
      payload: {
        kind: "media",
        media: {
          type: m.type,
          ...(m.url ? { link: m.url } : {}),
          ...(m.buffer ? { buffer: m.buffer } : {}),
          ...(m.caption ? { caption: m.caption } : {}),
          ...(m.filename ? { filename: m.filename } : {}),
        },
      },
    };
  }
  if (adapted.buttons?.length) {
    return {
      notifType,
      payload: {
        kind: "keyboard",
        text: adapted.text,
        buttons: adapted.buttons.map((b) => ({
          id: b.id ?? b.label,
          title: b.label,
          ...(b.url ? { url: b.url } : {}),
        })),
      },
    };
  }
  return { notifType, payload: { kind: "text", text: adapted.text } };
}
// === END W37 merger ===

/**
 * Render an order confirmation/status notification as formatted text — the
 * telegram representation of the WA template ({{1}} name, {{2}} order number,
 * {{3}} amount+currency, {{4}} status label). Used by the
 * whatsappNotifications seam so both channels carry the SAME semantic
 * content (J240).
 */
export function renderOrderStatusText(p: {
  customerName?: string;
  orderNumber: string;
  totalAmount: string;
  currency: string;
  statusLabel: string;
}): string {
  return (
    `Hi ${p.customerName || "Customer"} — your order ${p.orderNumber} ` +
    `(${p.totalAmount} ${p.currency}) is now *${p.statusLabel}*.`
  );
}

// ─── notifyCustomer: the routing entry point ─────────────────────────────────

/** Test hook: inject a fake channelSender (journeys assert routed payloads). */
let __channelSenderOverride:
  | ((tenantId: string, channel: string, to: string, payload: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>)
  | null = null;
export function __setChannelSenderForTests(
  fn: ((tenantId: string, channel: string, to: string, payload: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>) | null,
): void {
  __channelSenderOverride = fn;
}

export interface NotifyResult {
  /** true when this module delivered (or attempted) the message — caller must NOT continue its WA path. */
  handled: boolean;
  channel: Channel;
  sent?: boolean;
  simulated?: boolean;
  error?: string;
}

/**
 * Route a customer notification by category. Telegram-capable customers are
 * delivered via the channelSender facade; WhatsApp customers get
 * { handled:false, channel:"whatsapp" } so the caller's existing WA code path
 * runs byte-for-byte unchanged. Never throws.
 */
export async function notifyCustomer(
  tenantId: string,
  ref: CustomerRef,
  category: string,
  payload: NotifyPayload,
): Promise<NotifyResult> {
  let route: ResolvedRoute;
  try {
    route = await resolveCustomerChannel(tenantId, ref);
  } catch (e: any) {
    console.warn("[channelParity] resolve failed, staying on WA:", e?.message);
    return { handled: false, channel: WHATSAPP_CHANNEL };
  }
  if (route.channel !== TELEGRAM_CHANNEL || !route.to) {
    return { handled: false, channel: WHATSAPP_CHANNEL };
  }
  try {
    const adapted = adaptForChannel(category, TELEGRAM_CHANNEL, payload);
    const sendChannelMessage =
      __channelSenderOverride ?? (await import("./channelSender")).sendChannelMessage;
    // === W37 merger === C was written against the stub facade; map the
    // adapted payload onto Coder A's REAL ChannelMessagePayload union
    // (mechanical: text / keyboard{ id,title,url } / media). notifType and
    // orderId travel via sendChannelMessage opts where supported.
    const { payload: channelPayload, notifType } = toChannelMessagePayload(adapted, payload.notifType ?? category);
    const res: any = await sendChannelMessage(tenantId, TELEGRAM_CHANNEL, route.to, channelPayload, { notifType, orderId: payload.orderId ?? null });
    // === END W37 merger ===
    return {
      handled: true,
      channel: TELEGRAM_CHANNEL,
      sent: res?.sent === true,
      simulated: res?.simulated === true,
    };
  } catch (e: any) {
    // Fail-open: a telegram send failure is logged, never thrown into the
    // business flow. We still report handled:true — falling back to WA would
    // message a number the telegram-linked customer may not monitor.
    console.warn(`[channelParity] telegram ${category} notify failed:`, e?.message);
    return { handled: true, channel: TELEGRAM_CHANNEL, sent: false, error: e?.message ?? String(e) };
  }
}

/**
 * One-line mechanical replacement for sendWhatsAppText in migrated callers:
 *
 *   await sendCustomerText(tenantId, phone, body, { notifType: "..." });
 *
 * WA recipients hit the ORIGINAL waSender.sendWhatsAppText with identical
 * args (byte-equivalent); telegram recipients route through channelSender.
 */
export async function sendCustomerText(
  tenantId: string,
  ref: CustomerRef,
  category: string,
  text: string,
  waOpts?: Record<string, unknown>,
): Promise<{ channel: Channel; result: unknown }> {
  const routed = await notifyCustomer(tenantId, ref, category, { text, notifType: waOpts?.notifType as string | undefined });
  if (routed.handled) {
    return { channel: TELEGRAM_CHANNEL, result: routed };
  }
  const phone = typeof ref === "string" ? (normalizeRefString(ref).phone ?? ref) : (ref.phone ?? "");
  const { sendWhatsAppText } = await import("./waSender");
  const result = await sendWhatsAppText(tenantId, phone, text, waOpts as any);
  return { channel: WHATSAPP_CHANNEL, result };
}

// ─── Broadcast throttle (Bot API ~30 msg/s fair-use) ─────────────────────────

/**
 * A pacer for telegram broadcast fan-out: awaits between sends so the rate
 * stays ≤ TELEGRAM_BROADCAST_RATE_PER_SEC. WA pacing (frequencyCap/waQuality)
 * is untouched.
 */
export function createTelegramBroadcastPacer(nowImpl: () => number = () => Date.now()): { waitForSlot: () => Promise<void> } {
  let lastSendAt = 0;
  return {
    async waitForSlot() {
      const now = nowImpl();
      const wait = lastSendAt + TELEGRAM_BROADCAST_MIN_INTERVAL_MS - now;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastSendAt = nowImpl();
    },
  };
}
