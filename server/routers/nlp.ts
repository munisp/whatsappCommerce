/**
 * NLP Buyer Conversation Engine
 * Handles natural-language WhatsApp messages in English, Yoruba, Hausa, Igbo, and Pidgin.
 * No menu required — buyers type freely and the LLM interprets intent.
 *
 * Conversation states: greeting → browse → product_detail → add_to_cart →
 *   checkout_address → checkout_confirm → payment → order_confirmed → support
 */
import { z } from "zod";
import { eq, and, sql, desc, ilike, inArray, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, internalProcedure, router, assertTenantAccess } from "../_core/trpc";
// === W34 otel-core === traceparent propagation (internal ml call).
import { injectTraceHeaders } from "../_core/telemetry";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import {
  nlpSessions, cartSessions, cartItems, orders, orderItems,
  customers, products, conversations, agentEvents, tenants,
  telegramIdentities,
} from "../../drizzle/schema";
import { paymentTransactions, paymentIntents } from "../../drizzle/schema";
import { ENV } from "../_core/env";

/**
 * W12.1 IDOR guard for sessionId-keyed procedures: resolve the session's
 * tenant from nlp_sessions, then assert the caller may access that tenant.
 * Throws NOT_FOUND for unknown sessions (no cross-tenant existence leak
 * beyond what the caller already knows — they supplied the id).
 */
async function assertNlpSessionAccess(
  user: { role: string; tenantId?: string | null; memberships?: readonly string[] | null },
  sessionId: string,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  const [session] = await db
    .select({ tenantId: nlpSessions.tenantId })
    .from(nlpSessions)
    .where(eq(nlpSessions.id, sessionId))
    .limit(1);
  if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
  assertTenantAccess(user, session.tenantId);
}
import { offlineMessageQueue } from "../../drizzle/schema";
import { tenantIntegrations } from "../../drizzle/schema";
import {
  syncOrderToMedusa,
  syncOrderToOdoo,
  syncContactToTwenty,
  pushOrderActivityToTwenty,
} from "../services/integrationSync";
import { normalizeExtractedItems, addExtractedItemsToCart, matchCatalogItem } from "../services/nlpCart";
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
import { subscribeToWaitlist, unsubscribeFromWaitlist } from "../services/waitlist";
import { toMinorUnitsExact, minorUnitsToString } from "../../shared/escrowAmounts";
import { makeDualFormatter, DUAL_DISPLAY_FOOTER, formatPriceDual } from "../services/displayFx";
import { requestReturn } from "../services/rma";

/** W41 UC-5: load the tenant's dual-display formatter (null when unconfigured). */
async function dualFormatterFor(db: any, tenantId: string): Promise<((amount: number, currency?: string) => string) | null> {
  const [row] = await db
    .select({ displayCurrency: tenants.displayCurrency, displayFxRates: tenants.displayFxRates })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  return makeDualFormatter(row);
}

// ── Checkout message builders ────────────────────────────────────────────────
type CartLine = { productName: string; quantity: number; unitPrice: string; currency: string };

