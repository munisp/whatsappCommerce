/**
 * procurement/b2bCatalog.ts — Wholesale (B2B) catalog view of a supplier.
 *
 * Pricing resolution order (ADDITIVE over the existing Medusa client — the
 * supplier's Medusa price lists are consulted first when Medusa is wired up
 * for that tenant, otherwise we fall back to the local catalog):
 *   1. Medusa ACTIVE price lists (medusaAdapter.listPriceLists/listProducts)
 *      — variant prices with optional min_quantity tiers.
 *   2. Local products table, preferring wholesale_price_tiers
 *      (buyerType='wholesale', lowest min-quantity tier), then
 *      products.metadata.wholesalePrice, then the retail price.
 *
 * All prices are returned in CENTS (minor units). The supplier's MOQ is
 * attached to the result so the PO flow can enforce it at review time.
 */
import { and, asc, eq } from "drizzle-orm";
import { products, wholesalePriceTiers } from "../../../drizzle/schema";
import { getActiveSupplierProfile, type DbHandle } from "./directory";

export interface WholesaleItem {
  /** products.id locally, or `medusa:<productId>:<variantId>` for Medusa rows. */
  productRef: string;
  name: string;
  unitPriceCents: number;
  /** Minimum per-line quantity (wholesale tier min_quantity, else 1). */
  minQty: number;
  currency: string;
  source: "medusa" | "local";
}

export interface WholesaleCatalog {
  supplierTenantId: string;
  items: WholesaleItem[];
  moqCents: number;
  leadTimeDays: number;
  termsOffered: number[];
  defaultTermsDays: number;
  source: "medusa" | "local";
}

/** "123.45" (major units) → 12345 cents; null/NaN-safe. */
export function majorToCents(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

async function catalogFromMedusa(supplierTenantId: string, limit: number): Promise<WholesaleItem[]> {
  // Dynamic import: when Medusa env is absent the adapter throws on first
  // call — we catch and fall back to the local catalog.
  const { listPriceLists, listProducts } = await import("../medusaAdapter");
  const [{ price_lists: priceLists }, { products: medusaProducts }] = await Promise.all([
    listPriceLists(),
    listProducts({ limit }),
  ]);
  const active = (priceLists ?? []).filter((pl) => pl.status === "active");
  if (active.length === 0 || !Array.isArray(medusaProducts) || medusaProducts.length === 0) return [];

  // variant_id → best (lowest amount, then its min_quantity) wholesale price
  const best = new Map<string, { amountCents: number; minQty: number }>();
  for (const pl of active) {
    for (const price of pl.prices ?? []) {
      const amountCents = Math.round(Number(price.amount));
      if (!Number.isFinite(amountCents) || amountCents < 0) continue;
      const minQty = Math.max(1, Number(price.min_quantity ?? 1));
      const cur = best.get(price.variant_id);
      if (!cur || amountCents < cur.amountCents) best.set(price.variant_id, { amountCents, minQty });
    }
  }
  const items: WholesaleItem[] = [];
  for (const p of medusaProducts) {
    for (const v of (p as any).variants ?? []) {
      const hit = best.get(v.id);
      if (!hit) continue;
      items.push({
        productRef: `medusa:${p.id}:${v.id}`,
        name: v.title && v.title !== "Default Variant" ? `${p.title} — ${v.title}` : p.title,
        unitPriceCents: hit.amountCents,
        minQty: hit.minQty,
        currency: "NGN",
        source: "medusa",
      });
    }
  }
  return items.slice(0, limit);
}

async function catalogFromLocal(db: DbHandle, supplierTenantId: string, limit: number, buyerType = "wholesale"): Promise<WholesaleItem[]> {
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.tenantId, supplierTenantId), eq(products.status, "active")))
    .limit(limit)
    .catch(() => [] as any[]);
  if (!rows || rows.length === 0) return [];

  // === W46 uc-docs (UC-18): resolve tiers for the buyer's ACTUAL type/group
  // (was hardcoded 'wholesale'). The buyer's own type is preferred; the
  // legacy 'wholesale' tier remains the fallback so existing tenants are
  // byte-equivalent for buyers without a more specific group.
  const wanted = buyerType === "wholesale" ? ["wholesale"] : [buyerType, "wholesale"];
  const tiers = await db
    .select()
    .from(wholesalePriceTiers)
    .where(and(eq(wholesalePriceTiers.tenantId, supplierTenantId)))
    .orderBy(asc(wholesalePriceTiers.minQuantity))
    .catch(() => [] as any[]);
  const tierByProduct = new Map<string, any>();
  for (const t of tiers ?? []) {
    if (!wanted.includes(t.buyerType)) continue;
    const cur = tierByProduct.get(t.productId);
    // Prefer the buyer's own type over the wholesale fallback; within a
    // type, the lowest min-quantity tier (catalog entry price).
    const rank = (tt: any) => (tt.buyerType === buyerType ? 0 : 1);
    if (!cur || rank(t) < rank(cur) || (rank(t) === rank(cur) && Number(t.minQuantity ?? 1) < Number(cur.minQuantity ?? 1))) {
      tierByProduct.set(t.productId, t);
    }
  }
  // === END W46 uc-docs ===

  const items: WholesaleItem[] = [];
  for (const p of rows) {
    const tier = tierByProduct.get(p.id);
    const meta = (p.metadata ?? null) as Record<string, unknown> | null;
    let priceCents =
      (tier ? majorToCents(tier.unitPrice) : null) ??
      majorToCents(meta?.wholesalePrice) ??
      majorToCents(p.price);
    // === W46 uc-docs (UC-18): per-group discount from the tier row.
    if (priceCents != null && tier?.discountPercent != null) {
      const pct = Math.min(100, Math.max(0, parseFloat(String(tier.discountPercent)) || 0));
      priceCents = Math.round(priceCents * (100 - pct) / 100);
    }
    // === END W46 uc-docs ===
    if (priceCents == null) continue;
    items.push({
      productRef: p.id,
      name: p.name,
      unitPriceCents: priceCents,
      minQty: tier ? Math.max(1, Number(tier.minQuantity ?? 1)) : 1,
      currency: p.currency ?? "NGN",
      source: "local",
    });
  }
  return items;
}

