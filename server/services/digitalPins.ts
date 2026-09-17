// === W44 deposits-subs-digital (Coder C) ===
/**
 * digitalPins.ts — PIN digital goods (mig 0142).
 *
 *  - Merchant bulk-uploads PIN codes for a digital product (tRPC
 *    digitalPins.uploadBatch). Every PIN is encrypted at rest with the W42
 *    keyring v2:<kid> envelope (crypto/secrets.ts encryptSecret) — the
 *    plaintext NEVER persists and is decrypted server-side ONLY at
 *    delivery. Uploading a fresh batch clears the low-stock alert marker.
 *  - On a PAID order (webhook hook after the pinned confirmProviderPayment,
 *    or the subscription-billing order leg) allocatePinsForOrder walks the
 *    order's digital lines and claims one available PIN per unit
 *    (UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)) inside
 *    a txn. The PIN is then DELIVERED on the buyer's channel (BOTH WhatsApp
 *    + Telegram via channelParity, category digital_pin) and flipped to
 *    revealed (first delivery).
 *  - "reveal my pin" (chat, both channels) re-sends the SAME pin and writes
 *    an audit row on EVERY reveal.
 *  - Low stock: when the available count for a product drops below
 *    LOW_STOCK_THRESHOLD (10) the merchant gets an ops alert (adminPhone WA
 *    + settings.telegram.adminChatId) — once per dip (re-armed on upload).
 *  - Out of stock at allocation: the line follows the W43 backorder path
 *    when tenants.allowBackorders is on; otherwise the merchant is alerted
 *    that fulfillment is BLOCKED (honest — never faked).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  digitalPinBatches,
  digitalPins,
  orderItems,
  orders,
  products,
  tenants,
  type DigitalPinBatch,
} from "../../drizzle/schema";
import { encryptSecret, decryptSecret } from "./crypto/secrets";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const DIGITAL_PIN_CATEGORY = "digital_pin";
export const LOW_STOCK_THRESHOLD = 10;

async function requireActiveTenant(db: Db, tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("./tenantGuard");
  assertTenantActive(tenant);
  return tenant;
}

// ─── Merchant upload (tRPC) ──────────────────────────────────────────────────

export async function uploadPinBatch(
  db: Db,
  input: { tenantId: string; productId: string; uploadedBy: string; pins: string[] },
): Promise<{ batch: DigitalPinBatch; accepted: number; duplicatesRejected: number }> {
  await requireActiveTenant(db, input.tenantId);
  const [product] = await db.select().from(products)
    .where(and(eq(products.id, input.productId), eq(products.tenantId, input.tenantId)))
    .limit(1);
  if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "product not found" });
  if (!product.digitalPinEnabled) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This product is not enabled for PIN digital goods." });
  }
  const cleaned = (input.pins ?? []).map((p) => String(p).trim()).filter((p) => p.length >= 4 && p.length <= 128);
  if (cleaned.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "No valid PINs supplied (4-128 chars each)." });
  }
  const dedup = Array.from(new Set(cleaned));
  const duplicatesRejected = cleaned.length - dedup.length;

  const batch = await db.transaction(async (tx) => {
    const [b] = await tx.insert(digitalPinBatches).values({
      tenantId: input.tenantId,
      productId: input.productId,
      uploadedBy: input.uploadedBy.slice(0, 64),
      pinCount: dedup.length,
    }).returning();
    for (const pin of dedup) {
      await tx.insert(digitalPins).values({
        batchId: b!.id,
        tenantId: input.tenantId,
        productId: input.productId,
        pinEncrypted: encryptSecret(pin), // v2:<kid> envelope
        status: "available",
      });
    }
    // Fresh stock re-arms the low-stock alert marker.
    await tx.execute(sql`
      UPDATE tenants
      SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{digitalPinLowStockAlerted}', coalesce(settings->'digitalPinLowStockAlerted', '{}'::jsonb) - ${input.productId})
      WHERE id = ${input.tenantId}`);
    return b!;
  });

  try {
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({
      tenantId: input.tenantId,
      actorId: input.uploadedBy,
      action: "digital_pin.batch_uploaded",
      entityType: "digital_pin_batch",
      entityId: batch.id,
      summary: `product=${input.productId} pins=${dedup.length} dupes_rejected=${duplicatesRejected}`,
    } as any);
  } catch (e: any) {
    console.warn("[digitalPins] audit write failed:", e?.message);
  }
  // Restock cohesion: paid orders with BACKORDERED lines of this product
  // (W43 path taken while OOS) get their PINs allocated now (bounded).
  try {
    const pending = (await db.execute(sql`
      SELECT DISTINCT o.id AS order_id
      FROM order_items li
      JOIN orders o ON o.id = li."orderId" AND o."tenantId" = ${input.tenantId}
      WHERE li."productId" = ${input.productId} AND li.status = 'backordered'
        AND o."paymentStatus" = 'completed'
      LIMIT 20`)) as any;
    const pendingList: any[] = Array.isArray(pending) ? pending : (pending?.rows ?? []);
    for (const row of pendingList) {
      await allocatePinsForOrder(db, input.tenantId, row.order_id).catch((e: any) =>
        console.warn("[digitalPins] post-upload allocation failed:", e?.message));
    }
  } catch (e: any) {
    console.warn("[digitalPins] post-upload sweep failed:", e?.message);
  }
  return { batch, accepted: dedup.length, duplicatesRejected };
}

// ─── Low-stock merchant alert ────────────────────────────────────────────────

async function availableCount(db: Db, tenantId: string, productId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM digital_pins
    WHERE tenant_id = ${tenantId} AND product_id = ${productId} AND status = 'available'`)) as any;
  const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
  return Number(list[0]?.n ?? 0);
}

async function maybeAlertLowStock(db: Db, tenantId: string, productId: string): Promise<void> {
  try {
    const n = await availableCount(db, tenantId, productId);
    if (n >= LOW_STOCK_THRESHOLD) return;
    const [t] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const s = (t?.settings ?? {}) as any;
    const alerted = s?.digitalPinLowStockAlerted ?? {};
    if (alerted[productId]) return; // already alerted for this dip
    // Mark alerted FIRST (claim) so concurrent allocations don't spam.
    await db.execute(sql`
      UPDATE tenants
      SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{digitalPinLowStockAlerted}', coalesce(settings->'digitalPinLowStockAlerted', '{}'::jsonb) || ${JSON.stringify({ [productId]: true })}::jsonb)
      WHERE id = ${tenantId}`);
    const [p] = await db.select({ name: products.name }).from(products).where(eq(products.id, productId)).limit(1).catch(() => [] as any[]);
    const text = `⚠️ Low PIN stock: "${p?.name ?? productId}" has ${n} PIN(s) left (threshold ${LOW_STOCK_THRESHOLD}). Upload more via the dashboard (digitalPins.uploadBatch).`;
    const adminPhone: string | null = typeof (s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone) === "string"
      ? String(s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone).trim() : null;
    const adminChatId: string | null = typeof s?.telegram?.adminChatId === "string" ? s.telegram.adminChatId.trim() : null;
    const sends: Promise<unknown>[] = [];
    if (adminPhone) {
      sends.push((async () => {
        const { sendChannelMessage } = await import("./channelSender");
        return sendChannelMessage(tenantId, "whatsapp", adminPhone.replace(/^\+/, ""), { kind: "text", text }, { notifType: "ops_alert" });
      })());
    }
    if (adminChatId) {
      sends.push((async () => {
        const { sendChannelMessage } = await import("./channelSender");
        return sendChannelMessage(tenantId, "telegram", adminChatId, { kind: "text", text }, { notifType: "ops_alert" });
      })());
    }
    const results = await Promise.allSettled(sends);
    for (const r of results) if (r.status === "rejected") console.warn("[digitalPins] low-stock alert failed:", (r.reason as Error)?.message);
  } catch (e: any) {
    console.warn("[digitalPins] maybeAlertLowStock failed:", e?.message);
  }
}

// ─── Allocation on paid orders ───────────────────────────────────────────────

async function notifyCustomerPin(tenantId: string, customerRef: string, text: string, orderId?: string): Promise<void> {
  try {
    const { notifyCustomer } = await import("./channelParity");
    const ref = /^telegram:/i.test(customerRef)
      ? { channel: "telegram", channelScopedId: customerRef.replace(/^telegram:/i, "") }
      : { phone: customerRef.replace(/^\+/, "") };
    const routed = await notifyCustomer(tenantId, ref, DIGITAL_PIN_CATEGORY, { text, notifType: DIGITAL_PIN_CATEGORY, orderId });
    if (!routed.handled) {
      const phone = (ref as any).phone ?? "";
      if (phone) {
        const { sendWhatsAppText } = await import("./waSender");
        await sendWhatsAppText(tenantId, phone, text, { notifType: DIGITAL_PIN_CATEGORY, orderId }).catch((e: any) => console.warn("[digitalPins] WA notify failed:", e?.message));
      }
    }
  } catch (e: any) {
    console.warn("[digitalPins] notify failed:", e?.message);
  }
}

export interface PinAllocationResult {
  orderId: string;
  allocated: number;
  backordered: number;
  blocked: number;
}

/**
 * Allocate + deliver PINs for every digital line of a PAID order. Claim-first
 * (SKIP LOCKED) per unit; idempotent per order line (a line with a claimed
 * PIN row is skipped). OOS → W43 backorder path per tenants.allowBackorders.
 */
