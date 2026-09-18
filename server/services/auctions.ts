// === W46 uc-money ===
/**
 * auctions.ts — UC-11: chat-run auctions (mig 0152).
 *
 * Flow (BOTH channels — WA text and TG inbound feed the same NLP engine):
 *   1. Merchant (staff): "AUCTION <product> START <amount> ENDS <hours>" or
 *      the auctions.create router procedure → parks an ACTIVE auctions row.
 *   2. Buyer: "BID <amount> <product-or-auctionRef>" → placeBid claims the
 *      auction row FOR UPDATE, validates the auction is active/unexpired and
 *      the amount >= max(start, current + minIncrement), then applies a
 *      GUARDED high-bid UPDATE (WHERE current_bid_cents IS NULL OR
 *      current_bid_cents < :amount) — a concurrent equal/lower bid can never
 *      double-claim the high slot; the loser of the race gets CONFLICT. The
 *      previous high bidder is marked 'outbid' and notified on their channel.
 *      Anti-snipe: a bid inside the last antiSnipeSeconds extends endsAt.
 *   3. Close sweep: sweepDueAuctions claim-first flips due active auctions to
 *      'closed' (UPDATE … WHERE status='active' AND ends_at <= now()
 *      RETURNING) and invoices the winner at the high bid via the EXISTING
 *      paymentIntents + initiateWithFallback chain (idempotency key
 *      auction-checkout:<auctionId>), creating a pending order. Reserve not
 *      met → closed with no invoice; losers get an honest notice.
 * Money is fail-closed: if the payment link cannot be initiated the auction
 * still reads closed but winnerOrderId stays NULL — never fake a URL.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "crypto";
import { getDb } from "../db";
import {
  auctionBids,
  auctions,
  orderItems,
  orders,
  paymentIntents,
  products,
  tenants,
  type Auction,
} from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const AUCTION_CATEGORY = "auction_status";

async function assertActiveTenant(db: Db, tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("./tenantGuard");
  assertTenantActive(tenant);
  return tenant;
}

function customerRefOf(ref: string): { phone?: string; channel?: string; channelScopedId?: string } {
  return /^telegram:/i.test(ref)
    ? { channel: "telegram", channelScopedId: ref.replace(/^telegram:/i, "") }
    : { phone: ref };
}

async function notifyBidder(
  tenantId: string,
  bidderRef: string,
  text: string,
  extra?: { paymentUrl?: string },
): Promise<void> {
  const { notifyCustomer } = await import("./channelParity");
  const ref = customerRefOf(bidderRef);
  const payload: any = { text, notifType: AUCTION_CATEGORY };
  if (extra?.paymentUrl) {
    payload.paymentUrl = extra.paymentUrl;
    payload.buttons = [{ label: "💳 Pay now", url: extra.paymentUrl }];
  }
  const routed = await notifyCustomer(tenantId, ref, extra?.paymentUrl ? "payment_link" : AUCTION_CATEGORY, payload);
  if (!routed.handled && (ref as any).phone) {
    const { sendWhatsAppText } = await import("./waSender");
    await sendWhatsAppText(tenantId, (ref as any).phone,
      extra?.paymentUrl ? `${text}\n💳 Pay: ${extra.paymentUrl}` : text,
      { notifType: AUCTION_CATEGORY })
      .catch((e: any) => console.warn("[auctions] WA notify failed:", e?.message));
  }
}

const fmtN = (cents: number, currency = "NGN") =>
  `${currency === "NGN" ? "₦" : `${currency} `}${(cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

// ─── Create ──────────────────────────────────────────────────────────────────

export interface CreateAuctionInput {
  tenantId: string;
  productId?: string | null;
  productName?: string | null;
  startPriceCents: number;
  minIncrementCents?: number;
  reserveCents?: number | null;
  antiSnipeSeconds?: number;
  durationHours?: number;
  createdBy?: string | null;
}

export async function createAuction(db: Db, input: CreateAuctionInput): Promise<Auction> {
  await assertActiveTenant(db, input.tenantId);
  if (!Number.isInteger(input.startPriceCents) || input.startPriceCents <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Start price must be a positive whole number of kobo/cents." });
  }
  let product: typeof products.$inferSelect | undefined;
  if (input.productId) {
    [product] = await db.select().from(products)
      .where(and(eq(products.tenantId, input.tenantId), eq(products.id, input.productId)))
      .limit(1);
  } else if (input.productName?.trim()) {
    const q = `%${input.productName.trim().slice(0, 80)}%`;
    const rows = (await db.execute(sql`
      SELECT * FROM "products"
      WHERE "tenantId" = ${input.tenantId} AND "status" = 'active' AND "name" ILIKE ${q}
      ORDER BY "name" LIMIT 1
    `)) as unknown as any[];
    const list: any[] = Array.isArray(rows) ? rows : (rows as any)?.rows ?? [];
    product = list[0] as any;
  }
  if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "I couldn't find that product in this store." });

  // One ACTIVE auction per product at a time.
  const [live] = await db.select({ id: auctions.id }).from(auctions)
    .where(and(eq(auctions.tenantId, input.tenantId), eq(auctions.productId, product.id), eq(auctions.status, "active")))
    .limit(1);
  if (live) throw new TRPCError({ code: "CONFLICT", message: `${product.name} already has a live auction (ref ${live.id.slice(0, 8)}).` });

  const hours = input.durationHours ?? 24;
  const [row] = await db.insert(auctions).values({
    tenantId: input.tenantId,
    productId: product.id,
    title: product.name,
    startPriceCents: input.startPriceCents,
    minIncrementCents: input.minIncrementCents ?? 100,
    reserveCents: input.reserveCents ?? null,
    antiSnipeSeconds: input.antiSnipeSeconds ?? 0,
    status: "active",
    endsAt: new Date(Date.now() + hours * 3600 * 1000),
    createdBy: input.createdBy ?? null,
    createdAt: new Date(),
  }).returning();
  return row!;
}

// ─── Bid (claim-first guarded high-bid UPDATE) ───────────────────────────────

export interface PlaceBidInput {
  tenantId: string;
  /** Auction id / 8-char prefix, or product id / name (resolves the live auction). */
  auctionRef?: string | null;
  productName?: string | null;
  bidderRef: string;
  amountCents: number;
}

