/**
 * === W45 money-scheduled (Coder B1) ===
 * J364 — PAY-12: approval expiry resolves the parked payment. When an
 * approval_request expires undecided, the sweep flips it to 'expired' AND
 * the parked scheduled_payment to terminal 'approval_expired' (no infinite
 * +15min re-park, nothing moves). The W32 execution guard now consults the
 * approval row: an alive (pending, unexpired) approval still re-parks; a
 * dead (expired/rejected/missing) one resolves the payment terminally.
 */
import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const TID = "sim-sched-364";

async function seed(world: World) {
  const schema = await import("../../drizzle/schema");
  const now = new Date();
  await world.db.insert(schema.tenants).values({
    id: TID, name: "J364 Approvals", slug: TID, status: "active", createdAt: now, updatedAt: now,
  }).onConflictDoNothing();
  const [u] = await world.db.insert(schema.users).values({
    openId: `sim-${TID}-owner`, name: "Approval Owner", tenantId: TID, lastSignedIn: now,
  }).onConflictDoNothing().returning({ id: schema.users.id });
  const uid = u?.id ?? 364001;
  await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: String(uid), role: "owner" }).onConflictDoNothing();
  return uid;
}

async function insertParkedPayment(world: World, approvalId: string, status: string, key: string) {
  const schema = await import("../../drizzle/schema");
  const now = new Date();
  const id = crypto.randomUUID();
  await world.db.insert(schema.scheduledPayments).values({
    id, tenantId: TID, kind: "adhoc", recipient: { name: "J364" },
    amountCents: 90_000, currency: "NGN",
    executeAt: new Date(now.getTime() - 60_000),
    status, idempotencyKey: key, attempts: status === "claimed" ? 1 : 0,
    metadata: { approvalId },
    createdAt: now, updatedAt: now,
  });
  return id;
}

async function insertApproval(world: World, opts: { status: string; expiresAt: Date; targetId: string }) {
  const schema = await import("../../drizzle/schema");
  const id = crypto.randomUUID();
  await world.db.insert(schema.approvalRequests).values({
    id, tenantId: TID, kind: "scheduled_payment", targetId: opts.targetId,
    amountCents: 90_000, requestedBy: "system", approverRole: "owner",
    status: opts.status, expiresAt: opts.expiresAt, createdAt: new Date(),
  });
  return id;
}

export const journey: Journey = {
  id: "J364",
  name: "PAY-12: approval expiry resolves parked payment (approval_expired)",
  feature: "W45 approvals expiry sweep + W32 re-park guard fix",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    await seed(world);

    // ── A. Expired approval + parked (pending) payment → sweep resolves ──
    const payA = await insertParkedPayment(world, "", "pending", "j364-a");
    const apA = await insertApproval(world, { status: "pending", expiresAt: new Date(Date.now() - 60_000), targetId: payA });
    await world.db.update(schema.scheduledPayments)
      .set({ metadata: { approvalId: apA } }).where(eq(schema.scheduledPayments.id, payA));

    const sweep = await world.runCron("/api/scheduled/approvals-expiry");
    assert(sweep.status === 200, `approvals-expiry cron accepted (got ${sweep.status})`);
    const [apRow] = await world.db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, apA));
    assert(apRow.status === "expired", `approval expired (got ${apRow.status})`);
    const [payRow] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, payA));
    assert(payRow.status === "approval_expired", `parked payment resolved approval_expired (got ${payRow.status})`);
    assert(/APPROVAL_EXPIRED/.test(payRow.lastError ?? ""), "honest lastError recorded");
    const audit = await world.db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.action, "scheduled_payment.approval_expired"), eq(schema.auditLogs.entityId, payA)));
    assert(audit.length >= 1, "audit row written for the approval_expired resolution");
    // Terminal: the payment is NEVER re-picked by the payment tick.
    await world.runCron("/api/scheduled/execute-payments");
    const [payRow2] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, payA));
    assert(payRow2.status === "approval_expired", "terminal — the tick never re-parks or executes it");

    // ── B. Alive approval (pending, unexpired) → guard still RE-PARKS ────
    const { executeClaimedPayment } = await import("../../server/services/scheduledPayments");
    const payB = await insertParkedPayment(world, "", "claimed", "j364-b");
    const apB = await insertApproval(world, { status: "pending", expiresAt: new Date(Date.now() + 3600_000), targetId: payB });
    await world.db.update(schema.scheduledPayments)
      .set({ metadata: { approvalId: apB } }).where(eq(schema.scheduledPayments.id, payB));
    const resB = await executeClaimedPayment(world.db as any, payB);
    assert(resB.outcome === "pending_approval", `alive approval re-parks (got ${resB.outcome})`);
    const [payRowB] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, payB));
    assert(payRowB.status === "pending" && payRowB.executeAt.getTime() > Date.now(), "re-parked pending +15min");

    // ── C. Rejected approval + claimed payment → terminal, not re-park ───
    const payC = await insertParkedPayment(world, "", "claimed", "j364-c");
    const apC = await insertApproval(world, { status: "rejected", expiresAt: new Date(Date.now() + 3600_000), targetId: payC });
    await world.db.update(schema.scheduledPayments)
      .set({ metadata: { approvalId: apC } }).where(eq(schema.scheduledPayments.id, payC));
    const resC = await executeClaimedPayment(world.db as any, payC);
    assert(resC.outcome === "failed" && resC.error === "approval_expired", `dead approval resolves terminally (got ${JSON.stringify(resC)})`);
    const [payRowC] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, payC));
    assert(payRowC.status === "approval_expired", `payment terminal approval_expired (got ${payRowC.status})`);

    // ── D. No money moved anywhere in this journey ───────────────────────
    const ledger = await world.db.select().from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.tenantId, TID));
    assert(ledger.length === 0, "zero wallet movement — expiry never moves money");
  },
};
