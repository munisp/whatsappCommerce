// === W45 money-intents (Coder B2) ===
/**
 * J370 — PAY-24: cron sweep of stale non-terminal Paystack transfers.
 *
 * Seeds a merchant wallet with three withdrawal rows — one stale "pending"
 * (provider has NO such transfer → compensating credit), one stale "otp"
 * (auto-cancel + ops alert + compensating credit), one FRESH "pending"
 * (untouched) — then drives the REAL /api/scheduled/transfer-sweep cron route
 * (W42 cronAuth) and asserts the compensating credits landed exactly once.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { pay } from "../metaMock";

export const journey: Journey = {
  id: "J370",
  name: "PAY-24: stale transfer sweep → verify → compensating credit / otp cancel",
  feature: "W45 staleTransferSweep + /api/scheduled/transfer-sweep",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { getRecentErrors, _resetRecentErrors } = await import("../../server/services/observability");
    _resetRecentErrors();

    // Merchant wallet (tenantId is unique — reuse if a prior journey seeded it).
    let [wallet] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TENANT_ID)).limit(1);
    if (!wallet) {
      await world.db.insert(schema.merchantWallets).values({
        tenantId: TENANT_ID,
        currency: "NGN",
        availableBalance: "0.00",
        escrowBalance: "0.00",
        totalEarned: "0.00",
        totalWithdrawn: "0.00",
        custodyMode: "psp",
        isActive: true,
      });
      [wallet] = await world.db.select().from(schema.merchantWallets)
        .where(eq(schema.merchantWallets.tenantId, TENANT_ID)).limit(1);
    }
    const walletId = wallet.id;
    const balanceBefore = parseFloat(wallet.availableBalance);

    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    const mkRef = (tag: string) => `WD-j370-${tag}-${Date.now()}`;
    const stalePendingRef = mkRef("stale");
    const staleOtpRef = mkRef("otp");
    const freshRef = mkRef("fresh");

    const seedWithdrawal = async (ref: string, amount: string, status: string, createdAt: Date) => {
      await world.db.insert(schema.walletTransactions).values({
        walletId,
        tenantId: TENANT_ID,
        type: "withdrawal",
        amount,
        balanceBefore: "0.00",
        balanceAfter: "0.00",
        currency: "NGN",
        description: `J370 ${status} withdrawal`,
        reference: ref,
        metadata: { status },
        createdAt,
      });
    };
    await seedWithdrawal(stalePendingRef, "1000.00", "pending", twoHoursAgo);
    await seedWithdrawal(staleOtpRef, "2000.00", "otp", twoHoursAgo);
    await seedWithdrawal(freshRef, "500.00", "pending", new Date());

    // Provider truth: the stale pending transfer does NOT exist at Paystack.
    pay.transferVerifyStatuses.set(stalePendingRef, { found: false, status: null });

    // Drive the REAL cron route (W42 cron JWT signed by the world helper).
    const res = await world.runCron("/api/scheduled/transfer-sweep");
    assert(res.status === 200, `cron route 200 (got ${res.status}: ${JSON.stringify(res.json).slice(0, 200)})`);
    assert(res.json.ok === true, "sweep ok");
    assert(res.json.scanned === 2, `swept the two stale rows only (got ${res.json.scanned})`);

    // Stale pending → verified not-found → compensating credit.
    const [staleRow] = await world.db.select().from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.reference, stalePendingRef)).limit(1);
    assert((staleRow.metadata as any)?.status === "failed", "stale pending marked failed");
    assert(String((staleRow.metadata as any)?.failureReason ?? "").includes("not found"), "verify-not-found reason recorded");

    // Stale otp → ops alert + auto-cancel with compensating credit.
    const [otpRow] = await world.db.select().from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.reference, staleOtpRef)).limit(1);
    assert((otpRow.metadata as any)?.status === "failed", "stale otp auto-cancelled (failed)");
    assert(String((otpRow.metadata as any)?.failureReason ?? "").includes("stale_otp_auto_cancel"), "otp auto-cancel reason");
    const otpAlerts = getRecentErrors(50).filter(
      (e) => e.service === "payments/staleTransferSweep" && e.severity === "critical",
    );
    assert(otpAlerts.length >= 1, "stale-otp ops alert captured");

    // Compensating credits: +1000 +2000 on the wallet, exactly once.
    const [walletAfter] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.id, walletId)).limit(1);
    assert(
      parseFloat(walletAfter.availableBalance) === balanceBefore + 3000,
      `compensating credits landed exactly (+3000; got ${walletAfter.availableBalance} from ${balanceBefore})`,
    );

    // Fresh row untouched.
    const [freshRow] = await world.db.select().from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.reference, freshRef)).limit(1);
    assert((freshRow.metadata as any)?.status === "pending", "fresh pending row NOT swept");

    // Idempotent re-run: second sweep finds nothing non-terminal → no double credit.
    const res2 = await world.runCron("/api/scheduled/transfer-sweep");
    assert(res2.json.scanned === 0, "second sweep finds nothing (terminal rows excluded)");
    const [walletAfter2] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.id, walletId)).limit(1);
    assert(parseFloat(walletAfter2.availableBalance) === balanceBefore + 3000, "no double compensating credit");
  },
};
