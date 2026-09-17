// === W44 preorders-offers ===
/**
 * customOffers.ts — haggling / custom offers (mig 0139).
 *
 * Flow (BOTH channels — WA text and TG inbound feed the same NLP engine):
 *   1. Buyer: "I'll pay 4500 for Ankara fabric" → makeOffer validates the
 *      price floor (products.minPriceCents when set, else any positive
 *      amount), parks a PENDING custom_offers row (one OPEN offer per
 *      tenant+customer+product — the partial unique index is the backstop)
 *      and sends the merchant an approval card: WA interactive buttons + TG
 *      inline keyboard carrying the SAME id grammar
 *      (offer:accept|reject|counter:<id>). Typed fallback: "OFFER ACCEPT
 *      <id>", "OFFER REJECT <id> [note]", "OFFER COUNTER <id> <amount>".
 *   2. decideOffer flips pending → accepted|rejected|countered claim-first
 *      (SELECT … FOR UPDATE; duplicates/illegal transitions → CONFLICT).
 *      Accept creates a priced checkout: an order whose line unitPrice is the
 *      AGREED price with a price-override snapshot in orders.metadata
 *      (priceOverride: offerId, listPriceCents, agreedPriceCents, decidedBy,
 *      decidedAt) + audit row, then a PSP payment link via the EXISTING
 *      paymentIntents + initiateWithFallback chain (idempotency key
 *      offer-checkout:<offerId>), sent via the payment_link parity category.
 *      Counter sends the customer a counter-offer card
 *      (offer:caccept:<id> / offer:cdecline:<id>).
 *   3. respondToCounter (customer): accept → same priced checkout at the
 *      counter price (countered → accepted); decline → rejected.
 *   4. Expiry: pending/countered rows past expiresAt flip to 'expired' on the
 *      next touch (lazy) or via sweepExpiredOffers (CronJob pattern).
 *      'converted' marks an accepted offer whose order was PAID (lazy check
 *      on read — paymentConfirm.ts stays PINNED).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "crypto";
import { getDb } from "../db";
import {
  customOffers,
  orderItems,
  orders,
  paymentIntents,
  products,
  tenants,
  type CustomOffer,
} from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const CUSTOM_OFFER_CATEGORY = "custom_offer";
export const OFFER_TTL_MS = 48 * 3600 * 1000;
export const OFFER_OPEN_STATUSES = ["pending", "countered"] as const;
export const OFFER_TERMINAL = ["accepted", "rejected", "expired", "converted"] as const;

/** Merchant card id grammar (WA interactive buttons + TG inline keyboard). */
export const OFFER_ACCEPT_PREFIX = "offer:accept:";
export const OFFER_REJECT_PREFIX = "offer:reject:";
export const OFFER_COUNTER_PREFIX = "offer:counter:";
/** Customer counter-offer card ids. */
export const OFFER_CACCEPT_PREFIX = "offer:caccept:";
export const OFFER_CDECLINE_PREFIX = "offer:cdecline:";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function assertActiveTenant(db: Db, tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("./tenantGuard");
  assertTenantActive(tenant);
  return tenant;
}

function customerRefOf(customerId: string): { phone?: string; channel?: string; channelScopedId?: string } {
  return /^telegram:/i.test(customerId)
    ? { channel: "telegram", channelScopedId: customerId.replace(/^telegram:/i, "") }
    : { phone: customerId };
}

async function notifyOfferCustomer(
  tenantId: string,
  offer: CustomOffer,
  text: string,
  extra?: { paymentUrl?: string },
): Promise<void> {
  const { notifyCustomer } = await import("./channelParity");
  const ref = customerRefOf(offer.customerId);
  const payload: any = { text, notifType: CUSTOM_OFFER_CATEGORY, orderId: offer.orderId ?? undefined };
  if (extra?.paymentUrl) {
    payload.paymentUrl = extra.paymentUrl;
    payload.buttons = [{ label: "💳 Pay now", url: extra.paymentUrl }];
  }
  const routed = await notifyCustomer(tenantId, ref, extra?.paymentUrl ? "payment_link" : CUSTOM_OFFER_CATEGORY, payload);
  if (!routed.handled && (ref as any).phone) {
    const { sendWhatsAppText } = await import("./waSender");
    await sendWhatsAppText(tenantId, (ref as any).phone,
      extra?.paymentUrl ? `${text}\n💳 Pay: ${extra.paymentUrl}` : text,
      { notifType: CUSTOM_OFFER_CATEGORY, orderId: offer.orderId ?? undefined })
      .catch((e: any) => console.warn("[customOffers] WA notify failed:", e?.message));
  }
}

