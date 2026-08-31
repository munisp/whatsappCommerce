/**
 * J183 — W31 vendor-bills (Coder A): manual vendor bill → pay in full.
 *
 * A manual bill is created, paid in full through vendorBills.recordPayment —
 * a REAL wallet debit via the locked helpers (atomic conditional decrement,
 * wallet_tx reference `vbill:<billId>`) — and the paid bill is enqueued into
 * the Odoo outbox (queued honestly: no Odoo config in this journey).
 */
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

const T = "sim-vbill-183";

async function fundWallet(world: World, tenantId: string, balance: string) {
  const schema = await import("../../drizzle/schema");
  await world.db.insert(schema.merchantWallets)
    .values({ tenantId, availableBalance: balance })
    .onConflictDoNothing();
  await world.db.update(schema.merchantWallets)
    .set({ availableBalance: balance, updatedAt: new Date() })
    .where(eq(schema.merchantWallets.tenantId, tenantId));
}

export const journey: Journey = {
  id: "J183",
  name: "vendor bill pay in full",
  feature: "W31 vendor-bills AP inbox",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    // moneyProcedure requires an owner/operator membership row.
    await world.db.insert(schema.tenants).values({
      id: T, name: "W31 VBills 1831", slug: T, status: "active",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T, userId: "1831", role: "owner",
    }).onConflictDoNothing();
    const caller = await tenantCaller(T, { userId: 1831 });
    await fundWallet(world, T, "1000.00"); // ₦1,000.00 = 100,000 cents

    // ── Manual create ────────────────────────────────────────────────────
    const created = await caller.vendorBills.create({
      tenantId: T,
      vendorName: "Musa Supplies",
      billNumber: "INV-183",
      description: "40 cartons of detergent",
      amountCents: 50000,
      dueDate: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });
    assert(created.bill.status === "pending", `bill pending (got ${created.bill.status})`);
    assert(created.reviewRequired === false, "manual create needs no review");
    const billId = created.bill.id;

    // ── Pay in full (remaining by default) ───────────────────────────────
    const pay = await caller.vendorBills.recordPayment({ tenantId: T, billId });
    assert(pay.ok === true && pay.status === "paid", `paid (got ${pay.status})`);
    assert(pay.chargedCents === 50000, "charged the full amount");
    assert(pay.paymentRef === `vbill:${billId}`, `wallet ref vbill:<billId> (got ${pay.paymentRef})`);

    // ── Wallet debit asserted ────────────────────────────────────────────
    const [wallet] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, T)).limit(1);
    assert(Math.round(parseFloat(wallet.availableBalance) * 100) === 50000,
      `wallet debited exactly 500.00 (got ${wallet.availableBalance})`);
    const txs = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.walletId, wallet.id), eq(schema.walletTransactions.reference, `vbill:${billId}`)));
    assert(txs.length === 1, `exactly one wallet ledger entry (got ${txs.length})`);
    assert(txs[0].type === "withdrawal" && txs[0].amount === "500.00", "withdrawal ledger entry carries the debit");

    // ── Bill row + audit events ──────────────────────────────────────────
    const got = await caller.vendorBills.get({ tenantId: T, billId });
    assert(got.bill.status === "paid" && got.bill.paidCents === 50000, "bill paid in full");
    assert(got.bill.paymentRef === `vbill:${billId}`, "payment_ref stored on the bill");
    assert(got.bill.odooSyncState === "queued", `odoo sync queued honestly (got ${got.bill.odooSyncState})`);
    const eventNames = got.events.map((e: any) => e.event);
    assert(eventNames.includes("created") && eventNames.includes("payment_recorded"), "audit events appended");

    // ── Odoo outbox row (queued honestly — no Odoo config) ──────────────
    const outbox = await world.db.select().from(schema.odooSyncOutbox)
      .where(and(eq(schema.odooSyncOutbox.tenantId, T), eq(schema.odooSyncOutbox.entityType, "vendor_bill_payment")));
    assert(outbox.length === 1, `one vendor_bill_payment outbox row (got ${outbox.length})`);
    assert(outbox[0].status === "pending", `outbox queued, not faked (got ${outbox[0].status})`);
    assert((outbox[0].payload as any).paidCents === 50000, "payload carries paid cents");

    // ── Analyst is read-only: list works, payment is FORBIDDEN ──────────
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T, userId: "1832", role: "analyst",
    }).onConflictDoNothing();
    const analyst = await tenantCaller(T, { userId: 1832 });
    const listed = await analyst.vendorBills.list({ tenantId: T, status: "paid" });
    assert(listed.some((b: any) => b.id === billId), "analyst can list bills");
    const denied = await analyst.vendorBills.recordPayment({ tenantId: T, billId }).catch((e: any) => e);
    assert(denied?.code === "FORBIDDEN" || denied?.data?.code === "FORBIDDEN", "analyst cannot record payments");

    // ── Paying again is an honest CONFLICT, no second debit ─────────────
    const again = await caller.vendorBills.recordPayment({ tenantId: T, billId }).catch((e: any) => e);
    assert(again?.code === "CONFLICT" || again?.data?.code === "CONFLICT", "re-pay rejects CONFLICT");
    const [walletAfter] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, T)).limit(1);
    assert(walletAfter.availableBalance === wallet.availableBalance, "no second debit");
  },
};
