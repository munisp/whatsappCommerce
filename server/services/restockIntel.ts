// === W66 learning ===
/**
 * restockIntel.ts — R6 restock & procurement intelligence.
 *
 * MERCHANT SIDE
 *  - computeRestockSignals: per-product depletion rate from order_items
 *    cadence over RESTOCK_WINDOW_DAYS (paid orders only), days-of-cover =
 *    stock / daily rate, suggested reorder qty to reach TARGET_COVER_DAYS.
 *  - runRestockSweep (POST /api/scheduled/restock-sweep): for products with
 *    daysOfCover < COVER_THRESHOLD_DAYS, auto-draft a restock PO (status
 *    'draft' — NEVER submitted; the merchant confirms via ProcurementHub or
 *    the WA/TG nudge's one-tap link). Supplier resolution: the supplier the
 *    merchant last ordered that product from (po_items.product_ref), else
 *    the draft is skipped and only the nudge fires.
 *  - confirmRestockDraft: claim-first draft→submitted guarded transition —
 *    a double-confirm is a CONFLICT, never a double PO. Supplier admin is
 *    notified (poFlow-style approve/reject card via notifications).
 *
 * BUYER SIDE
 *  - runBuyerReorderNudges: buyers whose repeat-purchase cadence for a
 *    product has elapsed (last paid order older than their historical
 *    inter-purchase interval) get a "running low on X?" WA/TG nudge with a
 *    REORDER hint (the chat reorder intent rebuilds the cart — reorder.ts).
 *
 * Discipline: claim-first idempotency via proactive_nudges (per type+subject
 * +day/week bucket), integer cents, fail-open sends, quiet hours honoured.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { getDb } from "../db";
import { poItems, products, purchaseOrders, tenants } from "../../drizzle/schema";
import { interpolate, getStickyLocale, t27 } from "./i18n";
import { isQuietHours, parseMarketingFrequencyPolicy } from "./frequencyCap";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const RESTOCK_WINDOW_DAYS = 30;
export const COVER_THRESHOLD_DAYS = 7;
export const TARGET_COVER_DAYS = 21;
export const REORDER_MIN_HISTORY = 2;

function appBase(): string {
  return (process.env.PUBLIC_APP_URL ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Claim-first idempotency (same pattern as services/proactive.ts). */
async function claim(db: Db, tenantId: string, type: string, subject: string, day: string): Promise<boolean> {
  const res = await db.execute(sql`
    INSERT INTO proactive_nudges (tenant_id, nudge_type, subject_id, day, status)
    VALUES (${tenantId}, ${type}, ${subject}, ${day}, 'claimed')
    ON CONFLICT (tenant_id, nudge_type, subject_id, day) DO NOTHING
    RETURNING id
  `).catch((e: any) => {
    console.warn("[restock] claim failed (fail-open, skip):", e?.message);
    return null;
  });
  const rows = (res as any)?.rows ?? res ?? [];
  return Array.isArray(rows) ? rows.length === 1 : Number((res as any)?.rowCount ?? 0) === 1;
}

async function sendParity(tenantId: string, to: string, notifType: string, text: string): Promise<void> {
  const { notifyCustomer } = await import("./channelParity");
  const tg = await notifyCustomer(tenantId, to, "ops_alert", { text, notifType }).catch(() => ({ handled: false }) as any);
  if ((tg as any)?.handled) return;
  const { sendWhatsAppText } = await import("./waSender");
  await sendWhatsAppText(tenantId, to, text, { notifType }).catch((e: any) =>
    console.warn("[restock] WA send failed (fail-open):", e?.message));
}

export interface RestockSignal {
  productId: string;
  productName: string;
  stockQuantity: number;
  soldQtyWindow: number;
  dailyRate: number;
  daysOfCover: number | null; // null when never sold in window
  suggestedQty: number;
}

