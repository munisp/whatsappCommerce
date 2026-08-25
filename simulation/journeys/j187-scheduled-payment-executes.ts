/**
 * === W31 scheduled-batch ===
 * J187 — schedule a vendor-bill payment → the /api/scheduled/execute-payments
 * cron executes it at due time → the wallet is debited EXACTLY ONCE
 * (wallet_tx reference `sched:<id>`) and a cron replay is a no-op.
 *
 * vendor_bill contract note: the vendor_bills table belongs to Coder A's
 * parallel branch, so this journey references the bill by ID only
 * (kind='vendor_bill', targetId='vbill-j187-1') and the engine's lazy
 * bill-sync is exercised as a no-op without the table.
 */
import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";

const TID = "sim-sched-187";
const BALANCE_CENTS = 1_000_000; // ₦10,000.00
const PAY_CENTS = 250_000; // ₦2,500.00

async function seedTenantWithWallet(world: World, balanceCents: number) {
  const schema = await import("../../drizzle/schema");
  const now = new Date();
  await world.db.insert(schema.tenants).values({
    id: TID, name: "J187 Scheduled", slug: TID, status: "active", createdAt: now, updatedAt: now,
  }).onConflictDoNothing();
  const [u] = await world.db.insert(schema.users).values({
    openId: `sim-${TID}-owner`, name: "Sched Owner", tenantId: TID, lastSignedIn: now,
  }).onConflictDoNothing().returning({ id: schema.users.id });
  const uid = u?.id ?? 187001;
  await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: String(uid), role: "owner" }).onConflictDoNothing();
  await world.db.insert(schema.merchantWallets).values({
    id: crypto.randomUUID(), tenantId: TID, currency: "NGN",
    availableBalance: fmtMajor(balanceCents), escrowBalance: "0.00",
    totalEarned: "0.00", totalWithdrawn: "0.00",
    custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
  }).onConflictDoNothing();
  return uid;
}

async function walletBalanceCents(world: World): Promise<number> {
  const schema = await import("../../drizzle/schema");
  const [w] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, TID));
  return Math.round(parseFloat(w.availableBalance) * 100);
}

export const journey: Journey = {
  id: "J187",
  name: "scheduled vendor-bill payment executes once via cron; replay no-op",
  feature: "W31 scheduled payments: claim-before-send cron execution + sched:<id> idempotency",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const uid = await seedTenantWithWallet(world, BALANCE_CENTS);
    const caller = await tenantCaller(TID, { userId: uid });

    // ── Schedule a vendor-bill payment due immediately ──────────────────
    const sched = await caller.scheduledPayments.schedule({
      tenantId: TID,
      kind: "vendor_bill",
      targetId: "vbill-j187-1", // ID-only reference (Coder A contract)
      amountCents: PAY_CENTS,
      currency: "NGN",
      executeAt: new Date(Date.now() - 1000),
      idempotencyKey: "j187-sched-1",
    });
    assert(sched.status === "pending", `scheduled pending (got ${sched.status})`);
    assert(sched.duplicate === false, "first schedule is not a duplicate");

    // Idempotent schedule replay: same key returns the same row.
    const schedReplay = await caller.scheduledPayments.schedule({
      tenantId: TID, kind: "vendor_bill", targetId: "vbill-j187-1",
      amountCents: PAY_CENTS, currency: "NGN",
      executeAt: new Date(Date.now() - 1000), idempotencyKey: "j187-sched-1",
    });
    assert(schedReplay.duplicate === true && schedReplay.id === sched.id, "schedule replay idempotent");

    // ── Cron executes at due time ────────────────────────────────────────
    const bal0 = await walletBalanceCents(world);
    assert(bal0 === BALANCE_CENTS, `wallet seeded (got ${bal0})`);
    const tick1 = await world.runCron("/api/scheduled/execute-payments");
    assert(tick1.status === 200, `cron accepted (got ${tick1.status})`);
    assert(tick1.json.claimed >= 1 && tick1.json.executed >= 1, `tick executed the payment (${JSON.stringify(tick1.json)})`);

    const [row] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, sched.id));
    assert(row.status === "executed", `payment executed (got ${row.status})`);
    assert(row.attempts === 1, `one attempt (got ${row.attempts})`);

    const bal1 = await walletBalanceCents(world);
    assert(bal1 === BALANCE_CENTS - PAY_CENTS, `wallet debited exactly the payment (got ${bal1}, want ${BALANCE_CENTS - PAY_CENTS})`);

    const ledger = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.tenantId, TID), eq(schema.walletTransactions.reference, `sched:${sched.id}`)));
    assert(ledger.length === 1, `exactly one ledger row sched:<id> (got ${ledger.length})`);
    assert(Math.round(parseFloat(ledger[0].amount) * 100) === PAY_CENTS, "ledger amount matches");

    // ── Cron replay is a no-op (no double debit) ────────────────────────
    const tick2 = await world.runCron("/api/scheduled/execute-payments");
    assert(tick2.status === 200, "replay cron accepted");
    const bal2 = await walletBalanceCents(world);
    assert(bal2 === bal1, `replay moved nothing (got ${bal2}, want ${bal1})`);
    const ledger2 = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.tenantId, TID), eq(schema.walletTransactions.reference, `sched:${sched.id}`)));
    assert(ledger2.length === 1, "still exactly one ledger row after replay");

    // Cancel of an executed payment refuses honestly.
    const { expectTrpcError } = await import("./helpers");
    await expectTrpcError(caller.scheduledPayments.cancel({ tenantId: TID, id: sched.id }), "CONFLICT", "cancel executed");
  },
};
