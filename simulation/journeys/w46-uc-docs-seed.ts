// === W46 uc-docs ===
/**
 * w46-uc-docs-seed.ts — shared seeds for the W46 uc-docs journeys
 * (J402–J406). NOT a journey itself (runner imports journeys explicitly).
 */
import crypto from "crypto";
import { eq } from "drizzle-orm";
import type { World } from "../world";
import { tenantCaller } from "./helpers";

export interface UcTenant { tenantId: string; caller: any }

/** Tenant + owner membership + moneyProcedure-capable caller. */
export async function seedUcTenant(world: World, tag: string, userId = 4601): Promise<UcTenant> {
  const schema = await import("../../drizzle/schema");
  const tenantId = `sim-w46-${tag}`;
  await world.db.insert(schema.tenants).values({
    id: tenantId, name: `W46 ${tag}`, slug: tenantId, status: "active",
  }).onConflictDoNothing();
  await world.db.insert(schema.tenantMemberships).values({
    tenantId, userId: String(userId), role: "owner",
  }).onConflictDoNothing();
  const caller = await tenantCaller(tenantId, { userId });
  return { tenantId, caller };
}

export interface SeededPaidOrder { orderId: string; productId: string; totalCents: number }

/** Product + order (+ one item) + optional completed payment intent. */
export async function seedOrder(
  world: World,
  tenantId: string,
  tag: string,
  phone: string,
  opts: { status?: string; paymentStatus?: string; qty?: number; unitPrice?: string; currency?: string; paid?: boolean; metadata?: Record<string, unknown>; createdAt?: Date } = {},
): Promise<SeededPaidOrder> {
  const schema = await import("../../drizzle/schema");
  const qty = opts.qty ?? 2;
  const productId = `prod-w46-${tag}`;
  await world.db.delete(schema.products).where(eq(schema.products.id, productId)).catch(() => undefined);
  await world.db.insert(schema.products).values({
    id: productId,
    tenantId,
    sku: `SIM-W46-${tag.toUpperCase()}`,
    name: `W46 Product ${tag}`,
    price: opts.unitPrice ?? "4000.00",
    currency: opts.currency ?? "NGN",
    status: "active",
    stockQuantity: 50,
  });
  const totalCents = Math.round(parseFloat(opts.unitPrice ?? "4000.00") * 100) * qty;
  const orderId = `ord-w46-${tag}-${crypto.randomUUID().slice(0, 8)}`;
  await world.db.insert(schema.orders).values({
    id: orderId,
    tenantId,
    customerId: phone,
    orderNumber: `W46-${tag.toUpperCase()}-${crypto.randomUUID().slice(0, 4)}`,
    status: opts.status ?? "delivered",
    totalAmount: (totalCents / 100).toFixed(2),
    currency: opts.currency ?? "NGN",
    paymentStatus: opts.paymentStatus ?? (opts.paid === false ? "unpaid" : "completed"),
    metadata: (opts.metadata ?? {}) as any,
    createdAt: opts.createdAt ?? new Date(),
    updatedAt: new Date(),
  } as any);
  await world.db.insert(schema.orderItems).values({
    id: crypto.randomUUID(),
    orderId,
    productId,
    productName: `W46 Product ${tag}`,
    quantity: qty,
    unitPrice: opts.unitPrice ?? "4000.00",
    currency: opts.currency ?? "NGN",
  });
  if (opts.paid !== false) {
    await world.db.insert(schema.paymentIntents).values({
      id: crypto.randomUUID(),
      tenantId,
      orderId,
      customerId: phone.slice(0, 36),
      amount: (totalCents / 100).toFixed(2),
      currency: opts.currency ?? "NGN",
      provider: "paystack",
      providerPaymentId: `W46PAY-${tag.toUpperCase()}-${crypto.randomUUID().slice(0, 6)}`,
      idempotencyKey: `w46:${tag}:${orderId}`,
      status: "completed",
      completedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
  }
  return { orderId, productId, totalCents };
}

/** Link a telegram chat identity to a phone (digits-only, as the resolver does). */
export async function bindTelegram(world: World, tenantId: string, phoneE164: string, chatId: string) {
  const schema = await import("../../drizzle/schema");
  await world.db.insert(schema.telegramIdentities).values({
    tenantId,
    chatId,
    phoneE164: phoneE164.replace(/\D/g, ""),
    username: `w46_${chatId}`,
    linkedVia: "w46-sim",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any).onConflictDoNothing();
}
// === END W46 uc-docs ===
