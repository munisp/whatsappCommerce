// === W56 credit ===
/**
 * J567 — Score updates after a repayment/settlement event via the
 * post-commit seam (recomputeAfterPaymentEvent). The seam is additive and
 * non-blocking: it recomputes the buyer (and merchant) score AFTER the
 * money tx commits and never throws into the payment path.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J567",
  name: "credit score updates after repayment event via post-commit seam",
  feature: "W56 creditScoring: recomputeAfterPaymentEvent seam",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const scoring = await import("../../server/services/creditScoring");

    const phone = world.newPhone("567");
    const customerId = `cust-j567-${phone.slice(-6)}`;
    await world.db.insert(schema.customers).values({
      id: customerId, tenantId: TENANT_ID, whatsappPhone: phone, name: "J567 Buyer",
    }).onConflictDoNothing();
    await world.db.insert(schema.orders).values({
      id: "ord-j567-0", tenantId: TENANT_ID, customerId,
      orderNumber: "J567-0", status: "delivered", totalAmount: "9000.00",
      currency: "NGN", paymentStatus: "completed", metadata: {},
    });

    // Baseline score: no repayment history → cold-start half weight (150).
    const before = await scoring.computeAndStoreSubjectScore(world.db as any, TENANT_ID, "buyer", customerId);
    assert(before, "baseline computed");
    assert(before!.factors.repaymentTimeliness.points === 150, "cold-start half weight before any repayment");

    // A repayment lands: paid-on-time installment schedule entry.
    await world.db.insert(schema.buyerInstallmentPlans).values({
      tenantId: TENANT_ID,
      orderId: "ord-j567-inst",
      buyerPhone: phone,
      totalCents: 600_000,
      downPaymentCents: 300_000,
      downPaymentRef: "bipdown:j567",
      installments: 2,
      schedule: [
        { seq: 2, dueAt: new Date(Date.now() + 86400_000).toISOString(), amountCents: 300_000, status: "paid", paidAt: new Date().toISOString() },
      ],
      currency: "NGN",
      status: "active",
    });

    // Post-commit seam (as wired from settlement/refund paths): recomputes.
    await scoring.recomputeAfterPaymentEvent(world.db as any, {
      tenantId: TENANT_ID, buyerSubjectId: customerId, merchantId: TENANT_ID, kind: "settlement",
    });

    const after = await scoring.getStoredSubjectScore(world.db as any, TENANT_ID, "buyer", customerId);
    assert(after, "score row present after the seam");
    const factors = after!.factors as any;
    assert(factors.repaymentTimeliness.onTime === 1, "seam recompute sees the repayment");
    assert(factors.repaymentTimeliness.points === 300, "on-time repayment earns full timeliness weight");
    assert(after!.score > before!.score, `score improved after the repayment event (${before!.score} → ${after!.score})`);

    // The seam never throws, even for an unknown subject (fail-open).
    await scoring.recomputeAfterPaymentEvent(world.db as any, {
      tenantId: TENANT_ID, buyerSubjectId: "nobody-j567", kind: "refund",
    });
  },
};
