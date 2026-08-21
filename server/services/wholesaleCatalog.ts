/**
 * W27 — B2B wholesale marketplace catalog + purchase-order engine.
 *
 * Wholesaler tenants publish bulk listings (MOQ + tiered unit pricing,
 * INTEGER CENTS). Retailer tenants (or WhatsApp phone buyers) browse/search
 * the marketplace and place purchase orders. Checkout supports:
 *   - 'pay_now'      → returns a payment descriptor for the existing
 *                      payment rails (initiateWithFallback / payment links);
 *   - 'trade_credit' → draws on the buyer's existing credit account via
 *                      drawOnCreditTx (server/services/tradeCredit, public
 *                      interface), GATED by the platform merchant credit
 *                      score (getMerchantScore contract — see
 *                      creditScoreClient.ts).
 *
 * Deterministic: no unseeded randomness; all money math in integer cents.
 * Every public function takes the caller's db handle per repo convention
 * (services/inventory.ts, services/tradeCredit).
 */
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  wholesaleListings,
  wholesaleListingTiers,
  wholesaleOrders,
  type WholesaleListing,
  type WholesaleListingTier,
  type WholesaleOrder,
} from "../../drizzle/schema";
import { drawOnCreditTx } from "./tradeCredit";
import type { DbHandle } from "./tradeCredit/accounts";
import { getMerchantScoreGuarded } from "./creditScoreClient";

export type { DbHandle };

// ── Configuration (env-overridable, deterministic defaults) ────────────────
/** Minimum platform credit score (0–1000) required for trade-credit checkout. */
export function wholesaleCreditMinScore(): number {
  const v = Number(process.env.WHOLESALE_CREDIT_MIN_SCORE);
  return Number.isFinite(v) && v >= 0 ? Math.min(1000, Math.round(v)) : 300;
}

// ── Pure pricing (unit-testable) ────────────────────────────────────────────
export interface TierBand {
  minQty: number;
  maxQty?: number | null;
  unitPriceCents: number;
}

export type TieredPriceResult =
  | { ok: true; unitPriceCents: number; totalCents: number; tier: TierBand }
  | { ok: false; reason: "below_moq" | "no_tier" | "invalid_qty" };

/**
 * Resolve the unit price for `qty` against a listing's tier bands.
 * Bands are [minQty, maxQty] inclusive, maxQty NULL = open-ended. The band
 * with the HIGHEST minQty that still contains qty wins (deterministic even
 * with overlapping bands). totalCents = qty × unitPriceCents exactly.
 */
export function computeTieredPrice(
  tiers: TierBand[],
  qty: number,
  moq: number,
): TieredPriceResult {
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, reason: "invalid_qty" };
  if (qty < moq) return { ok: false, reason: "below_moq" };
  const containing = tiers
    .filter((t) => qty >= t.minQty && (t.maxQty == null || qty <= t.maxQty))
    .sort((a, b) => b.minQty - a.minQty || a.unitPriceCents - b.unitPriceCents);
  const tier = containing[0];
  if (!tier) return { ok: false, reason: "no_tier" };
  const unitPriceCents = Math.round(tier.unitPriceCents);
  return { ok: true, unitPriceCents, totalCents: qty * unitPriceCents, tier };
}

// ── Listing management ─────────────────────────────────────────────────────
export async function createWholesaleListingTx(
  db: DbHandle,
  args: {
    tenantId: string;
    title: string;
    description?: string;
    category?: string;
    productId?: string;
    moq?: number;
    currency?: string;
    status?: "draft" | "active" | "paused";
  },
): Promise<WholesaleListing> {
  const id = randomUUID();
  const [row] = await db
    .insert(wholesaleListings)
    .values({
      id,
      tenantId: args.tenantId,
      title: args.title,
      description: args.description ?? null,
      category: args.category ?? null,
      productId: args.productId ?? null,
      moq: args.moq && args.moq > 0 ? Math.round(args.moq) : 1,
      currency: args.currency ?? "NGN",
      status: args.status ?? "draft",
    })
    .returning();
  return row;
}

export async function setWholesaleListingStatusTx(
  db: DbHandle,
  args: { tenantId: string; listingId: string; status: "draft" | "active" | "paused" },
): Promise<WholesaleListing | null> {
  const [row] = await db
    .update(wholesaleListings)
    .set({ status: args.status, updatedAt: new Date() })
    .where(and(eq(wholesaleListings.id, args.listingId), eq(wholesaleListings.tenantId, args.tenantId)))
    .returning();
  return row ?? null;
}

export async function upsertWholesaleTierTx(
  db: DbHandle,
  args: {
    tenantId: string;
    listingId: string;
    minQty: number;
    maxQty?: number | null;
    unitPriceCents: number;
  },
): Promise<WholesaleListingTier> {
  const [row] = await db
    .insert(wholesaleListingTiers)
    .values({
      id: randomUUID(),
      tenantId: args.tenantId,
      listingId: args.listingId,
      minQty: Math.round(args.minQty),
      maxQty: args.maxQty == null ? null : Math.round(args.maxQty),
      unitPriceCents: Math.round(args.unitPriceCents),
    })
    .returning();
  return row;
}

