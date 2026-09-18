// === W46 uc-ux (Coder E) ===
/**
 * J410 — UC-24: gift orders — orders.isGift/giftMessage/giftRecipientPhone
 * stamped at checkout, gift-wrap fee line folded into the charged total, and
 * the recipient receipt hides prices on BOTH channels.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { resetW46TenantPolicies, seedCartWithProduct } from "./w46-uc-ux-seed";

export const journey: Journey = {
  id: "J410",
  name: "gift order: wrap fee line + price-hidden recipient receipt",
  feature: "UC-24 orders.isGift/giftMessage/recipientPhone + gift-wrap fee",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/giftOrders");
    const { createChatOrder } = await import("../../server/routers/nlp");
    const phone = world.newPhone("j410");
    const recipient = world.newPhone("j410r");
    await world.grantConsent(phone);
    await world.grantConsent(recipient);
    await resetW46TenantPolicies(world);
    try {
      // Tenant configures a ₦500.00 gift-wrap fee.
      await world.db.update(schema.tenants).set({ giftWrapFeeCents: 50000 }).where(eq(schema.tenants.id, TENANT_ID));
      assert((await svc.getGiftWrapFeeCents(world.db, TENANT_ID)) === 50000, "tenant wrap fee read");

      const { cartSessionId } = await seedCartWithProduct(world, "j410", phone, { unitPrice: "5000.00", qty: 1 });
      const order = await createChatOrder(world.db, {
        tenantId: TENANT_ID,
        waPhoneNumber: phone,
        cartSessionId,
        fulfillment: "pickup",
        address: null,
        gift: { isGift: true, wrap: true, message: "Happy birthday!", recipientPhone: recipient },
      });
      assert(order.created === true, `gift order created (got ${JSON.stringify(order)})`);
      assert(order.giftWrapFeeCents === 50000, "wrap fee line surfaced on the result");
      // ₦5,000 item + ₦500 wrap = ₦5,500 charged.
      assert(order.total === 5500, `total includes the wrap fee line (got ${order.total})`);

      const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId!));
      assert(ord.isGift === true, "orders.isGift stamped");
      assert(ord.giftMessage === "Happy birthday!", "orders.giftMessage stamped");
      assert(ord.giftRecipientPhone === recipient, "orders.giftRecipientPhone stamped");
      assert(Number(ord.giftWrapFeeCents) === 50000, "orders.giftWrapFeeCents stamped");
      assert((ord.metadata as any)?.gift?.wrapFeeCents === 50000, "gift metadata line recorded");
      assert(svc.giftReceiptSuppression(ord) === true, "receipt suppression on for gift orders");
      assert(svc.giftReceiptSuppression({ isGift: false }) === false, "normal orders show prices");

      // Recipient receipt: prices hidden.
      const receipt = svc.renderGiftReceipt({
        orderNumber: ord.orderNumber,
        buyerName: "Sim Buyer",
        message: ord.giftMessage,
        items: [{ productName: "W46 Product j410", quantity: 1 }],
      });
      assert(receipt.includes("gift") && receipt.includes("Happy birthday!"), "gift receipt rendered");
      assert(!receipt.includes("5000") && !receipt.includes("5500") && !receipt.includes("₦"), "recipient receipt hides prices");

      // Recipient notify on their channel (WA path in-sim; telegram routes via
      // the gift_order parity category through channelSender).
      world.outbound.reset();
      const sent = await svc.notifyGiftRecipient(world.db, { tenantId: TENANT_ID, orderId: order.orderId! });
      assert(sent.sent === true, "recipient notified");
      const calls = world.outbound.toPhone(recipient);
      assert(calls.some((c) => JSON.stringify(c.body).includes("gift")), "recipient got the price-hidden gift text");
      assert(!JSON.stringify(calls.map((c) => c.body)).includes("5,500"), "no prices leaked to the recipient");

      const parity = await import("../../server/services/channelParity");
      assert(parity.getParityCategory("gift_order")?.telegram === "full", "gift_order parity category registered");
    } finally {
      await resetW46TenantPolicies(world);
    }
  },
};
// === END W46 uc-ux ===
