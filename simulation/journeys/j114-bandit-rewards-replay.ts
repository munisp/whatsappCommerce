/**
 * J114 (O4) — contextual-bandit credit limits, operator view, on a FRESH
 * supplier tenant (isolated from J100's sim-tenant history so coverage and
 * replay numbers are exact):
 *   1. Seed 120 bandit_decisions (30 per multiplier arm) plus the repayment
 *      outcomes that imply each arm's reward (×0.75 defaults, ×1.0/×1.25
 *      late-cure, ×1.5 repays on time).
 *   2. The bandit-reward-tick cron assigns rewards from the realized
 *      outcomes (1 / 0.5 / 0) and is idempotent on a second pass.
 *   3. banditStatus: exact coverage on the fresh tenant (120 logged, 120
 *      rewarded, full coverage, shadow mode, not actively serving).
 *   4. banditReplay: off-policy evaluation vs the ×1.0 baseline arm —
 *      baseline avg reward exactly 0.5, bandit avg reward higher, positive
 *      lift, per-arm stats correct.
 *   5. Shadow suggest does NOT change the actual limit: the served limit
 *      equals the rule-based baseline (bandit:false A/B) while the bandit's
 *      choice (×1.5) is merely logged as a shadow decision row.
 *   6. Cross-tenant guards on banditStatus / banditReplay (FORBIDDEN).
 *
 * NOTE: services are imported LAZILY inside run() — loadJourneys() executes
 * before bootWorld() sets the sim env (see j101 header).
 */
import { randomUUID } from "crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

const N = 120; // ≥ BANDIT_PARAMS.minRewardedDecisions (100)
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const BASELINE_CENTS = 10_000_000; // ₦100k

const buyerId = (i: number) => `j114-buyer-${i}`;
const multFor = (i: number) => [0.75, 1.0, 1.25, 1.5][i % 4];

async function seedBanditBook(world: World, supplier: string) {
  const schema = await import("../../drizzle/schema");
  const { banditContext } = await import("../../server/services/banditLimits");
  const now = Date.now();

  for (let i = 0; i < N; i++) {
    const buyer = buyerId(i);
    const mult = multFor(i);
    // Platform history: first order 120d ago (tenure), one recent (volume),
    // one completed on-time payment.
    for (const [k, daysAgo] of [[0, 120], [1, 10]] as const) {
      await world.db.insert(schema.orders).values({
        id: `j114-ord-${buyer}-${k}`,
        tenantId: buyer,
        customerId: `j114-cust-${buyer}`,
        orderNumber: `J114-${buyer}-${k}`,
        status: "delivered",
        totalAmount: "500000.00",
        currency: "NGN",
        createdAt: new Date(now - daysAgo * DAY),
        updatedAt: new Date(now - daysAgo * DAY),
      }).onConflictDoNothing();
    }
    await world.db.insert(schema.paymentTransactions).values({
      id: `j114-pay-${buyer}`,
      tenantId: buyer,
      provider: "paystack",
      providerRef: `J114PAY-${buyer}`,
      amount: "1000.00",
      currency: "NGN",
      status: "completed",
      createdAt: new Date(now - 20 * DAY),
      paidAt: new Date(now - 20 * DAY + HOUR),
    }).onConflictDoNothing();

    // Credit account + ONE draw created AFTER the decision, with the outcome
    // implied by the arm: ×0.75 defaults, ×1.0/×1.25 late-cure, ×1.5 repays.
    const accountId = randomUUID();
    const defaulted = mult === 0.75;
    const lateCured = mult === 1.0 || mult === 1.25;
    await world.db.insert(schema.creditAccounts).values({
      id: accountId,
      supplierTenantId: supplier,
      buyerTenantId: buyer,
      limitCents: 30_000_000,
      outstandingCents: defaulted ? 8_000_000 : 0,
      termsDays: 30,
      status: "active",
    });
    await world.db.insert(schema.creditLedger).values({
      id: randomUUID(),
      creditAccountId: accountId,
      kind: "invoice_draw",
      amountCents: 8_000_000,
      dueDate: new Date(now - (defaulted ? 30 : 5) * DAY),
      status: defaulted ? "posted" : "settled",
      ref: `j114-draw-${i}`,
      note: defaulted || lateCured ? "late repayment [dun:fee] applied" : null,
      createdAt: new Date(now - DAY),
    });

    // The logged bandit decision (shadow), reward pending.
    await world.db.insert(schema.banditDecisions).values({
      tenantId: supplier,
      buyerId: buyer,
      context: banditContext({ pd: 0.2, utilization: 0.3, tenureDays: 120, volume90dCents: 50_000_000 }),
      chosenMultiplier: mult,
      suggestedLimitCents: Math.round((BASELINE_CENTS * mult) / 1000) * 1000,
      baselineLimitCents: BASELINE_CENTS,
      mode: "shadow",
      createdAt: new Date(now - 40 * DAY),
    });
  }
}

