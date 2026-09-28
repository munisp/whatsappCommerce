// === W49 RICHMEDIA ===
/**
 * W49 rich-media chat helpers (RICH-3/1/2/7/9/12/6).
 *
 * Central pieces:
 *   - publicMediaUrl(): Meta's Graph API (and Telegram's by-URL media) require
 *     ABSOLUTE https links, but storagePut() persists app-relative
 *     `/api/storage/<key>` URLs into products.imageUrl (RICH-3). This helper
 *     prefixes the configured public base (env PUBLIC_APP_URL, falling back
 *     to APP_URL) so tenant-uploaded images actually render in chat.
 *     Fail-open: returns null when no public base is configured so callers
 *     skip the media instead of pushing a guaranteed-400 link.
 *   - Product card senders (image-header interactive on WA; photo+keyboard
 *     on TG) with a uniform no-image fallback card (RICH-1/RICH-12).
 *   - Payment CTA senders (WA cta_url interactive; TG URL button) (RICH-7).
 *   - Welcome banner senders using the tenant logo (RICH-9).
 *   - Order receipt PDF delivery over both channels via the W46 ucDocsPdf
 *     pipeline (RICH-6).
 *
 * All senders are fail-open (callers .catch / we never throw into money
 * paths) and channel-parity complete: every WA helper has a TG twin.
 */
import { ENV } from "../_core/env";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

// ── RICH-3: absolute media URLs ─────────────────────────────────────────────

