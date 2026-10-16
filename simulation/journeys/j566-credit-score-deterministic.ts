// === W56 credit ===
/**
 * J566 — Internal credit score is computed from seeded on-platform history
 * DETERMINISTICALLY: the same seeded buyer history scored twice (same
 * `now`) yields byte-identical score/grade/factors, the grade band matches
 * the documented thresholds, and the cache row persists with the model
 * version stamp.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J566",
  name: "credit score computed from seeded history deterministically",
  feature: "W56 creditScoring: deterministic integer model + credit_scores cache",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const scoring = await import("../../server/services/creditScoring");

    const phone = world.newPhone("566");
    const customerId = `cust-j566-${phone.slice(-6)}`;
    await world.db.insert(schema.customers).values({
      id: customerId, tenantId: TENANT_ID, whatsappPhone: phone, name: "J566 Buyer",
    }).onConflictDoNothing();

    // Seed 12 delivered orders in the window (₦25,000 each).
    for (let i = 0; i < 12; i++) {
      await world.db.insert(schema.orders).values({
        id: `ord-j566-${i}`,
        tenantId: TENANT_ID,
        customerId,
        orderNumber: `J566-${i}`,
        status: "delivered",
        totalAmount: "25000.00",
        currency: "NGN",
        paymentStatus: "completed",
        metadata: {},
      });
    }
    // One on-time-paid installment plan (2 paid schedule entries).
    await world.db.insert(schema.buyerInstallmentPlans).values({
      tenantId: TENANT_ID,
      orderId: "ord-j566-inst",
      buyerPhone: phone,
      totalCents: 1_000_000,
      downPaymentCents: 500_000,
      downPaymentRef: "bipdown:j566",
      installments: 2,
      schedule: [
        { seq: 2, dueAt: "2025-01-08T00:00:00.000Z", amountCents: 500_000, status: "paid", paidAt: "2025-01-07T00:00:00.000Z" },
      ],
      currency: "NGN",
      status: "paid",
    });

    const now = new Date();
    const a = await scoring.computeAndStoreSubjectScore(world.db as any, TENANT_ID, "buyer", customerId, { now });
    const b = await scoring.computeAndStoreSubjectScore(world.db as any, TENANT_ID, "buyer", customerId, { now });
    assert(a && b, "score computed for the seeded buyer");
    assert(JSON.stringify({ s: a!.score, g: a!.grade, f: a!.factors }) === JSON.stringify({ s: b!.score, g: b!.grade, f: b!.factors }),
      "same inputs → same score/grade/factors (deterministic)");
    assert(a!.score >= 0 && a!.score <= 1000, "score bounded 0-1000");
    assert(a!.grade === scoring.gradeForScore(a!.score), "grade band matches the documented thresholds");
    assert(a!.factors.repaymentTimeliness.onTime === 1, "installment repayment counted on-time");
    assert(a!.version === "w56-v1", "model version stamped");

    // Phone-based resolution lands on the same canonical customer id.
    const byPhone = await scoring.computeAndStoreSubjectScore(world.db as any, TENANT_ID, "buyer", phone, { now });
    assert(byPhone && byPhone.score === a!.score, "phone resolution → same subject, same score");

    // Cache row: exactly one, upserted (not duplicated).
    const rows = await world.db
      .select()
      .from(schema.creditScores)
      .where(eq(schema.creditScores.subjectId, customerId));
    assert(rows.length === 1, `exactly one cache row (got ${rows.length})`);
    assert(rows[0].score === a!.score && rows[0].grade === a!.grade, "cache row matches the computation");
    assert(rows[0].subjectType === "buyer" && rows[0].tenantId === TENANT_ID, "tenant+subject scoped");
  },
};
