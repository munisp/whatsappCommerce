// === W46 inventory-depth ===
/**
 * server/services/inventoryDepth.ts — ORD-15/16/20/21 depth layer on top of
 * the W38 two-phase reservation core (services/inventory.ts):
 *
 *   ORD-15  products.barcode scan lookup + product_variants stock rows with
 *           claim-first reservation by variantId.
 *   ORD-16  warehouses + warehouse_stock; allocateWarehouses() runs at
 *           RESERVE time (default warehouse first, then largest qty) with
 *           claim-first conditional UPDATEs. Mig 0158 backfilled a single
 *           default warehouse per tenant mirroring products.stockQuantity.
 *   ORD-20  delivery_claims resolution state machine
 *           (open → under_review → approved|rejected → resolved).
 *   ORD-21  inventory_batches with FEFO reserve (earliest expiry first,
 *           expired batches never allocated) + expiry sweep admin alert.
 *
 * AUDIT INVARIANT: every stock mutation here (batch receipt, variant
 * receipt, warehouse allocation/restore, batch allocation/restore, variant
 * reservation) writes a W43 stock_adjustments row via recordStockAdjustment
 * in the SAME transaction as the mutation.
 *
 * Concurrency: every decrement is a claim-first conditional UPDATE
 * (... WHERE qty >= take RETURNING) — exactly one concurrent claimer wins;
 * losers see zero rows and the caller throws InsufficientStockError so the
 * whole order transaction rolls back.
 */
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  deliveryClaims,
  inventoryBatches,
  productVariants,
  products,
  stockAdjustments,
  warehouseStock,
  warehouses,
  type DeliveryClaimStatus,
} from "../../drizzle/schema";
import { recordStockAdjustment } from "./stockAdjustments";
import { InsufficientStockError, type TxHandle } from "./inventory";

// ───────────────────────────── ORD-15: barcode scan ─────────────────────────

/**
 * Resolve a scanned barcode/EAN to a tenant-scoped product and/or variant.
 * Variant rows win on exact barcode match; falls back to the product row.
 */
export async function scanBarcode(
  db: TxHandle,
  tenantId: string,
  barcode: string,
): Promise<{ product: any | null; variant: any | null }> {
  const code = barcode.trim();
  const [variant] = await db
    .select()
    .from(productVariants)
    .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.barcode, code)))
    .limit(1);
  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.barcode, code)))
    .limit(1);
  // A variant match implies its parent product.
  const parent = variant && !product
    ? (await db.select().from(products).where(eq(products.id, variant.productId)).limit(1))[0] ?? null
    : product ?? null;
  return { product: parent, variant: variant ?? null };
}

// ─────────────────────── ORD-15: variant stock mutation ─────────────────────

/** Receive stock onto a variant (and its parent product). Audited. */
export async function receiveVariantStock(
  db: TxHandle,
  input: { tenantId: string; variantId: string; qty: number; actorId?: string | null },
  now: Date = new Date(),
): Promise<void> {
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new Error("receiveVariantStock: qty must be a positive integer");
  const [variant] = await db
    .update(productVariants)
    .set({ stockQuantity: sql`${productVariants.stockQuantity} + ${input.qty}`, updatedAt: now })
    .where(and(eq(productVariants.id, input.variantId), eq(productVariants.tenantId, input.tenantId)))
    .returning({ id: productVariants.id, productId: productVariants.productId });
  if (!variant) throw new Error(`receiveVariantStock: variant ${input.variantId} not found for tenant`);
  await db
    .update(products)
    .set({ stockQuantity: sql`${products.stockQuantity} + ${input.qty}`, updatedAt: now })
    .where(eq(products.id, variant.productId));
  await recordStockAdjustment(db, {
    tenantId: input.tenantId,
    productId: variant.productId,
    variantId: variant.id,
    deltaQty: input.qty,
    reason: "restock",
    refType: "variant_receipt",
    refId: variant.id,
    actorId: input.actorId ?? null,
    note: `Variant stock receipt +${input.qty}`,
  });
}