export async function allocatePinsForOrder(db: Db, tenantId: string, orderId: string): Promise<PinAllocationResult> {
  const result: PinAllocationResult = { orderId, allocated: 0, backordered: 0, blocked: 0 };
  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
    .limit(1)
    .catch(() => [] as any[]);
  if (!order) return result;

  const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).catch(() => [] as any[]);
  const digitalLines: Array<{ line: any; product: any }> = [];
  for (const line of lines) {
    const [p] = await db.select().from(products)
      .where(and(eq(products.id, line.productId), eq(products.tenantId, tenantId)))
      .limit(1)
      .catch(() => [] as any[]);
    if (p?.digitalPinEnabled) digitalLines.push({ line, product: p });
  }
  if (!digitalLines.length) return result;

  const { isBackordersEnabled, markLineBackordered } = await import("./backorders");
  const backordersOn = await isBackordersEnabled(db, tenantId).catch(() => false);

  for (const { line, product } of digitalLines) {
    const qty = Math.max(1, Number(line.quantity) || 1);
    for (let unit = 0; unit < qty; unit++) {
      // Idempotency: this line already has claimed PINs covering this unit?
      const existing = (await db.execute(sql`
        SELECT count(*)::int AS n FROM digital_pins
        WHERE tenant_id = ${tenantId} AND order_line_id = ${line.id} AND status IN ('sold','revealed')`)) as any;
      const existingN = Number((Array.isArray(existing) ? existing : (existing?.rows ?? []))[0]?.n ?? 0);
      if (existingN > unit) continue; // unit already claimed (replay)

      // Claim-first allocation inside a txn.
      const claimed = await db.transaction(async (tx) => {
        const rows = (await tx.execute(sql`
          UPDATE digital_pins
          SET status = 'sold', order_line_id = ${String(line.id).slice(0, 36)}, order_id = ${orderId}, sold_at = now()
          WHERE id = (
            SELECT id FROM digital_pins
            WHERE tenant_id = ${tenantId} AND product_id = ${product.id} AND status = 'available'
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id, pin_encrypted`)) as any;
        const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
        return list[0] ?? null;
      });

      if (!claimed) {
        // Out of stock: W43 backorder path or honest block.
        if (backordersOn) {
          try {
            await markLineBackordered(db, { tenantId, orderLineId: line.id, qty: 1 });
            result.backordered++;
          } catch (e: any) {
            console.warn("[digitalPins] backorder mark failed:", e?.message);
            result.blocked++;
          }
        } else {
          result.blocked++;
          await alertMerchantFulfillmentBlocked(db, tenantId, order, product);
        }
        continue;
      }

      result.allocated++;
      // Deliver: decrypt server-side ONLY here, then flip to revealed.
      const pin = decryptSecret(claimed.pin_encrypted);
      await db.execute(sql`
        UPDATE digital_pins SET status = 'revealed', revealed_at = now() WHERE id = ${claimed.id} AND status = 'sold'`);
      try {
        const { writeAuditLog } = await import("../routers/audit");
        await writeAuditLog({
          tenantId,
          actorId: "system",
          action: "digital_pin.delivered",
          entityType: "digital_pin",
          entityId: claimed.id,
          summary: `order=${orderId} line=${line.id} product=${product.id}`,
        } as any);
      } catch { /* audit is best-effort */ }
      await notifyCustomerPin(tenantId, String(order.customerId),
        `🔑 Your ${product.name} PIN (order ${order.orderNumber}):\n\n*${pin}*\n\nKeep it safe — reply "reveal my pin" anytime to see it again.`,
        orderId);
      await maybeAlertLowStock(db, tenantId, product.id);
    }
  }
  return result;
}

