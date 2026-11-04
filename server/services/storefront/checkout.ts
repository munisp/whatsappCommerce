/**
 * Web checkout. Prices come from the database, never the browser. The order itself goes through
 * createChatOrder, the same path as chat, so stock reservation, age checks, minimum order, fraud scoring,
 * promos, delivery quotes and payment links all behave the same on every channel.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { cartItems, cartSessions, customers, orders, paymentTransactions, productVariants, products } from "../../../drizzle/schema";
import { quoteDeliveryForCart } from "../deliveryQuoteForCart";
import { checkAvailability } from "../inventory";
import { validatePromo } from "../promos";
import { checkoutOptions, type Db, type LoadedStore } from "./store";

export interface CartLineInput { productId: string; variantId?: string | null; quantity: number }

export interface PricedLine {
  productId: string; variantId: string | null; name: string; variantLabel: string | null; quantity: number;
  unitPrice: number; currency: string; imageUrl: string | null; available: boolean; reason: string | null;
}

/** Normalises a Nigerian or international number to digits with country code. */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = `234${digits.slice(1)}`;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

export async function priceCart(db: Db, tenantId: string, lines: CartLineInput[]): Promise<PricedLine[]> {
  if (lines.length === 0) return [];
  const ids = Array.from(new Set(lines.map((l) => l.productId)));
  const [rows, variants] = await Promise.all([
    db.select().from(products).where(and(eq(products.tenantId, tenantId), inArray(products.id, ids))),
    db.select().from(productVariants).where(and(eq(productVariants.tenantId, tenantId), inArray(productVariants.productId, ids))),
  ]);
  const availability = await checkAvailability(db, tenantId, lines.map((l) => ({ productId: l.productId, qty: l.quantity })));
  const short = new Set(availability.ok ? [] : availability.shortages.map((s) => s.productId));
  return lines.map((line) => {
    const product = rows.find((r) => r.id === line.productId);
    if (!product || product.status !== "active") {
      return { productId: line.productId, variantId: null, name: "Item no longer available", variantLabel: null, quantity: line.quantity, unitPrice: 0, currency: "NGN", imageUrl: null, available: false, reason: "unavailable" };
    }
    const own = variants.filter((v) => v.productId === product.id);
    const variant = line.variantId ? own.find((v) => v.id === line.variantId) : undefined;
    const label = variant ? (variant.name ?? Object.values((variant.attributes ?? {}) as Record<string, string>).join(" / ")) : null;
    let reason: string | null = null;
    if (own.length > 0 && !variant) reason = "choose_option";
    else if (variant && variant.stockQuantity < line.quantity) reason = "out_of_stock";
    else if (!variant && short.has(product.id)) reason = "out_of_stock";
    return {
      productId: product.id, variantId: variant?.id ?? null, name: product.name, variantLabel: label, quantity: line.quantity,
      unitPrice: Number(product.price), currency: product.currency, imageUrl: product.imageUrl, available: reason === null, reason,
    };
  });
}

export interface QuoteInput {
  lines: CartLineInput[]; fulfillment: "delivery" | "pickup"; address?: string | null; promoCode?: string | null;
}

/** What the buyer will pay, calculated the way the order will be. */
export async function quoteCheckout(db: Db, store: LoadedStore, input: QuoteInput) {
  const tenantId = store.tenant.id;
  const lines = await priceCart(db, tenantId, input.lines);
  const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  let deliveryFee = 0;
  let deliveryNote: string | null = null;
  if (input.fulfillment === "delivery" && lines.length > 0) {
    const { quote, aggQuote } = await quoteDeliveryForCart(db, {
      tenantId, address: input.address ?? null, items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })), subtotal,
    });
    deliveryFee = quote.fee;
    deliveryNote = aggQuote ? aggQuote.label : "Estimated from your delivery address";
  }
  let discount = 0;
  let promoError: string | null = null;
  let promoCode: string | null = null;
  if (input.promoCode?.trim()) {
    const check = await validatePromo(db, tenantId, input.promoCode.trim(), subtotal);
    if (check.ok) {
      discount = Math.min(Number(check.discount), subtotal + deliveryFee);
      promoCode = check.promo.code;
    } else {
      promoError = ({ not_found: "That code isn't valid.", expired: "That code has expired.", min_total: "Your order doesn't reach this code's minimum.", max_uses: "That code has been fully used." } as Record<string, string>)[check.reason] ?? "That code can't be used.";
    }
  }
  const { getMinOrderCents } = await import("../minOrder");
  const minOrderCents = await getMinOrderCents(db, tenantId, input.fulfillment);
  return {
    lines, subtotal, deliveryFee, deliveryNote, discount, promoCode, promoError,
    total: Math.max(0, subtotal + deliveryFee - discount),
    currency: lines[0]?.currency ?? store.tenant.defaultCurrency ?? "NGN",
    minOrder: minOrderCents > 0 ? minOrderCents / 100 : 0,
    ageRestriction: await requiredAge(db, tenantId, lines.map((l) => l.productId)),
  };
}

