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
  merchantWallets,
  walletTransactions,
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

// === W32 earlypay-fx (Coder C): early-payment discounts on wholesale POs ===
//
// Doctrine:
//  - Supplier-configured terms (discount_bps + discount_window_days +
//    due_date) live ON the wholesale_orders row (migration 0109). The
//    supplier offered the discount, so on an early pay the supplier is
//    credited exactly the discounted amount — no hidden haircut, no
//    platform skim on this leg.
//  - Claim-first: earlyPay flips discount_applied via ONE guarded
//    conditional UPDATE (status payable + NOT discount_applied + deadline
//    still open) INSIDE the money transaction. A double-tap loses the
//    guard → CONFLICT, never a double discount. The wallet ledger row
//    (reference `earlypay:<orderId>`) is the durable idempotency backstop
//    via wallet_tx_wallet_ref_uniq (0053).
//  - All math integer cents; deadlines server-derived (never trust a
//    client-supplied "still in window").

/** Pure early-pay math — unit-testable, deterministic. */
export function computeEarlyPayTerms(args: {
  totalCents: number;
  discountBps?: number | null;
  discountWindowDays?: number | null;
  dueDate?: Date | null;
  createdAt: Date;
  now?: Date;
}): {
  hasTerms: boolean;
  deadline: Date | null;
  saveCents: number;
  payableCents: number;
  available: boolean;
} {
  const now = args.now ?? new Date();
  const bps = args.discountBps ?? null;
  const windowDays = args.discountWindowDays ?? null;
  if (!bps || bps <= 0 || !windowDays || windowDays <= 0) {
    return { hasTerms: false, deadline: null, saveCents: 0, payableCents: args.totalCents, available: false };
  }
  // deadline = MIN(due_date, created_at + window) — never past the invoice due date.
  const windowEnd = new Date(args.createdAt.getTime() + windowDays * 86_400_000);
  const deadline = args.dueDate && args.dueDate.getTime() < windowEnd.getTime() ? args.dueDate : windowEnd;
  const saveCents = Math.round((args.totalCents * bps) / 10_000);
  return {
    hasTerms: true,
    deadline,
    saveCents,
    payableCents: args.totalCents - saveCents,
    available: now.getTime() < deadline.getTime(),
  };
}

/** Buyer-facing early-pay preview: "Pay by <deadline> to save ₦X" (server-derived). */
export async function earlyPayPreviewTx(
  db: DbHandle,
  args: { buyerTenantId: string; orderId: string },
): Promise<
  | { ok: true; orderId: string; currency: string; totalCents: number; available: boolean;
      deadline: Date | null; saveCents: number; payableCents: number; message: string }
  | { ok: false; reason: "not_found" }
> {
  const [order] = await db.select().from(wholesaleOrders).where(eq(wholesaleOrders.id, args.orderId)).limit(1);
  if (!order || order.buyerTenantId !== args.buyerTenantId) return { ok: false, reason: "not_found" };
  // The STORED early_pay_deadline is authoritative (it's what the earlyPay
  // claim guard checks in SQL) — never re-derive a different window here.
  const hasTerms = (order.discountBps ?? 0) > 0 && order.earlyPayDeadline != null;
  const saveCents = hasTerms ? Math.round((order.totalCents * order.discountBps!) / 10_000) : 0;
  const t = {
    hasTerms,
    deadline: order.earlyPayDeadline ?? null,
    saveCents,
    payableCents: order.totalCents - saveCents,
    available: hasTerms && order.earlyPayDeadline!.getTime() > Date.now(),
  };
  const payable = ["pending", "confirmed"].includes(order.status);
  const available = t.hasTerms && t.available && payable && !order.discountApplied;
  const message = !t.hasTerms
    ? "No early-payment discount on this order"
    : !payable
      ? `Order is ${order.status} — early payment no longer applies`
      : order.discountApplied
        ? "Early-payment discount already applied"
        : t.available
          ? `Pay by ${t.deadline!.toISOString().slice(0, 10)} to save ${formatMajor(t.saveCents, order.currency)}`
          : "Early-payment window has expired — full amount due";
  return {
    ok: true,
    orderId: order.id,
    currency: order.currency,
    totalCents: order.totalCents,
    available,
    deadline: t.deadline,
    saveCents: available ? t.saveCents : 0,
    payableCents: available ? t.payableCents : order.totalCents,
    message,
  };
}