/** Merchant approval/counter card on BOTH channels (same id grammar). */
async function sendMerchantOfferCard(db: Db, tenantId: string, offer: CustomOffer, productName: string): Promise<void> {
  const [t] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1).catch(() => [] as any[]);
  const s = (t?.settings ?? null) as any;
  const adminPhone: string | null = typeof (s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone) === "string"
    ? String(s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone).trim()
    : null;
  const adminChatId: string | null = typeof s?.telegram?.adminChatId === "string" ? s.telegram.adminChatId.trim() : null;

  const fmt = `₦${(offer.offeredPriceCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
  const body =
    `🤝 Offer ${offer.id.slice(0, 8)}: a customer offers ${fmt} for ${offer.qty} × ${productName}. ` +
    `Accept, reject, or counter (OFFER COUNTER ${offer.id.slice(0, 8)} <amount>).`;
  const buttons = [
    { id: `${OFFER_ACCEPT_PREFIX}${offer.id}`, title: "✅ Accept" },
    { id: `${OFFER_REJECT_PREFIX}${offer.id}`, title: "❌ Reject" },
    { id: `${OFFER_COUNTER_PREFIX}${offer.id}`, title: "💬 Counter" },
  ];
  const sends: Promise<unknown>[] = [];
  for (const [channel, to] of [["whatsapp", adminPhone?.replace(/^\+/, "")], ["telegram", adminChatId]] as const) {
    if (!to) continue;
    sends.push((async () => {
      const { sendChannelMessage } = await import("./channelSender");
      return sendChannelMessage(tenantId, channel, to, { kind: "keyboard", text: body, buttons }, { notifType: CUSTOM_OFFER_CATEGORY });
    })());
  }
  const results = await Promise.allSettled(sends);
  for (const r of results) {
    if (r.status === "rejected") console.warn("[customOffers] merchant card send failed:", (r.reason as Error)?.message);
  }
}

/** Customer counter-offer card (accept/decline) on their channel. */
async function sendCounterCard(tenantId: string, offer: CustomOffer, productName: string): Promise<void> {
  const { notifyCustomer } = await import("./channelParity");
  const ref = customerRefOf(offer.customerId);
  const fmt = `₦${((offer.counterPriceCents ?? 0) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
  const text = `🤝 The store counters your offer for ${offer.qty} × ${productName}: ${fmt}. Accept or decline?`;
  const buttons = [
    { id: `${OFFER_CACCEPT_PREFIX}${offer.id}`, label: "✅ Accept counter" },
    { id: `${OFFER_CDECLINE_PREFIX}${offer.id}`, label: "❌ Decline" },
  ];
  const routed = await notifyCustomer(tenantId, ref, CUSTOM_OFFER_CATEGORY, { text, buttons, notifType: CUSTOM_OFFER_CATEGORY });
  if (!routed.handled && (ref as any).phone) {
    const { sendChannelMessage } = await import("./channelSender");
    await sendChannelMessage(tenantId, "whatsapp", (ref as any).phone,
      { kind: "keyboard", text, buttons: buttons.map((b) => ({ id: b.id, title: b.label })) },
      { notifType: CUSTOM_OFFER_CATEGORY })
      .catch((e: any) => console.warn("[customOffers] WA counter card failed:", e?.message));
  }
}

// ─── Price floor + offer creation ────────────────────────────────────────────

/**
 * Price floor guard: offeredPrice >= product.minPriceCents when set, else any
 * positive integer amount.
 */
export function offerFloorOk(offeredPriceCents: number, minPriceCents: number | null | undefined): boolean {
  if (!Number.isInteger(offeredPriceCents) || offeredPriceCents <= 0) return false;
  if (minPriceCents == null) return true;
  return offeredPriceCents >= minPriceCents;
}

export interface MakeOfferInput {
  tenantId: string;
  /** WA phone (digits) or telegram:<chatId>. */
  customerRef: string;
  productId?: string | null;
  /** Free-text product name (chat path) — resolved tenant-scoped, ILIKE. */
  productName?: string | null;
  variantId?: string | null;
  qty?: number;
  offeredPriceCents: number;
}

export async function makeOffer(
  db: Db,
  input: MakeOfferInput,
): Promise<{ offer: CustomOffer; productName: string }> {
  await assertActiveTenant(db, input.tenantId);
  const qty = input.qty ?? 1;
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid quantity" });
  }
  if (!Number.isInteger(input.offeredPriceCents) || input.offeredPriceCents <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Offer amount must be a positive whole number of kobo/cents." });
  }

  // Resolve the product (tenant-scoped; by id or best ILIKE name match).
  let product: typeof products.$inferSelect | undefined;
  if (input.productId) {
    [product] = await db.select().from(products)
      .where(and(eq(products.tenantId, input.tenantId), eq(products.id, input.productId)))
      .limit(1);
  } else if (input.productName?.trim()) {
    const q = `%${input.productName.trim().slice(0, 80)}%`;
    const rows = (await db.execute(sql`
      SELECT * FROM "products"
      WHERE "tenantId" = ${input.tenantId} AND "status" = 'active' AND "name" ILIKE ${q}
      ORDER BY "name" LIMIT 1
    `)) as unknown as any[];
    const list: any[] = Array.isArray(rows) ? rows : (rows as any)?.rows ?? [];
    product = list[0] as any;
  }
  if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "I couldn't find that product in this store." });

  if (!offerFloorOk(input.offeredPriceCents, product.minPriceCents)) {
    const floor = product.minPriceCents != null
      ? ` The store can't go below ₦${(product.minPriceCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} for this item.`
      : "";
    throw new TRPCError({ code: "BAD_REQUEST", message: `That offer is below this store's minimum price.${floor}` });
  }

  // One OPEN offer per (tenant, customer, product) — partial unique backstop.
  const [open] = await db.select().from(customOffers)
    .where(and(
      eq(customOffers.tenantId, input.tenantId),
      eq(customOffers.customerId, input.customerRef),
      eq(customOffers.productId, product.id),
      inArray(customOffers.status, [...OFFER_OPEN_STATUSES]),
    ))
    .limit(1);
  if (open) {
    throw new TRPCError({ code: "CONFLICT", message: `You already have an open offer for ${product.name} (ref ${open.id.slice(0, 8)}) — wait for the store to respond.` });
  }

  const now = new Date();
  const [offer] = await db.insert(customOffers).values({
    tenantId: input.tenantId,
    customerId: input.customerRef,
    productId: product.id,
    variantId: input.variantId ?? null,
    qty,
    offeredPriceCents: input.offeredPriceCents,
    status: "pending",
    expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
    createdAt: now,
  }).returning();

  await sendMerchantOfferCard(db, input.tenantId, offer!, product.name);
  return { offer: offer!, productName: product.name };
}