async function alertMerchantFulfillmentBlocked(db: Db, tenantId: string, order: any, product: any): Promise<void> {
  try {
    const [t] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const s = (t?.settings ?? {}) as any;
    const adminPhone: string | null = typeof (s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone) === "string"
      ? String(s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone).trim() : null;
    if (!adminPhone) return;
    const { sendChannelMessage } = await import("./channelSender");
    await sendChannelMessage(tenantId, "whatsapp", adminPhone.replace(/^\+/, ""), {
      kind: "text",
      text: `🚫 PIN fulfillment BLOCKED: order ${order.orderNumber} needs a "${product.name}" PIN but none are available and backorders are disabled. Upload PINs, then contact the customer.`,
    }, { notifType: "ops_alert", orderId: order.id });
  } catch (e: any) {
    console.warn("[digitalPins] blocked alert failed:", e?.message);
  }
}

// ─── Reveal again (chat, both channels) ──────────────────────────────────────

export async function revealPinAgain(
  db: Db,
  input: { tenantId: string; customerRef: string },
): Promise<string> {
  await requireActiveTenant(db, input.tenantId);
  let customerId = input.customerRef.replace(/^\+/, "");
  if (/^telegram:/i.test(customerId)) {
    const chatId = customerId.replace(/^telegram:/i, "");
    const { telegramIdentities } = await import("../../drizzle/schema");
    const [ident] = await db.select({ phone: telegramIdentities.phoneE164 })
      .from(telegramIdentities)
      .where(and(eq(telegramIdentities.tenantId, input.tenantId), eq(telegramIdentities.chatId, chatId)))
      .limit(1)
      .catch(() => [] as any[]);
    customerId = ident?.phone ?? customerId;
  }
  // Latest PIN sold to this customer (via order ownership).
  const rows = (await db.execute(sql`
    SELECT p.id, p.pin_encrypted, p.status, o."orderNumber" AS order_number
    FROM digital_pins p
    JOIN orders o ON o.id = p.order_id AND o."tenantId" = ${input.tenantId}
    WHERE p.tenant_id = ${input.tenantId}
      AND o."customerId" = ${customerId.slice(0, 36)}
      AND p.status IN ('sold','revealed')
    ORDER BY p.sold_at DESC NULLS LAST
    LIMIT 1`)) as any;
  const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
  const pinRow = list[0];
  if (!pinRow) return "I couldn't find a digital PIN for this number yet — it appears here right after your payment is confirmed.";

  const pin = decryptSecret(pinRow.pin_encrypted); // server-side only
  await db.execute(sql`UPDATE digital_pins SET status = 'revealed', revealed_at = now() WHERE id = ${pinRow.id}`);
  try {
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({
      tenantId: input.tenantId,
      actorId: customerId,
      action: "digital_pin.revealed",
      entityType: "digital_pin",
      entityId: pinRow.id,
      summary: `customer re-revealed pin for order ${pinRow.order_number}`,
    } as any);
  } catch { /* best-effort */ }
  await notifyCustomerPin(input.tenantId, input.customerRef,
    `🔑 Your PIN for order ${pinRow.order_number} (reveal):\n\n*${pin}*`);
  return `🔑 I've re-sent your PIN for order ${pinRow.order_number} — check the message above.`;
}

