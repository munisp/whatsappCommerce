/**
 * J123 — Free-text discovery → pin → order: "fresh vegetables near me" with
 * no known location prompts the customer to share a pin; once the pin is
 * shared, the same free-text query returns query-filtered results (only the
 * merchant whose catalog matches); the customer then completes a real order
 * with the discovered merchant through the standard NLP checkout path.
 */
import { eq } from "drizzle-orm";
import {
  assert,
  assertIncludes,
  bodyText,
  SUPPLIER_TENANT_ID,
  TENANT_ID,
  type World,
} from "../world";
import type { Journey } from "../runner";
import {
  approveKyb,
  createChatOrderViaNlp,
  resetGeoDiscovery,
  tenantCaller,
} from "./helpers";

const SHOP = { lat: 6.5244, lng: 3.3792 };
const NEARBY_COMPETITOR = { lat: 6.5272, lng: 3.3792 }; // ~0.3 km — also near
const CUSTOMER = { lat: 6.53, lng: 3.3792 }; // ~0.6 km from the shop

const VEG_PRODUCT = {
  id: "p-freshveg",
  sku: "SIM-VEG",
  name: "Fresh Vegetables",
  price: "1200.00",
  stock: 20,
};

export const journey: Journey = {
  id: "J123",
  name: "free-text discovery → order",
  feature: "geo discovery: near-me query → pin → checkout",
  async run(world: World) {
    await resetGeoDiscovery(world);

    // Discovered merchant (matches the query) + a nearby competitor whose
    // catalog does NOT match "fresh vegetables".
    const near = await tenantCaller(TENANT_ID);
    await near.geo.merchant.setLocation({ latitude: SHOP.lat, longitude: SHOP.lng });
    await near.geo.merchant.setDiscoverable({ discoverable: true });
    const competitor = await tenantCaller(SUPPLIER_TENANT_ID);
    await competitor.geo.merchant.setLocation({
      latitude: NEARBY_COMPETITOR.lat,
      longitude: NEARBY_COMPETITOR.lng,
    });
    await competitor.geo.merchant.setDiscoverable({ discoverable: true });
    await approveKyb(world, TENANT_ID);
    await approveKyb(world, SUPPLIER_TENANT_ID);

    // Catalog item matching the free-text query.
    const schema = await import("../../drizzle/schema");
    await world.db.insert(schema.products).values({
      id: VEG_PRODUCT.id,
      tenantId: TENANT_ID,
      sku: VEG_PRODUCT.sku,
      name: VEG_PRODUCT.name,
      description: "Fresh Vegetables — simulation catalog item",
      category: "produce",
      price: VEG_PRODUCT.price,
      currency: "NGN",
      imageUrl: "https://cdn.sim.local/p-freshveg.jpg",
      status: "active",
      stockQuantity: VEG_PRODUCT.stock,
      lowStockThreshold: 3,
    }).onConflictDoNothing();

    const phone = world.newPhone("geo");
    await world.grantConsent(phone);

    // 1. Free-text "near me" with no known location → prompted to share a pin.
    await world.text(phone, "fresh vegetables near me");
    let reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "share your current location", "no-pin prompt asks for a location share");

    // 2. Customer shares the pin → discovery menu (both nearby merchants).
    await world.location(phone, CUSTOMER.lat, CUSTOMER.lng);
    reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "Businesses near you", "pin produced a discovery menu");
    assertIncludes(reply, "Sim Store", "discoverable merchant appears after pin share");

    // 3. Same free-text query again — now centered on the pin and filtered:
    // the competitor whose catalog has no "fresh vegetables" drops out.
    await world.text(phone, "fresh vegetables near me");
    reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "Sim Store", "query-filtered menu keeps the matching merchant");
    assert(
      !reply.includes("Lagos Plastics"),
      `query filter drops the non-matching competitor (got: ${reply.slice(0, 200)})`,
    );

    // 4. Order with the discovered merchant through the standard NLP
    // checkout path (add → confirm → pickup → payment link).
    const outcome = await createChatOrderViaNlp(world, phone, {
      items: [{ product: "Fresh Vegetables", quantity: 2 }],
      fulfillment: "pickup",
    });
    assert(outcome.total === 2400, `order total 2 × ₦1,200 (got ${outcome.total})`);
    assert(outcome.paymentUrl?.includes("checkout.paystack.com"), "payment link issued");

    const [order] = await world.db.select().from(schema.orders)
      .where(eq(schema.orders.id, outcome.orderId)).limit(1);
    assert(order?.tenantId === TENANT_ID, "order landed with the discovered merchant");

    // Tidy up the journey-owned catalog row (ignore FK complaints).
    await world.db.delete(schema.products).where(eq(schema.products.id, VEG_PRODUCT.id)).catch(() => {});
  },
};
