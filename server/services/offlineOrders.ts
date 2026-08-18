/**
 * offlineOrders.ts — W17/F10: merchant-captured offline sales (no WhatsApp
 * thread). Dashboard-driven: walk-in / phone-call sales recorded from the COD
 * board. Reuses the SAME inventory path as chat orders (reserveStock inside
 * the order transaction) — never a forked decrement.
 *
 * paymentMethod:
 *   cod      → order enters the COD flow (codState = cod_pending); an optional
 *              deposit is recorded as a COD cash row.
 *   cash     → offline cash sale; amountPaid recorded as an offline-cash row.
 *   transfer → offline bank transfer; amountPaid recorded as offline-transfer.
 * Fully paid orders get paymentStatus 'completed'; partial payments leave the
 * balance tracked via orderPaymentSummary (partial-payment tracking).
 */
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  codEvents,
  customers,
  orderItems,
  orders,
  paymentTransactions,
  products,
} from "../../drizzle/schema";
import { reserveStock, InsufficientStockError } from "./inventory";
import type { DbHandle } from "./codFlow";

export type OfflinePaymentMethod = "cod" | "cash" | "transfer";

export interface OfflineOrderItemInput {
  productId: string;
  qty: number;
  /** Optional price override (major units); defaults to the product price. */
  unitPrice?: number;
}

export interface CreateOfflineOrderResult {
  created: boolean;
  /** W23: true when an idempotency replay returned the existing order. */
  duplicate?: boolean;
  orderId?: string;
  orderNumber?: string;
  customerId?: string;
  total?: number;
  currency?: string;
  paymentStatus?: string;
  codState?: string | null;
  shortages?: Array<{ productId: string; name: string; requested: number; available: number }>;
}

