/**
 * J615 — buying by tapping only: product card [Add to cart] → reply with
 * cart total + [Checkout][View cart][Keep shopping] → [Checkout] → itemized
 * summary + [Pickup][Delivery] → [Pickup] → ONE message: summary + Pay now.
 * Also [Buy now] on a card goes straight to the Pickup/Delivery step, and a
 * tap mid-checkout is never mistaken for a delivery address.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { lastReply, replyCount } from "./helpers";

async function tap(world: World, phone: string, id: string, title: string, label: string) {
  const before = replyCount(world, phone);
  await world.buttonReply(phone, id, title);
  await world.waitFor(() => replyCount(world, phone) > before, 15000, label);
  await world.settle();
  return lastReply(world, phone);
}

function buttonIds(call: any): string[] {
  return (call?.body?.interactive?.action?.buttons ?? []).map((b: any) => b.reply?.id);
}

export const journey: Journey = {
  id: "J615",
  name: "tap-to-buy: card → cart → checkout → pay",
  feature: "chat checkout buttons",
  async run(world: World) {
    // ── Add to cart → Checkout → Pickup → Pay now ─────────────────────────
    const phone = world.newPhone("tap");
    await world.grantConsent(phone);

    const added = await tap(world, phone, "cart_add:p-jollof", "🛒 Add to cart", "add-to-cart reply");
    assertIncludes(bodyText(added), "✅ 1 × Jollof Rice", "tap added the tapped product");
    assertIncludes(bodyText(added), "🛒 Cart: 1 item · ₦2,500.00", "cart total shown");
    assert(
      JSON.stringify(buttonIds(added)) === JSON.stringify(["say:checkout", "say:cart", "say:shop"]),
      `next-step buttons (got ${buttonIds(added)})`,
    );

    const again = await tap(world, phone, "cart_add:p-chicken", "🛒 Add to cart", "second add reply");
    assertIncludes(bodyText(again), "🛒 Cart: 2 items · ₦5,500.00", "cart total updates");

    const checkout = await tap(world, phone, "say:checkout", "🧾 Checkout", "checkout reply");
    assertIncludes(bodyText(checkout), "1 × Jollof Rice", "checkout itemizes the cart");
    assertIncludes(bodyText(checkout), "Subtotal: ₦5,500.00", "checkout subtotal");
    assert(JSON.stringify(buttonIds(checkout)) === JSON.stringify(["say:1", "say:2"]), `pickup/delivery buttons (got ${buttonIds(checkout)})`);

    const beforePay = replyCount(world, phone);
    const pay = await tap(world, phone, "say:1", "🏪 Pickup", "order reply");
    assert(replyCount(world, phone) === beforePay + 1, `order step is one message (got ${replyCount(world, phone) - beforePay})`);
    assert(pay?.body?.interactive?.type === "cta_url", "order summary carries the Pay now button");
    assertIncludes(bodyText(pay), "₦5,500.00", "summary shows the total");
    assertIncludes(JSON.stringify(pay?.body), "https://checkout.paystack.com/sim/", "Pay now opens the payment link");

    const schema = await import("../../drizzle/schema");
    const [order] = await world.db.select().from(schema.orders)
      .where(and(eq(schema.orders.tenantId, TENANT_ID), eq(schema.orders.customerId, phone))).limit(1);
    assert(order && Number(order.totalAmount) === 5500, `order created for ₦5,500 (got ${order?.totalAmount})`);

    // ── Buy now → straight to Pickup/Delivery ─────────────────────────────
    const buyer = world.newPhone("buy");
    await world.grantConsent(buyer);
    const buy = await tap(world, buyer, "buy_now:p-ankara", "⚡ Buy now", "buy-now reply");
    assertIncludes(bodyText(buy), "1 × Ankara Fabric", "buy now itemizes the product");
    assert(JSON.stringify(buttonIds(buy)) === JSON.stringify(["say:1", "say:2"]), `buy now asks pickup/delivery (got ${buttonIds(buy)})`);

    // Delivery chosen, then a card tap while the address is awaited: the tap
    // adds to the cart instead of becoming the "address".
    await tap(world, buyer, "say:2", "🛵 Delivery", "delivery reply");
    const midTap = await tap(world, buyer, "cart_add:p-jollof", "🛒 Add to cart", "mid-checkout tap");
    assertIncludes(bodyText(midTap), "✅ 1 × Jollof Rice", "mid-checkout tap is an add, not an address");
    const [noOrder] = await world.db.select().from(schema.orders)
      .where(and(eq(schema.orders.tenantId, TENANT_ID), eq(schema.orders.customerId, buyer))).limit(1);
    assert(!noOrder, "no order was created from the tap id");

    // ── A product from another shop or a deleted one is refused ──────────
    const gone = await tap(world, buyer, "cart_add:not-a-real-product", "🛒 Add to cart", "unknown product reply");
    assertIncludes(bodyText(gone), "isn't available any more", "unknown product explained");
  },
};