// ─── Priced checkout (accept path) ───────────────────────────────────────────

/**
 * Create the priced checkout for an accepted offer: an order at the AGREED
 * price with a price-override snapshot (list vs agreed, actor, timestamp) +
 * audit row, then a PSP payment link through the EXISTING paymentIntents +
 * initiateWithFallback chain (idempotency key offer-checkout:<offerId>).
 * Money is fail-closed: if the link can't be initiated the offer still reads
 * accepted but orderId stays NULL and the merchant can retry — never fake a
 * URL.
 */
async function createOfferCheckout(
  db: Db,
  offer: CustomOffer,
  agreedPriceCents: number,
  decidedBy: string,
): Promise<{ orderId: string; paymentUrl: string | null }> {
  const [product] = await db.select().from(products)
    .where(and(eq(products.tenantId, offer.tenantId), eq(products.id, offer.productId)))
    .limit(1);
  if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "Product no longer exists" });
  const listPriceCents = Math.round(Number(product.price) * 100);
  const totalCents = agreedPriceCents * offer.qty;
  const now = new Date();
  const orderId = randomUUID();
  const orderNumber = `OFR-${now.getTime().toString(36).toUpperCase()}`;

  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      tenantId: offer.tenantId,
      customerId: offer.customerId,
      orderNumber,
      status: "pending",
      totalAmount: (totalCents / 100).toFixed(2),
      currency: product.currency ?? "NGN",
      paymentStatus: "unpaid",
      items: [{ productId: product.id, productName: product.name, quantity: offer.qty, unitPrice: agreedPriceCents / 100 }],
      metadata: {
        priceOverride: {
          offerId: offer.id,
          listPriceCents,
          agreedPriceCents,
          qty: offer.qty,
          decidedBy,
          decidedAt: now.toISOString(),
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(orderItems).values({
      id: randomUUID(),
      orderId,
      productId: product.id,
      productName: product.name,
      quantity: offer.qty,
      unitPrice: (agreedPriceCents / 100).toFixed(2),
      currency: product.currency ?? "NGN",
    });
  });

  try {
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({
      tenantId: offer.tenantId,
      actorId: decidedBy,
      action: "custom_offer.price_override",
      entityType: "custom_offer",
      entityId: offer.id,
      summary: `order=${orderId} product=${product.id} list=${listPriceCents} agreed=${agreedPriceCents} qty=${offer.qty}`,
    } as any);
  } catch (e: any) {
    console.warn("[customOffers] audit write failed:", e?.message);
  }

  // Payment link via the existing chain (idempotent on offer-checkout:<id>).
  const idemKey = `offer-checkout:${offer.id}`;
  const [existingIntent] = await db.select().from(paymentIntents)
    .where(eq(paymentIntents.idempotencyKey, idemKey)).limit(1).catch(() => [] as any[]);
  if (existingIntent) {
    return { orderId, paymentUrl: (existingIntent.metadata as any)?.paymentUrl ?? null };
  }
  const paymentIntentId = randomUUID();
  const reference = `OFR-${now.getTime()}-${paymentIntentId.slice(0, 8).toUpperCase()}`;
  await db.insert(paymentIntents).values({
    id: paymentIntentId,
    tenantId: offer.tenantId,
    orderId,
    customerId: offer.customerId,
    amount: (totalCents / 100).toFixed(2),
    currency: product.currency ?? "NGN",
    provider: "paystack",
    providerPaymentId: reference,
    idempotencyKey: idemKey,
    status: "pending",
    metadata: { kind: "custom_offer", offerId: offer.id, tenantId: offer.tenantId },
    createdAt: now,
    updatedAt: now,
  });
  let paymentUrl: string | null = null;
  try {
    const { initiateWithFallback } = await import("./payments/initiateWithFallback");
    const { ENV } = await import("../_core/env");
    const fallback = await initiateWithFallback(offer.tenantId, {
      tenantId: offer.tenantId,
      amountCents: totalCents,
      currency: product.currency ?? "NGN",
      reference,
      metadata: { payment_intent_id: paymentIntentId, tenant_id: offer.tenantId, kind: "custom_offer", offerId: offer.id },
      customer: { phone: offer.customerId.replace(/^telegram:/i, "") },
      callbackUrl: `${ENV.appUrl}/orders`,
    });
    paymentUrl = fallback.result.authorizationUrl ?? null;
    await db.update(paymentIntents).set({
      status: "initiated",
      metadata: { kind: "custom_offer", offerId: offer.id, tenantId: offer.tenantId, paymentUrl, servedProvider: fallback.providerId },
      updatedAt: new Date(),
    }).where(eq(paymentIntents.id, paymentIntentId));
  } catch (e: any) {
    await db.update(paymentIntents).set({
      status: "failed",
      failureReason: `provider_init: ${String(e?.message ?? e).slice(0, 300)}`,
      updatedAt: new Date(),
    }).where(eq(paymentIntents.id, paymentIntentId)).catch(() => {});
    console.warn("[customOffers] payment link failed:", e?.message);
  }
  return { orderId, paymentUrl };
}