export async function replaceWholesaleTiersTx(
  db: DbHandle,
  args: { tenantId: string; listingId: string; tiers: TierBand[] },
): Promise<WholesaleListingTier[]> {
  await db
    .delete(wholesaleListingTiers)
    .where(and(eq(wholesaleListingTiers.listingId, args.listingId), eq(wholesaleListingTiers.tenantId, args.tenantId)));
  const out: WholesaleListingTier[] = [];
  for (const t of args.tiers) {
    out.push(await upsertWholesaleTierTx(db, { tenantId: args.tenantId, listingId: args.listingId, ...t }));
  }
  return out;
}

export async function getWholesaleListingTx(
  db: DbHandle,
  listingId: string,
): Promise<{ listing: WholesaleListing; tiers: WholesaleListingTier[] } | null> {
  const [listing] = await db.select().from(wholesaleListings).where(eq(wholesaleListings.id, listingId)).limit(1);
  if (!listing) return null;
  const tiers = await db
    .select()
    .from(wholesaleListingTiers)
    .where(eq(wholesaleListingTiers.listingId, listingId))
    .orderBy(asc(wholesaleListingTiers.minQty));
  return { listing, tiers };
}

// ── Marketplace browse/search (retailer side, cross-tenant, active only) ───
export async function searchWholesaleListingsTx(
  db: DbHandle,
  args: {
    query?: string;
    category?: string;
    tenantId?: string; // restrict to one wholesaler
    limit?: number;
  } = {},
): Promise<Array<{ listing: WholesaleListing; tiers: WholesaleListingTier[] }>> {
  const conds = [eq(wholesaleListings.status, "active")];
  if (args.tenantId) conds.push(eq(wholesaleListings.tenantId, args.tenantId));
  if (args.category) conds.push(eq(wholesaleListings.category, args.category));
  if (args.query && args.query.trim()) {
    const q = `%${args.query.trim()}%`;
    conds.push(or(ilike(wholesaleListings.title, q), ilike(wholesaleListings.description, q))!);
  }
  const rows = await db
    .select()
    .from(wholesaleListings)
    .where(and(...conds))
    .orderBy(desc(wholesaleListings.createdAt))
    .limit(Math.min(Math.max(args.limit ?? 20, 1), 100));
  const out: Array<{ listing: WholesaleListing; tiers: WholesaleListingTier[] }> = [];
  for (const listing of rows) {
    const tiers = await db
      .select()
      .from(wholesaleListingTiers)
      .where(eq(wholesaleListingTiers.listingId, listing.id))
      .orderBy(asc(wholesaleListingTiers.minQty));
    out.push({ listing, tiers });
  }
  return out;
}

// ── Purchase orders ────────────────────────────────────────────────────────
export type WholesaleCheckoutResult =
  | {
      ok: true;
      order: WholesaleOrder;
      paymentMode: "pay_now" | "trade_credit";
      credit?: { ledgerId: string; outstandingAfter: number; score: number };
    }
  | {
      ok: false;
      reason:
        | "listing_not_found"
        | "listing_not_active"
        | "below_moq"
        | "no_tier"
        | "invalid_qty"
        | "credit_score_too_low"
        | "credit_draw_failed";
      detail?: string;
      score?: number;
    };

/**
 * Place a wholesale purchase order. Tenant scoping: the listing's tenantId
 * is the supplier; the buyer is `buyerTenantId` (retailer tenant) and/or
 * `buyerPhone` (WhatsApp buyer). At least one buyer identifier is required.
 *
 * trade_credit flow:
 *   1. Platform credit score gate (getMerchantScore contract). Below
 *      WHOLESALE_CREDIT_MIN_SCORE → refused BEFORE any state change.
 *   2. drawOnCreditTx — atomic claim-first draw on the existing credit
 *      account (never exceeds limit; idempotent on poId ref).
 *   3. Only then is the order row persisted (status 'confirmed',
 *      paymentMode 'trade_credit', creditLedgerId + creditScore recorded).
 */
