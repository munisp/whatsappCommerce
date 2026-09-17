/**
 * === W41 Coder A (UC-1) ===
 * J286 — Buyer installment plan creation + eligibility:
 *   1. Merchant NOT opted in → plan creation refused honestly (fail closed).
 *   2. Opt-in with a threshold → below-threshold refused; at-threshold
 *      creates a plan (integer cents, parts sum exactly, down = part 1).
 *   3. Checkout replay → the SAME plan is returned (one plan per order).
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J286",
  name: "buyer installment plan creation + eligibility (UC-1)",
  feature: "buyerInstallments.createBuyerPlan: opt-in + threshold fail-closed; integer-cent schedule; idempotent replay",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/buyerInstallments");
    const db = world.db;
    const orderId = `j286-order-${Date.now()}`;

    // ── 0. Seed a bare order row for the plan to link ────────────────────
    await db.insert(schema.orders).values({
      id: orderId,
      tenantId: TENANT_ID,
      customerId: "2348000000286",
      orderNumber: `J286-${Date.now()}`,
      status: "pending",
      totalAmount: "900.00",
      currency: "NGN",
      paymentStatus: "unpaid",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // ── 1. Not opted in → honest refusal, no plan row ────────────────────
    let refused: any = null;
    try {
      await svc.createBuyerPlan(db, {
        tenantId: TENANT_ID, orderId, buyerPhone: "2348000000286",
        totalCents: 900_00, installments: 3,
      });
    } catch (e: any) { refused = e; }
    assert(refused, "plan creation must refuse when the merchant is not opted in");
    assertIncludes(String(refused?.message ?? refused), "not offer installment", "honest opt-out message");

    // ── 2. Opt in with a threshold ───────────────────────────────────────
    const cfg = await svc.setBuyerInstallmentConfig(db, TENANT_ID, { enabled: true, minTotalCents: 1_000_00 });
    assert(cfg.enabled === true && cfg.minTotalCents === 1_000_00, `config saved, got ${JSON.stringify(cfg)}`);

    let below: any = null;
    try {
      await svc.createBuyerPlan(db, {
        tenantId: TENANT_ID, orderId, buyerPhone: "2348000000286",
        totalCents: 900_00, installments: 3,
      });
    } catch (e: any) { below = e; }
    assert(below, "below-threshold total must refuse");
    assertIncludes(String(below?.message ?? below), "below the installment minimum", "honest threshold message");

    // ── 3. At/above threshold → plan with exact integer-cent split ───────
    const plan = await svc.createBuyerPlan(db, {
      tenantId: TENANT_ID, orderId, buyerPhone: "2348000000286",
      totalCents: 1_200_00, installments: 3,
    });
    assert(plan.ok === true && plan.planId, "plan created");
    assert(plan.downPaymentCents === 400_00, `down payment = total/3, got ${plan.downPaymentCents}`);
    assert(plan.schedule.length === 2, `2 scheduled entries, got ${plan.schedule.length}`);
    const sum = plan.downPaymentCents + plan.schedule.reduce((a, e) => a + e.amountCents, 0);
    assert(sum === 1_200_00, `parts sum exactly to total, got ${sum}`);
    assert(plan.schedule.every((e) => e.status === "due" && e.paidAt === null), "entries start due");
    assert(plan.schedule[0].seq === 2, "schedule seq starts at 2 (part 1 = down payment)");
    assert(plan.downPaymentRef === svc.bipDownRef(plan.planId), "deterministic down-payment reference");

    const [row] = await db.select().from(schema.buyerInstallmentPlans)
      .where(eq(schema.buyerInstallmentPlans.id, plan.planId)).limit(1);
    assert(row?.status === "pending_down", `plan starts pending_down, got ${row?.status}`);
    assert(row?.orderId === orderId, "plan linked to the order");

    // ── 4. Replay → the SAME plan (one plan per order) ───────────────────
    const replay = await svc.createBuyerPlan(db, {
      tenantId: TENANT_ID, orderId, buyerPhone: "2348000000286",
      totalCents: 1_200_00, installments: 3,
    });
    assert(replay.duplicate === true && replay.planId === plan.planId, "checkout replay returns the existing plan");

    // Cleanup: restore the tenant default (other journeys see a clean world).
    await svc.setBuyerInstallmentConfig(db, TENANT_ID, { enabled: false });
  },
};