async function requiredAge(db: Db, tenantId: string, ids: string[]) {
  if (ids.length === 0) return null;
  const { requiredAgeForProducts } = await import("../ageGate");
  return (await requiredAgeForProducts(db, tenantId, ids).catch(() => null))?.requiredAge ?? null;
}

export interface CheckoutInput extends QuoteInput {
  checkoutKey: string;
  contact: { name: string; phone: string; email?: string | null };
  deliveryAddress?: { line1: string; city: string; state?: string | null } | null;
  paymentMethod: "online" | "cod";
  note?: string | null;
  ageAttestedAge?: number | null;
  accountId?: string | null;
  orderUrl: (token: string) => string;
}

export type CheckoutResult =
  | { ok: true; orderId: string; orderNumber: string; trackingToken: string; paymentUrl: string | null; paymentMethod: "online" | "cod"; total: number; currency: string; duplicate?: boolean }
  | { ok: false; error: string; code: "unavailable" | "age" | "min_order" | "blocked" | "invalid" };

export async function placeOrder(db: Db, store: LoadedStore, input: CheckoutInput): Promise<CheckoutResult> {
  const tenantId = store.tenant.id;
  const phone = normalizePhone(input.contact.phone);
  if (!phone) return { ok: false, code: "invalid", error: "Enter a valid phone number." };
  const options = checkoutOptions(store.tenant.settings);
  if (input.paymentMethod === "cod" && !options.cod) return { ok: false, code: "invalid", error: "Payment on delivery isn't available at this store." };
  if (input.fulfillment === "pickup" && !options.pickup) return { ok: false, code: "invalid", error: "Pickup isn't available at this store." };
  if (input.fulfillment === "delivery" && !input.deliveryAddress) return { ok: false, code: "invalid", error: "Enter a delivery address." };
  const { generateTrackingToken } = await import("../trackingToken");

  // A double submit returns the order already placed, not a second one.
  const [existing] = await db.select().from(orders).where(and(
    eq(orders.tenantId, tenantId), sql`${orders.metadata}->>'checkoutKey' = ${input.checkoutKey}`,
  )).limit(1);
  if (existing) {
    const [tx] = await db.select({ paymentUrl: paymentTransactions.paymentUrl }).from(paymentTransactions)
      .where(eq(paymentTransactions.orderId, existing.id)).orderBy(desc(paymentTransactions.createdAt)).limit(1);
    return {
      ok: true, duplicate: true, orderId: existing.id, orderNumber: existing.orderNumber, trackingToken: generateTrackingToken(existing.id),
      paymentUrl: tx?.paymentUrl ?? null, paymentMethod: ((existing.metadata as { paymentMethod?: string })?.paymentMethod === "cod" ? "cod" : "online"),
      total: Number(existing.totalAmount), currency: existing.currency,
    };
  }

  const priced = await priceCart(db, tenantId, input.lines);
  const blocked = priced.find((l) => !l.available);
  if (priced.length === 0) return { ok: false, code: "invalid", error: "Your cart is empty." };
  if (blocked) {
    return {
      ok: false, code: "unavailable",
      error: blocked.reason === "choose_option" ? `Choose an option for ${blocked.name}.` : `${blocked.name}${blocked.variantLabel ? ` (${blocked.variantLabel})` : ""} is no longer available in that quantity.`,
    };
  }

  // Variant stock is claimed first, atomically. It is given back if the order doesn't go through,
  // and by releaseVariantStock when an unpaid order's reservation lapses or an order is cancelled.
  const claimed: { variantId: string; quantity: number }[] = [];
  const giveBack = async () => {
    for (const c of claimed) {
      await db.update(productVariants).set({ stockQuantity: sql`${productVariants.stockQuantity} + ${c.quantity}` })
        .where(and(eq(productVariants.id, c.variantId), eq(productVariants.tenantId, tenantId)));
    }
  };
  for (const line of priced) {
    if (!line.variantId) continue;
    const [row] = await db.update(productVariants)
      .set({ stockQuantity: sql`${productVariants.stockQuantity} - ${line.quantity}` })
      .where(and(eq(productVariants.id, line.variantId), eq(productVariants.tenantId, tenantId), sql`${productVariants.stockQuantity} >= ${line.quantity}`))
      .returning({ id: productVariants.id });
    if (!row) {
      await giveBack();
      return { ok: false, code: "unavailable", error: `${line.name} (${line.variantLabel}) just sold out.` };
    }
    claimed.push({ variantId: line.variantId, quantity: line.quantity });
  }

  const sessionId = randomUUID();
  const address = input.fulfillment === "delivery" && input.deliveryAddress
    ? [input.deliveryAddress.line1, input.deliveryAddress.city, input.deliveryAddress.state].filter(Boolean).join(", ")
    : null;
  try {
    await db.insert(cartSessions).values({ id: sessionId, tenantId, waPhoneNumber: null, currentStep: "web_checkout", expiresAt: new Date(Date.now() + 3_600_000) });
    await db.insert(cartItems).values(priced.map((l) => ({
      cartSessionId: sessionId, productId: l.productId,
      productName: (l.variantLabel ? `${l.name} (${l.variantLabel})` : l.name).slice(0, 255),
      quantity: l.quantity, unitPrice: l.unitPrice.toFixed(2), currency: l.currency,
    })));
    const { createChatOrder } = await import("../../routers/nlp");
    const result = await createChatOrder(db, {
      tenantId,
      waPhoneNumber: phone,
      customerName: input.contact.name,
      cartSessionId: sessionId,
      fulfillment: input.fulfillment,
      address,
      promoCode: input.promoCode?.trim() || null,
      paymentMethod: input.paymentMethod,
      buyerNote: input.note ?? null,
      ageAttested: input.ageAttestedAge != null,
      ageAttestedAge: input.ageAttestedAge ?? null,
      web: {
        source: "web_storefront",
        email: input.contact.email ?? null,
        // The order id isn't known until the order exists, so the provider returns the buyer via their key.
        callbackUrl: input.orderUrl(`key-${input.checkoutKey}`),
        shippingAddress: input.fulfillment === "delivery" && input.deliveryAddress
          ? { ...input.deliveryAddress, raw: address, recipient: input.contact.name, phone }
          : null,
        metadata: {
          checkoutKey: input.checkoutKey,
          storeSlug: store.storefront.slug,
          contactEmail: input.contact.email ?? null,
          contactName: input.contact.name,
          ...(input.accountId ? { storeAccountId: input.accountId } : {}),
          ...(claimed.length ? { variantLines: claimed } : {}),
        },
      },
    });
    if (!result.created || !result.orderId || !result.orderNumber) {
      await giveBack();
      if (result.ageGate) {
        return { ok: false, code: "age", error: result.ageGate.underage ? `You must be ${result.ageGate.requiredAge} or older to buy this.` : `Please confirm your age. This order has items for ${result.ageGate.requiredAge}+ only.` };
      }
      if (result.minOrderBlock) return { ok: false, code: "min_order", error: "Your order is below this store's minimum." };
      if (result.fraudBlocked) return { ok: false, code: "blocked", error: "We couldn't accept this order online. Please contact the store." };
      if (result.shortages?.length) return { ok: false, code: "unavailable", error: "Some items just sold out. Please review your cart." };
      return { ok: false, code: "invalid", error: "We couldn't place your order. Please try again." };
    }
    await upsertCustomer(db, tenantId, phone, input.contact.name, input.contact.email ?? null);
    return {
      ok: true, orderId: result.orderId, orderNumber: result.orderNumber, trackingToken: generateTrackingToken(result.orderId),
      paymentUrl: result.paymentUrl ?? null, paymentMethod: result.paymentMethod ?? "online", total: result.total ?? 0, currency: result.currency ?? "NGN",
    };
  } catch (err) {
    await giveBack();
    throw err;
  } finally {
    // The order keeps its own copy of the lines. A leftover cart must not surface in anyone's chat.
    await db.delete(cartItems).where(eq(cartItems.cartSessionId, sessionId)).catch(() => undefined);
    await db.delete(cartSessions).where(eq(cartSessions.id, sessionId)).catch(() => undefined);
  }
}