export async function placeWholesaleOrderTx(
  db: DbHandle,
  args: {
    listingId: string;
    quantity: number;
    buyerTenantId?: string | null;
    buyerPhone?: string | null;
    paymentMode?: "pay_now" | "trade_credit";
    termsDays?: number;
    notes?: string;
    idempotencyKey?: string; // deterministic order id for retries
  },
): Promise<WholesaleCheckoutResult> {
  if (!args.buyerTenantId && !args.buyerPhone) {
    return { ok: false, reason: "credit_draw_failed", detail: "buyerTenantId or buyerPhone required" };
  }
  const found = await getWholesaleListingTx(db, args.listingId);
  if (!found) return { ok: false, reason: "listing_not_found" };
  const { listing, tiers } = found;
  if (listing.status !== "active") return { ok: false, reason: "listing_not_active" };

  const priced = computeTieredPrice(tiers, args.quantity, listing.moq);
  if (!priced.ok) return { ok: false, reason: priced.reason };

  const paymentMode = args.paymentMode ?? "pay_now";
  const orderId = args.idempotencyKey ?? randomUUID();

  // Idempotent replay: a retry with the same key returns the original order.
  const [existing] = await db.select().from(wholesaleOrders).where(eq(wholesaleOrders.id, orderId)).limit(1);
  if (existing) {
    return { ok: true, order: existing, paymentMode: existing.paymentMode as "pay_now" | "trade_credit" };
  }

  let credit: { ledgerId: string; outstandingAfter: number; score: number } | undefined;

  if (paymentMode === "trade_credit") {
    if (!args.buyerTenantId) {
      return { ok: false, reason: "credit_draw_failed", detail: "trade credit requires a buyer tenant" };
    }
    // 1. Platform credit score gate (D's contract via import guard).
    const scoreRes = await getMerchantScoreGuarded(listing.tenantId, args.buyerTenantId, db);
    const minScore = wholesaleCreditMinScore();
    if (scoreRes.score < minScore) {
      return {
        ok: false,
        reason: "credit_score_too_low",
        detail: `score ${scoreRes.score} below required ${minScore}`,
        score: scoreRes.score,
      };
    }
    // 2. Atomic draw on the existing credit facility (public interface).
    const draw = await drawOnCreditTx(db, {
      supplierTenantId: listing.tenantId,
      buyerTenantId: args.buyerTenantId,
      amountCents: priced.totalCents,
      poId: orderId,
      termsDays: args.termsDays,
    });
    if (!draw.ok) {
      return { ok: false, reason: "credit_draw_failed", detail: draw.reason, score: scoreRes.score };
    }
    credit = { ledgerId: draw.ledgerId, outstandingAfter: draw.outstandingAfter, score: scoreRes.score };
  }

  const now = new Date();
  const [order] = await db
    .insert(wholesaleOrders)
    .values({
      id: orderId,
      tenantId: listing.tenantId,
      buyerTenantId: args.buyerTenantId ?? null,
      buyerPhone: args.buyerPhone ?? null,
      listingId: listing.id,
      quantity: args.quantity,
      unitPriceCents: priced.unitPriceCents,
      totalCents: priced.totalCents,
      currency: listing.currency,
      status: paymentMode === "trade_credit" ? "confirmed" : "pending",
      paymentMode,
      creditLedgerId: credit?.ledgerId ?? null,
      creditScore: credit?.score ?? null,
      notes: args.notes ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return { ok: true, order, paymentMode, credit };
}

export async function listWholesaleOrdersTx(
  db: DbHandle,
  args: { tenantId: string; role: "supplier" | "buyer"; status?: string; limit?: number },
): Promise<WholesaleOrder[]> {
  const conds = [
    args.role === "supplier"
      ? eq(wholesaleOrders.tenantId, args.tenantId)
      : eq(wholesaleOrders.buyerTenantId, args.tenantId),
  ];
  if (args.status) conds.push(eq(wholesaleOrders.status, args.status));
  return db
    .select()
    .from(wholesaleOrders)
    .where(and(...conds))
    .orderBy(desc(wholesaleOrders.createdAt))
    .limit(Math.min(Math.max(args.limit ?? 50, 1), 200));
}

/** Supplier-side status transition (confirm → paid → fulfilled, or cancel). */
export async function updateWholesaleOrderStatusTx(
  db: DbHandle,
  args: { tenantId: string; orderId: string; status: "pending" | "confirmed" | "paid" | "fulfilled" | "cancelled" },
): Promise<WholesaleOrder | null> {
  const [row] = await db
    .update(wholesaleOrders)
    .set({ status: args.status, updatedAt: new Date() })
    .where(and(eq(wholesaleOrders.id, args.orderId), eq(wholesaleOrders.tenantId, args.tenantId)))
    .returning();
  return row ?? null;
}

// ── WhatsApp-friendly formatting (deterministic) ───────────────────────────
export function formatMajor(cents: number, currency = "NGN"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const major = Math.floor(abs / 100).toLocaleString("en-US").replace(/,/g, ",");
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${currency} ${major}.${frac}`;
}

export function formatListingForWhatsApp(
  listing: WholesaleListing,
  tiers: WholesaleListingTier[],
  index?: number,
): string {
  const prefix = index != null ? `${index + 1}. ` : "";
  const tierStr =
    tiers.length === 0
      ? "price on request"
      : tiers
          .map((t) => `${t.minQty}+${t.maxQty != null ? `–${t.maxQty}` : ""} units: ${formatMajor(t.unitPriceCents, listing.currency)}/unit`)
          .join("; ");
  return `${prefix}*${listing.title}* (MOQ ${listing.moq})\n${tierStr}\nID: ${listing.id.slice(0, 8)}`;
}
