/**
 * === W41 (Coder B, UC-2) ===
 * J296 — No-negative-balance race: ten concurrent ₦300 debits against a
 * ₦1,000 wallet — the claim-first guarded UPDATE serializes the claims, at
 * most THREE succeed, and the balance never dips below zero (the DB CHECK
 * constraint is the fail-closed backstop).
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J296",
  name: "concurrent debits: claim-first, balance never negative",
  feature: "W41 UC-2 guarded debit race (FOR UPDATE / guarded UPDATE)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const wallet = await import("../../server/services/customerWallet");
    const phone = world.newPhone("w41e");
    const credit = await wallet.creditWallet(TENANT_ID, phone, 100000, "merchant_goodwill", "goodwill:j296");
    assert(credit.ok === true, "seed ₦1,000 wallet");

    // 10 concurrent debits of ₦300 each — Σclaims (₦3,000) ≫ balance.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        wallet.debitWallet(TENANT_ID, phone, 30000, "checkout_spend", `race:j296:${i}`)),
    );
    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    assert(succeeded.length === 3, `exactly 3 debits of 30000 fit in 100000, got ${succeeded.length}`);
    assert(failed.length === 7 && failed.every((r) => r.error === "insufficient_funds"), "losers fail closed");

    const balance = await wallet.walletBalance(TENANT_ID, phone);
    assert(balance === 10000, `final balance 10000 (never negative), got ${balance}`);

    // Ledger is consistent: 3 debit rows, every running balance >= 0.
    const entries = await world.db.select().from(schema.customerWalletEntries)
      .where(eq(schema.customerWalletEntries.customerPhone, phone));
    const debits = entries.filter((e) => e.direction === "debit");
    assert(debits.length === 3, "one ledger row per successful claim");
    assert(debits.every((e) => e.balanceAfterCents >= 0), "no negative running balance recorded");

    // Single over-balance debit fails closed and moves nothing.
    const over = await wallet.debitWallet(TENANT_ID, phone, 20000, "checkout_spend", "race:j296:over");
    assert(over.ok === false && over.error === "insufficient_funds", "over-balance debit rejected");
    assert((await wallet.walletBalance(TENANT_ID, phone)) === 10000, "balance untouched by rejected debit");
  },
};
