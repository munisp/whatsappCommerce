/**
 * === W32 earlypay-fx (Coder C) ===
 * J205 — no live corridor → honest UNAVAILABLE, NOTHING moves.
 * A quote for a pair with no configured live delivery corridor can be
 * minted and accepted (rates are knowable), but EXECUTION is refused
 * honestly: no wallet debit, no ledger rows, no fake "delivered". The
 * tenant may still back out (quote stays accepted until expiry).
 */
import crypto from "crypto";
import { and, eq, like } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller, expectTrpcError } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";

const TID = "sim-fx-205";
const BALANCE_CENTS = 5_000_000; // ₦50,000.00

export const journey: Journey = {
  id: "J205",
  name: "FX payout with no live corridor → honest UNAVAILABLE, nothing moves",
  feature: "W32 FX payouts: corridor gate fails honestly — no simulated cross-border delivery",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const now = new Date();
    await world.db.insert(schema.tenants).values({ id: TID, name: "J205 FX", slug: TID, status: "active", createdAt: now, updatedAt: now }).onConflictDoNothing();
    const [u] = await world.db.insert(schema.users).values({ openId: `sim-${TID}-owner`, name: "FX Owner", tenantId: TID, lastSignedIn: now })
      .onConflictDoNothing().returning({ id: schema.users.id });
    const uid = u?.id ?? 205001;
    await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: String(uid), role: "owner" }).onConflictDoNothing();
    await world.db.insert(schema.merchantWallets).values({
      id: crypto.randomUUID(), tenantId: TID, currency: "NGN",
      availableBalance: fmtMajor(BALANCE_CENTS), escrowBalance: "0.00",
      totalEarned: "0.00", totalWithdrawn: "0.00",
      custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();

    const savedCorridors = process.env.FX_LIVE_CORRIDORS;
    // NGN:USD has a sim rate but NO live delivery corridor configured.
    process.env.FX_LIVE_CORRIDORS = "NGN:KES";
    try {
      const caller = await tenantCaller(TID, { userId: uid });
      const q = await caller.fxPayouts.quote({ tenantId: TID, fromCurrency: "NGN", toCurrency: "USD", amountCents: 1_000_000 });
      assert(q.ok === true, "quote minted (rate is knowable)");
      const a = await caller.fxPayouts.accept({ tenantId: TID, quoteId: q.quote.id });
      assert(a.ok === true, "quote accepted");

      const err = await expectTrpcError(
        caller.fxPayouts.execute({ tenantId: TID, quoteId: q.quote.id }),
        "PRECONDITION_FAILED",
        "no-corridor execute refused",
      );
      assert(/UNAVAILABLE/i.test(err?.message ?? ""), "honest UNAVAILABLE wording");

      // NOTHING moved: wallet intact, zero FX ledger rows, quote still accepted.
      const [w] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, TID));
      assert(Math.round(parseFloat(w.availableBalance) * 100) === BALANCE_CENTS, "wallet untouched");
      const fxLedger = await world.db.select().from(schema.walletTransactions)
        .where(and(eq(schema.walletTransactions.tenantId, TID), like(schema.walletTransactions.reference, "fx%")));
      assert(fxLedger.length === 0, `no FX ledger rows (got ${fxLedger.length})`);
      const [fq] = await world.db.select().from(schema.fxQuotes).where(eq(schema.fxQuotes.id, q.quote.id));
      assert(fq.status === "accepted" && fq.payoutRef == null, `quote not executed (got ${fq.status})`);
    } finally {
      if (savedCorridors === undefined) delete process.env.FX_LIVE_CORRIDORS; else process.env.FX_LIVE_CORRIDORS = savedCorridors;
    }
  },
};
