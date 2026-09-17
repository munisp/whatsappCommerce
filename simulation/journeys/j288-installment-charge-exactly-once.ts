/**
 * === W41 Coder A (UC-1) ===
 * J288 — Installment charge exactly-once incl. timeout-verify:
 *   1. A due installment is captured off-session against the plan's saved
 *      (fake) token: the durable charge row lands 'success', the schedule
 *      entry flips paid, and the paymentTransactions claim exists.
 *   2. Re-capturing the SAME entry is an exactly-once duplicate — never a
 *      second provider charge.
 *   3. Timeout-verify: a durable 'pending' charge row is converged by the
 *      verify-first reconciler via a READ-ONLY probe (success → entry paid,
 *      row flipped success) — never a blind re-charge.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J288",
  name: "installment charge exactly-once + timeout-verify reconcile (UC-1)",
  feature: "captureBuyerInstallment: durable ledger + claim exactly-once; reconcilePendingBuyerCharges verify-first",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/buyerInstallments");
    const tokensSvc = await import("../../server/services/customerPaymentTokens");
    const db = world.db;
    const buyer = "2348000000288";
    const orderId = `j288-order-${Date.now()}`;

    await svc.setBuyerInstallmentConfig(db, TENANT_ID, { enabled: true, minTotalCents: 0 });
    await db.insert(schema.orders).values({
      id: orderId, tenantId: TENANT_ID, customerId: buyer,
      orderNumber: `J288-${Date.now()}`, status: "confirmed",
      totalAmount: "600.00", currency: "NGN", paymentStatus: "unpaid",
      createdAt: new Date(), updatedAt: new Date(),
    });
    const token = await tokensSvc.saveCustomerToken(db, {
      tenantId: TENANT_ID, buyerPhone: buyer, provider: "fake",
      token: "fake-auth-j288", displayLabel: "Dev card •••• 0288",
      consentText: tokensSvc.tokenConsentPrompt("Dev card •••• 0288"),
    });
    const plan = await svc.createBuyerPlan(db, {
      tenantId: TENANT_ID, orderId, buyerPhone: buyer, totalCents: 600_00, installments: 3,
    });
    // Activate + attach the token (as the webhook hook would).
    await db.update(schema.buyerInstallmentPlans)
      .set({ status: "active", downPaymentPaidAt: new Date(), tokenId: token.id, updatedAt: new Date() })
      .where(eq(schema.buyerInstallmentPlans.id, plan.planId));
    const [active] = await db.select().from(schema.buyerInstallmentPlans)
      .where(eq(schema.buyerInstallmentPlans.id, plan.planId)).limit(1);

    // ── 1. Capture the first due entry (dueAt already passed for the test) ─
    const schedule = (active!.schedule as any[]).map((e, i) =>
      i === 0 ? { ...e, dueAt: new Date(Date.now() - 1000).toISOString() } : e);
    await db.update(schema.buyerInstallmentPlans)
      .set({ schedule, updatedAt: new Date() })
      .where(eq(schema.buyerInstallmentPlans.id, plan.planId));
    const entry = schedule[0];

    const cap = await svc.captureBuyerInstallment(db, active!, entry);
    assert(cap.ok === true, `capture succeeded, got ${JSON.stringify(cap)}`);
    const ref = svc.bipCaptureRef(plan.planId, entry.seq);
    const [claim] = await db.select().from(schema.paymentTransactions)
      .where(eq(schema.paymentTransactions.providerRef, ref)).limit(1);
    assert(claim, "paymentTransactions claim row exists for the charge reference");
    const [chargeRow] = await db.select().from(schema.buyerPlanCharges)
      .where(eq(schema.buyerPlanCharges.reference, ref)).limit(1);
    assert(chargeRow?.status === "success", `durable charge row success, got ${chargeRow?.status}`);
    const [afterCap] = await db.select().from(schema.buyerInstallmentPlans)
      .where(eq(schema.buyerInstallmentPlans.id, plan.planId)).limit(1);
    const paidEntry = (afterCap!.schedule as any[]).find((e) => e.seq === entry.seq);
    assert(paidEntry?.status === "paid" && paidEntry?.paidAt, "schedule entry paid");

    // ── 2. Same entry again → exactly-once duplicate (no 2nd charge) ──────
    const dupe = await svc.captureBuyerInstallment(db, afterCap!, entry);
    assert(dupe.ok === false && (dupe as any).reason === "duplicate", `second capture is a duplicate, got ${JSON.stringify(dupe)}`);
    const rows = await db.select().from(schema.buyerPlanCharges)
      .where(eq(schema.buyerPlanCharges.reference, ref)).limit(5);
    assert(rows.length === 1, "still exactly one durable charge row");

    // ── 3. Timeout-verify: durable 'pending' row → reconciler settles ─────
    const lastEntry = (afterCap!.schedule as any[]).find((e) => e.status === "due");
    const pendingRef = svc.bipCaptureRef(plan.planId, lastEntry.seq);
    await db.insert(schema.paymentTransactions).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, orderId,
      provider: "fake", providerRef: pendingRef,
      amount: (lastEntry.amountCents / 100).toFixed(2), currency: "NGN",
      status: "initiated", createdAt: new Date(), updatedAt: new Date(),
    });
    await db.insert(schema.buyerPlanCharges).values({
      tenantId: TENANT_ID, planId: plan.planId, orderId, tokenId: token.id,
      provider: "fake", kind: "installment", seq: lastEntry.seq, reference: pendingRef,
      amountCents: lastEntry.amountCents, currency: "NGN", status: "pending",
      providerStatus: "pending", createdAt: new Date(), updatedAt: new Date(),
    });
    const rec = await svc.reconcilePendingBuyerCharges(db, {
      probe: async () => ({ status: "success" as const }),
    });
    assert(rec.checked >= 1 && rec.settled >= 1, `reconciler settled the pending row: ${JSON.stringify(rec)}`);
    const [convRow] = await db.select().from(schema.buyerPlanCharges)
      .where(eq(schema.buyerPlanCharges.reference, pendingRef)).limit(1);
    assert(convRow?.status === "success", `pending row converged to success, got ${convRow?.status}`);
    const [finalPlan] = await db.select().from(schema.buyerInstallmentPlans)
      .where(eq(schema.buyerInstallmentPlans.id, plan.planId)).limit(1);
    const finalEntry = (finalPlan!.schedule as any[]).find((e) => e.seq === lastEntry.seq);
    assert(finalEntry?.status === "paid", "reconciler marked the entry paid");
    assert(finalPlan?.status === "paid", `plan fully paid after final entry, got ${finalPlan?.status}`);

    await svc.setBuyerInstallmentConfig(db, TENANT_ID, { enabled: false });
  },
};
