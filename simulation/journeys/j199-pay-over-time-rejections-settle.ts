/**
 * J199 — W32 pay-over-time (Coder A): honest negatives + early settle.
 *
 *  1. INELIGIBLE SCORE → recordPayment(payOverTime) rejects honestly with
 *     pay_over_time_ineligible: the bill stays pending, no plan, no loan,
 *     no facility decrement, no TB transfer — NOTHING moves.
 *  2. KYB NOT APPROVED → same honest rejection (fail-closed gate).
 *  3. FAILED INSTALLMENT CAPTURE (scripted provider decline) → the
 *     installment is marked honestly 'overdue', a WhatsApp dunning notice
 *     goes to the tenant admin, outstanding does NOT move, and the next
 *     sweep retries per the mandate rules (claim released, not faked).
 *  4. EARLY SETTLE → one mandate charge for the remaining balance
 *     (documented default policy: full fee, earned at origination) → plan
 *     AND loan repaid; replay rejects CONFLICT.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller, expectTrpcError } from "./helpers";
import { seedLoanMerchant, LOAN_RACE_FACILITY_ID } from "./loanRaceSeed";
import { ledger, pay } from "../metaMock";

const T_LOW = "sim-pot-199-low";
const T_NOKYB = "sim-pot-199-nokyb";
const T_OK = "sim-pot-199";
const ADMIN_PHONE = "2349019900199";

async function seedTenant(world: World, tenantId: string, opts: { kyb: boolean; userId: string }) {
  const schema = await import("../../drizzle/schema");
  await world.db.insert(schema.tenants).values({
    id: tenantId, name: `PoT 199 (${tenantId})`, slug: tenantId, status: "active",
  }).onConflictDoNothing();
  await world.db.insert(schema.tenantMemberships).values({
    tenantId, userId: opts.userId, role: "owner",
  }).onConflictDoNothing();
  if (opts.kyb) {
    await world.db.insert(schema.kycApplications).values({
      id: `kyb-${tenantId}`, tenantId, type: "kyb", status: "approved",
      applicantName: "Sim Owner", businessName: tenantId,
    }).onConflictDoNothing();
  }
}

export const journey: Journey = {
  id: "J199",
  name: "pay over time: ineligible rejection, failed capture dunning, early settle",
  feature: "W32 pay-over-time installment bill pay",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const pot = await import("../../server/services/payOverTime");

    const facilityCommitment = async () => {
      const [f] = await world.db.select().from(schema.creditFacilities)
        .where(eq(schema.creditFacilities.id, LOAN_RACE_FACILITY_ID)).limit(1);
      return f.commitmentCents as number;
    };
    const plansFor = async (tenantId: string) =>
      world.db.select().from(schema.installmentPlans).where(eq(schema.installmentPlans.tenantId, tenantId));

    // ── 1. Ineligible score → honest rejection, nothing moves ──────────
    await seedTenant(world, T_LOW, { kyb: true, userId: "1991" }); // KYB ok, zero sales history
    const callerLow = await tenantCaller(T_LOW, { userId: 1991 });
    const billLow = await callerLow.vendorBills.create({
      tenantId: T_LOW, vendorName: "Sola Trading", amountCents: 200_000,
    });
    const commitmentBefore = await facilityCommitment();
    const ledgerCallsBefore = ledger.calls.length;

    const elig = await callerLow.vendorBills.payOverTimeEligibility({ tenantId: T_LOW });
    assert(elig.eligible === false && elig.reason === "score_below_minimum",
      `honest ineligibility verdict (got ${JSON.stringify(elig)})`);
    const rejected = await callerLow.vendorBills.recordPayment({
      tenantId: T_LOW, billId: billLow.bill.id, payOverTime: { installments: 3 },
    }).catch((e: any) => e);
    assert(rejected?.code === "BAD_REQUEST" || rejected?.data?.code === "BAD_REQUEST", "ineligible → BAD_REQUEST");
    assert(/pay_over_time_ineligible/.test(rejected?.message ?? ""), `honest reason (got ${rejected?.message})`);

    const [billLowAfter] = await world.db.select().from(schema.vendorBills)
      .where(eq(schema.vendorBills.id, billLow.bill.id)).limit(1);
    assert(billLowAfter.status === "pending" && billLowAfter.paidCents === 0, "bill untouched (still pending)");
    assert((await plansFor(T_LOW)).length === 0, "no plan created for the rejection");
    assert(await facilityCommitment() === commitmentBefore, "facility untouched by the rejection");
    assert(ledger.calls.length === ledgerCallsBefore, "no TB transfer for the rejection");

    // ── 2. KYB not approved → fail-closed honest rejection ─────────────
    await seedTenant(world, T_NOKYB, { kyb: false, userId: "1992" });
    const callerNoKyb = await tenantCaller(T_NOKYB, { userId: 1992 });
    const billNoKyb = await callerNoKyb.vendorBills.create({
      tenantId: T_NOKYB, vendorName: "Kano Depot", amountCents: 100_000,
    });
    const kybRejected = await callerNoKyb.vendorBills.recordPayment({
      tenantId: T_NOKYB, billId: billNoKyb.bill.id, payOverTime: { installments: 6 },
    }).catch((e: any) => e);
    assert(/pay_over_time_ineligible.*KYB/.test(kybRejected?.message ?? ""),
      `KYB gate named honestly (got ${kybRejected?.message})`);
    assert((await plansFor(T_NOKYB)).length === 0, "no plan without KYB");

    // ── 3. Failed installment capture → overdue + WA dunning ───────────
    await seedLoanMerchant(world, T_OK); // eligible score + approved KYB
    // (tenant row already exists from seedLoanMerchant → settings set via UPDATE below)
    await world.db.update(schema.tenants).set({
      whatsappPhoneNumberId: `pn_${T_OK}`,
      settings: { whatsapp: { accessToken: "sim_wa_token" }, adminPhone: ADMIN_PHONE },
    }).where(eq(schema.tenants.id, T_OK));
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T_OK, userId: "1993", role: "owner",
    }).onConflictDoNothing();
    await world.db.insert(schema.paymentGatewayConfigs).values({
      id: `pgc-${T_OK}`, tenantId: T_OK, provider: "paystack", secretKey: "sk_sim_test",
      isActive: true, enabled: true, priority: 0,
    }).onConflictDoNothing();
    await world.db.insert(schema.paymentMandates).values({
      tenantId: T_OK, provider: "paystack", mandateRef: `sim-mandate-${T_OK}`, status: "active",
    }).onConflictDoNothing();
    const callerOk = await tenantCaller(T_OK, { userId: 1993 });

    const bill = await callerOk.vendorBills.create({
      tenantId: T_OK, vendorName: "Ikeja Plastics", amountCents: 120_000,
    });
    const orig = await callerOk.vendorBills.recordPayment({
      tenantId: T_OK, billId: bill.bill.id, payOverTime: { installments: 3 },
    });
    assert(orig.ok === true && orig.status === "paid", "origination succeeds for the eligible merchant");
    const planId = orig.planId;
    // fee = 250bps × 120,000 = 3,000 → total 123,000 → 41,000/installment.

    // Script a DEFINITIVE provider decline for mandate charges.
    pay.mandateChargeStatus = 400;
    try {
      const [planRow] = await world.db.select().from(schema.installmentPlans)
        .where(eq(schema.installmentPlans.id, planId)).limit(1);
      const schedule = (planRow.schedule as any[]).map((e) =>
        e.seq === 1 ? { ...e, dueAt: new Date(Date.now() - 60_000).toISOString() } : e);
      await world.db.update(schema.installmentPlans)
        .set({ schedule, updatedAt: new Date() })
        .where(eq(schema.installmentPlans.id, planId));

      const tick = await world.runCron("/api/scheduled/installment-due");
      assert(tick.status === 200 && tick.json?.ok === true, "cron tick ok");
      assert(tick.json.captured === 0 && tick.json.overdue === 1 && tick.json.dunned === 1,
        `failed capture → honest overdue + dunning (got ${JSON.stringify(tick.json)})`);

      const [planAfter] = await world.db.select().from(schema.installmentPlans)
        .where(eq(schema.installmentPlans.id, planId)).limit(1);
      const entry1 = (planAfter.schedule as any[]).find((e) => e.seq === 1);
      assert(entry1.status === "overdue", "installment honestly overdue (not faked paid)");
      const [loanMid] = await world.db.select().from(schema.merchantLoans)
        .where(eq(schema.merchantLoans.id, orig.loanId)).limit(1);
      assert(loanMid.outstandingCents === 123_000, "outstanding unmoved by the failed capture");

      // WA dunning actually went out to the admin phone.
      const dunning = world.outbound.findByBody("couldn't collect installment", ADMIN_PHONE);
      assert(dunning.length >= 1, "WA dunning notice sent to the admin phone");
      assert(JSON.stringify(dunning[0].body).includes("already paid in full"), "dunning copy stays honest about the vendor");

      // Next sweep RETRIES per the mandate rules (claim was released): with
      // the decline still scripted, it fails again — and does not double-dun
      // into a fake success.
      const tick2 = await world.runCron("/api/scheduled/installment-due");
      assert(tick2.json?.captured === 0 && tick2.json?.overdue === 1, "mandate-rule retry attempted honestly");
    } finally {
      pay.mandateChargeStatus = null;
    }

    // Recovery: the decline clears, the overdue installment captures.
    const tick3 = await world.runCron("/api/scheduled/installment-due");
    assert(tick3.json?.captured === 1, `overdue installment recovers on the next sweep (got ${JSON.stringify(tick3.json)})`);
    const [planRec] = await world.db.select().from(schema.installmentPlans)
      .where(eq(schema.installmentPlans.id, planId)).limit(1);
    assert((planRec.schedule as any[]).find((e) => e.seq === 1).status === "paid", "installment 1 now paid");

    // ── 4. Early settle (default policy: full fee) ─────────────────────
    const settle = await callerOk.vendorBills.settlePlanEarly({ tenantId: T_OK, planId });
    assert(settle.ok === true && settle.status === "repaid", "early settle succeeds");
    assert(settle.settleCents === 82_000, `remaining 2 installments in full (got ${settle.settleCents})`);
    assert(settle.feePolicy === "full_fee" && settle.waivedFeeCents === 0, "documented default fee policy");
    const settleCharges = world.outbound.all().filter(
      (c) => c.url.includes("charge_authorization") && c.body?.reference === pot.potSettleRef(planId));
    assert(settleCharges.length === 1, "exactly one settle charge (claim-first)");

    const [planFinal] = await world.db.select().from(schema.installmentPlans)
      .where(eq(schema.installmentPlans.id, planId)).limit(1);
    assert(planFinal.status === "repaid", "plan repaid after early settle");
    assert((planFinal.schedule as any[]).every((e) => e.status === "paid"), "all schedule entries paid");
    const [loanFinal] = await world.db.select().from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, orig.loanId)).limit(1);
    assert(loanFinal.status === "repaid" && loanFinal.outstandingCents === 0, "loan closed at zero");

    // Replay: settling a repaid plan is an honest CONFLICT, no 2nd charge.
    const replay = await callerOk.vendorBills.settlePlanEarly({ tenantId: T_OK, planId }).catch((e: any) => e);
    assert(replay?.code === "CONFLICT" || replay?.data?.code === "CONFLICT", "settle replay rejects CONFLICT");
    const settleChargesAfter = world.outbound.all().filter(
      (c) => c.url.includes("charge_authorization") && c.body?.reference === pot.potSettleRef(planId));
    assert(settleChargesAfter.length === 1, "no second settle charge");

    // Cross-tenant read of another tenant's plan is impossible (guard).
    const other = await callerLow.vendorBills.settlePlanEarly({ tenantId: T_LOW, planId }).catch((e: any) => e);
    assert(other?.code === "NOT_FOUND" || other?.data?.code === "NOT_FOUND", "tenant-guarded plan access");
  },
};
