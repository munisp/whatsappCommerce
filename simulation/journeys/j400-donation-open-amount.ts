// === W46 uc-money (Coder C) ===
/**
 * J400 — UC-16 open-amount / donation products: buyer-entered amount link,
 * min-amount guard (donationMinCents → minPriceCents fallback), fixed-price
 * products refuse the donation path.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J400",
  name: "open-amount donation checkout + min guard",
  feature: "UC-16 donations / pay-what-you-want",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { createDonationCheckout, openAmountOk, openAmountFloorCents } = await import("../../server/services/donations");
    const phone = world.newPhone("j400");
    await world.grantConsent(phone);

    // Floor helper semantics.
    assert(openAmountFloorCents({ donationMinCents: 5000, minPriceCents: 9000 }) === 5000, "donationMin wins");
    assert(openAmountFloorCents({ donationMinCents: null, minPriceCents: 9000 }) === 9000, "minPriceCents fallback");
    assert(openAmountFloorCents({}) === null, "no floor → any positive");
    assert(!openAmountOk(0, null) && !openAmountOk(-5, null), "non-positive refused");
    assert(openAmountOk(1, null) && !openAmountOk(4999, 5000) && openAmountOk(5000, 5000), "floor guard");

    const productId = "prod-w46-j400";
    await world.db.execute(`DELETE FROM products WHERE id = '${productId}'`).catch(() => undefined);
    await world.db.insert(schema.products).values({
      id: productId, tenantId: TENANT_ID, sku: "SIM-W46-J400",
      name: "W46 School Fees Fund", price: "0.00", currency: "NGN",
      status: "active", stockQuantity: 0,
      openAmountEnabled: true, donationMinCents: 100_000,
    });

    // Below the floor → refused.
    let floorBlocked = false;
    try {
      await createDonationCheckout(world.db, { tenantId: TENANT_ID, customerRef: phone, productId, amountCents: 50_000 });
    } catch (e: any) { floorBlocked = e?.code === "BAD_REQUEST" && /minimum/i.test(e?.message ?? ""); }
    assert(floorBlocked, "below-floor donation refused");

    // Buyer-entered amount above the floor → order + payment intent at that amount.
    const r = await createDonationCheckout(world.db, {
      tenantId: TENANT_ID, customerRef: phone, productId, amountCents: 250_000, note: "keep the change",
    });
    assert(r.amountCents === 250_000 && r.orderNumber.startsWith("DON-"), "donation checkout created");
    const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, r.orderId));
    assert(Number(ord.totalAmount) === 2500, "order total == buyer-entered amount");
    assert((ord.metadata as any)?.openAmount?.enteredAmountCents === 250_000, "openAmount snapshot recorded");
    assert((ord.metadata as any)?.openAmount?.floorCents === 100_000, "floor snapshot recorded");
    const intents = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.idempotencyKey, `donation:${r.orderId}`));
    assert(intents.length === 1 && Number(intents[0].amount) === 2500, "payment intent minted at entered amount");

    // Name resolution path (chat DONATE ... TO <name>).
    const r2 = await createDonationCheckout(world.db, {
      tenantId: TENANT_ID, customerRef: phone, productName: "school fees", amountCents: 100_000,
    });
    assert(r2.productName === "W46 School Fees Fund", "ILIKE name resolution hits open-amount product");

    // Fixed-price product refuses the donation path.
    const fixedId = "prod-w46-j400b";
    await world.db.execute(`DELETE FROM products WHERE id = '${fixedId}'`).catch(() => undefined);
    await world.db.insert(schema.products).values({
      id: fixedId, tenantId: TENANT_ID, sku: "SIM-W46-J400B",
      name: "W46 Fixed Price Item", price: "500.00", currency: "NGN",
      status: "active", stockQuantity: 3,
    });
    let fixedBlocked = false;
    try {
      await createDonationCheckout(world.db, { tenantId: TENANT_ID, customerRef: phone, productId: fixedId, amountCents: 60_000 });
    } catch (e: any) { fixedBlocked = e?.code === "BAD_REQUEST" && /fixed price/i.test(e?.message ?? ""); }
    assert(fixedBlocked, "fixed-price product refuses donation checkout");
  },
};