/** Configured public base URL of this app (no trailing slash), or null. */
export function publicAppBase(): string | null {
  const raw = (process.env.PUBLIC_APP_URL ?? ENV.publicAppUrl ?? "").trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

/**
 * Normalize a stored media URL for external (Meta/Telegram) consumption.
 *   - absolute http(s) → returned verbatim;
 *   - app-relative (`/api/storage/…`, `/api/uc-docs/…`) → prefixed with the
 *     public base;
 *   - anything else (data:, empty, no base configured) → null (skip media).
 */
export function publicMediaUrl(url: string | null | undefined): string | null {
  const u = (url ?? "").trim();
  if (!u) return null;
  if (/^https:\/\//i.test(u)) return u;
  // Meta rejects plain http except localhost dev; keep http only for local.
  if (/^http:\/\//i.test(u)) return u;
  if (!u.startsWith("/")) return null;
  const base = publicAppBase();
  return base ? `${base}${u}` : null;
}

// ── RICH-1/RICH-12: product card (image header + action buttons) ────────────

export interface ProductCardInput {
  productId: string;
  name: string;
  /** Pre-formatted price line, e.g. "₦4,500". */
  priceText?: string | null;
  /** Stored image URL (relative OK — absolutized here). */
  imageUrl?: string | null;
  /** Optional brand fallback image when the product has none (RICH-12). */
  fallbackImageUrl?: string | null;
}

export const PRODUCT_CARD_ADD_TO_CART_PREFIX = "cart_add:";
export const PRODUCT_CARD_BUY_NOW_PREFIX = "buy_now:";

function productCardButtons(productId: string) {
  return [
    { id: `${PRODUCT_CARD_ADD_TO_CART_PREFIX}${productId}`, title: "🛒 Add to cart" },
    { id: `${PRODUCT_CARD_BUY_NOW_PREFIX}${productId}`, title: "⚡ Buy now" },
  ];
}

function productCardBody(card: ProductCardInput): string {
  return card.priceText?.trim() ? `${card.name}\n${card.priceText.trim()}` : card.name;
}

/**
 * WhatsApp: ONE interactive message — image header + name/price body +
 * [Add to cart][Buy now] reply buttons. No image (or no public base) → the
 * same card with a text header so the UX is uniform (RICH-12).
 */
export async function sendWhatsAppProductCard(
  tenantId: string,
  toPhone: string,
  card: ProductCardInput,
): Promise<void> {
  const { sendWhatsAppInteractive } = await import("./waSender");
  const link = publicMediaUrl(card.imageUrl) ?? publicMediaUrl(card.fallbackImageUrl);
  // RICH-11: prefer a cached Meta media id (no per-send refetch); fail-open
  // to the link form.
  let headerImage: { link: string } | { mediaId: string } | null = null;
  if (link) {
    const { getOrUploadWaMediaId } = await import("./waMediaCache");
    const mediaId = await getOrUploadWaMediaId(tenantId, link).catch(() => null);
    headerImage = mediaId ? { mediaId } : { link };
  }
  await sendWhatsAppInteractive(tenantId, toPhone, {
    ...(headerImage ? { headerImage } : { headerText: card.name }),
    bodyText: productCardBody(card),
    action: { type: "button", buttons: productCardButtons(card.productId) },
  }, { notifType: "product_card" });
}

/**
 * Telegram parity: ONE sendPhoto with the caption and the same buttons as an
 * inline keyboard (telegramSender.sendTelegramMedia accepts replyMarkup).
 * No image → keyboard message with the same body (uniform card, RICH-12).
 */
export async function sendTelegramProductCard(
  tenantId: string,
  chatId: string,
  card: ProductCardInput,
): Promise<void> {
  const { sendTelegramMedia, sendTelegramKeyboard } = await import("./telegramSender");
  const link = publicMediaUrl(card.imageUrl) ?? publicMediaUrl(card.fallbackImageUrl);
  const buttons = productCardButtons(card.productId);
  if (link) {
    await sendTelegramMedia(tenantId, chatId, {
      type: "photo",
      url: link,
      caption: productCardBody(card),
    }, { notifType: "product_card", replyMarkup: buttons });
  } else {
    await sendTelegramKeyboard(tenantId, chatId, productCardBody(card), buttons, { notifType: "product_card" });
  }
}

// ── RICH-7: payment CTA (WA cta_url button / TG URL button) ────────────────

export interface PaymentCtaInput {
  url: string;
  orderNumber?: string | null;
  amountText?: string | null;
}

function paymentCtaBody(p: PaymentCtaInput): string {
  const head = p.orderNumber ? `Order ${p.orderNumber}` : "Your order";
  const amt = p.amountText?.trim() ? ` — ${p.amountText.trim()}` : "";
  return `💳 ${head}${amt} is awaiting payment. Tap below to pay securely.`;
}

/** WhatsApp: interactive cta_url button ("Pay now") instead of raw URL text. */
export async function sendWhatsAppPaymentCta(
  tenantId: string,
  toPhone: string,
  p: PaymentCtaInput,
): Promise<void> {
  const { sendWhatsAppInteractive } = await import("./waSender");
  await sendWhatsAppInteractive(tenantId, toPhone, {
    bodyText: paymentCtaBody(p),
    action: { type: "cta_url", displayText: "Pay now", url: p.url },
  }, { notifType: "payment_cta" });
}

/** Telegram parity: inline URL button (TG has always had these). */
export async function sendTelegramPaymentCta(
  tenantId: string,
  chatId: string,
  p: PaymentCtaInput,
): Promise<void> {
  const { sendTelegramKeyboard } = await import("./telegramSender");
  await sendTelegramKeyboard(tenantId, chatId, paymentCtaBody(p), [
    { id: p.url, title: "💳 Pay now", url: p.url },
  ], { notifType: "payment_cta" });
}

// ── RICH-9: welcome banner with tenant logo ─────────────────────────────────

/**
 * Resolve the tenant's chat-banner logo: tenants.settings.branding/logoUrl
 * first (an /api/storage tenant-branding URL is fine — that namespace is
 * publicly servable since W49), then the newest mediaAssets row with a
 * stored (non-data:) URL in meta. Returns an ABSOLUTE url or null.
 */
export async function resolveTenantLogoUrl(db: Db, tenantId: string): Promise<string | null> {
  try {
    const { tenants, mediaAssets } = await import("../../drizzle/schema");
    const { eq, desc } = await import("drizzle-orm");
    const [t] = await db.select({ settings: tenants.settings }).from(tenants)
      .where(eq(tenants.id, tenantId)).limit(1).catch(() => [] as any[]);
    const settings = (t?.settings ?? {}) as Record<string, any>;
    const candidates = [
      settings?.branding?.logoUrl,
      settings?.logoUrl,
      settings?.brand?.logoUrl,
    ];
    for (const c of candidates) {
      const abs = publicMediaUrl(typeof c === "string" ? c : null);
      if (abs) return abs;
    }
    const [asset] = await db.select({ meta: mediaAssets.meta }).from(mediaAssets)
      .where(eq(mediaAssets.tenantId, tenantId))
      .orderBy(desc(mediaAssets.createdAt)).limit(5)
      .catch(() => [] as any[]);
    const metaUrl = (asset?.meta as any)?.url ?? (asset?.meta as any)?.logoUrl ?? null;
    return publicMediaUrl(typeof metaUrl === "string" ? metaUrl : null);
  } catch {
    return null; // fail-open: banner is cosmetic
  }
}

/** WhatsApp welcome: logo image + greeting caption (falls back to nothing — caller still sends its text menu). */
export async function sendWhatsAppWelcomeBanner(
  tenantId: string,
  toPhone: string,
  greeting: string,
): Promise<boolean> {
  try {
    const { getDb } = await import("../db");
    const db = await getDb();
    const logo = db ? await resolveTenantLogoUrl(db, tenantId) : null;
    if (!logo) return false;
    const { sendWhatsAppMedia } = await import("./waSender");
    await sendWhatsAppMedia(tenantId, toPhone, { type: "image", link: logo, caption: greeting }, { notifType: "welcome_banner" });
    return true;
  } catch {
    return false;
  }
}

/** Telegram welcome parity: sendPhoto with the greeting caption. */
export async function sendTelegramWelcomeBanner(
  tenantId: string,
  chatId: string,
  greeting: string,
): Promise<boolean> {
  try {
    const { getDb } = await import("../db");
    const db = await getDb();
    const logo = db ? await resolveTenantLogoUrl(db, tenantId) : null;
    if (!logo) return false;
    const { sendTelegramMedia } = await import("./telegramSender");
    await sendTelegramMedia(tenantId, chatId, { type: "photo", url: logo, caption: greeting }, { notifType: "welcome_banner" });
    return true;
  } catch {
    return false;
  }
}

// ── RICH-6: order receipt PDF via the W46 ucDocsPdf pipeline ────────────────

export interface ReceiptPdfLineInput {
  businessName: string;
  orderNumber: string;
  lines: string[];
}

/**
 * Generate a minimal order-receipt PDF and deliver it as a chat document on
 * BOTH channels (WA: document by absolute public link; TG: multipart
 * sendDocument) through the existing sendChatDocument router. Fail-open:
 * returns false instead of throwing so the money path is never affected.
 */
export async function sendOrderReceiptPdf(
  tenantId: string,
  phone: string,
  input: ReceiptPdfLineInput,
): Promise<boolean> {
  try {
    const { linesToPdf, writeDocPdf, sendChatDocument } = await import("./ucDocsPdf");
    const pdf = linesToPdf({
      title: `Receipt — ${input.businessName}`,
      lines: [
        `Order: ${input.orderNumber}`,
        "",
        ...input.lines,
        "",
        "Thank you for shopping with us.",
      ],
    });
    const rel = `receipts/${tenantId}/receipt-${input.orderNumber}.pdf`;
    writeDocPdf(rel, pdf);
    const res = await sendChatDocument(tenantId, phone, {
      relPath: rel,
      filename: `receipt-${input.orderNumber}.pdf`,
      caption: `🧾 Receipt for order ${input.orderNumber}`,
      notifType: "order_receipt_pdf",
      category: "order_receipt",
    });
    return res.sent || res.simulated;
  } catch (e: any) {
    console.warn("[richMedia] receipt PDF delivery failed (fail-open):", e?.message);
    return false;
  }
}

// ── RICH-4/RICH-5: browse results (WA product_list / TG album) ──────────────

export interface BrowseProduct {
  id: string;
  name: string;
  priceText: string;
  imageUrl?: string | null;
}

/**
 * WhatsApp browse: when the tenant has a synced Meta catalog, send ONE
 * product_list interactive (per-product images rendered by Meta from the
 * catalog — RICH-4). Otherwise fall back to the existing ≤10-row list.
 * Returns true when a product_list was sent.
 */
export async function sendWhatsAppBrowseProducts(
  tenantId: string,
  toPhone: string,
  items: BrowseProduct[],
): Promise<boolean> {
  if (!items.length) return false;
  try {
    const { getDb } = await import("../db");
    const db = await getDb();
    if (!db) return false;
    const { getMetaCatalogConfig } = await import("./metaCatalog");
    const cfg = await getMetaCatalogConfig(db, tenantId);
    if (!cfg?.catalogId) return false;
    const { sendWhatsAppProductList } = await import("./waSender");
    await sendWhatsAppProductList(tenantId, toPhone, {
      catalogId: cfg.catalogId,
      headerText: "🛍️ Browse our catalog",
      bodyText: "Tap to view these products — add any to your cart right here.",
      sections: [{ title: "Products", productRetailerIds: items.slice(0, 10).map((p) => p.id) }],
    }, { notifType: "browse_product_list" });
    return true;
  } catch (e: any) {
    console.warn("[richMedia] product_list send failed (falling back to text):", e?.message);
    return false;
  }
}

/**
 * Telegram browse parity (RICH-5): top items WITH absolute image URLs as a
 * sendMediaGroup album (2..10 items). Returns false when fewer than 2 items
 * have usable images (caller then sends the plain keyboard list).
 */
export async function sendTelegramBrowseAlbum(
  tenantId: string,
  chatId: string,
  items: BrowseProduct[],
): Promise<boolean> {
  const withImages = items
    .map((p) => ({ p, url: publicMediaUrl(p.imageUrl) }))
    .filter((x): x is { p: BrowseProduct; url: string } => !!x.url)
    .slice(0, 10);
  if (withImages.length < 2) return false;
  try {
    const { sendTelegramMediaGroup } = await import("./telegramSender");
    await sendTelegramMediaGroup(
      tenantId,
      chatId,
      withImages.map(({ p, url }) => ({
        type: "photo" as const,
        media: url,
        caption: `${p.name} — ${p.priceText}`,
      })),
      { notifType: "browse_media_group" },
    );
    return true;
  } catch (e: any) {
    console.warn("[richMedia] TG browse album failed (fail-open):", e?.message);
    return false;
  }
}

// ── RICH-8: order status card + POD photo push (both channels) ──────────────

export interface OrderStatusCardInput {
  orderNumber: string;
  orderId: string;
  status: string;
  etaText?: string | null;
  trackingUrl?: string | null;
  /** First-item image or a status icon asset (relative OK). */
  imageUrl?: string | null;
}

function statusCardBody(s: OrderStatusCardInput): string {
  const eta = s.etaText?.trim() ? `\nETA: ${s.etaText.trim()}` : "";
  return `📦 Order ${s.orderNumber} — ${s.status}${eta}`;
}

/** WhatsApp: status update as an interactive card with [Track][Support]. */
export async function sendWhatsAppOrderStatusCard(
  tenantId: string,
  toPhone: string,
  s: OrderStatusCardInput,
): Promise<void> {
  const { sendWhatsAppInteractive } = await import("./waSender");
  const link = publicMediaUrl(s.imageUrl);
  const buttons = [
    ...(s.trackingUrl ? [] : [{ id: `order_track:${s.orderId}`, title: "📦 Track" }]),
    { id: `order_support:${s.orderId}`, title: "🙋 Support" },
  ];
  if (s.trackingUrl && /^https:\/\//.test(s.trackingUrl)) {
    // cta_url gives a real external Track button (RICH-7 mechanism).
    await sendWhatsAppInteractive(tenantId, toPhone, {
      ...(link ? { headerImage: { link } } : {}),
      bodyText: statusCardBody(s),
      action: { type: "cta_url", displayText: "Track shipment", url: s.trackingUrl },
    }, { notifType: "order_status_card", orderId: s.orderId });
    return;
  }
  await sendWhatsAppInteractive(tenantId, toPhone, {
    ...(link ? { headerImage: { link } } : {}),
    bodyText: statusCardBody(s),
    action: { type: "button", buttons },
  }, { notifType: "order_status_card", orderId: s.orderId });
}

/** Telegram parity: photo+keyboard or plain keyboard with a URL Track button. */
export async function sendTelegramOrderStatusCard(
  tenantId: string,
  chatId: string,
  s: OrderStatusCardInput,
): Promise<void> {
  const { sendTelegramMedia, sendTelegramKeyboard } = await import("./telegramSender");
  const link = publicMediaUrl(s.imageUrl);
  const buttons = [
    ...(s.trackingUrl
      ? [{ id: s.trackingUrl, title: "📦 Track", url: s.trackingUrl }]
      : [{ id: `order_track:${s.orderId}`, title: "📦 Track" }]),
    { id: `order_support:${s.orderId}`, title: "🙋 Support" },
  ];
  if (link) {
    await sendTelegramMedia(tenantId, chatId, { type: "photo", url: link, caption: statusCardBody(s) }, { notifType: "order_status_card", replyMarkup: buttons });
  } else {
    await sendTelegramKeyboard(tenantId, chatId, statusCardBody(s), buttons, { notifType: "order_status_card" });
  }
}

/**
 * Push the delivery proof-of-delivery PHOTO to the buyer on chat (the POD
 * previously lived only on the web timeline). Both channels; fail-open.
 */
export async function sendPodPhoto(
  tenantId: string,
  dest: { phone?: string; telegramChatId?: string },
  opts: { photoUrl: string; orderNumber: string },
): Promise<boolean> {
  const link = publicMediaUrl(opts.photoUrl);
  if (!link) return false;
  const caption = `✅ Delivered — proof photo for order ${opts.orderNumber}`;
  try {
    if (dest.telegramChatId) {
      const { sendTelegramMedia } = await import("./telegramSender");
      await sendTelegramMedia(tenantId, dest.telegramChatId, { type: "photo", url: link, caption }, { notifType: "pod_photo" });
      return true;
    }
    if (dest.phone) {
      const { sendWhatsAppMedia } = await import("./waSender");
      await sendWhatsAppMedia(tenantId, dest.phone, { type: "image", link, caption }, { notifType: "pod_photo" });
      return true;
    }
    return false;
  } catch (e: any) {
    console.warn("[richMedia] POD photo push failed (fail-open):", e?.message);
    return false;
  }
}
