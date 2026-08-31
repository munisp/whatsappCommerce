/**
 * J198 — W32 pay-over-time (Coder A): eligible merchant pays a vendor bill
 * over 3 installments.
 *
 * The vendor is paid IN FULL IMMEDIATELY from the platform lending facility
 * (locked funding leg asserted: credit_facilities FOR UPDATE decrement +
 * merchant_loan_funding row + exactly one TigerBeetle transfer via the
 * metaMock ledger bridge) — the merchant wallet is never touched. The bill
 * flips to 'paid' honestly with payment_ref `pot:<planId>` and
 * metadata.financing="pay_over_time". Installments are then captured on
 * schedule by the /api/scheduled/installment-due cron via the existing
 * mandate rails (deterministic refs `potcap:<planId>:<seq>`), each capture
 * restoring the facility by the principal portion and posting the
 * potrepay/potfee TB legs, until the plan AND the backing loan are repaid.
 */
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { seedLoanMerchant, LOAN_RACE_FACILITY_ID } from "./loanRaceSeed";
import { ledger } from "../metaMock";

const T = "sim-pot-198";
const FACILITY_SEED_CENTS = 1_000_000_000_00;

async function seedEligibleMerchant(world: World) {
  await seedLoanMerchant(world, T); // tenant + approved KYB + tier-B score signals
  const schema = await import("../../drizzle/schema");
  await world.db.insert(schema.tenantMemberships).values({
    tenantId: T, userId: "1981", role: "owner",
  }).onConflictDoNothing();
  // Active paystack mandate + gateway config for installment capture.
  await world.db.insert(schema.paymentGatewayConfigs).values({
    id: `pgc-${T}`, tenantId: T, provider: "paystack", secretKey: "sk_sim_test",
    isActive: true, enabled: true, priority: 0,
  }).onConflictDoNothing();
  await world.db.insert(schema.paymentMandates).values({
    tenantId: T, provider: "paystack", mandateRef: `sim-mandate-${T}`, status: "active",
  }).onConflictDoNothing();
}

async function backdateNextInstallment(world: World, planId: string) {
  const schema = await import("../../drizzle/schema");
  const [plan] = await world.db.select().from(schema.installmentPlans)
    .where(eq(schema.installmentPlans.id, planId)).limit(1);
  const next = (plan.schedule as any[]).find((e) => e.status !== "paid");
  const updated = (plan.schedule as any[]).map((e) =>
    e.seq === next.seq ? { ...e, dueAt: new Date(Date.now() - 60_000).toISOString() } : e);
  await world.db.update(schema.installmentPlans)
    .set({ schedule: updated, updatedAt: new Date() })
    .where(eq(schema.installmentPlans.id, planId));
  return next.seq;
}

