/**
 * J256 — W38 PAY-4/verify-first doctrine: a provider timeout / ambiguity
 * mid-charge NEVER double-charges and NEVER double-settles.
 *
 *  1. Charge returns 'pending' (timeout-equivalent ambiguity) → claim kept,
 *     durable pending row, entry 'due'.
 *  2. The installment sweep CANNOT re-charge while the claim is held
 *     (exactly-once duplicate verdict) — the provider sees exactly ONE
 *     charge for the reference across repeated sweeps.
 *  3. The reconciler probes READ-ONLY while the provider is still pending —
 *     nothing settles, nothing re-charges.
 *  4. When the provider finally confirms, the reconciler settles exactly
 *     once; a further sweep changes nothing.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { seedLoanMerchant } from "./loanRaceSeed";
import { pay } from "../metaMock";

const T = "sim-pot-256";

async function seed(world: World) {
  const schema = await import("../../drizzle/schema");
  await seedLoanMerchant(world, T);
  await world.db.update(schema.tenants).set({
    whatsappPhoneNumberId: `pn_${T}`,
    settings: { whatsapp: { accessToken: "sim_wa_token" }, adminPhone: "2349025600256" },
  }).where(eq(schema.tenants.id, T));
  await world.db.insert(schema.tenantMemberships).values({
    tenantId: T, userId: "2561", role: "owner",
  }).onConflictDoNothing();
  await world.db.insert(schema.paymentGatewayConfigs).values({
    id: `pgc-${T}`, tenantId: T, provider: "paystack", secretKey: "sk_sim_test",
    isActive: true, enabled: true, priority: 0,
  }).onConflictDoNothing();
  await world.db.insert(schema.paymentMandates).values({
    tenantId: T, provider: "paystack", mandateRef: `sim-mandate-${T}`, status: "active",
  }).onConflictDoNothing();
}

export const journey: Journey = {
  id: "J256",
  name: "pay over time: timeout mid-charge never double-charges or double-settles",
  feature: "W38 pay-over-time reconciliation",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const pot = await import("../../server/services/payOverTime");

    await seed(world);
    const caller = await tenantCaller(T, { userId: 2561 });
    const bill = await caller.vendorBills.create({
      tenantId: T, vendorName: "Oshodi Glass", amountCents: 120_000,
    });
    const orig = await caller.vendorBills.recordPayment({
      tenantId: T, billId: bill.bill.id, payOverTime: { installments: 3 },
    });
    assert(orig.ok === true, "origination succeeds");
    const planId = orig.planId;
    const ref1 = pot.potCaptureRef(planId, 1);

    const [planRow] = await world.db.select().from(schema.installmentPlans)
      .where(eq(schema.installmentPlans.id, planId)).limit(1);
    const schedule = (planRow.schedule as any[]).map((e) =>
      e.seq === 1 ? { ...e, dueAt: new Date(Date.now() - 60_000).toISOString() } : e);
    await world.db.update(schema.installmentPlans)
      .set({ schedule, updatedAt: new Date() })
      .where(eq(schema.installmentPlans.id, planId));

    const chargeCalls = () => world.outbound.all().filter(
      (c) => c.url.includes("charge_authorization") && c.body?.reference === ref1);

    // 1. Ambiguous ('pending') outcome — exactly one charge attempt.
    pay.mandateChargeDataStatus = "pending";
    pay.verifyStatuses.set(ref1, "pending"); // provider still processing
    try {
      await world.runCron("/api/scheduled/installment-due");
    } finally {
      pay.mandateChargeDataStatus = null;
    }
    assert(chargeCalls().length === 1, "exactly one charge attempt");

    // 2. Repeated due-sweeps CANNOT re-charge while the claim is held.
    const tick2 = await world.runCron("/api/scheduled/installment-due");
    assert(tick2.json?.captured === 0 && tick2.json?.skippedDuplicate >= 1,
      "claim blocks a blind re-charge (duplicate verdict)");
    assert(chargeCalls().length === 1, "STILL exactly one charge after re-sweep");

    // 3. Reconciler probes READ-ONLY; still pending → nothing moves.
    const recon1 = await pot.reconcilePendingPotCharges(world.db, {});
    assert(recon1.settled === 0 && recon1.failed === 0 && recon1.stillPending === 1,
      `still pending — no settle, no fail (got ${JSON.stringify(recon1)})`);
    assert(chargeCalls().length === 1, "reconciler never re-charges (read-only probe)");
    const [loanMid] = await world.db.select().from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, orig.loanId)).limit(1);
    assert(loanMid.outstandingCents === 123_000, "outstanding unmoved under ambiguity");

    // 4. Provider confirms → settle exactly once; replay is a no-op.
    pay.verifyStatuses.set(ref1, "success");
    const recon2 = await pot.reconcilePendingPotCharges(world.db, {});
    assert(recon2.settled === 1, "confirmed charge settles");
    const recon3 = await pot.reconcilePendingPotCharges(world.db, {});
    assert(recon3.checked === 0 && recon3.settled === 0, "no double settlement on replay");
    const [loanFinal] = await world.db.select().from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, orig.loanId)).limit(1);
    assert(loanFinal.outstandingCents === 82_000,
      `exactly one installment settled (got ${loanFinal.outstandingCents})`);
    assert(chargeCalls().length === 1, "exactly one provider charge end-to-end");
    const repayments = await world.db.select().from(schema.merchantLoanRepayments)
      .where(eq(schema.merchantLoanRepayments.reference, ref1));
    assert(repayments.length === 1, "exactly one repayment row");
  },
};