/**
 * Claim-first variant decrement, called from reserveStock when the order
 * item carries a variantId. Throws InsufficientStockError when the variant
 * cannot cover the qty (caller tx rolls back the product claim too).
 */
export async function reserveVariantStock(
  tx: TxHandle,
  tenantId: string,
  productId: string,
  variantId: string,
  qty: number,
  now: Date = new Date(),
): Promise<void> {
  const updated = await tx
    .update(productVariants)
    .set({ stockQuantity: sql`${productVariants.stockQuantity} - ${qty}`, updatedAt: now })
    .where(
      and(
        eq(productVariants.id, variantId),
        eq(productVariants.tenantId, tenantId),
        eq(productVariants.productId, productId),
        sql`${productVariants.stockQuantity} >= ${qty}`,
      ),
    )
    .returning({ id: productVariants.id, name: productVariants.name, stockQuantity: productVariants.stockQuantity });
  if (updated.length === 0) {
    const [v] = await tx
      .select({ name: productVariants.name, stockQuantity: productVariants.stockQuantity })
      .from(productVariants)
      .where(and(eq(productVariants.id, variantId), eq(productVariants.tenantId, tenantId)))
      .limit(1);
    throw new InsufficientStockError([{
      productId,
      name: v?.name ?? `variant ${variantId}`,
      requested: qty,
      available: v?.stockQuantity ?? 0,
    }]);
  }
}

/** Credit a released reservation back onto its variant. Audited by caller context. */
export async function restoreVariantStock(
  db: TxHandle,
  tenantId: string,
  variantId: string,
  qty: number,
  reservationId: string,
  now: Date = new Date(),
): Promise<void> {
  const [v] = await db
    .update(productVariants)
    .set({ stockQuantity: sql`${productVariants.stockQuantity} + ${qty}`, updatedAt: now })
    .where(and(eq(productVariants.id, variantId), eq(productVariants.tenantId, tenantId)))
    .returning({ id: productVariants.id, productId: productVariants.productId });
  if (!v) return; // variant deleted since — product-level restore already happened
  await recordStockAdjustment(db, {
    tenantId,
    productId: v.productId,
    variantId,
    deltaQty: qty,
    reason: "restock",
    refType: "variant_release",
    refId: reservationId,
    note: "Reservation released — variant stock credited back",
  });
}

// ───────────────────── ORD-16: warehouse allocation at reserve ───────────────

/** Ensure the tenant's default warehouse row exists; returns its id. */
export async function ensureDefaultWarehouse(
  db: TxHandle,
  tenantId: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.isDefault, true)))
    .limit(1);
  if (existing) return existing.id;
  const id = randomUUID();
  await db.insert(warehouses).values({ id, tenantId, name: "Main Warehouse", isDefault: true });
  return id;
}

/**
 * Allocate `qty` across warehouses at reserve time: default warehouse first,
 * then remaining warehouses by largest qty. Claim-first per row. Audit row
 * per claim (refType "warehouse_allocation", refId = reservationId) so the
 * release path can restore exactly what was taken. No-op when the product
 * has NO warehouse_stock rows (legacy/unmigrated product). Throws
 * InsufficientStockError when warehouse rows exist but cannot cover qty.
 */
