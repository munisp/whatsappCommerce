/**
 * J103 — M2 stakeholder journey: retail customer WhatsApp purchase.
 *
 *   customer orders via WhatsApp (scripted LLM → cart → confirm → pickup)
 *   → Paystack initiation asserted (payment_url + provider ref on the
 *     payment transaction) → real Paystack webhook (charge.success,
 *     HMAC-signed) → order status transitions pending → confirmed with
 *     paymentStatus completed → receipt/notification delivered to the
 *     buyer (itemized, order number, total, tracking link).
 *
 * Distinct from J07: asserts the FULL status transition chain
 * (pre-webhook pending state), the Paystack initiation artifacts, and the
 * delivery-status notification loop.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess } from "./helpers";

export const journey: Journey = {
  id: "J103",
  name: "WhatsApp order → paystack → status transitions → receipt",
  feature: "payment initiation → webhook → order confirmed → receipt notification",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("c");
    await world.grantConsent(phone);

    // ── 1. Customer orders via WhatsApp ───────────────────────────────────
    const order = await createChatOrderViaNlp(world, phone, {
      items: [{ product: "Ankara Fabric", quantity: 2 }],
    });
    assert(order.orderId, "chat order created");

    // ── 2. Paystack initiation artifacts ──────────────────────────────────
    assert(order.paymentRef, "paystack provider reference captured");
    assert(order.paymentUrl, "paystack checkout URL issued");
    const [tx] = await world.db
      .select()
      .from(schema.paymentTransactions)
      .where(eq(schema.paymentTransactions.orderId, order.orderId))
      .limit(1);
    assert(tx.provider === "paystack", `payment routed via paystack (got ${tx.provider})`);
    assert(tx.status === "initiated", `transaction initiated pre-webhook (got ${tx.status})`);

    // Pre-webhook: the order is NOT yet confirmed.
    const [before] = await world.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.orderId))
      .limit(1);
    assert(before.status !== "confirmed", `order not confirmed pre-webhook (got ${before.status})`);
    assert(before.paymentStatus !== "completed", "payment not completed pre-webhook");

    // ── 3. Webhook confirmation → status transitions ──────────────────────
    const total = 2 * 5000;
    const result = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: total });
    assert(result.status === 200, `paystack webhook accepted (got ${result.status})`);

    await world.waitFor(async () => {
      const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
      return o?.status === "confirmed";
    }, 10000, "order transitioned to confirmed");
    const [after] = await world.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.orderId))
      .limit(1);
    assert(after.status === "confirmed", "order status confirmed");
    assert(after.paymentStatus === "completed", "order paymentStatus completed");

    // ── 4. Receipt / notification delivered to the buyer ──────────────────
    const receipt = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(receipt, "Payment Receipt", "receipt notification delivered");
    assertIncludes(receipt, order.orderNumber, "receipt references the order number");
    assertIncludes(receipt, "2 × Ankara Fabric", "receipt itemizes the purchase");
    assertIncludes(receipt, "Total paid: ₦10,000.00", "receipt total in NGN");
    assertIncludes(receipt, order.paymentRef!, "receipt carries the paystack ref");
  },
};
