// === W46 uc-docs ===
/**
 * UC-18 — wholesale tier resolution from the buyer's ACTUAL type/group.
 *
 * Replaces the hardcoded buyerType='wholesale' lookup in
 * procurement/b2bCatalog.ts (previously line ~100): the catalog now prices
 * against the buyer's resolved type/group, falling back honestly:
 *
 *   resolveBuyerType(tenantId, phone, explicit?):
 *     1. an explicit caller-supplied buyerType wins (dashboard quote tools);
 *     2. the customers row's tags — the FIRST tag that is a known buyer
 *        type/group ('retail'|'wholesale'|'distributor'|'government') is the
 *        buyer's group;
 *     3. the buyer's most recent b2b_rfq.buyerType (self-declared at RFQ);
 *     4. default 'wholesale' (preserves the pre-W46 behavior for anonymous
 *        B2B buyers).
 *
 *   resolveTierPrice(...): the wholesale_price_tiers row for the buyer's
 *     type whose [minQuantity, maxQuantity] bracket contains the quantity
 *     (highest minQuantity = best tier); tier.discountPercent is applied on
 *     top (per-group discounts). Fallback chain when no tier matches the
 *     buyer's own type: 'wholesale' tier → metadata.wholesalePrice → retail
 *     price. All outputs integer cents.
 */
import { and, desc, eq } from "drizzle-orm";
import { b2bRfq, customers, products, wholesalePriceTiers } from "../../drizzle/schema";

type Db = any;

export const BUYER_TYPES = ["retail", "wholesale", "distributor", "government"] as const;
export type BuyerType = (typeof BUYER_TYPES)[number];

export function isBuyerType(v: unknown): v is BuyerType {
  return typeof v === "string" && (BUYER_TYPES as readonly string[]).includes(v);
}

/** Resolve the buyer's actual type/group for tier pricing at quote time. */
export async function resolveBuyerType(
  db: Db,
  opts: { tenantId: string; phone?: string | null; explicit?: string | null },
): Promise<{ buyerType: BuyerType; source: "explicit" | "customer_tags" | "rfq" | "default" }> {
  if (isBuyerType(opts.explicit)) return { buyerType: opts.explicit, source: "explicit" };
  const phone = opts.phone ?? null;
  if (phone) {
    // 2. customer tags carry the buyer's group (CRM segmentation).
    const [cust] = await db.select({ tags: customers.tags }).from(customers)
      .where(and(eq(customers.tenantId, opts.tenantId), eq(customers.whatsappPhone, phone)))
      .limit(1)
      .catch(() => [] as any[]);
    const tags = Array.isArray(cust?.tags) ? (cust.tags as unknown[]) : [];
    const tagHit = tags.find((t) => isBuyerType(t));
    if (isBuyerType(tagHit)) return { buyerType: tagHit, source: "customer_tags" };

    // 3. most recent RFQ self-declaration.
    const [rfq] = await db.select({ buyerType: b2bRfq.buyerType }).from(b2bRfq)
      .where(and(eq(b2bRfq.tenantId, opts.tenantId), eq(b2bRfq.buyerPhone, phone)))
      .orderBy(desc(b2bRfq.createdAt))
      .limit(1)
      .catch(() => [] as any[]);
    if (isBuyerType(rfq?.buyerType)) return { buyerType: rfq.buyerType, source: "rfq" };
  }
  // 4. default — identical to the pre-W46 hardcoded behavior.
  return { buyerType: "wholesale", source: "default" };
}

export interface TierResolution {
  unitPriceCents: number;
  minQty: number;
  /** Which tier row produced the price, if any. */
  tierId: string | null;
  buyerTypeUsed: string;
  /** Per-group discount applied from tier.discountPercent (0 when none). */
  discountPercent: number;
  source: "tier" | "tier_fallback_wholesale" | "metadata" | "retail";
}

