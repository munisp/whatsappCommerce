/**
 * J197 — W31 merger seam: the approval gate wired across Coder A's vendor
 * bills and Coder B's scheduled payments (the cross-branch contract).
 *
 * 1. Policy covers vendor_bill_payment + scheduled_payment (threshold ₦100).
 * 2. Vendor bill payment above threshold parks (pending_approval, no money),
 *    direct re-pay is refused, owner approve executes exactly once
 *    (vbill:<billId> ledger + wallet asserted), second approve → CONFLICT.
 * 3. Adhoc scheduled payment above threshold is parked BY THE CRON TICK
 *    (claimed → pending with metadata.approvalId, wallet untouched), approve
 *    executes it via the scheduled_payment executor (sched:<id> ledger),
 *    and the next tick is a no-op.
 */
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { expectTrpcError, tenantCaller } from "./helpers";

const T = "j197-tenant";

async function fundWallet(world: World, tenantId: string, balance: string) {
  const schema = await import("../../drizzle/schema");
  await world.db.insert(schema.merchantWallets).values({
    tenantId, custodyMode: "psp", availableBalance: balance,
    bankAccountName: "J197 Merchant", bankAccountNumber: "0123456789", bankCode: "058",
  }).onConflictDoNothing();
}

async function walletCents(world: World): Promise<number> {
  const schema = await import("../../drizzle/schema");
  const [w] = await world.db.select().from(schema.merchantWallets)
    .where(eq(schema.merchantWallets.tenantId, T));
  return Math.round(parseFloat(w.availableBalance) * 100);
}

export const journey: Journey = {
  id: "J197",
  name: "approval gate across vendor bills + scheduled payments (merger seam)",
  feature: "W31 approvals × vendor-bills × scheduled-payments cross-branch wiring",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    await world.db.insert(schema.tenants).values({
      id: T, name: "J197 Seam", slug: T, status: "active",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T, userId: "1971", role: "owner",
    }).onConflictDoNothing();
    const caller = await tenantCaller(T, { userId: 1971 });
    await fundWallet(world, T, "1000.00"); // 100,000 cents

    const pol = await caller.approvals.setPolicy({
      tenantId: T, thresholdCents: 10_000,
      kinds: ["vendor_bill_payment", "scheduled_payment"], approverRole: "owner", expiryHours: 72,
    });
    assert(pol.ok === true && pol.enabled === true, "owner set policy for both kinds");

    // ── Vendor bill above threshold parks ──────────────────────────────
    const created = await caller.vendorBills.create({
      tenantId: T, vendorName: "Seam Supplies", billNumber: "INV-197",
      amountCents: 50_000, dueDate: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });
    const billId = created.bill.id;
    const parked = await caller.vendorBills.recordPayment({ tenantId: T, billId });
    assert(parked.approvalRequired === true, `bill payment parked for approval (${JSON.stringify(parked)})`);
    assert(typeof parked.approvalId === "string", "parked payment carries approvalId");
    const [billParked] = await world.db.select().from(schema.vendorBills)
      .where(eq(schema.vendorBills.id, billId));
    assert(billParked.status === "pending_approval", `bill pending_approval (got ${billParked.status})`);
    assert((await walletCents(world)) === 100_000, "nothing debited while parked");

    // Direct re-pay is refused (parked state is payable only via approval).
    await expectTrpcError(
      caller.vendorBills.recordPayment({ tenantId: T, billId }),
      "CONFLICT",
      "direct re-pay of a parked bill refused",
    );

    // Approve → executes exactly once.
    const approved = await caller.approvals.approve({ tenantId: T, approvalId: parked.approvalId });
    assert(approved.ok === true && approved.executed === true, `approval executed (${JSON.stringify(approved.execution)})`);
    const [billPaid] = await world.db.select().from(schema.vendorBills)
      .where(eq(schema.vendorBills.id, billId));
    assert(billPaid.status === "paid", `bill paid after approval (got ${billPaid.status})`);
    assert(billPaid.paymentRef === `vbill:${billId}`, "vbill:<billId> reference");
    assert((await walletCents(world)) === 50_000, `wallet debited once (got ${await walletCents(world)})`);
    await expectTrpcError(
      caller.approvals.approve({ tenantId: T, approvalId: parked.approvalId }),
      "CONFLICT",
      "second approve single-consumption",
    );

    // ── Adhoc scheduled payment above threshold parks at the tick ──────
    const sched = await caller.scheduledPayments.schedule({
      tenantId: T, kind: "adhoc", recipient: { name: "Seam Vendor", account: "9998887776", bankCode: "058" },
      amountCents: 30_000, currency: "NGN",
      executeAt: new Date(Date.now() - 1000), idempotencyKey: "j197-sched-1",
    });
    assert(sched.status === "pending", "scheduled pending");
    const tick1 = await world.runCron("/api/scheduled/execute-payments");
    assert(tick1.status === 200, `cron accepted (got ${tick1.status})`);
    const [rowParked] = await world.db.select().from(schema.scheduledPayments)
      .where(eq(schema.scheduledPayments.id, sched.id));
    assert(rowParked.status === "pending", `parked back to pending (got ${rowParked.status})`);
    const schedApprovalId = (rowParked.metadata as Record<string, unknown>)?.approvalId as string | undefined;
    assert(typeof schedApprovalId === "string", "parked scheduled payment carries metadata.approvalId");
    assert((await walletCents(world)) === 50_000, "tick moved nothing while parked");

    // Approve → scheduled_payment executor claims + executes.
    const approved2 = await caller.approvals.approve({ tenantId: T, approvalId: schedApprovalId! });
    assert(approved2.ok === true && approved2.executed === true, `scheduled approval executed (${JSON.stringify(approved2.execution)})`);
    const [rowExecuted] = await world.db.select().from(schema.scheduledPayments)
      .where(eq(schema.scheduledPayments.id, sched.id));
    assert(rowExecuted.status === "executed", `scheduled executed (got ${rowExecuted.status})`);
    assert((await walletCents(world)) === 20_000, `wallet debited scheduled payment once (got ${await walletCents(world)})`);
    const ledger = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.tenantId, T), eq(schema.walletTransactions.reference, `sched:${sched.id}`)));
    assert(ledger.length === 1, "exactly one sched:<id> ledger row");

    // Next tick is a no-op (already executed; nothing re-parks).
    const tick2 = await world.runCron("/api/scheduled/execute-payments");
    assert(tick2.status === 200, "second cron accepted");
    assert((await walletCents(world)) === 20_000, "second tick moved nothing");
    const ledger2 = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.tenantId, T), eq(schema.walletTransactions.reference, `sched:${sched.id}`)));
    assert(ledger2.length === 1, "still one ledger row after second tick");
  },
};
