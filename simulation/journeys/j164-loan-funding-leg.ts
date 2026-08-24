/**
 * J164 — W30 (verify-v1 #12): micro-loan disbursement has a real funding leg.
 *
 * Accepting an offer atomically decrements the platform wholesale facility
 * (credit_facilities.commitment_cents), records the durable funding row
 * (merchant_loan_funding, deterministic ledger ref `loanfund:<loanId>`) and
 * posts the TigerBeetle transfer via the ledger bridge — the minted wallet
 * balance is now backed. A merchant whose principal exceeds the remaining
 * facility commitment is REJECTED honestly (no loan, no wallet credit, no
 * funding row, commitment untouched).
 */
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedLoanMerchant, LOAN_RACE_FACILITY_ID, LOAN_RACE_FACILITY_COMMITMENT_CENTS } from "./loanRaceSeed";
import { tenantCaller, expectTrpcError } from "./helpers";
import { ledger } from "../metaMock";

const MERCHANT = "sim-loan-race-164";
const MERCHANT_B = "sim-loan-race-164b";

export const journey: Journey = {
  id: "J164",
  name: "disbursement funding leg + insufficient facility rejected",
  feature: "microLoans funded disbursement (verify-v1 #12)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const micro = await import("../../server/services/tradeCredit/microLoans");
    await seedLoanMerchant(world, MERCHANT);
    const caller = await tenantCaller(MERCHANT);

    const facilityBefore = async () => {
      const [f] = await world.db
        .select()
        .from(schema.creditFacilities)
        .where(eq(schema.creditFacilities.id, LOAN_RACE_FACILITY_ID))
        .limit(1);
      assert(f, "platform funding facility seeded");
      return f;
    };
    const before = await facilityBefore();

    // ── 1. Funded disbursement: facility decrement + funding row + TB ──
    const accepted = await caller.credit.accept({ tenantId: MERCHANT, principalCents: 1_500_000 });
    assert(accepted.ok === true, "accept succeeds");
    if (!accepted.ok) return;
    const loan = accepted.loan;

    const after = await facilityBefore();
    assert(
      after.commitmentCents === before.commitmentCents - 1_500_000,
      `facility decremented by the principal (got ${after.commitmentCents}, want ${before.commitmentCents - 1_500_000})`,
    );

    const funding = await world.db
      .select()
      .from(schema.merchantLoanFunding)
      .where(eq(schema.merchantLoanFunding.loanId, loan.id));
    assert(funding.length === 1, "funding row persisted");
    assert(funding[0].facilityId === LOAN_RACE_FACILITY_ID, "funding row names the facility");
    assert(funding[0].principalCents === 1_500_000, "funding row carries the principal");
    assert(funding[0].ledgerRef === micro.loanFundingRef(loan.id), "deterministic ledger ref");

    // TigerBeetle entry posted via the ledger bridge with the same key.
    const transfers = ledger.calls.filter(
      (c: any) => c.url.includes("/transfer") && c.body?.idempotency_key === `loanfund:${loan.id}`,
    );
    assert(transfers.length === 1, `exactly one TB funding transfer (got ${transfers.length})`);
    assert(Number(transfers[0].body?.amount) === 1_500_000, "TB transfer amount == principal (integer cents)");
    assert(
      transfers[0].body?.debit_account_id === `credit-facility:${LOAN_RACE_FACILITY_ID}`,
      "TB debits the facility funding account",
    );

    // ── 2. Insufficient facility commitment → honest rejection ─────────
    await seedLoanMerchant(world, MERCHANT_B);
    const callerB = await tenantCaller(MERCHANT_B);
    await world.db
      .update(schema.creditFacilities)
      .set({ commitmentCents: 50_000, updatedAt: new Date() }) // < MIN_LOAN_CENTS
      .where(eq(schema.creditFacilities.id, LOAN_RACE_FACILITY_ID));
    try {
      const err = await expectTrpcError(
        callerB.credit.accept({ tenantId: MERCHANT_B, principalCents: 1_000_000 }),
        "BAD_REQUEST",
        "underfunded accept rejected",
      );
      assert(/insufficient_funding/.test(err.message), `honest reason (got ${err.message})`);

      // Nothing moved: no loan, no wallet, no funding row, commitment intact.
      const loansB = await world.db
        .select()
        .from(schema.merchantLoans)
        .where(and(eq(schema.merchantLoans.tenantId, MERCHANT_B), eq(schema.merchantLoans.merchantId, MERCHANT_B)));
      assert(loansB.length === 0, "no loan minted against an underfunded facility");
      const fundingB = await world.db
        .select()
        .from(schema.merchantLoanFunding)
        .where(eq(schema.merchantLoanFunding.tenantId, MERCHANT_B));
      assert(fundingB.length === 0, "no funding row for the rejection");
      const drained = await facilityBefore();
      assert(drained.commitmentCents === 50_000, "commitment untouched by the rejection");
    } finally {
      // Restore the deterministic seed commitment for later journeys.
      await world.db
        .update(schema.creditFacilities)
        .set({ commitmentCents: LOAN_RACE_FACILITY_COMMITMENT_CENTS - 1_500_000, updatedAt: new Date() })
        .where(eq(schema.creditFacilities.id, LOAN_RACE_FACILITY_ID));
    }
  },
};
