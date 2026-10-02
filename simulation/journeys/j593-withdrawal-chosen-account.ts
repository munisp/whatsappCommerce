// === W59 banking-pos ===
/**
 * J593 — withdrawal to a CHOSEN payout account (payoutAccountId) is
 * replay-safe on the client reference; default resolves the primary account
 * (legacy columns backfilled); provider rail recorded in ledger metadata.
 */
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { approveKyb, tenantCaller } from "./helpers";
import { seedUcTenant } from "./w46-uc-docs-seed";

export const journey: Journey = {
  id: "J593",
  name: "withdrawal: chosen account replay-safe, default-primary, rail metadata",
  feature: "W59 banking-pos: requestWithdrawal payoutAccountId",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/payoutAccounts");
    const { tenantId, caller } = await seedUcTenant(world, "593", 5931);
    await approveKyb(world, tenantId);
    await world.db.update(schema.escrowConfig).set({ custodyMode: "psp" }).where(eq(schema.escrowConfig.id, 1));
    await world.db.insert(schema.merchantWallets).values({
      tenantId, custodyMode: "psp", availableBalance: "5000.00",
    }).onConflictDoNothing();

    const acct = await svc.addPayoutAccount(world.db, { tenantId, bankCode: "044", accountNumber: "0123456789", provider: "paystack" });
    const acct2 = await svc.addPayoutAccount(world.db, { tenantId, bankCode: "058", accountNumber: "2222222222", provider: "paystack" });

    // ── 1. Chosen account (non-primary) ────────────────────────────────
    const wd1 = await caller.wallet.requestWithdrawal({
      tenantId, amount: 200, reference: "J593-WD1", payoutAccountId: acct2.account.id,
    });
    assert(wd1.success && !wd1.duplicate, "first withdrawal initiated");
    const [tx1] = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.tenantId, tenantId), eq(schema.walletTransactions.reference, "J593-WD1")));
    const meta = tx1.metadata as any;
    assert(meta?.payoutAccountId === acct2.account.id && meta?.provider === "paystack", "ledger metadata records chosen account + rail");
    assert(meta?.bankAccountNumber === "2222222222", "payout went to the chosen account");

    // ── 2. Replay same reference → idempotent duplicate, no double debit ─
    const wd1b = await caller.wallet.requestWithdrawal({ tenantId, amount: 200, reference: "J593-WD1", payoutAccountId: acct2.account.id });
    assert(wd1b.duplicate === true, "replay returns duplicate:true");
    const [w1] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, tenantId));
    assert(parseFloat(w1.availableBalance) === 4800, "exactly one debit");

    // ── 3. Default: primary account ────────────────────────────────────
    const wd2 = await caller.wallet.requestWithdrawal({ tenantId, amount: 100, reference: "J593-WD2" });
    assert(wd2.success, "default-primary withdrawal initiated");
    const [tx2] = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.tenantId, tenantId), eq(schema.walletTransactions.reference, "J593-WD2")));
    assert((tx2.metadata as any)?.payoutAccountId === acct.account.id, "default resolved the primary account");
    // disabled account is rejected
    await svc.disablePayoutAccount(world.db, tenantId, acct2.account.id);
    let rejected = false;
    try {
      await caller.wallet.requestWithdrawal({ tenantId, amount: 100, reference: "J593-WD3", payoutAccountId: acct2.account.id });
    } catch (e: any) { rejected = /disabled/i.test(e?.message ?? ""); }
    assert(rejected, "disabled payout account rejected");
  },
};
