/**
 * server/services/medusa/orderBridge.ts — W28 order bridge.
 *
 * Outbound: a platform order over medusa-sourced items is mirrored to Medusa
 * via the tenant's resolved adapter (MockMedusaAdapter in tests/sim). The
 * medusa_order_links row (unique tenant+order) makes the bridge idempotent —
 * a retried bridge returns the existing link instead of double-creating.
 *
 * Inbound: Medusa fulfillment webhooks (order.fulfillment_created /
 * order.completed / order.canceled) update platform DB state only: the order
 * status and — when an escrow hold exists — the escrow state transitions
 * escrow_held → delivery_confirmed (exactly the state escrow.confirmDelivery
 * would set). The existing buyerConfirm / SLA release path then releases the
 * escrow through the unmodified escrow.ts rails. escrow.ts is NOT edited.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  escrowTransactions,
  medusaOrderLinks,
  orders,
  products,
} from "../../../drizzle/schema";
import type { MedusaAdapter } from "./adapter";

type Db = NonNullable<Awaited<ReturnType<typeof import("../../db").getDb>>>;

export interface BridgeResult {
  bridged: boolean;
  medusaOrderId: string | null;
  reason?: string;
}

/**
 * Mirror a platform order to Medusa. Guards:
 *  - tenant mapping must exist with syncEnabled=true,
 *  - at least one order item must be medusa-sourced (metadata.medusaId),
 *  - idempotent per platform order (existing link short-circuits).
 * Integer cents end to end: platform decimal totals → cents via exact
 * string math; Medusa amounts are integer minor units natively.
 */
export async function bridgeOrderToMedusa(
  db: Db,
  tenantId: string,
  orderId: string,
  adapter: MedusaAdapter,
  mappingSyncEnabled: boolean,
): Promise<BridgeResult> {
  if (!mappingSyncEnabled) return { bridged: false, medusaOrderId: null, reason: "sync-disabled" };

  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
    .limit(1);
  if (!order) return { bridged: false, medusaOrderId: null, reason: "order-not-found" };

  const [existing] = await db
    .select()
    .from(medusaOrderLinks)
    .where(and(eq(medusaOrderLinks.tenantId, tenantId), eq(medusaOrderLinks.orderId, orderId)))
    .limit(1)
    .catch(() => []);
  if (existing) return { bridged: false, medusaOrderId: existing.medusaOrderId, reason: "already-bridged" };

  const items = (Array.isArray(order.items) ? order.items : []) as Array<Record<string, any>>;
  // Medusa provenance is resolved from the products table (chat/storefront
  // order items don't carry catalog metadata): an item is medusa-sourced
  // when its product row has metadata.source = "medusa".
  const productIds = Array.from(new Set(items.map((i) => String(i?.productId ?? "")).filter(Boolean)));
  const productRows = productIds.length
    ? await db
        .select({ id: products.id, metadata: products.metadata })
        .from(products)
        .where(and(eq(products.tenantId, tenantId), inArray(products.id, productIds)))
        .catch(() => [])
    : [];
  const provenance = new Map(
    productRows
      .filter((p) => (p.metadata as any)?.source === "medusa")
      .map((p) => [p.id, (p.metadata as any) as { medusaId?: string; medusaVariantId?: string }]),
  );
  const medusaItems = items.filter((i) => provenance.has(String(i?.productId ?? "")));
  if (medusaItems.length === 0) return { bridged: false, medusaOrderId: null, reason: "no-medusa-items" };

  // Platform items carry decimal major-unit prices; convert exactly to cents.
  const toCents = (v: string | number): number => {
    const s = String(v);
    const neg = s.startsWith("-");
    const [maj, min = ""] = (neg ? s.slice(1) : s).split(".");
    const cents = Number(maj || "0") * 100 + Number((min + "00").slice(0, 2));
    return neg ? -cents : cents;
  };
  const totalCents = toCents(order.totalAmount);

  const medusaOrder = await adapter.createOrder({
    platformOrderId: order.id,
    platformOrderNumber: order.orderNumber,
    currency: order.currency,
    email: `order-${order.orderNumber}@whatsapp.local`,
    phone: "",
    address: null,
    items: medusaItems.map((i) => ({
      variantId: String(provenance.get(String(i.productId))?.medusaVariantId ?? i.productId ?? ""),
      title: String(i.name ?? i.productName ?? "item"),
      quantity: Number(i.qty ?? i.quantity ?? 1),
      unitPriceCents: toCents(i.price ?? i.unitPrice ?? "0"),
    })),
    totalCents,
  });

  await db.insert(medusaOrderLinks).values({
    tenantId,
    orderId,
    medusaOrderId: medusaOrder.id,
    status: "created",
    payload: { currency: medusaOrder.currency_code, totalCents },
  }).onConflictDoNothing();

  // erpOrderId is the established reverse-lookup column the Wave-26 medusa
  // webhook uses — set it so both webhook blocks resolve this order.
  await db
    .update(orders)
    .set({ erpOrderId: medusaOrder.id, updatedAt: new Date() })
    .where(eq(orders.id, orderId));

  return { bridged: true, medusaOrderId: medusaOrder.id };
}

