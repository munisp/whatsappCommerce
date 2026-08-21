/**
 * J144 — Verified-only review enforcement: a buyer who has never completed
 * an order is REFUSED when trying to review (WhatsApp RATE command); after
 * their order is delivered the same command creates a published,
 * purchase-verified review; a second RATE updates rather than duplicates;
 * the merchant responds and moderates via the tenant-guarded router; a
 * different phone cannot review the same order.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, tenantCaller } from "./helpers";

async function lastText(world: World, phone: string): Promise<string> {
  return bodyText(world.outbound.lastOfType("text", phone));
}

export const journey: Journey = {
  id: "J144",
  name: "verified-only review enforcement",
  feature: "purchase-verified reviews + moderation",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("rev");
    await world.grantConsent(phone);

    // ── 1. No completed order → review refused ──────────────────────────
    await world.text(phone, "RATE 5 Amazing!");
    await world.waitFor(async () => (await lastText(world, phone)).includes("verified purchases"),
      8000, "unverified review refused");
    let rows = await world.db.select().from(schema.reviews)
      .where(eq(schema.reviews.tenantId, TENANT_ID));
    assert(rows.length === 0, "no review row created without a delivered order");

    // ── 2. Deliver the buyer's order → review accepted ──────────────────
    const order = await createChatOrderViaNlp(world, phone, {
      items: [{ product: "Jollof Rice", quantity: 1 }],
      fulfillment: "pickup",
    });
    await world.db.update(schema.orders)
      .set({ status: "delivered", updatedAt: new Date() })
      .where(eq(schema.orders.id, order.orderId));

    await world.text(phone, "RATE 5 Great jollof, fast pickup!");
    await world.waitFor(async () => (await lastText(world, phone)).includes("5-star review"),
      8000, "verified review accepted");
    rows = await world.db.select().from(schema.reviews)
      .where(and(eq(schema.reviews.tenantId, TENANT_ID), eq(schema.reviews.orderId, order.orderId)));
    assert(rows.length === 1, "exactly one review row");
    assert(rows[0].rating === 5 && rows[0].status === "published", "review published with rating");
    assert(rows[0].customerPhone === phone, "review bound to the verified buyer");

    // ── 3. Re-rating updates the same review (no stacking) ──────────────
    await world.text(phone, "RATE 4 Actually, a bit salty");
    await world.waitFor(async () => (await lastText(world, phone)).includes("4-star review"),
      8000, "re-rate accepted");
    rows = await world.db.select().from(schema.reviews)
      .where(and(eq(schema.reviews.tenantId, TENANT_ID), eq(schema.reviews.orderId, order.orderId)));
    assert(rows.length === 1 && rows[0].rating === 4, "re-rate updated in place, no duplicate");

    // ── 4. Merchant responds + moderates via the guarded router ─────────
    const tenant = await tenantCaller(TENANT_ID);
    const responded = await tenant.reviews.respond({
      tenantId: TENANT_ID, reviewId: rows[0].id, response: "Sorry about the salt — next one's on us!",
    });
    assert(responded.merchantResponse?.includes("next one"), "merchant response stored");
    const summary = await tenant.reviews.summary({ tenantId: TENANT_ID });
    assert(summary.count === 1 && summary.avg === 4, "aggregate reflects the updated rating");
    const flagged = await tenant.reviews.moderate({ tenantId: TENANT_ID, reviewId: rows[0].id, status: "flagged" });
    assert(flagged.status === "flagged", "moderation flag applied");
    const afterFlag = await tenant.reviews.summary({ tenantId: TENANT_ID });
    assert(afterFlag.count === 0, "flagged reviews drop out of the aggregate");
    await tenant.reviews.moderate({ tenantId: TENANT_ID, reviewId: rows[0].id, status: "published" });

    // ── 5. A stranger cannot review that order ──────────────────────────
    const stranger = world.newPhone("stranger");
    await world.grantConsent(stranger);
    await world.text(stranger, "RATE 1 terrible");
    await world.waitFor(async () => (await lastText(world, stranger)).includes("verified purchases"),
      8000, "stranger review refused");
    rows = await world.db.select().from(schema.reviews)
      .where(eq(schema.reviews.tenantId, TENANT_ID));
    assert(rows.length === 1, "stranger could not add a review");
  },
};
