/**
 * === W41 Coder A (UC-1) ===
 * J292 — Fulfillment gating on plan status:
 *   1. An order with a non-terminal installment plan cannot enter
 *      fulfillment (orderCrud.updateStatus → processing/shipped throws
 *      PRECONDITION_FAILED with an honest outstanding amount).
 *   2. Paid-in-full (via the capture path) releases the gate.
 *   3. An order with NO plan is never gated.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J292",
  name: "fulfillment gated until the installment plan is paid (UC-1)",
  feature: "assertOrderFulfillmentAllowed + orderCrud.updateStatus gate; paid-in-full releases",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/buyerInstallments");
    const tokensSvc = await import("../../server/services/customerPaymentTokens");
    const db = world.db;
    const buyer = "2348000000292";
    const orderId = `j292-order-${Date.now()}`;
    const freeOrderId = `j292-free-${Date.now()}`;

    await svc.setBuyerInstallmentConfig(db, TENANT_ID, { enabled: true, minTotalCents: 0 });
    await db.insert(schema.orders).values([{
      id: orderId, tenantId: TENANT_ID, customerId: buyer,
      orderNumber: `J292-${Date.now()}`, status: "confirmed",
      totalAmount: "400.00", currency: "NGN", paymentStatus: "completed",
      createdAt: new Date(), updatedAt: new Date(),
    }, {
      id: freeOrderId, tenantId: TENANT_ID, customerId: buyer,
      orderNumber: `J292F-${Date.now()}`, status: "confirmed",
      totalAmount: "100.00", currency: "NGN", paymentStatus: "completed",
      createdAt: new Date(), updatedAt: new Date(),
    }]);

    const token = await tokensSvc.saveCustomerToken(db, {
      tenantId: TENANT_ID, buyerPhone: buyer, provider: "fake",
      token: "fake-auth-j292", displayLabel: "Dev card •••• 0292",
      consentText: tokensSvc.tokenConsentPrompt("Dev card •••• 0292"),
    });
    const plan = await svc.createBuyerPlan(db, {
      tenantId: TENANT_ID, orderId, buyerPhone: buyer, totalCents: 400_00, installments: 2,
    });
    const schedule = (plan.schedule as any[]).map((e) => ({ ...e, dueAt: new Date(Date.now() - 1000).toISOString() }));
    await db.update(schema.buyerInstallmentPlans)
      .set({ status: "active", downPaymentPaidAt: new Date(), tokenId: token.id, schedule, updatedAt: new Date() })
      .where(eq(schema.buyerInstallmentPlans.id, plan.planId));

    // ── 1. Gate holds (service + the real orderCrud transition) ──────────
    const gating = await svc.getFulfillmentGatingPlan(db, orderId);
    assert(gating?.id === plan.planId, "gating plan found");
    let thrown: any = null;
    try {
      await svc.assertOrderFulfillmentAllowed(db, orderId);
    } catch (e: any) { thrown = e; }
    assert(thrown?.code === "PRECONDITION_FAILED", `gate throws PRECONDITION_FAILED, got ${thrown?.code}`);
    assertIncludes(String(thrown?.message), "installment plan", "honest gate message");

    const caller = await adminCaller();
    let transitionRefused: any = null;
    try {
      await caller.orderCrud.updateStatus({ orderId, status: "processing" });
    } catch (e: any) { transitionRefused = e; }
    assert(transitionRefused, "orderCrud.updateStatus refuses fulfillment while the plan is unpaid");
    assertIncludes(String(transitionRefused?.message ?? transitionRefused), "installment plan", "honest refusal message");
    const [stillConfirmed] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
    assert(stillConfirmed?.status === "confirmed", "order status unchanged by the refused transition");

    // ── 2. Pay the final installment → gate releases ─────────────────────
    const [active] = await db.select().from(schema.buyerInstallmentPlans)
      .where(eq(schema.buyerInstallmentPlans.id, plan.planId)).limit(1);
    const cap = await svc.captureBuyerInstallment(db, active!, schedule[0]);
    assert(cap.ok === true && (cap as any).planPaid === true, `final installment paid the plan: ${JSON.stringify(cap)}`);
    const gateAfter = await svc.getFulfillmentGatingPlan(db, orderId);
    assert(gateAfter === null, "gate released on paid-in-full");
    await svc.assertOrderFulfillmentAllowed(db, orderId); // must not throw
    const okTransition = await caller.orderCrud.updateStatus({ orderId, status: "processing" });
    assert(okTransition.ok === true, "fulfillment proceeds after paid-in-full");

    // ── 3. No-plan order is never gated ──────────────────────────────────
    assert((await svc.getFulfillmentGatingPlan(db, freeOrderId)) === null, "no plan → no gate");
    await svc.assertOrderFulfillmentAllowed(db, freeOrderId);

    await svc.setBuyerInstallmentConfig(db, TENANT_ID, { enabled: false });
  },
};
