/**
 * J62 — Charge-mandate-first repayment (W13). With an ACTIVE mandate linked
 * to the seeded facility, initiateRepayment charges the mandate AT SOURCE:
 * the paystack mock records /transaction/charge_authorization with the exact
 * cr-{accountId}-* reference, the FIFO settlement lands in the same flow
 * (outstanding decrement + repayment ledger row + draw settlement), and NO
 * payment link is ever issued. Double-submit after full settlement is
 * refused BEFORE any provider charge (exactly-once), and a replayed provider
 * webhook for the mandate reference settles nothing twice.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { CREDIT_ACCOUNT_ID, SUPPLIER_TENANT_ID, TENANT_ID } from "../world";
import { creditAccount, creditLedgerRows, expectTrpcError, linkActiveMandate, paystackChargeSuccess, tenantCaller } from "./helpers";

const chargeAuthCalls = (world: World) =>
  world.outbound.all().filter((c) => c.url.includes("api.paystack.co/transaction/charge_authorization"));
const initializeCalls = (world: World) =>
  world.outbound.all().filter((c) => c.url.includes("api.paystack.co/transaction/initialize"));

export const journey: Journey = {
  id: "J62",
  name: "charge-first repayment",
  feature: "initiateRepayment → mandate charge → FIFO settle, exactly-once",
  async run(world) {
    const schema = await import("../../drizzle/schema");

    // Seed ₦100,000 outstanding via the real draw path.
    const { drawOnCredit } = await import("../../server/services/tradeCredit");
    const draw = await drawOnCredit({
      supplierTenantId: SUPPLIER_TENANT_ID,
      buyerTenantId: TENANT_ID,
      amountCents: 10_000_000,
      poId: "po-j62-seed",
      termsDays: 14,
    });
    assert(draw.ok === true, "seed draw succeeds");

    // Buyer links + activates a paystack mandate through the REAL router path.
    const mandate = await linkActiveMandate(world, { buyerTenantId: TENANT_ID, accountId: CREDIT_ACCOUNT_ID });
    const buyer = await tenantCaller(TENANT_ID, { userId: 262 });

    // ── Partial repayment (₦40,000) charged at source ─────────────────────
    const initsBefore = initializeCalls(world).length;
    const res = await buyer.tradeCredit.initiateRepayment({
      buyerTenantId: TENANT_ID,
      accountId: CREDIT_ACCOUNT_ID,
      amountCents: 4_000_000,
    });
    assert(res.ok === true && res.mode === "mandate", `repayment via mandate (${JSON.stringify(res)})`);
    const reference = (res as any).reference as string;
    assert(new RegExp(`^cr-${CREDIT_ACCOUNT_ID}-\\d{8}-\\d{6}$`).test(reference), `reference shape cr-{accountId}-* (got ${reference})`);

    // The mock recorded the charge_authorization call with the exact reference.
    const charges = chargeAuthCalls(world);
    assert(charges.length === 1, `exactly one charge_authorization call (got ${charges.length})`);
    assert(charges[0].body?.reference === reference, "charge carries the exact repayment reference");
    assert(charges[0].body?.authorization_code === mandate.mandateRef, "charge uses the mandate authorization code");
    assert(Number(charges[0].body?.amount) === 4_000_000, "charge amount = ₦40,000 (kobo)");

    // NO payment link was issued for this repayment (no new initialize call).
    assert(initializeCalls(world).length === initsBefore, "no payment-link initialization for a mandate repayment");

    // FIFO settlement landed: outstanding ↓, repayment ledger row, draw still posted.
    assert(Number((await creditAccount(world)).outstandingCents) === 6_000_000, "outstanding drops to ₦60,000");
    const repay1 = (await creditLedgerRows(world, "repayment")).filter((r: any) => r.ref === reference);
    assert(repay1.length === 1 && Number(repay1[0].amountCents) === 4_000_000, "repayment ledger row for the mandate charge");
    const drawsMid = await creditLedgerRows(world, "invoice_draw");
    assert(drawsMid.length === 1 && drawsMid[0].status === "posted", "partially-covered draw stays posted");

    // ── Settle the remaining ₦60,000 at source → draw settles FIFO ────────
    const res2 = await buyer.tradeCredit.initiateRepayment({
      buyerTenantId: TENANT_ID,
      accountId: CREDIT_ACCOUNT_ID,
      amountCents: 6_000_000,
    });
    assert(res2.ok === true && res2.mode === "mandate", "second repayment via mandate");
    assert(Number((res2 as any).outstandingAfter) === 0, "outstanding zero after full repayment");
    assert(Number((await creditAccount(world)).outstandingCents) === 0, "outstanding persisted at zero");
    const drawsDone = await creditLedgerRows(world, "invoice_draw");
    assert(drawsDone.length === 1 && drawsDone[0].status === "settled", "draw settled FIFO");
    assert(chargeAuthCalls(world).length === 2, "second mandate charge recorded");

    // ── Double-submit after full settlement: refused BEFORE any charge ────
    const chargesBeforeReplay = chargeAuthCalls(world).length;
    const err = await expectTrpcError(
      buyer.tradeCredit.initiateRepayment({
        buyerTenantId: TENANT_ID,
        accountId: CREDIT_ACCOUNT_ID,
        amountCents: 6_000_000,
      }),
      "BAD_REQUEST",
      "double-submit after full settlement",
    );
    assert(/exceeds_outstanding/.test(err.message), `refusal reason exceeds_outstanding (got ${err.message})`);
    assert(chargeAuthCalls(world).length === chargesBeforeReplay, "refused double-submit NEVER reaches the provider");
    assert(Number((await creditAccount(world)).outstandingCents) === 0, "outstanding untouched by the double-submit");
    assert((await creditLedgerRows(world, "repayment")).length === 2, "still exactly two repayment rows");

    // ── Replayed provider webhook for the mandate reference settles nothing ─
    const replay = await paystackChargeSuccess(world, { reference: (res2 as any).reference, amountMajor: 60_000 });
    assert(replay.status !== 500, `replay webhook handled (got ${replay.status})`);
    assert(Number((await creditAccount(world)).outstandingCents) === 0, "replay does not settle twice");
    assert((await creditLedgerRows(world, "repayment")).length === 2, "no extra repayment row from the replay");

    // The mandate stays active + linked throughout.
    const [mandateRow] = await world.db
      .select()
      .from(schema.paymentMandates)
      .where(eq(schema.paymentMandates.id, mandate.mandateId))
      .limit(1);
    assert(mandateRow?.status === "active", "mandate remains active");
  },
};