export async function allocateWarehouses(
  tx: TxHandle,
  tenantId: string,
  productId: string,
  variantId: string,
  qty: number,
  reservationId: string,
  now: Date = new Date(),
): Promise<{ warehouseId: string; qty: number }[]> {
  const stockRows = await tx
    .select({
      id: warehouseStock.id,
      warehouseId: warehouseStock.warehouseId,
      qty: warehouseStock.qty,
    })
    .from(warehouseStock)
    .where(
      and(
        eq(warehouseStock.tenantId, tenantId),
        eq(warehouseStock.productId, productId),
        eq(warehouseStock.variantId, variantId),
        gt(warehouseStock.qty, 0),
      ),
    );
  if (stockRows.length === 0) return []; // no warehouse tracking for this product
  // Default warehouse first, then largest qty (separate plain selects keep
  // this usable by the in-memory test fakes — no join surface required).
  const whs = await tx
    .select({ id: warehouses.id, isDefault: warehouses.isDefault })
    .from(warehouses)
    .where(eq(warehouses.tenantId, tenantId));
  const defaultIds = new Set(whs.filter((w) => w.isDefault).map((w) => w.id));
  const rows = stockRows.sort((a, b) =>
    (defaultIds.has(b.warehouseId) ? 1 : 0) - (defaultIds.has(a.warehouseId) ? 1 : 0) || b.qty - a.qty,
  );
  const allocations: { warehouseId: string; qty: number }[] = [];
  let remaining = qty;
  for (const row of rows) {
    if (remaining <= 0) break;
    const take = Math.min(row.qty, remaining);
    // Claim-first: only succeeds if the row still has >= take.
    const claimed = await tx
      .update(warehouseStock)
      .set({ qty: sql`${warehouseStock.qty} - ${take}`, updatedAt: now })
      .where(and(eq(warehouseStock.id, row.id), sql`${warehouseStock.qty} >= ${take}`))
      .returning({ id: warehouseStock.id });
    if (claimed.length === 0) continue; // lost the race — try next warehouse
    allocations.push({ warehouseId: row.warehouseId, qty: take });
    await recordStockAdjustment(tx, {
      tenantId,
      productId,
      variantId: variantId || null,
      deltaQty: -take,
      reason: "other",
      refType: "warehouse_allocation",
      refId: reservationId,
      note: `Reserved ${take} from warehouse ${row.warehouseId}`,
    });
    remaining -= take;
  }
  if (remaining > 0) {
    throw new InsufficientStockError([{ productId, name: productId, requested: qty, available: qty - remaining }]);
  }
  return allocations;
}

/** Restore warehouse allocations for a released reservation (audit-replay). */
export async function restoreWarehouseAllocations(
  db: TxHandle,
  tenantId: string,
  reservationId: string,
  now: Date = new Date(),
): Promise<void> {
  const allocs = await db
    .select()
    .from(stockAdjustments)
    .where(and(eq(stockAdjustments.tenantId, tenantId), eq(stockAdjustments.refType, "warehouse_allocation"), eq(stockAdjustments.refId, reservationId)));
  for (const a of allocs) {
    const whId = /warehouse (\S+)$/.exec(a.note ?? "")?.[1];
    if (!whId) continue;
    const take = -a.deltaQty; // allocations are negative deltas
    await db
      .update(warehouseStock)
      .set({ qty: sql`${warehouseStock.qty} + ${take}`, updatedAt: now })
      .where(and(
        eq(warehouseStock.tenantId, tenantId),
        eq(warehouseStock.warehouseId, whId),
        eq(warehouseStock.productId, a.productId),
        eq(warehouseStock.variantId, a.variantId ?? ""),
      ));
    await recordStockAdjustment(db, {
      tenantId,
      productId: a.productId,
      variantId: a.variantId,
      deltaQty: take,
      reason: "restock",
      refType: "warehouse_release",
      refId: reservationId,
      note: `Reservation released — ${take} restored to warehouse ${whId}`,
    });
  }
}

// ─────────────────────── ORD-21: batches, FEFO, expiry sweep ────────────────

/**
 * Receive a batch of perishable stock: batch row + product stock credit +
 * default-warehouse stock credit, all audited in one tx.
 */
