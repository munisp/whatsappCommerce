/**
 * J184 — W31 vendor-bills (Coder A): partial payments → partially_paid →
 * paid, and an idempotent replay of a payment_ref performs NO second debit.
 */
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

const T = "sim-vbill-184";

export const journey: Journey = {
  id: "J184",
  name: "vendor bill partial payments",
  feature: "W31 vendor-bills AP inbox",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    await world.db.insert(schema.tenants).values({
      id: T, name: "W31 VBills 1841", slug: T, status: "active",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T, userId: "1841", role: "owner",
    }).onConflictDoNothing();
    const caller = await tenantCaller(T, { userId: 1841 });
    await world.db.insert(schema.merchantWallets)
      .values({ tenantId: T, availableBalance: "2000.00" })
      .onConflictDoNothing();
    await world.db.update(schema.merchantWallets)
      .set({ availableBalance: "2000.00", updatedAt: new Date() })
      .where(eq(schema.merchantWallets.tenantId, T));

    const created = await caller.vendorBills.create({
      tenantId: T, vendorName: "Adaeze Wholesale", amountCents: 100000,
    });
    const billId = created.bill.id;

    // ── Partial payment #1 (explicit ref) ────────────────────────────────
    const p1 = await caller.vendorBills.recordPayment({
      tenantId: T, billId, amountCents: 40000, paymentRef: `vbill:${billId}:p1`,
    });
    assert(p1.status === "partially_paid" && p1.paidCents === 40000, `partially_paid after first (got ${p1.status})`);

    // ── Idempotent replay of payment_ref → no second debit ──────────────
    const replay = await caller.vendorBills.recordPayment({
      tenantId: T, billId, amountCents: 40000, paymentRef: `vbill:${billId}:p1`,
    });
    assert(replay.duplicate === true, "replay flagged duplicate");
    assert(replay.chargedCents === 0, "replay charges nothing");
    const [w1] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, T)).limit(1);
    assert(Math.round(parseFloat(w1.availableBalance) * 100) === 160000,
      `wallet debited once for the partial (got ${w1.availableBalance})`);
    const p1txs = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.walletId, w1.id), eq(schema.walletTransactions.reference, `vbill:${billId}:p1`)));
    assert(p1txs.length === 1, `exactly one ledger entry for the replayed ref (got ${p1txs.length})`);

    // ── Partial payment #2 settles the bill ─────────────────────────────
    const p2 = await caller.vendorBills.recordPayment({
      tenantId: T, billId, amountCents: 60000, paymentRef: `vbill:${billId}:p2`,
    });
    assert(p2.status === "paid" && p2.paidCents === 100000, `paid after second (got ${p2.status})`);

    const got = await caller.vendorBills.get({ tenantId: T, billId });
    assert(got.bill.status === "paid", "bill paid");
    const payments = got.events.filter((e: any) => e.event === "payment_recorded");
    assert(payments.length === 2, `two payment_recorded audit events (got ${payments.length})`);

    const [w2] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, T)).limit(1);
    assert(Math.round(parseFloat(w2.availableBalance) * 100) === 100000,
      `wallet reflects exactly the bill total (got ${w2.availableBalance})`);
    const allTxs = await world.db.select().from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.walletId, w2.id));
    assert(allTxs.filter((t: any) => String(t.reference ?? "").startsWith(`vbill:${billId}`)).length === 2,
      "exactly two wallet ledger entries across both partials");

    // Over-payment guard: a settled bill rejects further payment.
    const over = await caller.vendorBills.recordPayment({ tenantId: T, billId, amountCents: 1 })
      .catch((e: any) => e);
    assert(over?.code === "CONFLICT" || over?.data?.code === "CONFLICT", "paid bill rejects further payment");
  },
};
