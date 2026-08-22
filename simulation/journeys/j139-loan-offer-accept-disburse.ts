/**
 * J139 — Micro-loan offer → accept → disburse:
 * the seeded credit merchant (score in tier B) gets a REAL offer via the
 * tenant-guarded credit router (tRPC caller), accepts it through the router,
 * and the principal lands in the merchant wallet over the existing wallet
 * rails (loan_disbursement ledger entry, exactly-once reference); a second
 * accept is refused (one open loan per merchant), and a cross-tenant caller
 * is rejected before any db work.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedCreditMerchant, CREDIT_MERCHANT_ID } from "./creditSeed";
import { tenantCaller, expectTrpcError } from "./helpers";

export const journey: Journey = {
  id: "J139",
  name: "loan offer → accept → disburse",
  feature: "microLoans offers/accept via credit router + wallet rails",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const seed = await seedCreditMerchant(world);
    const caller = await tenantCaller(CREDIT_MERCHANT_ID);

    // ── 1. Tenant-guarded score + offers via the router ─────────────────
    const scoreRes = await caller.credit.score({ tenantId: CREDIT_MERCHANT_ID });
    assert(scoreRes.score >= 600 && scoreRes.score < 800, `tier B score (got ${scoreRes.score})`);

    const offersRes = await caller.credit.offers({ tenantId: CREDIT_MERCHANT_ID });
    assert(offersRes.blockedReason === null, "offers not blocked");
    assert(offersRes.offers.length === 1, "one offer for the tier");
    const offer = offersRes.offers[0];
    // Tier B: 30% of 90d volume (10 × ₦5,000 = ₦50,000 = 5,000,000 cents).
    assert(offer.tier === "B", `tier B offer (got ${offer.tier})`);
    assert(offer.maxPrincipalCents === 1_500_000, `30% volume cap (got ${offer.maxPrincipalCents})`);
    assert(offer.feeCents === 105_000, `7% fee on max (got ${offer.feeCents})`);
    assert(offer.totalRepayCents === 1_605_000, "total = principal + fee");

    // ── 2. Cross-tenant guard: another tenant cannot see/accept ──────────
    const intruder = await tenantCaller("sim-tenant");
    await expectTrpcError(
      intruder.credit.score({ tenantId: CREDIT_MERCHANT_ID }),
      "FORBIDDEN",
      "cross-tenant score view blocked",
    );
    await expectTrpcError(
      intruder.credit.accept({ tenantId: CREDIT_MERCHANT_ID, principalCents: 1_000_000 }),
      "FORBIDDEN",
      "cross-tenant accept blocked",
    );

    // ── 3. Accept (partial principal) → wallet disbursement ─────────────
    const accepted = await caller.credit.accept({
      tenantId: CREDIT_MERCHANT_ID,
      principalCents: 1_000_000, // ₦10,000 of the ₦15,000 max
    });
    assert(accepted.ok === true, "accept succeeds");
    if (!accepted.ok) return;
    const loan = accepted.loan;
    assert(loan.status === "active", "loan active");
    assert(loan.principalCents === 1_000_000, "principal as requested");
    assert(loan.feeCents === 70_000, `7% fee on accepted principal (got ${loan.feeCents})`);
    assert(loan.outstandingCents === 1_070_000, "outstanding = principal + fee");
    assert(loan.repaymentPct === 25, "tier B repayment pct");
    assert(loan.dueAt, "due date set");

    // Wallet rails: wallet created (find-or-create) + exactly-one ledger credit.
    const [wallet] = await world.db
      .select()
      .from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, CREDIT_MERCHANT_ID))
      .limit(1);
    assert(wallet, "merchant wallet exists");
    assert(
      Math.round(parseFloat(wallet.availableBalance) * 100) === 1_000_000,
      `wallet credited the principal (got ${wallet.availableBalance})`,
    );
    const disb = await world.db
      .select()
      .from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.walletId, wallet.id));
    const credits = disb.filter((t: any) => t.type === "loan_disbursement");
    assert(credits.length === 1, "exactly one disbursement ledger entry");
    assert(credits[0].reference === `loandisb:${loan.id}`, "deterministic idempotency reference");
    assert(Math.round(parseFloat(credits[0].amount) * 100) === 1_000_000, "ledger amount == principal");

    // ── 4. Second accept refused (outstanding-balance cap) ──────────────
    const again = await caller.credit.offers({ tenantId: CREDIT_MERCHANT_ID });
    assert(again.blockedReason === "existing_loan", "open loan blocks new offers");
    await expectTrpcError(
      caller.credit.accept({ tenantId: CREDIT_MERCHANT_ID, principalCents: 500_000 }),
      "CONFLICT",
      "second accept refused",
    );

    // ── 5. Loans + derived repayment schedule via the router ────────────
    const loans = await caller.credit.loans({ tenantId: CREDIT_MERCHANT_ID });
    assert(loans.length === 1, "one loan listed");
    assert(loans[0].schedule[0].label.includes("25%"), "schedule carries the pct-of-sale rule");
    assert(loans[0].schedule[1].amountCents === 1_070_000, "schedule carries the outstanding due");
    void seed;
  },
};