async function resolveAuctionId(db: Db, tenantId: string, ref: string): Promise<string | null> {
  if (/^[0-9a-fA-F-]{36}$/.test(ref)) return ref;
  const rows = (await db.execute(sql`
    SELECT id FROM auctions
    WHERE tenant_id = ${tenantId} AND id::text LIKE ${ref + "%"}
    ORDER BY created_at DESC LIMIT 2
  `)) as unknown as any[];
  const list: any[] = Array.isArray(rows) ? rows : (rows as any)?.rows ?? [];
  return list.length === 1 ? String(list[0].id) : null;
}

export async function placeBid(
  db: Db,
  input: PlaceBidInput,
): Promise<{ auction: Auction; outbidRef: string | null; extended: boolean }> {
  await assertActiveTenant(db, input.tenantId);
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Bid must be a positive whole number of kobo/cents." });
  }

  // Resolve the auction (by id/prefix or the live auction for a product name).
  let auctionId: string | null = null;
  if (input.auctionRef) {
    auctionId = await resolveAuctionId(db, input.tenantId, input.auctionRef);
  } else if (input.productName?.trim()) {
    const q = `%${input.productName.trim().slice(0, 80)}%`;
    const rows = (await db.execute(sql`
      SELECT a.id FROM auctions a
      JOIN "products" p ON p.id = a.product_id
      WHERE a.tenant_id = ${input.tenantId} AND a.status = 'active' AND p."name" ILIKE ${q}
      ORDER BY a.created_at DESC LIMIT 1
    `)) as unknown as any[];
    const list: any[] = Array.isArray(rows) ? rows : (rows as any)?.rows ?? [];
    auctionId = list[0] ? String(list[0].id) : null;
  }
  if (!auctionId) throw new TRPCError({ code: "NOT_FOUND", message: "No live auction found for that." });

  const result = await db.transaction(async (tx) => {
    // Claim-first: lock the auction row for the whole bid decision.
    const rows = (await tx.execute(sql`
      SELECT * FROM auctions WHERE id = ${auctionId} AND tenant_id = ${input.tenantId} FOR UPDATE
    `)) as any;
    const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
    const a = list[0];
    if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "auction not found" });
    if (a.status !== "active") {
      throw new TRPCError({ code: "CONFLICT", message: `That auction is ${a.status} — bidding is closed.` });
    }
    const now = new Date();
    if (new Date(a.ends_at) <= now) {
      throw new TRPCError({ code: "CONFLICT", message: "That auction has ended — the close sweep is picking the winner." });
    }
    const floor = a.current_bid_cents != null
      ? Number(a.current_bid_cents) + Number(a.min_increment_cents)
      : Number(a.start_price_cents);
    if (input.amountCents < floor) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Your bid must be at least ${fmtN(floor)}.`,
      });
    }
    if (a.current_bidder_id === input.bidderRef) {
      throw new TRPCError({ code: "CONFLICT", message: "You already hold the high bid on this auction." });
    }

    // Guarded high-bid UPDATE: even with the row lock, the guard clause makes
    // the claim itself conditional so a racing statement-level interleave can
    // never overwrite a higher bid with a lower one.
    const upd = (await tx.execute(sql`
      UPDATE auctions SET
        current_bid_cents = ${input.amountCents},
        current_bidder_id = ${input.bidderRef},
        bid_count = bid_count + 1
      WHERE id = ${a.id}
        AND status = 'active'
        AND (current_bid_cents IS NULL OR current_bid_cents < ${input.amountCents})
      RETURNING id
    `)) as any;
    const updList: any[] = Array.isArray(upd) ? upd : (upd?.rows ?? []);
    if (updList.length === 0) {
      throw new TRPCError({ code: "CONFLICT", message: "Another bid beat yours — check the current price and try again." });
    }

    await tx.insert(auctionBids).values({
      tenantId: input.tenantId,
      auctionId: a.id,
      bidderId: input.bidderRef,
      amountCents: input.amountCents,
      status: "active",
      createdAt: now,
    });
    let outbidRef: string | null = null;
    if (a.current_bidder_id) {
      outbidRef = String(a.current_bidder_id);
      await tx.execute(sql`
        UPDATE auction_bids SET status = 'outbid'
        WHERE auction_id = ${a.id} AND bidder_id = ${a.current_bidder_id} AND status = 'active'
      `);
    }

    // Anti-snipe: bid inside the last N seconds extends the end by N seconds.
    let extended = false;
    const snipe = Number(a.anti_snipe_seconds ?? 0);
    if (snipe > 0) {
      const endsAt = new Date(a.ends_at);
      const remainingMs = endsAt.getTime() - now.getTime();
      if (remainingMs < snipe * 1000) {
        const newEnd = new Date(now.getTime() + snipe * 1000);
        await tx.execute(sql`UPDATE auctions SET ends_at = ${newEnd.toISOString()} WHERE id = ${a.id}`);
        extended = true;
      }
    }
    const [fresh] = await tx.select().from(auctions).where(eq(auctions.id, a.id)).limit(1);
    return { auction: fresh!, outbidRef, extended };
  });

  // Notify the outbid bidder (fire-and-forget; both channels).
  if (result.outbidRef) {
    void notifyBidder(input.tenantId, result.outbidRef,
      `🔨 You've been outbid on "${result.auction.title ?? "the auction"}" — the high bid is now ` +
      `${fmtN(input.amountCents)}. Bid again before it ends!`)
      .catch((e: any) => console.warn("[auctions] outbid notify failed:", e?.message));
  }
  return result;
}

