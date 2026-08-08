/**
 * NLP Buyer Conversation Engine
 * Handles natural-language WhatsApp messages in English, Yoruba, Hausa, Igbo, and Pidgin.
 * No menu required — buyers type freely and the LLM interprets intent.
 *
 * Conversation states: greeting → browse → product_detail → add_to_cart →
 *   checkout_address → checkout_confirm → payment → order_confirmed → support
 */
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import {
  nlpSessions, cartSessions, cartItems, orders, orderItems,
  customers, products, conversations, agentEvents, tenants,
} from "../../drizzle/schema";
import { paymentGatewayConfigs, paymentTransactions } from "../../drizzle/schema";
import { offlineMessageQueue } from "../../drizzle/schema";
import { tenantIntegrations } from "../../drizzle/schema";
import {
  syncOrderToMedusa,
  syncOrderToOdoo,
  syncContactToTwenty,
  pushOrderActivityToTwenty,
} from "../services/integrationSync";
import { normalizeExtractedItems, addExtractedItemsToCart } from "../services/nlpCart";
import { quoteDeliveryFee } from "../services/deliveryQuote";
import { trackingUrlFor } from "../services/trackingToken";
import {
  checkAvailability,
  reserveStock,
  InsufficientStockError,
  type StockShortage,
} from "../services/inventory";
import { matchFaq, parseFaqSettings } from "../services/faq";
import { buildReorder, buildReorderReply } from "../services/reorder";
import { raiseChatDispute, buildDisputeReply } from "../services/chatDispute";
import { touchCartMarker } from "../services/cartRecovery";
import { localeFromSessionLanguage, tr } from "../services/i18n";
import { validatePromo, applyPromo } from "../services/promos";
import { toMinorUnitsExact, minorUnitsToString } from "../../shared/escrowAmounts";

// ── Checkout message builders ────────────────────────────────────────────────
type CartLine = { productName: string; quantity: number; unitPrice: string; currency: string };

/** Format a major-unit amount with the currency symbol where we know it. */
export function fmtMoney(amount: number, currency: string): string {
  const symbols: Record<string, string> = { NGN: "₦", USD: "$", GHS: "GH₵", KES: "KSh " };
  const sym = symbols[(currency ?? "").toUpperCase()] ?? `${currency} `;
  return `${sym}${amount.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function itemizedLines(items: CartLine[]): string[] {
  return items.map(i => `${i.quantity} × ${i.productName} — ${fmtMoney(Number(i.unitPrice), i.currency)} each`);
}

/** Extract a promo code from chat text, e.g. "use code SAVE10" or "code: SAVE10". */
export function extractPromoCode(text: string): string | null {
  const m = /\b(?:use\s+)?code[:\s]+([A-Za-z0-9_-]{2,32})\b/i.exec(text);
  return m ? m[1] : null;
}

/** Buyer-facing reason a promo code was not applied. */
function promoRejectText(reason: string): string {
  switch (reason) {
    case "not_found": return "that code doesn't exist";
    case "expired": return "that code has expired";
    case "min_total": return "your cart is below the minimum for that code";
    case "max_uses": return "that code has been fully used";
    default: return "that code isn't valid";
  }
}

/** Step-1 checkout card: itemized cart + subtotal + fulfillment prompt. */
function buildFulfillmentPrompt(items: CartLine[], subtotal: number, currency: string): string {
  return [
    "🛒 *Your order*",
    ...itemizedLines(items),
    `Subtotal: ${fmtMoney(subtotal, currency)}`,
    "",
    "How would you like to receive your order?",
    "1️⃣ Pickup",
    "2️⃣ Delivery",
  ].join("\n");
}

/** Final order summary (pickup or delivery) incl. payment + tracking links. */
function buildOrderSummary(opts: {
  fulfillment: "pickup" | "delivery";
  orderNumber: string;
  items: CartLine[];
  subtotal: number;
  deliveryFee: number;
  deliveryZone?: string;
  address?: string | null;
  /** Applied promo (discount line in the summary). */
  promo?: { code: string; discount: number } | null;
  /** Set when a code was supplied but rejected (buyer-facing reason). */
  promoError?: string | null;
  total: number;
  currency: string;
  paymentUrl: string | null;
  trackingUrl: string;
}): string {
  const lines: string[] = [
    opts.fulfillment === "delivery"
      ? `🧾 *Delivery Order ${opts.orderNumber}*`
      : `🧾 *Pickup Order ${opts.orderNumber}*`,
    ...itemizedLines(opts.items),
  ];
  if (opts.fulfillment === "delivery") {
    if (opts.address) lines.push(`📍 Deliver to: ${opts.address}`);
    lines.push(`Subtotal: ${fmtMoney(opts.subtotal, opts.currency)}`);
    lines.push(`Delivery fee${opts.deliveryZone ? ` (${opts.deliveryZone})` : ""}: ${fmtMoney(opts.deliveryFee, opts.currency)}`);
  }
  if (opts.promo && opts.promo.discount > 0) {
    lines.push(`🏷️ Promo ${opts.promo.code}: −${fmtMoney(opts.promo.discount, opts.currency)}`);
  }
  lines.push(`*Total: ${fmtMoney(opts.total, opts.currency)}*`);
  if (opts.promoError) lines.push(`⚠️ Promo not applied — ${opts.promoError}.`);
  if (opts.fulfillment === "pickup") lines.push("", "🏪 We'll message you when it's ready for pickup.");
  if (opts.paymentUrl) {
    lines.push("", `💳 Click here to complete payment: ${opts.paymentUrl}`);
    lines.push("📱 No data? Dial *712*amount# to pay via MTN MoMo");
  }
  lines.push("", `🧾 Already paid by transfer? Send a photo/screenshot of your receipt here and we'll confirm it automatically.`);
  lines.push(`🔎 Track your order: ${opts.trackingUrl}`);
  return lines.join("\n");
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface ChatOrderResult {
  created: boolean;
  fraudBlocked?: boolean;
  riskLevel?: string;
  orderId?: string;
  orderNumber?: string;
  items?: CartLine[];
  /** Items that could not be fully reserved (no order/payment link created). */
  shortages?: StockShortage[];
  /** Cart lines that ARE available — the buyer's adjusted cart. */
  availableItems?: CartLine[];
  subtotal?: number;
  deliveryFee?: number;
  deliveryZone?: string;
  total?: number;
  currency?: string;
  paymentUrl?: string | null;
  /** Applied promo (code + discount in MAJOR units). */
  promo?: { code: string; discount: number } | null;
  /** Reject reason when a promo code was supplied but not applied. */
  promoError?: string | null;
}

/** Buyer-facing reply when (part of) the cart can't be fulfilled: names the
 * unavailable items, shows the adjusted available cart, and creates NO
 * payment link — we never take payment for items that don't exist in stock. */
export function buildShortageReply(
  shortages: StockShortage[],
  availableItems: CartLine[],
  currency: string,
): string {
  const lines: string[] = [
    "😔 *Some items are out of stock right now:*",
    ...shortages.map((s) =>
      s.available > 0
        ? `• ${s.name} — you asked for ${s.requested}, only ${s.available} left`
        : `• ${s.name} — out of stock`),
  ];
  if (availableItems.length > 0) {
    lines.push("", "✅ *Still available in your cart:*", ...itemizedLines(availableItems));
    const subtotal = availableItems.reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0);
    lines.push(`Available subtotal: ${fmtMoney(subtotal, currency)}`);
    lines.push("", "Adjust your quantities or remove the unavailable items, then confirm again.");
  } else {
    lines.push("", "None of the items in your cart are available right now — please check back soon.");
  }
  return lines.join("\n");
}

