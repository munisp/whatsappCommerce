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