// ─── Decisions (claim-first state machine) ───────────────────────────────────

export interface DecideOfferInput {
  offerId: string;
  tenantId: string;
  action: "accept" | "reject" | "counter";
  counterPriceCents?: number | null;
  decidedBy?: string | null;
  note?: string | null;
}

/** Id prefix tolerance: typed commands may carry the 8-char prefix. */
async function resolveOfferId(db: Db, tenantId: string, idOrPrefix: string): Promise<string | null> {
  if (/^[0-9a-fA-F-]{36}$/.test(idOrPrefix)) return idOrPrefix;
  const rows = (await db.execute(sql`
    SELECT id FROM custom_offers
    WHERE tenant_id = ${tenantId} AND id::text LIKE ${idOrPrefix + "%"}
    ORDER BY created_at DESC LIMIT 2
  `)) as unknown as any[];
  const list: any[] = Array.isArray(rows) ? rows : (rows as any)?.rows ?? [];
  return list.length === 1 ? String(list[0].id) : null;
}

export async function decideOffer(db: Db, input: DecideOfferInput): Promise<CustomOffer> {
  await assertActiveTenant(db, input.tenantId);
  const offerId = await resolveOfferId(db, input.tenantId, input.offerId);
  if (!offerId) throw new TRPCError({ code: "NOT_FOUND", message: "offer not found" });
  if (input.action === "counter") {
    if (!Number.isInteger(input.counterPriceCents ?? NaN) || (input.counterPriceCents ?? 0) <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Counter needs a positive amount, e.g. OFFER COUNTER <id> 4800" });
    }
  }

  const decided = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT * FROM custom_offers WHERE id = ${offerId} AND tenant_id = ${input.tenantId} FOR UPDATE
    `)) as any;
    const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
    const raw = list[0];
    if (!raw) throw new TRPCError({ code: "NOT_FOUND", message: "offer not found" });
    const now = new Date();
    const nowIso = now.toISOString();
    if (raw.status === "pending" && raw.expires_at && new Date(raw.expires_at) <= now) {
      await tx.execute(sql`UPDATE custom_offers SET status = 'expired', decided_at = ${nowIso} WHERE id = ${raw.id}`);
      return { ...raw, status: "expired", decided_at: now } as any;
    }
    if (raw.status !== "pending") {
      throw new TRPCError({ code: "CONFLICT", message: `offer is already ${raw.status}` });
    }
    const next = input.action === "accept" ? "accepted" : input.action === "reject" ? "rejected" : "countered";
    await tx.execute(sql`
      UPDATE custom_offers
      SET status = ${next}, decided_by = ${input.decidedBy ?? null}, decision_note = ${input.note ?? null},
          counter_price_cents = ${input.action === "counter" ? input.counterPriceCents : null},
          decided_at = ${nowIso}
      WHERE id = ${raw.id} AND status = 'pending'
    `);
    return { ...raw, status: next, counter_price_cents: input.action === "counter" ? input.counterPriceCents : null, decided_at: now } as any;
  });

  const normalized = normalizeOffer(decided);

  // Post-decision effects (fail-open notifications; checkout is fail-closed).
  const [product] = await db.select({ name: products.name }).from(products)
    .where(and(eq(products.tenantId, input.tenantId), eq(products.id, normalized.productId)))
    .limit(1).catch(() => [] as any[]);
  const productName = product?.name ?? "that item";

  if (normalized.status === "accepted") {
    const checkout = await createOfferCheckout(db, normalized, normalized.offeredPriceCents, input.decidedBy ?? "merchant");
    await db.update(customOffers).set({ orderId: checkout.orderId }).where(eq(customOffers.id, normalized.id));
    normalized.orderId = checkout.orderId;
    const fmt = `₦${(normalized.offeredPriceCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
    const text = checkout.paymentUrl
      ? `🎉 Your offer of ${fmt} for ${normalized.qty} × ${productName} was ACCEPTED. Tap below to pay — this price is held until the offer expires.`
      : `🎉 Your offer of ${fmt} for ${normalized.qty} × ${productName} was ACCEPTED. The store will share your payment link shortly.`;
    await notifyOfferCustomer(input.tenantId, normalized, text, checkout.paymentUrl ? { paymentUrl: checkout.paymentUrl } : undefined)
      .catch((e) => console.warn("[customOffers] accept notify failed:", (e as Error)?.message));
  } else if (normalized.status === "countered") {
    await sendCounterCard(input.tenantId, normalized, productName)
      .catch((e) => console.warn("[customOffers] counter card failed:", (e as Error)?.message));
  } else {
    const text = normalized.status === "rejected"
      ? `Sorry — the store declined your offer for ${productName}${input.note ? ` (${input.note})` : ""}.`
      : `Your offer for ${productName} expired before the store responded.`;
    await notifyOfferCustomer(input.tenantId, normalized, text)
      .catch((e) => console.warn("[customOffers] terminal notify failed:", (e as Error)?.message));
  }
  return normalized;
}

/** Customer response to a counter-offer. */
export async function respondToCounter(
  db: Db,
  input: { offerId: string; tenantId: string; customerRef: string; accept: boolean },
): Promise<CustomOffer> {
  await assertActiveTenant(db, input.tenantId);
  const offerId = await resolveOfferId(db, input.tenantId, input.offerId);
  if (!offerId) throw new TRPCError({ code: "NOT_FOUND", message: "offer not found" });

  const decided = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT * FROM custom_offers WHERE id = ${offerId} AND tenant_id = ${input.tenantId} FOR UPDATE
    `)) as any;
    const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
    const raw = list[0];
    if (!raw) throw new TRPCError({ code: "NOT_FOUND", message: "offer not found" });
    if (raw.customer_id !== input.customerRef) {
      throw new TRPCError({ code: "FORBIDDEN", message: "This offer belongs to a different customer." });
    }
    const now = new Date();
    const nowIso = now.toISOString();
    if (raw.status === "countered" && raw.expires_at && new Date(raw.expires_at) <= now) {
      await tx.execute(sql`UPDATE custom_offers SET status = 'expired', decided_at = ${nowIso} WHERE id = ${raw.id}`);
      return { ...raw, status: "expired", decided_at: now } as any;
    }
    if (raw.status !== "countered") {
      throw new TRPCError({ code: "CONFLICT", message: `offer is already ${raw.status}` });
    }
    const next = input.accept ? "accepted" : "rejected";
    await tx.execute(sql`
      UPDATE custom_offers SET status = ${next}, decided_at = ${nowIso}
      WHERE id = ${raw.id} AND status = 'countered'
    `);
    return { ...raw, status: next, decided_at: now } as any;
  });

  const normalized = normalizeOffer(decided);
  const [product] = await db.select({ name: products.name }).from(products)
    .where(and(eq(products.tenantId, input.tenantId), eq(products.id, normalized.productId)))
    .limit(1).catch(() => [] as any[]);
  const productName = product?.name ?? "that item";

  if (normalized.status === "accepted") {
    const agreed = normalized.counterPriceCents ?? normalized.offeredPriceCents;
    const checkout = await createOfferCheckout(db, normalized, agreed, input.customerRef);
    await db.update(customOffers).set({ orderId: checkout.orderId }).where(eq(customOffers.id, normalized.id));
    normalized.orderId = checkout.orderId;
    const fmt = `₦${(agreed / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
    const text = checkout.paymentUrl
      ? `🎉 Deal! ${normalized.qty} × ${productName} for ${fmt}. Tap below to pay — this price is held until the offer expires.`
      : `🎉 Deal! ${normalized.qty} × ${productName} for ${fmt}. The store will share your payment link shortly.`;
    await notifyOfferCustomer(input.tenantId, normalized, text, checkout.paymentUrl ? { paymentUrl: checkout.paymentUrl } : undefined)
      .catch((e) => console.warn("[customOffers] counter-accept notify failed:", (e as Error)?.message));
  } else if (normalized.status === "rejected") {
    await notifyOfferCustomer(input.tenantId, normalized, `No problem — your offer for ${productName} is closed.`)
      .catch((e) => console.warn("[customOffers] counter-decline notify failed:", (e as Error)?.message));
  }
  return normalized;
}

// ─── Read / expiry sweep ─────────────────────────────────────────────────────

function normalizeOffer(raw: any): CustomOffer {
  return {
    id: raw.id,
    tenantId: raw.tenantId ?? raw.tenant_id,
    customerId: raw.customerId ?? raw.customer_id,
    productId: raw.productId ?? raw.product_id,
    variantId: raw.variantId ?? raw.variant_id ?? null,
    qty: Number(raw.qty),
    offeredPriceCents: Number(raw.offeredPriceCents ?? raw.offered_price_cents),
    counterPriceCents: raw.counterPriceCents ?? raw.counter_price_cents ?? null,
    status: raw.status,
    expiresAt: raw.expiresAt ?? (raw.expires_at ? new Date(raw.expires_at) : null),
    orderId: raw.orderId ?? raw.order_id ?? null,
    decidedBy: raw.decidedBy ?? raw.decided_by ?? null,
    decisionNote: raw.decisionNote ?? raw.decision_note ?? null,
    createdAt: raw.createdAt ?? (raw.created_at ? new Date(raw.created_at) : null),
    decidedAt: raw.decidedAt ?? (raw.decided_at ? new Date(raw.decided_at) : null),
  } as CustomOffer;
}

/**
 * Read an offer with the lazy transitions: expired when past expiresAt;
 * converted when the accepted offer's order is PAID (paymentConfirm stays
 * PINNED — this is the adjacent read-side seam).
 */
export async function getOffer(db: Db, tenantId: string, offerId: string): Promise<CustomOffer | null> {
  const [row] = await db.select().from(customOffers)
    .where(and(eq(customOffers.id, offerId), eq(customOffers.tenantId, tenantId)))
    .limit(1);
  if (!row) return null;
  const now = new Date();
  if ((OFFER_OPEN_STATUSES as readonly string[]).includes(row.status) && row.expiresAt <= now) {
    const [upd] = await db.update(customOffers).set({ status: "expired", decidedAt: now })
      .where(and(eq(customOffers.id, row.id), eq(customOffers.status, row.status))).returning();
    return upd ?? { ...row, status: "expired" };
  }
  if (row.status === "accepted" && row.orderId) {
    const [ord] = await db.select({ paymentStatus: orders.paymentStatus }).from(orders)
      .where(eq(orders.id, row.orderId)).limit(1).catch(() => [] as any[]);
    if (ord?.paymentStatus === "completed") {
      const [upd] = await db.update(customOffers).set({ status: "converted" })
        .where(and(eq(customOffers.id, row.id), eq(customOffers.status, "accepted"))).returning();
      return upd ?? { ...row, status: "converted" };
    }
  }
  return row;
}

export interface OfferSweepResult {
  expired: number;
}

/** Expiry sweep (CronJob pattern): open offers past expiresAt → expired + notify. */
export async function sweepExpiredOffers(
  opts: { now?: Date; db?: Db } = {},
): Promise<OfferSweepResult> {
  const db = opts.db ?? (await getDb());
  if (!db) return { expired: 0 };
  const now = opts.now ?? new Date();
  const claimed = (await db.execute(sql`
    UPDATE custom_offers SET status = 'expired', decided_at = ${now.toISOString()}
    WHERE status IN ('pending', 'countered') AND expires_at <= ${now.toISOString()}
    RETURNING *
  `)) as unknown as any[];
  const rows = (Array.isArray(claimed) ? claimed : (claimed as any).rows ?? []) as any[];
  for (const raw of rows) {
    const offer = normalizeOffer(raw);
    const [product] = await db.select({ name: products.name }).from(products)
      .where(and(eq(products.tenantId, offer.tenantId), eq(products.id, offer.productId)))
      .limit(1).catch(() => [] as any[]);
    await notifyOfferCustomer(offer.tenantId, offer,
      `Your offer for ${product?.name ?? "that item"} expired before it was decided. Feel free to make a new one.`)
      .catch((e) => console.warn("[customOffers] expiry notify failed:", (e as Error)?.message));
  }
  return { expired: rows.length };
}

/** Latest open offer for a customer (chat read-side helper). */
export async function latestOpenOffer(db: Db, tenantId: string, customerRef: string): Promise<CustomOffer | null> {
  const [row] = await db.select().from(customOffers)
    .where(and(
      eq(customOffers.tenantId, tenantId),
      eq(customOffers.customerId, customerRef),
      inArray(customOffers.status, [...OFFER_OPEN_STATUSES]),
    ))
    .orderBy(desc(customOffers.createdAt))
    .limit(1);
  return row ?? null;
}

