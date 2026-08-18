/**
 * J100 — W22 contextual-bandit credit-limit setting.
 *
 * Seeds 120 bandit_decisions on the sim tenant (30 per multiplier arm:
 * ×0.75 → default, ×1.0/×1.25 → late-cured, ×1.5 → repaid on time),
 * runs the bandit-reward-tick cron, and asserts:
 *   1. the tick assigns rewards from repayment outcomes
 *      (1 on-time / 0.5 late-cured / 0 default)
 *   2. shadow mode (default): the suggest-limit path logs the bandit
 *      decision row but the served limit equals the rule-based baseline
 *   3. the LinUCB policy prefers the historically-rewarding multiplier
 *      (×1.5) once rewards exist
 *   4. banditStatus / banditReplay: coverage, off-policy estimate vs the
 *      ×1.0 baseline arm (positive lift)
 *   5. active mode (BANDIT_LIMITS_MODE=active + ≥100 rewarded gate):
 *      the bandit choice is served but NEVER exceeds the manufacturer
 *      program caps (×1.5 clamped to maxExposure)
 *   6. cross-tenant guard on banditStatus / banditReplay (FORBIDDEN)
 */
import { randomUUID } from "crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

const N = 120; // ≥ BANDIT_PARAMS.minRewardedDecisions (100)
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const BASELINE_CENTS = 10_000_000; // ₦100k
const MAX_EXPOSURE_CENTS = 20_000_000; // ₦200k hard program cap

const buyerId = (i: number) => `j100-buyer-${i}`;
const multFor = (i: number) => [0.75, 1.0, 1.25, 1.5][i % 4];

