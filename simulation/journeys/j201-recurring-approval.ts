/**
 * === W32 recurring-tiers ===
 * J201 — recurring amount ABOVE the auto-pay threshold: the sweep creates the
 * period payment but parks it behind a one-tap WA approval (approval_requests
 * row, kind 'scheduled_payment', WA notification to the owner); the wallet
 * does not move — even when the 5-min execute-payments tick runs (W32 guard).
 * Owner approves → the W31 executor map executes it exactly once. pause
 * stops future runs; resume + next period runs once more; cancel is
 * permanent (sweeps no-op honestly).
 */
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";

const TID = "sim-w32-201";
const OWNER_PHONE = "+2348012010001";
const AMOUNT_CENTS = 5_000_000; // ₦50,000 — above the rule's auto-pay limit

export const journey: Journey = {
  id: "J201",
  name: "above auto-pay threshold → WA approval → approve executes; pause/cancel stop runs",
  feature: "W32 recurring engine: approval parking + W31 approvals composition",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const now = new Date();
    await world.db.insert(schema.tenants).values({
      id: TID, name: "J201 Recurring Approval", slug: TID, status: "active",
      // WA credentials so waSender really posts through the Meta mock.
      whatsappPhoneNumberId: "pn_sim_201",
      settings: { whatsapp: { accessToken: "sim-wa-token-201" } },
      createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    const [u] = await world.db.insert(schema.users).values({
      openId: `sim-${TID}-owner`, name: "Owner", tenantId: TID, phone: OWNER_PHONE, lastSignedIn: now,
    }).onConflictDoNothing().returning({ id: schema.users.id });
    const uid = u?.id ?? 201001;
    await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: String(uid), role: "owner" }).onConflictDoNothing();
    await world.db.insert(schema.merchantWallets).values({
      id: crypto.randomUUID(), tenantId: TID, currency: "NGN",
      availableBalance: fmtMajor(20_000_000), escrowBalance: "0.00", totalEarned: "0.00", totalWithdrawn: "0.00",
      custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    const caller = await tenantCaller(TID, { userId: uid });

    // auto_pay_under_cents below the amount → every run needs approval.
    const firstRun = new Date(Date.now() - 60_000);
    const created = await caller.recurringRules.create({
      tenantId: TID, kind: "adhoc",
      recipient: { name: "J201 Contractor" },
      amountCents: AMOUNT_CENTS, currency: "NGN",
      cadence: "monthly", dayOfMonth: firstRun.getUTCDate(),
      autoPayUnderCents: 1_000_000, firstRunAt: firstRun,
    });

    const cron1 = await world.runCron("/api/scheduled/recurring-run");
    assert(cron1.status === 200 && cron1.json?.ok === true, `cron ok (${JSON.stringify(cron1.json)})`);
    assert(cron1.json.created === 1 && cron1.json.pendingApproval === 1 && cron1.json.autoPaid === 0,
      `period created and parked for approval (${JSON.stringify(cron1.json)})`);

    const period = firstRun.toISOString().slice(0, 10);
    const [payment] = await world.db.select().from(schema.scheduledPayments)
      .where(eq(schema.scheduledPayments.idempotencyKey, `recur:${created.id}:${period}`));
    assert(payment?.status === "pending", `payment parked pending (${payment?.status})`);
    const approvalId = ((payment?.metadata ?? {}) as any).approvalId;
    assert(typeof approvalId === "string", "parked payment carries approvalId");

    const [approval] = await world.db.select().from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, approvalId));
    assert(approval?.status === "pending" && approval.kind === "scheduled_payment",
      "approval request pending (kind scheduled_payment)");

    // WA approval request went out to the approver (admin phone; the mock
    // normalises the MSISDN, so match on the approval ref, not the phone).
    const texts = world.outbound.findByBody(approvalId.slice(0, 8));
    assert(texts.length >= 1, "WA approval request sent to the approver");

    // Nothing moved while parked — and the 5-min tick must NOT execute it
    // (W32 metadata.approvalId guard in executeClaimedPayment re-parks).
    // Backdate execute_at so the tick genuinely claims the row.
    await world.db.update(schema.scheduledPayments)
      .set({ executeAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.scheduledPayments.id, payment.id));
    const tick = await world.runCron("/api/scheduled/execute-payments");
    assert(tick.status === 200, "execute-payments tick ok");
    const [walletParked] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(walletParked.availableBalance === fmtMajor(20_000_000),
      `wallet untouched while parked (got ${walletParked.availableBalance})`);
    const [paymentStillParked] = await world.db.select().from(schema.scheduledPayments)
      .where(eq(schema.scheduledPayments.id, payment.id));
    assert(paymentStillParked.status === "pending", `tick did not execute the parked payment (${paymentStillParked.status})`);

    // One-tap approve → the W31 executor map executes exactly once.
    const approved = await caller.approvals.approve({ tenantId: TID, approvalId });
    assert(approved.ok === true && approved.executed === true,
      `approval executed (${JSON.stringify(approved.execution)})`);
    const [paymentAfter] = await world.db.select().from(schema.scheduledPayments)
      .where(eq(schema.scheduledPayments.id, payment.id));
    assert(paymentAfter.status === "executed", `payment executed after approval (${paymentAfter.status})`);
    const [walletPaid] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(walletPaid.availableBalance === fmtMajor(20_000_000 - AMOUNT_CENTS),
      `wallet debited once (got ${walletPaid.availableBalance})`);

    // ── pause stops future runs honestly ─────────────────────────────────
    const paused = await caller.recurringRules.pause({ tenantId: TID, id: created.id });
    assert(paused.status === "paused" && paused.changed === true, "rule paused");
    const cronPaused = await world.runCron("/api/scheduled/recurring-run");
    assert(cronPaused.json.claimed === 0, "paused rule is never claimed");

    // ── resume → the next due period runs exactly once ────────────────────
    const resumed = await caller.recurringRules.resume({ tenantId: TID, id: created.id });
    assert(resumed.status === "active" && resumed.changed === true, "rule resumed");
    // A new period must differ from the first period key (same-day replays
    // are idempotent no-ops by design) — backdate the due date 3 days.
    await caller.recurringRules.update({
      tenantId: TID, id: created.id, nextRunAt: new Date(Date.now() - 3 * 24 * 60 * 60_000),
    });
    const cronResumed = await world.runCron("/api/scheduled/recurring-run");
    assert(cronResumed.json.created === 1 && cronResumed.json.pendingApproval === 1,
      `resumed rule creates its next period (${JSON.stringify(cronResumed.json)})`);

    // ── cancel is permanent ───────────────────────────────────────────────
    const cancelled = await caller.recurringRules.cancel({ tenantId: TID, id: created.id });
    assert(cancelled.status === "cancelled", "rule cancelled");
    const [ruleCancelled] = await world.db.select().from(schema.recurringRules)
      .where(eq(schema.recurringRules.id, created.id));
    await world.db.update(schema.recurringRules)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.recurringRules.id, created.id));
    const cronCancelled = await world.runCron("/api/scheduled/recurring-run");
    assert(cronCancelled.json.claimed === 0, "cancelled rule is never claimed");
    const payments = await world.db.select().from(schema.scheduledPayments)
      .where(and(eq(schema.scheduledPayments.tenantId, TID)));
    assert(payments.length === 2, `exactly two periods ever created (got ${payments.length})`);
    void ruleCancelled;
  },
};
