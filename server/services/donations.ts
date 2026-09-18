// === W46 uc-money ===
/**
 * donations.ts — UC-16: open-amount / donation products (mig 0152).
 *
 * A product with openAmountEnabled=true has no fixed charge: the BUYER
 * enters the amount in chat (BOTH channels — "DONATE 5000 to <product>" /
 * "PAY 2000 FOR <product>"). The floor guard is donationMinCents (falls
 * back to minPriceCents, else any positive integer). The checkout link is
 * minted at the buyer-entered amount through the EXISTING paymentIntents +
 * initiateWithFallback chain (idempotency key donation:<orderId>), and the
 * order carries an openAmount snapshot (productId, enteredAmountCents,
 * floorCents) in metadata. Money is fail-closed: no fake URLs.
 */
import { and, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "crypto";
import { getDb } from "../db";
import {
  orderItems,
  orders,
  paymentIntents,
  products,
  tenants,
} from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const DONATION_CATEGORY = "donation_link";

/** Floor guard: donationMinCents → minPriceCents → any positive amount. */
export function openAmountFloorCents(product: {
  donationMinCents?: number | null;
  minPriceCents?: number | null;
}): number | null {
  return product.donationMinCents ?? product.minPriceCents ?? null;
}

export function openAmountOk(amountCents: number, floorCents: number | null): boolean {
  if (!Number.isInteger(amountCents) || amountCents <= 0) return false;
  if (floorCents == null) return true;
  return amountCents >= floorCents;
}

export interface DonationCheckoutInput {
  tenantId: string;
  /** WA phone (digits) or telegram:<chatId> session key of the buyer. */
  customerRef: string;
  productId?: string | null;
  productName?: string | null;
  amountCents: number;
  note?: string | null;
}

export async function createDonationCheckout(
  db: Db,
  input: DonationCheckoutInput,
): Promise<{ orderId: string; orderNumber: string; paymentUrl: string | null; amountCents: number; productName: string }> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("./tenantGuard");
  assertTenantActive(tenant);
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Amount must be a positive whole number of kobo/cents." });
  }

  let product: typeof products.$inferSelect | undefined;
  if (input.productId) {
    [product] = await db.select().from(products)
      .where(and(eq(products.tenantId, input.tenantId), eq(products.id, input.productId)))
      .limit(1);
  } else if (input.productName?.trim()) {
    const q = `%${input.productName.trim().slice(0, 80)}%`;
    const rows = (await db.execute(sql`
      SELECT * FROM "products"
      WHERE "tenantId" = ${input.tenantId} AND "status" = 'active'
        AND "openAmountEnabled" = true AND "name" ILIKE ${q}
      ORDER BY "name" LIMIT 1
    `)) as unknown as any[];
    const list: any[] = Array.isArray(rows) ? rows : (rows as any)?.rows ?? [];
    product = list[0] as any;
  }
  if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "I couldn't find an open-amount item like that in this store." });
  if (!product.openAmountEnabled) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${product.name} has a fixed price — add it to your cart instead.` });
  }
  const floor = openAmountFloorCents(product);
  if (!openAmountOk(input.amountCents, floor)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `The minimum for ${product.name} is ₦${((floor ?? 0) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}.`,
    });
  }

  const now = new Date();
  const orderId = randomUUID();
  const orderNumber = `DON-${now.getTime().toString(36).toUpperCase()}`;
  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      tenantId: input.tenantId,
      customerId: input.customerRef,
      orderNumber,
      status: "pending",
      totalAmount: (input.amountCents / 100).toFixed(2),
      currency: product.currency ?? "NGN",
      paymentStatus: "unpaid",
      items: [{ productId: product.id, productName: product.name, quantity: 1, unitPrice: input.amountCents / 100 }],
      metadata: {
        openAmount: {
          productId: product.id,
          enteredAmountCents: input.amountCents,
          floorCents: floor,
          note: input.note ?? null,
          enteredAt: now.toISOString(),
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
      quantity: 1,
      unitPrice: (input.amountCents / 100).toFixed(2),
      currency: product.currency ?? "NGN",
    });
  });

  // Payment link via the existing chain (idempotent on donation:<orderId>).
  const idemKey = `donation:${orderId}`;
  const paymentIntentId = randomUUID();
  const reference = `DON-${now.getTime()}-${paymentIntentId.slice(0, 8).toUpperCase()}`;
  await db.insert(paymentIntents).values({
    id: paymentIntentId,
    tenantId: input.tenantId,
    orderId,
    customerId: input.customerRef,
    amount: (input.amountCents / 100).toFixed(2),
    currency: product.currency ?? "NGN",
    provider: "paystack",
    providerPaymentId: reference,
    idempotencyKey: idemKey,
    status: "pending",
    metadata: { kind: "donation", productId: product.id, tenantId: input.tenantId },
    createdAt: now,
    updatedAt: now,
  });
  let paymentUrl: string | null = null;
  try {
    const { initiateWithFallback } = await import("./payments/initiateWithFallback");
    const { ENV } = await import("../_core/env");
    const fallback = await initiateWithFallback(input.tenantId, {
      tenantId: input.tenantId,
      amountCents: input.amountCents,
      currency: product.currency ?? "NGN",
      reference,
      metadata: { payment_intent_id: paymentIntentId, tenant_id: input.tenantId, kind: "donation", productId: product.id },
      customer: { phone: input.customerRef.replace(/^telegram:/i, "") },
      callbackUrl: `${ENV.appUrl}/orders`,
    });
    paymentUrl = fallback.result.authorizationUrl ?? null;
    await db.update(paymentIntents).set({
      status: "initiated",
      metadata: { kind: "donation", productId: product.id, tenantId: input.tenantId, paymentUrl, servedProvider: fallback.providerId },
      updatedAt: new Date(),
    }).where(eq(paymentIntents.id, paymentIntentId));
  } catch (e: any) {
    await db.update(paymentIntents).set({
      status: "failed",
      failureReason: `provider_init: ${String(e?.message ?? e).slice(0, 300)}`,
      updatedAt: new Date(),
    }).where(eq(paymentIntents.id, paymentIntentId)).catch(() => {});
    console.warn("[donations] payment link failed:", e?.message);
  }

  // Notify the buyer on their channel (payment_link parity category).
  const { notifyCustomer } = await import("./channelParity");
  const ref = /^telegram:/i.test(input.customerRef)
    ? { channel: "telegram", channelScopedId: input.customerRef.replace(/^telegram:/i, "") }
    : { phone: input.customerRef };
  const text = `🙏 Thank you! Your ${(input.amountCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} ${product.currency ?? "NGN"} ` +
    `for ${product.name} is ready — complete it here:`;
  const routed = await notifyCustomer(input.tenantId, ref as any, "payment_link", {
    text, paymentUrl: paymentUrl ?? undefined,
    buttons: paymentUrl ? [{ label: "💳 Pay now", url: paymentUrl }] : undefined,
    notifType: DONATION_CATEGORY, orderId,
  } as any);
  if (!routed.handled && (ref as any).phone) {
    const { sendWhatsAppText } = await import("./waSender");
    await sendWhatsAppText(input.tenantId, (ref as any).phone,
      paymentUrl ? `${text}\n💳 Pay: ${paymentUrl}` : `${text} (link pending — the store will follow up)`,
      { notifType: DONATION_CATEGORY, orderId })
      .catch((e: any) => console.warn("[donations] WA notify failed:", e?.message));
  }
  return { orderId, orderNumber, paymentUrl, amountCents: input.amountCents, productName: product.name };
}
// === END W46 uc-money (donations) ===