async function seedDecisionsAndOutcomes(world: World) {
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
        id: `j100-ord-${buyer}-${k}`,
        tenantId: buyer,
        customerId: `j100-cust-${buyer}`,
        orderNumber: `J100-${buyer}-${k}`,
        status: "delivered",
        totalAmount: "500000.00",
        currency: "NGN",
        createdAt: new Date(now - daysAgo * DAY),
        updatedAt: new Date(now - daysAgo * DAY),
      }).onConflictDoNothing();
    }
    await world.db.insert(schema.paymentTransactions).values({
      id: `j100-pay-${buyer}`,
      tenantId: buyer,
      provider: "paystack",
      providerRef: `J100PAY-${buyer}`,
      amount: "1000.00",
      currency: "NGN",
      status: "completed",
      createdAt: new Date(now - 20 * DAY),
      paidAt: new Date(now - 20 * DAY + HOUR),
    }).onConflictDoNothing();

    // Credit account + ONE draw created AFTER the decision, with the outcome
    // implied by the arm: ×0.75 defaults, ×1.0/×1.25 late-cure, ×1.5 repays on time.
    const accountId = randomUUID();
    const defaulted = mult === 0.75;
    const lateCured = mult === 1.0 || mult === 1.25;
    await world.db.insert(schema.creditAccounts).values({
      id: accountId,
      supplierTenantId: TENANT_ID,
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
      ref: `j100-draw-${i}`,
      note: defaulted || lateCured ? "late repayment [dun:fee] applied" : null,
      createdAt: new Date(now - DAY),
    });

    // The logged bandit decision (shadow), reward pending.
    await world.db.insert(schema.banditDecisions).values({
      tenantId: TENANT_ID,
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
  id: "J100",
  name: "Contextual-bandit credit limits",
  feature: "LinUCB limit multipliers, shadow logging, reward tick, off-policy replay, active-mode cap clamp",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { suggestLimitTx } = await import("../../server/services/tradeCredit/scoring");
    const caller = await adminCaller();

    await seedDecisionsAndOutcomes(world);

    // ── 1. Reward tick assigns rewards from repayment outcomes ───────────
    const tick = await world.runCron("/api/scheduled/bandit-reward-tick");
    assert(tick.status === 200, `cron tick 200 (got ${tick.status})`);
    assert(tick.json?.ok === true, "cron tick ok");
    assert(tick.json.rewarded >= N, `tick rewarded ≥${N} (got ${tick.json.rewarded})`);
    assert(tick.json.histogram?.onTime >= N / 4, `≥${N / 4} on-time rewards (got ${tick.json.histogram?.onTime})`);
    assert(tick.json.histogram?.lateCured >= N / 2, `≥${N / 2} late-cured rewards`);
    assert(tick.json.histogram?.defaulted >= N / 4, `≥${N / 4} default rewards`);

    const rewardedRows = await world.db
      .select()
      .from(schema.banditDecisions)
      .where(and(eq(schema.banditDecisions.tenantId, TENANT_ID), isNotNull(schema.banditDecisions.reward)));
    assert(rewardedRows.length >= N, `≥${N} rewarded decisions persisted (got ${rewardedRows.length})`);
    const byMult = new Map<number, number[]>();
    for (const r of rewardedRows) {
      const m = Number(r.chosenMultiplier);
      byMult.set(m, [...(byMult.get(m) ?? []), Number(r.reward)]);
    }
    assert(byMult.get(0.75)?.every((r) => r === 0), "×0.75 arm defaulted (reward 0)");
    assert(byMult.get(1)?.every((r) => r === 0.5), "×1.0 arm late-cured (reward 0.5)");
    assert(byMult.get(1.25)?.every((r) => r === 0.5), "×1.25 arm late-cured (reward 0.5)");
    assert(byMult.get(1.5)?.every((r) => r === 1), "×1.5 arm repaid on time (reward 1)");

    // Idempotent: a second tick assigns nothing new.
    const tick2 = await world.runCron("/api/scheduled/bandit-reward-tick");
    assert(tick2.json?.rewarded === 0, `second tick rewards nothing (got ${tick2.json?.rewarded})`);

    // ── 2-3. Shadow mode: limit unchanged, policy prefers ×1.5 ───────────
    const shadowBuyer = buyerId(2); // a ×1.5 buyer with history
    const withBandit = await suggestLimitTx(world.db, shadowBuyer, TENANT_ID);
    const withoutBandit = await suggestLimitTx(world.db, shadowBuyer, TENANT_ID, new Date(), { bandit: false });
    assert(withBandit.bandit, "bandit decision metadata present");
    assert(withBandit.bandit!.mode === "shadow", `default mode is shadow (got ${withBandit.bandit!.mode})`);
    assert(
      withBandit.suggestedLimitCents === withoutBandit.suggestedLimitCents,
      `shadow mode leaves the limit unchanged (${withBandit.suggestedLimitCents} vs ${withoutBandit.suggestedLimitCents})`,
    );
    assert(
      withBandit.bandit!.chosenMultiplier === 1.5,
      `bandit prefers the historically-rewarding ×1.5 arm (got ×${withBandit.bandit!.chosenMultiplier})`,
    );
    const [logged] = await world.db
      .select()
      .from(schema.banditDecisions)
      .where(and(eq(schema.banditDecisions.buyerId, shadowBuyer), eq(schema.banditDecisions.mode, "shadow")));
    assert(logged, "shadow decision row persisted");

    // ── 4. Status + off-policy replay ─────────────────────────────────────
    const status = await caller.tradeCredit.banditStatus({ tenantId: TENANT_ID });
    assert(status.mode === "shadow", "status reports shadow mode");
    assert(status.activeServing === false, "not actively serving in shadow mode");
    assert(status.decisionsLogged >= N, `≥${N} decisions logged (got ${status.decisionsLogged})`);
    assert(status.rewardedDecisions >= N, `≥${N} rewarded (got ${status.rewardedDecisions})`);
    assert(status.rewardCoverage > 0.5, "reward coverage reported");

    const replay = await caller.tradeCredit.banditReplay({ tenantId: TENANT_ID });
    assert(replay.matchedDecisions > 0, "replay matched decisions");
    assert(replay.baselineAvgReward != null && Math.abs(replay.baselineAvgReward - 0.5) < 1e-9, `baseline arm avg reward 0.5 (got ${replay.baselineAvgReward})`);
    assert(replay.banditAvgReward != null && replay.banditAvgReward > replay.baselineAvgReward!, `bandit outperforms baseline (${replay.banditAvgReward} vs ${replay.baselineAvgReward})`);
    assert(replay.lift != null && replay.lift > 0, `positive off-policy lift (got ${replay.lift})`);
    const arm150 = replay.perMultiplier.find((m) => m.multiplier === 1.5);
    assert(arm150 && arm150.avgReward === 1, "×1.5 arm stats: avg reward 1");

    // ── 5. Active mode: bandit served but clamped by program caps ────────
    process.env.BANDIT_LIMITS_MODE = "active";
    try {
      const mfrCaller = await tenantCaller(TENANT_ID, { userId: 1000 });
      const program = await mfrCaller.manufacturerPrograms.create({
        tenantId: TENANT_ID,
        name: "J100 Bandit Caps",
        maxExposureCents: MAX_EXPOSURE_CENTS,
        programCapCents: 500_000_000,
        concentrationCapBps: 10000,
        allowedTenorDays: [30],
        feeBps: 0,
      });
      await mfrCaller.manufacturerPrograms.setStatus({ tenantId: TENANT_ID, programId: program.id, status: "active" });

      const sug = await mfrCaller.manufacturerPrograms.suggestLimitForProgram({
        tenantId: TENANT_ID,
        programId: program.id,
        buyerTenantId: shadowBuyer,
      });
      assert(sug.bandit, "bandit metadata on program suggestion");
      assert(sug.bandit!.mode === "active", `active mode served (got ${sug.bandit!.mode})`);
      assert(sug.bandit!.chosenMultiplier === 1.5, `active bandit picked ×1.5 (got ×${sug.bandit!.chosenMultiplier})`);
      assert(
        sug.suggestedLimitCents <= MAX_EXPOSURE_CENTS,
        `cap-clamp proof: ×1.5 never exceeds maxExposure (got ${sug.suggestedLimitCents} ≤ ${MAX_EXPOSURE_CENTS})`,
      );
      assert(Number.isInteger(sug.suggestedLimitCents), "integer cents");

      const statusActive = await caller.tradeCredit.banditStatus({ tenantId: TENANT_ID });
      assert(statusActive.mode === "active" && statusActive.activeServing === true, "status reports active serving past the gate");
    } finally {
      delete process.env.BANDIT_LIMITS_MODE;
    }

    // ── 6. Cross-tenant guard ─────────────────────────────────────────────
    const outsider = await tenantCaller("someone-else", { userId: 1001 });
    await expectTrpcError(outsider.tradeCredit.banditStatus({ tenantId: TENANT_ID }), "FORBIDDEN", "banditStatus cross-tenant");
    await expectTrpcError(outsider.tradeCredit.banditReplay({ tenantId: TENANT_ID }), "FORBIDDEN", "banditReplay cross-tenant");

    // Back in shadow mode: status reflects the default again.
    const statusAfter = await caller.tradeCredit.banditStatus({ tenantId: TENANT_ID });
    assert(statusAfter.mode === "shadow", "env restore returns to shadow");
  },
};
