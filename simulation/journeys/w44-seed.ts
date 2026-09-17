// === W44 deposits-subs-digital (Coder C) ===
/**
 * w44-seed.ts — shared seeds for the W44 journeys (J347–J351).
 * NOT a journey itself (runner imports journeys explicitly).
 */
import { randomUUID } from "node:crypto";
import { TENANT_ID, type World } from "../world";

/** Bookable service product for the tenant (id stable per tag). */
export async function seedServiceProduct(world: World, tag: string, priceCents = 20_000): Promise<{ productId: string; name: string }> {
  const schema = await import("../../drizzle/schema");
  const productId = `svc-w44-${tag}`;
  const name = `Braids Deluxe ${tag.toUpperCase()}`;
  await world.db.execute(
    `DELETE FROM products WHERE id = '${productId}'`,
  ).catch(() => undefined);
  await world.db.insert(schema.products).values({
    id: productId,
    tenantId: TENANT_ID,
    sku: `SIM-SVC-${tag.toUpperCase()}`,
    name,
    price: (priceCents / 100).toFixed(2),
    currency: "NGN",
    status: "active",
    stockQuantity: 0,
    serviceBookingEnabled: true,
    serviceDurationMinutes: 60,
  });
  return { productId, name };
}

/** PIN-digital product for the tenant. */
export async function seedDigitalProduct(world: World, tag: string, priceCents = 5_000): Promise<{ productId: string; name: string }> {
  const schema = await import("../../drizzle/schema");
  const productId = `dig-w44-${tag}`;
  const name = `Recharge PIN Pack ${tag.toUpperCase()}`;
  await world.db.execute(`DELETE FROM products WHERE id = '${productId}'`).catch(() => undefined);
  await world.db.insert(schema.products).values({
    id: productId,
    tenantId: TENANT_ID,
    sku: `SIM-DIG-${tag.toUpperCase()}`,
    name,
    price: (priceCents / 100).toFixed(2),
    currency: "NGN",
    status: "active",
    stockQuantity: 0,
    digitalPinEnabled: true,
  });
  return { productId, name };
}

/** Paid-order seed for PIN allocation (pending intent → webhook confirms). */
export async function seedDigitalOrder(
  world: World,
  tag: string,
  phone: string,
  productId: string,
  productName: string,
  qty: number,
  unitPriceCents: number,
): Promise<{ orderId: string; orderNumber: string; lineId: string; reference: string; amountCents: number }> {
  const schema = await import("../../drizzle/schema");
  const orderId = randomUUID();
  const orderNumber = `W44-${tag.toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
  const reference = `w44pin-${tag}-${randomUUID().slice(0, 8)}`;
  const amountCents = qty * unitPriceCents;
  const now = new Date();
  await world.db.insert(schema.orders).values({
    id: orderId,
    tenantId: TENANT_ID,
    customerId: phone,
    orderNumber,
    status: "pending",
    totalAmount: (amountCents / 100).toFixed(2),
    currency: "NGN",
    paymentStatus: "unpaid",
    metadata: {},
  });
  const lineId = randomUUID();
  await world.db.insert(schema.orderItems).values({
    id: lineId,
    orderId,
    productId,
    productName,
    quantity: qty,
    unitPrice: (unitPriceCents / 100).toFixed(2),
    currency: "NGN",
  });
  await world.db.insert(schema.paymentIntents).values({
    id: randomUUID(),
    tenantId: TENANT_ID,
    orderId,
    customerId: phone,
    amount: (amountCents / 100).toFixed(2),
    currency: "NGN",
    provider: "paystack",
    providerPaymentId: reference,
    idempotencyKey: `seed:${reference}`,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  return { orderId, orderNumber, lineId, reference, amountCents };
}

/** Save an active fake payment token for a buyer (W41 contract, explicit consent). */
export async function seedFakeToken(world: World, phone: string): Promise<string> {
  const { saveCustomerToken } = await import("../../server/services/customerPaymentTokens");
  const row = await saveCustomerToken(world.db, {
    tenantId: TENANT_ID,
    buyerPhone: phone,
    provider: "fake",
    token: `fake-tok-${randomUUID().slice(0, 12)}`,
    displayLabel: "Dev card",
    consentText: "Save this card for subscription billing? Reply YES to save it. You can remove it anytime.",
  });
  return row.id;
}

/** Bind a telegram chat id to a buyer phone (channel resolution). */
export async function bindTelegram(world: World, phone: string, chatId: string): Promise<void> {
  const schema = await import("../../drizzle/schema");
  await world.db.insert(schema.telegramIdentities).values({
    tenantId: TENANT_ID,
    chatId,
    phoneE164: phone.replace(/^\+/, ""),
    linkedVia: "sim-seed",
  }).catch(async () => {
    // Row may exist from a previous journey — update instead.
    await world.db.execute(
      `UPDATE telegram_identities SET phone_e164 = '${phone.replace(/^\+/, "")}' WHERE tenant_id = '${TENANT_ID}' AND chat_id = '${chatId}'`,
    );
  });
}