/** Per-product depletion signal for one tenant. */
export async function computeRestockSignals(db: Db, tenantId: string): Promise<RestockSignal[]> {
  const rows = await db.execute(sql`
    SELECT p.id AS product_id, p.name AS product_name,
           p."stockQuantity" AS stock_quantity,
           COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN oi.quantity ELSE 0 END), 0)::int AS sold_qty
    FROM products p
    LEFT JOIN order_items oi ON oi."productId" = p.id
    LEFT JOIN orders o ON o.id = oi."orderId"
      AND o."tenantId" = p."tenantId"
      AND o."paymentStatus" = 'completed'
      AND o."createdAt" > now() - (${RESTOCK_WINDOW_DAYS} * interval '1 day')
    WHERE p."tenantId" = ${tenantId} AND p.status = 'active'
    GROUP BY p.id, p.name, p."stockQuantity"
  `).then((r: any) => (r.rows ?? r)).catch(() => [] as any[]);
  return (rows as any[]).map((r) => {
    const sold = Number(r.sold_qty ?? 0);
    const stock = Number(r.stock_quantity ?? 0);
    const dailyRate = sold / RESTOCK_WINDOW_DAYS;
    const daysOfCover = sold > 0 ? Math.floor(stock / dailyRate) : null;
    const suggestedQty = sold > 0
      ? Math.max(0, Math.ceil(dailyRate * TARGET_COVER_DAYS) - stock)
      : 0;
    return {
      productId: r.product_id,
      productName: r.product_name,
      stockQuantity: stock,
      soldQtyWindow: sold,
      dailyRate: Number(dailyRate.toFixed(4)),
      daysOfCover,
      suggestedQty,
    };
  });
}

/** Products whose cover is below threshold (the actionable restock list). */
export function lowCoverSignals(signals: RestockSignal[], thresholdDays = COVER_THRESHOLD_DAYS): RestockSignal[] {
  return signals.filter((s) => s.daysOfCover != null && s.daysOfCover < thresholdDays && s.suggestedQty > 0);
}

/** The supplier the merchant last ordered this product from, if any. */
async function lastSupplierForProduct(db: Db, tenantId: string, productId: string): Promise<{ supplierTenantId: string; unitPriceCents: number } | null> {
  const rows = await db.execute(sql`
    SELECT po.supplier_tenant_id AS supplier_id, pi.unit_price_cents
    FROM po_items pi
    JOIN purchase_orders po ON po.id = pi.po_id
    WHERE po.buyer_tenant_id = ${tenantId}
      AND pi.product_ref = ${productId}
      AND po.status IN ('submitted','approved','fulfilled','invoiced','paid')
    ORDER BY po.created_at DESC
    LIMIT 1
  `).then((r: any) => (r.rows ?? r)).catch(() => [] as any[]);
  const row = (rows as any[])[0];
  return row ? { supplierTenantId: row.supplier_id, unitPriceCents: Number(row.unit_price_cents ?? 0) } : null;
}

/**
 * Auto-draft a restock PO (status 'draft' — merchant confirms). Idempotent:
 * an existing draft for the same tenant+product is returned, never
 * duplicated. Returns null when no supplier can be resolved.
 */
