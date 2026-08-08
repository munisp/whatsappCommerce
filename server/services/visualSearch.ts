/**
 * server/services/visualSearch.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Visual product search: buyer sends a photo of something they want; the
 * vision LLM describes the item; the description is matched against the
 * tenant catalog (same matchCatalogItem confidence logic as text NLP cart);
 * the top match is returned as a product card with a BUY shortcut.
 *
 * Runs ONLY for inbound images the receipt-verification pipeline did not
 * claim (no pending unpaid order) — the webhook chains this after
 * handleInboundReceiptImage returns outcome "no_pending_order".
 *
 * Feature flag: tenants.settings.visualSearch.enabled (default true).
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { products, tenants } from "../../drizzle/schema";
import { invokeLLM } from "../_core/llm";
import { matchCatalogItem, type CatalogProduct } from "./nlpCart";
import { resolveTenantWaCredentials, sendWhatsAppMedia, sendWhatsAppText } from "./waSender";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Gate used by the webhook media branch: run visual search ONLY when the
 * receipt-verification pipeline did not claim the image (no pending unpaid
 * order). A receipt screenshot for a real order is never double-handled.
 */
export function shouldRunVisualSearchAfterReceipt(
  outcome: { handled: boolean; outcome?: string } | null | undefined,
): boolean {
  return !!outcome?.handled && outcome.outcome === "no_pending_order";
}

export interface VisualSearchOutcome {
  handled: boolean;
  matched?: boolean;
  productId?: string;
  reason?: string;
}

/** settings.visualSearch.enabled — default true. */
export async function isVisualSearchEnabled(db: Db, tenantId: string): Promise<boolean> {
  const [tenant] = await db.select({ settings: tenants.settings }).from(tenants)
    .where(eq(tenants.id, tenantId)).limit(1)
    .catch(() => []);
  const flag = ((tenant?.settings as any)?.visualSearch ?? {}) as { enabled?: boolean };
  return flag.enabled !== false;
}

/** Download a WhatsApp media object base64 (same Graph pattern as receipts). */
async function downloadWaMedia(tenantId: string, mediaId: string): Promise<{ base64: string; mimeType: string } | null> {
  const creds = await resolveTenantWaCredentials(tenantId);
  if (!creds) return null;
  const meta = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(12000),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const url = meta?.url;
  if (!url) return null;
  const bin = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(20000),
  }).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  if (!bin) return null;
  return {
    base64: Buffer.from(bin).toString("base64"),
    mimeType: typeof meta?.mime_type === "string" ? meta.mime_type : "image/jpeg",
  };
}

/** Describe the item in the photo with the vision LLM (receiptVision pattern). */
export async function describeProductImage(
  imageBase64: string,
  mimeType: string,
): Promise<{ itemName: string; description: string }> {
  const dataUrl = `data:${mimeType};base64,${imageBase64}`;
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content:
          "You are a product recognition assistant for a commerce catalog. " +
          "Identify the main product in the image with a short generic name " +
          "(e.g. 'red sneakers', 'Ankara fabric', 'rice bag 5kg') that would " +
          "match a store catalog entry. Always respond with valid JSON only.",
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          {
            type: "text",
            text: 'What product is this? Respond with JSON: {"itemName": "short generic product name", "description": "one sentence"}',
          },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "visual_product_search",
        strict: true,
        schema: {
          type: "object",
          properties: {
            itemName: { type: "string" },
            description: { type: "string" },
          },
          required: ["itemName", "description"],
          additionalProperties: false,
        },
      },
    },
  });
  const content: any = response?.choices?.[0]?.message?.content;
  const parsed = typeof content === "string" ? JSON.parse(content) : content;
  return {
    itemName: String(parsed?.itemName ?? "").trim(),
    description: String(parsed?.description ?? "").trim(),
  };
}

const fmtPrice = (price: string, currency: string) =>
  `${currency} ${Number(price).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

/**
 * Full pipeline for one inbound image. Fire-and-forget from the webhook;
 * never throws.
 */
export async function handleInboundProductImage(opts: {
  tenantId: string;
  waPhoneNumber: string;
  mediaId: string;
}): Promise<VisualSearchOutcome> {
  try {
    const db = await getDb();
    if (!db) return { handled: false, reason: "db-unavailable" };
    const { tenantId, waPhoneNumber } = opts;

    if (!(await isVisualSearchEnabled(db, tenantId))) {
      return { handled: false, reason: "disabled" };
    }

    const media = await downloadWaMedia(tenantId, opts.mediaId);
    if (!media) return { handled: false, reason: "download-failed" };

    let described: { itemName: string; description: string };
    try {
      described = await describeProductImage(media.base64, media.mimeType);
    } catch (e: any) {
      console.error("[visualSearch] vision call failed:", e?.message);
      return { handled: false, reason: "vision-failed" };
    }
    if (!described.itemName) return { handled: false, reason: "vision-empty" };

    const catalog: Array<CatalogProduct & { imageUrl?: string | null; description?: string | null }> =
      await db.select({
        id: products.id,
        name: products.name,
        price: products.price,
        currency: products.currency,
        stockQuantity: products.stockQuantity,
        imageUrl: products.imageUrl,
        description: products.description,
      }).from(products).where(eq(products.tenantId, tenantId)).limit(500);

    const match = matchCatalogItem(catalog, described.itemName);
    if (match.status === "matched") {
      const p = match.product as CatalogProduct & { imageUrl?: string | null };
      const caption =
        `🔎 That looks like *${p.name}* — ${fmtPrice(p.price, p.currency)}.\n` +
        (p.stockQuantity > 0
          ? `Reply *BUY ${p.name}* to order it.`
          : `It's currently out of stock — reply *NOTIFY ME ${p.name}* and I'll alert you when it's back.`);
      if (p.imageUrl) {
        await sendWhatsAppMedia(tenantId, waPhoneNumber, { type: "image", link: p.imageUrl, caption }, { notifType: "visual_search" });
      } else {
        await sendWhatsAppText(tenantId, waPhoneNumber, caption, { notifType: "visual_search" });
      }
      return { handled: true, matched: true, productId: p.id };
    }

    // No confident match → polite fallback with a mini menu.
    const top = catalog.filter((p) => p.stockQuantity > 0).slice(0, 5);
    const menu = top.length
      ? top.map((p) => `• ${p.name} — ${fmtPrice(p.price, p.currency)}`).join("\n")
      : "Our catalog is being updated — please check back soon.";
    await sendWhatsAppText(
      tenantId,
      waPhoneNumber,
      `🤔 I couldn't find that exact item in our catalog. Here's a look at our menu:\n${menu}\n\nReply with the name of what you'd like to order.`,
      { notifType: "visual_search" },
    );
    return { handled: true, matched: false };
  } catch (e: any) {
    console.error("[visualSearch] pipeline error:", e?.message);
    return { handled: false, reason: "error" };
  }
}
