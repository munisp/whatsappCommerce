/**
 * === W45 money-scheduled (Coder B1) ===
 * J362 — PAY-10: schedule-time amount==remaining validation. A vendor-bill
 * schedule whose amount does not equal the bill's REMAINING balance is
 * rejected BEFORE any row exists; the exact remaining amount schedules and
 * executes once (W38 in-tx LEAST() path accumulates paid_cents); a terminal
 * (already-paid) bill still schedules and is skipped honestly at execution
 * (W38 contract preserved). The legacy post-commit blanket
 * syncVendorBillBestEffort fallback is gone — paid_cents bookkeeping comes
 * only from the in-transaction LEAST() update.
 */
import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";

const TID = "sim-sched-362";
const BALANCE_CENTS = 1_000_000;

async function seed(world: World) {
  const schema = await import("../../drizzle/schema");
  const now = new Date();
  await world.db.insert(schema.tenants).values({
    id: TID, name: "J362 Scheduled", slug: TID, status: "active", createdAt: now, updatedAt: now,
  }).onConflictDoNothing();
  const [u] = await world.db.insert(schema.users).values({
    openId: `sim-${TID}-owner`, name: "Sched Owner", tenantId: TID, lastSignedIn: now,
  }).onConflictDoNothing().returning({ id: schema.users.id });
  const uid = u?.id ?? 362001;
  await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: String(uid), role: "owner" }).onConflictDoNothing();
  await world.db.insert(schema.merchantWallets).values({
    id: crypto.randomUUID(), tenantId: TID, currency: "NGN",
    availableBalance: fmtMajor(BALANCE_CENTS), escrowBalance: "0.00",
    totalEarned: "0.00", totalWithdrawn: "0.00",
    custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
  }).onConflictDoNothing();
  return uid;
}

async function balanceCents(world: World): Promise<number> {
  const schema = await import("../../drizzle/schema");
  const [w] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, TID));
  return Math.round(parseFloat(w.availableBalance) * 100);
}

export const journey: Journey = {
  id: "J362",
  name: "PAY-10: schedule-time amount==remaining validation",
  feature: "W45 scheduledPayments schedule-time vendor-bill validation",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const uid = await seed(world);
    const caller = await tenantCaller(TID, { userId: uid });

    // ── Bill A: partially paid (500 total, 200 paid → remaining 300) ─────
    const billA = crypto.randomUUID();
    await world.db.insert(schema.vendorBills).values({
      id: billA, tenantId: TID, vendorName: "J362 Vendor A",
      amountCents: 50_000, currency: "NGN", status: "partially_paid", paidCents: 20_000,
    });

    // Stale/full amount (500) is REJECTED at schedule time — no row created.
    let rejected = false;
    try {
      await caller.scheduledPayments.schedule({
        tenantId: TID, kind: "vendor_bill", targetId: billA,
        amountCents: 50_000, currency: "NGN",
        executeAt: new Date(Date.now() - 1000), idempotencyKey: "j362-bad-amount",
      });
    } catch (e: any) {
      rejected = /remaining balance 30000|remaining balance/.test(String(e?.message ?? e));
    }
    assert(rejected, "stale amount rejected at schedule time with the remaining balance in the error");
    const staleRows = await world.db.select().from(schema.scheduledPayments)
      .where(eq(schema.scheduledPayments.idempotencyKey, "j362-bad-amount"));
    assert(staleRows.length === 0, "rejected schedule created NO payment row");

    // Exact remaining amount (300) schedules and executes; LEAST() path
    // accumulates paid_cents 200+300=500 in the SAME commit as the debit.
    const s1 = await caller.scheduledPayments.schedule({
      tenantId: TID, kind: "vendor_bill", targetId: billA,
      amountCents: 30_000, currency: "NGN",
      executeAt: new Date(Date.now() - 1000), idempotencyKey: "j362-good-amount",
    });
    assert(s1.status === "pending", `exact-remaining schedule accepted (got ${s1.status})`);

    // ── Bill B: already paid (terminal) — schedules, then skipped honestly
    const billB = crypto.randomUUID();
    await world.db.insert(schema.vendorBills).values({
      id: billB, tenantId: TID, vendorName: "J362 Vendor B",
      amountCents: 40_000, currency: "NGN", status: "paid", paidCents: 40_000, paymentRef: "manual:cash",
    });
    const s2 = await caller.scheduledPayments.schedule({
      tenantId: TID, kind: "vendor_bill", targetId: billB,
      amountCents: 40_000, currency: "NGN",
      executeAt: new Date(Date.now() - 1000), idempotencyKey: "j362-paid-bill",
    });

    const tick = await world.runCron("/api/scheduled/execute-payments");
    assert(tick.status === 200, `cron accepted (got ${tick.status})`);

    const [row1] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, s1.id));
    assert(row1.status === "executed", `remaining-amount payment executed (got ${row1.status})`);
    const [bA] = await world.db.select().from(schema.vendorBills).where(eq(schema.vendorBills.id, billA));
    assert(bA.status === "paid", "partially-paid bill flipped to paid in the debit commit");
    assert(bA.paidCents === 50_000, `paid_cents accumulated 20000+30000=50000 via LEAST() (got ${bA.paidCents})`);
    assert(bA.paymentRef === `sched:${s1.id}`, "bill payment_ref points at the scheduled payment");

    const [row2] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, s2.id));
    assert(row2.status === "skipped_already_paid", `terminal bill skipped honestly (got ${row2.status})`);

    // Exactly ONE debit (bill A's 300) — bill B never moved money.
    assert(await balanceCents(world) === BALANCE_CENTS - 30_000, "wallet debited exactly the remaining amount once");

    // Replay: nothing moves and bill bookkeeping is untouched (no blanket
    // post-commit overwrite — the fallback is gone).
    await world.runCron("/api/scheduled/execute-payments");
    assert(await balanceCents(world) === BALANCE_CENTS - 30_000, "replay moved nothing");
    const [bA2] = await world.db.select().from(schema.vendorBills).where(eq(schema.vendorBills.id, billA));
    assert(bA2.paidCents === 50_000 && bA2.paymentRef === `sched:${s1.id}`, "bill bookkeeping stable across replay");
    const ledger = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.tenantId, TID), eq(schema.walletTransactions.reference, `sched:${s1.id}`)));
    assert(ledger.length === 1, "exactly one ledger row for the executed payment");
  },
};
