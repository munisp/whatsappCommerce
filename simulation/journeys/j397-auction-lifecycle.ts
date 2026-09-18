// === W46 uc-money (Coder C) ===
/**
 * J397 — UC-11 auction lifecycle: create → bids (claim-first high-bid) →
 * close sweep invoices the winner via the existing paymentIntents chain;
 * sweep is idempotent (second run closes nothing).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J397",
  name: "auction lifecycle: bid, close sweep, winner invoice",
  feature: "UC-11 auctions",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { createAuction, placeBid, sweepDueAuctions } = await import("../../server/services/auctions");
    const productId = `prod-w46-j397`;
    await world.db.execute(`DELETE FROM products WHERE id = '${productId}'`).catch(() => undefined);
    await world.db.insert(schema.products).values({
      id: productId, tenantId: TENANT_ID, sku: "SIM-W46-J397",
      name: "W46 Auction Ankara", price: "9000.00", currency: "NGN",
      status: "active", stockQuantity: 1,
    });

    const auction = await createAuction(world.db, {
      tenantId: TENANT_ID, productId, startPriceCents: 500_000, durationHours: 1,
      createdBy: "j397-merchant",
    });
    assert(auction.status === "active", "auction created active");

    // Duplicate live auction for the same product is refused.
    let dupBlocked = false;
    try {
      await createAuction(world.db, { tenantId: TENANT_ID, productId, startPriceCents: 100 });
    } catch (e: any) { dupBlocked = e?.code === "CONFLICT"; }
    assert(dupBlocked, "one live auction per product");

    const bidderA = world.newPhone("j397a");
    const bidderB = world.newPhone("j397b");
    await world.grantConsent(bidderA);
    await world.grantConsent(bidderB);

    const b1 = await placeBid(world.db, { tenantId: TENANT_ID, auctionRef: auction.id, bidderRef: bidderA, amountCents: 500_000 });
    assert(b1.auction.currentBidCents === 500_000 && b1.outbidRef === null, "first bid at start price");
    const b2 = await placeBid(world.db, { tenantId: TENANT_ID, auctionRef: auction.id, bidderRef: bidderB, amountCents: 510_000 });
    assert(b2.auction.currentBidCents === 510_000 && b2.outbidRef === bidderA, "higher bid outbids");

    const [bidA] = await world.db.select().from(schema.auctionBids)
      .where(eq(schema.auctionBids.bidderId, bidderA));
    assert(bidA.status === "outbid", "previous high bid flipped to outbid");
    const [aNow] = await world.db.select().from(schema.auctions).where(eq(schema.auctions.id, auction.id));
    assert(aNow.bidCount === 2, "bid count tracked");

    // Close sweep: force due, sweep claims + invoices winner B.
    await world.db.execute(`UPDATE auctions SET ends_at = now() - interval '1 minute' WHERE id = '${auction.id}'`);
    const r1 = await sweepDueAuctions(world.db, TENANT_ID, {});
    assert(r1.closed >= 1 && r1.invoiced >= 1, "sweep closed + invoiced");

    const [closed] = await world.db.select().from(schema.auctions).where(eq(schema.auctions.id, auction.id));
    assert(closed.status === "closed" && closed.winnerOrderId, "auction closed with winner order");
    const [won] = await world.db.select().from(schema.auctionBids).where(eq(schema.auctionBids.bidderId, bidderB));
    assert(won.status === "won", "winning bid marked won");

    const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, closed.winnerOrderId!));
    assert(ord && ord.customerId === bidderB, "winner order belongs to high bidder");
    assert(Number(ord.totalAmount) === 5100, "order total == winning bid");
    assert((ord.metadata as any)?.auctionWin?.auctionId === auction.id, "order carries auction snapshot");

    const intents = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.idempotencyKey, `auction-checkout:${auction.id}`));
    assert(intents.length === 1, "winner payment intent minted once");

    // Idempotent sweep: nothing left to close.
    const r2 = await sweepDueAuctions(world.db, TENANT_ID, {});
    assert(r2.closed === 0 && r2.invoiced === 0, "second sweep is a no-op");
  },
};
