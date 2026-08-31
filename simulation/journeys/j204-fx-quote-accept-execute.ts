/**
 * === W32 earlypay-fx (Coder C) ===
 * J204 — FX vendor payout: quote → accept → execute.
 *  1. Quote NGN→KES from the deterministic sim fixed table — metadata.source
 *     honestly labelled "sim-fixed-table"; fee math exact (fee+net==gross).
 *  2. Accept within expiry (guarded single consume); replayed accept is a
 *     no-op (duplicate:true, same row, acceptedAt unchanged).
 *  3. Execute: live corridor NGN:KES configured + sim Mojaloop switch
 *     (202) → locked wallet debit of the GROSS in NGN, payout + fee ledger
 *     legs, executed quote with payout reference; execute replay idempotent.
 *  4. Expired quote refuses acceptance honestly (status → expired).
 */
import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller, expectTrpcError } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";

const TID = "sim-fx-204";
const BALANCE_CENTS = 20_000_000; // ₦200,000.00
const GROSS_CENTS = 10_000_000; // ₦100,000.00
const FEE_BPS = 150; // default
const FEE_CENTS = Math.round((GROSS_CENTS * FEE_BPS) / 10_000); // 150,000
const NET_CENTS = GROSS_CENTS - FEE_CENTS;
const RATE = "0.08300000"; // SIM_FX_RATES NGN:KES
const DELIVERED_CENTS = Math.floor(NET_CENTS * Number(RATE));

async function walletCents(world: World): Promise<number> {
  const schema = await import("../../drizzle/schema");
  const [w] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, TID));
  return w ? Math.round(parseFloat(w.availableBalance) * 100) : 0;
}

