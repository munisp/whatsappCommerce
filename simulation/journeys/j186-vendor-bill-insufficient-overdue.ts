/**
 * J186 — W31 vendor-bills (Coder A): honesty rails.
 *  1. INSUFFICIENT_FUNDS: paying a bill larger than the wallet balance
 *     fails honestly and NOTHING moves (wallet + bill unchanged).
 *  2. The overdue sweep flips due bills to 'overdue' (guarded, repeatable).
 *  3. The sales digest honestly includes overdue vendor bills.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { expectTrpcError, tenantCaller } from "./helpers";

const T = "sim-vbill-186";

export const journey: Journey = {
  id: "J186",
  name: "insufficient funds + overdue sweep",
  feature: "W31 vendor-bills AP inbox",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    await world.db.insert(schema.tenants).values({
      id: T, name: "W31 VBills 1861", slug: T, status: "active",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T, userId: "1861", role: "owner",
    }).onConflictDoNothing();
    const caller = await tenantCaller(T, { userId: 1861 });
    // Wallet with a small balance.
    await world.db.insert(schema.merchantWallets)
      .values({ tenantId: T, availableBalance: "100.00" })
      .onConflictDoNothing();
    await world.db.update(schema.merchantWallets)
      .set({ availableBalance: "100.00", updatedAt: new Date() })
      .where(eq(schema.merchantWallets.tenantId, T));

    // ── 1. Insufficient funds honesty ────────────────────────────────────
    const created = await caller.vendorBills.create({
      tenantId: T, vendorName: "Big Supplier Co", amountCents: 500000, // ₦5,000
      dueDate: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });
    const billId = created.bill.id;
    const err = await expectTrpcError(
      caller.vendorBills.recordPayment({ tenantId: T, billId }),
      "BAD_REQUEST", "insufficient funds",
    );
    assert(/INSUFFICIENT_FUNDS/.test(err?.message ?? ""), `honest INSUFFICIENT_FUNDS (got ${err?.message})`);
    const [wallet] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, T)).limit(1);
    assert(wallet.availableBalance === "100.00", `wallet untouched (got ${wallet.availableBalance})`);
    const txs = await world.db.select().from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.walletId, wallet.id));
    assert(txs.length === 0, "no ledger entry written");
    const after = await caller.vendorBills.get({ tenantId: T, billId });
    assert(after.bill.status === "pending" && after.bill.paidCents === 0, "bill still pending, nothing moved");

    // ── 2. Overdue sweep ─────────────────────────────────────────────────
    const overdueBill = await caller.vendorBills.create({
      tenantId: T, vendorName: "Late Supplier", amountCents: 30000,
      dueDate: new Date(Date.now() - 3 * 24 * 3600 * 1000), // 3 days ago
    });
    // Not yet swept → still pending.
    assert(overdueBill.bill.status === "pending", "past-due bill is pending until the sweep runs");
    const sweep = await caller.vendorBills.markOverdue({ tenantId: T });
    assert(sweep.flipped === 1 && sweep.billIds.includes(overdueBill.bill.id), `sweep flips the due bill (got ${sweep.flipped})`);
    const got = await caller.vendorBills.get({ tenantId: T, billId: overdueBill.bill.id });
    assert(got.bill.status === "overdue", `status overdue (got ${got.bill.status})`);
    assert(got.events.some((e: any) => e.event === "overdue"), "overdue audit event");
    // Sweep is idempotent — second run flips nothing.
    const sweep2 = await caller.vendorBills.markOverdue({ tenantId: T });
    assert(sweep2.flipped === 0, "sweep is repeatable");

    // ── 3. Digest includes overdue bills ─────────────────────────────────
    const { computeSalesSummary, renderDigestMessage } = await import("../../server/services/bookkeeping");
    const summary = await computeSalesSummary(world.db, T, "weekly", new Date());
    assert((summary.vendorBillsOverdueCount ?? 0) === 1, `digest counts 1 overdue bill (got ${summary.vendorBillsOverdueCount})`);
    assert(summary.vendorBillsOverdueCents === 30000, `digest overdue cents (got ${summary.vendorBillsOverdueCents})`);
    const msg = renderDigestMessage(summary);
    assert(/vendor bill/i.test(msg) && /overdue/.test(msg), `digest message mentions overdue bills: ${msg}`);
  },
};
