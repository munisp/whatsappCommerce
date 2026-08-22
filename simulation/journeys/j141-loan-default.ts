/**
 * J141 — Loan default path:
 * an active micro-loan whose due date passed beyond the grace window is
 * marked DEFAULTED by the REAL sweep (defaultedAt stamped, stable across
 * re-sweeps); new offers are blocked while the default stands; a manual
 * wallet repayment of the full balance still cures the loan to REPAID and
 * re-opens offers.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedCreditMerchant, CREDIT_MERCHANT_ID } from "./creditSeed";
import { tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J141",
  name: "loan default path",
  feature: "microLoans late/default handling + cure",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const micro = await import("../../server/services/tradeCredit/microLoans");
    await seedCreditMerchant(world);
    const caller = await tenantCaller(CREDIT_MERCHANT_ID);

    // ── 1. Loan disbursed 40 days ago, due 10 days ago (grace = 7d) ─────
    const now = new Date();
    const disbursedAt = new Date(now.getTime() - 40 * 24 * 3600 * 1000);
    const dueAt = new Date(now.getTime() - 10 * 24 * 3600 * 1000);
    const [loan] = await world.db
      .insert(schema.merchantLoans)
      .values({
        tenantId: CREDIT_MERCHANT_ID,
        merchantId: CREDIT_MERCHANT_ID,
        status: "active",
        principalCents: 1_000_000,
        feeCents: 70_000,
        outstandingCents: 1_070_000,
        repaymentPct: 25,
        scoreAtAccept: 650,
        tier: "B",
        disbursedAt,
        dueAt,
      })
      .returning();
    // Wallet funded so the cure repayment has something to debit.
    const [wallet] = await world.db
      .insert(schema.merchantWallets)
      .values({ tenantId: CREDIT_MERCHANT_ID, availableBalance: "20000.00" })
      .onConflictDoNothing()
      .returning();
    const [walletRow] = wallet
      ? [wallet]
      : await world.db.select().from(schema.merchantWallets)
          .where(eq(schema.merchantWallets.tenantId, CREDIT_MERCHANT_ID)).limit(1);
    await world.db
      .update(schema.merchantWallets)
      .set({ availableBalance: "20000.00", updatedAt: new Date() })
      .where(eq(schema.merchantWallets.id, walletRow.id));

    // ── 2. Sweep marks it defaulted (past dueAt + grace) ────────────────
    const sweep = await micro.runLoanRepaymentSweepTx(world.db, { now });
    assert(sweep.markedDefaulted === 1, `defaulted by the sweep (got ${sweep.markedDefaulted})`);
    const [def1] = await world.db
      .select()
      .from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, loan.id))
      .limit(1);
    assert(def1.status === "defaulted", `status defaulted (got ${def1.status})`);
    assert(def1.defaultedAt, "defaultedAt stamped");

    // Re-sweep: defaultedAt is stable, no double-marking.
    const sweep2 = await micro.runLoanRepaymentSweepTx(world.db, {
      now: new Date(now.getTime() + 24 * 3600 * 1000),
    });
    assert(sweep2.markedDefaulted === 0, "no double default marking");
    const [def2] = await world.db
      .select()
      .from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, loan.id))
      .limit(1);
    assert(
      def2.defaultedAt!.getTime() === def1.defaultedAt!.getTime(),
      "defaultedAt stable across sweeps",
    );

    // ── 3. Default blocks new offers ────────────────────────────────────
    const offers = await caller.credit.offers({ tenantId: CREDIT_MERCHANT_ID });
    assert(offers.blockedReason === "existing_loan", "defaulted loan blocks offers");
    assert(offers.offers.length === 0, "no offers while defaulted");

    // ── 4. Manual full repayment cures the default ──────────────────────
    const cured = await caller.credit.repay({
      tenantId: CREDIT_MERCHANT_ID,
      loanId: loan.id,
      amountCents: 1_070_000,
    });
    assert(cured.ok === true, "manual repayment applied");
    assert(cured.repaid === true, "loan repaid");
    const [curedLoan] = await world.db
      .select()
      .from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, loan.id))
      .limit(1);
    assert(curedLoan.status === "repaid", "status repaid after cure");
    assert(curedLoan.outstandingCents === 0, "outstanding cleared");
    const [walletAfter] = await world.db
      .select()
      .from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.id, walletRow.id))
      .limit(1);
    assert(
      Math.round(parseFloat(walletAfter.availableBalance) * 100) === 2_000_000 - 1_070_000,
      "wallet debited the cure amount",
    );

    // ── 5. Offers open up again once the book is clean ──────────────────
    const after = await caller.credit.offers({ tenantId: CREDIT_MERCHANT_ID });
    assert(after.blockedReason === null, "offers unblocked after cure");
    assert(after.offers.length === 1, "offer available again");
  },
};
