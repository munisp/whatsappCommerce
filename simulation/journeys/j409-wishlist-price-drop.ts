// === W46 uc-ux (Coder E) ===
/**
 * J409 — UC-23: wishlist save/list/remove + price-drop sweep notifies the
 * buyer once per drop (claim-first baseline flip → replays notify nobody).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedCartWithProduct } from "./w46-uc-ux-seed";

export const journey: Journey = {
  id: "J409",
  name: "wishlist save/list/remove + price-drop alert sweep",
  feature: "UC-23 wishlists + chat intents + price-drop sweep",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/wishlists");
    const phone = world.newPhone("j409");
    await world.grantConsent(phone);
    const { productId } = await seedCartWithProduct(world, "j409", phone, { unitPrice: "5000.00" });

    // ── save this / my list / remove ──
    const save = await svc.saveToWishlist(world.db, { tenantId: TENANT_ID, phone, productId });
    assert(save.saved && !save.already, "first save persists");
    const dupe = await svc.saveToWishlist(world.db, { tenantId: TENANT_ID, phone, productId });
    assert(dupe.already === true, "duplicate save is idempotent");
    const list = await svc.listWishlist(world.db, { tenantId: TENANT_ID, phone });
    assert(list.length === 1 && list[0].productId === productId, "my list returns the saved product");
    const text = svc.formatWishlist(list);
    assert(text.includes("Your wishlist") && text.includes("W46 Product j409"), "wishlist text rendered");
    // Baseline price captured at save time (₦5,000 → 500000 kobo; integer cents).
    const [row0] = await world.db.select().from(schema.wishlists)
      .where(eq(schema.wishlists.productId, productId));
    assert(Number(row0.lastPriceCents) === 500000, `baseline captured in integer cents (got ${row0.lastPriceCents})`);

    // ── price-drop sweep ──
    await world.db.update(schema.products).set({ price: "4000.00" }).where(eq(schema.products.id, productId));
    world.outbound.reset();
    const sweep1 = await svc.sweepWishlistPriceDrops(world.db);
    assert(sweep1.alerted >= 1, "sweep alerts on the price drop");
    const alerts = world.outbound.findByBody("Price drop", phone);
    assert(alerts.length >= 1, "buyer received the price-drop alert on their channel");
    const [row1] = await world.db.select().from(schema.wishlists).where(eq(schema.wishlists.id, row0.id));
    assert(Number(row1.lastPriceCents) === 400000 && row1.notifiedAt, "baseline refreshed + notifiedAt stamped");
    // Replay with no further drop: nobody notified.
    const sweep2 = await svc.sweepWishlistPriceDrops(world.db);
    assert(sweep2.alerted === 0, "replay sweep is idempotent");

    // ── remove by list position ──
    const bad = await svc.removeWishlistEntry(world.db, { tenantId: TENANT_ID, phone, position: 5 });
    assert(bad.removed === false, "out-of-range remove refused");
    const ok = await svc.removeWishlistEntry(world.db, { tenantId: TENANT_ID, phone, position: 1 });
    assert(ok.removed === true, "remove by position works");
    assert((await svc.listWishlist(world.db, { tenantId: TENANT_ID, phone })).length === 0, "list empty after remove");

    // Parity category registered.
    const parity = await import("../../server/services/channelParity");
    assert(parity.getParityCategory("price_drop_alert")?.telegram === "full", "price_drop_alert parity category registered");
  },
};
// === END W46 uc-ux ===
