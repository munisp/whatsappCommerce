/**
 * === W31 scheduled-batch ===
 * J189 — batch payments: 5 items under ONE confirmation, wallet covers only
 * 4 → 4 executed + 1 honest insufficient_funds; each item runs in its own
 * transaction (partial-failure isolation); per-item idempotency keys
 * `batch:<batchId>:<idx>`; replaying the batch returns the stored summary
 * and moves nothing.
 */
import crypto from "crypto";
import { eq, and, sql } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";

const TID = "sim-sched-189";
const BATCH_ID = "b189b189-0000-4000-8000-000000000189";
const ITEM_CENTS = 100_000; // ₦1,000.00 each ×5
const BALANCE_CENTS = 450_000; // covers 4, not 5

export const journey: Journey = {
  id: "J189",
  name: "batch of 5 with 1 insufficient → 4 executed, per-item idempotency",
  feature: "W31 batch payments: single confirmation, isolated per-item txs, honest outcomes",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const now = new Date();
    await world.db.insert(schema.tenants).values({
      id: TID, name: "J189 Batch", slug: TID, status: "active", createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    const [u] = await world.db.insert(schema.users).values({
      openId: `sim-${TID}-owner`, name: "Batch Owner", tenantId: TID, lastSignedIn: now,
    }).onConflictDoNothing().returning({ id: schema.users.id });
    const uid = u?.id ?? 189001;
    await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: String(uid), role: "owner" }).onConflictDoNothing();
    await world.db.insert(schema.merchantWallets).values({
      id: crypto.randomUUID(), tenantId: TID, currency: "NGN",
      availableBalance: fmtMajor(BALANCE_CENTS), escrowBalance: "0.00", totalEarned: "0.00", totalWithdrawn: "0.00",
      custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    const caller = await tenantCaller(TID, { userId: uid });

    const items = [0, 1, 2, 3, 4].map((i) => ({
      kind: (i < 2 ? "vendor_bill" : "adhoc") as "vendor_bill" | "adhoc",
      targetId: i < 2 ? `vbill-j189-${i}` : undefined,
      recipient: i >= 2 ? { name: `Supplier ${i}` } : undefined,
      amountCents: ITEM_CENTS,
      currency: "NGN",
    }));

    const res = await caller.scheduledPayments.batchPay({ tenantId: TID, batchId: BATCH_ID, items });
    assert(res.batchId === BATCH_ID && res.duplicate === false, "batch created");
    assert(res.itemCount === 5, "5 items");
    assert(res.executedCount === 4, `4 executed (got ${res.executedCount})`);
    assert(res.failedCount === 1, `1 honest failure (got ${res.failedCount})`);
    const insufficient = res.items.filter((it: any) => it.outcome === "insufficient_funds");
    assert(insufficient.length === 1, `exactly 1 insufficient_funds item (got ${insufficient.length})`);
    const executedItems = res.items.filter((it: any) => it.outcome === "executed");
    assert(executedItems.length === 4, "4 executed items");

    // ── Per-item rows + idempotency keys ─────────────────────────────────
    const rows = await world.db.select().from(schema.scheduledPayments)
      .where(sql`${schema.scheduledPayments.idempotencyKey} LIKE ${`batch:${BATCH_ID}:%`}`);
    assert(rows.length === 5, `5 per-item scheduled rows (got ${rows.length})`);
    const keys = new Set(rows.map((r: any) => r.idempotencyKey));
    for (let i = 0; i < 5; i++) assert(keys.has(`batch:${BATCH_ID}:${i}`), `per-item key ${i} present`);
    assert(rows.filter((r: any) => r.status === "executed").length === 4, "4 rows executed");
    assert(rows.filter((r: any) => r.status === "insufficient_funds").length === 1, "1 row insufficient_funds");

    // ── Wallet + ledger: debited exactly the 4 executed items ───────────
    const [wallet] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, TID));
    assert(Math.round(parseFloat(wallet.availableBalance) * 100) === BALANCE_CENTS - 4 * ITEM_CENTS,
      `wallet debited 4 items (got ${wallet.availableBalance})`);
    const ledger = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.tenantId, TID), sql`${schema.walletTransactions.reference} LIKE 'sched:%'`));
    assert(ledger.length === 4, `exactly 4 ledger rows (got ${ledger.length})`);

    // ── Summary row ──────────────────────────────────────────────────────
    const [batch] = await world.db.select().from(schema.paymentBatches).where(eq(schema.paymentBatches.id, BATCH_ID));
    assert(batch, "payment_batches summary row exists");
    assert(batch.totalCents === 5 * ITEM_CENTS && batch.itemCount === 5, "summary totals");
    assert(batch.executedCount === 4 && batch.failedCount === 1, "summary counts honest");

    // ── Whole-batch replay: same summary, nothing moves ─────────────────
    const replay = await caller.scheduledPayments.batchPay({ tenantId: TID, batchId: BATCH_ID, items });
    assert(replay.duplicate === true, "batch replay flagged duplicate");
    assert(replay.executedCount === 4 && replay.failedCount === 1, "replay returns stored summary");
    const [wallet2] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, TID));
    assert(parseFloat(wallet2.availableBalance) === parseFloat(wallet.availableBalance), "replay moved nothing");
    const ledger2 = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.tenantId, TID), sql`${schema.walletTransactions.reference} LIKE 'sched:%'`));
    assert(ledger2.length === 4, "still exactly 4 ledger rows after replay");

    // ── Over-limit batch refused (max 50) ────────────────────────────────
    const { expectTrpcError } = await import("./helpers");
    const big = Array.from({ length: 51 }, () => ({ kind: "adhoc" as const, amountCents: 100 }));
    await expectTrpcError(caller.scheduledPayments.batchPay({ tenantId: TID, items: big }), "BAD_REQUEST", "51-item batch refused");
  },
};