/**
 * Create an order from the buyer's cart: totals (incl. delivery fee for
 * delivery fulfillment), fraud gate, order row (with metadata breakdown),
 * fire-and-forget integration sync, and payment-link initiation via the
 * tenant's configured gateway. The payment link always covers the full total
 * (subtotal + delivery fee).
 */
export async function createChatOrder(
  db: Db,
  opts: {
    tenantId: string;
    waPhoneNumber: string;
    customerName?: string;
    cartSessionId: string;
    fulfillment: "pickup" | "delivery";
    address: string | null;
    /** Optional promo/discount code extracted from the chat text. */
    promoCode?: string | null;
  },
): Promise<ChatOrderResult> {
  const items = await db.select().from(cartItems).where(eq(cartItems.cartSessionId, opts.cartSessionId));
  if (items.length === 0) return { created: false };

  // ── Inventory guard (BEFORE any order/payment-link exists) ─────────────
  // Never take payment for items that don't exist in stock. This read-only
  // pre-check produces the buyer-facing shortage reply; the authoritative
  // atomic reservation happens inside the order transaction below.
  const reserveItems = items.map((i) => ({ productId: i.productId, qty: i.quantity }));
  const availability = await checkAvailability(db, opts.tenantId, reserveItems);
  if (!availability.ok) {
    const shortIds = new Set(availability.shortages.map((s) => s.productId));
    return {
      created: false,
      shortages: availability.shortages,
      availableItems: items.filter((i) => !shortIds.has(i.productId)),
      currency: items[0].currency,
    };
  }

  const subtotal = items.reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0);
  const quote = opts.fulfillment === "delivery" ? quoteDeliveryFee({ address: opts.address }) : null;
  const deliveryFee = quote?.fee ?? 0;

  // ── Promo code (optional) ─────────────────────────────────────────────
  // Validated against the cart subtotal; the discount is computed in integer
  // minor units (shared/escrowAmounts discipline) and clamped so the total
  // (subtotal + delivery fee − discount) can never go negative. A promo
  // failure NEVER blocks the order — the buyer just pays full price and the
  // summary notes the code was not applied.
  let promo: { code: string; discount: number } | null = null;
  let promoMeta: { code: string; type: string; value: number; discount: string } | null = null;
  let promoError: string | null = null;
  if (opts.promoCode) {
    try {
      const validation = await validatePromo(db, opts.tenantId, opts.promoCode, subtotal);
      if (validation.ok) {
        const discountMajor = Number(minorUnitsToString(validation.discountMinor));
        promo = { code: validation.promo.code, discount: discountMajor };
        promoMeta = {
          code: validation.promo.code,
          type: validation.promo.type,
          value: validation.promo.value,
          discount: validation.discount,
        };
      } else {
        promoError = `${opts.promoCode} — ${promoRejectText(validation.reason)}`;
      }
    } catch (e: unknown) {
      console.error("[nlp] promo validation failed (non-blocking):", (e as Error)?.message);
    }
  }
  const totalMinor = Math.max(0, toMinorUnitsExact(subtotal + deliveryFee) - (promoMeta ? toMinorUnitsExact(promoMeta.discount) : 0));
  const total = Number(minorUnitsToString(totalMinor));
  const currency = items[0].currency;

  // ── Fraud gate: call /api/ml/predict before creating the order ──────
  try {
    const fraudResp = await fetch(`http://localhost:${process.env.PORT ?? 3000}/api/ml/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: opts.tenantId,
        amount: total,
        phone: opts.waPhoneNumber,
        items: items.map(i => ({ productId: i.productId, qty: i.quantity })),
        customerId: opts.waPhoneNumber,
      }),
    });
    if (fraudResp.ok) {
      const fraudResult = await fraudResp.json() as { fraudProbability: number; riskLevel: string };
      if (fraudResult.riskLevel === "high" || fraudResult.fraudProbability > 0.7) {
        return { created: false, fraudBlocked: true, riskLevel: fraudResult.riskLevel };
      }
    }
  } catch { /* fraud gate failure is non-blocking — allow order through */ }

  const orderId = crypto.randomUUID();
  const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`;
  // ── Order row + atomic stock reservation in ONE transaction ────────────
  // reserveStock runs a conditional UPDATE (stockQuantity >= qty) per item;
  // if a concurrent checkout claimed the last unit since the pre-check, it
  // throws InsufficientStockError and the WHOLE order rolls back — no order,
  // no payment link, no oversell.
  try {
    await db.transaction(async (tx) => {
      await tx.insert(orders).values({
        id: orderId,
        tenantId: opts.tenantId,
        customerId: opts.waPhoneNumber, // use phone as customer ref until resolved
        orderNumber,
        status: "pending",
        totalAmount: total.toFixed(2),
        currency,
        paymentStatus: "unpaid",
        shippingAddress: opts.address ? { raw: opts.address } : null,
        items: items.map(i => ({ productId: i.productId, name: i.productName, qty: i.quantity, price: i.unitPrice })),
        metadata: {
          fulfillment: opts.fulfillment,
          subtotal: subtotal.toFixed(2),
          deliveryFee: deliveryFee.toFixed(2),
          deliveryZone: quote?.zone ?? null,
          source: "whatsapp_chat",
          ...(promoMeta ? { promo: promoMeta } : {}),
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await reserveStock(tx, opts.tenantId, orderId, reserveItems);
    });
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      const shortIds = new Set(err.shortages.map((s) => s.productId));
      return {
        created: false,
        shortages: err.shortages,
        availableItems: items.filter((i) => !shortIds.has(i.productId)),
        currency,
      };
    }
    throw err;
  }

  // ── Claim the promo usage only AFTER the order transaction committed ──
  // (a rolled-back order must never consume a use). Claim-first + atomic —
  // losing a maxUses race just logs; the buyer keeps the validated discount.
  if (promoMeta) {
    applyPromo(db, opts.tenantId, promoMeta.code).then((claimed) => {
      if (!claimed) {
        console.warn(`[nlp] promo ${promoMeta.code} usage claim lost maxUses race for order ${orderId}`);
      }
    }).catch((e: unknown) => console.error("[nlp] promo usage claim failed:", (e as Error)?.message));
  }

  // ── Fire-and-forget sync to external systems ─────────────────────────
  (async () => {
    try {
      const syncItems = items.map(i => ({
        productId: i.productId ?? "",
        name: i.productName ?? "",
        qty: i.quantity,
        price: i.unitPrice,
      }));
      const syncPayload = {
        id: orderId,
        orderNumber,
        total,
        currency,
        phone: opts.waPhoneNumber,
        address: opts.address ?? null,
        items: syncItems,
      };
      await syncOrderToMedusa(opts.tenantId, syncPayload);
      await syncOrderToOdoo(opts.tenantId, syncPayload);
      const personId = await syncContactToTwenty(opts.tenantId, opts.waPhoneNumber, opts.customerName);
      if (personId) {
        await pushOrderActivityToTwenty(opts.tenantId, personId, orderNumber, total, currency);
      }
    } catch (_) { /* best-effort — never block NLP */ }
  })();

  // ── Initiate payment via configured gateway (amount = total incl. fee) ──
  let paymentUrl: string | null = null;
  try {
    const [gwConfig] = await db.select().from(paymentGatewayConfigs)
      .where(and(eq(paymentGatewayConfigs.tenantId, opts.tenantId), eq(paymentGatewayConfigs.isActive, true)))
      .limit(1);
    if (gwConfig) {
      const txId = crypto.randomUUID();
      const callbackUrl = gwConfig.callbackUrl ?? `https://wa.me/${opts.waPhoneNumber}`;
      if (gwConfig.provider === "paystack") {
        const resp = await fetch("https://api.paystack.co/transaction/initialize", {
          method: "POST",
          headers: { Authorization: `Bearer ${gwConfig.secretKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ amount: Math.round(total * 100), currency, reference: txId, callback_url: callbackUrl }),
        }).then(r => r.json()).catch(() => null);
        paymentUrl = resp?.data?.authorization_url ?? null;
      } else if (gwConfig.provider === "flutterwave") {
        const resp = await fetch("https://api.flutterwave.com/v3/payments", {
          method: "POST",
          headers: { Authorization: `Bearer ${gwConfig.secretKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ tx_ref: txId, amount: total, currency, redirect_url: callbackUrl, customer: { phone_number: opts.waPhoneNumber } }),
        }).then(r => r.json()).catch(() => null);
        paymentUrl = resp?.data?.link ?? null;
      }
      await db.insert(paymentTransactions).values({
        id: txId,
        tenantId: opts.tenantId,
        orderId,
        provider: gwConfig.provider,
        providerRef: txId,
        amount: total.toFixed(2),
        currency,
        status: "initiated",
        paymentUrl,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  } catch (_) { /* payment link generation is best-effort */ }

  return {
    created: true,
    orderId,
    orderNumber,
    items,
    subtotal,
    deliveryFee,
    deliveryZone: quote ? (quote.zone === "same_city" ? "same-city estimate" : "intercity estimate") : undefined,
    total,
    currency,
    paymentUrl,
    promo,
    promoError,
  };
}
import { hermesConfigs } from "../../drizzle/schema";

// ── Language detection & system prompts ───────────────────────────────────────
// ── USSD numbered menu builder ────────────────────────────────────────────────
const USSD_MENUS: Record<string, Record<string, string>> = {
  greeting: {
    en: "Welcome! Reply:\n1. Browse products\n2. View my cart\n3. Check order status\n4. Help",
    yo: "Ẹ káàbọ̀! Dáhùn:\n1. Wo àwọn ọjà\n2. Wo àpò mi\n3. Ṣàyẹ̀wò ìpèsè\n4. Ìrànlọ́wọ́",
    ha: "Barka da zuwa! Amsa:\n1. Duba kayayyaki\n2. Duba kwandon saye\n3. Duba oda\n4. Taimako",
    ig: "Nnọọ! Zaghachi:\n1. Lee ngwaahịa\n2. Lee ngọdo m\n3. Lelee ọrụ\n4. Enyemaka",
    pidgin: "Welcome! Reply:\n1. See products\n2. My cart\n3. Check order\n4. Help",
  },
  browse: {
    en: "Products menu:\n1. View all products\n2. Search by name\n3. View cart\n4. Back to main menu",
    pidgin: "Products:\n1. See all\n2. Search\n3. My cart\n4. Back",
  },
  checkout_address: {
    en: "Checkout:\n1. Enter delivery address\n2. Use saved address\n3. Cancel order",
    pidgin: "Checkout:\n1. Enter address\n2. Saved address\n3. Cancel",
  },
};

function buildUssdMenu(state: string, lang: string): string {
  const menu = USSD_MENUS[state] ?? USSD_MENUS.greeting;
  return menu[lang] ?? menu.en;
}

// ── Multilingual fallback error messages ──────────────────────────────────────
const FALLBACK_ERRORS: Record<string, string> = {
  english: "Sorry, I didn't understand that. Please try again or type 'help'.",
  yoruba: "Pèlé, mi ò lóye ìyẹn. Jọ̀wọ́ gbìyànjú lẹ́ẹ̀kan sí i tàbí kọ 'ìrànlọ́wọ́'.",
  hausa: "Yi haƙuri, ban fahimci hakan ba. Don Allah sake gwadawa ko rubuta 'taimako'.",
  igbo: "Ndo, aghaghị m ịghọta nke ahụ. Biko nwaa ọzọ ma ọ bụ dee 'enyemaka'.",
  pidgin: "Sorry, I no understand wetin you talk. Try again or type 'help'.",
};

const LANGUAGE_HINTS: Record<string, string[]> = {
  yoruba: ["ẹ", "ọ", "ṣ", "jẹ", "wa", "mo", "ni", "fun", "ati", "se", "bawo", "kini", "ewo"],
  hausa: ["na", "da", "ba", "mai", "ina", "kuma", "don", "shi", "ta", "suna", "yaya", "wane"],
  igbo: ["ọ", "ị", "ụ", "bụ", "nke", "na", "ya", "ha", "gị", "m", "dị", "nọ", "ebe"],
  pidgin: ["abeg", "wetin", "dey", "oga", "no be", "wey", "comot", "chop", "wahala", "sharp sharp", "how far"],
};

function detectLanguage(text: string): string {
  const lower = text.toLowerCase();
  for (const [lang, hints] of Object.entries(LANGUAGE_HINTS)) {
    if (hints.some(h => lower.includes(h))) return lang;
  }
  return "english";
}

function buildSystemPrompt(language: string, products: Array<{ name: string; price: string; currency: string; stockQuantity: number }>, tenantName: string): string {
  const productList = products.slice(0, 20).map(p =>
    `- ${p.name}: ${p.currency} ${p.price} (${p.stockQuantity > 0 ? "in stock" : "out of stock"})`
  ).join("\n");

  const langInstructions: Record<string, string> = {
    english: "Respond in clear, friendly English.",
    yoruba: "Respond in Yoruba (you may mix with English where needed). Be warm and respectful.",
    hausa: "Respond in Hausa (you may mix with English where needed). Be polite and helpful.",
    igbo: "Respond in Igbo (you may mix with English where needed). Be friendly and clear.",
    pidgin: "Respond in Nigerian Pidgin English. Be casual, friendly, and use common pidgin expressions.",
  };

  return `You are a helpful WhatsApp shopping assistant for ${tenantName}. ${langInstructions[language] ?? langInstructions.english}

You help customers browse products, add items to their cart, and complete purchases — all through natural conversation.

AVAILABLE PRODUCTS:
${productList}

CONVERSATION RULES:
1. Detect what the customer wants (browse, search product, add to cart, checkout, check order status, get help).
2. Never show a numbered menu unless the customer explicitly asks for options.
3. If a customer mentions a product name (even partially or misspelled), match it to the catalog.
4. Guide checkout naturally: collect delivery address, confirm order summary, then provide payment instructions.
5. If stock is 0, apologise and suggest alternatives.
6. Keep responses SHORT (under 160 chars when possible) — this is WhatsApp.
7. If the customer wants to REPEAT a previous order ("repeat my last order", "same as last time", "the usual", "reorder"), use intent "reorder" — the system rebuilds the cart from their last paid order automatically.
8. If the customer raises a DISPUTE or complaint about an order ("I want to dispute", "my order never arrived", "you sent the wrong item", "I'm not happy with my order"), use intent "dispute" — the system logs the dispute and notifies the team automatically.

RESPOND WITH JSON (no markdown):
{
  "reply": "<message to send to customer>",
  "intent": "browse|search|add_to_cart|remove_from_cart|view_cart|checkout|confirm_order|order_status|support|greeting|reorder|dispute|unknown",
  "nextState": "greeting|browse|product_detail|add_to_cart|checkout_address|checkout_confirm|payment|order_confirmed|support",
  "extractedItems": [{"product": "<product name>", "quantity": <number>}] — EVERY product the customer wants to add in this message (multi-item orders are common, e.g. "2 spicy wraps and 1 malt"); empty array if none,
  "extractedProduct": "<single product name if exactly one mentioned, else null>",
  "extractedQuantity": <number or null>,
  "extractedAddress": "<delivery address if provided, or null>",
  "confidence": <0.0-1.0>
}`;
}

// ── Router ────────────────────────────────────────────────────────────────────
export const nlpRouter = router({
  /**
   * Process an incoming WhatsApp message through the NLP engine.
   * Called by the webhook handler when a message arrives.
   */
  processMessage: publicProcedure
    .input(z.object({
     tenantId: z.string(),
     waPhoneNumber: z.string(),
     message: z.string().max(4096),
     customerName: z.string().optional(),
      ussdMode: z.boolean().optional(),
   }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      // 1. Upsert NLP session
      const existing = await db.select().from(nlpSessions)
        .where(and(eq(nlpSessions.tenantId, input.tenantId), eq(nlpSessions.waPhoneNumber, input.waPhoneNumber)))
        .limit(1);

      const detectedLang = detectLanguage(input.message);
      let session = existing[0];

      if (!session) {
        const [newSession] = await db.insert(nlpSessions).values({
          id: crypto.randomUUID(),
          tenantId: input.tenantId,
          waPhoneNumber: input.waPhoneNumber,
          customerName: input.customerName,
          language: detectedLang,
          state: "greeting",
          context: {},
          messageHistory: [],
          lastActivityAt: new Date(),
          createdAt: new Date(),
        }).returning();
        session = newSession;
      } else {
        // Update language if newly detected
        if (detectedLang !== "english") {
          await db.update(nlpSessions)
            .set({ language: detectedLang, lastActivityAt: new Date() })
            .where(eq(nlpSessions.id, session.id));
          session.language = detectedLang;
        }
      }

      // 2. Load tenant products for context
      const tenantProducts = await db.select({
        id: products.id,
        name: products.name,
        price: products.price,
        currency: products.currency,
        stockQuantity: products.stockQuantity,
        description: products.description,
        imageUrl: products.imageUrl,
      }).from(products)
        .where(and(eq(products.tenantId, input.tenantId), eq(products.status, "active")))
        .limit(30);

      // 3. Load cart for context
      let cartSession = session.cartSessionId
        ? (await db.select().from(cartSessions).where(eq(cartSessions.id, session.cartSessionId)).limit(1))[0]
        : null;

      let cartItemsList: Array<{ productName: string; quantity: number; unitPrice: string; currency: string }> = [];
      if (cartSession) {
        cartItemsList = await db.select().from(cartItems).where(eq(cartItems.cartSessionId, cartSession.id));
      }

      // 3b. Deterministic checkout steps — when the session is awaiting a
      // structured answer (fulfillment choice / delivery address) parse it
      // directly instead of spending an LLM call on a structured reply.
      {
        const stepCtx: Record<string, unknown> = (session.context as Record<string, unknown>) ?? {};
        if (cartSession && (stepCtx.awaitingFulfillment === true || stepCtx.awaitingAddress === true)) {
          const text = input.message.trim();
          const lower = text.toLowerCase();
          let reply: string;
          let stepIntent = "checkout_fulfillment";
          let nextState = "checkout_confirm";
          const activeCartId: string = cartSession.id;
          // Rich follow-up annotation: set when this turn creates an order —
          // the webhook delivers an interactive order action card after the
          // payment summary.
          let stepOrderCard: { orderId: string; orderNumber: string; paymentUrl: string | null } | undefined;

          // Promo code capture: "use code SAVE10" at any checkout step sticks
          // to the session and is applied when the order is created.
          const mentionedPromo = extractPromoCode(text);
          if (mentionedPromo) stepCtx.promoCode = mentionedPromo;

          const finalizeOrder = async (fulfillment: "pickup" | "delivery", address: string | null) => {
            const order = await createChatOrder(db, {
              tenantId: input.tenantId,
              waPhoneNumber: input.waPhoneNumber,
              customerName: input.customerName,
              cartSessionId: activeCartId,
              fulfillment,
              address,
              promoCode: typeof stepCtx.promoCode === "string" ? stepCtx.promoCode : null,
            });
            if (order.fraudBlocked) {
              return `⚠️ Your order could not be processed at this time. Please contact support for assistance. (Risk: ${order.riskLevel})`;
            }
            if (order.shortages?.length) {
              // No order, no payment link — tell the buyer what's missing.
              return buildShortageReply(order.shortages, order.availableItems ?? [], order.currency ?? "NGN");
            }
            if (!order.created) return "Your cart appears to be empty — what would you like to order?";
            stepCtx.fulfillment = fulfillment;
            stepCtx.lastOrderId = order.orderId;
            stepCtx.lastOrderNumber = order.orderNumber;
            nextState = "payment";
            stepIntent = "confirm_order";
            stepOrderCard = { orderId: order.orderId!, orderNumber: order.orderNumber!, paymentUrl: order.paymentUrl ?? null };
            return buildOrderSummary({
              fulfillment,
              orderNumber: order.orderNumber!,
              items: order.items!,
              subtotal: order.subtotal!,
              deliveryFee: order.deliveryFee!,
              deliveryZone: order.deliveryZone,
              address,
              promo: order.promo ?? null,
              promoError: order.promoError ?? null,
              total: order.total!,
              currency: order.currency!,
              paymentUrl: order.paymentUrl ?? null,
              trackingUrl: trackingUrlFor(order.orderId!),
            });
          };

          if (stepCtx.awaitingFulfillment === true) {
            const wantsPickup = /^(1|pickup|pick up|pick-up|collect|i'?ll pick|i go pick)/.test(lower);
            const wantsDelivery = /^(2|deliver|delivery|bring it|send it)/.test(lower);
            delete stepCtx.awaitingFulfillment;
            if (wantsPickup) {
              reply = await finalizeOrder("pickup", null);
            } else if (wantsDelivery) {
              stepCtx.fulfillment = "delivery";
              const knownAddress = typeof stepCtx.deliveryAddress === "string" ? stepCtx.deliveryAddress : null;
              if (knownAddress) {
                reply = await finalizeOrder("delivery", knownAddress);
              } else {
                stepCtx.awaitingAddress = true;
                nextState = "checkout_address";
                reply = "Great — delivery it is! 🛵 Please send me your full delivery address (street, area, city).";
              }
            } else {
              // Unrecognized — re-ask, keep awaiting the choice.
              stepCtx.awaitingFulfillment = true;
              reply = (mentionedPromo
                ? `Got it — code ${mentionedPromo.toUpperCase()} will be applied to your order. `
                : "") + "Please reply 1️⃣ for Pickup or 2️⃣ for Delivery.";
            }
          } else {
            // awaitingAddress — treat the whole message as the address.
            delete stepCtx.awaitingAddress;
            if (text.length >= 6) {
              stepCtx.deliveryAddress = text;
              reply = await finalizeOrder("delivery", text);
            } else {
              stepCtx.awaitingAddress = true;
              nextState = "checkout_address";
              reply = "That looks a bit short — please send your full delivery address (street, area, city).";
            }
          }

          const stepHistory = [
            ...((session.messageHistory as Array<{ role: string; content: string }>).slice(-10)),
            { role: "user", content: input.message },
            { role: "assistant", content: reply },
          ].slice(-20);
          await db.update(nlpSessions).set({
            state: nextState,
            context: stepCtx,
            messageHistory: stepHistory,
            lastActivityAt: new Date(),
          }).where(eq(nlpSessions.id, session.id));
          await db.insert(agentEvents).values({
            id: crypto.randomUUID(),
            tenantId: input.tenantId,
            conversationId: session.id,
            eventType: "nlp_message",
            intentType: stepIntent,
            confidence: "1.000",
            escalated: false,
            model: "deterministic-checkout",
            createdAt: new Date(),
          });
          return {
            reply,
            intent: stepIntent,
            state: nextState,
            language: session.language,
            sessionId: session.id,
            confidence: 1,
            orderCard: stepOrderCard,
          };
        }
      }

      // 3c. FAQ knowledge base — answer straight from settings.faq before any
      // LLM call. A miss falls through to the normal pipeline.
      {
        const [tenantRow] = await db.select({ settings: tenants.settings })
          .from(tenants)
          .where(eq(tenants.id, input.tenantId))
          .limit(1)
          .catch(() => [] as any[]);
        const faqs = parseFaqSettings((tenantRow?.settings ?? null) as Record<string, unknown> | null);
        if (faqs.length > 0) {
          const hit = matchFaq(faqs, input.message);
          if (hit) {
            const faqHistory = [
              ...((session.messageHistory as Array<{ role: string; content: string }>).slice(-10)),
              { role: "user", content: input.message },
              { role: "assistant", content: hit.entry.a },
            ].slice(-20);
            await db.update(nlpSessions).set({
              messageHistory: faqHistory,
              lastActivityAt: new Date(),
            }).where(eq(nlpSessions.id, session.id));
            await db.insert(agentEvents).values({
              id: crypto.randomUUID(),
              tenantId: input.tenantId,
              conversationId: session.id,
              eventType: "nlp_message",
              intentType: "faq",
              confidence: hit.score.toFixed(3),
              escalated: false,
              model: "faq-kb",
              createdAt: new Date(),
            });
            return {
              reply: hit.entry.a,
              intent: "faq",
              state: session.state,
              language: session.language,
              sessionId: session.id,
              confidence: hit.score,
            };
          }
        }
      }

      // 4. Build message history for LLM context (last 10 turns)
      const history = (session.messageHistory as Array<{ role: string; content: string }>).slice(-10);

      // 5. Call LLM
     // 5a. USSD mode check — if session context has ussdMode=true, return numbered menu
    const sessionCtx = (session.context as Record<string, unknown>) ?? {};
     const isUssd = input.ussdMode ?? sessionCtx.ussdMode === true;
     if (isUssd) {
       const ussdMenu = buildUssdMenu(session.state, session.language);
       await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
       return { reply: ussdMenu, intent: "ussd_menu", confidence: 1, state: session.state, language: session.language, sessionId: session.id };
     }
      // 5b. Hermes setup / status commands — handled before LLM to avoid token cost
      const trimmedMsg = input.message.trim().toLowerCase();
      if (trimmedMsg === "hermes setup" || trimmedMsg === "hermes agent setup") {
        const { ENV } = await import("../_core/env");
        const existingCfg = await db.select().from(hermesConfigs)
          .where(eq(hermesConfigs.tenantId, input.tenantId)).limit(1);
        if (existingCfg.length === 0) {
          await db.insert(hermesConfigs).values({
            tenantId: input.tenantId,
            active: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            hermesAgentUrl: (ENV as any).hermesAgentUrl ?? null,
            hermesApiKey: (ENV as any).hermesApiKey ?? null,
          });
        } else {
          await db.update(hermesConfigs)
            .set({ active: true, updatedAt: Date.now() })
            .where(eq(hermesConfigs.tenantId, input.tenantId));
        }
        const confirmMsg = [
          "✅ *Hermes Agent is now active for your store!*",
          "",
          "Here is what Hermes can do for you:",
          "• 📦 Auto-generate Purchase Orders when stock runs low",
          "• 📧 Email suppliers automatically with PO details",
          "• 🔄 Sync inventory across WooCommerce and other channels",
          "• 💬 Reply APPROVE PO-XXXX or REJECT PO-XXXX to manage orders",
          "",
          "Your Hermes Agent dashboard is live at /hermes in your back-office.",
          "Reply *hermes status* at any time to check the connection.",
        ].join("\n");
        // Delivery is handled by the caller: the WhatsApp webhook now sends the
        // returned reply via services/waSender (tenant-aware credentials), so
        // sending here as well would double-deliver the confirmation.
        await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
        return { reply: confirmMsg, intent: "hermes_setup", confidence: 1, state: session.state, language: session.language, sessionId: session.id };
      }
      if (trimmedMsg === "hermes status") {
        const cfg = await db.select().from(hermesConfigs)
          .where(eq(hermesConfigs.tenantId, input.tenantId)).limit(1);
        const statusMsg = cfg.length > 0 && cfg[0].active
          ? "✅ *Hermes Agent is active* for your store. Type APPROVE PO-XXXX or REJECT PO-XXXX to manage purchase orders."
          : "⚠️ *Hermes Agent is not yet configured.* Type *hermes setup* to activate it.";
        await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
        return { reply: statusMsg, intent: "hermes_status", confidence: 1, state: session.state, language: session.language, sessionId: session.id };
      }
     const systemPrompt = buildSystemPrompt(session.language, tenantProducts, input.tenantId);
      const cartSummary = cartItemsList.length > 0
        ? `\nCURRENT CART:\n${cartItemsList.map(i => `- ${i.productName} x${i.quantity} @ ${i.currency} ${i.unitPrice}`).join("\n")}\nCart total: ${cartItemsList.reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0).toFixed(2)}`
        : "\nCURRENT CART: empty";

      const messages = [
        { role: "system" as const, content: systemPrompt + cartSummary },
        ...history.map(h => ({ role: h.role as "user" | "assistant", content: h.content })),
        { role: "user" as const, content: input.message },
      ];

      let llmResult: {
        reply: string; intent: string; nextState: string;
        extractedItems?: Array<{ product?: string | null; quantity?: number | null }> | null;
        extractedProduct: string | null; extractedQuantity: number | null;
        extractedAddress: string | null; confidence: number;
      };

      try {
        const raw = await invokeLLM({ messages, model: "gpt-5-mini" });
        const rawContent = raw.choices?.[0]?.message?.content;
        const content = typeof rawContent === "string" ? rawContent : "{}";
        // Strip markdown code fences if present
        const cleaned = content.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
        llmResult = JSON.parse(cleaned);
      } catch {
        llmResult = {
          reply: FALLBACK_ERRORS[session.language] ?? FALLBACK_ERRORS.english,
          intent: "unknown", nextState: session.state,
          extractedItems: [],
          extractedProduct: null, extractedQuantity: null,
          extractedAddress: null, confidence: 0,
        };
      }

      // 6. Act on intent
      const ctx: Record<string, unknown> = (session.context as Record<string, unknown>) ?? {};
      // Rich follow-up annotations for the webhook delivery layer.
      let orderCard: { orderId: string; orderNumber: string; paymentUrl: string | null } | undefined;

      if (llmResult.intent === "add_to_cart") {
        // Multi-item support: the LLM returns extractedItems[] for messages like
        // "2 spicy chicken wraps and 1 sweet chilli wrap"; the legacy single
        // extractedProduct/extractedQuantity fields are the fallback. Each item
        // is matched with per-item confidence — ambiguous mentions are NOT
        // guessed; they get a clarification line appended to the reply.
        const itemsToAdd = normalizeExtractedItems(llmResult);
        if (itemsToAdd.length > 0) {
          const result = await addExtractedItemsToCart(db, {
            tenantId: input.tenantId,
            waPhoneNumber: input.waPhoneNumber,
            session: { id: session.id, language: session.language },
            cartSession,
            products: tenantProducts,
            items: itemsToAdd,
          });
          cartSession = result.cartSession;
          if (result.added.length > 0) {
            // Keep the in-memory cart context in sync for this turn.
            cartItemsList = await db.select().from(cartItems).where(eq(cartItems.cartSessionId, result.cartSession.id));
            const addedSummary = result.added
              .map(a => `✅ ${a.quantity} × ${a.productName}`)
              .join("\n");
            llmResult.reply = `${addedSummary}\n${llmResult.reply ?? ""}`.trim();
          }
          if (result.clarifications.length > 0) {
            llmResult.reply = `${llmResult.reply ?? ""}\n\n${result.clarifications.join("\n")}`.trim();
          }
          // Refresh the abandoned-cart marker (24h TTL) on every cart update.
          if (result.cartSession) {
            await touchCartMarker(input.tenantId, input.waPhoneNumber).catch(() => {});
          }
        }
      }

      if (llmResult.intent === "reorder") {
        // Smart reorder: rebuild the cart from the caller's most recent PAID
        // order at CURRENT catalog prices (price changes are called out).
        const locale = localeFromSessionLanguage(session.language);
        const reordered = await buildReorder(db, {
          tenantId: input.tenantId,
          waPhoneNumber: input.waPhoneNumber,
          session: { id: session.id, language: session.language },
          cartSession,
          products: tenantProducts,
        });
        if (reordered.cartSessionId) {
          if (!cartSession || cartSession.id !== reordered.cartSessionId) {
            cartSession = (await db.select().from(cartSessions)
              .where(eq(cartSessions.id, reordered.cartSessionId)).limit(1))[0] ?? cartSession;
          }
          await touchCartMarker(input.tenantId, input.waPhoneNumber).catch(() => {});
        }
        llmResult.reply = reordered.status === "no_prior_order"
          ? tr(locale, "reorderNoPriorOrder")
          : buildReorderReply(reordered);
      }

      if (llmResult.intent === "dispute") {
        // Chat dispute self-service: log the dispute (shared escrow dispute
        // validation when the order is escrow-backed) + notify the admin.
        const dispute = await raiseChatDispute({
          db,
          tenantId: input.tenantId,
          phone: input.waPhoneNumber,
          complaintText: input.message,
          orderId: typeof ctx.lastOrderId === "string" ? ctx.lastOrderId : null,
          customerName: input.customerName,
        }).catch((e: any) => {
          console.warn("[nlp] dispute intake failed:", e?.message);
          return null;
        });
        if (dispute) {
          llmResult.reply = buildDisputeReply(dispute);
          llmResult.nextState = "support";
        }
      }

      if (llmResult.intent === "confirm_order" && cartSession) {
        // Promo code capture ("use code SAVE10") — sticks to the session.
        const mentionedPromo = extractPromoCode(input.message);
        if (mentionedPromo) ctx.promoCode = mentionedPromo;
        const items = await db.select().from(cartItems).where(eq(cartItems.cartSessionId, cartSession.id));
        if (items.length > 0) {
          const subtotal = items.reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0);
          const currency = items[0].currency;
          const fulfillment = typeof ctx.fulfillment === "string" ? ctx.fulfillment as "pickup" | "delivery" : null;

          if (!fulfillment) {
            // Checkout step 1: itemized cart + subtotal, then ask pickup or
            // delivery. The order (and payment link) is only created once the
            // fulfillment choice — and for delivery, the address + fee — is
            // known, so the payment link always covers the true total.
            ctx.awaitingFulfillment = true;
            llmResult.nextState = "checkout_confirm";
            llmResult.reply = buildFulfillmentPrompt(items, subtotal, currency);
          } else {
            // Fulfillment already chosen earlier in the session — create the
            // order immediately (e.g. buyer re-confirming).
            const address = fulfillment === "delivery"
              ? (llmResult.extractedAddress ?? (typeof ctx.deliveryAddress === "string" ? ctx.deliveryAddress : null))
              : null;
            const order = await createChatOrder(db, {
              tenantId: input.tenantId,
              waPhoneNumber: input.waPhoneNumber,
              customerName: input.customerName,
              cartSessionId: cartSession.id,
              fulfillment,
              address,
              promoCode: typeof ctx.promoCode === "string" ? ctx.promoCode : null,
            });
            if (order.fraudBlocked) {
              llmResult.reply = `\u26a0\ufe0f Your order could not be processed at this time. Please contact support for assistance. (Risk: ${order.riskLevel})`;
            } else if (order.shortages?.length) {
              // Out-of-stock guard tripped — no order, no payment link.
              llmResult.reply = buildShortageReply(order.shortages, order.availableItems ?? [], order.currency ?? "NGN");
            } else if (order.created) {
              ctx.lastOrderId = order.orderId;
              ctx.lastOrderNumber = order.orderNumber;
              orderCard = { orderId: order.orderId!, orderNumber: order.orderNumber!, paymentUrl: order.paymentUrl ?? null };
              llmResult.reply = buildOrderSummary({
                fulfillment,
                orderNumber: order.orderNumber!,
                items: order.items!,
                subtotal: order.subtotal!,
                deliveryFee: order.deliveryFee!,
                deliveryZone: order.deliveryZone,
                address,
                promo: order.promo ?? null,
                promoError: order.promoError ?? null,
                total: order.total!,
                currency: order.currency!,
                paymentUrl: order.paymentUrl ?? null,
                trackingUrl: trackingUrlFor(order.orderId!),
              });
            }
          }
        }
      } // end if (confirm_order)

      if (llmResult.extractedAddress) {
        ctx.deliveryAddress = llmResult.extractedAddress;
      }

      // 6b. Product image card — on a single-product query (search/browse or
      // a product_detail turn), annotate the best-match catalog image so the
      // webhook can deliver it as an image card.
      let productImage: { link: string; caption: string } | undefined;
      const productQuery = llmResult.extractedProduct?.trim();
      if (
        productQuery &&
        (llmResult.intent === "search" || llmResult.intent === "browse" || llmResult.nextState === "product_detail")
      ) {
        const q = productQuery.toLowerCase();
        const match =
          tenantProducts.find((p) => p.name.toLowerCase() === q) ??
          tenantProducts.find((p) => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()));
        if (match?.imageUrl) {
          productImage = {
            link: match.imageUrl,
            caption: `${match.name} — ${fmtMoney(Number(match.price), match.currency)}`,
          };
        }
      }

      // 7. Update session
      const newHistory = [
        ...history,
        { role: "user", content: input.message },
        { role: "assistant", content: llmResult.reply },
      ].slice(-20);

      await db.update(nlpSessions).set({
        state: llmResult.nextState ?? session.state,
        context: ctx,
        messageHistory: newHistory,
        lastActivityAt: new Date(),
      }).where(eq(nlpSessions.id, session.id));

      // 8. Log agent event
      await db.insert(agentEvents).values({
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        conversationId: session.id,
        eventType: "nlp_message",
        intentType: llmResult.intent,
        confidence: llmResult.confidence?.toFixed(3) ?? "0.000",
        escalated: false,
        model: "gpt-5-mini",
        createdAt: new Date(),
      });

      return {
        reply: llmResult.reply,
        intent: llmResult.intent,
        state: llmResult.nextState,
        language: session.language,
        sessionId: session.id,
        confidence: llmResult.confidence ?? 0,
        orderCard,
        productImage,
      };
    }),

  /** Get or create a session for a phone number */
  getSession: protectedProcedure
    .input(z.object({ tenantId: z.string(), waPhoneNumber: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [session] = await db.select().from(nlpSessions)
        .where(and(eq(nlpSessions.tenantId, input.tenantId), eq(nlpSessions.waPhoneNumber, input.waPhoneNumber)))
        .limit(1);
      return session ?? null;
    }),

  /** List active sessions for a tenant */
  listSessions: protectedProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().default(50) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return db.select().from(nlpSessions)
        .where(eq(nlpSessions.tenantId, input.tenantId))
        .orderBy(sql`${nlpSessions.lastActivityAt} DESC`)
        .limit(input.limit);
    }),

  /** Reset/clear a session (e.g. after order confirmed) */
  resetSession: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await db.update(nlpSessions).set({
        state: "greeting",
        context: {},
        messageHistory: [],
        cartSessionId: null,
        lastActivityAt: new Date(),
      }).where(eq(nlpSessions.id, input.sessionId));
      return { ok: true };
    }),

  /** Simulate a conversation (for testing/demo) */
  simulate: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      waPhoneNumber: z.string(),
      messages: z.array(z.string()),
    }))
    .mutation(async ({ input, ctx }) => {
      const results = [];
      for (const msg of input.messages) {
        // Re-use processMessage logic inline
        const db = await getDb();
        if (!db) break;
        results.push({ message: msg, processed: true });
      }
      return results;
    }),

  /** Queue a message for offline delivery (called when buyer is offline) */
  queueOfflineMessage: protectedProcedure
    .input(z.object({
      sessionId: z.string(),
      tenantId: z.string(),
      waPhoneNumber: z.string(),
      message: z.string(),
      direction: z.enum(["inbound", "outbound"]).default("outbound"),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [row] = await db.insert(offlineMessageQueue).values({
        id: crypto.randomUUID(),
        sessionId: input.sessionId,
        tenantId: input.tenantId,
        waPhoneNumber: input.waPhoneNumber,
        message: input.message,
        direction: input.direction,
        status: "queued",
        queuedAt: new Date(),
      }).returning();
      return row;
    }),

  /** Sync (replay) queued offline messages when buyer reconnects */
  syncOfflineQueue: protectedProcedure
    .input(z.object({
      sessionId: z.string(),
      waPhoneNumber: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const queued = await db.select().from(offlineMessageQueue)
        .where(and(
          eq(offlineMessageQueue.sessionId, input.sessionId),
          eq(offlineMessageQueue.status, "queued"),
        ))
        .orderBy(offlineMessageQueue.queuedAt);
      if (queued.length === 0) return { synced: 0, messages: [] };
      await db.update(offlineMessageQueue)
        .set({ status: "delivered", deliveredAt: new Date() })
        .where(and(
          eq(offlineMessageQueue.sessionId, input.sessionId),
          eq(offlineMessageQueue.status, "queued"),
        ));
      return { synced: queued.length, messages: queued };
    }),

  /** Get queued offline message count for a session */
  getOfflineQueueCount: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { count: 0 };
      const rows = await db.select().from(offlineMessageQueue)
        .where(and(
          eq(offlineMessageQueue.sessionId, input.sessionId),
          eq(offlineMessageQueue.status, "queued"),
        ));
    return { count: rows.length };
    }),
  /** Load queued offline messages for a session (mount-time pre-population) */
  getQueuedMessages: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { messages: [] };
      const rows = await db.select().from(offlineMessageQueue)
        .where(and(
          eq(offlineMessageQueue.sessionId, input.sessionId),
          eq(offlineMessageQueue.status, "queued"),
        ))
        .orderBy(offlineMessageQueue.queuedAt);
      return { messages: rows.map(r => r.message) };
    }),

  /** Unified order timeline: platform order + Medusa + Odoo + Twenty CRM events */
  getOrderTimeline: protectedProcedure
    .input(z.object({ orderNumber: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [order] = await db.select().from(orders)
        .where(eq(orders.orderNumber, input.orderNumber))
        .limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });

      const items = await db.select().from(orderItems)
        .where(eq(orderItems.orderId, order.id));

      const payments = await db.select().from(paymentTransactions)
        .where(eq(paymentTransactions.orderId, order.id));

      const integrations = await db.select({
        integrationType: tenantIntegrations.integrationType,
        status: tenantIntegrations.status,
      }).from(tenantIntegrations)
        .where(eq(tenantIntegrations.tenantId, order.tenantId));

      const hasMedusa = integrations.some(i => i.integrationType === "medusa" && i.status === "active");
      const hasOdoo = integrations.some(i => i.integrationType === "odoo_erp" && i.status === "active");
      const hasTwenty = integrations.some(i => i.integrationType === "twenty_crm" && i.status === "active");

      type TimelineEvent = {
        id: string; timestamp: Date; system: string; event: string;
        detail: string; status: "success" | "pending" | "failed" | "info";
      };
      const timeline: TimelineEvent[] = [];

      timeline.push({
        id: "platform-created",
        timestamp: order.createdAt,
        system: "WhatsApp Platform",
        event: "Order Created",
        detail: `Order ${order.orderNumber} created via WhatsApp conversation`,
        status: "success",
      });

      if (payments.length > 0) {
        const p = payments[payments.length - 1];
        timeline.push({
          id: `payment-${p.id}`,
          timestamp: p.createdAt,
          system: "Payment Gateway",
          event: p.status === "success" ? "Payment Confirmed" : "Payment Initiated",
          detail: `${p.provider} · ${order.currency} ${order.totalAmount}`,
          status: p.status === "success" ? "success" : p.status === "failed" ? "failed" : "pending",
        });
      }

      if (order.erpOrderId) {
        timeline.push({
          id: "medusa-synced",
          timestamp: order.updatedAt,
          system: "Medusa Commerce",
          event: "Order Synced",
          detail: `Medusa order ID: ${order.erpOrderId}`,
          status: "success",
        });
      } else if (hasMedusa) {
        timeline.push({
          id: "medusa-pending",
          timestamp: order.createdAt,
          system: "Medusa Commerce",
          event: "Sync Pending",
          detail: "Order not yet synced to Medusa — will retry on next heartbeat",
          status: "pending",
        });
      }

      if (hasOdoo) {
        timeline.push({
          id: "odoo-sale",
          timestamp: order.updatedAt,
          system: "Odoo ERP",
          event: order.status === "delivered" ? "Delivery Completed"
            : order.status === "processing" ? "In Fulfillment" : "Sale Order Created",
          detail: `Odoo sale.order · Status: ${order.status}`,
          status: order.status === "delivered" ? "success"
            : order.status === "cancelled" ? "failed" : "pending",
        });
      }

      if (hasTwenty) {
        timeline.push({
          id: "twenty-activity",
          timestamp: order.createdAt,
          system: "Twenty CRM",
          event: "CRM Activity Logged",
          detail: "Order activity pushed to Twenty CRM for customer contact",
          status: "success",
        });
      }

      timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      return {
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          paymentStatus: order.paymentStatus,
          totalAmount: order.totalAmount,
          currency: order.currency,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
          shippingAddress: order.shippingAddress,
          notes: order.notes,
          erpOrderId: order.erpOrderId,
        },
        items,
        payments,
        timeline,
        integrations: { hasMedusa, hasOdoo, hasTwenty },
      };
    }),
});