/** Stock snapshot for merchant queries/tests. */
export async function pinStockForProduct(db: Db, tenantId: string, productId: string): Promise<{ available: number; sold: number; revealed: number }> {
  const rows = (await db.execute(sql`
    SELECT status, count(*)::int AS n FROM digital_pins
    WHERE tenant_id = ${tenantId} AND product_id = ${productId}
    GROUP BY status`)) as any;
  const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
  const out = { available: 0, sold: 0, revealed: 0 };
  for (const r of list) if (r.status in out) (out as any)[r.status] = Number(r.n);
  return out;
}

// ─── Webhook hook entry (paid order → allocate) ──────────────────────────────

/**
 * Called from the paystack/flutterwave webhook handlers after the pinned
 * confirmProviderPayment succeeded: resolves the payment intent by
 * reference → real storefront order → allocatePinsForOrder. Exactly-once
 * per line (allocation idempotency lives in allocatePinsForOrder).
 */
export async function runDigitalPinWebhookHook(
  db: Db,
  args: { provider: string; reference: string },
): Promise<{ handled: boolean; orderId?: string }> {
  try {
    const { paymentIntents } = await import("../../drizzle/schema");
    const [intent] = await db.select().from(paymentIntents)
      .where(eq(paymentIntents.providerPaymentId, args.reference))
      .limit(1);
    if (!intent?.orderId) return { handled: false };
    const [order] = await db.select({ id: orders.id, tenantId: orders.tenantId }).from(orders)
      .where(and(eq(orders.id, intent.orderId), eq(orders.tenantId, intent.tenantId)))
      .limit(1);
    if (!order) return { handled: false }; // non-storefront reference (AR, appointment, …)
    const res = await allocatePinsForOrder(db, order.tenantId, order.id);
    return { handled: res.allocated + res.backordered + res.blocked > 0, orderId: order.id };
  } catch (e: any) {
    console.error("[digitalPins] webhook hook failed:", e?.message);
    return { handled: false };
  }
}
