/**
 * reorder.ts — Smart reorder ("repeat my last order" / "same as last time").
 *
 * Loads the caller's most recent PAID order (orders.paymentStatus =
 * "completed"; orders.customerId may hold the raw WhatsApp phone or a
 * customers.id — both are resolved, mirroring logistics.resolveBuyerPhone),
 * then rebuilds the cart through the same catalog matching used by the NLP
 * add-to-cart path (nlpCart.addExtractedItemsToCart). Items are ALWAYS
 * repriced from the live catalog — price changes since the last order are
 * called out in the reply. Items that no longer match the catalog or are out
 * of stock are listed as unavailable. The buyer then confirms via the
 * standard checkout flow.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { customers, orders } from "../../drizzle/schema";
import { addExtractedItemsToCart, type AddedCartItem, type CatalogProduct } from "./nlpCart";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

interface OrderItemLine {
  productId?: string;
  name?: string;
  qty?: number;
  price?: string;
}

export interface ReorderAddedItem extends AddedCartItem {
  /** Unit price on the previous order (null when unknown). */
  previousUnitPrice: string | null;
  priceChanged: boolean;
}

export interface ReorderResult {
  status: "ready" | "no_prior_order" | "nothing_available";
  orderNumber?: string;
  cartSessionId?: string;
  added: ReorderAddedItem[];
  unavailable: string[];
}

/** Candidate orders.customerId values for a WhatsApp phone. */
async function customerIdCandidates(db: Db, tenantId: string, phone: string): Promise<string[]> {
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, phone)))
    .limit(1)
    .catch(() => [] as any[]);
  return customer ? [customer.id, phone] : [phone];
}

/** The caller's most recent paid order, or null. */
export async function findLastPaidOrder(
  db: Db,
  tenantId: string,
  phone: string,
): Promise<{ id: string; orderNumber: string; items: OrderItemLine[] } | null> {
  const candidates = await customerIdCandidates(db, tenantId, phone);
  const [order] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      items: orders.items,
    })
    .from(orders)
    .where(and(
      eq(orders.tenantId, tenantId),
      inArray(orders.customerId, candidates),
      eq(orders.paymentStatus, "completed"),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(1)
    .catch(() => [] as any[]);
  if (!order) return null;
  const items = Array.isArray(order.items) ? (order.items as OrderItemLine[]) : [];
  return { id: order.id, orderNumber: order.orderNumber, items };
}

/**
 * Rebuild the buyer's cart from their last paid order at CURRENT catalog
 * prices. Returns what was re-added (with price-change flags) and which
 * lines could not be fulfilled.
 */
export async function buildReorder(
  db: Db,
  opts: {
    tenantId: string;
    waPhoneNumber: string;
    session: { id: string; language: string };
    cartSession: any | null;
    products: CatalogProduct[];
  },
): Promise<ReorderResult> {
  const lastOrder = await findLastPaidOrder(db, opts.tenantId, opts.waPhoneNumber);
  if (!lastOrder || lastOrder.items.length === 0) {
    return { status: "no_prior_order", added: [], unavailable: [] };
  }

  // Previous unit prices keyed by lowercased item name for price-change notes.
  const prevPriceByName = new Map<string, string>();
  const itemsToAdd = lastOrder.items
    .map((line) => {
      const name = (line.name ?? "").toString().trim();
      if (!name) return null;
      const qty = Math.max(1, Math.min(999, Math.floor(Number(line.qty ?? 1)) || 1));
      if (line.price != null) prevPriceByName.set(name.toLowerCase(), String(line.price));
      return { product: name, quantity: qty };
    })
    .filter((x): x is { product: string; quantity: number } => !!x);

  const result = await addExtractedItemsToCart(db, {
    tenantId: opts.tenantId,
    waPhoneNumber: opts.waPhoneNumber,
    session: opts.session,
    cartSession: opts.cartSession,
    products: opts.products,
    items: itemsToAdd,
  });

  const added: ReorderAddedItem[] = result.added.map((a) => {
    const prev = prevPriceByName.get(a.productName.toLowerCase()) ?? null;
    const priceChanged = prev != null && Number(prev) !== Number(a.unitPrice);
    return { ...a, previousUnitPrice: prev, priceChanged };
  });

  return {
    status: added.length > 0 ? "ready" : "nothing_available",
    orderNumber: lastOrder.orderNumber,
    cartSessionId: result.cartSession?.id,
    added,
    unavailable: result.clarifications,
  };
}

/** Buyer-facing reorder reply: what was re-added, reprice notes, next step. */
export function buildReorderReply(result: ReorderResult, currency?: string): string {
  if (result.status === "no_prior_order") {
    return "I couldn't find a previous paid order for this number — tell me what you'd like and I'll add it to your cart. 🛒";
  }
  const lines: string[] = [];
  if (result.added.length > 0) {
    lines.push(`🔁 *Reordering from ${result.orderNumber ?? "your last order"}*`, "");
    for (const a of result.added) {
      const priceNote = a.priceChanged && a.previousUnitPrice != null
        ? ` (was ${a.previousUnitPrice}, now ${a.unitPrice})`
        : "";
      lines.push(`✅ ${a.quantity} × ${a.productName} — ${a.unitPrice} ${a.currency}${priceNote}`);
    }
    const changed = result.added.filter((a) => a.priceChanged);
    if (changed.length > 0) {
      lines.push("", "ℹ️ Prices above are today's catalog prices.");
    }
    lines.push("", "Reply *checkout* to complete your order, or keep shopping.");
  }
  if (result.unavailable.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...result.unavailable);
  }
  if (result.status === "nothing_available") {
    lines.push("", "None of the items from your last order are available right now — browse the catalog and I'll add something new.");
  }
  return lines.join("\n");
}