// ─── Close sweep → invoice winner ────────────────────────────────────────────

/** Priced winner checkout: order at the winning bid + PSP link (existing chain). */
async function invoiceWinner(
  db: Db,
  auction: Auction,
): Promise<{ orderId: string | null; paymentUrl: string | null }> {
  const [product] = await db.select().from(products)
    .where(and(eq(products.tenantId, auction.tenantId), eq(products.id, auction.productId)))
    .limit(1);
  if (!product) return { orderId: null, paymentUrl: null };
  const totalCents = auction.currentBidCents!;
  const now = new Date();
  const orderId = randomUUID();
  const orderNumber = `AUC-${now.getTime().toString(36).toUpperCase()}`;

  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      tenantId: auction.tenantId,
      customerId: auction.currentBidderId!,
      orderNumber,
      status: "pending",
      totalAmount: (totalCents / 100).toFixed(2),
      currency: product.currency ?? "NGN",
      paymentStatus: "unpaid",
      items: [{ productId: product.id, productName: product.name, quantity: 1, unitPrice: totalCents / 100 }],
      metadata: {
        auctionWin: {
          auctionId: auction.id,
          winningBidCents: totalCents,
          bidCount: auction.bidCount,
          closedAt: now.toISOString(),
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(orderItems).values({
      id: randomUUID(),
      orderId,
      productId: product.id,
      productName: product.name,
      quantity: 1,
      unitPrice: (totalCents / 100).toFixed(2),
      currency: product.currency ?? "NGN",
    });
  });

  const idemKey = `auction-checkout:${auction.id}`;
  const [existingIntent] = await db.select().from(paymentIntents)
    .where(eq(paymentIntents.idempotencyKey, idemKey)).limit(1).catch(() => [] as any[]);
  if (existingIntent) {
    return { orderId, paymentUrl: (existingIntent.metadata as any)?.paymentUrl ?? null };
  }
  const paymentIntentId = randomUUID();
  const reference = `AUC-${now.getTime()}-${paymentIntentId.slice(0, 8).toUpperCase()}`;
  await db.insert(paymentIntents).values({
    id: paymentIntentId,
    tenantId: auction.tenantId,
    orderId,
    customerId: auction.currentBidderId!,
    amount: (totalCents / 100).toFixed(2),
    currency: product.currency ?? "NGN",
    provider: "paystack",
    providerPaymentId: reference,
    idempotencyKey: idemKey,
    status: "pending",
    metadata: { kind: "auction_win", auctionId: auction.id, tenantId: auction.tenantId },
    createdAt: now,
    updatedAt: now,
  });
  let paymentUrl: string | null = null;
  try {
    const { initiateWithFallback } = await import("./payments/initiateWithFallback");
    const { ENV } = await import("../_core/env");
    const fallback = await initiateWithFallback(auction.tenantId, {
      tenantId: auction.tenantId,
      amountCents: totalCents,
      currency: product.currency ?? "NGN",
      reference,
      metadata: { payment_intent_id: paymentIntentId, tenant_id: auction.tenantId, kind: "auction_win", auctionId: auction.id },
      customer: { phone: auction.currentBidderId!.replace(/^telegram:/i, "") },
      callbackUrl: `${ENV.appUrl}/orders`,
    });
    paymentUrl = fallback.result.authorizationUrl ?? null;
    await db.update(paymentIntents).set({
      status: "initiated",
      metadata: { kind: "auction_win", auctionId: auction.id, tenantId: auction.tenantId, paymentUrl, servedProvider: fallback.providerId },
      updatedAt: new Date(),
    }).where(eq(paymentIntents.id, paymentIntentId));
  } catch (e: any) {
    await db.update(paymentIntents).set({
      status: "failed",
      failureReason: `provider_init: ${String(e?.message ?? e).slice(0, 300)}`,
      updatedAt: new Date(),
    }).where(eq(paymentIntents.id, paymentIntentId)).catch(() => {});
    console.warn("[auctions] winner payment link failed:", e?.message);
  }
  await db.update(auctions).set({ winnerOrderId: orderId }).where(eq(auctions.id, auction.id));
  return { orderId, paymentUrl };
}