export async function draftRestockPo(db: Db, opts: {
  tenantId: string;
  signal: RestockSignal;
  notes?: string;
}): Promise<{ poId: string; poNumber: string; created: boolean } | null> {
  const supplier = await lastSupplierForProduct(db, opts.tenantId, opts.signal.productId);
  if (!supplier) return null;
  // Idempotency: reuse an open draft for this product (notes marker).
  const existing = await db.execute(sql`
    SELECT po.id, po.po_number FROM purchase_orders po
    JOIN po_items pi ON pi.po_id = po.id
    WHERE po.buyer_tenant_id = ${opts.tenantId}
      AND po.status = 'draft'
      AND pi.product_ref = ${opts.signal.productId}
    LIMIT 1
  `).then((r: any) => (r.rows ?? r)).catch(() => [] as any[]);
  if ((existing as any[]).length > 0) {
    return { poId: existing[0].id, poNumber: existing[0].po_number, created: false };
  }
  const now = new Date();
  const poId = crypto.randomUUID();
  const poNumber = `PO-RST-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const qty = opts.signal.suggestedQty;
  const unitPriceCents = supplier.unitPriceCents > 0 ? supplier.unitPriceCents : 0;
  await db.insert(purchaseOrders).values({
    id: poId,
    poNumber,
    buyerTenantId: opts.tenantId,
    supplierTenantId: supplier.supplierTenantId,
    status: "draft",
    subtotalCents: qty * unitPriceCents,
    paymentMode: "credit",
    notes: opts.notes ?? `W66 restock draft: ${opts.signal.productName} cover ${opts.signal.daysOfCover}d < ${COVER_THRESHOLD_DAYS}d`,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(poItems).values({
    id: crypto.randomUUID(),
    poId,
    productRef: opts.signal.productId,
    name: opts.signal.productName,
    qty,
    unitPriceCents,
    lineTotalCents: qty * unitPriceCents,
  });
  return { poId, poNumber, created: true };
}

/**
 * Merchant confirm: claim-first draft→submitted. Exactly one confirm
 * succeeds; the supplier admin is notified to approve/reject (money moves
 * only at supplier approval via poFlow.approvePurchaseOrder — fail-closed).
 */
export async function confirmRestockDraft(db: Db, opts: {
  tenantId: string;
  poId: string;
}): Promise<{ ok: true; poNumber: string } | { ok: false; reason: "not_found" | "wrong_status" }> {
  const claimed = await db.update(purchaseOrders)
    .set({ status: "submitted", updatedAt: new Date() })
    .where(and(
      eq(purchaseOrders.id, opts.poId),
      eq(purchaseOrders.buyerTenantId, opts.tenantId),
      eq(purchaseOrders.status, "draft"),
    ))
    .returning({ id: purchaseOrders.id, poNumber: purchaseOrders.poNumber, supplierTenantId: purchaseOrders.supplierTenantId });
  if (claimed.length === 0) {
    const [po] = await db.select({ id: purchaseOrders.id }).from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, opts.poId), eq(purchaseOrders.buyerTenantId, opts.tenantId))).limit(1);
    return { ok: false, reason: po ? "wrong_status" : "not_found" };
  }
  const po = claimed[0];
  // Notify supplier admin (fail-open; mirrors poFlow's approval card path).
  try {
    const { emitNotification } = await import("../routers/notifications");
    await emitNotification({
      id: crypto.randomUUID(), tenantId: po.supplierTenantId, type: "system",
      title: "New Purchase Order",
      body: `Restock PO ${po.poNumber} submitted — review to approve or reject.`,
      metadata: { poId: opts.poId, poNumber: po.poNumber, source: "w66_restock" },
      read: false, readAt: null, createdAt: new Date(),
    });
  } catch (e: any) {
    console.warn("[restock] supplier notify failed (fail-open):", e?.message);
  }
  return { ok: true, poNumber: po.poNumber };
}

export interface RestockSweepRun {
  draftsCreated: number;
  nudgesSent: number;
  skippedQuiet: number;
  skippedNoSupplier: number;
}

/** Daily sweep: draft restock POs + WA/TG nudge with one-tap confirm link. */
export async function runRestockSweep(opts: { now?: Date } = {}): Promise<RestockSweepRun> {
  const out: RestockSweepRun = { draftsCreated: 0, nudgesSent: 0, skippedQuiet: 0, skippedNoSupplier: 0 };
  try {
    const db = await getDb();
    if (!db) return out;
    const day = utcDay(opts.now ?? new Date());
    const tenantRows = await db.select({ id: tenants.id, settings: tenants.settings }).from(tenants)
      .catch(() => [] as any[]);
    for (const t of tenantRows as any[]) {
      try {
        const settings = ((t.settings ?? {}) as Record<string, unknown>);
        const adminPhone = typeof settings.adminPhone === "string" ? settings.adminPhone : "";
        const policy = parseMarketingFrequencyPolicy(settings);
        if (isQuietHours(opts.now ?? new Date(), policy)) { out.skippedQuiet += 1; continue; }
        const signals = lowCoverSignals(await computeRestockSignals(db, t.id));
        for (const sig of signals) {
          try {
            if (!(await claim(db, t.id, "restock_draft", sig.productId, day))) continue;
            const draft = await draftRestockPo(db, { tenantId: t.id, signal: sig });
            if (!draft) { out.skippedNoSupplier += 1; continue; }
            if (draft.created) out.draftsCreated += 1;
            if (!adminPhone) continue;
            const url = `${appBase()}/procurement?confirmPo=${draft.poId}`;
            const locale = (await getStickyLocale(t.id, adminPhone).catch(() => null)) ?? "en";
            const body = interpolate(t27(locale, "restockDraftNudge"), {
              product: sig.productName,
              days: sig.daysOfCover ?? 0,
              qty: sig.suggestedQty,
              url,
            });
            await sendParity(t.id, adminPhone, "w66_restock_draft", body);
            out.nudgesSent += 1;
          } catch (e: any) {
            console.warn("[restock] product sweep failed (fail-open):", e?.message);
          }
        }
      } catch (e: any) {
        console.warn("[restock] tenant sweep failed (fail-open):", e?.message);
      }
    }
  } catch (e: any) {
    console.error("[restock] sweep failed (fail-open):", e?.message);
  }
  return out;
}

export interface BuyerReorderRun {
  nudgesSent: number;
  skippedQuiet: number;
}

/**
 * Buyer-side "running low on X?" nudges: buyers with >= REORDER_MIN_HISTORY
 * paid orders containing the same product, whose last purchase is older than
 * their mean inter-purchase interval, get one nudge per product per week.
 */
export async function runBuyerReorderNudges(opts: { now?: Date } = {}): Promise<BuyerReorderRun> {
  const out: BuyerReorderRun = { nudgesSent: 0, skippedQuiet: 0 };
  try {
    const db = await getDb();
    if (!db) return out;
    const now = opts.now ?? new Date();
    // ISO week bucket (Monday) for weekly idempotency.
    const monday = new Date(now);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const week = monday.toISOString().slice(0, 10);

    const rows = await db.execute(sql`
      SELECT o."tenantId" AS tenant_id, o."customerId" AS buyer,
             oi."productName" AS product_name,
             count(DISTINCT o.id)::int AS purchases,
             max(o."createdAt") AS last_at,
             min(o."createdAt") AS first_at
      FROM order_items oi
      JOIN orders o ON o.id = oi."orderId" AND o."paymentStatus" = 'completed'
      GROUP BY o."tenantId", o."customerId", oi."productName"
      HAVING count(DISTINCT o.id) >= ${REORDER_MIN_HISTORY}
      ORDER BY last_at DESC
      LIMIT 500
    `).then((r: any) => (r.rows ?? r)).catch(() => [] as any[]);

    for (const r of rows as any[]) {
      try {
        const purchases = Number(r.purchases);
        const lastAt = new Date(r.last_at).getTime();
        const firstAt = new Date(r.first_at).getTime();
        const intervalMs = purchases > 1 ? (lastAt - firstAt) / (purchases - 1) : Infinity;
        // Cadence elapsed: time since last purchase exceeds the buyer's own
        // inter-purchase interval (floor 3 days to avoid same-week spam).
        if (now.getTime() - lastAt < Math.max(intervalMs, 3 * 24 * 3600_000)) continue;

        const [t] = await db.select({ settings: tenants.settings }).from(tenants)
          .where(eq(tenants.id, r.tenant_id)).limit(1).catch(() => [] as any[]);
        const settings = ((t as any)?.settings ?? {}) as Record<string, unknown>;
        if (isQuietHours(now, parseMarketingFrequencyPolicy(settings))) { out.skippedQuiet += 1; continue; }

        const buyerKey = String(r.buyer);
        if (!(await claim(db, r.tenant_id, "buyer_reorder", `${buyerKey}:${r.product_name}`, week))) continue;
        const locale = (await getStickyLocale(r.tenant_id, buyerKey).catch(() => null)) ?? "en";
        const body = interpolate(t27(locale, "reorderNudge"), { product: r.product_name });
        await sendParity(r.tenant_id, buyerKey, "w66_buyer_reorder", body);
        out.nudgesSent += 1;
      } catch (e: any) {
        console.warn("[restock] buyer reorder nudge failed (fail-open):", e?.message);
      }
    }
  } catch (e: any) {
    console.error("[restock] buyer reorder sweep failed (fail-open):", e?.message);
  }
  return out;
}

/** List draft restock POs for the ProcurementHub review card. */
export async function listRestockDrafts(db: Db, tenantId: string) {
  return db.select({
    id: purchaseOrders.id,
    poNumber: purchaseOrders.poNumber,
    supplierTenantId: purchaseOrders.supplierTenantId,
    subtotalCents: purchaseOrders.subtotalCents,
    notes: purchaseOrders.notes,
    createdAt: purchaseOrders.createdAt,
  }).from(purchaseOrders)
    .where(and(eq(purchaseOrders.buyerTenantId, tenantId), eq(purchaseOrders.status, "draft")))
    .orderBy(desc(purchaseOrders.createdAt))
    .limit(50);
}
// === END W66 learning ===
