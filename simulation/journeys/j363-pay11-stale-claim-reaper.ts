/**
 * === W45 money-scheduled (Coder B1) ===
 * J363 — PAY-11: stale-claim reaper. A payment stranded in 'claimed' (its
 * executor crashed between claim and execute, updatedAt >10min ago) is
 * reaped back to 'pending' INSIDE the tick and immediately re-claimed +
 * executed — money moves exactly once. A FRESH claim (<10min) is left alone
 * (its executor may still be mid-flight).
 */
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";

const TID = "sim-sched-363";
const BALANCE_CENTS = 500_000;
const PAY_CENTS = 120_000;

export const journey: Journey = {
  id: "J363",
  name: "PAY-11: stale-claim reaper recovers crashed executor",
  feature: "W45 scheduledPayments stale-claim reaper in tick",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const now = new Date();
    await world.db.insert(schema.tenants).values({
      id: TID, name: "J363 Reaper", slug: TID, status: "active", createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    const [u] = await world.db.insert(schema.users).values({
      openId: `sim-${TID}-owner`, name: "Reaper Owner", tenantId: TID, lastSignedIn: now,
    }).onConflictDoNothing().returning({ id: schema.users.id });
    const uid = u?.id ?? 363001;
    await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: String(uid), role: "owner" }).onConflictDoNothing();
    await world.db.insert(schema.merchantWallets).values({
      id: crypto.randomUUID(), tenantId: TID, currency: "NGN",
      availableBalance: fmtMajor(BALANCE_CENTS), escrowBalance: "0.00",
      totalEarned: "0.00", totalWithdrawn: "0.00",
      custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    const caller = await tenantCaller(TID, { userId: uid });

    // ── Payment A: will be stranded in 'claimed' 20min ago (crash) ───────
    const a = await caller.scheduledPayments.schedule({
      tenantId: TID, kind: "adhoc", recipient: { name: "J363 Supplier" },
      amountCents: PAY_CENTS, currency: "NGN",
      executeAt: new Date(Date.now() - 60_000), idempotencyKey: "j363-stranded",
    });
    await world.db.update(schema.scheduledPayments)
      .set({ status: "claimed", attempts: 1, updatedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(schema.scheduledPayments.id, a.id));

    // ── Payment B: freshly claimed (executor possibly mid-flight) ────────
    const b = await caller.scheduledPayments.schedule({
      tenantId: TID, kind: "adhoc", recipient: { name: "J363 Fresh" },
      amountCents: PAY_CENTS, currency: "NGN",
      executeAt: new Date(Date.now() - 60_000), idempotencyKey: "j363-fresh",
    });
    await world.db.update(schema.scheduledPayments)
      .set({ status: "claimed", attempts: 1, updatedAt: new Date() })
      .where(eq(schema.scheduledPayments.id, b.id));

    const tick = await world.runCron("/api/scheduled/execute-payments");
    assert(tick.status === 200, `cron accepted (got ${tick.status})`);
    assert(tick.json?.staleClaimsReaped >= 1, `tick reports the reaped claim (got ${JSON.stringify(tick.json)})`);

    // A was reaped → re-claimed → executed in the SAME tick; one debit.
    const [rowA] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, a.id));
    assert(rowA.status === "executed", `stranded payment recovered and executed (got ${rowA.status})`);
    const ledger = await world.db.select().from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.reference, `sched:${a.id}`));
    assert(ledger.length === 1, "exactly one ledger row for the recovered payment");
    const [w] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, TID));
    assert(Math.round(parseFloat(w.availableBalance) * 100) === BALANCE_CENTS - PAY_CENTS, "wallet debited exactly once");

    // B untouched: still claimed, no ledger row, no debit.
    const [rowB] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, b.id));
    assert(rowB.status === "claimed", `fresh claim left alone (got ${rowB.status})`);

    // Age B past the stale window: the next tick reaps and executes it too.
    await world.db.update(schema.scheduledPayments)
      .set({ status: "claimed", updatedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(schema.scheduledPayments.id, b.id));
    const tick2 = await world.runCron("/api/scheduled/execute-payments");
    assert(tick2.status === 200, "second cron accepted");
    const [rowB2] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, b.id));
    assert(rowB2.status === "executed", `aged claim reaped + executed on next tick (got ${rowB2.status})`);
    const [w2] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, TID));
    assert(Math.round(parseFloat(w2.availableBalance) * 100) === BALANCE_CENTS - 2 * PAY_CENTS, "both payments debited exactly once");
  },
};
