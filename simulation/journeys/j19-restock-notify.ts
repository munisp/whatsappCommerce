/**
 * J19 — Restock notify: a waitlisted buyer is alerted when the product goes
 * 0 → 5 through the REAL product-update path (router → triggerRestockNotification).
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J19",
  name: "restock waitlist notify",
  feature: "0→5 restock fan-out",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const schema = await import("../../drizzle/schema");

    // Buyer adds the widget while it has 1 in stock…
    await world.db.update(schema.products).set({ stockQuantity: 1 }).where(eq(schema.products.id, "p-restock"));
    world.llm.when("restock widget please", {
      reply: "Added!",
      intent: "add_to_cart",
      nextState: "add_to_cart",
      extractedItems: [{ product: "Restock Widget", quantity: 1 }],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.95,
    });
    await world.text(phone, "restock widget please");
    // …but it sells out before they confirm → checkout hits the shortage.
    await world.db.update(schema.products).set({ stockQuantity: 0 }).where(eq(schema.products.id, "p-restock"));
    world.llm.when("confirm widget order", {
      reply: "Confirming.",
      intent: "confirm_order",
      nextState: "checkout_confirm",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.95,
    });
    await world.text(phone, "confirm widget order");
    const base0 = world.outbound.toPhone(phone).length;
    await world.text(phone, "1"); // pickup → reservation attempt hits the shortage
    const oos = world.outbound.toPhone(phone).slice(base0).map((c) => bodyText(c)).join("\n");
    assertIncludes(oos, "out of stock", "buyer told the widget is out of stock");

    await world.text(phone, "NOTIFY ME");
    const entries = await world.db.select().from(schema.waitlistEntries)
      .where(and(eq(schema.waitlistEntries.tenantId, TENANT_ID), eq(schema.waitlistEntries.phone, phone)));
    assert(entries.length === 1 && entries[0].productId === "p-restock", "waitlist subscription stored");
    assert(entries[0].notifiedAt == null, "not yet notified");

    // Admin restocks 0 → 5 through the REAL product router.
    const caller = await adminCaller();
    const before = world.outbound.toPhone(phone).length;
    await caller.product.update({ id: "p-restock", tenantId: TENANT_ID, stockQuantity: 5 });

    await world.waitFor(() => world.outbound.toPhone(phone).length > before, 10000, "restock alert sent");
    const alert = world.outbound.toPhone(phone).slice(before).map((c) => bodyText(c)).join("\n");
    assertIncludes(alert, "Restock Widget", "alert names the product");
    assert(
      alert.includes("back in stock") || alert.includes("Back in stock"),
      "alert says the product is back in stock",
    );

    const [entry] = await world.db.select().from(schema.waitlistEntries)
      .where(and(eq(schema.waitlistEntries.tenantId, TENANT_ID), eq(schema.waitlistEntries.phone, phone)));
    assert(entry.notifiedAt != null, "waitlist entry stamped notifiedAt");

    // A no-op restock (5 → 5) must not re-alert.
    const count = world.outbound.toPhone(phone).length;
    await caller.product.update({ id: "p-restock", tenantId: TENANT_ID, stockQuantity: 5 });
    await world.settle(600);
    assert(world.outbound.toPhone(phone).length === count, "no alert when stock did not transition 0→>0");
  },
};
