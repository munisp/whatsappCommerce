/**
 * J255 — W38 PAY-4: a PENDING pay-over-time installment charge reconciles
 * to settled.
 *
 * Pre-fix: captureInstallment kept the `potcap:` claim and the entry 'due'
 * on a pending provider charge, but nothing ever wrote the reconciler's
 * scan set — money that later succeeded at the provider was NEVER settled
 * against the loan. Post-fix:
 *
 *  1. Pending mandate charge → durable pot_charges row (status 'pending'),
 *     claim kept, entry stays honestly 'due', outstanding unmoved.
 *  2. Provider later confirms (read-only fetchStatus) → the
 *     reconcilePendingPotCharges sweep settles EXACTLY ONCE via the same
 *     reference: loan outstanding decrements, schedule entry paid, row
 *     flips 'success'.
 *  3. Re-running the sweep is a no-op (exactly-once: repayment reference
 *     unique index + claim-first flip) — never a double settlement.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { seedLoanMerchant } from "./loanRaceSeed";
import { pay } from "../metaMock";

const T = "sim-pot-255";
const ADMIN_PHONE = "2349025500255";

async function seed(world: World) {
  const schema = await import("../../drizzle/schema");
  await seedLoanMerchant(world, T);
  await world.db.update(schema.tenants).set({
    whatsappPhoneNumberId: `pn_${T}`,
    settings: { whatsapp: { accessToken: "sim_wa_token" }, adminPhone: ADMIN_PHONE },
  }).where(eq(schema.tenants.id, T));
  await world.db.insert(schema.tenantMemberships).values({
    tenantId: T, userId: "2551", role: "owner",
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
  id: "J255",
  name: "pay over time: pending installment charge reconciles to settled (PAY-4)",
  feature: "W38 pay-over-time reconciliation",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const pot = await import("../../server/services/payOverTime");

    await seed(world);
    const caller = await tenantCaller(T, { userId: 2551 });
    const bill = await caller.vendorBills.create({
      tenantId: T, vendorName: "Aba Fabrics", amountCents: 120_000,
    });
    const orig = await caller.vendorBills.recordPayment({
      tenantId: T, billId: bill.bill.id, payOverTime: { installments: 3 },
    });
    assert(orig.ok === true, "origination succeeds");
    const planId = orig.planId;
    // fee 250bps × 120,000 = 3,000 → 123,000 total → 41,000/installment.

    // Backdate installment 1 so it is due.
    const [planRow] = await world.db.select().from(schema.installmentPlans)
      .where(eq(schema.installmentPlans.id, planId)).limit(1);
    const schedule = (planRow.schedule as any[]).map((e) =>
      e.seq === 1 ? { ...e, dueAt: new Date(Date.now() - 60_000).toISOString() } : e);
    await world.db.update(schema.installmentPlans)
      .set({ schedule, updatedAt: new Date() })
      .where(eq(schema.installmentPlans.id, planId));

    // 1. Provider ACCEPTS but money has not moved (status 'pending').
    pay.mandateChargeDataStatus = "pending";
    const ref1 = pot.potCaptureRef(planId, 1);
    try {
      const tick = await world.runCron("/api/scheduled/installment-due");
      assert(tick.status === 200 && tick.json?.ok === true, "cron tick ok");
      assert(tick.json.captured === 0, "pending charge is not a capture");
    } finally {
      pay.mandateChargeDataStatus = null;
    }

    const [planMid] = await world.db.select().from(schema.installmentPlans)
      .where(eq(schema.installmentPlans.id, planId)).limit(1);
    assert((planMid.schedule as any[]).find((e) => e.seq === 1).status === "due",
      "entry stays honestly 'due' while the charge is pending");
    const [loanMid] = await world.db.select().from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, orig.loanId)).limit(1);
    assert(loanMid.outstandingCents === 123_000, "outstanding unmoved while pending");

    // Durable reconciler-visible row exists (THE PAY-4 fix).
    const [chargeRow] = await world.db.select().from(schema.potCharges)
      .where(eq(schema.potCharges.reference, ref1)).limit(1);
    assert(chargeRow, "pending charge persisted to pot_charges (reconciler-visible)");
    assert(chargeRow.status === "pending" && chargeRow.kind === "installment" && chargeRow.seq === 1,
      `row is a pending installment charge (got ${chargeRow.status}/${chargeRow.kind})`);
    assert(chargeRow.amountCents === 41_000, "charge amount persisted in cents");

    // 2. Provider confirms → sweep settles exactly once.
    pay.verifyStatuses.set(ref1, "success");
    const recon = await pot.reconcilePendingPotCharges(world.db, {});
    assert(recon.checked >= 1 && recon.settled === 1 && recon.failed === 0,
      `reconciler settles the confirmed charge (got ${JSON.stringify(recon)})`);

    const [planSettled] = await world.db.select().from(schema.installmentPlans)
      .where(eq(schema.installmentPlans.id, planId)).limit(1);
    assert((planSettled.schedule as any[]).find((e) => e.seq === 1).status === "paid",
      "installment 1 paid after reconciliation");
    const [loanSettled] = await world.db.select().from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, orig.loanId)).limit(1);
    assert(loanSettled.outstandingCents === 123_000 - 41_000,
      `outstanding settled by exactly one installment (got ${loanSettled.outstandingCents})`);
    const [chargeAfter] = await world.db.select().from(schema.potCharges)
      .where(eq(schema.potCharges.reference, ref1)).limit(1);
    assert(chargeAfter.status === "success", "pot_charges row flipped to success");

    const repayments = await world.db.select().from(schema.merchantLoanRepayments)
      .where(eq(schema.merchantLoanRepayments.reference, ref1));
    assert(repayments.length === 1, "exactly one repayment row for the reference");

    // 3. Sweep replay is a no-op — never a double settlement.
    const recon2 = await pot.reconcilePendingPotCharges(world.db, {});
    assert(recon2.settled === 0 && recon2.checked === 0, "replay settles nothing");
    const [loanFinal] = await world.db.select().from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, orig.loanId)).limit(1);
    assert(loanFinal.outstandingCents === 82_000, "outstanding unchanged after replay");
  },
};
