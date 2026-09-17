/**
 * === W41 Coder A (UC-1) ===
 * J289 — Dunning on installment failure:
 *   1. A plan with NO saved token: capture marks the entry honestly
 *      'overdue' and duns the buyer (never a fake success).
 *   2. A durable 'pending' charge whose provider probe reports FAILED is
 *      flipped to 'failed' by the verify-first reconciler, the entry goes
 *      'overdue' — the charge is never blind-retried.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J289",
  name: "installment failure → overdue + dunning (UC-1)",
  feature: "capture no_token → overdue + dunning; reconcile probe-failed → failed + overdue",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/buyerInstallments");
    const db = world.db;
    const buyer = "2348000000289";
    const orderId = `j289-order-${Date.now()}`;

    await svc.setBuyerInstallmentConfig(db, TENANT_ID, { enabled: true, minTotalCents: 0 });
    await db.insert(schema.orders).values({
      id: orderId, tenantId: TENANT_ID, customerId: buyer,
      orderNumber: `J289-${Date.now()}`, status: "confirmed",
      totalAmount: "600.00", currency: "NGN", paymentStatus: "unpaid",
      createdAt: new Date(), updatedAt: new Date(),
    });
    const plan = await svc.createBuyerPlan(db, {
      tenantId: TENANT_ID, orderId, buyerPhone: buyer, totalCents: 600_00, installments: 3,
    });
    const schedule = (plan.schedule as any[]).map((e) => ({ ...e, dueAt: new Date(Date.now() - 1000).toISOString() }));
    await db.update(schema.buyerInstallmentPlans)
      .set({ status: "active", downPaymentPaidAt: new Date(), schedule, updatedAt: new Date() })
      .where(eq(schema.buyerInstallmentPlans.id, plan.planId));
    const [active] = await db.select().from(schema.buyerInstallmentPlans)
      .where(eq(schema.buyerInstallmentPlans.id, plan.planId)).limit(1);

    // ── 1. No token → overdue + dunning, plan NOT paid ───────────────────
    const outcome = await svc.captureBuyerInstallment(db, active!, schedule[0]);
    assert(outcome.ok === false && (outcome as any).reason === "no_token", `no_token outcome, got ${JSON.stringify(outcome)}`);
    const [after] = await db.select().from(schema.buyerInstallmentPlans)
      .where(eq(schema.buyerInstallmentPlans.id, plan.planId)).limit(1);
    const entryAfter = (after!.schedule as any[]).find((e) => e.seq === schedule[0].seq);
    assert(entryAfter?.status === "overdue", `entry honestly overdue, got ${entryAfter?.status}`);
    assert(after?.status === "active", "plan stays active (not paid, not fake-settled)");

    // ── 2. Pending charge probe-failed → failed + overdue ────────────────
    const failEntry = (after!.schedule as any[]).find((e) => e.status === "due");
    const failRef = svc.bipCaptureRef(plan.planId, failEntry.seq);
    await db.insert(schema.buyerPlanCharges).values({
      tenantId: TENANT_ID, planId: plan.planId, orderId, tokenId: null,
      provider: "fake", kind: "installment", seq: failEntry.seq, reference: failRef,
      amountCents: failEntry.amountCents, currency: "NGN", status: "pending",
      providerStatus: "pending", createdAt: new Date(), updatedAt: new Date(),
    });
    const rec = await svc.reconcilePendingBuyerCharges(db, {
      probe: async () => ({ status: "failed" as const }),
    });
    assert(rec.failed >= 1, `reconciler recorded the failure: ${JSON.stringify(rec)}`);
    const [chargeRow] = await db.select().from(schema.buyerPlanCharges)
      .where(eq(schema.buyerPlanCharges.reference, failRef)).limit(1);
    assert(chargeRow?.status === "failed", `charge row failed, got ${chargeRow?.status}`);
    const [finalPlan] = await db.select().from(schema.buyerInstallmentPlans)
      .where(eq(schema.buyerInstallmentPlans.id, plan.planId)).limit(1);
    const failEntryAfter = (finalPlan!.schedule as any[]).find((e) => e.seq === failEntry.seq);
    assert(failEntryAfter?.status === "overdue", `failed entry overdue, got ${failEntryAfter?.status}`);

    await svc.setBuyerInstallmentConfig(db, TENANT_ID, { enabled: false });
  },
};