export const journey: Journey = {
  id: "J204",
  name: "FX quote → accept → execute with exact fee math; expired refusal; replay no-op",
  feature: "W32 FX payouts: deterministic labelled rates + guarded consume + Mojaloop delivery",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { meta } = await import("../metaMock");
    const now = new Date();
    await world.db.insert(schema.tenants).values({ id: TID, name: "J204 FX", slug: TID, status: "active", createdAt: now, updatedAt: now }).onConflictDoNothing();
    const [u] = await world.db.insert(schema.users).values({ openId: `sim-${TID}-owner`, name: "FX Owner", tenantId: TID, lastSignedIn: now })
      .onConflictDoNothing().returning({ id: schema.users.id });
    const uid = u?.id ?? 204001;
    await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: String(uid), role: "owner" }).onConflictDoNothing();
    await world.db.insert(schema.merchantWallets).values({
      id: crypto.randomUUID(), tenantId: TID, currency: "NGN",
      availableBalance: fmtMajor(BALANCE_CENTS), escrowBalance: "0.00",
      totalEarned: "0.00", totalWithdrawn: "0.00",
      custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();

    const savedEnv = {
      FX_RATE_SOURCE: process.env.FX_RATE_SOURCE,
      FX_LIVE_CORRIDORS: process.env.FX_LIVE_CORRIDORS,
      MOJALOOP_URL: process.env.MOJALOOP_URL,
    };
    process.env.FX_RATE_SOURCE = "sim";
    process.env.FX_LIVE_CORRIDORS = "NGN:KES";
    // The sim Mojaloop switch: the fetch mock answers 202 (async accepted).
    process.env.MOJALOOP_URL = "http://mojaloop.sim.local:3001";
    meta.hostStatus.set("mojaloop.sim.local", 202);
    try {
      const caller = await tenantCaller(TID, { userId: uid });

      // ── 1. Quote — deterministic fixed-table rate, honestly labelled ────
      const q = await caller.fxPayouts.quote({ tenantId: TID, fromCurrency: "NGN", toCurrency: "KES", amountCents: GROSS_CENTS });
      assert(q.ok === true, "quote ok");
      assert(q.quote.rate === RATE, `fixed-table rate (got ${q.quote.rate})`);
      assert(q.quote.provider === "sim", "provider honestly 'sim'");
      assert((q.quote.metadata as any)?.source === "sim-fixed-table", "metadata.source honestly labelled");
      assert(q.quote.feeCents === FEE_CENTS, `fee ${FEE_CENTS} (got ${q.quote.feeCents})`);
      assert(q.quote.feeCents + q.netCents === GROSS_CENTS, "fee+net==gross");
      assert(q.quote.totalCents === GROSS_CENTS, "total is the gross debit");
      assert(q.quote.status === "quoted", "status quoted");

      // ── 2. Accept — guarded single consume; replay no-op ───────────────
      const a = await caller.fxPayouts.accept({ tenantId: TID, quoteId: q.quote.id });
      assert(a.ok === true && a.duplicate === false, "first accept wins");
      const a2 = await caller.fxPayouts.accept({ tenantId: TID, quoteId: q.quote.id });
      assert(a2.ok === true && a2.duplicate === true, "replayed accept is a no-op");
      assert(String(a2.quote.acceptedAt) === String(a.quote.acceptedAt), "replay did not re-consume");

      // ── 3. Execute — locked gross debit + payout/fee legs + payout ref ──
      const ex = await caller.fxPayouts.execute({ tenantId: TID, quoteId: q.quote.id });
      assert(ex.ok === true, `execute ok (${JSON.stringify(ex).slice(0, 300)})`);
      assert(ex.feeCents + ex.netCents === GROSS_CENTS, "executed fee math exact");
      assert(ex.payoutRef && ex.payoutRef.length > 10, "Mojaloop payout reference recorded");
      assert((await walletCents(world)) === BALANCE_CENTS - GROSS_CENTS, "wallet debited exactly the gross");

      const payoutLegs = await world.db.select().from(schema.walletTransactions)
        .where(and(eq(schema.walletTransactions.tenantId, TID), eq(schema.walletTransactions.reference, `fxpayout:${q.quote.id}`)));
      assert(payoutLegs.length === 1, "exactly one payout ledger leg");
      assert(Math.round(parseFloat(payoutLegs[0].amount) * 100) === GROSS_CENTS, "payout leg is the gross");
      assert((payoutLegs[0].metadata as any)?.netCents === NET_CENTS, "net recorded on the payout leg");
      const feeLegs = await world.db.select().from(schema.walletTransactions)
        .where(and(eq(schema.walletTransactions.tenantId, TID), eq(schema.walletTransactions.reference, `fxfee:${q.quote.id}`)));
      assert(feeLegs.length === 1 && Math.round(parseFloat(feeLegs[0].amount) * 100) === FEE_CENTS, "fee leg (escrow pattern)");
      const [fq] = await world.db.select().from(schema.fxQuotes).where(eq(schema.fxQuotes.id, q.quote.id));
      assert(fq.status === "executed" && fq.payoutRef === ex.payoutRef, "quote executed with payout ref");

      // Execute replay: idempotent, nothing moves again.
      const ex2 = await caller.fxPayouts.execute({ tenantId: TID, quoteId: q.quote.id });
      assert(ex2.ok === true && ex2.payoutRef === ex.payoutRef, "execute replay returns original payout ref");
      assert((await walletCents(world)) === BALANCE_CENTS - GROSS_CENTS, "replay moved nothing");

      // ── 4. Expired quote refuses acceptance honestly ────────────────────
      const q2 = await caller.fxPayouts.quote({ tenantId: TID, fromCurrency: "NGN", toCurrency: "KES", amountCents: 100_000 });
      assert(q2.ok === true, "second quote ok");
      await world.db.update(schema.fxQuotes)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.fxQuotes.id, q2.quote.id));
      await expectTrpcError(caller.fxPayouts.accept({ tenantId: TID, quoteId: q2.quote.id }), "PRECONDITION_FAILED", "expired accept refused");
      const [fq2] = await world.db.select().from(schema.fxQuotes).where(eq(schema.fxQuotes.id, q2.quote.id));
      assert(fq2.status === "expired", `expired quote status honest (got ${fq2.status})`);
    } finally {
      meta.hostStatus.delete("mojaloop.sim.local");
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  },
};