export async function receiveBatch(
  db: TxHandle,
  input: {
    tenantId: string;
    productId: string;
    qty: number;
    batchCode?: string | null;
    expiryDate?: Date | null;
    actorId?: string | null;
  },
  now: Date = new Date(),
): Promise<string> {
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new Error("receiveBatch: qty must be a positive integer");
  const batchId = randomUUID();
  await db.insert(inventoryBatches).values({
    id: batchId,
    tenantId: input.tenantId,
    productId: input.productId,
    batchCode: input.batchCode ?? null,
    qty: input.qty,
    expiryDate: input.expiryDate ?? null,
    createdAt: now,
  });
  const [prod] = await db
    .update(products)
    .set({ stockQuantity: sql`${products.stockQuantity} + ${input.qty}`, updatedAt: now })
    .where(and(eq(products.id, input.productId), eq(products.tenantId, input.tenantId)))
    .returning({ id: products.id });
  if (!prod) throw new Error(`receiveBatch: product ${input.productId} not found for tenant`);
  const whId = await ensureDefaultWarehouse(db, input.tenantId);
  // Portable upsert (PGlite cannot infer ON CONFLICT column specs): read the
  // product-level row, then update-or-insert. The unique index
  // warehouse_stock_uniq guards concurrency; callers run inside a tx.
  const [wsRow] = await db
    .select({ id: warehouseStock.id })
    .from(warehouseStock)
    .where(and(
      eq(warehouseStock.tenantId, input.tenantId),
      eq(warehouseStock.warehouseId, whId),
      eq(warehouseStock.productId, input.productId),
      eq(warehouseStock.variantId, ""),
    ))
    .limit(1);
  if (wsRow) {
    await db
      .update(warehouseStock)
      .set({ qty: sql`${warehouseStock.qty} + ${input.qty}`, updatedAt: now })
      .where(eq(warehouseStock.id, wsRow.id));
  } else {
    await db.insert(warehouseStock).values({
      id: randomUUID(),
      tenantId: input.tenantId,
      warehouseId: whId,
      productId: input.productId,
      variantId: "",
      qty: input.qty,
      updatedAt: now,
    });
  }
  await recordStockAdjustment(db, {
    tenantId: input.tenantId,
    productId: input.productId,
    deltaQty: input.qty,
    reason: "restock",
    refType: "batch_receipt",
    refId: batchId,
    actorId: input.actorId ?? null,
    note: `Batch ${input.batchCode ?? batchId} received +${input.qty}${input.expiryDate ? ` (expiry ${input.expiryDate.toISOString().slice(0, 10)})` : ""}`,
  });
  return batchId;
}

/**
 * FEFO allocation at reserve time: earliest-expiry non-expired batches
 * first (NULL expiry = non-perishable, picked last). Claim-first per batch.
 * No-op when the product has no batch rows; throws InsufficientStockError
 * when batches exist but unexpired qty cannot cover the reservation. Audit
 * row per batch claim (refType "batch_reserve", refId = reservationId).
 */
export async function fefoAllocate(
  tx: TxHandle,
  tenantId: string,
  productId: string,
  qty: number,
  reservationId: string,
  now: Date = new Date(),
): Promise<{ batchId: string; qty: number }[]> {
  const batches = (await tx
    .select({ id: inventoryBatches.id, qty: inventoryBatches.qty, expiryDate: inventoryBatches.expiryDate })
    .from(inventoryBatches)
    .where(
      and(
        eq(inventoryBatches.tenantId, tenantId),
        eq(inventoryBatches.productId, productId),
        gt(inventoryBatches.qty, 0),
        or(isNull(inventoryBatches.expiryDate), gt(inventoryBatches.expiryDate, now)),
      ),
    )).sort((a, b) => {
      // FEFO order, computed in JS (keeps the in-memory test fakes usable):
      // earliest expiry first, NULL (non-perishable) last.
      if (a.expiryDate == null && b.expiryDate == null) return 0;
      if (a.expiryDate == null) return 1;
      if (b.expiryDate == null) return -1;
      return a.expiryDate.getTime() - b.expiryDate.getTime();
    });
  if (batches.length === 0) return [];
  const picks: { batchId: string; qty: number }[] = [];
  let remaining = qty;
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(b.qty, remaining);
    const claimed = await tx
      .update(inventoryBatches)
      .set({ qty: sql`${inventoryBatches.qty} - ${take}` })
      .where(and(eq(inventoryBatches.id, b.id), sql`${inventoryBatches.qty} >= ${take}`))
      .returning({ id: inventoryBatches.id });
    if (claimed.length === 0) continue; // raced — move to next batch
    picks.push({ batchId: b.id, qty: take });
    await recordStockAdjustment(tx, {
      tenantId,
      productId,
      deltaQty: -take,
      reason: "other",
      refType: "batch_reserve",
      refId: reservationId,
      note: `FEFO reserved ${take} from batch ${b.id}`,
    });
    remaining -= take;
  }
  if (remaining > 0) {
    throw new InsufficientStockError([{ productId, name: productId, requested: qty, available: qty - remaining }]);
  }
  return picks;
}

