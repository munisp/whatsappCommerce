/**
 * J206 — W33 tax-statements (Coder A): supplier tax profile capture + annual
 * totals match REAL payments (conservation vs wallet_tx).
 *
 * Two vendor bills are paid through the real vendorBills.recordPayment rail
 * (wallet debits, wallet_tx refs `vbill:<billId>`) plus one attributed payout
 * withdrawal (`payout:` ref, metadata.supplierRef). The aggregated annual
 * total for the supplier MUST equal the sum of the corresponding
 * wallet_transactions withdrawals — no fabricated figures. Also asserts the
 * OPTIONAL capture wiring on the vendor_bills create path (taxProfile +
 * vendorRef stamp).
 */
import { and, eq, like, or } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

const T = "sim-tax-206";
const VREF = "musa-supplies";

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
  id: "J206",
  name: "supplier tax profile + annual totals conservation",
  feature: "W33 tax-statements",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const YEAR = new Date().getUTCFullYear();
    await world.db.insert(schema.tenants).values({
      id: T, name: "W33 Tax 206", slug: T, status: "active",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T, userId: "2061", role: "owner",
    }).onConflictDoNothing();
    const caller = await tenantCaller(T, { userId: 2061 });
    await fundWallet(world, T, "5000.00");

    // ── Explicit profile capture (router CRUD) ───────────────────────────
    const upserted = await caller.taxStatements.upsertProfile({
      tenantId: T,
      vendorName: "Musa Supplies",
      vendorRef: VREF,
      taxId: "TIN-12345678",
      taxIdType: "tin",
      countryCode: "ng",
      withholdingBps: 0,
    });
    assert(upserted.created === true, "profile created");
    assert(upserted.profile.taxId === "TIN-12345678" && upserted.profile.taxIdType === "tin", "tax identity stored");
    assert(upserted.profile.countryCode === "NG", "country code normalized to upper-case");

    // ── Bill 1 via the create path with OPTIONAL capture wiring ──────────
    const b1 = await caller.vendorBills.create({
      tenantId: T,
      vendorName: "Musa Supplies",
      amountCents: 120000,
      vendorRef: VREF,
      taxProfile: { taxId: "TIN-12345678", taxIdType: "tin" },
    });
    const bill1 = b1.bill.id;
    assert((b1.bill.metadata as any)?.vendorRef === VREF, "create path stamps metadata.vendorRef");
    const profiles = await caller.taxStatements.listProfiles({ tenantId: T });
    assert(profiles.length === 1, `capture wiring upserts, never duplicates (got ${profiles.length})`);

    // ── Bill 2 (no capture fields — capture stays optional) ──────────────
    const b2 = await caller.vendorBills.create({
      tenantId: T,
      vendorName: "Musa Supplies",
      amountCents: 80000,
      vendorRef: VREF,
    });
    const bill2 = b2.bill.id;

    // ── Pay both through the real rail ───────────────────────────────────
    const p1 = await caller.vendorBills.recordPayment({ tenantId: T, billId: bill1 });
    const p2 = await caller.vendorBills.recordPayment({ tenantId: T, billId: bill2 });
    assert(p1.status === "paid" && p2.status === "paid", "both bills paid");

    // ── One attributed payout withdrawal (payout rail convention) ────────
    const [wallet] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, T)).limit(1);
    await world.db.insert(schema.walletTransactions).values({
      walletId: wallet.id,
      tenantId: T,
      type: "withdrawal",
      amount: "500.00",
      balanceBefore: "4800.00",
      balanceAfter: "4300.00",
      currency: "NGN",
      description: "Payout to Musa Supplies",
      reference: `payout:${VREF}:206`,
      metadata: { supplierRef: VREF, supplierName: "Musa Supplies" },
      createdAt: new Date(),
    });

    // ── Conservation: statement totals == wallet_tx truth ────────────────
    const txs = await world.db.select().from(schema.walletTransactions)
      .where(and(
        eq(schema.walletTransactions.walletId, wallet.id),
        eq(schema.walletTransactions.type, "withdrawal"),
        or(
          like(schema.walletTransactions.reference, "vbill:%"),
          like(schema.walletTransactions.reference, "payout:%"),
        ),
      ));
    const expectedCents = txs.reduce((a, t) => a + Math.round(parseFloat(t.amount) * 100), 0);
    assert(expectedCents === 120000 + 80000 + 50000, `expected 250000 cents of supplier payments (got ${expectedCents})`);

    const totals = await caller.taxStatements.annualTotals({ tenantId: T, year: YEAR });
    const bucket = totals.find((b: any) => b.supplierRef === VREF && b.currency === "NGN");
    assert(bucket, "annualTotals has a bucket for the supplier");
    assert(bucket.totalPaidCents === expectedCents,
      `CONSERVATION: annual total == wallet_tx withdrawals (${bucket.totalPaidCents} vs ${expectedCents})`);
    assert(bucket.paymentCount === txs.length, `payment count matches wallet_tx rows (${bucket.paymentCount} vs ${txs.length})`);
    assert(bucket.sources.vendorBills === 2 && bucket.sources.payouts === 1, "source attribution correct");

    // ── Upsert idempotency: same identity updates, no second row ─────────
    const again = await caller.taxStatements.upsertProfile({
      tenantId: T, vendorName: "Musa Supplies Ltd", vendorRef: VREF, withholdingBps: 250,
    });
    assert(again.created === false && again.profile.id === upserted.profile.id, "upsert reuses the profile row");
    assert(again.profile.withholdingBps === 250, "withholding bps updated");
    const after = await caller.taxStatements.listProfiles({ tenantId: T });
    assert(after.length === 1, "still exactly one profile");

    // ── Tenant guard: another tenant sees nothing ────────────────────────
    const T2 = "sim-tax-206b";
    await world.db.insert(schema.tenants).values({ id: T2, name: "Other", slug: T2, status: "active" }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({ tenantId: T2, userId: "2062", role: "owner" }).onConflictDoNothing();
    const stranger = await tenantCaller(T2, { userId: 2062 });
    const theirTotals = await stranger.taxStatements.annualTotals({ tenantId: T2, year: YEAR });
    assert(theirTotals.length === 0, "no cross-tenant leakage in annual totals");
  },
};
