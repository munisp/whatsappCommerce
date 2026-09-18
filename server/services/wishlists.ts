// === W46 uc-ux (Coder E): UC-23 — wishlists + price-drop alerts ===
/**
 * wishlists.ts — "save this" / "my list" buyer wishlist.
 *
 * Chat intents are parsed in the SHARED nlp engine (routers/nlp.ts banner
 * block), so both WhatsApp and Telegram buyers get the same grammar:
 *   SAVE <product>               → saveToWishlist (catalog match)
 *   MY LIST                      → listWishlist rendering
 *   REMOVE <n>                   → removeWishlistEntry (by list position)
 *
 * Price-drop sweep (sweepWishlistPriceDrops, cron route
 * /api/scheduled/wishlist-price-drop-sweep): for every wishlist row whose
 * product's CURRENT price is below the stored lastPriceCents, notify the
 * buyer once per drop (claim-first baseline flip) on BOTH channels via the
 * price_drop_alert parity category. Idempotent — a replay with no price
 * change notifies nobody.
 */

import { and, eq, sql } from "drizzle-orm";
import { products, wishlists } from "../../drizzle/schema";
import { sendCustomerText } from "./channelParity";
import { toMinorUnitsExact } from "../../shared/escrowAmounts";

type Db = any;

/** Save a product to the buyer's wishlist (idempotent; baseline price captured). */
export async function saveToWishlist(
  db: Db,
  opts: { tenantId: string; phone: string; productId: string },
): Promise<{ saved: boolean; already: boolean }> {
  const [existing] = await db.select({ id: wishlists.id }).from(wishlists)
    .where(and(
      eq(wishlists.tenantId, opts.tenantId),
      eq(wishlists.phone, opts.phone),
      eq(wishlists.productId, opts.productId),
    )).limit(1);
  if (existing) return { saved: true, already: true };
  const [prod] = await db.select({ price: products.price }).from(products)
    .where(eq(products.id, opts.productId)).limit(1);
  const priceCents = prod ? toMinorUnitsExact(Number(prod.price)) : null;
  await db.insert(wishlists).values({
    tenantId: opts.tenantId,
    phone: opts.phone,
    productId: opts.productId,
    lastPriceCents: priceCents,
  });
  return { saved: true, already: false };
}

/** Buyer wishlist with live product names/prices, in save order. */
export async function listWishlist(
  db: Db,
  opts: { tenantId: string; phone: string },
): Promise<Array<{ id: string; productId: string; name: string; price: string; currency: string }>> {
  const rows = await db.execute(sql`
    SELECT w.id, w.product_id AS "productId", p.name, p.price, p.currency
    FROM wishlists w
    JOIN products p ON p.id = w.product_id
    WHERE w.tenant_id = ${opts.tenantId} AND w.phone = ${opts.phone}
    ORDER BY w.created_at ASC`);
  return (((rows as any).rows ?? rows) as any[]);
}

/** Remove by 1-based list position (chat "REMOVE 2"). */
export async function removeWishlistEntry(
  db: Db,
  opts: { tenantId: string; phone: string; position: number },
): Promise<{ removed: boolean }> {
  const list = await listWishlist(db, opts);
  const target = list[opts.position - 1];
  if (!target) return { removed: false };
  await db.delete(wishlists).where(eq(wishlists.id, target.id));
  return { removed: true };
}

export function formatWishlist(
  list: Array<{ name: string; price: string; currency: string }>,
  fmt: (major: number, currency: string) => string = (m, c) => `${c} ${m.toFixed(2)}`,
): string {
  if (list.length === 0) return "Your wishlist is empty. When you see something you like, reply SAVE <product> and I'll keep it here for you. ❤️";
  const lines = list.map((e, i) => `${i + 1}. ${e.name} — ${fmt(Number(e.price), e.currency)}`);
  return "❤️ *Your wishlist:*\n" + lines.join("\n") + "\nReply REMOVE <number> to drop an item, or order any time.";
}

/**
 * Price-drop sweep. Returns the number of buyers alerted. Each alert is
 * claim-first (guarded UPDATE on the CURRENT baseline), so
 * concurrent/replayed sweeps never double-notify the same drop.
 */
export async function sweepWishlistPriceDrops(
  db: Db,
  opts: { tenantId?: string } = {},
): Promise<{ alerted: number }> {
  // Rows whose live price may be below the stored baseline.
  const dropped = await db.execute(sql`
    SELECT w.id, w.tenant_id AS "tenantId", w.phone, w.last_price_cents AS "lastPriceCents",
           p.id AS "productId", p.name, p.price, p.currency
    FROM wishlists w
    JOIN products p ON p.id = w.product_id
    WHERE w.last_price_cents IS NOT NULL
      AND p.status = 'active'
      AND (${opts.tenantId ?? null}::varchar IS NULL OR w.tenant_id = ${opts.tenantId ?? null})
    `);
  const rows = (((dropped as any).rows ?? dropped) as any[]).filter((r) =>
    toMinorUnitsExact(Number(r.price)) < Number(r.lastPriceCents));
  let alerted = 0;
  for (const r of rows) {
    const newCents = toMinorUnitsExact(Number(r.price));
    // Claim-first: only the worker that flips the CURRENT baseline notifies;
    // replays/concurrent sweeps see the row already moved and skip.
    const claimed = await db.execute(sql`
      UPDATE wishlists
      SET last_price_cents = ${newCents}, notified_at = now()
      WHERE id = ${r.id} AND last_price_cents = ${Number(r.lastPriceCents)}
      RETURNING id`);
    const got = ((claimed as any).rows ?? claimed) as any[];
    if (!got || got.length === 0) continue;
    const drop = Number(r.lastPriceCents) - newCents;
    const body = `🔔 *Price drop!* ${r.name} is now ${r.currency} ${(newCents / 100).toFixed(2)} (was ${r.currency} ${(Number(r.lastPriceCents) / 100).toFixed(2)} — you save ${r.currency} ${(drop / 100).toFixed(2)}). Reply with the product name to order!`;
    try {
      await sendCustomerText(r.tenantId, r.phone, "price_drop_alert", body, { notifType: "wishlist_price_drop" });
      alerted++;
    } catch (e: unknown) {
      console.warn("[wishlists] price-drop notify failed:", (e as Error)?.message);
    }
  }
  return { alerted };
}
// === END W46 uc-ux ===