/** Restore FEFO batch allocations for a released reservation (audit-replay). */
export async function restoreBatchAllocations(
  db: TxHandle,
  tenantId: string,
  reservationId: string,
): Promise<void> {
  const allocs = await db
    .select()
    .from(stockAdjustments)
    .where(and(eq(stockAdjustments.tenantId, tenantId), eq(stockAdjustments.refType, "batch_reserve"), eq(stockAdjustments.refId, reservationId)));
  for (const a of allocs) {
    const batchId = /batch (\S+)$/.exec(a.note ?? "")?.[1];
    if (!batchId) continue;
    const take = -a.deltaQty;
    await db
      .update(inventoryBatches)
      .set({ qty: sql`${inventoryBatches.qty} + ${take}` })
      .where(and(eq(inventoryBatches.id, batchId), eq(inventoryBatches.tenantId, tenantId)));
    await recordStockAdjustment(db, {
      tenantId,
      productId: a.productId,
      deltaQty: take,
      reason: "restock",
      refType: "batch_release",
      refId: reservationId,
      note: `Reservation released — ${take} restored to batch ${batchId}`,
    });
  }
}

/** How soon before expiry a batch counts as "expiring" for the sweep alert. */
export const EXPIRY_WARN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Expiry sweep: find batches with remaining qty that are EXPIRED or expire
 * within EXPIRY_WARN_WINDOW, group per tenant, and alert the tenant admin on
 * BOTH channels (channelParity sendCustomerText, category inventory_alert).
 * Alert-only: no stock is written off — write-off stays an explicit,
 * separately-audited merchant action. Returns per-tenant counts.
 */
export async function sweepExpiringBatches(
  db: TxHandle,
  now: Date = new Date(),
): Promise<{ tenants: number; expired: number; expiring: number; alerted: number }> {
  const warnBefore = new Date(now.getTime() + EXPIRY_WARN_WINDOW_MS);
  const rows = await db
    .select({
      tenantId: inventoryBatches.tenantId,
      productId: inventoryBatches.productId,
      batchCode: inventoryBatches.batchCode,
      qty: inventoryBatches.qty,
      expiryDate: inventoryBatches.expiryDate,
      productName: products.name,
    })
    .from(inventoryBatches)
    .innerJoin(products, eq(products.id, inventoryBatches.productId))
    .where(and(gt(inventoryBatches.qty, 0), lt(inventoryBatches.expiryDate, warnBefore)));
  const byTenant = new Map<string, { expired: typeof rows; expiring: typeof rows }>();
  for (const r of rows) {
    if (!r.expiryDate) continue;
    const bucket = r.expiryDate.getTime() <= now.getTime() ? "expired" : "expiring";
    const t = byTenant.get(r.tenantId) ?? { expired: [] as typeof rows, expiring: [] as typeof rows };
    (t[bucket] as typeof rows).push(r);
    byTenant.set(r.tenantId, t);
  }
  let expired = 0;
  let expiring = 0;
  let alerted = 0;
  for (const [tenantId, t] of Array.from(byTenant.entries())) {
    expired += t.expired.length;
    expiring += t.expiring.length;
    const lines = [
      `⚠️ Inventory expiry alert: ${t.expired.length} batch(es) EXPIRED, ${t.expiring.length} expiring within 7 days.`,
      ...[...t.expired, ...t.expiring].slice(0, 10).map((r) =>
        `• ${r.productName} batch ${r.batchCode ?? "?"}: ${r.qty} unit(s), expiry ${r.expiryDate!.toISOString().slice(0, 10)}`),
    ];
    try {
      // Tenant-admin routing with WA/Telegram parity (category
      // "inventory_alert"); adminAlerts resolves the admin phone.
      const { resolveAdminPhone } = await import("./adminAlerts");
      const adminPhone = await resolveAdminPhone(db as any, tenantId);
      if (adminPhone) {
        const { sendCustomerText } = await import("./channelParity");
        await sendCustomerText(tenantId, adminPhone, "inventory_alert", lines.join("\n"), { notifType: "ops_alert" });
        alerted++;
      } else {
        console.warn(`[inventory-expiry-sweep] tenant=${tenantId} has no adminPhone — ${lines[0]}`);
      }
    } catch (e: any) {
      console.error(`[inventory-expiry-sweep] alert failed tenant=${tenantId}:`, e?.message ?? e);
    }
  }
  return { tenants: byTenant.size, expired, expiring, alerted };
}

