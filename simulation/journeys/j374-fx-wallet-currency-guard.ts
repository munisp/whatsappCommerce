/**
 * === W45 money-ledger (Coder B3) ===
 * J374 — PAY-17: wallet currency guard is fail-closed.
 *  1. A USD→NGN quote against an NGN wallet refuses execute honestly
 *     (currency_mismatch) — NOTHING moves (no debit, no outbox row, quote
 *     stays 'accepted').
 *  2. With a USD wallet the SAME quote executes: the debit and both wallet
 *     legs post in USD (never a cross-currency 1:1 leg).
 */
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller, expectTrpcError } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";
import { meta } from "../metaMock";

const TID = "sim-fx-374";
const BALANCE_CENTS = 50_000_000;

export const journey: Journey = {
  id: "J374",
  name: "FX payout: cross-currency wallet debit refused fail-closed; matching currency executes (PAY-17)",
  feature: "W45 money-ledger: wallet currency guard",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const outbox = await import("../../server/services/paymentOutbox");
    const now = new Date();
    await world.db.insert(schema.tenants).values({ id: TID, name: "J374 FX", slug: TID, status: "active", createdAt: now, updatedAt: now }).onConflictDoNothing();
    const [u] = await world.db.insert(schema.users).values({ openId: `sim-${TID}-owner`, name: "FX Owner", tenantId: TID, lastSignedIn: now })
      .onConflictDoNothing().returning({ id: schema.users.id });
    const uid = u?.id ?? 374001;
    await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: String(uid), role: "owner" }).onConflictDoNothing();
    const walletId = crypto.randomUUID();
    await world.db.insert(schema.merchantWallets).values({
      id: walletId, tenantId: TID, currency: "NGN",
      availableBalance: fmtMajor(BALANCE_CENTS), escrowBalance: "0.00",
      totalEarned: "0.00", totalWithdrawn: "0.00",
      custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    const walletCents = async () => {
      const [w] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.id, walletId));
      return Math.round(parseFloat(w.availableBalance) * 100);
    };

    const savedEnv = {
      FX_RATE_SOURCE: process.env.FX_RATE_SOURCE,
      FX_LIVE_CORRIDORS: process.env.FX_LIVE_CORRIDORS,
      MOJALOOP_URL: process.env.MOJALOOP_URL,
    };
    process.env.FX_RATE_SOURCE = "sim";
    process.env.FX_LIVE_CORRIDORS = "USD:NGN";
    process.env.MOJALOOP_URL = "http://mojaloop.sim.local:3001";
    meta.hostStatus.set("mojaloop.sim.local", 202);
    try {
      const caller = await tenantCaller(TID, { userId: uid });
      // SIM_FX_RATES USD:NGN = 1515.00000000
      const q = await caller.fxPayouts.quote({ tenantId: TID, fromCurrency: "USD", toCurrency: "NGN", amountCents: 1_000_000 });
      assert(q.ok === true, "USD→NGN quote ok");
      await caller.fxPayouts.accept({ tenantId: TID, quoteId: q.quote.id });

      // ── 1. NGN wallet + USD quote → fail-closed refusal, NOTHING moves ──
      await expectTrpcError(caller.fxPayouts.execute({ tenantId: TID, quoteId: q.quote.id }), "PRECONDITION_FAILED", "currency mismatch refused fail-closed");
      assert((await walletCents()) === BALANCE_CENTS, "wallet untouched");
      const leaked = await outbox.getPaymentOutboxByReference(world.db, `fxmoja:${q.quote.id}`);
      assert(!leaked, "no outbox leg enqueued on refusal");
      const [fq] = await world.db.select().from(schema.fxQuotes).where(eq(schema.fxQuotes.id, q.quote.id));
      assert(fq.status === "accepted", "quote still accepted (merchant may fix the wallet)");

      // ── 2. USD wallet → same quote executes with USD legs ──────────────
      await world.db.update(schema.merchantWallets).set({ currency: "USD", updatedAt: new Date() })
        .where(eq(schema.merchantWallets.id, walletId));
      const ex2 = await caller.fxPayouts.execute({ tenantId: TID, quoteId: q.quote.id });
      assert(ex2.ok === true, `execute ok after currency fix (${JSON.stringify(ex2).slice(0, 200)})`);
      assert((await walletCents()) === BALANCE_CENTS - 1_000_000, "USD wallet debited the gross in USD");
      const legs = await world.db.select().from(schema.walletTransactions)
        .where(eq(schema.walletTransactions.tenantId, TID));
      assert(legs.length >= 1 && legs.every((l) => l.currency === "USD"), "every wallet leg in the wallet currency");
      const row = await outbox.getPaymentOutboxByReference(world.db, `fxmoja:${q.quote.id}`);
      assert(row && row.status === "pending", "outbox leg enqueued post-guard");
    } finally {
      meta.hostStatus.delete("mojaloop.sim.local");
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  },
};