async function upsertCustomer(db: Db, tenantId: string, phone: string, name: string, email: string | null) {
  await db.insert(customers).values({ id: randomUUID(), tenantId, whatsappPhone: phone, name, email })
    .onConflictDoNothing({ target: [customers.tenantId, customers.whatsappPhone] })
    .catch((e: unknown) => console.warn("[storefront] customer upsert failed (non-blocking):", (e as Error)?.message));
}

/** Find an order by the checkout key the payment provider returns the buyer with. */
export async function orderIdForCheckoutKey(db: Db, tenantId: string, key: string): Promise<string | null> {
  const [row] = await db.select({ id: orders.id }).from(orders)
    .where(and(eq(orders.tenantId, tenantId), sql`${orders.metadata}->>'checkoutKey' = ${key}`)).limit(1);
  return row?.id ?? null;
}

/**
 * Gives variant stock back once, when a reservation lapses or an order is cancelled. The metadata flag
 * is claimed atomically, so a repeat call does nothing, and orders without variant lines are untouched.
 */
export async function releaseVariantStock(db: Pick<Db, "update">, orderId: string): Promise<void> {
  const [claimed] = await db.update(orders)
    .set({ metadata: sql`coalesce(${orders.metadata}, '{}'::jsonb) || '{"variantStockReleased":true}'::jsonb` })
    .where(and(eq(orders.id, orderId), sql`${orders.metadata} ? 'variantLines'`, sql`NOT (${orders.metadata} ? 'variantStockReleased')`))
    .returning({ tenantId: orders.tenantId, metadata: orders.metadata });
  if (!claimed) return;
  const lines = ((claimed.metadata as { variantLines?: { variantId: string; quantity: number }[] }).variantLines) ?? [];
  for (const line of lines) {
    await db.update(productVariants).set({ stockQuantity: sql`${productVariants.stockQuantity} + ${line.quantity}` })
      .where(and(eq(productVariants.id, line.variantId), eq(productVariants.tenantId, claimed.tenantId)));
  }
}
