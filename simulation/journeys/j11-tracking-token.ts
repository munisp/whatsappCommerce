/**
 * J11 — Tracking token: the HMAC link validates and returns a PII-scrubbed
 * payload; a tampered token is rejected.
 */
import { generateTrackingToken, verifyTrackingToken } from "../../server/services/trackingToken";
import { assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp } from "./helpers";

export const journey: Journey = {
  id: "J11",
  name: "tracking token",
  feature: "HMAC tracking link + PII scrub",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });

    // Token round-trips through the real verifier.
    const token = generateTrackingToken(order.orderId);
    assert(verifyTrackingToken(token) === order.orderId, "generated token verifies");

    // Public tRPC path returns the scrubbed view.
    const { appRouter } = await import("../../server/routers");
    const anon = appRouter.createCaller({ user: null, req: { protocol: "http", headers: {} }, res: { clearCookie: () => {} } } as any);
    const view = await anon.tracking.getByToken({ token });
    assert(view.orderNumber === order.orderNumber, "tracking view returns the order number");
    assert(view.status === "pending", "tracking view returns the status");
    assertIncludes(JSON.stringify(view.items), "Jollof Rice", "tracking view lists items");

    // PII scrub: no raw phone, no address, no customer id anywhere.
    const serialized = JSON.stringify(view);
    assert(!serialized.includes(phone), "tracking payload contains no buyer phone");
    assert(!serialized.includes(order.orderId), "tracking payload does not echo the internal order id");
    assert(!/address|street|latitude|longitude/i.test(serialized), "tracking payload contains no address/coords");

    // Tampered tokens are rejected at every layer.
    const tampered = `${order.orderId}.${"A".repeat(24)}`;
    assert(verifyTrackingToken(tampered) === null, "tampered signature rejected by the verifier");
    const wrongOrder = token.replace(order.orderId, "00000000-0000-0000-0000-000000000000");
    assert(verifyTrackingToken(wrongOrder) === null, "swapped order id rejected");
    let threw = false;
    try {
      await anon.tracking.getByToken({ token: tampered });
    } catch (e: any) {
      threw = true;
      assert(e?.code === "NOT_FOUND" || String(e?.message).includes("Invalid"), "tampered token → NOT_FOUND");
    }
    assert(threw, "tampered token rejected by the public endpoint");
  },
};
