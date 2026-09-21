/**
 * === W45 money-ledger (Coder B3) ===
 * J375 — PAY-18 + PAY-19: PoT TigerBeetle legs ride the post-commit outbox
 * and fee legs post to the PLAN-CURRENCY platform-fees account.
 *  1. Origination commits PG-only (facility decrement + loan + plan + bill
 *     paid) with a payment_outbox row `potfund:<loanId>` — NO in-transaction
 *     ledger-bridge call. The worker then delivers the TB transfer
 *     (deterministic idempotency key == the outbox reference).
 *  2. Installment capture (fake mandate, non-NGN USD plan) enqueues
 *     `potrepay:` + `potfee:` legs; the fee leg credits
 *     `platform-fees:USD` — NEVER a hardcoded NGN account.
 *  3. Worker delivery is exactly-once: a second tick delivers nothing.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import { ledgerAccountId, LEDGER_ACCOUNT_KINDS } from "../../server/services/ledgerAccounts";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { seedLoanMerchant } from "./loanRaceSeed";
import { ledger, meta } from "../metaMock";

const T = "sim-pot-375";
const ADMIN_PHONE = "2349037500375";

export const journey: Journey = {
  id: "J375",
  name: "pay over time: TB legs via post-commit outbox; per-currency platform-fees account (PAY-18/19)",
  feature: "W45 money-ledger: PoT ledger outbox",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const pot = await import("../../server/services/payOverTime");
    const outbox = await import("../../server/services/paymentOutbox");

    await seedLoanMerchant(world, T);
    await world.db.update(schema.tenants).set({
      whatsappPhoneNumberId: `pn_${T}`,
      settings: { whatsapp: { accessToken: "sim_wa_token" }, adminPhone: ADMIN_PHONE },
    }).where(eq(schema.tenants.id, T));
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T, userId: "3751", role: "owner",
    }).onConflictDoNothing();
    // Dev fake mandate (NODE_ENV=test): charges succeed without provider I/O.
    await world.db.insert(schema.paymentMandates).values({
      tenantId: T, provider: "fake", mandateRef: `fake-mandate-${T}`, status: "active",
    }).onConflictDoNothing();

    const caller = await tenantCaller(T, { userId: 3751 });
    const bill = await caller.vendorBills.create({
      tenantId: T, vendorName: "USD Supplier Ltd", amountCents: 120_000, currency: "USD",
    });

    // ── 1. Origination with the ledger bridge DOWN: the PG money mutation
    // still COMMITS (bill paid, plan active) and the TB funding leg waits in
    // the outbox — pre-W45 the bridge call was in-tx and this would have
    // rolled everything back.
    meta.hostStatus.set("ledger-bridge", 502);
    const orig = await caller.vendorBills.recordPayment({
      tenantId: T, billId: bill.bill.id, payOverTime: { installments: 3 },
    });
    assert(orig.ok === true, "origination commits despite the bridge outage (post-commit outbox)");
    const fundRef = pot.potFundingRef(orig.loanId);
    const fundRow = await outbox.getPaymentOutboxByReference(world.db, fundRef);
    assert(fundRow && fundRow.status === "pending" && fundRow.kind === "ledger_transfer", "potfund outbox row pending (undelivered while bridge down)");
    assert(fundRow!.attempts >= 1, "best-effort drain attempted and honestly recorded the failure");
    assert(ledger.transfers.length === 0, "no TB transfer while the bridge is down");
    const [billRow] = await world.db.select().from(schema.vendorBills).where(eq(schema.vendorBills.id, bill.bill.id));
    assert(billRow.status === "paid", "bill paid — PG committed, delivery converges via the outbox");

    // Bridge recovers → the worker delivers the funding leg (deterministic key).
    meta.hostStatus.delete("ledger-bridge");
    const tick1 = await outbox.processPaymentOutbox(world.db);
    assert(tick1.delivered >= 1, `worker delivered the funding leg (${JSON.stringify(tick1)})`);
    const fundLeg = ledger.transfers.find((t) => t.body?.idempotency_key === fundRef);
    assert(fundLeg, "TB funding transfer delivered post-commit");
    // Legs reach the bridge as kind-tagged ledger ids (a7 + tag), never as the opaque domain refs it rejects.
    const tagOf = (k: keyof typeof LEDGER_ACCOUNT_KINDS) => `a7${LEDGER_ACCOUNT_KINDS[k].tag.toString(16).padStart(2, "0")}`;
    assert(String(fundLeg!.body.debit_account_id).startsWith(tagOf("credit-facility")), "funding debits the facility");
    assert(String(fundLeg!.body.credit_account_id).startsWith(tagOf("vendor-bill")), "funding credits the vendor bill");
    assert(fundLeg!.body.single_phase === true, "the funding leg is posted, not a reserve that would expire");
    assert(fundLeg!.body.amount === 120_000, "funding amount is the bill remainder");

    // ── 2. Capture installment 1 → potrepay/potfee outbox legs ───────────
    const planId = orig.planId;
    const [planRow] = await world.db.select().from(schema.installmentPlans)
      .where(eq(schema.installmentPlans.id, planId)).limit(1);
    assert(planRow.currency === "USD", "plan carries the bill currency");
    const schedule = (planRow.schedule as any[]).map((e) =>
      e.seq === 1 ? { ...e, dueAt: new Date(Date.now() - 60_000).toISOString() } : e);
    await world.db.update(schema.installmentPlans)
      .set({ schedule, updatedAt: new Date() })
      .where(eq(schema.installmentPlans.id, planId));

    const sweep = await pot.runInstallmentCaptureSweep(world.db, {});
    assert(sweep.captured === 1, `installment captured (${JSON.stringify(sweep)})`);
    // Settlement legs are outbox rows (delivered by the post-commit drain or
    // the next worker tick — exactly-once by reference either way).
    const feeRow = await outbox.getPaymentOutboxByReference(world.db, `potfee:${planId}:1`);
    assert(feeRow && ["pending", "delivered"].includes(feeRow!.status), "potfee outbox row exists");
    assert((feeRow!.payload as any).credit_account_id === "platform-fees:USD",
      `PAY-19 per-currency fee account (got ${(feeRow!.payload as any).credit_account_id})`);
    const repayRow = await outbox.getPaymentOutboxByReference(world.db, `potrepay:${planId}:1`);
    assert(repayRow && (repayRow!.payload as any).credit_account_id.startsWith("credit-facility:"), "potrepay restores the facility");

    // ── 3. Worker delivers exactly once ──────────────────────────────────
    const tick2 = await outbox.processPaymentOutbox(world.db);
    const feeLeg = ledger.transfers.find((t) => t.body?.idempotency_key === `potfee:${planId}:1`);
    assert(feeLeg && feeLeg.body.credit_account_id === ledgerAccountId("platform-fees", "USD"), "fee leg posted to the platform-fees:USD ledger account");
    assert(feeLeg!.body.single_phase === true, "the fee leg is posted");
    const repayLeg = ledger.transfers.find((t) => t.body?.idempotency_key === `potrepay:${planId}:1`);
    assert(repayLeg, "repay leg posted to the facility");
    const tick3 = await outbox.processPaymentOutbox(world.db);
    assert(tick3.claimed === 0, "worker replay is a no-op (exactly-once)");
  },
};
