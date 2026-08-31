/**
 * === W32 recurring-tiers ===
 * J202 — payout speed tiers. instant: schedule with execute_at<=now claims +
 * executes INLINE; the merchant wallet drops by the gross, the recipient leg
 * (wallet_tx `sched:<id>`) is the NET, and the platform fee (escrow_config
 * .instant_payout_fee_bps, integer cents) lands on the deterministic platform
 * fee wallet as `schedfee:<id>` — fee + net == gross exactly. standard:
 * stays honestly pending until the next execute-payments tick, free (no fee
 * leg, no fake T+1 promise).
 */
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";

const TID = "sim-w32-202";
const GROSS_CENTS = 1_000_000; // ₦10,000.00
const FEE_BPS = 50; // 0.5% → 5,000 cents fee on the gross

export const journey: Journey = {
  id: "J202",
  name: "instant payout executes inline with fee leg (fee+net==gross); standard waits for tick",
  feature: "W32 speed tiers: schedfee:<id> platform fee leg + honest next-batch standard",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const now = new Date();
    await world.db.insert(schema.tenants).values({
      id: TID, name: "J202 Speed Tiers", slug: TID, status: "active", createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    const [u] = await world.db.insert(schema.users).values({
      openId: `sim-${TID}-owner`, name: "Owner", tenantId: TID, lastSignedIn: now,
    }).onConflictDoNothing().returning({ id: schema.users.id });
    const uid = u?.id ?? 202001;
    await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: String(uid), role: "owner" }).onConflictDoNothing();
    await world.db.insert(schema.merchantWallets).values({
      id: crypto.randomUUID(), tenantId: TID, currency: "NGN",
      availableBalance: fmtMajor(5_000_000), escrowBalance: "0.00", totalEarned: "0.00", totalWithdrawn: "0.00",
      custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    // Pin the platform fee rate for deterministic math.
    await world.db.update(schema.escrowConfig).set({ instantPayoutFeeBps: FEE_BPS })
      .where(eq(schema.escrowConfig.id, 1));
    const caller = await tenantCaller(TID, { userId: uid });

    // ── instant: inline claim + execute with fee leg ──────────────────────
    const instant = await caller.scheduledPayments.schedule({
      tenantId: TID, kind: "adhoc", recipient: { name: "J202 Payee" },
      amountCents: GROSS_CENTS, currency: "NGN",
      executeAt: new Date(Date.now() - 1000), speed: "instant",
    });
    assert(instant.speed === "instant", "instant tier echoed");
    assert(instant.status === "executed", `instant executed inline (${instant.status})`);
    const expectedFee = Math.round((GROSS_CENTS * FEE_BPS) / 10_000);
    assert(instant.feeCents === expectedFee, `fee reported (${instant.feeCents} vs ${expectedFee})`);
    assert(instant.netCents === GROSS_CENTS - expectedFee, "net reported");

    // Merchant wallet dropped by the GROSS.
    const [wallet] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(wallet.availableBalance === fmtMajor(5_000_000 - GROSS_CENTS),
      `gross debited (got ${wallet.availableBalance})`);

    // Recipient leg is the NET; the fee leg credits the platform fee wallet.
    const [netTx] = await world.db.select().from(schema.walletTransactions)
      .where(and(eq(schema.walletTransactions.tenantId, TID),
        eq(schema.walletTransactions.reference, `sched:${instant.id}`)));
    assert(netTx, "sched:<id> ledger row exists");
    assert(Math.round(parseFloat(netTx.amount) * 100) === GROSS_CENTS - expectedFee,
      `net leg ${netTx.amount}`);
    const meta = (netTx.metadata ?? {}) as any;
    assert(meta.speed === "instant" && meta.grossCents === GROSS_CENTS && meta.feeCents === expectedFee,
      "net leg metadata carries gross/fee honestly");

    const { PLATFORM_FEE_WALLET_ID } = await import("../../server/services/scheduledPayments");
    const [feeTx] = await world.db.select().from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.reference, `schedfee:${instant.id}`));
    assert(feeTx, "schedfee:<id> fee leg exists");
    assert(feeTx.walletId === PLATFORM_FEE_WALLET_ID, "fee credited to the platform fee wallet");
    assert(Math.round(parseFloat(feeTx.amount) * 100) === expectedFee, `fee leg amount ${feeTx.amount}`);
    assert(
      Math.round(parseFloat(feeTx.amount) * 100) + Math.round(parseFloat(netTx.amount) * 100) === GROSS_CENTS,
      "fee + net == gross exactly",
    );
    const [platformWallet] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.id, PLATFORM_FEE_WALLET_ID));
    assert(parseFloat(platformWallet.availableBalance) * 100 >= expectedFee,
      "platform fee wallet balance includes the fee");

    // ── standard: free, waits honestly for the next batch ─────────────────
    const standard = await caller.scheduledPayments.schedule({
      tenantId: TID, kind: "adhoc", recipient: { name: "J202 Slow Payee" },
      amountCents: GROSS_CENTS, currency: "NGN",
      executeAt: new Date(Date.now() - 1000), speed: "standard",
    });
    assert(standard.speed === "standard" && standard.status === "pending",
      `standard stays pending until the tick (${standard.status})`);
    assert(/next payment batch/.test(standard.note), `honest next-batch copy (${standard.note})`);
    const [walletMid] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(walletMid.availableBalance === wallet.availableBalance, "standard moved nothing before the tick");

    const tick = await world.runCron("/api/scheduled/execute-payments");
    assert(tick.status === 200, "execute-payments tick ok");
    const [stdAfter] = await world.db.select().from(schema.scheduledPayments)
      .where(eq(schema.scheduledPayments.id, standard.id));
    assert(stdAfter.status === "executed", `standard executed by the tick (${stdAfter.status})`);
    const [stdTx] = await world.db.select().from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.reference, `sched:${standard.id}`));
    assert(Math.round(parseFloat(stdTx.amount) * 100) === GROSS_CENTS, "standard pays the full gross — free");
    const stdFee = await world.db.select().from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.reference, `schedfee:${standard.id}`));
    assert(stdFee.length === 0, "no fee leg for standard");
    const [walletFinal] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(walletFinal.availableBalance === fmtMajor(5_000_000 - 2 * GROSS_CENTS),
      `both payments debited exactly once (got ${walletFinal.availableBalance})`);
  },
};
