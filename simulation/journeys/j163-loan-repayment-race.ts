/**
 * J163 — W30 (verify-v1 #4): sweep + manual repayment race conserves money.
 *
 * With an active loan and a settled sale on the wallet rails, run the cron
 * sweep (25% of the sale) CONCURRENTLY with a full manual repayment. The
 * shared locked helper (loan row FOR UPDATE + wallet row FOR UPDATE +
 * conditional decrement + guarded outstanding decrement, one transaction)
 * guarantees, regardless of interleaving:
 *   outstanding ends at 0 (loan repaid), total debited == original
 *   outstanding, wallet balance == seed balance − total debited, no negative
 *   balance, no duplicate/orphan repayment rows.
 */
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedLoanMerchant, fmtMajor } from "./loanRaceSeed";
import { tenantCaller } from "./helpers";

const MERCHANT = "sim-loan-race-163";

export const journey: Journey = {
  id: "J163",
  name: "sweep + manual repayment race → conservation",
  feature: "microLoans locked repayment helper (verify-v1 #4)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const micro = await import("../../server/services/tradeCredit/microLoans");
    await seedLoanMerchant(world, MERCHANT);
    const caller = await tenantCaller(MERCHANT);

    // ── Active loan: ₦10,000 principal, ₦10,700 outstanding, 25%/sale ──
    const accepted = await caller.credit.accept({ tenantId: MERCHANT, principalCents: 1_000_000 });
    assert(accepted.ok === true, "loan accepted");
    if (!accepted.ok) return;
    const loan = accepted.loan;
    const outstanding0 = loan.outstandingCents; // 1,070,000

    const [wallet] = await world.db
      .select()
      .from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, MERCHANT))
      .limit(1);
    assert(wallet, "wallet exists");

    // ── A settled sale lands (escrow_release credit, ₦20,000) ──────────
    const saleCents = 2_000_000;
    const bal0 = Math.round(parseFloat(wallet.availableBalance) * 100); // 1,000,000
    await world.db.insert(schema.walletTransactions).values({
      walletId: wallet.id,
      tenantId: MERCHANT,
      type: "escrow_release",
      amount: fmtMajor(saleCents),
      balanceBefore: fmtMajor(bal0),
      balanceAfter: fmtMajor(bal0 + saleCents),
      currency: "NGN",
      description: "J163 simulated settled sale",
      reference: "sim-j163-settle-1",
    });
    await world.db
      .update(schema.merchantWallets)
      .set({ availableBalance: fmtMajor(bal0 + saleCents), updatedAt: new Date() })
      .where(eq(schema.merchantWallets.id, wallet.id));

    // ── Race: cron sweep vs full manual repayment ──────────────────────
    const [sweep, manual] = await Promise.all([
      micro.runLoanRepaymentSweepTx(world.db),
      micro.repayLoanManualTx(world.db, { loanId: loan.id, amountCents: outstanding0 }),
    ]);
    assert(sweep.deductions >= 0, "sweep ran");
    void manual;

    // ── Conservation assertions (interleaving-independent) ─────────────
    const [loanAfter] = await world.db
      .select()
      .from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, loan.id))
      .limit(1);
    assert(loanAfter.outstandingCents === 0, `outstanding fully collected (got ${loanAfter.outstandingCents})`);
    assert(loanAfter.status === "repaid", `loan repaid (got ${loanAfter.status})`);

    const repayRows = await world.db
      .select()
      .from(schema.merchantLoanRepayments)
      .where(eq(schema.merchantLoanRepayments.loanId, loan.id));
    const repaidTotal = repayRows.reduce((s: number, r: any) => s + r.amountCents, 0);
    assert(repaidTotal === outstanding0, `repayment rows sum to the outstanding (got ${repaidTotal})`);
    const refs = new Set(repayRows.map((r: any) => r.reference));
    assert(refs.size === repayRows.length, "no duplicate repayment references");

    const [walletAfter] = await world.db
      .select()
      .from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.id, wallet.id))
      .limit(1);
    const balAfter = Math.round(parseFloat(walletAfter.availableBalance) * 100);
    assert(balAfter === bal0 + saleCents - outstanding0,
      `wallet reflects exactly the collected amount (got ${balAfter}, want ${bal0 + saleCents - outstanding0})`);
    assert(balAfter >= 0, "balance never negative");

    const repayTxs = (await world.db
      .select()
      .from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.walletId, wallet.id), eq(schema.walletTransactions.type, "loan_repayment"))));
    const debitedTotal = repayTxs.reduce((s: number, t: any) => s + Math.round(parseFloat(t.amount) * 100), 0);
    assert(debitedTotal === outstanding0, `wallet ledger debits sum to the outstanding (got ${debitedTotal})`);
    assert(repayTxs.length === repayRows.length, "ledger entries and repayment rows are 1:1");

    // Idempotent re-sweep: nothing left to deduct.
    const again = await micro.runLoanRepaymentSweepTx(world.db);
    assert(again.deductions === 0, "re-sweep is a no-op on a repaid loan");
  },
};
