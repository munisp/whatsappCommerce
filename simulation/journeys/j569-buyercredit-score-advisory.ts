// === W56 credit ===
/**
 * J569 — buyerCredit limit decision consumes the internal score as a
 * READ-ONLY ADVISORY: createBuyerPlan stamps scoreAdvisory {score, grade,
 * version} on its result without blocking plan creation (existing flows
 * unchanged — advisory never declines).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J569",
  name: "buyerCredit decision carries the credit-score advisory",
  feature: "W56 creditScoring: scoreAdvisory stamp on createBuyerPlan",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const bi = await import("../../server/services/buyerInstallments");

    // Merchant opts into installments (fail-closed default must be lifted).
    await bi.setBuyerInstallmentConfig(world.db as any, TENANT_ID, {
      enabled: true, minTotalCents: 100_000, choices: [2, 3, 4],
    });

    const phone = world.newPhone("569");
    const customerId = `cust-j569-${phone.slice(-6)}`;
    await world.db.insert(schema.customers).values({
      id: customerId, tenantId: TENANT_ID, whatsappPhone: phone, name: "J569 Buyer",
    }).onConflictDoNothing();
    await world.db.insert(schema.orders).values({
      id: "ord-j569-0", tenantId: TENANT_ID, customerId,
      orderNumber: "J569-0", status: "delivered", totalAmount: "12000.00",
      currency: "NGN", paymentStatus: "completed", metadata: {},
    });
    await world.db.insert(schema.orders).values({
      id: "ord-j569-1", tenantId: TENANT_ID, customerId,
      orderNumber: "J569-1", status: "confirmed", totalAmount: "2500.00",
      // orders.paymentStatus enum has no "pending" (that's payment_intents) —
      // a confirmed-but-unpaid order is "unpaid".
      currency: "NGN", paymentStatus: "unpaid", metadata: {},
    });

    const plan = await bi.createBuyerPlan(world.db as any, {
      tenantId: TENANT_ID,
      orderId: "ord-j569-1",
      buyerPhone: phone,
      totalCents: 250_000,
      installments: 2,
    });
    assert(plan.ok && plan.planId, "plan created — advisory never blocks");
    assert(plan.scoreAdvisory, "scoreAdvisory stamped on the decision");
    assert(typeof plan.scoreAdvisory!.score === "number" && plan.scoreAdvisory!.score >= 0, "advisory carries the integer score");
    assert(["A", "B", "C", "D", "E"].includes(plan.scoreAdvisory!.grade), "advisory carries the grade band");
    assert(plan.scoreAdvisory!.version === "w56-v1", "advisory carries the model version");

    // The advisory equals the stored buyer score (same deterministic model).
    const stored = await world.db
      .select()
      .from(schema.creditScores)
      .where(eq(schema.creditScores.subjectId, customerId));
    assert(stored.length === 1 && stored[0].score === plan.scoreAdvisory!.score, "advisory matches the stored score");

    // Replay: same order → duplicate plan, no double insert, advisory path intact.
    const dupe = await bi.createBuyerPlan(world.db as any, {
      tenantId: TENANT_ID, orderId: "ord-j569-1", buyerPhone: phone, totalCents: 250_000, installments: 2,
    });
    assert(dupe.duplicate === true && dupe.planId === plan.planId, "idempotent replay returns the same plan");
  },
};
