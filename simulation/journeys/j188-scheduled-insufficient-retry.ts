/**
 * === W31 scheduled-batch ===
 * J188 — insufficient funds at execution is HONEST: nothing moves, the row
 * goes to status 'insufficient_funds'; after a wallet top-up the merchant
 * calls scheduledPayments.retry → next cron tick executes it.
 */
import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";

const TID = "sim-sched-188";
const PAY_CENTS = 400_000; // ₦4,000.00

export const journey: Journey = {
  id: "J188",
  name: "insufficient funds honesty → top-up → merchant retry → executed",
  feature: "W31 scheduled payments: honest insufficient_funds + retry after top-up",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const now = new Date();
    await world.db.insert(schema.tenants).values({
      id: TID, name: "J188 Retry", slug: TID, status: "active", createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    const [u] = await world.db.insert(schema.users).values({
      openId: `sim-${TID}-owner`, name: "Retry Owner", tenantId: TID, lastSignedIn: now,
    }).onConflictDoNothing().returning({ id: schema.users.id });
    const uid = u?.id ?? 188001;
    await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: String(uid), role: "owner" }).onConflictDoNothing();
    // Wallet exists but EMPTY.
    await world.db.insert(schema.merchantWallets).values({
      id: crypto.randomUUID(), tenantId: TID, currency: "NGN",
      availableBalance: "0.00", escrowBalance: "0.00", totalEarned: "0.00", totalWithdrawn: "0.00",
      custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    const caller = await tenantCaller(TID, { userId: uid });

    const sched = await caller.scheduledPayments.schedule({
      tenantId: TID, kind: "adhoc",
      recipient: { name: "Supaclean Ltd", bankAccountNumber: "0123456789", bankCode: "058" },
      amountCents: PAY_CENTS, currency: "NGN",
      executeAt: new Date(Date.now() - 1000), idempotencyKey: "j188-sched-1",
    });
    assert(sched.status === "pending", "scheduled pending");

    // ── Execution with an empty wallet: honest insufficient_funds ───────
    const tick1 = await world.runCron("/api/scheduled/execute-payments");
    assert(tick1.status === 200, `cron accepted (got ${tick1.status})`);
    assert(tick1.json.insufficientFunds >= 1, `tick reported insufficient_funds (${JSON.stringify(tick1.json)})`);
    let [row] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, sched.id));
    assert(row.status === "insufficient_funds", `honest insufficient_funds (got ${row.status})`);
    assert((row.lastError ?? "").includes("INSUFFICIENT_FUNDS"), "last_error explains honestly");
    let [wallet] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, TID));
    assert(parseFloat(wallet.availableBalance) === 0, "nothing moved from the empty wallet");
    let ledger = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.tenantId, TID), eq(schema.walletTransactions.reference, `sched:${sched.id}`)));
    assert(ledger.length === 0, "NO ledger row written for the failed debit");

    // Retry BEFORE top-up still fails honestly at execution time.
    const retry0 = await caller.scheduledPayments.retry({ tenantId: TID, id: sched.id });
    assert(retry0.retried === true, "retry resets to pending");
    const tickBad = await world.runCron("/api/scheduled/execute-payments");
    assert(tickBad.json.insufficientFunds >= 1, "pre-top-up retry lands back on insufficient_funds");

    // ── Merchant tops up, retries, cron executes ─────────────────────────
    await world.db.update(schema.merchantWallets)
      .set({ availableBalance: fmtMajor(1_000_000), updatedAt: new Date() })
      .where(eq(schema.merchantWallets.tenantId, TID));
    const retry1 = await caller.scheduledPayments.retry({ tenantId: TID, id: sched.id });
    assert(retry1.retried === true && retry1.status === "pending", "retry after top-up resets to pending");
    const tick2 = await world.runCron("/api/scheduled/execute-payments");
    assert(tick2.json.executed >= 1, `executed after top-up (${JSON.stringify(tick2.json)})`);
    [row] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, sched.id));
    assert(row.status === "executed", `executed (got ${row.status})`);
    [wallet] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, TID));
    assert(Math.round(parseFloat(wallet.availableBalance) * 100) === 1_000_000 - PAY_CENTS,
      `wallet debited exactly once (got ${wallet.availableBalance})`);
    ledger = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.tenantId, TID), eq(schema.walletTransactions.reference, `sched:${sched.id}`)));
    assert(ledger.length === 1, "exactly one ledger row across the whole retry chain");

    // Retry of an executed payment refuses honestly.
    const retry2 = await caller.scheduledPayments.retry({ tenantId: TID, id: sched.id }).then(
      () => ({ refused: false }),
      (e: any) => ({ refused: true, code: e?.code ?? e?.data?.code }),
    );
    assert(retry2.refused === true && (retry2 as any).code === "CONFLICT", "retry of executed payment refused with CONFLICT");
  },
};
