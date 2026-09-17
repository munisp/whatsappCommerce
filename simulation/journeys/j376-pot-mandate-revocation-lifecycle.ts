/**
 * === W45 money-ledger (Coder B3) ===
 * J376 — PAY-20: mandate revocation lifecycle.
 *  1. Revoke → active PoT plans flip to 'paused' (auto-capture stops; the
 *     due sweep does NOT capture or dun them — infinite dunning ends), and
 *     the merchant gets a re-link CTA + manual payment-link URL on the admin
 *     channel.
 *  2. Manual fallback: the payment link is idempotent (same reference on
 *     repeat); when the intent completes, the sweep settles the plan EXACTLY
 *     once (plan + loan repaid) and sends a receipt.
 *  3. Admin restructure re-splits the remaining balance (paused while no
 *     mandate); confirming a NEW mandate resumes the plan; admin cancel is a
 *     terminal audited write-off (replay CONFLICT).
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { seedLoanMerchant } from "./loanRaceSeed";

const T = "sim-pot-376";
const ADMIN_PHONE = "2349037600376";

export const journey: Journey = {
  id: "J376",
  name: "pay over time: mandate revoke → pause + re-link CTA + manual link; restructure/resume/cancel (PAY-20)",
  feature: "W45 money-ledger: mandate revocation lifecycle",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const pot = await import("../../server/services/payOverTime");
    const mandates = await import("../../server/services/payments/mandates");

    await seedLoanMerchant(world, T);
    await world.db.update(schema.tenants).set({
      whatsappPhoneNumberId: `pn_${T}`,
      settings: { whatsapp: { accessToken: "sim_wa_token" }, adminPhone: ADMIN_PHONE },
    }).where(eq(schema.tenants.id, T));
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T, userId: "3761", role: "owner",
    }).onConflictDoNothing();
    await world.db.insert(schema.paymentGatewayConfigs).values({
      id: `pgc-${T}`, tenantId: T, provider: "paystack", secretKey: "sk_sim_test",
      isActive: true, enabled: true, priority: 0,
    }).onConflictDoNothing();
    const [m1] = await world.db.insert(schema.paymentMandates).values({
      tenantId: T, provider: "fake", mandateRef: `fake-mandate-${T}-1`, status: "active",
    }).returning({ id: schema.paymentMandates.id });

    const caller = await tenantCaller(T, { userId: 3761 });
    const originate = async (vendor: string) => {
      const bill = await caller.vendorBills.create({ tenantId: T, vendorName: vendor, amountCents: 120_000 });
      const orig = await caller.vendorBills.recordPayment({
        tenantId: T, billId: bill.bill.id, payOverTime: { installments: 3 },
      });
      assert(orig.ok === true, "origination succeeds");
      // Backdate installment 1 so it is due for capture.
      const [p] = await world.db.select().from(schema.installmentPlans)
        .where(eq(schema.installmentPlans.id, orig.planId)).limit(1);
      const sched = (p.schedule as any[]).map((e) =>
        e.seq === 1 ? { ...e, dueAt: new Date(Date.now() - 60_000).toISOString() } : e);
      await world.db.update(schema.installmentPlans).set({ schedule: sched, updatedAt: new Date() })
        .where(eq(schema.installmentPlans.id, orig.planId));
      return orig.planId;
    };
    const planStatus = async (planId: string) => {
      const [p] = await world.db.select().from(schema.installmentPlans).where(eq(schema.installmentPlans.id, planId));
      return p?.status;
    };

    // ── 1. Revoke → paused + CTA + manual link, no dunning ───────────────
    const plan1 = await originate("Revoke Supplier A");
    const dunningBefore = world.outbound.findByBody("couldn't collect", ADMIN_PHONE).length;
    const rev = await mandates.revokeMandate(world.db, { tenantId: T, mandateId: m1.id });
    assert(rev.ok === true, "revoke ok");
    assert((await planStatus(plan1)) === "paused", "plan paused on revocation");
    const cta = world.outbound.findByBody("PAUSED", ADMIN_PHONE);
    assert(cta.length >= 1, "re-link CTA notice sent to the admin");
    assert(JSON.stringify(cta[0].body).includes("Pay here"), "CTA carries the manual payment link");

    const sweep1 = await pot.runInstallmentCaptureSweep(world.db, {});
    assert(sweep1.captured === 0 && sweep1.dunned === 0, `paused plan never captured/dunned (${JSON.stringify(sweep1)})`);
    assert(world.outbound.findByBody("couldn't collect", ADMIN_PHONE).length === dunningBefore, "dunning ENDED — no infinite retry storm");

    // ── 2. Manual payment-link fallback settles exactly once ─────────────
    const link1 = await pot.createPotManualPaymentLink(world.db, { tenantId: T, planId: plan1 });
    assert(link1.ok === true && link1.paymentUrl, `manual link minted (${JSON.stringify(link1)})`);
    const link2 = await pot.createPotManualPaymentLink(world.db, { tenantId: T, planId: plan1 });
    assert(link2.ok === true && link2.reference === link1.reference, "manual link idempotent (same reference)");
    // Provider confirms the manual payment (pinned paymentConfirm flips the
    // intent to completed; the sweep settles — adjacent seam only).
    await world.db.update(schema.paymentIntents)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.paymentIntents.idempotencyKey, `pot-manual:${plan1}`));
    const sweep2 = await pot.runInstallmentCaptureSweep(world.db, {});
    assert(sweep2.manualSettled === 1, `manual payment settled (${JSON.stringify(sweep2)})`);
    assert((await planStatus(plan1)) === "repaid", "plan repaid via manual link");
    const [plan1Row] = await world.db.select().from(schema.installmentPlans).where(eq(schema.installmentPlans.id, plan1));
    const [loan1] = await world.db.select().from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, plan1Row.loanId ?? ""));
    assert(loan1.status === "repaid" && loan1.outstandingCents === 0, "loan closed");
    assert(world.outbound.findByBody("settled in full", ADMIN_PHONE).length >= 1, "manual-settle receipt sent");
    const sweep3 = await pot.runInstallmentCaptureSweep(world.db, {});
    assert(sweep3.manualSettled === 0, "manual settle replay is a no-op");

    // ── 3. Restructure → resume on re-link → admin cancel ────────────────
    const plan2 = await originate("Revoke Supplier B");
    const [m2] = await world.db.insert(schema.paymentMandates).values({
      tenantId: T, provider: "fake", mandateRef: `fake-mandate-${T}-2`, status: "active",
    }).returning({ id: schema.paymentMandates.id });
    await mandates.revokeMandate(world.db, { tenantId: T, mandateId: m2.id });
    assert((await planStatus(plan2)) === "paused", "plan2 paused on revocation");

    const rs = await pot.adminRestructurePlan(world.db, {
      tenantId: T, planId: plan2, installments: 6, actor: "admin-j376", note: "hardship restructure",
    });
    assert(rs.ok === true && rs.status === "paused", "restructure stays paused without a mandate");
    const unpaid = rs.schedule.filter((e) => e.status !== "paid");
    assert(unpaid.length === 6, "re-split into 6 installments");
    assert(unpaid.reduce((a, e) => a + e.amountCents, 0) === 123_000, "restructure preserves the exact remaining balance");

    const m3 = await mandates.createMandateForTenant(world.db, { tenantId: T });
    assert(m3.ok === true && m3.mandateId, "new mandate created (dev fake)");
    // Dev fake mandates are immediately active; resume rides confirmMandateTx
    // for pending ones — call the resume seam directly for the fake-active row.
    await pot.resumePotPlansOnMandateLink(world.db, T);
    assert((await planStatus(plan2)) === "active", "plan resumed after re-link");
    assert(world.outbound.findByBody("RESUMED", ADMIN_PHONE).length >= 1, "resume notice sent");

    const cancel = await pot.adminCancelPlan(world.db, {
      tenantId: T, planId: plan2, actor: "admin-j376", reason: "merchant hardship — facility absorbs",
    });
    assert(cancel.ok === true && cancel.writeOffCents === 123_000, `cancel writes off honestly (${JSON.stringify(cancel)})`);
    assert((await planStatus(plan2)) === "cancelled", "plan cancelled");
    const [loan2row] = await world.db.select().from(schema.installmentPlans).where(eq(schema.installmentPlans.id, plan2));
    const [loan2] = await world.db.select().from(schema.merchantLoans).where(eq(schema.merchantLoans.id, loan2row.loanId ?? ""));
    assert(loan2.status === "cancelled" && loan2.outstandingCents === 0, "loan closed as cancelled write-off");
    let threw = false;
    await pot.adminCancelPlan(world.db, { tenantId: T, planId: plan2, actor: "admin-j376", reason: "replay" }).catch(() => { threw = true; });
    assert(threw, "cancel replay refuses (CONFLICT)");
  },
};