/** Supplier sets/refreshes the early-payment terms on a PO (pre-payment only). */
export async function setWholesalePaymentTermsTx(
  db: DbHandle,
  args: {
    tenantId: string; // supplier
    orderId: string;
    discountBps: number;
    discountWindowDays: number;
    dueDate?: Date | null;
  },
): Promise<{ ok: true; order: WholesaleOrder } | { ok: false; reason: "not_found" | "terms_locked" }> {
  const [order] = await db.select().from(wholesaleOrders).where(eq(wholesaleOrders.id, args.orderId)).limit(1);
  if (!order || order.tenantId !== args.tenantId) return { ok: false, reason: "not_found" };
  // Terms are locked once money moved or the discount was claimed — a
  // supplier must never reprice a PO the buyer already acted on.
  if (!["pending", "confirmed"].includes(order.status) || order.discountApplied) {
    return { ok: false, reason: "terms_locked" };
  }
  const t = computeEarlyPayTerms({
    totalCents: order.totalCents,
    discountBps: args.discountBps,
    discountWindowDays: args.discountWindowDays,
    dueDate: args.dueDate ?? null,
    createdAt: order.createdAt,
  });
  const [row] = await db
    .update(wholesaleOrders)
    .set({
      discountBps: Math.round(args.discountBps),
      discountWindowDays: Math.round(args.discountWindowDays),
      dueDate: args.dueDate ?? null,
      earlyPayDeadline: t.deadline,
      updatedAt: new Date(),
    })
    .where(and(
      eq(wholesaleOrders.id, args.orderId),
      eq(wholesaleOrders.tenantId, args.tenantId),
      eq(wholesaleOrders.discountApplied, false),
      sql`${wholesaleOrders.status} IN ('pending','confirmed')`,
    ))
    .returning();
  if (!row) return { ok: false, reason: "terms_locked" };
  return { ok: true, order: row };
}

export type EarlyPayResult =
  | { ok: true; order: WholesaleOrder; chargedCents: number; saveCents: number; supplierCreditedCents: number; walletTxId: string }
  | { ok: false; reason: "not_found" | "no_terms" | "window_expired" | "already_claimed" | "not_payable" | "insufficient_funds" };

async function getOrCreateWalletLocal(db: any, tenantId: string) {
  const [existing] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantId));
  if (existing) return existing;
  const id = randomUUID();
  await db.insert(merchantWallets).values({
    id, tenantId, currency: "NGN",
    availableBalance: "0", escrowBalance: "0",
    totalEarned: "0", totalWithdrawn: "0",
    custodyMode: "psp", isActive: true,
    createdAt: new Date(), updatedAt: new Date(),
  }).onConflictDoNothing();
  const [created] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantId));
  return created!;
}

/**
 * Pay a wholesale PO early with the supplier's configured discount.
 * One DB transaction: claim-first guarded UPDATE (discount_applied false→
 * true, status payable, deadline open) → locked conditional wallet debit of
 * the DISCOUNTED amount from the buyer → supplier wallet credited the same
 * discounted amount (their terms, honestly) → order → 'paid'. Any failure
 * rolls the whole thing back, so a claim can never strand without payment.
 */
