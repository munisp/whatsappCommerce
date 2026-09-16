/**
 * J257 — W38 PAY-5: early-settle full lifecycle — no permanently stuck
 * states.
 *
 *  A. PENDING settle charge → durable pot_charges row, claim kept, plan
 *     stays honestly active. Retry while still pending → honest CONFLICT
 *     (in-flight), NO second charge. When the provider confirms, the retry
 *     settles VERIFY-FIRST (no new charge) and closes the plan.
 *  B. PENDING settle charge that ultimately FAILS at the provider → the
 *     retry verifies, flips the row 'failed', RELEASES the claim ("abandon
 *     settle"), and a fresh settle attempt succeeds — the plan is never
 *     stuck behind a dead claim.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { seedLoanMerchant } from "./loanRaceSeed";
import { pay } from "../metaMock";

const T = "sim-pot-257";

async function seed(world: World) {
  const schema = await import("../../drizzle/schema");
  await seedLoanMerchant(world, T);
  await world.db.update(schema.tenants).set({
    whatsappPhoneNumberId: `pn_${T}`,
    settings: { whatsapp: { accessToken: "sim_wa_token" }, adminPhone: "2349025700257" },
  }).where(eq(schema.tenants.id, T));
  await world.db.insert(schema.tenantMemberships).values({
    tenantId: T, userId: "2571", role: "owner",
  }).onConflictDoNothing();
  await world.db.insert(schema.paymentGatewayConfigs).values({
    id: `pgc-${T}`, tenantId: T, provider: "paystack", secretKey: "sk_sim_test",
    isActive: true, enabled: true, priority: 0,
  }).onConflictDoNothing();
  await world.db.insert(schema.paymentMandates).values({
    tenantId: T, provider: "paystack", mandateRef: `sim-mandate-${T}`, status: "active",
  }).onConflictDoNothing();
}

async function originate(caller: any, vendorName: string) {
  const bill = await caller.vendorBills.create({ tenantId: T, vendorName, amountCents: 120_000 });
  const orig = await caller.vendorBills.recordPayment({
    tenantId: T, billId: bill.bill.id, payOverTime: { installments: 3 },
  });
  assert(orig.ok === true, `origination succeeds for ${vendorName}`);
  return orig;
}

export const journey: Journey = {
  id: "J257",
  name: "pay over time: early-settle pending lifecycle closes stuck states (PAY-5)",
  feature: "W38 pay-over-time reconciliation",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const pot = await import("../../server/services/payOverTime");

    await seed(world);
    const caller = await tenantCaller(T, { userId: 2571 });

    // ── A. pending → verify-first settle on retry ──────────────────────
    const origA = await originate(caller, "Aba Fabrics");
    const planA = origA.planId;
    const refA = pot.potSettleRef(planA);
    const settleChargesA = () => world.outbound.all().filter(
      (c) => c.url.includes("charge_authorization") && c.body?.reference === refA);

    pay.mandateChargeDataStatus = "pending";
    pay.verifyStatuses.set(refA, "pending");
    const firstAttempt = await caller.vendorBills.settlePlanEarly({ tenantId: T, planId: planA })
      .catch((e: any) => e);
    pay.mandateChargeDataStatus = null;
    assert(firstAttempt?.code === "CONFLICT" || firstAttempt?.data?.code === "CONFLICT",
      "pending settle charge → honest CONFLICT");
    assert(/pending at the provider/.test(firstAttempt?.message ?? ""), "honest pending copy");
    assert(settleChargesA().length === 1, "one settle charge sent");

    const [rowA] = await world.db.select().from(schema.potCharges)
      .where(eq(schema.potCharges.reference, refA)).limit(1);
    assert(rowA && rowA.status === "pending" && rowA.kind === "settle",
      "durable pending settle row (reconciler-visible)");
    const [planAmid] = await world.db.select().from(schema.installmentPlans)
      .where(eq(schema.installmentPlans.id, planA)).limit(1);
    assert(planAmid.status === "active", "plan honestly still active while pending");

    // Retry while STILL pending → CONFLICT in-flight, no second charge.
    const inflight = await caller.vendorBills.settlePlanEarly({ tenantId: T, planId: planA })
      .catch((e: any) => e);
    assert(inflight?.code === "CONFLICT" || inflight?.data?.code === "CONFLICT", "in-flight retry → CONFLICT");
    assert(/in flight/.test(inflight?.message ?? ""), `honest in-flight copy (got ${inflight?.message})`);
    assert(settleChargesA().length === 1, "no blind second charge while in flight");

    // Provider confirms → the retry settles VERIFY-FIRST (no new charge).
    pay.verifyStatuses.set(refA, "success");
    const settledA = await caller.vendorBills.settlePlanEarly({ tenantId: T, planId: planA });
    assert(settledA.ok === true && settledA.status === "repaid", "verify-first settle succeeds on retry");
    assert(settleChargesA().length === 1, "settled WITHOUT a second provider charge");
    const [planAdone] = await world.db.select().from(schema.installmentPlans)
      .where(eq(schema.installmentPlans.id, planA)).limit(1);
    assert(planAdone.status === "repaid", "plan A repaid");
    assert((planAdone.schedule as any[]).every((e) => e.status === "paid"), "all A entries paid");
    const [loanA] = await world.db.select().from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, origA.loanId)).limit(1);
    assert(loanA.status === "repaid" && loanA.outstandingCents === 0, "loan A closed at zero");
    const [rowAdone] = await world.db.select().from(schema.potCharges)
      .where(eq(schema.potCharges.reference, refA)).limit(1);
    assert(rowAdone.status === "success", "pot_charges row closed success");

    // ── B. pending → definitive provider failure → abandon + fresh retry ──
    const origB = await originate(caller, "Kano Leather");
    const planB = origB.planId;
    const refB = pot.potSettleRef(planB);
    const settleChargesB = () => world.outbound.all().filter(
      (c) => c.url.includes("charge_authorization") && c.body?.reference === refB);

    pay.mandateChargeDataStatus = "pending";
    pay.verifyStatuses.set(refB, "pending");
    const bFirst = await caller.vendorBills.settlePlanEarly({ tenantId: T, planId: planB })
      .catch((e: any) => e);
    pay.mandateChargeDataStatus = null;
    assert(bFirst?.code === "CONFLICT" || bFirst?.data?.code === "CONFLICT", "B: pending charge → CONFLICT");

    // Provider says the pending charge FAILED → abandon settle: claim
    // released, durable row failed, caller told to retry.
    pay.verifyStatuses.set(refB, "failed");
    const bAbandon = await caller.vendorBills.settlePlanEarly({ tenantId: T, planId: planB })
      .catch((e: any) => e);
    assert(bAbandon?.code === "CONFLICT" || bAbandon?.data?.code === "CONFLICT", "B: failed verify → CONFLICT");
    assert(/failed at the provider.*retry/i.test(bAbandon?.message ?? ""),
      `honest abandon copy (got ${bAbandon?.message})`);
    const [rowB] = await world.db.select().from(schema.potCharges)
      .where(eq(schema.potCharges.reference, refB)).limit(1);
    assert(rowB.status === "failed", "durable row flipped failed");
    assert(settleChargesB().length === 1, "no charge sent during abandon");

    // Fresh attempt now succeeds — the plan is NOT stuck.
    pay.verifyStatuses.delete(refB);
    const bRetry = await caller.vendorBills.settlePlanEarly({ tenantId: T, planId: planB });
    assert(bRetry.ok === true && bRetry.status === "repaid", "fresh settle succeeds after abandon");
    assert(settleChargesB().length === 2, "exactly one FRESH charge after the definitive failure");
    const [planBdone] = await world.db.select().from(schema.installmentPlans)
      .where(eq(schema.installmentPlans.id, planB)).limit(1);
    assert(planBdone.status === "repaid", "plan B repaid — never stuck");
    const [loanB] = await world.db.select().from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, origB.loanId)).limit(1);
    assert(loanB.outstandingCents === 0 && loanB.status === "repaid", "loan B closed at zero");
  },
};
