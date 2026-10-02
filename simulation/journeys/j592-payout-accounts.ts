// === W59 banking-pos ===
/**
 * J592 — payout accounts: fail-closed verified add (bad NUBAN → error + NO
 * row), verified add via NIBSS name enquiry (accountName from the rail),
 * legacy wallet-column backfill idempotent, row-locked single-primary under
 * a concurrent flip race, disable (primary promote-on-disable).
 */
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

export const journey: Journey = {
  id: "J592",
  name: "payout accounts: fail-closed add, backfill idempotent, primary race, disable",
  feature: "W59 banking-pos: merchant_payout_accounts",
  async run(world: World) {
    // flutterwave rail requires FLUTTERWAVE_SECRET_KEY at call time (sim fetch
    // mock intercepts the HTTP; any non-empty key unlocks the adapter).
    process.env.FLUTTERWAVE_SECRET_KEY = "sk_flw_sim";
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/payoutAccounts");
    const { tenantId } = await seedUcTenant(world, "592", 5921);

    // ── 1. Fail-closed: unresolvable NUBAN → error, NO row ─────────────
    let failed = false;
    try {
      await svc.addPayoutAccount(world.db, { tenantId, bankCode: "044", accountNumber: "0000000000", provider: "paystack" });
    } catch (e: any) {
      failed = /verification failed/i.test(e?.message ?? "");
    }
    assert(failed, "add with unresolvable account must throw (fail-closed)");
    let rows = await world.db.select().from(schema.merchantPayoutAccounts).where(eq(schema.merchantPayoutAccounts.tenantId, tenantId));
    assert(rows.length === 0, "fail-closed add wrote no row");

    // ── 2. Verified add: accountName comes from the rail ───────────────
    const add1 = await svc.addPayoutAccount(world.db, { tenantId, bankCode: "044", accountNumber: "0123456789", provider: "paystack" });
    assert(!add1.duplicate && add1.account.accountName.includes("SIM RESOLVED"), "name enquiry populated accountName");
    assert(add1.account.isPrimary === true, "first account is primary");
    // Idempotent re-add
    const add1b = await svc.addPayoutAccount(world.db, { tenantId, bankCode: "044", accountNumber: "0123456789", provider: "paystack" });
    assert(add1b.duplicate === true && add1b.account.id === add1.account.id, "re-add is an idempotent replay");
    const add2 = await svc.addPayoutAccount(world.db, { tenantId, bankCode: "058", accountNumber: "2222222222", provider: "flutterwave" });
    assert(add2.account.isPrimary === false, "second account is not primary");

    // ── 3. Legacy backfill idempotent ──────────────────────────────────
    const { tenantId: legacyTenant } = await seedUcTenant(world, "592b", 5922);
    await world.db.insert(schema.merchantWallets).values({
      tenantId: legacyTenant, custodyMode: "psp", availableBalance: "0",
      bankAccountName: "Legacy Merchant", bankAccountNumber: "3333333333", bankCode: "057",
    }).onConflictDoNothing();
    await svc.backfillLegacyPayoutAccount(world.db, legacyTenant);
    await svc.backfillLegacyPayoutAccount(world.db, legacyTenant); // replay
    rows = await world.db.select().from(schema.merchantPayoutAccounts).where(eq(schema.merchantPayoutAccounts.tenantId, legacyTenant));
    assert(rows.length === 1 && rows[0].isPrimary && rows[0].provider === "paystack", "backfill created exactly one primary row");

    // ── 4. Concurrent setPrimary race → exactly one primary ────────────
    await Promise.all([
      svc.setPrimaryPayoutAccount(world.db, tenantId, add1.account.id).catch(() => null),
      svc.setPrimaryPayoutAccount(world.db, tenantId, add2.account.id).catch(() => null),
    ]);
    await svc.setPrimaryPayoutAccount(world.db, tenantId, add2.account.id);
    rows = await world.db.select().from(schema.merchantPayoutAccounts).where(eq(schema.merchantPayoutAccounts.tenantId, tenantId));
    const primaries = rows.filter((r: any) => r.isPrimary && r.status === "active");
    assert(primaries.length === 1 && primaries[0].id === add2.account.id, "exactly one primary after race");

    // ── 5. Disable promotes the remaining active account ───────────────
    await svc.disablePayoutAccount(world.db, tenantId, add2.account.id);
    rows = await world.db.select().from(schema.merchantPayoutAccounts).where(eq(schema.merchantPayoutAccounts.tenantId, tenantId));
    const after = rows.filter((r: any) => r.isPrimary && r.status === "active");
    assert(after.length === 1 && after[0].id === add1.account.id, "disable promoted the other active account");
  },
};
