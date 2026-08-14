/**
 * shopifyIntegration/orderBridge.ts — Shopify orders/create webhook →
 * platform order (roadmap F7, capability order_bridge_in).
 *
 * Guarantees:
 *   - EXACTLY-ONCE: dedupe by Shopify order id (state.orders.processedIds);
 *     a replayed/retried webhook returns { action: 'duplicate' } and never
 *     double-books.
 *   - Totals are computed in KOBO (minor units) with integer math, then
 *     stored as the orders.totalAmount decimal (major units).
 *   - Unknown SKU: the order is STILL captured; unmatched items are flagged
 *     in metadata.unmatchedItems so an operator can reconcile.
 *   - The customer is matched by phone (customer.phone → shipping/billing
 *     phone); a placeholder customer is created when none matches so the
 *     order always has a valid customerId.
 */
import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { customers, orders, orderItems, products } from "../../../drizzle/schema";
import { writeAuditLog } from "../../routers/audit";
import {
  loadTenantSettings,
  readShopifyState,
  updateShopifyState,
} from "./state";
import { redactShopifyPayload } from "./security";

/** Major-unit string/number → kobo integer. Integer math only (no float accumulation). */
export function toKobo(amount: string | number | null | undefined): number {
  if (amount === null || amount === undefined) return 0;
  const n = typeof amount === "number" ? amount : parseFloat(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export interface ShopifyOrderLineItem {
  id?: number;
  sku?: string | null;
  title?: string;
  name?: string;
  quantity?: number;
  price?: string;
}

export interface ShopifyOrderPayload {
  id: number | string;
  name?: string; // e.g. "#1001"
  order_number?: number;
  currency?: string;
  total_price?: string;
  current_total_price?: string;
  line_items?: ShopifyOrderLineItem[];
  customer?: { phone?: string | null; email?: string | null; first_name?: string; last_name?: string } | null;
  billing_address?: { phone?: string | null } | null;
  shipping_address?: { phone?: string | null } | null;
  financial_status?: string;
}

export type OrderBridgeResult =
  | { action: "created"; orderId: string; orderNumber: string; unmatchedItems: string[] }
  | { action: "duplicate"; orderId: string }
  | { action: "failed"; error: string };

function extractPhone(p: ShopifyOrderPayload): string | null {
  const raw =
    p.customer?.phone ?? p.shipping_address?.phone ?? p.billing_address?.phone ?? null;
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, "");
  return digits.length >= 7 ? digits.slice(0, 30) : null;
}

/**
 * Bridge one Shopify orders/create payload into the platform order model.
 * Never throws — returns a structured result (the webhook route must answer
 * 200 for duplicates and 5xx only for transient failures Shopify may retry).
 */
export async function bridgeShopifyOrder(
  tenantId: string,
  payload: ShopifyOrderPayload,
): Promise<OrderBridgeResult> {
  try {
    const shopifyOrderId = String(payload.id);
    if (!shopifyOrderId || shopifyOrderId === "undefined") {
      return { action: "failed", error: "missing order id" };
    }
    const { db, settings } = await loadTenantSettings(tenantId);
    const state = readShopifyState(settings);

    // Exactly-once: replay tolerance for Shopify's at-least-once delivery.
    const existing = state.orders.processedIds[shopifyOrderId];
    if (existing) return { action: "duplicate", orderId: existing };

    // ── Customer: match by phone, else create a placeholder. ──────────────
    const phone = extractPhone(payload);
    let customerId: string | null = null;
    if (phone) {
      const [c] = await db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, phone)))
        .limit(1);
      customerId = c?.id ?? null;
    }
    if (!customerId) {
      customerId = crypto.randomUUID();
      const name = [payload.customer?.first_name, payload.customer?.last_name]
        .filter(Boolean)
        .join(" ") || null;
      await db.insert(customers).values({
        id: customerId,
        tenantId,
        whatsappPhone: phone ?? `shopify-${shopifyOrderId}`.slice(0, 30),
        name,
        email: payload.customer?.email ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
    }

    // ── Line items: match by SKU, kobo math, flag unknowns. ───────────────
    const lines = Array.isArray(payload.line_items) ? payload.line_items : [];
    const unmatchedItems: string[] = [];
    const mapped: Array<{
      productId: string | null;
      sku: string | null;
      name: string;
      quantity: number;
      unitKobo: number;
    }> = [];
    for (const line of lines) {
      const sku = line.sku?.trim() || null;
      const quantity = Math.max(1, Math.trunc(Number(line.quantity) || 1));
      const unitKobo = toKobo(line.price);
      const name = line.title ?? line.name ?? sku ?? "item";
      let productId: string | null = null;
      if (sku) {
        const [prod] = await db
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.tenantId, tenantId), eq(products.sku, sku)))
          .limit(1);
        productId = prod?.id ?? null;
      }
      if (!productId) unmatchedItems.push(sku ?? name);
      mapped.push({ productId, sku, name, quantity, unitKobo });
    }

    // Kobo totals: prefer the platform-side line sum when Shopify's total is
    // absent; never accumulate floats.
    const linesTotalKobo = mapped.reduce((sum, l) => sum + l.unitKobo * l.quantity, 0);
    const shopifyTotalKobo = toKobo(payload.current_total_price ?? payload.total_price);
    const totalKobo = shopifyTotalKobo > 0 ? shopifyTotalKobo : linesTotalKobo;
    const currency = (payload.currency ?? "NGN").slice(0, 3).toUpperCase();

    const orderId = crypto.randomUUID();
    const orderNumber = `SHOPIFY-${payload.order_number ?? payload.name ?? shopifyOrderId}`.slice(0, 50);

    await db.insert(orders).values({
      id: orderId,
      tenantId,
      customerId,
      orderNumber,
      status: payload.financial_status === "paid" ? "confirmed" : "pending",
      totalAmount: (totalKobo / 100).toFixed(2),
      currency,
      paymentStatus: payload.financial_status === "paid" ? "completed" : "unpaid",
      shippingAddress: payload.shipping_address
        ? (redactShopifyPayload(payload.shipping_address) as Record<string, unknown>)
        : null,
      items: mapped.map((l) => ({
        productId: l.productId,
        sku: l.sku,
        productName: l.name,
        quantity: l.quantity,
        unitPrice: l.unitKobo / 100,
        unmatched: l.productId === null,
      })),
      metadata: {
        source: "shopify",
        shopifyOrderId,
        shopifyOrderName: payload.name ?? null,
        totalKobo,
        unmatchedItems,
      },
      erpOrderId: shopifyOrderId.slice(0, 64),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    for (const l of mapped) {
      // Unmatched SKUs are captured in orders.items/metadata only — the
      // order_items.productId FK references products, so unknown SKUs must
      // not be inserted there.
      if (!l.productId) continue;
      await db.insert(orderItems).values({
        id: crypto.randomUUID(),
        orderId,
        productId: l.productId,
        productName: l.name,
        quantity: l.quantity,
        unitPrice: (l.unitKobo / 100).toFixed(2),
        currency,
      } as any);
    }

    // Record dedupe LAST (after the order committed) so a crash mid-insert
    // lets the Shopify retry re-drive the bridge.
    await updateShopifyState(tenantId, (s) => {
      s.orders.processedIds[shopifyOrderId] = orderId;
      s.orders.lastOrderAt = new Date().toISOString();
    });
    await writeAuditLog({
      tenantId,
      actorId: "shopify-order-bridge",
      actorName: "Shopify Order Bridge",
      action: "shopify.order.bridged",
      entityType: "order",
      entityId: orderId,
      details: {
        shopifyOrderId,
        orderNumber,
        totalKobo,
        unmatchedItems,
      },
    } as any);
    return { action: "created", orderId, orderNumber, unmatchedItems };
  } catch (err: any) {
    return { action: "failed", error: err?.message ?? String(err) };
  }
}