export const journey: Journey = {
  id: "J114",
  name: "bandit rewards + off-policy replay (O4)",
  feature: "seeded decisions + outcomes → reward tick → banditStatus coverage → banditReplay lift vs ×1.0 baseline → shadow suggest unchanged",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { suggestLimitTx } = await import("../../server/services/tradeCredit/scoring");
    const admin = await adminCaller();

    // Fresh supplier tenant → exact, isolated bandit bookkeeping.
    const supplier = (await admin.onboarding.start({ name: "J114 Bandit Supplier" })).tenantId;
    await seedBanditBook(world, supplier);
    const caller = await tenantCaller(supplier, { userId: 1140 });

    // ── 1-2. Reward tick assigns rewards; idempotent on a second pass ────
    const tick = await world.runCron("/api/scheduled/bandit-reward-tick");
    assert(tick.status === 200 && tick.json?.ok === true, `cron tick ok (got ${tick.status})`);
    assert(tick.json.rewarded >= N, `tick rewarded ≥${N} (got ${tick.json.rewarded})`);

    const myRows = await world.db
      .select()
      .from(schema.banditDecisions)
      .where(eq(schema.banditDecisions.tenantId, supplier));
    assert(myRows.length === N, `exactly ${N} decisions on the fresh tenant (got ${myRows.length})`);
    const rewarded = myRows.filter((r: any) => r.reward != null);
    assert(rewarded.length === N, `all ${N} decisions rewarded (got ${rewarded.length})`);
    const byMult = new Map<number, number[]>();
    for (const r of rewarded) {
      const m = Number((r as any).chosenMultiplier);
      byMult.set(m, [...(byMult.get(m) ?? []), Number((r as any).reward)]);
    }
    assert(byMult.get(0.75)?.every((r) => r === 0), "×0.75 arm defaulted (reward 0)");
    assert(byMult.get(1)?.every((r) => r === 0.5), "×1.0 arm late-cured (reward 0.5)");
    assert(byMult.get(1.25)?.every((r) => r === 0.5), "×1.25 arm late-cured (reward 0.5)");
    assert(byMult.get(1.5)?.every((r) => r === 1), "×1.5 arm repaid on time (reward 1)");

    const tick2 = await world.runCron("/api/scheduled/bandit-reward-tick");
    assert(tick2.json?.rewarded === 0, `second tick rewards nothing (got ${tick2.json?.rewarded})`);

    // ── 3. banditStatus: exact coverage on the fresh tenant ───────────────
    const status = await caller.tradeCredit.banditStatus({ tenantId: supplier });
    assert(status.mode === "shadow", `shadow mode by default (got ${status.mode})`);
    assert(status.activeServing === false, "not actively serving in shadow mode");
    assert(status.decisionsLogged === N, `exactly ${N} logged (got ${status.decisionsLogged})`);
    assert(status.rewardedDecisions === N, `exactly ${N} rewarded (got ${status.rewardedDecisions})`);
    assert(Math.abs(status.rewardCoverage - 1) < 1e-9, `full reward coverage (got ${status.rewardCoverage})`);

    // ── 4. banditReplay: off-policy lift vs the ×1.0 baseline arm ────────
    const replay = await caller.tradeCredit.banditReplay({ tenantId: supplier });
    assert(replay.matchedDecisions > 0, "replay matched decisions");
    assert(replay.baselineAvgReward != null && Math.abs(replay.baselineAvgReward - 0.5) < 1e-9,
      `×1.0 baseline arm avg reward exactly 0.5 (got ${replay.baselineAvgReward})`);
    assert(replay.banditAvgReward != null && replay.banditAvgReward > replay.baselineAvgReward!,
      `bandit policy outperforms the baseline (${replay.banditAvgReward} vs ${replay.baselineAvgReward})`);
    assert(replay.lift != null && replay.lift > 0, `positive off-policy lift (got ${replay.lift})`);
    const arm150 = replay.perMultiplier.find((m) => m.multiplier === 1.5);
    assert(arm150 && arm150.avgReward === 1 && arm150.decisions === N / 4,
      `×1.5 arm stats: ${N / 4} decisions, avg reward 1 (got ${JSON.stringify(arm150)})`);

    // ── 5. Shadow suggest does not change the actual limit ───────────────
    const shadowBuyer = buyerId(2); // a ×1.5 buyer with history
    const withBandit = await suggestLimitTx(world.db, shadowBuyer, supplier);
    const withoutBandit = await suggestLimitTx(world.db, shadowBuyer, supplier, new Date(), { bandit: false });
    assert(withBandit.bandit, "bandit decision metadata present");
    assert(withBandit.bandit!.mode === "shadow", `shadow mode served (got ${withBandit.bandit!.mode})`);
    assert(
      withBandit.suggestedLimitCents === withoutBandit.suggestedLimitCents,
      `shadow suggest leaves the actual limit unchanged (${withBandit.suggestedLimitCents} vs ${withoutBandit.suggestedLimitCents})`,
    );
    assert(
      withBandit.bandit!.chosenMultiplier === 1.5,
      `bandit prefers the historically-rewarding ×1.5 arm (got ×${withBandit.bandit!.chosenMultiplier})`,
    );
    assert(
      withBandit.bandit!.banditLimitCents !== withBandit.suggestedLimitCents,
      "the bandit's choice differs from the served limit in shadow mode (logged, not served)",
    );
    const shadowRows = await world.db
      .select()
      .from(schema.banditDecisions)
      .where(and(
        eq(schema.banditDecisions.tenantId, supplier),
        eq(schema.banditDecisions.buyerId, shadowBuyer),
        eq(schema.banditDecisions.mode, "shadow"),
        isNotNull(schema.banditDecisions.createdAt),
      ));
    assert(shadowRows.some((r: any) => r.reward == null), "shadow suggest logged a new (unrewarded) decision row");

    // ── 6. Cross-tenant guards ────────────────────────────────────────────
    const outsider = await tenantCaller("someone-else", { userId: 1141 });
    await expectTrpcError(outsider.tradeCredit.banditStatus({ tenantId: supplier }), "FORBIDDEN", "banditStatus cross-tenant");
    await expectTrpcError(outsider.tradeCredit.banditReplay({ tenantId: supplier }), "FORBIDDEN", "banditReplay cross-tenant");
  },
};
