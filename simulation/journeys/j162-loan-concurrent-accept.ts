/**
 * J162 — W30 (verify-v1 #3): concurrent micro-loan accepts disburse ONCE.
 *
 * Two racing credit.accept calls for the same merchant: the in-transaction
 * existing-loan re-check (serialized by the FOR UPDATE wallet lock) plus the
 * merchant_loans_open_uniq partial unique index (0088) guarantee exactly one
 * loan, one wallet credit, one funding-leg row and one facility decrement —
 * the loser either gets the winner's loan (deduped) or a CONFLICT, never a
 * second disbursement.
 */
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedLoanMerchant, LOAN_RACE_FACILITY_ID, LOAN_RACE_FACILITY_COMMITMENT_CENTS, fmtMajor } from "./loanRaceSeed";
import { tenantCaller } from "./helpers";

const MERCHANT = "sim-loan-race-162";

export const journey: Journey = {
  id: "J162",
  name: "concurrent accepts → single loan",
  feature: "microLoans accept race hardening (verify-v1 #3)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    await seedLoanMerchant(world, MERCHANT);
    const caller = await tenantCaller(MERCHANT);

    const attempt = () =>
      caller.credit
        .accept({ tenantId: MERCHANT, principalCents: 1_000_000 })
        .then((r: any) => ({ ok: true as const, r }))
        .catch((e: any) => ({ ok: false as const, e }));

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const wins = [a, b].filter((x) => x.ok && (x as any).r?.ok === true);
    assert(wins.length >= 1, `at least one accept succeeds (${JSON.stringify([a, b]).slice(0, 400)})`);
    // A loser is either a CONFLICT (existing_loan) or a deduped success
    // carrying the SAME loan id — never a second loan.
    const loanIds = new Set(wins.map((w: any) => w.r.loan.id));
    assert(loanIds.size === 1, `both winners reference the same loan (${[...loanIds]})`);

    // Exactly ONE loan row for the merchant.
    const loans = await world.db
      .select()
      .from(schema.merchantLoans)
      .where(and(eq(schema.merchantLoans.tenantId, MERCHANT), eq(schema.merchantLoans.merchantId, MERCHANT)));
    assert(loans.length === 1, `exactly one loan row (got ${loans.length})`);
    const loan = loans[0];

    // Exactly ONE wallet disbursement credit; balance == principal (not 2×).
    const [wallet] = await world.db
      .select()
      .from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, MERCHANT))
      .limit(1);
    assert(wallet, "wallet exists");
    assert(
      Math.round(parseFloat(wallet.availableBalance) * 100) === 1_000_000,
      `wallet credited exactly once (got ${wallet.availableBalance})`,
    );
    const credits = (await world.db
      .select()
      .from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.walletId, wallet.id)))
      .filter((t: any) => t.type === "loan_disbursement");
    assert(credits.length === 1, `exactly one disbursement ledger entry (got ${credits.length})`);

    // Exactly ONE funding-leg row and ONE facility decrement (verify-v1 #12).
    const funding = await world.db
      .select()
      .from(schema.merchantLoanFunding)
      .where(eq(schema.merchantLoanFunding.loanId, loan.id));
    assert(funding.length === 1, `exactly one funding row (got ${funding.length})`);
    assert(funding[0].principalCents === 1_000_000, "funding row carries the principal");
    const [facility] = await world.db
      .select()
      .from(schema.creditFacilities)
      .where(eq(schema.creditFacilities.id, LOAN_RACE_FACILITY_ID))
      .limit(1);
    assert(
      facility.commitmentCents === LOAN_RACE_FACILITY_COMMITMENT_CENTS - 1_000_000,
      `facility decremented exactly once (got ${facility.commitmentCents})`,
    );
    void fmtMajor;
  },
};
