// === W47 stakeholders ===
/**
 * J451 — ONB-S-8 vendor payee vetting:
 *   - structured payee fields are format-validated (NUBAN 10 digits, bank
 *     code, account name required with an account);
 *   - vendors dedup on the normalised name key (same vendor, two spellings
 *     → ONE registry row, bills link to it);
 *   - payee details LOCK once a bill is approved;
 *   - the FIRST wallet payout to a registered vendor requires approved
 *     tenant KYB (fail-closed); after the first payout the vendor is
 *     stamped (kybTier basic) and pays normally.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { approveKyb, expectTrpcError, tenantCaller } from "./helpers";

const T = "j451-vendor";

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
  id: "J451",
  name: "vendor payee vetting: validation, dedup, approval lock, KYB first-payout gate",
  feature: "W47 stakeholders: ONB-S-8 vendor bills payee vetting",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    await world.db.insert(schema.tenants).values({
      id: T, name: "J451 Vendors", slug: T, status: "active",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T, userId: "4511", role: "owner",
    }).onConflictDoNothing();
    const caller = await tenantCaller(T, { userId: 4511 });
    await fundWallet(world, T, "5000.00");

    // ── 1. Malformed payee rejected ─────────────────────────────────────
    await expectTrpcError(
      caller.vendorBills.create({
        tenantId: T, vendorName: "Bad Payee Ltd", amountCents: 100000,
        payee: { bankCode: "058", accountNumber: "123", accountName: "Bad Payee" },
      }),
      "BAD_REQUEST",
      "non-NUBAN account number rejected",
    );
    await expectTrpcError(
      caller.vendorBills.create({
        tenantId: T, vendorName: "Bad Payee Ltd", amountCents: 100000,
        payee: { bankCode: "058", accountNumber: "0123456789" }, // no account name
      }),
      "BAD_REQUEST",
      "account without account name rejected",
    );

    // ── 2. Valid payee registers + links the vendor ─────────────────────
    const b1 = await caller.vendorBills.create({
      tenantId: T, vendorName: "ABC Supplies", amountCents: 100000,
      payee: { bankCode: "058", accountNumber: "0123456789", accountName: "ABC Supplies", phone: "+2348011110451" },
    });
    assert(b1.vendor?.vendorId && b1.vendor.deduped === false, "vendor registered on first bill");
    const b2 = await caller.vendorBills.create({
      tenantId: T, vendorName: "abc  SUPPLIES!!", amountCents: 50000,
      payee: { phone: "+2348011110451" },
    });
    assert(b2.vendor?.vendorId === b1.vendor.vendorId && b2.vendor.deduped === true, "vendor dedup on normalised name");
    const vendorsList = await caller.vendorBills.listVendors({ tenantId: T });
    assert(vendorsList.length === 1, "one canonical vendor row");

    // ── 3. Payee lock once approved ─────────────────────────────────────
    await world.db.update(schema.vendorBills).set({ status: "approved", updatedAt: new Date() })
      .where(eq(schema.vendorBills.id, b1.bill.id));
    await expectTrpcError(
      caller.vendorBills.update({ tenantId: T, billId: b1.bill.id, vendorContact: { bankAccount: "9999999999" } }),
      "CONFLICT",
      "payee details locked once approved",
    );
    // Non-payee fields still editable in the approved window.
    await caller.vendorBills.update({ tenantId: T, billId: b1.bill.id, description: "approved-bill note" });
    // Pending bills still allow payee edits (editable window pre-approval).
    await caller.vendorBills.update({ tenantId: T, billId: b2.bill.id, vendorContact: { phone: "+2348022220451" } });

    // ── 4. First payout requires approved tenant KYB ────────────────────
    await world.db.update(schema.vendorBills).set({ status: "pending", updatedAt: new Date() })
      .where(eq(schema.vendorBills.id, b1.bill.id));
    await expectTrpcError(
      caller.vendorBills.recordPayment({ tenantId: T, billId: b1.bill.id }),
      "FORBIDDEN",
      "first payout to a registered vendor requires KYB",
    );
    await approveKyb(world, T);
    const pay = await caller.vendorBills.recordPayment({ tenantId: T, billId: b1.bill.id });
    assert(pay.ok && pay.status === "paid", "payout succeeds once KYB approved");
    const [v] = await world.db.select().from(schema.vendors).where(eq(schema.vendors.id, b1.vendor.vendorId));
    assert(v.firstPaidAt && v.kybTier === "basic", "vendor stamped after first payout");

    // Second vendor bill pays without re-gating (vendor already vetted).
    const pay2 = await caller.vendorBills.recordPayment({ tenantId: T, billId: b2.bill.id });
    assert(pay2.ok && pay2.status === "paid", "subsequent payout to the vetted vendor is not re-gated");

    // Events recorded.
    const detail = await caller.vendorBills.get({ tenantId: T, billId: b1.bill.id });
    assert(detail.events.some((e: any) => e.event === "payment_recorded"), "payment event recorded");
  },
};
