// === W46 uc-money (Coder C) ===
/**
 * J398 — UC-11 auction guards: increment floor, self-outbid refusal, expired
 * auction refusal, anti-snipe extension, reserve-not-met closes without an
 * invoice.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J398",
  name: "auction bid guards + anti-snipe + reserve miss",
  feature: "UC-11 auctions (guards)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { createAuction, placeBid, sweepDueAuctions } = await import("../../server/services/auctions");
    const productId = `prod-w46-j398`;
    await world.db.execute(`DELETE FROM products WHERE id = '${productId}'`).catch(() => undefined);
    await world.db.insert(schema.products).values({
      id: productId, tenantId: TENANT_ID, sku: "SIM-W46-J398",
      name: "W46 Auction Reserve Item", price: "12000.00", currency: "NGN",
      status: "active", stockQuantity: 1,
    });

    const bidder = world.newPhone("j398a");
    await world.grantConsent(bidder);

    // ── Anti-snipe auction ──
    const snipe = await createAuction(world.db, {
      tenantId: TENANT_ID, productId, startPriceCents: 1_000_000,
      minIncrementCents: 50_000, antiSnipeSeconds: 300, durationHours: 1,
      createdBy: "j398-merchant",
    });

    // Below the start price → refused.
    let floorBlocked = false;
    try {
      await placeBid(world.db, { tenantId: TENANT_ID, auctionRef: snipe.id, bidderRef: bidder, amountCents: 999_999 });
    } catch (e: any) { floorBlocked = e?.code === "BAD_REQUEST"; }
    assert(floorBlocked, "below-floor bid refused");

    const first = await placeBid(world.db, { tenantId: TENANT_ID, auctionRef: snipe.id, bidderRef: bidder, amountCents: 1_000_000 });
    assert(first.auction.currentBidCents === 1_000_000, "start-price bid accepted");

    // Below current + increment → refused.
    let incBlocked = false;
    const other = world.newPhone("j398b");
    await world.grantConsent(other);
    try {
      await placeBid(world.db, { tenantId: TENANT_ID, auctionRef: snipe.id, bidderRef: other, amountCents: 1_040_000 });
    } catch (e: any) { incBlocked = e?.code === "BAD_REQUEST"; }
    assert(incBlocked, "below-increment bid refused");

    // Same bidder cannot outbid themselves.
    let selfBlocked = false;
    try {
      await placeBid(world.db, { tenantId: TENANT_ID, auctionRef: snipe.id, bidderRef: bidder, amountCents: 2_000_000 });
    } catch (e: any) { selfBlocked = e?.code === "CONFLICT"; }
    assert(selfBlocked, "self-outbid refused");

    // Anti-snipe: force ends_at into the window, bid → end extends.
    await world.db.execute(`UPDATE auctions SET ends_at = now() + interval '60 seconds' WHERE id = '${snipe.id}'`);
    const ext = await placeBid(world.db, { tenantId: TENANT_ID, auctionRef: snipe.id, bidderRef: other, amountCents: 1_100_000 });
    assert(ext.extended, "bid inside anti-snipe window extends the end");
    const [aExt] = await world.db.select().from(schema.auctions).where(eq(schema.auctions.id, snipe.id));
    assert(new Date(aExt.endsAt).getTime() > Date.now() + 200_000, "ends_at extended ~5min out");

    // ── Reserve-not-met auction closes with NO invoice ──
    const productId2 = `prod-w46-j398b`;
    await world.db.execute(`DELETE FROM products WHERE id = '${productId2}'`).catch(() => undefined);
    await world.db.insert(schema.products).values({
      id: productId2, tenantId: TENANT_ID, sku: "SIM-W46-J398B",
      name: "W46 Auction Reserve Two", price: "20000.00", currency: "NGN",
      status: "active", stockQuantity: 1,
    });
    const reserve = await createAuction(world.db, {
      tenantId: TENANT_ID, productId: productId2, startPriceCents: 100_000,
      reserveCents: 5_000_000, durationHours: 1, createdBy: "j398-merchant",
    });
    await placeBid(world.db, { tenantId: TENANT_ID, auctionRef: reserve.id, bidderRef: bidder, amountCents: 100_000 });
    await world.db.execute(`UPDATE auctions SET ends_at = now() - interval '1 minute' WHERE id = '${reserve.id}'`);
    const r = await sweepDueAuctions(world.db, TENANT_ID, { auctionId: reserve.id });
    assert(r.closed === 1 && r.invoiced === 0 && r.reserveMissed === 1, "reserve miss closes without invoice");
    const [aRes] = await world.db.select().from(schema.auctions).where(eq(schema.auctions.id, reserve.id));
    assert(aRes.status === "closed" && aRes.winnerOrderId === null, "no winner order on reserve miss");

    // Bidding on a closed auction is refused.
    let closedBlocked = false;
    try {
      await placeBid(world.db, { tenantId: TENANT_ID, auctionRef: reserve.id, bidderRef: other, amountCents: 9_000_000 });
    } catch (e: any) { closedBlocked = e?.code === "CONFLICT"; }
    assert(closedBlocked, "closed auction refuses bids");

    // Expired-but-unswept auction also refuses bids (lazy expiry guard).
    const productId3 = `prod-w46-j398c`;
    await world.db.execute(`DELETE FROM products WHERE id = '${productId3}'`).catch(() => undefined);
    await world.db.insert(schema.products).values({
      id: productId3, tenantId: TENANT_ID, sku: "SIM-W46-J398C",
      name: "W46 Auction Expired", price: "100.00", currency: "NGN",
      status: "active", stockQuantity: 1,
    });
    const exp = await createAuction(world.db, { tenantId: TENANT_ID, productId: productId3, startPriceCents: 10_000, durationHours: 1 });
    await world.db.execute(`UPDATE auctions SET ends_at = now() - interval '1 minute' WHERE id = '${exp.id}'`);
    let expBlocked = false;
    try {
      await placeBid(world.db, { tenantId: TENANT_ID, auctionRef: exp.id, bidderRef: bidder, amountCents: 10_000 });
    } catch (e: any) { expBlocked = e?.code === "CONFLICT"; }
    assert(expBlocked, "ended auction refuses late bids");
  },
};
