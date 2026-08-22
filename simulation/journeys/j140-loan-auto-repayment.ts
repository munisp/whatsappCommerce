/**
 * J140 — Auto-repayment deduction on sale:
 * with an active micro-loan, a settled sale (an escrow_release credit on
 * the merchant wallet, exactly the shape escrow settlement writes) is swept
 * by the REAL runLoanRepaymentSweep — 25% (tier rule) is debited from the
 * wallet into the loan (loan_repayment ledger + repayments row with the
 * deterministic reference), outstanding shrinks; a second sweep is a
 * no-op (idempotent); and when the deduction covers the balance the loan
 * flips to repaid.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedCreditMerchant, CREDIT_MERCHANT_ID } from "./creditSeed";
import { tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J140",
  name: "auto-repayment deduction on sale",
  feature: "runLoanRepaymentSweep over wallet escrow_release rails",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const micro = await import("../../server/services/tradeCredit/microLoans");
    await seedCreditMerchant(world);
    const caller = await tenantCaller(CREDIT_MERCHANT_ID);

    // ── 1. Active loan (₦10,000 principal, 25% per-sale rule) ───────────
    const accepted = await caller.credit.accept({
      tenantId: CREDIT_MERCHANT_ID,
      principalCents: 1_000_000,
    });
    assert(accepted.ok === true, "loan accepted");
    if (!accepted.ok) return;
    const loan = accepted.loan;

    const [wallet] = await world.db
      .select()
      .from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, CREDIT_MERCHANT_ID))
      .limit(1);
    assert(wallet, "wallet exists");

    // ── 2. A settled sale lands on the wallet rails (escrow_release) ────
    const saleCents = 2_000_000; // ₦20,000 sale
    const beforeCents = Math.round(parseFloat(wallet.availableBalance) * 100);
    const afterCents = beforeCents + saleCents;
    const fmt = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
    const [saleTx] = await world.db
      .insert(schema.walletTransactions)
      .values({
        walletId: wallet.id,
        tenantId: CREDIT_MERCHANT_ID,
        type: "escrow_release",
        amount: fmt(saleCents),
        balanceBefore: fmt(beforeCents),
        balanceAfter: fmt(afterCents),
        currency: "NGN",
        description: "J140 simulated settled sale",
        reference: "sim-j140-settle-1",
      })
      .returning();
    await world.db
      .update(schema.merchantWallets)
      .set({ availableBalance: fmt(afterCents), updatedAt: new Date() })
      .where(eq(schema.merchantWallets.id, wallet.id));

    // ── 3. Sweep deducts 25% of the sale from the wallet ────────────────
    const sweep1 = await micro.runLoanRepaymentSweepTx(world.db);
    assert(sweep1.deductions === 1, `one deduction applied (got ${sweep1.deductions})`);
    const expectedDeduction = 500_000; // 25% of ₦20,000
    assert(sweep1.deductedCents === expectedDeduction, `25% deducted (got ${sweep1.deductedCents})`);

    const [walletAfter] = await world.db
      .select()
      .from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.id, wallet.id))
      .limit(1);
    assert(
      Math.round(parseFloat(walletAfter.availableBalance) * 100) === afterCents - expectedDeduction,
      "wallet debited the deduction",
    );
    const [loanAfter] = await world.db
      .select()
      .from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, loan.id))
      .limit(1);
    assert(loanAfter.outstandingCents === 1_070_000 - expectedDeduction, "outstanding shrinks");
    assert(loanAfter.status === "active", "still active (partial)");

    const repayRows = await world.db
      .select()
      .from(schema.merchantLoanRepayments)
      .where(eq(schema.merchantLoanRepayments.loanId, loan.id));
    assert(repayRows.length === 1, "one repayment ledger row");
    assert(
      repayRows[0].reference === `loanrepay:${loan.id}:${saleTx.id}`,
      "deterministic idempotency reference",
    );
    assert(repayRows[0].source === "sale_deduction", "source recorded");

    // ── 4. Second sweep is a no-op (idempotent) ─────────────────────────
    const sweep2 = await micro.runLoanRepaymentSweepTx(world.db);
    assert(sweep2.deductions === 0, "no double deduction");
    const [walletFinal] = await world.db
      .select()
      .from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.id, wallet.id))
      .limit(1);
    assert(
      parseFloat(walletFinal.availableBalance) === parseFloat(walletAfter.availableBalance),
      "wallet unchanged on re-sweep",
    );

    // ── 5. Sales keep repaying until the loan flips to repaid ───────────
    // Two more ₦20,000 sales: 25% each (₦5,000 + ₦5,000) covers the
    // remaining ₦5,700 with the per-sale deduction capped at outstanding.
    for (const tag of ["2", "3"]) {
      const [w] = await world.db
        .select()
        .from(schema.merchantWallets)
        .where(eq(schema.merchantWallets.id, wallet.id))
        .limit(1);
      const b = Math.round(parseFloat(w.availableBalance) * 100);
      await world.db.insert(schema.walletTransactions).values({
        walletId: wallet.id,
        tenantId: CREDIT_MERCHANT_ID,
        type: "escrow_release",
        amount: fmt(saleCents),
        balanceBefore: fmt(b),
        balanceAfter: fmt(b + saleCents),
        currency: "NGN",
        description: `J140 simulated settled sale ${tag}`,
        reference: `sim-j140-settle-${tag}`,
      });
      await world.db
        .update(schema.merchantWallets)
        .set({ availableBalance: fmt(b + saleCents), updatedAt: new Date() })
        .where(eq(schema.merchantWallets.id, wallet.id));
    }
    const sweep3 = await micro.runLoanRepaymentSweepTx(world.db);
    assert(sweep3.repaidLoans === 1, "loan fully repaid by sale deductions");
    const [loanDone] = await world.db
      .select()
      .from(schema.merchantLoans)
      .where(eq(schema.merchantLoans.id, loan.id))
      .limit(1);
    assert(loanDone.status === "repaid", `loan repaid (got ${loanDone.status})`);
    assert(loanDone.outstandingCents === 0, "outstanding zero");
    assert(loanDone.repaidAt, "repaidAt stamped");
    // Last deduction capped at outstanding (500k then 70k, not 500k+500k).
    const allRepay = await world.db
      .select()
      .from(schema.merchantLoanRepayments)
      .where(eq(schema.merchantLoanRepayments.loanId, loan.id));
    const total = allRepay.reduce((s: number, r: any) => s + r.amountCents, 0);
    assert(total === 1_070_000, `repayments sum to principal+fee exactly (got ${total})`);
  },
};