function majorToCentsLocal(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/**
 * Resolve the unit price for (product, buyerType, quantity) from
 * wholesale_price_tiers. Returns null when no price could be resolved.
 */
export async function resolveTierPrice(
  db: Db,
  opts: { tenantId: string; productId: string; buyerType: BuyerType; quantity?: number },
): Promise<TierResolution | null> {
  const qty = Math.max(1, Math.floor(opts.quantity ?? 1));
  const [product] = await db.select().from(products)
    .where(and(eq(products.id, opts.productId), eq(products.tenantId, opts.tenantId)))
    .limit(1)
    .catch(() => [] as any[]);
  if (!product) return null;

  const tiers = await db.select().from(wholesalePriceTiers)
    .where(and(eq(wholesalePriceTiers.tenantId, opts.tenantId), eq(wholesalePriceTiers.productId, opts.productId)))
    .orderBy(desc(wholesalePriceTiers.minQuantity))
    .catch(() => [] as any[]);

  const pickTier = (type: string) =>
    (tiers ?? [])
      .filter((t: any) => t.buyerType === type)
      .filter((t: any) => Number(t.minQuantity ?? 1) <= qty && (t.maxQuantity == null || Number(t.maxQuantity) >= qty))
      // highest minQuantity = best (deepest) tier for this quantity
      .sort((a: any, b: any) => Number(b.minQuantity ?? 1) - Number(a.minQuantity ?? 1))[0] ?? null;

  const applyTier = (tier: any, source: TierResolution["source"], buyerTypeUsed: string): TierResolution | null => {
    const base = majorToCentsLocal(tier.unitPrice);
    if (base == null) return null;
    const discountPercent = tier.discountPercent != null ? Math.min(100, Math.max(0, parseFloat(String(tier.discountPercent)) || 0)) : 0;
    const unitPriceCents = Math.round(base * (100 - discountPercent) / 100);
    return { unitPriceCents, minQty: Math.max(1, Number(tier.minQuantity ?? 1)), tierId: tier.id, buyerTypeUsed, discountPercent, source };
  };

  const own = pickTier(opts.buyerType);
  if (own) {
    const hit = applyTier(own, "tier", opts.buyerType);
    if (hit) return hit;
  }
  if (opts.buyerType !== "wholesale") {
    const fallback = pickTier("wholesale");
    if (fallback) {
      const hit = applyTier(fallback, "tier_fallback_wholesale", "wholesale");
      if (hit) return hit;
    }
  }
  const meta = (product.metadata ?? null) as Record<string, unknown> | null;
  const metaPrice = majorToCentsLocal(meta?.wholesalePrice);
  if (metaPrice != null) {
    return { unitPriceCents: metaPrice, minQty: 1, tierId: null, buyerTypeUsed: opts.buyerType, discountPercent: 0, source: "metadata" };
  }
  const retail = majorToCentsLocal(product.price);
  if (retail == null) return null;
  return { unitPriceCents: retail, minQty: 1, tierId: null, buyerTypeUsed: opts.buyerType, discountPercent: 0, source: "retail" };
}

/**
 * Quote a list of items for a buyer at their resolved type/group. Used by
 * the RFQ quote path so per-group discounts apply at quote time.
 */
export async function quoteItemsForBuyer(
  db: Db,
  opts: { tenantId: string; phone?: string | null; buyerType?: string | null; items: { productId: string; quantity: number }[] },
) {
  const resolved = await resolveBuyerType(db, { tenantId: opts.tenantId, phone: opts.phone, explicit: opts.buyerType });
  const lines: { productId: string; quantity: number; resolution: TierResolution | null }[] = [];
  let totalCents = 0;
  for (const it of opts.items) {
    const resolution = await resolveTierPrice(db, {
      tenantId: opts.tenantId, productId: it.productId, buyerType: resolved.buyerType, quantity: it.quantity,
    });
    lines.push({ productId: it.productId, quantity: it.quantity, resolution });
    if (resolution) totalCents += resolution.unitPriceCents * Math.max(1, it.quantity);
  }
  return { buyerType: resolved.buyerType, buyerTypeSource: resolved.source, lines, totalCents };
}
// === END W46 uc-docs ===