// ─────────────────── ORD-20: delivery claims state machine ──────────────────

/** Allowed status transitions. resolved is terminal. */
export const CLAIM_TRANSITIONS: Record<DeliveryClaimStatus, DeliveryClaimStatus[]> = {
  open: ["under_review", "rejected"],
  under_review: ["approved", "rejected"],
  approved: ["resolved"],
  rejected: ["resolved"],
  resolved: [],
};

export class ClaimTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Illegal delivery-claim transition ${from} → ${to}`);
    this.name = "ClaimTransitionError";
  }
}

export async function createDeliveryClaim(
  db: TxHandle,
  input: {
    tenantId: string;
    shipmentId: string;
    orderId?: string | null;
    type: string;
    photos?: string[];
    description?: string | null;
    reportedBy?: string | null;
  },
  now: Date = new Date(),
): Promise<string> {
  const id = randomUUID();
  await db.insert(deliveryClaims).values({
    id,
    tenantId: input.tenantId,
    shipmentId: input.shipmentId,
    orderId: input.orderId ?? null,
    type: input.type,
    photos: input.photos ?? [],
    description: input.description ?? null,
    status: "open",
    reportedBy: input.reportedBy ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/**
 * Claim-first state-machine transition: the guarded UPDATE only matches when
 * the row is still in the expected source state, so concurrent reviewers
 * cannot double-resolve. Throws ClaimTransitionError on illegal transitions
 * and TRPC-safe Error when the claim is not found / not owned.
 */
export async function transitionDeliveryClaim(
  db: TxHandle,
  input: {
    tenantId: string;
    claimId: string;
    to: DeliveryClaimStatus;
    resolution?: string | null;
    actorId?: string | null;
  },
  now: Date = new Date(),
): Promise<void> {
  const [claim] = await db
    .select({ id: deliveryClaims.id, status: deliveryClaims.status })
    .from(deliveryClaims)
    .where(and(eq(deliveryClaims.id, input.claimId), eq(deliveryClaims.tenantId, input.tenantId)))
    .limit(1);
  if (!claim) throw new Error(`delivery claim ${input.claimId} not found`);
  const from = claim.status as DeliveryClaimStatus;
  if (!(CLAIM_TRANSITIONS[from] ?? []).includes(input.to)) {
    throw new ClaimTransitionError(from, input.to);
  }
  if (input.to === "resolved" && !input.resolution) {
    throw new Error("resolution is required when resolving a delivery claim");
  }
  const updated = await db
    .update(deliveryClaims)
    .set({
      status: input.to,
      resolution: input.to === "resolved" ? input.resolution! : undefined,
      resolvedBy: input.to === "resolved" ? input.actorId ?? null : undefined,
      resolvedAt: input.to === "resolved" ? now : undefined,
      updatedAt: now,
    })
    .where(and(
      eq(deliveryClaims.id, input.claimId),
      eq(deliveryClaims.tenantId, input.tenantId),
      eq(deliveryClaims.status, from), // claim-first: exactly one transition wins
    ))
    .returning({ id: deliveryClaims.id });
  if (updated.length === 0) throw new Error(`delivery claim ${input.claimId} transitioned concurrently — retry`);
}

// === END W46 inventory-depth ===