export interface FulfillmentResult {
  action: "updated" | "ignored" | "order-not-found";
  orderId?: string;
  newStatus?: string;
  escrowAdvanced?: boolean;
}

const EVENT_STATUS: Record<string, string> = {
  "order.fulfillment_created": "shipped",
  "order.completed": "delivered",
  "order.canceled": "cancelled",
  "order.payment_captured": "confirmed",
  "order.placed": "pending",
};

/**
 * Apply a Medusa fulfillment/order event to platform DB state. Order status
 * mirrors the Wave-26 mapping; additionally, a delivered event advances any
 * escrow_held hold to delivery_confirmed (DB-state-only — the SAME columns
 * escrow.confirmDelivery sets) so the existing buyerConfirm / SLA release
 * rails complete the release. Never touches escrow.ts code paths directly.
 */
export async function applyMedusaFulfillment(
  db: Db,
  medusaOrderId: string,
  event: string,
): Promise<FulfillmentResult> {
  const newStatus = EVENT_STATUS[event];
  if (!newStatus) return { action: "ignored" };

  const [link] = await db
    .select()
    .from(medusaOrderLinks)
    .where(eq(medusaOrderLinks.medusaOrderId, medusaOrderId))
    .limit(1)
    .catch(() => []);
  let orderId = link?.orderId ?? null;
  if (!orderId) {
    // Fall back to the Wave-26 reverse lookup column.
    const [o] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.erpOrderId, medusaOrderId))
      .limit(1)
      .catch(() => []);
    orderId = o?.id ?? null;
  }
  if (!orderId) return { action: "order-not-found" };

  await db
    .update(orders)
    .set({ status: newStatus as typeof orders.$inferInsert.status, updatedAt: new Date() })
    .where(eq(orders.id, orderId));

  if (link) {
    await db
      .update(medusaOrderLinks)
      .set({ status: event.replace("order.", ""), updatedAt: new Date() })
      .where(eq(medusaOrderLinks.id, link.id))
      .catch(() => {});
  }

  // Advance the escrow checkpoint on delivery so the existing release rails
  // (buyerConfirm / SLA scan) can settle. Guarded to escrow_held so replays
  // and out-of-order events are no-ops.
  let escrowAdvanced = false;
  if (newStatus === "delivered") {
    // === W30 escrow-lifecycle === shared helper resets the buyer-protection
    // deadline on every delivery_confirmed transition (verify-v1 #14).
    const { confirmEscrowDelivery } = await import("../escrowLifecycle");
    const res = await confirmEscrowDelivery(db, { orderId });
    escrowAdvanced = res.transitioned.length > 0;
  }

  return { action: "updated", orderId, newStatus, escrowAdvanced };
}