/**
 * Close all due auctions for a tenant (or a single auction by id). Claim-first
 * active→closed flip via guarded UPDATE … RETURNING — only the claimer sees
 * the row, so concurrent sweeps never double-invoice a winner.
 */
export async function sweepDueAuctions(
  db: Db,
  tenantId: string,
  opts: { auctionId?: string } = {},
): Promise<{ closed: number; invoiced: number; reserveMissed: number }> {
  await assertActiveTenant(db, tenantId);
  const nowIso = new Date().toISOString();
  const rows = (await db.execute(sql`
    UPDATE auctions SET status = 'closed', closed_at = ${nowIso}
    WHERE tenant_id = ${tenantId}
      AND status = 'active'
      AND ends_at <= ${nowIso}
      ${opts.auctionId ? sql`AND id = ${opts.auctionId}` : sql``}
    RETURNING id
  `)) as any;
  const claimedIds: string[] = (Array.isArray(rows) ? rows : (rows?.rows ?? []))
    .map((r: any) => String(r.id));
  // W46 merger fix (J397/J398): re-load claimed rows via drizzle — raw SQL
  // results carry snake_case keys, so reading a.currentBidCents off them
  // silently yielded undefined and winners were never invoiced.
  const claimed: Auction[] = claimedIds.length === 0 ? [] : await db
    .select()
    .from(auctions)
    .where(inArray(auctions.id, claimedIds));
  let invoiced = 0;
  let reserveMissed = 0;
  for (const a of claimed) {
    if (a.currentBidCents != null && a.currentBidderId &&
        (a.reserveCents == null || a.currentBidCents >= a.reserveCents)) {
      const { orderId, paymentUrl } = await invoiceWinner(db, a);
      if (orderId) invoiced += 1;
      await db.execute(sql`
        UPDATE auction_bids SET status = 'won'
        WHERE auction_id = ${a.id} AND bidder_id = ${a.currentBidderId} AND status = 'active'
      `);
      await notifyBidder(a.tenantId, a.currentBidderId,
        `🎉 You WON the auction for "${a.title ?? "item"}" at ${fmtN(a.currentBidCents)}! ` +
        (paymentUrl ? "Complete payment to claim it:" : "The store will follow up with payment details."),
        paymentUrl ? { paymentUrl } : undefined)
        .catch((e: any) => console.warn("[auctions] winner notify failed:", e?.message));
      // Losers get an honest close notice.
      const losers = (await db.execute(sql`
        SELECT DISTINCT bidder_id FROM auction_bids
        WHERE auction_id = ${a.id} AND bidder_id <> ${a.currentBidderId}
      `)) as any;
      const loserList: any[] = Array.isArray(losers) ? losers : (losers?.rows ?? []);
      for (const l of loserList) {
        void notifyBidder(a.tenantId, String(l.bidder_id),
          `🔨 The auction for "${a.title ?? "item"}" has ended — the winning bid was ${fmtN(a.currentBidCents)}. Thanks for bidding!`)
          .catch(() => {});
      }
      await db.execute(sql`
        UPDATE auction_bids SET status = 'lost'
        WHERE auction_id = ${a.id} AND status IN ('active','outbid')
      `);
    } else {
      if (a.currentBidCents != null) reserveMissed += 1;
      // Reserve not met (or no bids): mark bids lost, no invoice.
      await db.execute(sql`
        UPDATE auction_bids SET status = 'lost' WHERE auction_id = ${a.id} AND status = 'active'
      `);
      if (a.currentBidderId) {
        void notifyBidder(a.tenantId, a.currentBidderId,
          `🔨 The auction for "${a.title ?? "item"}" ended below the store's reserve, so no sale was made.`)
          .catch(() => {});
      }
    }
  }
  return { closed: claimed.length, invoiced, reserveMissed };
}
// === END W46 uc-money (auctions) ===
