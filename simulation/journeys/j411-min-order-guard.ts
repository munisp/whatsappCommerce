// === W46 uc-ux (Coder E) ===
/**
 * J411 — UC-27: tenant minimum order value per fulfillment mode — checkout
 * blocks below the minimum with an additive-cart prompt (no order, no
 * payment link) and passes at/above it; pickup/delivery minima independent.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { resetW46TenantPolicies, seedCartWithProduct } from "./w46-uc-ux-seed";

export const journey: Journey = {
  id: "J411",
  name: "min order value: block below minimum, prompt, per-mode",
  feature: "UC-27 tenant minOrderCents per fulfillment mode + checkout guard",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/minOrder");
    const { createChatOrder } = await import("../../server/routers/nlp");
    const phone = world.newPhone("j411");
    await world.grantConsent(phone);
    await resetW46TenantPolicies(world);
    try {
      // Default: no minimum → guard passes.
      assert((await svc.getMinOrderCents(world.db, TENANT_ID, "delivery")) === 0, "default delivery minimum is 0");
      const free = await svc.checkMinOrder(world.db, { tenantId: TENANT_ID, fulfillment: "delivery", subtotalMajor: 1 });
      assert(free.ok === true, "no minimum → any subtotal passes");

      // Delivery minimum ₦10,000 (1_000_000 kobo); pickup minimum ₦2,000.
      await world.db.update(schema.tenants).set({
        minOrderCentsDelivery: 1_000_000,
        minOrderCentsPickup: 200_000,
      }).where(eq(schema.tenants.id, TENANT_ID));

      // Per-mode independence.
      const del = await svc.checkMinOrder(world.db, { tenantId: TENANT_ID, fulfillment: "delivery", subtotalMajor: 5000 });
      assert(del.ok === false && del.shortfallCents === 500_000, "delivery shortfall computed in cents");
      const pick = await svc.checkMinOrder(world.db, { tenantId: TENANT_ID, fulfillment: "pickup", subtotalMajor: 5000 });
      assert(pick.ok === true, "pickup minimum is independent");

      // ── Checkout BLOCK below the delivery minimum: no order, no link ──
      const { cartSessionId: lowCart } = await seedCartWithProduct(world, "j411a", phone, { unitPrice: "5000.00", qty: 1 });
      const blocked = await createChatOrder(world.db, {
        tenantId: TENANT_ID, waPhoneNumber: phone, cartSessionId: lowCart, fulfillment: "delivery", address: "1 Sim Street",
      });
      assert(blocked.created === false && blocked.minOrderBlock, "below-minimum delivery checkout blocked");
      assert(blocked.minOrderBlock!.shortfallCents === 500_000, "block carries the shortfall");
      assert(!blocked.paymentUrl && !blocked.orderId, "no payment link / order row for a blocked checkout");
      const prompt = svc.minOrderBlockReply(blocked.minOrderBlock!, "NGN", "delivery");
      assert(prompt.includes("minimum") && prompt.includes("10000.00"), "prompt names the minimum");

      // ── At/above the minimum the SAME-value cart checks out ──
      const { cartSessionId: hiCart } = await seedCartWithProduct(world, "j411b", phone, { unitPrice: "5000.00", qty: 2 });
      const passed = await createChatOrder(world.db, {
        tenantId: TENANT_ID, waPhoneNumber: phone, cartSessionId: hiCart, fulfillment: "delivery", address: "1 Sim Street",
      });
      assert(passed.created === true && !passed.minOrderBlock, `at-minimum checkout passes (got ${JSON.stringify(passed)})`);

      // Pickup enforces its own minimum on a tiny cart.
      const { cartSessionId: tinyCart } = await seedCartWithProduct(world, "j411c", phone, { unitPrice: "1000.00", qty: 1 });
      const pickupBlocked = await createChatOrder(world.db, {
        tenantId: TENANT_ID, waPhoneNumber: phone, cartSessionId: tinyCart, fulfillment: "pickup", address: null,
      });
      assert(pickupBlocked.created === false && pickupBlocked.minOrderBlock?.minCents === 200_000, "pickup mode enforces its own minimum");
    } finally {
      await resetW46TenantPolicies(world);
    }
  },
};
// === END W46 uc-ux ===