/**
 * Wholesale catalog for a supplier tenant. Returns null when the supplier has
 * no ACTIVE profile (procurement is opt-in per supplier).
 */
export async function getWholesaleCatalog(
  db: DbHandle,
  opts: { supplierTenantId: string; limit?: number; buyerType?: string; buyerPhone?: string },
): Promise<WholesaleCatalog | null> {
  const profile = await getActiveSupplierProfile(db, opts.supplierTenantId);
  if (!profile) return null;
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);

  // === W46 uc-docs (UC-18): resolve the buyer's actual type/group at quote
  // time (explicit > customer tags > latest RFQ > 'wholesale' default).
  let buyerType = "wholesale";
  try {
    const { resolveBuyerType } = await import("../tierPricing");
    const resolved = await resolveBuyerType(db, {
      tenantId: opts.supplierTenantId,
      phone: opts.buyerPhone ?? null,
      explicit: opts.buyerType ?? null,
    });
    buyerType = resolved.buyerType;
  } catch (e: any) {
    console.info("[procurement.b2bCatalog] buyer-type resolution failed, defaulting to wholesale:", e?.message);
  }
  // === END W46 uc-docs ===

  let items: WholesaleItem[] = [];
  let source: "medusa" | "local" = "local";
  try {
    items = await catalogFromMedusa(opts.supplierTenantId, limit);
    if (items.length > 0) source = "medusa";
  } catch (e: any) {
    console.info("[procurement.b2bCatalog] medusa catalog unavailable, using local:", e?.message);
  }
  if (items.length === 0) {
    items = await catalogFromLocal(db, opts.supplierTenantId, limit, buyerType);
    source = "local";
  }

  return {
    supplierTenantId: opts.supplierTenantId,
    items,
    moqCents: Number(profile.moqCents ?? 0),
    leadTimeDays: Number(profile.leadTimeDays ?? 3),
    termsOffered: Array.isArray(profile.termsOffered) ? (profile.termsOffered as number[]) : [],
    defaultTermsDays: Number(profile.defaultTermsDays ?? 14),
    source,
  };
}