export async function earlyPayWholesaleOrderTx(
  db: DbHandle,
  args: { buyerTenantId: string; orderId: string },
): Promise<EarlyPayResult> {
  const [order] = await db.select().from(wholesaleOrders).where(eq(wholesaleOrders.id, args.orderId)).limit(1);
  if (!order || order.buyerTenantId !== args.buyerTenantId) return { ok: false, reason: "not_found" };
  if (order.discountApplied) return { ok: false, reason: "already_claimed" };
  if (!["pending", "confirmed"].includes(order.status)) return { ok: false, reason: "not_payable" };
  // STORED early_pay_deadline is authoritative (same value the claim guard
  // checks in SQL inside the transaction below).
  const hasTerms = (order.discountBps ?? 0) > 0 && order.earlyPayDeadline != null;
  if (!hasTerms) return { ok: false, reason: "no_terms" };
  if (order.earlyPayDeadline!.getTime() <= Date.now()) return { ok: false, reason: "window_expired" };
  const saveCents = Math.round((order.totalCents * order.discountBps!) / 10_000);
  const t = { saveCents, payableCents: order.totalCents - saveCents };

  const buyerWallet = await getOrCreateWalletLocal(db, args.buyerTenantId);
  const supplierWallet = await getOrCreateWalletLocal(db, order.tenantId);
  const debitRef = `earlypay:${order.id}`;
  const creditRef = `earlypay:${order.id}:supplier`;
  const walletTxId = randomUUID();
  const supplierTxId = randomUUID();
  const payableMajor = (t.payableCents / 100).toFixed(2);

  try {
    const finalOrder = await db.transaction(async (tx: any) => {
      // 1. Claim-first: exactly one early pay can ever win this guard.
      const claimed = await tx
        .update(wholesaleOrders)
        .set({ discountApplied: true, discountCents: t.saveCents, updatedAt: new Date() })
        .where(and(
          eq(wholesaleOrders.id, order.id),
          eq(wholesaleOrders.buyerTenantId, args.buyerTenantId),
          eq(wholesaleOrders.discountApplied, false),
          sql`${wholesaleOrders.status} IN ('pending','confirmed')`,
          sql`${wholesaleOrders.earlyPayDeadline} IS NOT NULL AND ${wholesaleOrders.earlyPayDeadline} > now()`,
        ))
        .returning();
      if (claimed.length !== 1) {
        throw Object.assign(new Error("early-pay claim lost (already applied, not payable, or window expired)"), { code: "CONFLICT" });
      }

      // 2. Locked buyer wallet + conditional debit of the discounted amount.
      const lockedBuyer = await tx.execute(sql`SELECT available_balance, currency FROM merchant_wallets WHERE id = ${buyerWallet.id} FOR UPDATE`);
      if (!(lockedBuyer as unknown as Record<string, unknown>[])[0]) throw new Error("buyer wallet not found");
      const debited = await tx.execute(sql`
        UPDATE merchant_wallets
        SET available_balance = available_balance - ${payableMajor}::numeric,
            total_withdrawn = total_withdrawn + ${payableMajor}::numeric,
            updated_at = now()
        WHERE id = ${buyerWallet.id}
          AND available_balance >= ${payableMajor}::numeric
        RETURNING available_balance
      `);
      const drow = (debited as unknown as Record<string, unknown>[])[0];
      if (!drow) {
        throw Object.assign(new Error("INSUFFICIENT_FUNDS: buyer wallet cannot cover the discounted amount"), { code: "INSUFFICIENT_FUNDS" });
      }
      const buyerAfter = parseFloat(String(drow.available_balance));
      const buyerBefore = buyerAfter + t.payableCents / 100;
      await tx.insert(walletTransactions).values({
        id: walletTxId,
        walletId: buyerWallet.id,
        tenantId: args.buyerTenantId,
        type: "wholesale_trade",
        amount: payableMajor,
        balanceBefore: buyerBefore.toFixed(2),
        balanceAfter: buyerAfter.toFixed(2),
        currency: order.currency,
        description: `Early payment for wholesale order ${order.id} (saved ${formatMajor(t.saveCents, order.currency)})`,
        reference: debitRef,
        metadata: { status: "executed", source: "wholesale_early_pay", orderId: order.id, saveCents: t.saveCents, grossCents: order.totalCents },
        createdAt: new Date(),
      });

      // 3. Supplier credited the discounted amount — their configured terms.
      const lockedSupplier = await tx.execute(sql`SELECT available_balance FROM merchant_wallets WHERE id = ${supplierWallet.id} FOR UPDATE`);
      if (!(lockedSupplier as unknown as Record<string, unknown>[])[0]) throw new Error("supplier wallet not found");
      const credited = await tx.execute(sql`
        UPDATE merchant_wallets
        SET available_balance = available_balance + ${payableMajor}::numeric,
            total_earned = total_earned + ${payableMajor}::numeric,
            updated_at = now()
        WHERE id = ${supplierWallet.id}
        RETURNING available_balance
      `);
      const crow = (credited as unknown as Record<string, unknown>[])[0];
      const supplierAfter = parseFloat(String(crow.available_balance));
      const supplierBefore = supplierAfter - t.payableCents / 100;
      await tx.insert(walletTransactions).values({
        id: supplierTxId,
        walletId: supplierWallet.id,
        tenantId: order.tenantId,
        type: "wholesale_trade",
        amount: payableMajor,
        balanceBefore: supplierBefore.toFixed(2),
        balanceAfter: supplierAfter.toFixed(2),
        currency: order.currency,
        description: `Early payment received for wholesale order ${order.id} (discount ${formatMajor(t.saveCents, order.currency)} per your terms)`,
        reference: creditRef,
        metadata: { status: "executed", source: "wholesale_early_pay_credit", orderId: order.id, discountCents: t.saveCents },
        createdAt: new Date(),
      });

      // 4. Order paid honestly at the discounted amount.
      const [paid] = await tx
        .update(wholesaleOrders)
        .set({ status: "paid", updatedAt: new Date() })
        .where(and(eq(wholesaleOrders.id, order.id), eq(wholesaleOrders.discountApplied, true)))
        .returning();
      if (!paid) throw new Error("order status flip lost claim — rolling back");
      return paid as WholesaleOrder;
    });
    return {
      ok: true,
      order: finalOrder,
      chargedCents: t.payableCents,
      saveCents: t.saveCents,
      supplierCreditedCents: t.payableCents,
      walletTxId,
    };
  } catch (err: any) {
    if (err?.code === "INSUFFICIENT_FUNDS") return { ok: false, reason: "insufficient_funds" };
    if (err?.code === "CONFLICT" || err?.code === "23505") {
      // Double-tap: the claim guard (or the wallet_ref unique index backstop)
      // rejected the second attempt — the first payment stands, exactly once.
      const [cur] = await db.select().from(wholesaleOrders).where(eq(wholesaleOrders.id, order.id)).limit(1);
      if (cur?.discountApplied) return { ok: false, reason: "already_claimed" };
      if (!cur || !["pending", "confirmed"].includes(cur.status)) return { ok: false, reason: "not_payable" };
      return { ok: false, reason: "window_expired" };
    }
    throw err;
  }
}
// === END W32 earlypay-fx (wholesale early-pay) ===
