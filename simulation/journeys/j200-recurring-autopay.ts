/**
 * === W32 recurring-tiers ===
 * J200 — monthly recurring supplier bill: the daily cron sweep creates a
 * vendor bill (capture_source='recurring') + scheduled_payment (idempotency
 * key `recur:<ruleId>:<period>`), auto-pays it inline under the rule's
 * auto_pay_under_cents, and advances next_run_at in the same transaction.
 * A replayed sweep is a no-op (idempotency key wins; next_run advanced once).
 */
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";

const TID = "sim-w32-200";
const AMOUNT_CENTS = 250_000; // ₦2,500.00 monthly supplier bill

export const journey: Journey = {
  id: "J200",
  name: "monthly recurring bill → cron creates bill + auto-pays under threshold → replay no-op",
  feature: "W32 recurring engine: crash-safe advance, recur:<ruleId>:<period> idempotency, auto-pay",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const now = new Date();
    await world.db.insert(schema.tenants).values({
      id: TID, name: "J200 Recurring", slug: TID, status: "active", createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    const [u] = await world.db.insert(schema.users).values({
      openId: `sim-${TID}-owner`, name: "Recurring Owner", tenantId: TID, lastSignedIn: now,
    }).onConflictDoNothing().returning({ id: schema.users.id });
    const uid = u?.id ?? 200001;
    await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: String(uid), role: "owner" }).onConflictDoNothing();
    await world.db.insert(schema.merchantWallets).values({
      id: crypto.randomUUID(), tenantId: TID, currency: "NGN",
      availableBalance: fmtMajor(10_000_000), escrowBalance: "0.00", totalEarned: "0.00", totalWithdrawn: "0.00",
      custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    const caller = await tenantCaller(TID, { userId: uid });

    // Rule due right now (firstRunAt in the past), auto-pay well above amount.
    const firstRun = new Date(Date.now() - 60_000);
    const created = await caller.recurringRules.create({
      tenantId: TID, kind: "vendor_bill",
      recipient: { name: "J200 Flour Supplier", phone: "+2348012000001" },
      amountCents: AMOUNT_CENTS, currency: "NGN",
      cadence: "monthly", dayOfMonth: firstRun.getUTCDate(),
      autoPayUnderCents: 1_000_000, firstRunAt: firstRun,
    });
    assert(created.status === "active", "rule active on create");

    const cron1 = await world.runCron("/api/scheduled/recurring-run");
    assert(cron1.status === 200 && cron1.json?.ok === true, `cron ok (${JSON.stringify(cron1.json)})`);
    assert(cron1.json.claimed === 1 && cron1.json.created === 1 && cron1.json.autoPaid === 1,
      `sweep created + auto-paid one period (${JSON.stringify(cron1.json)})`);

    // Vendor bill created with the additive capture_source vocab.
    const bills = await world.db.select().from(schema.vendorBills)
      .where(and(eq(schema.vendorBills.tenantId, TID), eq(schema.vendorBills.captureSource, "recurring")));
    assert(bills.length === 1, `exactly one recurring vendor bill (got ${bills.length})`);
    assert(bills[0].amountCents === AMOUNT_CENTS, "bill amount matches the rule");
    assert(bills[0].status === "paid", `bill paid by the auto-pay (${bills[0].status})`);
    assert(bills[0].paymentRef?.startsWith("sched:"), `bill settled via sched ref (${bills[0].paymentRef})`);

    // Wallet debited exactly once, gross amount.
    const [wallet] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(wallet.availableBalance === fmtMajor(10_000_000 - AMOUNT_CENTS),
      `wallet debited once (got ${wallet.availableBalance})`);
    const period = firstRun.toISOString().slice(0, 10);
    const [payment] = await world.db.select().from(schema.scheduledPayments)
      .where(eq(schema.scheduledPayments.idempotencyKey, `recur:${created.id}:${period}`));
    assert(payment?.status === "executed", `period payment executed (${payment?.status})`);
    assert(payment?.targetId === bills[0].id, "payment targets the created bill");

    // next_run_at advanced exactly one monthly step into the future.
    const [rule] = await world.db.select().from(schema.recurringRules)
      .where(eq(schema.recurringRules.id, created.id));
    const expectedMonth = (firstRun.getUTCMonth() + 1) % 12;
    assert(rule.nextRunAt.getTime() > Date.now(), "next run moved to the future");
    assert(rule.nextRunAt.getUTCMonth() === expectedMonth, `monthly step (${rule.nextRunAt.toISOString()})`);
    assert(rule.lastRunAt !== null, "last_run_at stamped");

    // Replay: the same sweep again creates nothing and does not move money.
    const cron2 = await world.runCron("/api/scheduled/recurring-run");
    assert(cron2.status === 200 && cron2.json.claimed === 0 && cron2.json.created === 0,
      `replay is a no-op (${JSON.stringify(cron2.json)})`);
    const billsAfter = await world.db.select().from(schema.vendorBills)
      .where(eq(schema.vendorBills.tenantId, TID));
    assert(billsAfter.length === 1, "no second bill on replay");
    const [wallet2] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(wallet2.availableBalance === wallet.availableBalance, "no second debit on replay");
  },
};