export async function createOfflineOrder(
  db: DbHandle,
  opts: {
    tenantId: string;
    customerName: string;
    customerPhone: string;
    items: OfflineOrderItemInput[];
    paymentMethod: OfflinePaymentMethod;
    /** Amount already collected (major units). Defaults: full total for
     * cash/transfer, 0 for cod. */
    amountPaid?: number;
    currency?: string;
    note?: string | null;
    actor?: string;
    /**
     * W23 (additive): device-local queue id for offline sync. When provided,
     * re-syncing the SAME queued order (retry after a reconnect timeout)
     * returns the already-created order instead of minting a duplicate and
     * double-reserving stock. Stored in orders.metadata.clientRef.
     */
    clientRef?: string | null;
  },
): Promise<CreateOfflineOrderResult> {
  if (!opts.items.length) throw new Error("Offline order needs at least one item");
  const now = new Date();

  // ── Idempotent reconnect sync (W23): replay of a queued clientRef ──────
  const clientRef = opts.clientRef?.trim() || null;
  if (clientRef) {
    const existing = await db
      .select()
      .from(orders)
      .where(and(
        eq(orders.tenantId, opts.tenantId),
        sql`metadata->>'source' = 'offline'`,
        sql`metadata->>'clientRef' = ${clientRef}`,
      ))
      .limit(1)
      .catch(() => [] as any[]);
    const row = (Array.isArray(existing) ? existing : [])[0];
    if (row) {
      return {
        created: true,
        duplicate: true,
        orderId: String(row.id),
        orderNumber: String(row.orderNumber ?? ""),
        customerId: String(row.customerId ?? ""),
        total: Number(row.totalAmount ?? 0),
        currency: String(row.currency ?? "NGN"),
        paymentStatus: String(row.paymentStatus ?? ""),
        codState: (row.codState ?? null) as string | null,
      };
    }
  }

  // ── Resolve/create the customer (unique per tenant+phone) ─────────────
  const phone = opts.customerPhone.trim();
  let [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, opts.tenantId), eq(customers.whatsappPhone, phone)))
    .limit(1);
  if (!customer) {
    const id = randomUUID();
    await db.insert(customers).values({
      id,
      tenantId: opts.tenantId,
      whatsappPhone: phone,
      name: opts.customerName.trim() || null,
      createdAt: now,
      updatedAt: now,
    });
    customer = { id, tenantId: opts.tenantId, whatsappPhone: phone, name: opts.customerName } as any;
  }

  // ── Price the items from the catalog (override allowed) ───────────────
  const lines: Array<{ productId: string; name: string; qty: number; unitPrice: number }> = [];
  for (const item of opts.items) {
    const [p] = await db
      .select()
      .from(products)
      .where(and(eq(products.id, item.productId), eq(products.tenantId, opts.tenantId)))
      .limit(1);
    if (!p) throw new Error(`Product ${item.productId} not found for tenant`);
    lines.push({
      productId: p.id,
      name: p.name,
      qty: item.qty,
      unitPrice: item.unitPrice ?? Number(p.price),
    });
  }
  const currency = opts.currency ?? "NGN";
  const total = Math.round(lines.reduce((s, l) => s + l.unitPrice * l.qty, 0) * 100) / 100;
  const amountPaid = Math.max(
    0,
    Math.round((opts.amountPaid ?? (opts.paymentMethod === "cod" ? 0 : total)) * 100) / 100,
  );

  const orderId = randomUUID();
  const orderNumber = `OFF-${Date.now().toString(36).toUpperCase()}`;
  const isCod = opts.paymentMethod === "cod";

  // ── Order + items + atomic stock reservation in ONE transaction ───────
  // Same reserveStock path as chat orders: a concurrent checkout claiming the
  // last unit rolls the whole offline order back.
  const apply = async (tx: any) => {
    await tx.insert(orders).values({
      id: orderId,
      tenantId: opts.tenantId,
      customerId: customer.id,
      orderNumber,
      status: "pending",
      totalAmount: total.toFixed(2),
      currency,
      paymentStatus: amountPaid >= total && total > 0 ? "completed" : amountPaid > 0 ? "initiated" : "unpaid",
      codState: isCod ? "cod_pending" : null,
      items: lines.map((l) => ({ productId: l.productId, name: l.name, qty: l.qty, price: l.unitPrice })),
      metadata: { source: "offline", paymentMethod: opts.paymentMethod, ...(clientRef ? { clientRef } : {}) },
      notes: opts.note ?? null,
      createdAt: now,
      updatedAt: now,
    });
    for (const l of lines) {
      await tx.insert(orderItems).values({
        id: randomUUID(),
        orderId,
        productId: l.productId,
        productName: l.name,
        quantity: l.qty,
        unitPrice: l.unitPrice.toFixed(2),
        currency,
      });
    }
    await reserveStock(tx, opts.tenantId, orderId, lines.map((l) => ({ productId: l.productId, qty: l.qty })), now);
  };
  try {
    if (db.transaction) await db.transaction(apply);
    else await apply(db);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      return { created: false, shortages: err.shortages };
    }
    throw err;
  }

  // ── Payment record (claim-style unique ref; replay-safe) ──────────────
  if (amountPaid > 0) {
    const provider = isCod ? "cod" : `offline-${opts.paymentMethod}`;
    await db
      .insert(paymentTransactions)
      .values({
        id: randomUUID(),
        tenantId: opts.tenantId,
        orderId,
        customerId: customer.id,
        provider,
        providerRef: `offline:${orderId}:${opts.paymentMethod}:${amountPaid.toFixed(2)}`,
        amount: amountPaid.toFixed(2),
        currency,
        status: "completed",
        paidAt: now,
        metadata: { kind: "offline_capture", actor: opts.actor ?? null },
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }

  if (isCod) {
    await db.insert(codEvents).values({
      id: randomUUID(),
      tenantId: opts.tenantId,
      orderId,
      fromState: null,
      toState: "cod_pending",
      actor: opts.actor ?? "merchant",
      note: opts.note ?? "Offline COD order captured",
    });
  }

  return {
    created: true,
    orderId,
    orderNumber,
    customerId: customer.id,
    total,
    currency,
    paymentStatus: amountPaid >= total && total > 0 ? "completed" : amountPaid > 0 ? "initiated" : "unpaid",
    codState: isCod ? "cod_pending" : null,
  };
}