export const journey: Journey = {
  id: "J198",
  name: "pay over time: bill paid in full, 3 installments captured",
  feature: "W32 pay-over-time installment bill pay",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const pot = await import("../../server/services/payOverTime");
    await seedEligibleMerchant(world);
    const caller = await tenantCaller(T, { userId: 1981 });

    const facilityCommitment = async () => {
      const [f] = await world.db.select().from(schema.creditFacilities)
        .where(eq(schema.creditFacilities.id, LOAN_RACE_FACILITY_ID)).limit(1);
      return f.commitmentCents as number;
    };
    const commitment0 = await facilityCommitment();
    assert(commitment0 === FACILITY_SEED_CENTS, "facility seeded at full commitment");

    // ── Eligibility surface is honest ──────────────────────────────────
    const elig = await caller.vendorBills.payOverTimeEligibility({ tenantId: T });
    assert(elig.eligible === true && elig.minScore === 600, `eligible (got ${JSON.stringify(elig)})`);

    // ── Create + originate ─────────────────────────────────────────────
    const created = await caller.vendorBills.create({
      tenantId: T, vendorName: "Ada Wholesale", billNumber: "INV-198",
      amountCents: 300_000, description: "60 cartons of noodles",
    });
    const billId = created.bill.id;

    const pay = await caller.vendorBills.recordPayment({
      tenantId: T, billId, payOverTime: { installments: 3 },
    });
    assert(pay.ok === true && pay.status === "paid", `bill paid honestly (got ${pay.status})`);
    assert(pay.chargedCents === 0, "merchant wallet NOT charged (facility funds the vendor)");
    assert(pay.paymentRef === `pot:${pay.planId}`, `payment_ref pot:<planId> (got ${pay.paymentRef})`);
    assert(pay.feeCents === 7_500, `fee = 250bps of principal (got ${pay.feeCents})`);
    assert(pay.totalRepayCents === 307_500, `outstanding = principal + fee (got ${pay.totalRepayCents})`);
    assert(typeof pay.message === "string" && pay.message.startsWith("Vendor paid in full"),
      `honest merchant copy (got ${pay.message})`);
    assert(pay.message.includes("3 installments"), "copy names the installment count");

    // Bill row: paid in full + financing metadata.
    const [bill] = await world.db.select().from(schema.vendorBills)
      .where(eq(schema.vendorBills.id, billId)).limit(1);
    assert(bill.status === "paid" && bill.paidCents === 300_000, "bill paid in full");
    assert((bill.metadata as any)?.financing === "pay_over_time", "metadata.financing recorded");

    // Wallet untouched: no wallet row was even created for this tenant.
    const wallets = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, T));
    assert(wallets.length === 0, "merchant wallet untouched by the principal");

    // ── Funding leg: facility decrement + funding row + TB transfer ────
    assert(await facilityCommitment() === commitment0 - 300_000, "facility decremented by the principal");
    const funding = await world.db.select().from(schema.merchantLoanFunding)
      .where(eq(schema.merchantLoanFunding.loanId, pay.loanId));
    assert(funding.length === 1 && funding[0].facilityId === LOAN_RACE_FACILITY_ID, "funding row persisted");
    assert(funding[0].ledgerRef === pot.potFundingRef(pay.loanId), "deterministic potfund ref");
    const fundTransfers = ledger.calls.filter(
      (c: any) => c.url.includes("/transfer") && c.body?.idempotency_key === `potfund:${pay.loanId}`);
    assert(fundTransfers.length === 1, `exactly one TB funding transfer (got ${fundTransfers.length})`);
    assert(Number(fundTransfers[0].body?.amount) === 300_000, "TB funding amount == principal");
    assert(fundTransfers[0].body?.debit_account_id === `credit-facility:${LOAN_RACE_FACILITY_ID}`,
      "TB debits the facility account");

    // Plan + loan state.
    const [plan] = await world.db.select().from(schema.installmentPlans)
      .where(eq(schema.installmentPlans.id, pay.planId)).limit(1);
    assert(plan.status === "active" && plan.installments === 3, "plan active with 3 installments");
    const schedule = plan.schedule as any[];
    assert(schedule.length === 3, "schedule stored on the plan");
    assert(schedule.every((e: any) => e.status === "due" && e.amountCents === 102_500),
      "3 equal installments of 102,500 cents");
    const [loan] = await world.db.select().from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, pay.loanId)).limit(1);
    assert(loan.outstandingCents === 307_500 && loan.tier === "POT", "loan outstanding = principal + fee");

    // ── Installments captured on schedule by the cron ──────────────────
    for (let seq = 1; seq <= 3; seq++) {
      const backdated = await backdateNextInstallment(world, pay.planId);
      assert(backdated === seq, `backdating installment ${seq}`);
      const outstandingBefore = (await world.db.select().from(schema.merchantLoans)
        .where(eq(schema.merchantLoans.id, pay.loanId)).limit(1))[0].outstandingCents;
      const commitmentBefore = await facilityCommitment();

      const tick = await world.runCron("/api/scheduled/installment-due");
      assert(tick.status === 200 && tick.json?.ok === true, `cron tick ok (got ${tick.status})`);
      assert(tick.json.captured === 1, `installment ${seq} captured (got ${JSON.stringify(tick.json)})`);

      // Mandate charge carried the deterministic reference.
      const charges = world.outbound.all().filter(
        (c) => c.url.includes("charge_authorization") && c.body?.reference === pot.potCaptureRef(pay.planId, seq));
      assert(charges.length === 1, `exactly one mandate charge for installment ${seq}`);

      const [loanAfter] = await world.db.select().from(schema.merchantLoans)
        .where(eq(schema.merchantLoans.id, pay.loanId)).limit(1);
      assert(loanAfter.outstandingCents === outstandingBefore - 102_500,
        `outstanding decremented by the installment (got ${loanAfter.outstandingCents})`);
      assert(await facilityCommitment() === commitmentBefore + 100_000,
        "facility restored by the principal portion");

      const [planAfter] = await world.db.select().from(schema.installmentPlans)
        .where(eq(schema.installmentPlans.id, pay.planId)).limit(1);
      const entry = (planAfter.schedule as any[]).find((e) => e.seq === seq);
      assert(entry.status === "paid" && typeof entry.paidAt === "string", `installment ${seq} marked paid`);

      // potrepay + potfee TB legs for this installment.
      const repayLegs = ledger.calls.filter(
        (c: any) => c.body?.idempotency_key === `potrepay:${pay.planId}:${seq}`);
      const feeLegs = ledger.calls.filter(
        (c: any) => c.body?.idempotency_key === `potfee:${pay.planId}:${seq}`);
      assert(repayLegs.length === 1 && Number(repayLegs[0].body?.amount) === 100_000, "principal leg to facility");
      assert(feeLegs.length === 1 && Number(feeLegs[0].body?.amount) === 2_500
        && feeLegs[0].body?.credit_account_id === "platform-fees:NGN", "fee leg to platform fees");
    }

    // ── Terminal state: plan + loan repaid, facility fully restored ────
    const [planFinal] = await world.db.select().from(schema.installmentPlans)
      .where(eq(schema.installmentPlans.id, pay.planId)).limit(1);
    assert(planFinal.status === "repaid", "plan repaid");
    const [loanFinal] = await world.db.select().from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, pay.loanId)).limit(1);
    assert(loanFinal.status === "repaid" && loanFinal.outstandingCents === 0, "loan repaid at zero");
    assert(await facilityCommitment() === commitment0, "facility fully restored after repayment");

    // Cron replay with nothing due is a no-op.
    const idle = await world.runCron("/api/scheduled/installment-due");
    assert(idle.json?.captured === 0, "idle sweep captures nothing");

    // Repay replay: paying the paid bill again is an honest CONFLICT.
    const again = await caller.vendorBills.recordPayment({
      tenantId: T, billId, payOverTime: { installments: 3 },
    }).catch((e: any) => e);
    assert(again?.code === "CONFLICT" || again?.data?.code === "CONFLICT", "re-origination rejects CONFLICT");
  },
};