/** Format a major-unit amount with the currency symbol where we know it. */
export function fmtMoney(amount: number, currency: string): string {
  const symbols: Record<string, string> = { NGN: "₦", USD: "$", GHS: "GH₵", KES: "KSh " };
  const sym = symbols[(currency ?? "").toUpperCase()] ?? `${currency} `;
  return `${sym}${amount.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** W41 UC-5: optional dual-display price formatter (NGN + tenant display currency). */
type PriceFmt = (amount: number, currency: string) => string;

function itemizedLines(items: CartLine[], fmt: PriceFmt = fmtMoney): string[] {
  return items.map(i => `${i.quantity} × ${i.productName} — ${fmt(Number(i.unitPrice), i.currency)} each`);
}

/** Extract a promo code from chat text, e.g. "use code SAVE10" or "code: SAVE10". */
export function extractPromoCode(text: string): string | null {
  const m = /\b(?:use\s+)?code[:\s]+([A-Za-z0-9_-]{2,32})\b/i.exec(text);
  return m ? m[1] : null;
}

// === W46 orders-p2 (ORD-25) ===
/**
 * Extract a buyer free-text note from a checkout message:
 * "note: leave at the gate", "add note — call when you arrive",
 * "delivery note: knock twice", "instructions: no onions". Returns null when
 * the message carries no explicit note marker (we NEVER guess — a plain
 * address line is not a note). Capped at 500 chars.
 */
export function extractBuyerNote(text: string): string | null {
  const m = /\b(?:note|add (?:a )?note|delivery note|instruction[s]?)\s*[:–—-]\s*([\s\S]+)$/i.exec(text ?? "");
  const note = m?.[1]?.trim();
  return note ? note.slice(0, 500) : null;
}
// === END W46 orders-p2 ===

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
function buildFulfillmentPrompt(items: CartLine[], subtotal: number, currency: string, fmt?: PriceFmt): string {
  const lines = [
    "🛒 *Your order*",
    ...itemizedLines(items, fmt),
    `Subtotal: ${(fmt ?? fmtMoney)(subtotal, currency)}`,
    "",
    "How would you like to receive your order?",
    "1️⃣ Pickup",
    "2️⃣ Delivery",
  ];
  if (fmt) lines.push("", DUAL_DISPLAY_FOOTER);
  return lines.join("\n");
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
  /** W17/F10: cash-on-delivery orders show a pay-on-receipt line instead. */
  paymentMethod?: "online" | "cod";
  trackingUrl: string;
  /** W46 uc-money (UC-15): optional tip prompt line (tenant opt-in). */
  tipPrompt?: string | null;
  /** W41 UC-5: dual-display price formatter (NGN + tenant display currency). */
  fmt?: PriceFmt;
}): string {
  const fmt = opts.fmt ?? fmtMoney;
  const lines: string[] = [
    opts.fulfillment === "delivery"
      ? `🧾 *Delivery Order ${opts.orderNumber}*`
      : `🧾 *Pickup Order ${opts.orderNumber}*`,
    ...itemizedLines(opts.items, opts.fmt),
  ];
  if (opts.fulfillment === "delivery") {
    if (opts.address) lines.push(`📍 Deliver to: ${opts.address}`);
    lines.push(`Subtotal: ${fmt(opts.subtotal, opts.currency)}`);
    lines.push(`Delivery fee${opts.deliveryZone ? ` (${opts.deliveryZone})` : ""}: ${fmt(opts.deliveryFee, opts.currency)}`);
  }
  if (opts.promo && opts.promo.discount > 0) {
    lines.push(`🏷️ Promo ${opts.promo.code}: −${fmt(opts.promo.discount, opts.currency)}`);
  }
  lines.push(`*Total: ${fmt(opts.total, opts.currency)}*`);
  // W46 uc-money (UC-15): tip prompt rides the shared summary (BOTH channels).
  if (opts.tipPrompt) lines.push(opts.tipPrompt);
  if (opts.promoError) lines.push(`⚠️ Promo not applied — ${opts.promoError}.`);
  if (opts.fulfillment === "pickup") lines.push("", "🏪 We'll message you when it's ready for pickup.");
  if (opts.paymentMethod === "cod") {
    lines.push("", `💵 *Cash on ${opts.fulfillment === "delivery" ? "delivery" : "pickup"}* — please have ${fmt(opts.total, opts.currency)} ready for the rider.`);
  } else if (opts.paymentUrl) {
    lines.push("", `💳 Click here to complete payment: ${opts.paymentUrl}`);
    lines.push("📱 No data? Dial *712*amount# to pay via MTN MoMo");
  }
  lines.push("", `🧾 Already paid by transfer? Send a photo/screenshot of your receipt here and we'll confirm it automatically.`);
  lines.push(`🔎 Track your order: ${opts.trackingUrl}`);
  // W41 UC-5: honest footer whenever a converted price was shown — the
  // charge itself stays in NGN.
  if (opts.fmt) lines.push("", DUAL_DISPLAY_FOOTER);
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
  /** W17/F10: 'cod' when the order is cash-on-delivery (no payment link). */
  paymentMethod?: "online" | "cod";
  /** Applied promo (code + discount in MAJOR units). */
  promo?: { code: string; discount: number } | null;
  /** Reject reason when a promo code was supplied but not applied. */
  promoError?: string | null;
  /** W27: aggregated courier quote snapshot (feeCents integer). */
  deliveryQuote?: { courier: string; quoteId: string; feeCents: number; etaMinutes: number; label: string } | null;
  /** W27: loyalty redemption applied at checkout (integer points/cents). */
  loyalty?: { points: number; discountCents: number; balanceAfter: number } | null;
  /** W41: buyer installment plan created for this order (payment link = down payment). */
  installment?: { planId: string; downPaymentCents: number; installments: number; totalCents: number } | null;
  // === W46 uc-ux (Coder E) ===
  /** UC-27: set when checkout was BLOCKED by the tenant minimum order value. */
  minOrderBlock?: import("../services/minOrder").MinOrderCheck;
  /** UC-24: gift wrap fee line charged on this order (integer cents). */
  giftWrapFeeCents?: number;
  /** UC-21: delivery slot booking outcome for this order. */
  slotBooking?: { booked: boolean; reason?: string };
  /** UC-17: venue table the order was placed from (QR deep link). */
  venueTable?: { tableId: string; label: string } | null;
  // === END W46 uc-ux ===
  /** === W46 privacy-consent (TEN-15): age gate blocked the order — the
   * buyer must attest to `requiredAge` before checkout proceeds. === */
  ageGate?: { requiredAge: number; restrictedProductIds: string[]; underage?: boolean; statedAge?: number } | null;
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
  lines.push("", "🔔 Reply *NOTIFY ME* and I'll message you the moment it's back in stock.");
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
    /** W17/F10: 'cod' creates a cash-on-delivery order (no payment link,
     * codState = cod_pending) instead of an online-payment order. */
    paymentMethod?: "online" | "cod";
    /** W27: buyer location pin — enables distance-priced courier quotes. */
    deliveryCoords?: { latitude: number; longitude: number } | null;
    /** W27: redeem loyalty points at checkout (discount capped per rules). */
    loyaltyRedeem?: boolean;
    /** W41: buyer chose installments — create a plan; the payment link
     * charges the DOWN PAYMENT only (adjacent checkout-caller seam; the
     * pinned paymentConfirm path settles it unchanged). */
    installments?: number | null;
    /** W41: buyer explicitly consented to save the card after paying. */
    saveCardConsent?: boolean;
    // === W46 uc-ux (Coder E) ===
    /** UC-24: gift options captured at checkout (wrap/message/recipient). */
    gift?: import("../services/giftOrders").GiftOptions;
    /** UC-21: pre-armed delivery slot id (buyer picked SLOT <n> earlier). */
    deliverySlotId?: string | null;
    // === END W46 uc-ux ===
    /** W46 orders-p2 (ORD-25): buyer free-text note captured at chat
     *  checkout ("note: leave at the gate") — persisted to orders.notes so
     *  the merchant sees it on the order. Capped at 500 chars. */
    buyerNote?: string | null;
    /** === W46 privacy-consent (TEN-15): buyer attested their age in this
     * checkout turn (affirmative reply verified by the caller). === */
    ageAttested?: boolean;
    /** === W47 buyer (ONB-B-1): the ACTUAL digits the buyer stated; the
     * gate compares them against requiredAge (truthful minors fail). === */
    ageAttestedAge?: number | null;
    /** W47 (ONB-TOCTOU-2): evidence wamid for the attestation row. */
    ageProofWamid?: string | null;
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

  // === W46 privacy-consent (TEN-15): age-restricted checkout gate ========
  // Runs BEFORE any order/payment link exists, on the single order-creation
  // seam shared by the WhatsApp, Telegram and LLM/agent checkout paths.
  // A durable attestation (age_attestations) covers returning buyers; an
  // in-turn affirmation (opts.ageAttested) is persisted as evidence.
  try {
    const { assertAgeGate } = await import("../services/ageGate");
    const gate = await assertAgeGate(db, {
      tenantId: opts.tenantId,
      phone: opts.waPhoneNumber,
      productIds: items.map((i) => i.productId),
      attested: opts.ageAttested === true,
      // W47 buyer (ONB-B-1): actual stated digits decide the verdict.
      attestedAge: opts.ageAttestedAge ?? null,
      source: "chat_reply",
      proofWamid: opts.ageProofWamid ?? null, // W47 (ONB-TOCTOU-2)
    });
    if (!gate.ok) {
      return {
        created: false,
        ageGate: { requiredAge: gate.requiredAge!, restrictedProductIds: gate.restrictedProductIds ?? [], underage: gate.underage === true, statedAge: gate.statedAge },
        currency: items[0].currency,
      };
    }
  } catch (e: unknown) {
    // Fail CLOSED on a gate lookup error only when the cart actually
    // contains restricted products is impossible to know here — so we
    // re-check cheaply; unrestricted carts proceed unaffected.
    console.error("[nlp] age gate check failed:", (e as Error)?.message);
    try {
      const { requiredAgeForProducts } = await import("../services/ageGate");
      const requirement = await requiredAgeForProducts(db, opts.tenantId, items.map((i) => i.productId));
      if (requirement) {
        return {
          created: false,
          ageGate: { requiredAge: requirement.requiredAge, restrictedProductIds: requirement.restrictedProductIds },
          currency: items[0].currency,
        };
      }
    } catch (e2: unknown) {
      console.error("[nlp] age gate re-check failed (allowing unrestricted cart only):", (e2 as Error)?.message);
    }
  }
  // === END W46 privacy-consent ===

  const subtotal = items.reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0);
  // === W46 uc-ux (Coder E): UC-27 minimum order guard =====================
  // Runs BEFORE any order/payment link exists — a below-minimum cart blocks
  // checkout with an additive prompt (both channels render the same text).
  {
    try {
      const { checkMinOrder } = await import("../services/minOrder");
      const minCheck = await checkMinOrder(db, {
        tenantId: opts.tenantId,
        fulfillment: opts.fulfillment,
        subtotalMajor: subtotal,
      });
      if (!minCheck.ok) {
        return { created: false, minOrderBlock: minCheck, currency: items[0].currency };
      }
    } catch (e: unknown) {
      console.error("[nlp] min-order guard failed (non-blocking):", (e as Error)?.message);
    }
  }
  // === END W46 uc-ux ===
  // ── W27: aggregated courier quote — cheapest of the tenant's enabled
  // courier adapters (distance-priced local dispatch when coordinates are
  // known), falling back to the honest zone rate. Non-blocking. ────────────
  let aggQuote: import("../services/delivery/service").AggregatedQuote | null = null;
  if (opts.fulfillment === "delivery") {
    try {
      const { quoteOrderDelivery } = await import("../services/delivery/service");
      const dc = opts.deliveryCoords ?? null;
      aggQuote = await quoteOrderDelivery(db, {
        tenantId: opts.tenantId,
        dropoffAddress: opts.address,
        ...(dc ? { dropoffLat: dc.latitude, dropoffLng: dc.longitude } : {}),
        orderValueCents: toMinorUnitsExact(subtotal),
      });
    } catch (e: unknown) {
      console.error("[nlp] aggregated delivery quote failed (non-blocking):", (e as Error)?.message);
    }
  }
  // === W45 orders-p0 (ORD-9): weight-aware, tenant-zone quoting ===
  // Sum the order weight (qty × products.weightKg; unknown-weight lines use
  // the 1kg floor) and load the tenant's configured delivery zones
  // (merchant_locations.deliveryZones — geo.ts) so the fallback quote prices
  // the ACTUAL parcel and the merchant's real zones instead of Lagos hints.
  let orderWeightKg = 0;
  let tenantDeliveryZones: { name: string }[] | null = null;
  if (opts.fulfillment === "delivery") {
    try {
      const weightRows = await db.select({ id: products.id, weightKg: products.weightKg })
        .from(products)
        .where(inArray(products.id, items.map((i) => i.productId)));
      const weightById = new Map(weightRows.map((r) => [r.id, Number(r.weightKg ?? 0)]));
      orderWeightKg = items.reduce((s, i) => {
        const w = weightById.get(i.productId);
        return s + i.quantity * (w && w > 0 ? w : 1);
      }, 0);
      const { merchantLocations } = await import("../../drizzle/schema");
      const [loc] = await db.select({ deliveryZones: merchantLocations.deliveryZones })
        .from(merchantLocations)
        .where(eq(merchantLocations.tenantId, opts.tenantId))
        .orderBy(desc(merchantLocations.createdAt))
        .limit(1);
      tenantDeliveryZones = (loc?.deliveryZones as { name: string }[] | null) ?? null;
    } catch (e: unknown) {
      console.warn("[nlp] weight/zone quote inputs failed (non-blocking):", (e as Error)?.message);
    }
  }
  // === END W45 orders-p0 ===
  const quote = aggQuote
    ? { fee: aggQuote.feeMajor, zone: aggQuote.zone ?? "same_city", carrier: aggQuote.label }
    : (opts.fulfillment === "delivery"
        ? quoteDeliveryFee({ address: opts.address, weightKg: orderWeightKg || undefined, deliveryZones: tenantDeliveryZones })
        : null);
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
  // ── W27: loyalty points redemption (optional, cap-enforced) ─────────────
  // Burn happens AFTER the order row commits (below); here we only preview
  // the discount so totals/payment link reflect it. Integer cents only.
  let loyaltyPreview: { points: number; discountCents: number } | null = null;
  if (opts.loyaltyRedeem) {
    try {
      const { getLoyaltyRules, getBalance, previewRedemption } = await import("../services/loyalty");
      const rules = await getLoyaltyRules(db, opts.tenantId);
      if (rules.enabled) {
        const balance = await getBalance(db, opts.tenantId, opts.waPhoneNumber);
        const preLoyaltyMinor = Math.max(0, toMinorUnitsExact(subtotal + deliveryFee) - (promoMeta ? toMinorUnitsExact(promoMeta.discount) : 0));
        const preview = previewRedemption(rules, balance, preLoyaltyMinor);
        if (preview.points > 0) {
          loyaltyPreview = { points: preview.points, discountCents: preview.discountCents };
        }
      }
    } catch (e: unknown) {
      console.error("[nlp] loyalty preview failed (non-blocking):", (e as Error)?.message);
    }
  }
  // === W46 uc-ux (Coder E): UC-24 gift-wrap fee line ======================
  // The tenant's configured wrap fee (integer cents) is an explicit fee line
  // folded into the charged total; 0/absent = no wrap charge.
  let giftWrapFeeCents = 0;
  if (opts.gift && (opts.gift.isGift || opts.gift.wrap)) {
    try {
      const { getGiftWrapFeeCents } = await import("../services/giftOrders");
      giftWrapFeeCents = opts.gift.wrap ? await getGiftWrapFeeCents(db, opts.tenantId) : 0;
    } catch (e: unknown) {
      console.error("[nlp] gift wrap fee lookup failed (non-blocking):", (e as Error)?.message);
      giftWrapFeeCents = 0;
    }
  }
  // === END W46 uc-ux ===
  const totalMinor = Math.max(0,
    toMinorUnitsExact(subtotal + deliveryFee)
    + giftWrapFeeCents
    - (promoMeta ? toMinorUnitsExact(promoMeta.discount) : 0)
    - (loyaltyPreview?.discountCents ?? 0));
  const total = Number(minorUnitsToString(totalMinor));
  const currency = items[0].currency;

  // ── Fraud gate: call /api/ml/predict before creating the order ──────
  try {
    const fraudResp = await fetch(`http://localhost:${process.env.PORT ?? 3000}/api/ml/predict`, {
      method: "POST",
      // === W34 otel-core === traceparent propagation on the internal ml call.
      headers: injectTraceHeaders({ "Content-Type": "application/json" }),
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
        codState: opts.paymentMethod === "cod" ? "cod_pending" : null,
        // === W46 uc-ux (Coder E): UC-24 gift order columns ===
        isGift: opts.gift?.isGift === true || opts.gift?.wrap === true,
        giftMessage: opts.gift?.message ?? null,
        giftRecipientPhone: opts.gift?.recipientPhone ?? null,
        giftWrapFeeCents,
        // === END W46 uc-ux ===
        shippingAddress: opts.address ? { raw: opts.address } : null,
        // === W46 orders-p2 (ORD-25): buyer free-text note → orders.notes ===
        notes: opts.buyerNote?.trim() ? opts.buyerNote.trim().slice(0, 500) : null,
        // === END W46 orders-p2 ===
        items: items.map(i => ({ productId: i.productId, name: i.productName, qty: i.quantity, price: i.unitPrice })),
        metadata: {
          fulfillment: opts.fulfillment,
          subtotal: subtotal.toFixed(2),
          deliveryFee: deliveryFee.toFixed(2),
          deliveryZone: quote?.zone ?? null,
          source: "whatsapp_chat",
          paymentMethod: opts.paymentMethod === "cod" ? "cod" : "online",
          ...(promoMeta ? { promo: promoMeta } : {}),
          // === W46 uc-ux (Coder E): UC-24 gift metadata (wrap fee line) ===
          ...(opts.gift && (opts.gift.isGift || opts.gift.wrap) ? {
            gift: { wrap: opts.gift.wrap === true, wrapFeeCents: giftWrapFeeCents, message: opts.gift.message ?? null, recipientPhone: opts.gift.recipientPhone ?? null },
          } : {}),
          // === END W46 uc-ux ===
          // W27: aggregated courier quote snapshot + loyalty redemption.
          ...(aggQuote ? {
            deliveryQuote: {
              courier: aggQuote.courier,
              quoteId: aggQuote.quoteId,
              feeCents: aggQuote.feeCents,
              etaMinutes: aggQuote.etaMinutes,
              label: aggQuote.label,
            },
          } : {}),
          ...(opts.deliveryCoords ? { deliveryCoords: opts.deliveryCoords } : {}),
          ...(loyaltyPreview ? {
            loyaltyRedemption: {
              points: loyaltyPreview.points,
              discountCents: loyaltyPreview.discountCents,
            },
          } : {}),
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

  // === W46 uc-ux (Coder E): UC-17 venue-table stamp + UC-21 slot claim ====
  // Adjacent post-commit seams — a failure here NEVER rolls back the order.
  let venueTable: { tableId: string; label: string } | null = null;
  try {
    const { attachVenueTableToOrder } = await import("../services/venueTables");
    venueTable = await attachVenueTableToOrder(db, { orderId, cartSessionId: opts.cartSessionId });
  } catch (e: unknown) {
    console.error("[nlp] venue-table attach failed (non-blocking):", (e as Error)?.message);
  }
  let slotBooking: ChatOrderResult["slotBooking"];
  if (opts.deliverySlotId && opts.fulfillment === "delivery") {
    try {
      const slotsSvc = await import("../services/deliverySlots");
      const booked = await slotsSvc.bookDeliverySlot(db, { tenantId: opts.tenantId, orderId, slotId: opts.deliverySlotId });
      slotBooking = booked;
      if (booked.booked) {
        // Courier booking seam (quote window recorded on order metadata).
        await slotsSvc.bookCourierForSlot(db, { tenantId: opts.tenantId, orderId, slotId: opts.deliverySlotId, dropoffAddress: opts.address ?? null });
      }
    } catch (e: unknown) {
      console.error("[nlp] delivery-slot booking failed (non-blocking):", (e as Error)?.message);
      slotBooking = { booked: false, reason: "error" };
    }
  }
  // === END W46 uc-ux ===

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

  // ── W27: burn the redeemed points only AFTER the order committed ────────
  // (a rolled-back order must never burn points). Idempotent per order.
  let loyaltyApplied: { points: number; discountCents: number; balanceAfter: number } | null = null;
  if (loyaltyPreview) {
    try {
      const { redeemPoints } = await import("../services/loyalty");
      const burn = await redeemPoints({
        tenantId: opts.tenantId,
        customerPhone: opts.waPhoneNumber,
        points: loyaltyPreview.points,
        reason: `Redeemed on order ${orderNumber}`,
        orderId,
      }, db);
      loyaltyApplied = { ...loyaltyPreview, balanceAfter: burn.balanceAfter };
    } catch (e: unknown) {
      // Balance changed since preview (concurrent burn) — the buyer pays full
      // price; the order total already reflects the discount, so log loudly.
      console.error(`[nlp] loyalty burn failed for order ${orderId}:`, (e as Error)?.message);
    }
  }
  const deliveryQuoteMeta = aggQuote
    ? { courier: aggQuote.courier, quoteId: aggQuote.quoteId, feeCents: aggQuote.feeCents, etaMinutes: aggQuote.etaMinutes, label: aggQuote.label }
    : null;

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

  // ── COD: enter the COD flow instead of taking online payment ─────────
  if (opts.paymentMethod === "cod") {
    try {
      const { codEvents } = await import("../../drizzle/schema");
      await db.insert(codEvents).values({
        id: crypto.randomUUID(),
        tenantId: opts.tenantId,
        orderId,
        fromState: null,
        toState: "cod_pending",
        actor: `customer:${opts.waPhoneNumber}`,
        note: "Chat order with cash on delivery",
      });
    } catch (e: unknown) {
      console.error("[nlp] cod event insert failed (non-blocking):", (e as Error)?.message);
    }
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
      paymentUrl: null,
      paymentMethod: "cod",
      promo,
      promoError,
      deliveryQuote: deliveryQuoteMeta,
      loyalty: loyaltyApplied,
      giftWrapFeeCents,
      slotBooking,
      venueTable,
    };
  }

  // ── W41 (UC-1): buyer installments — create the plan BEFORE the payment
  // link so the link charges the DOWN PAYMENT only. Adjacent checkout-caller
  // seam: paymentConfirm.ts is untouched; the pinned path settles the down
  // payment (escrow hold, stock commit, receipt) and the adjacent webhook
  // hook (runBuyerCreditWebhookHook) activates the plan. An installment
  // offer/eligibility failure NEVER blocks the order — fall back to full
  // payment honestly.
  let installment: ChatOrderResult["installment"] = null;
  let installmentDownRef: string | null = null;
  if (opts.installments != null) { // COD orders returned above — this is the online path
    try {
      const { createBuyerPlan } = await import("../services/buyerInstallments");
      const plan = await createBuyerPlan(db, {
        tenantId: opts.tenantId,
        orderId,
        buyerPhone: opts.waPhoneNumber,
        totalCents: totalMinor,
        currency,
        installments: opts.installments,
        saveCardConsent: opts.saveCardConsent === true,
      });
      installment = { planId: plan.planId, downPaymentCents: plan.downPaymentCents, installments: opts.installments, totalCents: totalMinor };
      installmentDownRef = plan.downPaymentRef;
      await db.update(orders).set({
        metadata: sql`COALESCE(${orders.metadata}, '{}'::jsonb) || ${JSON.stringify({
          installments: { planId: plan.planId, installments: opts.installments, totalCents: totalMinor, downPaymentCents: plan.downPaymentCents, status: "pending_down" },
        })}::jsonb`,
        updatedAt: new Date(),
      }).where(eq(orders.id, orderId)).catch((e: unknown) =>
        console.error("[nlp] order installment metadata failed (non-blocking):", (e as Error)?.message));
    } catch (e: unknown) {
      console.error(`[nlp] installment plan creation failed for order ${orderId} — falling back to full payment:`, (e as Error)?.message);
      installment = null;
      installmentDownRef = null;
    }
  }
  // Amount charged NOW (major units): the down payment for installment
  // orders, the full total otherwise. Integer cents → major via minor units.
  const chargeNowMajor = installment ? installment.downPaymentCents / 100 : total;

  // ── Initiate payment via the PLATFORM's own gateway (amount = total incl.
  // fee) — tenants no longer bring their own Paystack/Flutterwave keys.
  // Every order is charged to the platform's account; escrow (custodyMode
  // "psp") attributes the tenant's share to their wallet on release, and
  // tenants cash out via wallet.requestWithdrawal. Mirrors the same
  // provider-selection pattern already used by wallet.topUp.
  let paymentUrl: string | null = null;
  try {
    const provider: "paystack" | "flutterwave" | null = ENV.paystackSecretKey
      ? "paystack"
      : ENV.flwSecretKey
        ? "flutterwave"
        : null;
    if (provider) {
      const txId = installmentDownRef ?? crypto.randomUUID();
      const callbackUrl = `https://wa.me/${opts.waPhoneNumber}`;
      // Paystack rejects /transaction/initialize outright without an email —
      // WhatsApp customers never type one, so synthesize one from their phone
      // number against a real, resolvable domain (Paystack validates the
      // address format; a non-resolving placeholder domain like the old
      // "@wa.commerce" gets rejected with "Invalid Email Address Passed").
      const customerEmail = `${opts.waPhoneNumber.replace(/\D/g, "") || "customer"}@wa-app.newfire.app`;
      if (provider === "paystack") {
        const resp = await fetch("https://api.paystack.co/transaction/initialize", {
          method: "POST",
          headers: { Authorization: `Bearer ${ENV.paystackSecretKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ email: customerEmail, amount: Math.round(chargeNowMajor * 100), currency, reference: txId, callback_url: callbackUrl }),
        }).then(r => r.json()).catch((err: unknown) => { console.error(`[nlp] Paystack initialize request failed for order ${orderId}:`, (err as Error)?.message); return null; });
        if (resp && resp.status === false) {
          console.error(`[nlp] Paystack initialize rejected for order ${orderId}: ${resp.message ?? "unknown error"}`);
        }
        paymentUrl = resp?.data?.authorization_url ?? null;
      } else {
        const resp = await fetch("https://api.flutterwave.com/v3/payments", {
          method: "POST",
          headers: { Authorization: `Bearer ${ENV.flwSecretKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ tx_ref: txId, amount: chargeNowMajor, currency, redirect_url: callbackUrl, customer: { phone_number: opts.waPhoneNumber, email: customerEmail } }),
        }).then(r => r.json()).catch((err: unknown) => { console.error(`[nlp] Flutterwave initialize request failed for order ${orderId}:`, (err as Error)?.message); return null; });
        if (resp && resp.status === "error") {
          console.error(`[nlp] Flutterwave initialize rejected for order ${orderId}: ${resp.message ?? "unknown error"}`);
        }
        paymentUrl = resp?.data?.link ?? null;
      }
      await db.insert(paymentTransactions).values({
        id: txId,
        tenantId: opts.tenantId,
        orderId,
        provider,
        providerRef: txId,
        amount: chargeNowMajor.toFixed(2),
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
    deliveryQuote: deliveryQuoteMeta,
    loyalty: loyaltyApplied,
    installment,
    giftWrapFeeCents,
    slotBooking,
    venueTable,
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
9. If the customer wants to CANCEL an order they placed ("cancel my order", "cancel the order", "I don't want it anymore", "please cancel order #..."), use intent "cancel_order" — the system cancels it if it hasn't shipped and refunds any payment. Do NOT use "dispute" for plain cancellation requests.

RESPOND WITH JSON (no markdown):
{
  "reply": "<message to send to customer>",
  "intent": "browse|search|add_to_cart|remove_from_cart|view_cart|checkout|confirm_order|order_status|support|greeting|reorder|dispute|cancel_order|discover_nearby|browse_wholesale|join_group_deal|unknown",
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
  processMessage: internalProcedure
    .input(z.object({
     tenantId: z.string(),
     waPhoneNumber: z.string(),
     message: z.string().max(4096),
     customerName: z.string().optional(),
      ussdMode: z.boolean().optional(),
      // === W37 telegram === optional channel tag (default whatsapp). Only
      // affects the session-key computation below via sessionKeyFor; the
      // WhatsApp path is byte-equivalent (key == waPhoneNumber).
      channel: z.string().optional(),
      // === END W37 telegram ===
      // === W47 crosscutting (ONB-TOCTOU-2): inbound message id — stamped as
      // proofWamid on age attestations created at this turn. ===
      wamid: z.string().max(120).optional(),
      // === END W47 crosscutting ===
   }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      // === W27 catalog-ai (additive): merchant text fallback for AI listing
      // drafts — "PUBLISH <id8>" / "REJECT <id8>" resolves the merchant's
      // pending catalog_ai_drafts without touching the buyer NLP pipeline.
      if (/^\s*(publish|reject)\s+[0-9a-f]{8}\s*$/i.test(input.message ?? "")) {
        try {
          const { handleCatalogDraftTextCommand, isTenantStaffPhone } = await import("../services/catalogAI");
          if (await isTenantStaffPhone(db, input.tenantId, input.waPhoneNumber)) {
            const res = await handleCatalogDraftTextCommand({
              tenantId: input.tenantId,
              phone: input.waPhoneNumber,
              text: input.message,
            });
            if (res.handled) {
              return { reply: res.reply ?? "", intent: "catalog_draft", confidence: 1, state: "browse", language: "en", sessionId: "" };
            }
          }
        } catch (e: any) {
          console.warn("[nlp] catalog_draft command error:", e?.message);
        }
      }

      // 1. Upsert NLP session
      // === W37 telegram === channel-aware session key. For whatsapp (or an
      // absent channel) sessionKeyFor returns input.waPhoneNumber unchanged,
      // so the WA lookup/insert below is behavior-identical to pre-W37.
      // Telegram sessions key on `telegram:<chat_id>` so they never collide
      // with the WA identity of the same linked phone.
      const { sessionKeyFor } = await import("../services/channelIdentity");
      const sessionKey = sessionKeyFor(input.channel ?? "whatsapp", input.waPhoneNumber);
      // === END W37 telegram ===
      // === W47 buyer (ONB-B-6): cross-channel identity merge — resolve the
      // canonical buyer identity (E.164 phone when a Telegram chat explicitly
      // self-shared its phone) so orders / attestations / consent state merge
      // across WhatsApp + Telegram. Session/cart rows stay keyed by the
      // channel session key (routing); buyer-identity keys use buyerKey. ===
      let buyerKey = sessionKey;
      if ((input.channel ?? "whatsapp") !== "whatsapp") {
        try {
          const { resolveIdentity, channelFromSessionKey } = await import("../services/channelIdentity");
          const parsed = channelFromSessionKey(sessionKey);
          const identity = await resolveIdentity(db, input.tenantId, parsed.channel, parsed.id);
          if (identity.phoneE164) buyerKey = identity.phoneE164;
        } catch (e: any) {
          console.warn("[nlp] identity resolve failed (using channel key):", e?.message);
        }
      }
      // === END W47 buyer ===
      const existing = await db.select().from(nlpSessions)
        .where(and(eq(nlpSessions.tenantId, input.tenantId), eq(nlpSessions.waPhoneNumber, sessionKey)))
        .limit(1);

      const detectedLang = detectLanguage(input.message);
      let session = existing[0];

      // === W47 crosscutting (ONB-ID-3): recycled-number protection — a
      // session dormant longer than ONB_DORMANT_DAYS (default 90) must NOT
      // silently hand the prior owner's cart/consent/context to whoever now
      // holds the number. Wipe the session, expire the consent decision (so
      // the consent prompt re-fires), and start fresh. ===
      if (session?.lastActivityAt) {
        const dormantDays = Number.parseInt(process.env.ONB_DORMANT_DAYS ?? "", 10) || 90;
        const cutoff = Date.now() - dormantDays * 86_400_000;
        if (new Date(session.lastActivityAt as any).getTime() < cutoff) {
          const { resetDormantIdentity } = await import("../services/consent");
          await resetDormantIdentity(db, {
            tenantId: input.tenantId,
            phone: sessionKey,
            channel: input.channel ?? "whatsapp",
            lastActivityAt: new Date(session.lastActivityAt as any),
          });
          await db.delete(nlpSessions).where(eq(nlpSessions.id, session.id));
          session = undefined as any;
        }
      }
      // === END W47 crosscutting ===

      if (!session) {
        // === W47 buyer (ONB-B-10) + crosscutting (ONB-ID-2): single-winner insert — the UNIQUE index
        // on (tenantId, waPhoneNumber) (mig 0166) makes the race loser a
        // no-op; re-select to load the winner's row. ===
        const inserted = await db.insert(nlpSessions).values({
          id: crypto.randomUUID(),
          tenantId: input.tenantId,
          waPhoneNumber: sessionKey, // === W37 telegram === (== input.waPhoneNumber for whatsapp)
          customerName: input.customerName,
          language: detectedLang,
          state: "greeting",
          context: {},
          messageHistory: [],
          lastActivityAt: new Date(),
          createdAt: new Date(),
        }).onConflictDoNothing().returning();
        session = inserted[0] ?? (await db.select().from(nlpSessions)
          .where(and(eq(nlpSessions.tenantId, input.tenantId), eq(nlpSessions.waPhoneNumber, sessionKey)))
          .limit(1))[0];
        if (!session) throw new Error("nlp_sessions get-or-create failed after conflict re-select");
        // === END W47 buyer ===
      } else {
        // Update language if newly detected — === W47 buyer (ONB-B-12):
        // NEVER overwrite once the buyer picked a sticky locale via the
        // language picker; detection no longer flips mid-conversation. ===
        const { getStickyLocale } = await import("../services/i18n");
        const sticky = await getStickyLocale(input.tenantId, sessionKey).catch(() => null);
        if (detectedLang !== "english" && !sticky) {
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

          // W17/F10: cash-on-delivery intent at any checkout step sticks to
          // the session ("2 cash on delivery", "delivery, I go pay cash").
          if (/\b(cod|c\.o\.d|cash on delivery|pay on delivery|pay cash|cash when (i|una) receive)\b/i.test(text)) {
            stepCtx.paymentMethod = "cod";
          }

          // === W46 orders-p2 (ORD-25): buyer free-text note capture =======
          // "note: leave at the gate" / "add note — call when you arrive"
          // at any checkout step sticks to the session and is written to
          // orders.notes when the order is created (both channels — Telegram
          // runs the SAME processMessage path).
          {
            const captured = extractBuyerNote(text);
            if (captured) stepCtx.buyerNote = captured;
          }
          // === END W46 orders-p2 ===

          // W27: loyalty redemption intent at any checkout step ("redeem my
          // points", "2 delivery use points") sticks to the session like the
          // promo/COD capture above and is applied when the order is created.
          if (/\b(redeem|use)\b[^.]*\bpoints?\b|\bpoints?\s+(discount|don jazzy)?$/i.test(lower) && !/\b(balance|how many|check)\b/.test(lower)) {
            stepCtx.loyaltyRedeem = true;
          }

          // === W46 uc-ux (Coder E): UC-24 gift intent capture =============
          // "this is a gift", "gift wrap it", "send to 234… as a gift" sticks
          // gift options to the session; createChatOrder charges the wrap fee
          // line and stamps the order's gift columns. One-shot: consumed when
          // the order is created (deleted from stepCtx below).
          if (/\bgift\b/i.test(text)) {
            const recipient = text.match(/(?:send|ship|deliver)\s+(?:it\s+)?to\s*(\+?[\d][\d\s-]{7,16}\d)/i);
            stepCtx.gift = {
              isGift: true,
              wrap: /\bwrap(ped|ping)?\b/i.test(text),
              recipientPhone: recipient ? recipient[1].replace(/[\s-]/g, "") : null,
              message: null,
            };
          }
          // === END W46 uc-ux ===

          // W41 (UC-1): installment intent at any checkout step — "pay in 3",
          // "installments", "pay small small" sticks to the session and is
          // applied when the order is created (plan + down-payment link).
          {
            const m = lower.match(/\bpay\s+in\s+(\d+)\b/);
            if (m) {
              stepCtx.installments = Number(m[1]);
            } else if (/\binstallments?\b|\bpay small small\b|\blayaway\b/.test(lower) && !/\b(status|balance|left|remaining)\b/.test(lower)) {
              stepCtx.installments = 3; // default choice; plan validates eligibility
            }
            // Explicit save-card consent ("pay in 3 and save my card").
            if (/\bsave (my )?(card|card details)\b/.test(lower)) {
              stepCtx.saveCardConsent = true;
            }
          }

          const finalizeOrder = async (fulfillment: "pickup" | "delivery", address: string | null) => {
            const order = await createChatOrder(db, {
              tenantId: input.tenantId,
              // W47 buyer (ONB-B-6): canonical cross-channel buyer identity.
              waPhoneNumber: buyerKey,
              customerName: input.customerName,
              cartSessionId: activeCartId,
              fulfillment,
              address,
              promoCode: typeof stepCtx.promoCode === "string" ? stepCtx.promoCode : null,
              paymentMethod: stepCtx.paymentMethod === "cod" ? "cod" : "online",
              loyaltyRedeem: stepCtx.loyaltyRedeem === true,
              installments: typeof stepCtx.installments === "number" ? (stepCtx.installments as number) : null,
              saveCardConsent: stepCtx.saveCardConsent === true,
              // === W46 uc-ux (Coder E): UC-24 gift + UC-21 slot opts ===
              gift: (stepCtx.gift as import("../services/giftOrders").GiftOptions | undefined) ?? undefined,
              deliverySlotId: typeof stepCtx.deliverySlotId === "string" ? stepCtx.deliverySlotId : null,
              // === END W46 uc-ux ===
              // W46 orders-p2 (ORD-25): attach the captured buyer note.
              buyerNote: typeof stepCtx.buyerNote === "string" ? stepCtx.buyerNote : null,
              deliveryCoords: (() => {
                const dc = stepCtx.deliveryCoords as { latitude?: number; longitude?: number } | undefined;
                return typeof dc?.latitude === "number" && typeof dc?.longitude === "number"
                  ? { latitude: dc.latitude, longitude: dc.longitude }
                  : null;
              })(),
            });
            // === W46 uc-ux (Coder E): UC-27 min-order block ===============
            if (order.minOrderBlock) {
              const { minOrderBlockReply } = await import("../services/minOrder");
              return minOrderBlockReply(order.minOrderBlock, order.currency ?? "NGN", fulfillment);
            }
            // === END W46 uc-ux ===
            if (order.fraudBlocked) {
              return `⚠️ Your order could not be processed at this time. Please contact support for assistance. (Risk: ${order.riskLevel})`;
            }
            if (order.shortages?.length) {
              // No order, no payment link — tell the buyer what's missing,
              // and remember the products so "NOTIFY ME" can subscribe them.
              stepCtx.lastShortageProductIds = order.shortages.map((s) => s.productId);
              return buildShortageReply(order.shortages, order.availableItems ?? [], order.currency ?? "NGN");
            }
            if (!order.created) return "Your cart appears to be empty — what would you like to order?";
            stepCtx.fulfillment = fulfillment;
            stepCtx.lastOrderId = order.orderId;
            stepCtx.lastOrderNumber = order.orderNumber;
            // === W46 uc-ux (Coder E): consume one-shot gift/slot opts ======
            const w46Gift = (stepCtx.gift as import("../services/giftOrders").GiftOptions | undefined) ?? undefined;
            const w46SlotFailed = order.slotBooking && order.slotBooking.booked === false;
            delete stepCtx.gift;
            delete stepCtx.deliverySlotId;
            // === END W46 uc-ux ===
            if (order.loyalty) delete stepCtx.loyaltyRedeem; // W27: one-shot redeem flag consumed
            nextState = "payment";
            stepIntent = "confirm_order";
            stepOrderCard = { orderId: order.orderId!, orderNumber: order.orderNumber!, paymentUrl: order.paymentUrl ?? null };
            const summary = buildOrderSummary({
              fmt: (await dualFormatterFor(db, input.tenantId)) ?? undefined,
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
              paymentMethod: order.paymentMethod ?? "online",
              trackingUrl: trackingUrlFor(order.orderId!),
              // === W46 uc-money (UC-15): tip prompt (tenant opt-in) ===
              tipPrompt: order.paymentMethod === "cod" ? null
                : await (async () => {
                    try {
                      const { tipCheckoutPrompt } = await import("../services/tipping");
                      return await tipCheckoutPrompt(db, input.tenantId, order.currency ?? "NGN");
                    } catch { return null; }
                  })(),
              // === END W46 uc-money ===
            });
            // W41 (UC-1): installment plan — the link charges the down
            // payment only; explain the schedule honestly.
            if (order.installment) {
              delete stepCtx.installments; // one-shot flag consumed
              delete stepCtx.saveCardConsent;
              const inst = order.installment;
              const rest = inst.totalCents - inst.downPaymentCents;
              return summary +
                `\n📅 *Installment plan:* you're paying ${fmtMoney(inst.downPaymentCents / 100, order.currency ?? "NGN")} now` +
                ` and ${fmtMoney(rest / 100, order.currency ?? "NGN")} in ${inst.installments - 1} weekly payment${inst.installments - 1 === 1 ? "" : "s"}.` +
                `\nYour order ships once the plan is fully paid.`;
            }
            // W41: installment offer when eligible (merchant opt-in + threshold).
            if (stepCtx.paymentMethod !== "cod") {
              try {
                const { checkBuyerInstallmentEligibility, buildInstallmentOfferText } = await import("../services/buyerInstallments");
                const elig = await checkBuyerInstallmentEligibility(db, input.tenantId, Math.round((order.total ?? 0) * 100));
                if (elig.eligible) {
                  return summary + buildInstallmentOfferText(Math.round((order.total ?? 0) * 100), elig.config, order.currency ?? "NGN");
                }
              } catch { /* offer is best-effort */ }
            }
            // W27: annotate the loyalty redemption on the buyer's summary.
            if (order.loyalty && order.loyalty.points > 0) {
              return summary + `\n🎁 Redeemed ${order.loyalty.points} pts (−${fmtMoney(order.loyalty.discountCents / 100, order.currency ?? "NGN")}). Points balance: ${order.loyalty.balanceAfter}.`;
            }
            if (stepCtx.loyaltyRedeem === true) {
              return summary + `\n🎁 No loyalty points available to redeem yet — points vest when orders are delivered.`;
            }
            // === W46 uc-ux (Coder E): gift/slot/venue summary annotations ==
            {
              let annotated = summary;
              if (w46Gift && (w46Gift.isGift || w46Gift.wrap)) {
                const { giftSummaryLine } = await import("../services/giftOrders");
                annotated += giftSummaryLine(w46Gift, order.giftWrapFeeCents ?? 0, order.currency ?? "NGN");
              }
              if (order.slotBooking?.booked) {
                annotated += "\n📅 Your chosen delivery slot is booked for this order.";
              } else if (w46SlotFailed) {
                annotated += "\n⚠️ That delivery slot just filled up — reply SLOTS to pick another; this order will be scheduled as soon as possible.";
              }
              if (order.venueTable) {
                annotated += `\n🍽️ Order sent to the kitchen for *${order.venueTable.label}*.`;
              }
              return annotated;
            }
            // === END W46 uc-ux ===
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
                reply = "Great — delivery it is! 🛵 Please send me your full delivery address (street, area, city) — or tap the button below to share your location. 📍";
                // Native location request (interactive location_request_message).
                // Fire-and-forget: a send failure never blocks checkout — the
                // free-text address path above remains fully functional.
                void import("../services/waLocation")
                  .then(({ sendWhatsAppLocationRequest }) =>
                    sendWhatsAppLocationRequest(
                      input.tenantId,
                      input.waPhoneNumber,
                      "📍 Share your delivery location — or just type your full address here.",
                    ),
                  )
                  .catch((e: unknown) => console.error("[nlp] location request send failed:", (e as Error)?.message));
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

      // 3d. Back-in-stock waitlist commands — deterministic, no LLM needed.
      {
        const cmd = input.message.trim().toLowerCase();
        if (cmd === "notify me" || cmd === "stop") {
          const cmdCtx: Record<string, unknown> = (session.context as Record<string, unknown>) ?? {};
          let reply: string;
          if (cmd === "stop") {
            const removed = await unsubscribeFromWaitlist(db, input.tenantId, input.waPhoneNumber);
            reply = removed > 0
              ? "✅ Done — you won't get back-in-stock alerts anymore."
              : "You're not on any back-in-stock alerts.";
          } else {
            const ids = Array.isArray(cmdCtx.lastShortageProductIds)
              ? (cmdCtx.lastShortageProductIds as unknown[]).filter((x): x is string => typeof x === "string")
              : [];
            if (ids.length === 0) {
              reply = "Which product should I watch for you? Tell me the product name and I'll notify you when it's back.";
            } else {
              for (const productId of ids) {
                await subscribeToWaitlist(db, input.tenantId, productId, input.waPhoneNumber);
              }
              reply = "🔔 Got it — I'll message you the moment it's back in stock. Reply STOP to unsubscribe.";
            }
          }
          await db.update(nlpSessions).set({ context: cmdCtx, lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return {
            reply,
            intent: cmd === "stop" ? "waitlist_unsubscribe" : "waitlist_subscribe",
            state: session.state,
            language: session.language,
            sessionId: session.id,
            confidence: 1,
          };
        }
      }

      // 3f. W41 (UC-6/UC-1) buyer-credit commands — deterministic, no LLM.
      // "my cards" lists saved payment methods (never the raw token);
      // "remove card N" revokes; "buy again" is the one-tap reorder charged
      // to the saved token; "save card" confirms the consent prompt issued
      // at checkout. Parity: telegram buyers hit the SAME nlp.processMessage
      // via the W37 telegram seam, so these replies work on both channels.
      {
        const cmd = input.message.trim().toLowerCase();
        const cardsMatch = cmd === "my cards" || cmd === "saved cards" || cmd === "my card";
        const removeMatch = cmd.match(/^remove card(?:\s+(\d+))?$/);
        const saveMatch = cmd === "save card" || cmd === "save my card";
        const reorderMatch = cmd === "buy again" || cmd === "one tap reorder";
        if (cardsMatch || removeMatch || saveMatch || reorderMatch) {
          const creditCtx: Record<string, unknown> = (session.context as Record<string, unknown>) ?? {};
          let reply: string;
          const tokensSvc = await import("../services/customerPaymentTokens");
          if (cardsMatch) {
            const list = await tokensSvc.listCustomerTokens(db, input.tenantId, input.waPhoneNumber);
            creditCtx.lastTokenIds = list.map((t) => t.id);
            reply = list.length === 0
              ? "You have no saved cards. After your next card payment, reply SAVE CARD to save it for one-tap checkout and installments."
              : "💳 *Your saved cards:*\n" +
                list.map((t, i) => `${i + 1}. ${t.displayLabel ?? `${t.provider} card`}`).join("\n") +
                "\n\nReply REMOVE CARD <number> to remove one, or BUY AGAIN to reorder your last purchase with one tap.";
          } else if (removeMatch) {
            const list = await tokensSvc.listCustomerTokens(db, input.tenantId, input.waPhoneNumber);
            const idx = removeMatch[1] ? Number(removeMatch[1]) - 1 : 0;
            const target = list[idx];
            if (!target) {
              reply = list.length === 0
                ? "You have no saved cards to remove."
                : `That card number doesn't match — reply MY CARDS to see your ${list.length} saved card${list.length === 1 ? "" : "s"}.`;
            } else {
              const res = await tokensSvc.revokeCustomerToken(db, { tenantId: input.tenantId, buyerPhone: input.waPhoneNumber, tokenId: target.id });
              reply = res.ok
                ? `✅ Removed ${target.displayLabel ?? "card"} — it won't be charged again.`
                : "I couldn't remove that card just now — please try again.";
            }
          } else if (saveMatch) {
            // Consent confirm: save the reusable authorization from the
            // buyer's most recent successful card payment. Honest failure
            // when the provider returned no reusable handle.
            reply = "I couldn't find a recent card payment to save. Pay with your card first, then reply SAVE CARD.";
            const candidates = await db.select().from(paymentTransactions)
              .where(eq(paymentTransactions.tenantId, input.tenantId))
              .orderBy(sql`${paymentTransactions.createdAt} DESC`)
              .limit(20);
            for (const tx of candidates) {
              if (tx.status !== "completed" && tx.status !== "success") continue;
              const [ord] = await db.select().from(orders).where(eq(orders.id, tx.orderId ?? "")).limit(1);
              if (!ord || ord.customerId !== input.waPhoneNumber) continue;
              const saved = await tokensSvc.saveTokenFromPayment(db, {
                tenantId: input.tenantId,
                buyerPhone: input.waPhoneNumber,
                provider: tx.provider,
                reference: tx.providerRef ?? tx.id,
                consentText: tokensSvc.tokenConsentPrompt(null),
              });
              if (saved.ok) {
                reply = `✅ Saved ${saved.displayLabel ?? "your card"} for faster checkouts. Reply MY CARDS anytime to manage it.`;
              } else if (saved.error === "no_reusable_authorization") {
                reply = "Your last payment didn't return a reusable card authorization, so there's nothing I can save — your card details stay with the payment provider.";
              }
              break;
            }
          } else {
            // BUY AGAIN — one-tap reorder with the saved token. The message
            // IS the explicit tap; reorderWithToken charges the token
            // off-session and settles via the pinned confirm path.
            const [lastOrder] = await db.select().from(orders)
              .where(and(eq(orders.tenantId, input.tenantId), eq(orders.customerId, input.waPhoneNumber), eq(orders.paymentStatus, "completed")))
              .orderBy(sql`${orders.createdAt} DESC`)
              .limit(1);
            if (!lastOrder) {
              reply = "I couldn't find a previous paid order to repeat — tell me what you'd like and we'll start a fresh order.";
            } else {
              const list = await tokensSvc.listCustomerTokens(db, input.tenantId, input.waPhoneNumber);
              const token = list[0];
              if (!token) {
                reply = "You don't have a saved card yet — reply SAVE CARD after your next card payment, then BUY AGAIN works with one tap.";
              } else {
                const { reorderWithToken } = await import("../services/buyerInstallments");
                const res = await reorderWithToken(db, {
                  tenantId: input.tenantId,
                  buyerPhone: input.waPhoneNumber,
                  tokenId: token.id,
                  sourceOrderId: lastOrder.id,
                });
                reply = res.ok
                  ? res.status === "pending"
                    ? `⏳ Reorder ${res.orderNumber} placed — your saved ${token.displayLabel ?? "card"} is being charged ${fmtMoney((res.chargedCents ?? 0) / 100, lastOrder.currency)}. I'll confirm as soon as it clears.`
                    : `✅ Reorder ${res.orderNumber} confirmed — charged ${fmtMoney((res.chargedCents ?? 0) / 100, lastOrder.currency)} to your saved ${token.displayLabel ?? "card"}. 🔎 Track it: ${trackingUrlFor(res.orderId!)}`
                  : res.error === "reorder_already_charged"
                    ? "That reorder was already placed — check your orders with STATUS."
                    : `⚠️ I couldn't charge your saved card (${res.error ?? "charge failed"}). No money moved — try again or order the usual way.`;
              }
            }
          }
          await db.update(nlpSessions).set({ context: creditCtx, lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return {
            reply,
            intent: "buyer_credit",
            state: session.state,
            language: session.language,
            sessionId: session.id,
            confidence: 1,
          };
        }
      }

      // === W46 uc-ux (Coder E): 3h. UC-17/21/23 deterministic commands =====
      // No LLM. Parity: telegram buyers hit the SAME nlp.processMessage via
      // the W37 telegram seam, so these replies work on both channels.
      //   TABLE:<token>  — UC-17 venue-table QR deep link → cart metadata
      //   SLOTS / SLOT n — UC-21 delivery slot picker + arming
      //   SAVE <product> / MY LIST / REMOVE n — UC-23 wishlist
      {
        const ucCmd = input.message.trim();
        const ucLower = ucCmd.toLowerCase();
        const ucCtx: Record<string, unknown> = (session.context as Record<string, unknown>) ?? {};

        // UC-17: venue-table QR deep link (prefilled TABLE:<token> text).
        const tableMatch = ucCmd.match(/^TABLE:([A-Za-z0-9_-]{8,128})$/i);
        if (tableMatch) {
          const { seedCartFromTableQr } = await import("../services/venueTables");
          const seeded = await seedCartFromTableQr(db, {
            tenantId: input.tenantId,
            qrToken: tableMatch[1],
            waPhoneNumber: input.waPhoneNumber,
          });
          if (seeded && !session.cartSessionId) {
            session.cartSessionId = seeded.cartSessionId;
            cartSession = (await db.select().from(cartSessions).where(eq(cartSessions.id, seeded.cartSessionId)).limit(1))[0] ?? cartSession;
          }
          const reply = seeded
            ? `🍽️ You're ordering from *${seeded.tableLabel}*. Browse the menu and tell me what you'd like — I'll send it to your table!`
            : "Sorry, that table QR code isn't active — please ask the staff for help.";
          return { reply, intent: "venue_table_scan", state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }

        // UC-21: delivery slot picker (SLOTS lists, SLOT n arms for checkout).
        if (ucLower === "slots" || ucLower === "delivery slots") {
          const slotsSvc = await import("../services/deliverySlots");
          const slots = await slotsSvc.listAvailableSlots(db, input.tenantId);
          ucCtx.lastSlotIds = slots.map((s) => s.id);
          await db.update(nlpSessions).set({ context: ucCtx, lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return { reply: slotsSvc.formatSlotPicker(slots), intent: "delivery_slots", state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }
        const slotMatch = ucLower.match(/^slot\s+(\d+)$/);
        if (slotMatch) {
          const ids = Array.isArray(ucCtx.lastSlotIds) ? ucCtx.lastSlotIds as string[] : [];
          const picked = ids[Number(slotMatch[1]) - 1];
          let reply: string;
          if (picked) {
            ucCtx.deliverySlotId = picked;
            reply = "✅ Slot reserved for your next delivery order — complete checkout and I'll book it.";
          } else {
            reply = "That slot number doesn't match the list — reply SLOTS to see the available delivery slots first.";
          }
          await db.update(nlpSessions).set({ context: ucCtx, lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return { reply, intent: "delivery_slot_pick", state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }

        // UC-23: wishlist commands.
        const saveMatch = ucCmd.match(/^save(?:\s+this)?(?:\s+(.+))?$/i);
        const myListMatch = /^(my list|wishlist|my wishlist|saved items)$/.test(ucLower);
        const wishRemoveMatch = ucLower.match(/^remove\s+(\d+)$/);
        if (saveMatch || myListMatch || wishRemoveMatch) {
          const wishSvc = await import("../services/wishlists");
          let reply: string;
          if (myListMatch) {
            const list = await wishSvc.listWishlist(db, { tenantId: input.tenantId, phone: input.waPhoneNumber });
            reply = wishSvc.formatWishlist(list, (m, c) => fmtMoney(m, c));
          } else if (wishRemoveMatch) {
            const res = await wishSvc.removeWishlistEntry(db, { tenantId: input.tenantId, phone: input.waPhoneNumber, position: Number(wishRemoveMatch[1]) });
            reply = res.removed ? "✅ Removed from your wishlist." : "That number doesn't match your list — reply MY LIST to see it.";
          } else {
            const mention = saveMatch?.[1]?.trim() ?? "";
            if (!mention) {
              reply = "Tell me what to save — e.g. SAVE <product name> — and I'll keep it on your wishlist and alert you when the price drops. ❤️";
            } else {
              const prods = await db.select({ id: products.id, name: products.name, price: products.price, currency: products.currency, stockQuantity: products.stockQuantity })
                .from(products)
                .where(and(eq(products.tenantId, input.tenantId), eq(products.status, "active")));
              const match = matchCatalogItem(prods, mention);
              if (match.status === "matched") {
                const res = await wishSvc.saveToWishlist(db, { tenantId: input.tenantId, phone: input.waPhoneNumber, productId: match.product.id });
                reply = res.already
                  ? `${match.product.name} is already on your wishlist — I'll alert you when the price drops. ❤️`
                  : `❤️ Saved *${match.product.name}* to your wishlist. Reply MY LIST anytime; I'll message you if the price drops.`;
              } else if (match.status === "ambiguous") {
                reply = `Which one? ${match.candidates.map((c) => c.name).join(", ")} — reply SAVE <full name>.`;
              } else {
                reply = `I couldn't find "${mention}" in the catalog — try the exact product name.`;
              }
            }
          }
          return { reply, intent: "wishlist", state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }
      }
      // === END W46 uc-ux ===

      // 3e. Geospatial merchant discovery — deterministic, no LLM needed.
      // Free-text "…near me" searches (and category-menu replies after a pin
      // was shared) run discoverNearby centered on the session's
      // lastDiscovery pin, falling back to the saved deliveryCoords.
      {
        const { extractDiscoverQuery, resolveCategorySelection, formatDiscoveryMenu } =
          await import("../services/discoveryMenu");
        const { discoverNearby, listCategories, defaultRadiusKm } =
          await import("../services/geoDiscovery");
        const geoCtx: Record<string, unknown> = (session.context as Record<string, unknown>) ?? {};
        const lastDisc = geoCtx.lastDiscovery as { lat?: number; lng?: number; radiusKm?: number } | undefined;
        const hasPin = typeof lastDisc?.lat === "number" && typeof lastDisc?.lng === "number";
        const residual = extractDiscoverQuery(input.message);
        let category: string | null = null;
        if (residual == null && hasPin) {
          const cats = await listCategories(db).catch(() => [] as Awaited<ReturnType<typeof listCategories>>);
          category = resolveCategorySelection(input.message, cats);
        }
        if (residual != null || category != null) {
          let center: { lat: number; lng: number; radiusKm?: number } | null = null;
          if (hasPin) {
            center = { lat: lastDisc!.lat as number, lng: lastDisc!.lng as number, radiusKm: lastDisc!.radiusKm };
          } else {
            const dc = geoCtx.deliveryCoords as { latitude?: number; longitude?: number } | undefined;
            if (typeof dc?.latitude === "number" && typeof dc?.longitude === "number") {
              center = { lat: dc.latitude, lng: dc.longitude };
            }
          }
          let reply: string;
          if (!center) {
            reply = "To see businesses near you, tap 📎 → Location and share your current location.";
          } else {
            const result = await discoverNearby({
              lat: center.lat,
              lng: center.lng,
              radiusKm: center.radiusKm ?? defaultRadiusKm(),
              ...(category ? { category } : {}),
              ...(residual ? { query: residual } : {}),
            }, db);
            reply = formatDiscoveryMenu(result.items, result.radiusKm);
          }
          const geoHistory = [
            ...((session.messageHistory as Array<{ role: string; content: string }>).slice(-10)),
            { role: "user", content: input.message },
            { role: "assistant", content: reply },
          ].slice(-20);
          await db.update(nlpSessions).set({
            messageHistory: geoHistory,
            lastActivityAt: new Date(),
          }).where(eq(nlpSessions.id, session.id));
          await db.insert(agentEvents).values({
            id: crypto.randomUUID(),
            tenantId: input.tenantId,
            conversationId: session.id,
            eventType: "nlp_message",
            intentType: "discover_nearby",
            confidence: "1.000",
            escalated: false,
            model: "deterministic-geo-discovery",
            createdAt: new Date(),
          });
          return {
            reply,
            intent: "discover_nearby",
            state: session.state,
            language: session.language,
            sessionId: session.id,
            confidence: 1,
          };
        }
      }

      // 3f. W27 loyalty balance + verified review commands — deterministic,
      // no LLM needed.
      {
        const cmd = input.message.trim().toLowerCase();
        // ── POINTS / BALANCE / LOYALTY → points balance + earn hint ──────
        if (/^(points|points balance|loyalty|loyalty points|balance)$/.test(cmd)) {
          const { getBalance, getLoyaltyRules } = await import("../services/loyalty");
          const [rules, balance] = await Promise.all([
            getLoyaltyRules(db, input.tenantId),
            getBalance(db, input.tenantId, input.waPhoneNumber),
          ]);
          const reply = rules.enabled
            ? `🎁 You have *${balance} loyalty points*. Earn ${rules.pointsPerUnit} pt per ₦${Math.round(rules.unitValueCents / 100)} spent (points vest on delivery). Redeem at checkout with "redeem points" — up to ${rules.redemptionCapPercent}% off your order.`
            : `🎁 Loyalty rewards aren't active at this store right now.`;
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return {
            reply, intent: "loyalty_balance", state: session.state,
            language: session.language, sessionId: session.id, confidence: 1,
          };
        }
        // ── REDEEM POINTS (standalone) → sticks to the session like COD ──
        // The discount is computed at order creation (createChatOrder) under
        // the tenant's cap; this command only arms the session flag.
        if (/^(redeem|use)( my)? points$/.test(cmd)) {
          const w27Ctx: Record<string, unknown> = (session.context as Record<string, unknown>) ?? {};
          w27Ctx.loyaltyRedeem = true;
          await db.update(nlpSessions).set({ context: w27Ctx, lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return {
            reply: "👍 I'll apply your loyalty points to your next checkout (up to the store's cap). Send your order when ready!",
            intent: "loyalty_redeem_arm", state: session.state,
            language: session.language, sessionId: session.id, confidence: 1,
          };
        }
        // ── RATE <1-5> [text] / REVIEW <1-5> [text] → verified review ────
        const rateMatch = /^(?:rate|review)\s+([1-5])\b[:\-\s]*(.*)$/i.exec(input.message.trim());
        if (rateMatch) {
          const { createReview } = await import("../services/reviews");
          const w27Ctx: Record<string, unknown> = (session.context as Record<string, unknown>) ?? {};
          const lastOrderId = typeof w27Ctx.lastOrderId === "string" ? w27Ctx.lastOrderId : undefined;
          const rating = parseInt(rateMatch[1], 10);
          const reviewText = rateMatch[2]?.trim() || null;
          let reply: string;
          try {
            await createReview(db, {
              tenantId: input.tenantId,
              customerPhone: input.waPhoneNumber,
              rating,
              text: reviewText,
              ...(lastOrderId ? { orderId: lastOrderId } : {}),
            });
            reply = `⭐ Thanks for your ${rating}-star review${reviewText ? "" : ""}! It helps other buyers and the merchant improve.`;
          } catch (e: any) {
            reply = e?.code === "FORBIDDEN"
              ? `Sorry — reviews are only for verified purchases. Once your order is delivered you can rate your experience (e.g. "RATE 5 Great!").`
              : `Sorry, I couldn't save that review just now — please try again later.`;
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return {
            reply, intent: "review_submit", state: session.state,
            language: session.language, sessionId: session.id, confidence: 1,
          };
        }
      }
      // === W41 rma-fx (Coder C): 3g. Returns — buyer "RETURN ..." + merchant
      // "RMA APPROVE/REJECT <id>" — deterministic, no LLM (covers WA AND TG;
      // telegram inbound feeds through this same engine). ===
      {
        const trimmedMsg = input.message.trim();
        // ── Merchant decision: RMA APPROVE <id> / RMA REJECT <id> [note] ──
        const rmaCmd = /^rma\s+(approve|reject)\s+([0-9a-fA-F-]{8,36})\b[:\-\s]*(.*)$/i.exec(trimmedMsg);
        if (rmaCmd) {
          const { isTenantStaffPhone } = await import("../services/catalogAI");
          const isStaff = await isTenantStaffPhone(db, input.tenantId, input.waPhoneNumber).catch(() => false);
          let reply: string;
          if (!isStaff) {
            reply = "Sorry, only store staff can approve or reject returns.";
          } else {
            try {
              const { decideReturn } = await import("../services/rma");
              const rma = await decideReturn(db, {
                rmaId: rmaCmd[2],
                tenantId: input.tenantId,
                approve: rmaCmd[1].toLowerCase() === "approve",
                note: rmaCmd[3]?.trim() || undefined,
              });
              reply = `RMA ${rma.id.slice(0, 8)} ${rma.status} — the buyer has been notified.`;
            } catch (e: any) {
              reply = `Could not update that return: ${e?.message ?? "unknown error"}`;
            }
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return {
            reply, intent: "rma_decide", state: session.state,
            language: session.language, sessionId: session.id, confidence: 1,
          };
        }
        // ── Buyer: RETURN [order] [reason…] ──
        const returnCmd = /^return\b[\s:,-]*(.*)$/i.exec(trimmedMsg);
        if (returnCmd) {
          const rmaCtx: Record<string, unknown> = (session.context as Record<string, unknown>) ?? {};
          let reply: string;
          try {
            const { rma, orderNumber } = await requestReturn(db, {
              tenantId: input.tenantId,
              buyerRef: input.waPhoneNumber,
              orderId: typeof rmaCtx.lastOrderId === "string" ? rmaCtx.lastOrderId : null,
              reason: returnCmd[1]?.trim() || "buyer requested return",
              requestedVia: "whatsapp",
            });
            reply = `📦 Got it — your return request for order ${orderNumber} is in ` +
              `(ref ${rma.id.slice(0, 8)}). The merchant will review it and we'll message you here ` +
              `as soon as it's approved or rejected.`;
          } catch (e: any) {
            reply = e?.code === "NOT_FOUND"
              ? "I couldn't find an order on this number to return — please share your order number."
              : e?.code === "CONFLICT"
                ? (e?.message ?? "There is already an open return for this order.")
                : `Sorry, I couldn't start that return just now (${e?.message ?? "unknown error"}).`;
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return {
            reply, intent: "rma_request", state: session.state,
            language: session.language, sessionId: session.id, confidence: 1,
          };
        }
      }
      // === END W41 rma-fx ===
      // === W43 dispatch (Coder C): post-dispatch address change — buyer
      // "change my address …" (BOTH channels; telegram inbound feeds this
      // same engine) + merchant decision via typed command ("ADDR APPROVE
      // <id>") or approval-card callback ids ("addrchg:approve:<id>" — TG
      // callback_query dispatches the id here as text; the WA interactive
      // branch in server/_core/index.ts resolves the same ids). ===
      {
        const trimmedMsg = input.message.trim();
        // ── Merchant decision: card callback id or typed ADDR command ──
        const cb = /^addrchg:(approve|reject):([0-9a-fA-F-]{36})\s*$/i.exec(trimmedMsg);
        const typed = /^addr\s+(approve|reject)\s+([0-9a-fA-F-]{8,36})\b[:\-\s]*(.*)$/i.exec(trimmedMsg);
        const decideMatch = cb ?? typed;
        if (decideMatch) {
          const { isTenantStaffPhone } = await import("../services/catalogAI");
          // TG merchant: session key "telegram:<chatId>" → linked staff phone.
          let staffRef = input.waPhoneNumber;
          if (/^telegram:/i.test(staffRef)) {
            const chatId = staffRef.replace(/^telegram:/i, "");
            const [ident] = await db.select({ phone: telegramIdentities.phoneE164 })
              .from(telegramIdentities)
              .where(and(eq(telegramIdentities.tenantId, input.tenantId), eq(telegramIdentities.chatId, chatId)))
              .limit(1).catch(() => [] as any[]);
            if (ident?.phone) staffRef = ident.phone;
          }
          const isStaff = await isTenantStaffPhone(db, input.tenantId, staffRef).catch(() => false);
          let reply: string;
          if (!isStaff) {
            reply = "Sorry, only store staff can approve or reject address changes.";
          } else {
            try {
              const { decideAddressChange } = await import("../services/addressChange");
              const decided = await decideAddressChange(db, {
                requestId: decideMatch[2],
                tenantId: input.tenantId,
                approve: decideMatch[1].toLowerCase() === "approve",
                decidedBy: input.waPhoneNumber,
                note: typed?.[3]?.trim() || undefined,
              });
              reply = `Address change ${decided.id.slice(0, 8)} ${decided.status} — the customer has been notified.`;
            } catch (e: any) {
              reply = `Could not update that address change: ${e?.message ?? "unknown error"}`;
            }
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return {
            reply, intent: "address_change_decide", state: session.state,
            language: session.language, sessionId: session.id, confidence: 1,
          };
        }
        // ── Buyer: change my address [to …] ──
        const addrCmd = /^(?:change|update|edit)\s+(?:my\s+)?(?:delivery\s+|shipping\s+)?address\b[\s:,-]*(.*)$/i.exec(trimmedMsg);
        if (addrCmd) {
          let reply: string;
          const remainder = (addrCmd[1] ?? "").replace(/^(?:to|as)\s+/i, "").trim();
          if (!remainder) {
            reply = "Sure — please send the new delivery address in one message, e.g. \"change my address to 12 Adeola Odeku St, Victoria Island, Lagos\". (Only orders already out for delivery can be changed.)";
          } else {
            try {
              const { requestAddressChange, parseAddressFromText } = await import("../services/addressChange");
              // buyerRef: E.164 phone (WA) or "telegram:<chatId>" session key
              // (TG) — the service resolves linked phones either way.
              const { req, orderNumber } = await requestAddressChange(db, {
                tenantId: input.tenantId,
                buyerRef: input.waPhoneNumber,
                newAddress: parseAddressFromText(remainder),
                requestedBy: "customer",
              });
              reply = `📍 Got it — your address change for order ${orderNumber} is pending merchant approval ` +
                `(ref ${req.id.slice(0, 8)}). We'll message you here as soon as it's approved or rejected.` +
                (req.feeCents > 0 ? ` A fee of ₦${(req.feeCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} applies on approval.` : "");
            } catch (e: any) {
              reply = e?.code === "FORBIDDEN"
                ? "Sorry, this store doesn't allow address changes after dispatch."
                : e?.code === "CONFLICT"
                  ? (e?.message ?? "There is already a pending address change for this order.")
                  : e?.code === "NOT_FOUND"
                    ? "I couldn't find an order out for delivery on this number — address changes are only possible once your order is on its way."
                    : `Sorry, I couldn't start that address change just now (${e?.message ?? "unknown error"}).`;
            }
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return {
            reply, intent: "address_change_request", state: session.state,
            language: session.language, sessionId: session.id, confidence: 1,
          };
        }
      }
      // === END W43 dispatch ===
      // === W44 giftcards-referrals (Coder A): gift-card + referral chat
      // commands — deterministic, no LLM (BOTH channels: telegram inbound
      // feeds this same engine; waPhoneNumber is the session key, E.164 on
      // WA and "telegram:<chatId>" on TG). ===
      {
        const trimmedMsg = input.message.trim();
        const w44Ctx: Record<string, unknown> = (session.context as Record<string, unknown>) ?? {};
        /** TG session keys resolve to the linked E.164 phone when bound. */
        const resolveCustomerRef = async (): Promise<string> => {
          const ref = input.waPhoneNumber;
          if (/^telegram:/i.test(ref)) {
            const chatId = ref.replace(/^telegram:/i, "");
            const [ident] = await db.select({ phone: telegramIdentities.phoneE164 })
              .from(telegramIdentities)
              .where(and(eq(telegramIdentities.tenantId, input.tenantId), eq(telegramIdentities.chatId, chatId)))
              .limit(1).catch(() => [] as any[]);
            if (ident?.phone) return ident.phone;
          }
          return ref;
        };
        const w44Return = async (reply: string, intent: string) => {
          await db.update(nlpSessions).set({ context: w44Ctx, lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return { reply, intent, state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        };

        // ── GIFT CARD BALANCE [CODE] ──
        const gcBal = /^gift\s?card\s+balance(?:\s+([A-Za-z0-9-]{4,64}))?$/i.exec(trimmedMsg);
        if (gcBal) {
          const { getGiftCardBalance, fmtNaira } = await import("../services/giftCards");
          const code = (gcBal[1] ?? (typeof w44Ctx.lastGiftCardCode === "string" ? w44Ctx.lastGiftCardCode : "")).toUpperCase();
          let reply: string;
          if (!code) {
            reply = "Please send the card code, e.g. GIFT CARD BALANCE GC-ABCD-1234.";
          } else {
            const bal = await getGiftCardBalance(input.tenantId, code, db);
            if (!bal) {
              reply = `I couldn't find a gift card with code ${code} — please double-check the code.`;
            } else {
              w44Ctx.lastGiftCardCode = code;
              reply = `🎁 Gift card *${code}*\nBalance: ${fmtNaira(bal.balanceCents, bal.currency)}\nStatus: ${bal.status}` +
                (bal.expiresAt ? `\nExpires: ${bal.expiresAt.toISOString().slice(0, 10)}` : "") +
                (bal.status === "active" || bal.status === "redeemed_partially"
                  ? `\nRedeem it on your next order with "USE GIFT CARD ${code}".` : "");
            }
          }
          return w44Return(reply, "gift_card_balance");
        }

        // ── USE/REDEEM/PAY WITH GIFT CARD <CODE> → apply to the session's
        // last unpaid order (claim-first, idempotent per order+code) ──
        const gcUse = /^(?:use|redeem|pay\s+with)\s+gift\s?card\s+([A-Za-z0-9-]{4,64})$/i.exec(trimmedMsg);
        if (gcUse) {
          const { applyGiftCardToOrder, fmtNaira } = await import("../services/giftCards");
          const code = gcUse[1]!.toUpperCase();
          w44Ctx.lastGiftCardCode = code;
          const orderId = typeof w44Ctx.lastOrderId === "string" ? w44Ctx.lastOrderId : null;
          let reply: string;
          if (!orderId) {
            reply = "You don't have an open checkout right now — start an order first, then say USE GIFT CARD <code> when I send the payment summary.";
          } else {
            const [ord] = await db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.tenantId, input.tenantId))).limit(1);
            if (!ord || (ord.paymentStatus !== "unpaid" && ord.paymentStatus !== "initiated")) {
              reply = "That order isn't awaiting payment anymore. Start a new order to use your gift card.";
            } else {
              const customerRef = await resolveCustomerRef();
              const res = await applyGiftCardToOrder(input.tenantId, code, orderId, { customerRef, db });
              if (!res.ok) {
                reply = res.error === "insufficient_funds"
                  ? `⚠️ That gift card couldn't cover any of this order (${res.error}).`
                  : res.error === "gift_card_not_found"
                    ? `I couldn't find a gift card with code ${code} — please double-check it.`
                    : `⚠️ I couldn't redeem that gift card (${res.error ?? "unknown error"}). No money moved.`;
              } else {
                const [cur] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
                const totalCents = Math.round(parseFloat(String(cur?.totalAmount ?? "0")) * 100);
                const curr = cur?.currency ?? "NGN";
                reply = `🎁 Applied ${fmtNaira(res.appliedCents, curr)} from gift card *${res.code}* to order ${ord.orderNumber}.` +
                  (res.remainderCents > 0
                    ? `\nRemaining to pay: ${fmtNaira(res.remainderCents, curr)} of ${fmtNaira(totalCents, curr)} — I'll send a payment link for the rest.`
                    : `\n✅ That covers the whole ${fmtNaira(totalCents, curr)} — your order is PAID. Thank you!`) +
                  `\nCard balance left: ${fmtNaira(res.balanceCents ?? 0, curr)}.`;
                if (res.remainderCents > 0 && res.orderPaidInFull !== true) {
                  // PSP remainder via the EXISTING provider chain (payment_link
                  // parity category; telegram gets a URL inline button).
                  try {
                    const { initiateWithFallback } = await import("../services/payments/initiateWithFallback");
                    const ref = `GCR-${Date.now()}-${orderId.slice(0, 8).toUpperCase()}`;
                    const outcome = await initiateWithFallback(input.tenantId, {
                      tenantId: input.tenantId,
                      amountCents: res.remainderCents,
                      currency: curr,
                      reference: ref,
                      metadata: { kind: "gift_card_remainder", orderId, giftCardCode: res.code },
                      customer: { phone: customerRef.replace(/^telegram:/i, "") },
                    });
                    const url = outcome.result.authorizationUrl;
                    if (url) {
                      await db.insert(paymentIntents).values({
                        id: crypto.randomUUID(),
                        tenantId: input.tenantId,
                        orderId,
                        customerId: customerRef.slice(0, 36),
                        amount: (res.remainderCents / 100).toFixed(2),
                        currency: curr,
                        provider: "paystack",
                        providerPaymentId: ref,
                        idempotencyKey: `giftcard-remainder:${ref}`,
                        metadata: { kind: "gift_card_remainder", orderId, giftCardCode: res.code },
                      });
                      reply += `\n💳 Pay the remainder: ${url}`;
                    }
                  } catch (e: any) {
                    console.warn("[nlp] gift-card remainder link failed:", e?.message);
                  }
                }
              }
            }
          }
          return w44Return(reply, "gift_card_redeem");
        }

        // ── MY REFERRAL CODE ──
        if (/^my referral( code)?$/i.test(trimmedMsg)) {
          const { getOrCreateReferralCode } = await import("../services/referrals");
          const customerRef = await resolveCustomerRef();
          const codeRow = await getOrCreateReferralCode(input.tenantId, customerRef, db);
          const reply = `📣 Your referral code is *${codeRow.code}* — share it with friends! When a friend's first order is paid, you earn store credit (if this store's program is on). Friends enter it here with "USE REFERRAL ${codeRow.code}".`;
          return w44Return(reply, "referral_code");
        }

        // ── USE REFERRAL <CODE> / REFERRAL CODE <CODE> → attribute (first
        // order only; self-referral rejected; one attribution per referee) ──
        const refUse = /^(?:use\s+)?referral(?:\s+code)?\s+([A-Za-z0-9-]{4,64})$/i.exec(trimmedMsg);
        if (refUse) {
          const { attributeReferral } = await import("../services/referrals");
          const customerRef = await resolveCustomerRef();
          const res = await attributeReferral(input.tenantId, { code: refUse[1]!, refereeCustomerId: customerRef }, db);
          const reply = res.ok
            ? res.duplicate
              ? "You're already linked to a referral code — one referral per person. Your reward tracks your first paid order."
              : `✅ Referral code ${refUse[1]!.toUpperCase()} linked to you — it counts when your first order is paid. Happy shopping!`
            : res.error === "self_referral_rejected"
              ? "Sorry — you can't use your own referral code. Share it with a friend instead!"
              : res.error === "referee_not_first_order"
                ? "Referral codes can only be linked before your first paid order."
                : res.error === "referral_code_not_found"
                  ? "I couldn't find that referral code — please double-check it with your friend."
                  : `⚠️ I couldn't link that referral code (${res.error ?? "unknown error"}).`;
          return w44Return(reply, "referral_attribute");
        }
      }
      // === END W44 giftcards-referrals ===
      // === W44 preorders-offers (Coder B): haggling / custom offers — buyer
      // "I'll pay X for Y" (BOTH channels; telegram inbound feeds this same
      // engine), merchant decision via card callback ids
      // ("offer:accept|reject|counter:<id>") or typed commands ("OFFER ACCEPT
      // <id>" / "OFFER REJECT <id> [note]" / "OFFER COUNTER <id> <amount>"),
      // customer counter response via "offer:caccept|cdecline:<id>" or typed
      // "ACCEPT OFFER <id>" / "DECLINE OFFER <id>". ===
      {
        const trimmedMsg = input.message.trim();
        // ── Merchant decision: card callback or typed OFFER command ──
        const offerCb = /^offer:(accept|reject|counter):([0-9a-fA-F-]{8,36})\s*$/i.exec(trimmedMsg);
        const offerTyped = /^offer\s+(accept|reject|counter)\s+([0-9a-fA-F-]{8,36})\b[:\-\s]*(.*)$/i.exec(trimmedMsg);
        const offerDecision = offerCb ?? offerTyped;
        if (offerDecision) {
          const { isTenantStaffPhone } = await import("../services/catalogAI");
          // TG merchant: session key "telegram:<chatId>" → linked staff phone.
          let staffRef = input.waPhoneNumber;
          if (/^telegram:/i.test(staffRef)) {
            const chatId = staffRef.replace(/^telegram:/i, "");
            const [ident] = await db.select({ phone: telegramIdentities.phoneE164 })
              .from(telegramIdentities)
              .where(and(eq(telegramIdentities.tenantId, input.tenantId), eq(telegramIdentities.chatId, chatId)))
              .limit(1).catch(() => [] as any[]);
            if (ident?.phone) staffRef = ident.phone;
          }
          const isStaff = await isTenantStaffPhone(db, input.tenantId, staffRef).catch(() => false);
          let reply: string;
          if (!isStaff) {
            reply = "Sorry, only store staff can respond to offers.";
          } else {
            const action = offerDecision[1].toLowerCase() as "accept" | "reject" | "counter";
            const remainder = offerTyped?.[3]?.trim() ?? "";
            let counterPriceCents: number | null = null;
            if (action === "counter") {
              const amt = /([\d,]+(?:\.\d{1,2})?)/.exec(remainder);
              counterPriceCents = amt ? Math.round(Number(amt[1].replace(/,/g, "")) * 100) : null;
              if (!counterPriceCents) {
                await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
                return {
                  reply: `To counter, type OFFER COUNTER ${offerDecision[2]} <amount> — e.g. OFFER COUNTER ${offerDecision[2]} 4800.`,
                  intent: "offer_decide", state: session.state,
                  language: session.language, sessionId: session.id, confidence: 1,
                };
              }
            }
            try {
              const { decideOffer } = await import("../services/customOffers");
              const decided = await decideOffer(db, {
                offerId: offerDecision[2],
                tenantId: input.tenantId,
                action,
                counterPriceCents,
                decidedBy: input.waPhoneNumber,
                note: action === "reject" ? remainder || undefined : undefined,
              });
              reply = decided.status === "accepted"
                ? `Offer ${decided.id.slice(0, 8)} accepted — the customer got a priced checkout link.`
                : decided.status === "countered"
                  ? `Counter of ₦${((decided.counterPriceCents ?? 0) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} sent to the customer for offer ${decided.id.slice(0, 8)}.`
                  : `Offer ${decided.id.slice(0, 8)} ${decided.status} — the customer has been notified.`;
            } catch (e: any) {
              reply = `Could not update that offer: ${e?.message ?? "unknown error"}`;
            }
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return {
            reply, intent: "offer_decide", state: session.state,
            language: session.language, sessionId: session.id, confidence: 1,
          };
        }
        // ── Customer counter-offer response: card callback or typed ──
        const counterCb = /^offer:(caccept|cdecline):([0-9a-fA-F-]{8,36})\s*$/i.exec(trimmedMsg);
        const counterTyped = /^(accept|decline)\s+offer\s+([0-9a-fA-F-]{8,36})\s*$/i.exec(trimmedMsg);
        if (counterCb ?? counterTyped) {
          const accept = counterCb ? counterCb[1].toLowerCase() === "caccept" : counterTyped![1].toLowerCase() === "accept";
          const idRef = (counterCb ?? counterTyped)![2];
          let reply: string;
          try {
            const { respondToCounter } = await import("../services/customOffers");
            const decided = await respondToCounter(db, {
              offerId: idRef,
              tenantId: input.tenantId,
              customerRef: input.waPhoneNumber,
              accept,
            });
            reply = decided.status === "accepted"
              ? "Deal! Your payment link is on its way here."
              : decided.status === "rejected"
                ? "Okay — that offer is closed. You can make a new one any time."
                : `That offer is ${decided.status} now.`;
          } catch (e: any) {
            reply = `Could not update that offer: ${e?.message ?? "unknown error"}`;
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return {
            reply, intent: "offer_counter_response", state: session.state,
            language: session.language, sessionId: session.id, confidence: 1,
          };
        }
        // ── Buyer makes an offer: "I'll pay 4500 for Ankara fabric" ──
        const offerCmd = /^(?:i'?ll\s+pay|i\s+can\s+pay|i\s+offer|my\s+offer\s+is|offer)\s*(?:₦|n(?:gn)?)?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:kobo)?\s+(?:for|on)\s+(.+)$/i.exec(trimmedMsg);
        if (offerCmd) {
          const rawAmt = Number(offerCmd[1].replace(/,/g, ""));
          // "kobo" suffix means the amount is already in minor units.
          const offeredPriceCents = /kobo/i.test(offerCmd[0]) ? Math.round(rawAmt) : Math.round(rawAmt * 100);
          let productText = offerCmd[2].trim();
          let qty = 1;
          const qtyM = /(?:^|\s)(?:x\s*(\d+)|(\d+)\s*x)$/i.exec(productText);
          if (qtyM) {
            qty = Number(qtyM[1] ?? qtyM[2]);
            productText = productText.replace(qtyM[0], "").trim();
          }
          let reply: string;
          try {
            const { makeOffer } = await import("../services/customOffers");
            const { offer, productName } = await makeOffer(db, {
              tenantId: input.tenantId,
              customerRef: input.waPhoneNumber,
              productName: productText,
              qty,
              offeredPriceCents,
            });
            reply = `🤝 Got it — your offer of ₦${(offeredPriceCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} for ${qty} × ${productName} ` +
              `is with the store (ref ${offer.id.slice(0, 8)}). We'll message you here as soon as they respond.`;
          } catch (e: any) {
            reply = e?.code === "CONFLICT"
              ? (e?.message ?? "You already have an open offer for that product.")
              : e?.code === "NOT_FOUND"
                ? "I couldn't find that product in this store — check the name and try again."
                : (e?.message ?? `Sorry, I couldn't place that offer just now (${e?.message ?? "unknown error"}).`);
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return {
            reply, intent: "offer_request", state: session.state,
            language: session.language, sessionId: session.id, confidence: 1,
          };
        }
      }
      // === END W44 preorders-offers ===
      // === W44 deposits-subs-digital (Coder C): appointments (book/cancel/
      // merchant complete+no-show), subscription pause/resume/cancel, digital
      // PIN reveal. BOTH channels — telegram inbound feeds this same engine;
      // customerRef is the E.164 phone (WA) or "telegram:<chatId>" session key. ===
      {
        const trimmedMsg = input.message.trim();

        // ── Merchant: APPT COMPLETE <id8> / APPT NOSHOW <id8> ──
        const apptAdmin = /^appt\s+(complete|noshow|no-show)\s+([0-9a-fA-F-]{8,36})\s*$/i.exec(trimmedMsg);
        if (apptAdmin) {
          const { isTenantStaffPhone } = await import("../services/catalogAI");
          let staffRef = input.waPhoneNumber;
          if (/^telegram:/i.test(staffRef)) {
            const chatId = staffRef.replace(/^telegram:/i, "");
            const [ident] = await db.select({ phone: telegramIdentities.phoneE164 })
              .from(telegramIdentities)
              .where(and(eq(telegramIdentities.tenantId, input.tenantId), eq(telegramIdentities.chatId, chatId)))
              .limit(1).catch(() => [] as any[]);
            if (ident?.phone) staffRef = ident.phone;
          }
          const isStaff = await isTenantStaffPhone(db, input.tenantId, staffRef).catch(() => false);
          let reply: string;
          if (!isStaff) {
            reply = "Sorry, only store staff can manage appointments.";
          } else {
            try {
              const { serviceAppointments } = await import("../../drizzle/schema");
              const matches = await db.select({ id: serviceAppointments.id }).from(serviceAppointments)
                .where(and(eq(serviceAppointments.tenantId, input.tenantId),
                  sql`CAST(${serviceAppointments.id} AS text) LIKE ${apptAdmin[2].toLowerCase() + "%"}`))
                .limit(2);
              if (matches.length !== 1) {
                reply = matches.length === 0
                  ? "No appointment with that reference — check the id."
                  : "That reference is ambiguous — send more characters of the id.";
              } else if (/^complete$/i.test(apptAdmin[1])) {
                const { completeAppointment } = await import("../services/appointments");
                const r = await completeAppointment(db, { tenantId: input.tenantId, appointmentId: matches[0]!.id, actorId: staffRef });
                reply = `Appointment ${matches[0]!.id.slice(0, 8)} completed — ` +
                  (r.remainder === "wallet" ? "remainder charged from the customer's wallet."
                    : r.remainder === "link" ? "remainder payment link sent to the customer."
                      : r.remainder === "failed" ? "⚠️ the remainder could not be collected yet."
                        : "no remainder due.");
              } else {
                const { markNoShow } = await import("../services/appointments");
                await markNoShow(db, { tenantId: input.tenantId, appointmentId: matches[0]!.id, actorId: staffRef });
                reply = `Appointment ${matches[0]!.id.slice(0, 8)} marked no-show — deposit kept, customer notified.`;
              }
            } catch (e: any) {
              reply = `Could not update that appointment: ${e?.message ?? "unknown error"}`;
            }
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return { reply, intent: "appointment_admin", state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }

        // ── Buyer: list bookable services ──
        if (/^(?:services|book a service|book an? appointment|appointments)\s*$/i.test(trimmedMsg)) {
          const { listServiceProducts, appointmentDepositPct } = await import("../services/appointments");
          const svcs = await listServiceProducts(db, input.tenantId);
          const depositPct = await appointmentDepositPct(db, input.tenantId);
          const reply = svcs.length === 0
            ? "We don't have bookable services right now — browse our products with 'menu'."
            : "📅 Bookable services:\n" + svcs.map((s, i) =>
                `${i + 1}. ${s.name} — ₦${(s.priceCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} (${s.durationMinutes} min, ${depositPct}% deposit)`).join("\n") +
              `\n\nReply "book <service> at <time>" — e.g. "book ${svcs[0]!.name} at 2026-01-05 14:00".`;
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return { reply, intent: "appointment_list_services", state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }

        // ── Buyer: book <service> at <time> ──
        const bookCmd = /^book\s+(.+?)\s+(?:at|on)\s+(.+)$/i.exec(trimmedMsg);
        if (bookCmd) {
          const { listServiceProducts, bookAppointment, parseAppointmentTime } = await import("../services/appointments");
          const svcs = await listServiceProducts(db, input.tenantId);
          const wanted = bookCmd[1].trim().toLowerCase();
          const svc = svcs.find((s) => s.name.toLowerCase() === wanted)
            ?? svcs.find((s) => s.name.toLowerCase().includes(wanted) || wanted.includes(s.name.toLowerCase()));
          let reply: string;
          if (!svc) {
            reply = svcs.length === 0
              ? "We don't have bookable services right now."
              : `I couldn't match "${bookCmd[1].trim()}" to a service. Bookable: ${svcs.map((s) => s.name).join(", ")}.`;
          } else {
            const startsAt = parseAppointmentTime(bookCmd[2]);
            if (!startsAt) {
              reply = `I couldn't parse that time — use e.g. "book ${svc.name} at 2026-01-05 14:00" or "book ${svc.name} at tomorrow 2pm".`;
            } else {
              try {
                const r = await bookAppointment(db, {
                  tenantId: input.tenantId,
                  customerRef: input.waPhoneNumber,
                  serviceProductId: svc.id,
                  startsAt,
                  channel: /^telegram:/i.test(input.waPhoneNumber) ? "telegram" : "whatsapp",
                });
                const fmt = (c: number) => `₦${(c / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
                reply = `📅 ${r.serviceName} on ${startsAt.toUTCString()} (ref ${r.appt.id.slice(0, 8)}).` +
                  (r.depositCents > 0
                    ? `\nDeposit: ${fmt(r.depositCents)}${r.remainderCents > 0 ? ` (remainder ${fmt(r.remainderCents)} at your appointment)` : ""}.` +
                      (r.paymentUrl ? `\n💳 Pay deposit: ${r.paymentUrl}` : `\n⚠️ Deposit link unavailable right now — we'll retry shortly.`)
                    : "\nNo deposit required — you're booked!");
              } catch (e: any) {
                reply = e?.code === "CONFLICT"
                  ? (e?.message ?? "That time slot is already booked.")
                  : e?.code === "NOT_FOUND"
                    ? "That service is not available for booking."
                    : `Sorry, I couldn't book that just now (${e?.message ?? "unknown error"}).`;
              }
            }
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return { reply, intent: "appointment_book", state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }

        // ── Buyer: cancel appointment [id8] ──
        const cancelAppt = /^cancel\s+(?:my\s+)?appointment\b\s*([0-9a-fA-F-]{0,36})\s*$/i.exec(trimmedMsg);
        if (cancelAppt) {
          let reply: string;
          try {
            const { serviceAppointments } = await import("../../drizzle/schema");
            const { cancelAppointment } = await import("../services/appointments");
            const ref = input.waPhoneNumber.replace(/^\+/, "");
            const conds = [
              eq(serviceAppointments.tenantId, input.tenantId),
              inArray(serviceAppointments.status, ["booked", "confirmed"]),
            ];
            if (cancelAppt[1]) {
              conds.push(sql`CAST(${serviceAppointments.id} AS text) LIKE ${cancelAppt[1].toLowerCase() + "%"}`);
            } else {
              conds.push(or(eq(serviceAppointments.customerId, ref), eq(serviceAppointments.customerId, input.waPhoneNumber))!);
            }
            const matches = await db.select({ id: serviceAppointments.id }).from(serviceAppointments)
              .where(and(...conds))
              .orderBy(desc(serviceAppointments.createdAt))
              .limit(2);
            if (matches.length === 0) {
              reply = "I couldn't find an active appointment on this number.";
            } else if (matches.length > 1) {
              reply = "You have more than one active appointment — reply \"cancel appointment <ref>\" with the reference from your booking message.";
            } else {
              const r = await cancelAppointment(db, {
                tenantId: input.tenantId,
                appointmentId: matches[0]!.id,
                actorId: ref,
              });
              reply = r.outcome === "refunded"
                ? `✅ Appointment cancelled — your deposit is being refunded.`
                : r.outcome === "forfeited"
                  ? `Appointment cancelled. Because this was inside the cancel window, the deposit is forfeited.`
                  : `✅ Appointment cancelled.`;
            }
          } catch (e: any) {
            reply = `Could not cancel that appointment: ${e?.message ?? "unknown error"}`;
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return { reply, intent: "appointment_cancel", state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }

        // ── Buyer: subscription lifecycle ──
        const subCmd = /^(pause|resume|cancel)\s+(?:my\s+)?subscription\s*$/i.exec(trimmedMsg);
        if (subCmd) {
          const subs = await import("../services/subscriptions");
          let reply: string;
          try {
            const action = subCmd[1].toLowerCase();
            reply = action === "pause"
              ? await subs.pauseSubscription(db, { tenantId: input.tenantId, customerRef: input.waPhoneNumber })
              : action === "resume"
                ? await subs.resumeSubscription(db, { tenantId: input.tenantId, customerRef: input.waPhoneNumber })
                : await subs.cancelSubscriptionChat(db, { tenantId: input.tenantId, customerRef: input.waPhoneNumber });
          } catch (e: any) {
            reply = `Could not update your subscription: ${e?.message ?? "unknown error"}`;
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return { reply, intent: `subscription_${subCmd[1].toLowerCase()}`, state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }

        // ── Buyer: reveal my pin ──
        if (/^(?:reveal\s+(?:my\s+)?pin|my\s+pin|resend\s+(?:my\s+)?pin)\s*$/i.test(trimmedMsg)) {
          let reply: string;
          try {
            const { revealPinAgain } = await import("../services/digitalPins");
            reply = await revealPinAgain(db, { tenantId: input.tenantId, customerRef: input.waPhoneNumber });
          } catch (e: any) {
            reply = `Could not reveal your PIN just now (${e?.message ?? "unknown error"}).`;
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return { reply, intent: "digital_pin_reveal", state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }
      }
      // === END W44 deposits-subs-digital ===
      // === W46 uc-money (Coder C): UC-11 auctions (BID / AUCTION / CLOSE
      // AUCTION), UC-15 tips (TIP <amount>), UC-16 donations (DONATE <amount>
      // TO <product>), UC-26 pre-confirmation amendments (AMEND <orderRef>
      // SET <product> x<qty>). BOTH channels — telegram inbound feeds this
      // same engine; customerRef is the E.164 phone (WA) or
      // "telegram:<chatId>" session key. ===
      {
        const trimmedMsg = input.message.trim();
        const parseAmountCents = (raw: string, kobo: boolean) => {
          const n = Number(raw.replace(/,/g, ""));
          if (!Number.isFinite(n) || n <= 0) return null;
          return kobo ? Math.round(n) : Math.round(n * 100);
        };
        const resolveStaffRef = async (): Promise<string> => {
          let staffRef = input.waPhoneNumber;
          if (/^telegram:/i.test(staffRef)) {
            const chatId = staffRef.replace(/^telegram:/i, "");
            const [ident] = await db.select({ phone: telegramIdentities.phoneE164 })
              .from(telegramIdentities)
              .where(and(eq(telegramIdentities.tenantId, input.tenantId), eq(telegramIdentities.chatId, chatId)))
              .limit(1).catch(() => [] as any[]);
            if (ident?.phone) staffRef = ident.phone;
          }
          return staffRef;
        };

        // ── Merchant: AUCTION START <product> AT <amount> FOR <hours>H ──
        const auctionStart = /^auction\s+(?:start\s+)?(.+?)\s+(?:at|for)\s*(?:₦|n(?:gn)?)?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:kobo)?\s+(?:for|ends?\s+in)\s+(\d{1,3})\s*h(?:ours?)?\s*$/i.exec(trimmedMsg);
        if (auctionStart) {
          const { isTenantStaffPhone } = await import("../services/catalogAI");
          const isStaff = await isTenantStaffPhone(db, input.tenantId, await resolveStaffRef()).catch(() => false);
          let reply: string;
          if (!isStaff) {
            reply = "Sorry, only store staff can start auctions.";
          } else {
            try {
              const { createAuction } = await import("../services/auctions");
              const startPriceCents = parseAmountCents(auctionStart[2], /kobo/i.test(auctionStart[0]));
              if (!startPriceCents) throw new Error("Give a start price, e.g. AUCTION START Ankara fabric AT 5000 FOR 24H");
              const a = await createAuction(db, {
                tenantId: input.tenantId,
                productName: auctionStart[1],
                startPriceCents,
                durationHours: Number(auctionStart[3]),
                createdBy: input.waPhoneNumber,
              });
              reply = `🔨 Auction live for ${a.title} (ref ${a.id.slice(0, 8)}) — starts at ₦${(startPriceCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}, ends ${a.endsAt.toISOString().slice(0, 16).replace("T", " ")} UTC. Customers bid with: BID <amount> ${a.title}.`;
            } catch (e: any) {
              reply = e?.message ?? "Could not start that auction.";
            }
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return { reply, intent: "auction_create", state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }

        // ── Merchant: CLOSE AUCTION <ref> (manual close sweep) ──
        const auctionClose = /^close\s+auction\s+([0-9a-fA-F-]{8,36})\s*$/i.exec(trimmedMsg);
        if (auctionClose) {
          const { isTenantStaffPhone } = await import("../services/catalogAI");
          const isStaff = await isTenantStaffPhone(db, input.tenantId, await resolveStaffRef()).catch(() => false);
          let reply: string;
          if (!isStaff) {
            reply = "Sorry, only store staff can close auctions.";
          } else {
            try {
              const { sweepDueAuctions } = await import("../services/auctions");
              // Force-close: mark the ref-matched active auction due, then run
              // the claim-first sweep (which owns the guarded flip + invoice).
              await db.execute(sql`
                UPDATE auctions SET ends_at = now()
                WHERE tenant_id = ${input.tenantId} AND status = 'active'
                  AND id::text LIKE ${auctionClose[1] + "%"}
              `);
              const r = await sweepDueAuctions(db, input.tenantId, {});
              reply = r.closed > 0
                ? `🔨 Closed ${r.closed} auction(s) — ${r.invoiced} winner(s) invoiced${r.reserveMissed ? `, ${r.reserveMissed} ended below reserve` : ""}.`
                : "No active auction matched that ref (already closed?).";
            } catch (e: any) {
              reply = e?.message ?? "Could not close that auction.";
            }
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return { reply, intent: "auction_close", state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }

        // ── Buyer: BID <amount> <product-or-ref> ──
        const bidCmd = /^bid\s+(?:₦|n(?:gn)?)?\s*([\d,]+(?:\.\d{1,2})?)\s*(kobo)?\s+(?:for|on)\s+(.+)$/i.exec(trimmedMsg);
        if (bidCmd) {
          const amountCents = parseAmountCents(bidCmd[1], !!bidCmd[2]);
          let reply: string;
          if (!amountCents) {
            reply = "Bid like this: BID 5500 Ankara fabric";
          } else {
            try {
              const { placeBid } = await import("../services/auctions");
              const target = bidCmd[3].trim();
              const isRef = /^[0-9a-fA-F-]{8,36}$/.test(target);
              const r = await placeBid(db, {
                tenantId: input.tenantId,
                bidderRef: input.waPhoneNumber,
                amountCents,
                ...(isRef ? { auctionRef: target } : { productName: target }),
              });
              reply = `🔨 You're the high bidder at ₦${(amountCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} on "${r.auction.title}" (ref ${r.auction.id.slice(0, 8)})` +
                `${r.extended ? " — the end time was extended (anti-snipe)." : "."} We'll message you if you're outbid.`;
            } catch (e: any) {
              reply = e?.message ?? "Could not place that bid just now.";
            }
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return { reply, intent: "auction_bid", state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }

        // ── Buyer: DONATE <amount> TO <product> ──
        const donateCmd = /^(?:donate|give)\s+(?:₦|n(?:gn)?)?\s*([\d,]+(?:\.\d{1,2})?)\s*(kobo)?\s+(?:to|for|towards?)\s+(.+)$/i.exec(trimmedMsg);
        if (donateCmd) {
          const amountCents = parseAmountCents(donateCmd[1], !!donateCmd[2]);
          let reply: string;
          if (!amountCents) {
            reply = "Donate like this: DONATE 5000 to School fees fund";
          } else {
            try {
              const { createDonationCheckout } = await import("../services/donations");
              const r = await createDonationCheckout(db, {
                tenantId: input.tenantId,
                customerRef: input.waPhoneNumber,
                productName: donateCmd[3].trim(),
                amountCents,
              });
              reply = r.paymentUrl
                ? `🙏 Thank you! Your ₦${(amountCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} for ${r.productName} is ready:\n💳 Pay: ${r.paymentUrl}`
                : `🙏 Thank you! Your pledge for ${r.productName} (ref ${r.orderNumber}) is recorded — the store will send your payment link shortly.`;
            } catch (e: any) {
              reply = e?.message ?? "Could not set up that donation just now.";
            }
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return { reply, intent: "donation_request", state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }

        // ── Buyer: TIP <amount> (applies to latest pending unpaid order) ──
        const tipCmd = /^(?:tip|add\s+tip)\s+(?:₦|n(?:gn)?)?\s*([\d,]+(?:\.\d{1,2})?)\s*(kobo)?\s*$/i.exec(trimmedMsg);
        if (tipCmd) {
          const tipCents = parseAmountCents(tipCmd[1], !!tipCmd[2]);
          let reply: string;
          if (tipCents == null) {
            reply = "Tip like this: TIP 500";
          } else {
            try {
              const { setOrderTip } = await import("../services/tipping");
              const r = await setOrderTip(db, { tenantId: input.tenantId, customerRef: input.waPhoneNumber, tipCents });
              reply = tipCents === 0
                ? `Tip removed from order ${r.orderNumber}. Total is now ₦${(r.totalCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}.`
                : `💝 Tip of ₦${(tipCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} added to order ${r.orderNumber}. New total: ₦${(r.totalCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}.`;
            } catch (e: any) {
              reply = e?.message ?? "Could not add that tip just now.";
            }
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return { reply, intent: "tip_set", state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }

        // ── Buyer/staff: AMEND <orderRef> SET <product> x<qty> [, …] ──
        const amendCmd = /^amend\s+(?:order\s+)?([A-Za-z0-9-]{4,40})\s+set\s+(.+)$/i.exec(trimmedMsg);
        if (amendCmd) {
          let reply: string;
          try {
            const { amendOrder } = await import("../services/orderAmendments");
            // Parse "product name x2, other product x1" segments.
            const segs = amendCmd[2].split(",").map((s) => s.trim()).filter(Boolean);
            const lines: { productId: string; qty: number }[] = [];
            for (const seg of segs) {
              const m = /^(.*?)\s*(?:x\s*(\d+)|(\d+)\s*x)$/i.exec(seg);
              if (!m) throw new Error(`I couldn't parse "${seg}" — use "<product> x<qty>".`);
              const name = m[1].trim();
              const qty = Number(m[2] ?? m[3]);
              const prows = (await db.execute(
                sql`SELECT id FROM "products" WHERE "tenantId" = ${input.tenantId} AND "status" = 'active' AND "name" ILIKE ${"%" + name.slice(0, 80) + "%"} ORDER BY "name" LIMIT 1`,
              )) as unknown as any[];
              const plist: any[] = Array.isArray(prows) ? prows : (prows as any)?.rows ?? [];
              if (!plist[0]) throw new Error(`I couldn't find "${name}" in this store.`);
              lines.push({ productId: String((plist[0] as any).id), qty });
            }
            // Resolve order ref: full id or orderNumber suffix.
            const orows = (await db.execute(
              sql`SELECT id, "customerId" FROM orders WHERE "tenantId" = ${input.tenantId} AND (id = ${amendCmd[1]} OR "orderNumber" ILIKE ${"%" + amendCmd[1]}) ORDER BY "createdAt" DESC LIMIT 2`,
            )) as unknown as any[];
            const olist: any[] = Array.isArray(orows) ? orows : (orows as any)?.rows ?? [];
            if (olist.length !== 1) throw new Error("I couldn't find exactly one order with that ref.");
            if (olist[0].customerId !== input.waPhoneNumber) {
              const { isTenantStaffPhone } = await import("../services/catalogAI");
              const isStaff = await isTenantStaffPhone(db, input.tenantId, await resolveStaffRef()).catch(() => false);
              if (!isStaff) throw new Error("You can only amend your own orders.");
            }
            const r = await amendOrder(db, {
              tenantId: input.tenantId,
              orderId: String(olist[0].id),
              lines,
              actorId: input.waPhoneNumber,
              customerRef: String(olist[0].customerId),
              reason: "chat amend command",
            });
            const a = r.amendment;
            const deltaTxt = a.deltaCents === 0 ? "no change to the total"
              : a.deltaCents > 0 ? `₦${(a.deltaCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} more${r.deltaPaymentUrl ? ` — pay the difference: ${r.deltaPaymentUrl}` : ""}`
              : `₦${(-a.deltaCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} less${r.refundStatus ? ` — refund ${r.refundStatus.replace(/_/g, " ")}` : ""}`;
            reply = `📝 Order amended (new total ₦${(a.newTotalCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}, ${deltaTxt}).`;
          } catch (e: any) {
            reply = e?.message ?? "Could not amend that order just now.";
          }
          await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
          return { reply, intent: "order_amend", state: session.state, language: session.language, sessionId: session.id, confidence: 1 };
        }
      }
      // === END W46 uc-money ===
      // === W27 Coder F: 3f. Wholesale marketplace + group buying commands ===
      // Deterministic, no LLM needed (discoveryMenu.ts exemplar). Parses
      // "wholesale [q]" / "buy <#> <qty>" / "deals" / "join <ref> <qty>" /
      // "deal <ref>" and answers from the wholesaleCatalog / groupBuy
      // services. Session context remembers the last listing menu so "buy 1
      // 100" resolves to a listing.
      {
        const { parseWholesaleCommand, handleWholesaleCommand } =
          await import("../services/wholesaleWhatsApp");
        const wCmd = parseWholesaleCommand(input.message);
        if (wCmd) {
          const wCtx: Record<string, unknown> = (session.context as Record<string, unknown>) ?? {};
          const result = await handleWholesaleCommand(db, wCmd, {
            waPhoneNumber: input.waPhoneNumber,
            sessionCtx: wCtx,
          });
          const nextCtx = result.ctxPatch ? { ...wCtx, ...result.ctxPatch } : wCtx;
          const wHistory = [
            ...((session.messageHistory as Array<{ role: string; content: string }>).slice(-10)),
            { role: "user", content: input.message },
            { role: "assistant", content: result.reply },
          ].slice(-20);
          await db.update(nlpSessions).set({
            context: nextCtx,
            messageHistory: wHistory,
            lastActivityAt: new Date(),
          }).where(eq(nlpSessions.id, session.id));
          await db.insert(agentEvents).values({
            id: crypto.randomUUID(),
            tenantId: input.tenantId,
            conversationId: session.id,
            eventType: "nlp_message",
            intentType: result.intent,
            confidence: "1.000",
            escalated: false,
            model: "deterministic-wholesale-groupbuy",
            createdAt: new Date(),
          });
          return {
            reply: result.reply,
            intent: result.intent,
            state: session.state,
            language: session.language,
            sessionId: session.id,
            confidence: 1,
          };
        }
      }
      // === END W27 Coder F ===

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
          // W46 merge-close: the catalog context window above is limited to
          // 30 rows (unordered) — on tenants with larger catalogs an
          // extracted item can legitimately fall outside the window and be
          // misreported as "not on the menu". Rescue by name with a targeted
          // lookup before declaring not_found.
          const windowNames = new Set(tenantProducts.map((p) => p.name.toLowerCase()));
          const rescueNames = Array.from(new Set(
            itemsToAdd.map((i) => (i.product ?? "").trim()).filter((n) => n.length > 0),
          )).filter((n) => {
            const q = n.toLowerCase();
            return !windowNames.has(q) &&
              !tenantProducts.some((p) => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()));
          });
          for (const name of rescueNames) {
            const hits = await db.select({
              id: products.id, name: products.name, price: products.price,
              currency: products.currency, stockQuantity: products.stockQuantity,
              description: products.description, imageUrl: products.imageUrl,
            }).from(products)
              .where(and(eq(products.tenantId, input.tenantId), eq(products.status, "active"), ilike(products.name, `%${name}%`)))
              .limit(5)
              .catch(() => [] as any[]);
            for (const h of hits) {
              if (!windowNames.has(h.name.toLowerCase())) {
                tenantProducts.push(h);
                windowNames.add(h.name.toLowerCase());
              }
            }
          }
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

      // === W45 orders-p0 (ORD-27): buyer "cancel order" chat intent ===
      // Both channels reach this handler (Telegram inbound routes through the
      // same processMessage). Runs the guarded PRE-SHIP buyer cancel in
      // orderCrud.buyerCancel (phone-ownership check + unified W38
      // cancelOrder incl. escrow refund). Shipped orders are redirected to
      // the dispute path honestly.
      if (llmResult.intent === "cancel_order") {
        try {
          const { appRouter } = await import("../routers");
          const caller = appRouter.createCaller({
            user: { id: 0, role: "user", tenantId: input.tenantId, name: "chat-buyer-cancel" },
          } as any);
          const result = await caller.orderCrud.buyerCancel({
            tenantId: input.tenantId,
            // W47 buyer (ONB-B-6): canonical cross-channel buyer identity.
            phone: buyerKey,
            reason: input.message.slice(0, 200),
          });
          llmResult.reply = result.escrowRefunded
            ? `✅ Your order has been cancelled and your payment refund is on its way. Sorry to see it go — type "menu" anytime to shop again.`
            : `✅ Your order has been cancelled.${result.refundSweepRequired ? " Your refund is being processed by our team." : ""} Type "menu" anytime to shop again.`;
          llmResult.nextState = "browse";
        } catch (e: any) {
          const msg = e?.message ?? "";
          if (/already shipped|terminal/i.test(msg)) {
            llmResult.reply = `⚠️ That order has already shipped, so it can't be cancelled here — reply "dispute" and our team will help you with a return or refund.`;
          } else if (/No cancellable order/i.test(msg)) {
            llmResult.reply = `I couldn't find an open order on this number to cancel. If you meant a specific order, reply with "cancel order <order id>".`;
          } else {
            console.error("[nlp] cancel_order intent failed:", msg);
            llmResult.reply = `⚠️ I couldn't cancel the order just now — our team has been notified. You can also reply "dispute" for help.`;
            try {
              const { notifyTenantAdminWhatsApp } = await import("../services/adminAlerts");
              await notifyTenantAdminWhatsApp(db, input.tenantId, `⚠️ Buyer cancel-order request failed for ${input.waPhoneNumber}: ${msg.slice(0, 200)}`);
            } catch { /* best-effort */ }
          }
        }
      }
      // === END W45 orders-p0 ===

      if (llmResult.intent === "confirm_order" && cartSession) {
        // Promo code capture ("use code SAVE10") — sticks to the session.
        const mentionedPromo = extractPromoCode(input.message);
        if (mentionedPromo) ctx.promoCode = mentionedPromo;
        // === W46 uc-ux (Coder E): UC-24 gift intent capture (LLM path) ====
        if (/\bgift\b/i.test(input.message) && !ctx.gift) {
          const recipient = input.message.match(/(?:send|ship|deliver)\s+(?:it\s+)?to\s*(\+?[\d][\d\s-]{7,16}\d)/i);
          ctx.gift = {
            isGift: true,
            wrap: /\bwrap(ped|ping)?\b/i.test(input.message),
            recipientPhone: recipient ? recipient[1].replace(/[\s-]/g, "") : null,
            message: null,
          };
        }
        // === END W46 uc-ux ===
        // === W46 privacy-consent (TEN-15): age attestation capture — an
        // affirmative reply ("yes 18+", "I am 21") at any confirm turn is a
        // one-shot attestation for THIS checkout (persisted by the gate).
        // === W47 buyer (ONB-B-1 / ONB-B-11): the captured digits decide —
        // a truthful minor FAILS (attestedAge = actual digits); an explicit
        // denial removes the restricted items instead of looping. ===
        const { parseAgeAttestationReply } = await import("../services/ageGate");
        const ageReply = ctx.awaitingAgeAttestation === true
          ? parseAgeAttestationReply(input.message ?? "")
          : null;
        const ageAttested = ageReply?.affirmed === true;
        const ageAttestedAge = ageReply?.affirmed === true ? ageReply.statedAge ?? null : null;
        if (ageAttested) delete ctx.awaitingAgeAttestation;
        // ONB-B-11: explicit denial at the prompt → remove the restricted
        // items from the cart and let the buyer continue with the rest
        // (no indefinite re-prompt loop, no dead end).
        if (ageReply?.affirmed === false && cartSession) {
          delete ctx.awaitingAgeAttestation;
          const cartRows = await db.select().from(cartItems).where(eq(cartItems.cartSessionId, cartSession.id));
          const gatedIds = new Set(
            (await db.select({ id: products.id }).from(products)
              .where(and(eq(products.tenantId, input.tenantId), eq(products.ageRestricted, true))))
              .map((p: any) => p.id),
          );
          const removed = cartRows.filter((i) => gatedIds.has(i.productId));
          for (const i of removed) {
            await db.delete(cartItems).where(eq(cartItems.id, i.id));
          }
          const { buildAgeGateDenialReply } = await import("../services/ageGate");
          llmResult.reply = buildAgeGateDenialReply(removed.map((i) => i.productName));
          llmResult.nextState = removed.length < cartRows.length ? "checkout_confirm" : "browse";
          // Fall through to persist ctx; skip the order-creation below.
          ctx.lastAgeDenialAt = Date.now();
        }
        // === END W46/W47 ===
        const items = await db.select().from(cartItems).where(eq(cartItems.cartSessionId, cartSession.id));
        // W47 buyer (ONB-B-11): denial already produced the reply — skip
        // order creation entirely this turn.
        if (ageReply?.affirmed !== false && items.length > 0) {
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
            llmResult.reply = buildFulfillmentPrompt(items, subtotal, currency,
              (await dualFormatterFor(db, input.tenantId)) ?? undefined);
          } else {
            // Fulfillment already chosen earlier in the session — create the
            // order immediately (e.g. buyer re-confirming).
            const address = fulfillment === "delivery"
              ? (llmResult.extractedAddress ?? (typeof ctx.deliveryAddress === "string" ? ctx.deliveryAddress : null))
              : null;
            const order = await createChatOrder(db, {
              tenantId: input.tenantId,
              // W47 buyer (ONB-B-6): canonical cross-channel buyer identity.
              waPhoneNumber: buyerKey,
              customerName: input.customerName,
              cartSessionId: cartSession.id,
              fulfillment,
              address,
              promoCode: typeof ctx.promoCode === "string" ? ctx.promoCode : null,
              paymentMethod: ctx.paymentMethod === "cod" ? "cod" : "online",
              loyaltyRedeem: ctx.loyaltyRedeem === true,
              // W46 orders-p2 (ORD-25): attach any captured buyer note.
              buyerNote: typeof ctx.buyerNote === "string" ? ctx.buyerNote : null,
              deliveryCoords: (() => {
                const dc = ctx.deliveryCoords as { latitude?: number; longitude?: number } | undefined;
                return typeof dc?.latitude === "number" && typeof dc?.longitude === "number"
                  ? { latitude: dc.latitude, longitude: dc.longitude }
                  : null;
              })(),
              // === W46 uc-ux (Coder E): UC-24 gift + UC-21 slot opts ===
              gift: (ctx.gift as import("../services/giftOrders").GiftOptions | undefined) ?? undefined,
              deliverySlotId: typeof ctx.deliverySlotId === "string" ? ctx.deliverySlotId : null,
              // === END W46 uc-ux ===
              // === W46 privacy-consent (TEN-15): one-shot age attestation ===
              // === W47 buyer (ONB-B-1): pass the ACTUAL stated digits ===
              ageAttested,
              ageAttestedAge,
              // W47 (ONB-TOCTOU-2): evidence id on the attestation row.
              ageProofWamid: input.wamid ?? null,
            });
            // === W46 privacy-consent (TEN-15): gate blocked — prompt attestation ===
            if (order.ageGate) {
              const { buildAgeAttestationPrompt, buildAgeGateUnderageReply } = await import("../services/ageGate");
              // W47 (ONB-I18N-1): localized attestation prompt.
              const { localeFromSessionLanguage } = await import("../services/i18n");
              const gated = new Set(order.ageGate.restrictedProductIds);
              const names = items.filter((i) => gated.has(i.productId)).map((i) => i.productName);
              // === W47 buyer (ONB-B-1): truthful minor — the attestation
              // FAILED. Remove the restricted items from the cart, clear the
              // prompt flag (no loop) and let the buyer continue with the
              // remaining items. ===
              if (order.ageGate.underage === true) {
                delete ctx.awaitingAgeAttestation;
                for (const i of items.filter((i) => gated.has(i.productId))) {
                  await db.delete(cartItems).where(eq(cartItems.id, i.id));
                }
                llmResult.reply = buildAgeGateUnderageReply(
                  order.ageGate.requiredAge, order.ageGate.statedAge ?? 0, names,
                );
                llmResult.nextState = names.length < items.length ? "checkout_confirm" : "browse";
              } else {
              ctx.awaitingAgeAttestation = true;
              llmResult.reply = buildAgeAttestationPrompt(
                order.ageGate.requiredAge,
                names,
                localeFromSessionLanguage(session?.language),
              );
              llmResult.nextState = "checkout_confirm";
              }
            // === END W46/W47 ===
            // === W46 uc-ux (Coder E): UC-27 min-order block ===============
            } else if (order.minOrderBlock) {
              const { minOrderBlockReply } = await import("../services/minOrder");
              llmResult.reply = minOrderBlockReply(order.minOrderBlock, order.currency ?? "NGN", fulfillment);
            // === END W46 uc-ux ===
            } else if (order.fraudBlocked) {
              llmResult.reply = `\u26a0\ufe0f Your order could not be processed at this time. Please contact support for assistance. (Risk: ${order.riskLevel})`;
            } else if (order.shortages?.length) {
              // Out-of-stock guard tripped — no order, no payment link.
              ctx.lastShortageProductIds = order.shortages.map((s) => s.productId);
              llmResult.reply = buildShortageReply(order.shortages, order.availableItems ?? [], order.currency ?? "NGN");
            } else if (order.created) {
              ctx.lastOrderId = order.orderId;
              ctx.lastOrderNumber = order.orderNumber;
              if (order.loyalty) delete ctx.loyaltyRedeem; // W27: one-shot redeem flag consumed
              orderCard = { orderId: order.orderId!, orderNumber: order.orderNumber!, paymentUrl: order.paymentUrl ?? null };
              llmResult.reply = buildOrderSummary({
                fmt: (await dualFormatterFor(db, input.tenantId)) ?? undefined,
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
                paymentMethod: order.paymentMethod ?? "online",
                trackingUrl: trackingUrlFor(order.orderId!),
                // === W46 uc-money (UC-15): tip prompt (tenant opt-in) ===
                tipPrompt: order.paymentMethod === "cod" ? null
                  : await (async () => {
                      try {
                        const { tipCheckoutPrompt } = await import("../services/tipping");
                        return await tipCheckoutPrompt(db, input.tenantId, order.currency ?? "NGN");
                      } catch { return null; }
                    })(),
                // === END W46 uc-money ===
              });
              if (order.loyalty && order.loyalty.points > 0) {
                llmResult.reply += `\n🎁 Redeemed ${order.loyalty.points} pts (−${fmtMoney(order.loyalty.discountCents / 100, order.currency ?? "NGN")}). Points balance: ${order.loyalty.balanceAfter}.`;
              }
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
          // W41 UC-5: catalog card shows the dual price when configured
          // (display-only — the charge stays in NGN).
          const [fxTenant] = await db
            .select({ displayCurrency: tenants.displayCurrency, displayFxRates: tenants.displayFxRates })
            .from(tenants).where(eq(tenants.id, input.tenantId)).limit(1)
            .catch(() => [] as any[]);
          productImage = {
            link: match.imageUrl,
            caption: `${match.name} — ${formatPriceDual(fxTenant, Number(match.price), match.currency)}`,
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
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
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
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
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
    .mutation(async ({ input, ctx }) => {
      await assertNlpSessionAccess(ctx.user, input.sessionId);
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
      assertTenantAccess(ctx.user, input.tenantId);
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
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
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
    .mutation(async ({ input, ctx }) => {
      await assertNlpSessionAccess(ctx.user, input.sessionId);
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
    .query(async ({ input, ctx }) => {
      await assertNlpSessionAccess(ctx.user, input.sessionId);
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
    .query(async ({ input, ctx }) => {
      await assertNlpSessionAccess(ctx.user, input.sessionId);
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
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [order] = await db.select().from(orders)
        .where(eq(orders.orderNumber, input.orderNumber))
        .limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      // QA follow-up (P1): the order was looked up by number alone and its
      // items, payment transactions and integration status returned to ANY
      // logged-in user — any tenant's order, given just an order number.
      // Load-then-assert, the pattern used across this codebase.
      assertTenantAccess(ctx.user, order.tenantId);

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

      // W17/F10: surface partial-payment summary + COD audit trail in the
      // order detail response.
      const { orderPaymentSummary, codEventsForOrder } = await import("../services/codFlow");
      const paymentSummary = await orderPaymentSummary(db, order.tenantId, order.id).catch(() => null);
      const codEventsList = order.codState
        ? await codEventsForOrder(db, order.tenantId, order.id).catch(() => [])
        : [];
      for (const ev of codEventsList) {
        timeline.push({
          id: `cod-${ev.id}`,
          timestamp: ev.createdAt,
          system: "COD Flow",
          event: `COD: ${ev.fromState ?? "start"} → ${ev.toState}`,
          detail: ev.note ?? `by ${ev.actor}`,
          status: "info",
        });
        timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      }

      return {
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          paymentStatus: order.paymentStatus,
          totalAmount: order.totalAmount,
          currency: order.currency,
          codState: order.codState,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
          shippingAddress: order.shippingAddress,
          notes: order.notes,
          erpOrderId: order.erpOrderId,
        },
        items,
        payments,
        paymentSummary,
        codEvents: codEventsList,
        timeline,
        integrations: { hasMedusa, hasOdoo, hasTwenty },
      };
    }),
});
