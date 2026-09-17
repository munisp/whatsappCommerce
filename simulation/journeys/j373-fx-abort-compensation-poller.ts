/**
 * === W45 money-ledger (Coder B3) ===
 * J373 — PAY-16: FX delivery ABORT compensates honestly + the poller
 * converges a lost callback.
 *  1. Executed quote + delivered outbox leg → ABORTED callback → guarded
 *     wallet re-credit (fxrefund:<quoteId> fx_refund leg), quote 'failed'
 *     with failedReason delivery_aborted; replay is a no-op (never
 *     double-refunds).
 *  2. Callback lost entirely → pollFxTransfers READ-ONLY GET /transfers/:id
 *     (scripted switch answers ABORTED) converges the quote exactly like the
 *     callback path.
 *  3. ABORTED on an already-FULFILLED quote is a money ambiguity → fail
 *     CLOSED: conflict, nothing reversed.
 */
import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";
import { meta, erp } from "../metaMock";

const TID = "sim-fx-373";
const BALANCE_CENTS = 30_000_000;
const GROSS_CENTS = 5_000_000;

export const journey: Journey = {
  id: "J373",
  name: "FX payout: ABORT compensating re-credit + fulfil/error poller + fail-closed ambiguity (PAY-16)",
  feature: "W45 money-ledger: FX Mojaloop outbox",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const fx = await import("../../server/services/fxPayouts");
    const outbox = await import("../../server/services/paymentOutbox");
    const now = new Date();
    await world.db.insert(schema.tenants).values({ id: TID, name: "J373 FX", slug: TID, status: "active", createdAt: now, updatedAt: now }).onConflictDoNothing();
    const [u] = await world.db.insert(schema.users).values({ openId: `sim-${TID}-owner`, name: "FX Owner", tenantId: TID, lastSignedIn: now })
      .onConflictDoNothing().returning({ id: schema.users.id });
    const uid = u?.id ?? 373001;
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
    const executeOne = async () => {
      const caller = await tenantCaller(TID, { userId: uid });
      const q = await caller.fxPayouts.quote({ tenantId: TID, fromCurrency: "NGN", toCurrency: "KES", amountCents: GROSS_CENTS });
      assert(q.ok === true, "quote ok");
      await caller.fxPayouts.accept({ tenantId: TID, quoteId: q.quote.id });
      const ex = await caller.fxPayouts.execute({ tenantId: TID, quoteId: q.quote.id });
      assert(ex.ok === true, `execute ok (${JSON.stringify(ex).slice(0, 200)})`);
      await outbox.processPaymentOutbox(world.db);
      return { quoteId: q.quote.id as string, transferId: ex.payoutRef as string };
    };

    const savedEnv = {
      FX_RATE_SOURCE: process.env.FX_RATE_SOURCE,
      FX_LIVE_CORRIDORS: process.env.FX_LIVE_CORRIDORS,
      MOJALOOP_URL: process.env.MOJALOOP_URL,
    };
    process.env.FX_RATE_SOURCE = "sim";
    process.env.FX_LIVE_CORRIDORS = "NGN:KES";
    process.env.MOJALOOP_URL = "http://mojaloop.sim.local:3001";
    meta.hostStatus.set("mojaloop.sim.local", 202);
    try {
      // ── 1. ABORTED callback → compensating re-credit, quote failed ──────
      const a = await executeOne();
      assert((await walletCents()) === BALANCE_CENTS - GROSS_CENTS, "debit landed");
      const cb = await fx.handleFxTransferCallback(world.db, { transferId: a.transferId, state: "ABORTED", detail: "payee rejected" });
      assert(cb.ok === true && cb.action === "compensated", `abort compensates (${JSON.stringify(cb)})`);
      assert((await walletCents()) === BALANCE_CENTS, "wallet re-credited the gross");
      const [fq] = await world.db.select().from(schema.fxQuotes).where(eq(schema.fxQuotes.id, a.quoteId));
      assert(fq.status === "failed", "quote failed honestly");
      assert(String((fq.metadata as any)?.failedReason ?? "").includes("delivery_aborted"), "honest failedReason");
      const refundLegs = await world.db.select().from(schema.walletTransactions)
        .where(and(eq(schema.walletTransactions.tenantId, TID), eq(schema.walletTransactions.reference, `fxrefund:${a.quoteId}`)));
      assert(refundLegs.length === 1 && refundLegs[0].type === "fx_refund", "fx_refund compensation leg recorded");
      const cbReplay = await fx.handleFxTransferCallback(world.db, { transferId: a.transferId, state: "ABORTED" });
      assert(cbReplay.ok === true && cbReplay.action === "noop", "abort replay never double-refunds");
      assert((await walletCents()) === BALANCE_CENTS, "replay moved nothing");

      // ── 2. Lost callback → poller converges READ-ONLY ──────────────────
      const b = await executeOne();
      assert((await walletCents()) === BALANCE_CENTS - GROSS_CENTS, "second debit landed");
      erp.handlers.set("mojaloop.sim.local", () => ({ json: { transferState: "ABORTED" }, status: 200 }));
      const poll = await fx.pollFxTransfers(world.db, { olderThanMs: 0 });
      assert(poll.compensated >= 1, `poller compensated (${JSON.stringify(poll)})`);
      assert((await walletCents()) === BALANCE_CENTS, "poller re-credited the gross");
      const [fq2] = await world.db.select().from(schema.fxQuotes).where(eq(schema.fxQuotes.id, b.quoteId));
      assert(fq2.status === "failed" && (fq2.metadata as any)?.transferState === "aborted", "poller converged the quote");
      const poll2 = await fx.pollFxTransfers(world.db, { olderThanMs: 0 });
      assert(poll2.compensated === 0, "poller replay is a no-op");
      erp.handlers.delete("mojaloop.sim.local");

      // ── 3. ABORT after FULFIL → fail CLOSED, nothing reversed ──────────
      const c = await executeOne();
      const f1 = await fx.handleFxTransferCallback(world.db, { transferId: c.transferId, state: "COMMITTED" });
      assert(f1.ok === true && f1.action === "fulfilled", "fulfil converges");
      const late = await fx.handleFxTransferCallback(world.db, { transferId: c.transferId, state: "ABORTED" });
      assert(late.ok === false && late.reason === "conflict", "abort-after-fulfil is a fail-closed conflict");
      assert((await walletCents()) === BALANCE_CENTS - GROSS_CENTS, "delivered transfer NEVER reversed");
    } finally {
      erp.handlers.delete("mojaloop.sim.local");
      meta.hostStatus.delete("mojaloop.sim.local");
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  },
};
