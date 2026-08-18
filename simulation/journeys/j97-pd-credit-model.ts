/**
 * J97 — ML probability-of-default (PD) credit model + expected-loss pricing
 * (W21).
 *
 * Seeds a credit book on the sim tenant (48 buyers: 24 repaid on time, 24
 * late/defaulted), trains the per-tenant logistic-regression PD model via
 * tradeCredit.trainPdModel, and asserts:
 *   1. untrained tenant → rules fallback (fallbackUsed, pd = 1 − score/100
 *      proxy via the suggestLimit integration)
 *   2. after training, PD(defaulter) > PD(on-time) + margin — the model
 *      learned the repayment-outcome signal
 *   3. expected-loss fee is monotonic in PD and clamped by the TERMS_BANDS
 *      envelope; the scorer integration caps it at the rule-score band fee
 *   4. cross-tenant guard on trainPdModel / pdModelStatus (FORBIDDEN)
 *   5. deterministic retrain (same data → identical weights, version bumps)
 *   6. cron /api/scheduled/pd-model-tick trains the global corpus model and
 *      untrained tenants resolve to the global fallback (modelScope global)
 */
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

const TENANT_B = "sim-tenant-b-pd";
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const N_GOOD = 24;
const N_BAD = 24;

const goodId = (i: number) => `j97-buyer-good-${i}`;
const badId = (i: number) => `j97-buyer-bad-${i}`;

async function seedCreditBook(world: World) {
  const schema = await import("../../drizzle/schema");
  const now = Date.now();

  const seedPlatformHistory = async (buyerId: string, onTime: boolean, volMajor: string) => {
    // Orders: first 120 days ago (tenure), one inside the 90d window (volume).
    for (const [k, daysAgo] of [[0, 120], [1, 10]] as const) {
      await world.db.insert(schema.orders).values({
        id: `j97-ord-${buyerId}-${k}`,
        tenantId: buyerId,
        customerId: `j97-cust-${buyerId}`,
        orderNumber: `J97-${buyerId}-${k}`,
        status: "delivered",
        totalAmount: volMajor,
        currency: "NGN",
        createdAt: new Date(now - daysAgo * DAY),
        updatedAt: new Date(now - daysAgo * DAY),
      }).onConflictDoNothing();
    }
    // Completed payment: on-time (1h) or late (72h).
    const created = new Date(now - 20 * DAY);
    await world.db.insert(schema.paymentTransactions).values({
      id: `j97-pay-${buyerId}`,
      tenantId: buyerId,
      provider: "paystack",
      providerRef: `J97PAY-${buyerId}`,
      amount: "1000.00",
      currency: "NGN",
      status: "completed",
      createdAt: created,
      paidAt: new Date(created.getTime() + (onTime ? 1 : 72) * HOUR),
    }).onConflictDoNothing();
  };

  for (let i = 0; i < N_GOOD; i++) {
    const buyerId = goodId(i);
    await seedPlatformHistory(buyerId, true, "500000.00");
    const accountId = randomUUID();
    await world.db.insert(schema.creditAccounts).values({
      id: accountId,
      supplierTenantId: TENANT_ID,
      buyerTenantId: buyerId,
      limitCents: 30_000_000,
      outstandingCents: 0,
      termsDays: 30,
      status: "active",
    });
    // One draw, fully repaid ON TIME (settled, no dunning markers, balance 0).
    await world.db.insert(schema.creditLedger).values({
      id: randomUUID(),
      creditAccountId: accountId,
      kind: "invoice_draw",
      amountCents: 5_000_000,
      dueDate: new Date(now - 5 * DAY),
      status: "settled",
      ref: `j97-draw-g-${i}`,
    });
    await world.db.insert(schema.creditLedger).values({
      id: randomUUID(),
      creditAccountId: accountId,
      kind: "repayment",
      amountCents: 5_000_000,
      status: "posted",
      ref: `j97-repay-g-${i}`,
    });
  }

  for (let i = 0; i < N_BAD; i++) {
    const buyerId = badId(i);
    await seedPlatformHistory(buyerId, false, "50000.00");
    const accountId = randomUUID();
    const frozen = i % 2 === 0;
    await world.db.insert(schema.creditAccounts).values({
      id: accountId,
      supplierTenantId: TENANT_ID,
      buyerTenantId: buyerId,
      limitCents: 10_000_000,
      outstandingCents: 8_000_000, // 80% utilization, never repaid
      termsDays: 14,
      status: frozen ? "frozen" : "active",
    });
    // Overdue posted draw WITH a dunning late marker → label 1 either way.
    await world.db.insert(schema.creditLedger).values({
      id: randomUUID(),
      creditAccountId: accountId,
      kind: "invoice_draw",
      amountCents: 8_000_000,
      dueDate: new Date(now - 30 * DAY),
      status: "posted",
      ref: `j97-draw-b-${i}`,
      note: `late repayment [dun:fee] applied`,
    });
  }
}

export const journey: Journey = {
  id: "J97",
  name: "ML probability-of-default credit model",
  feature: "logistic-regression PD model + expected-loss pricing + rules/global fallback + cron retrain",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const ml = await import("../../server/services/tradeCredit/mlPdScoring");
    const { suggestLimitTx } = await import("../../server/services/tradeCredit/scoring");
    const caller = await adminCaller();

    await seedCreditBook(world);

    // ── 1. Untrained scope → rules fallback (never throws) ────────────────
    const pre = await ml.scorePd(world.db, TENANT_B, goodId(0));
    assert(pre.fallbackUsed === true, "untrained tenant → rules fallback");
    assert(pre.modelVersion === null, "no model version before training");
    assert(pre.pd >= 0 && pre.pd <= 1, `fallback pd in [0,1] (got ${pre.pd})`);

    const statusPre = await caller.tradeCredit.pdModelStatus({ tenantId: TENANT_ID });
    assert(statusPre.trained === false, "no PD model trained yet");
    assert(statusPre.scope === null, "no global fallback before any training");

    // suggestLimit integration exposes the rule-proxy PD.
    const sugPre = await suggestLimitTx(world.db, goodId(0), TENANT_ID);
    assert(sugPre.pdSource === "rules", `untrained → pdSource rules (got ${sugPre.pdSource})`);
    assert(typeof sugPre.pd === "number" && sugPre.pd >= 0 && sugPre.pd <= 1, "pd present on suggestion");
    assert(Math.abs(sugPre.pd! - (1 - sugPre.score / 100)) < 1e-3, "rules proxy pd = 1 − score/100");
    assert(typeof sugPre.expectedLossFeeBps === "number", "expected-loss fee present");

    // ── 2. Train the per-tenant PD model ──────────────────────────────────
    const trained = await caller.tradeCredit.trainPdModel({ tenantId: TENANT_ID });
    assert(trained.trained === true, `model trained (got ${JSON.stringify(trained)})`);
    assert(trained.sampleCount! >= N_GOOD + N_BAD, `≥${N_GOOD + N_BAD} labeled rows (got ${trained.sampleCount})`);
    assert(trained.version === 1, `first version = 1 (got ${trained.version})`);
    assert(typeof trained.logloss === "number" && trained.logloss! >= 0, "logloss recorded");
    assert(trained.auc == null || (trained.auc >= 0 && trained.auc <= 1), "auc in [0,1]");

    const status = await caller.tradeCredit.pdModelStatus({ tenantId: TENANT_ID });
    assert(status.trained === true, "status reports trained");
    assert(status.scope === "tenant", "status scope = tenant");
    assert(status.version === 1, "status version 1");

    // Below-gate tenant stays untrained.
    const trainedB = await caller.tradeCredit.trainPdModel({ tenantId: TENANT_B });
    assert(trainedB.trained === false, "empty book → below gate");
    assert(trainedB.reason === "insufficient_samples", "gate reason reported");

    // ── 3. PD(defaulter) > PD(on-time) + margin ───────────────────────────
    const pdGood: number[] = [];
    const pdBad: number[] = [];
    for (let i = 0; i < N_GOOD; i++) {
      const r = await ml.scorePd(world.db, TENANT_ID, goodId(i));
      assert(r.fallbackUsed === false, "trained tenant → ML path");
      assert(r.modelVersion === 1, "scores use model v1");
      assert(r.modelScope === "tenant", "tenant-scoped model used");
      pdGood.push(r.pd);
    }
    for (let i = 0; i < N_BAD; i++) {
      const r = await ml.scorePd(world.db, TENANT_ID, badId(i));
      assert(r.fallbackUsed === false, "trained tenant → ML path");
      pdBad.push(r.pd);
    }
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const meanGood = mean(pdGood);
    const meanBad = mean(pdBad);
    assert(
      meanBad > meanGood + 0.2,
      `PD(defaulters) (${meanBad.toFixed(3)}) > PD(on-time) (${meanGood.toFixed(3)}) + margin`,
    );
    assert(Math.max(...pdGood) < 0.5, `every on-time buyer PD < 0.5 (max ${Math.max(...pdGood).toFixed(3)})`);
    assert(Math.min(...pdBad) > 0.5, `every defaulter PD > 0.5 (min ${Math.min(...pdBad).toFixed(3)})`);

    // ── 4. Expected-loss pricing: monotonic in PD, clamped by bands ───────
    const tenor = 30;
    let prevFee = -1;
    for (const pd of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      const el = ml.expectedLossTerms(pd, tenor);
      assert(el.feeBps >= prevFee, `fee monotonic in pd (${pd} → ${el.feeBps})`);
      assert(el.feeBps >= ml.EL_PRICING.minFeeBps && el.feeBps <= ml.EL_PRICING.maxFeeBps, "fee within envelope");
      prevFee = el.feeBps;
    }
    // Envelope clamps: zero PD → margin only; max PD at long tenor → max band fee.
    assert(ml.expectedLossTerms(0, tenor).feeBps === ml.EL_PRICING.marginBps, "pd=0 → margin only");
    assert(ml.expectedLossTerms(1, 45).feeBps === ml.EL_PRICING.maxFeeBps, "pd=1 @45d clamps to max band fee");
    // Tenor scaling: longer tenor ⇒ higher expected-loss component.
    const elShort = ml.expectedLossTerms(0.5, 14);
    const elLong = ml.expectedLossTerms(0.5, 45);
    assert(elLong.feeBps >= elShort.feeBps, "fee scales with tenor");

    // Scorer integration: ML-sourced PD and the band-capped EL fee.
    const sugMl = await suggestLimitTx(world.db, goodId(0), TENANT_ID);
    assert(sugMl.pdSource === "ml", `trained → pdSource ml (got ${sugMl.pdSource})`);
    assert(sugMl.pd! < 0.5, "on-time buyer scored low-PD by the model");
    if (!sugMl.terms.decline) {
      assert(
        sugMl.expectedLossFeeBps! <= sugMl.terms.feeBps,
        `EL fee ${sugMl.expectedLossFeeBps} capped by band fee ${sugMl.terms.feeBps}`,
      );
    }
    const sugBad = await suggestLimitTx(world.db, badId(0), TENANT_ID);
    assert(sugBad.pdSource === "ml", "defaulter also ML-scored");
    assert(sugBad.pd! > sugMl.pd! + 0.2, "suggestion PD separates defaulter from on-time");
    assert(
      sugBad.expectedLossFeeBps! >= sugMl.expectedLossFeeBps!,
      "higher PD → no cheaper expected-loss fee",
    );

    // ── 5. Cross-tenant guard ─────────────────────────────────────────────
    const { appRouter } = await import("../../server/routers");
    const outsider = appRouter.createCaller({
      user: { id: 99, openId: "sim-outsider", role: "user", tenantId: "someone-else" } as any,
      req: { protocol: "http", headers: {} },
    } as any);
    const trainDenied = await outsider.tradeCredit.trainPdModel({ tenantId: TENANT_ID }).then(() => false, (e: any) => e?.code === "FORBIDDEN");
    assert(trainDenied, "trainPdModel rejects cross-tenant");
    const statusDenied = await outsider.tradeCredit.pdModelStatus({ tenantId: TENANT_ID }).then(() => false, (e: any) => e?.code === "FORBIDDEN");
    assert(statusDenied, "pdModelStatus rejects cross-tenant");

    // ── 6. Deterministic retrain (same data → identical weights) ──────────
    const retrain = await caller.tradeCredit.trainPdModel({ tenantId: TENANT_ID });
    assert(retrain.trained === true && retrain.version === 2, `retrain bumps to v2 (got ${retrain.version})`);
    const models = await world.db
      .select()
      .from(schema.creditPdModels)
      .where(eq(schema.creditPdModels.tenantId, TENANT_ID));
    const v1 = models.find((m: any) => m.version === 1)!;
    const v2 = models.find((m: any) => m.version === 2)!;
    assert(v1 && v2, "versions 1 and 2 persisted");
    assert(
      JSON.stringify(v1.weights) === JSON.stringify(v2.weights),
      "deterministic retrain: identical weights",
    );

    // ── 7. Cron: global corpus model + untrained-tenant global fallback ───
    const tick = await world.runCron("/api/scheduled/pd-model-tick");
    assert(tick.status === 200, `cron tick 200 (got ${tick.status})`);
    assert(tick.json?.ok === true, "cron tick ok");
    assert(tick.json.global?.trained === true, "global corpus model trained");
    assert(tick.json.global?.sampleCount >= N_GOOD + N_BAD, "global corpus covers the seeded book");
    assert(tick.json.trained >= 1, `cron trained ≥1 tenant (got ${tick.json.trained})`);

    const statusB = await caller.tradeCredit.pdModelStatus({ tenantId: TENANT_B });
    assert(statusB.trained === false, "tenant B still has no own model");
    assert(statusB.scope === "global", `tenant B resolves to the global fallback (got ${statusB.scope})`);
    const pdB = await ml.scorePd(world.db, TENANT_B, badId(1));
    assert(pdB.fallbackUsed === false, "global model scores untrained tenant's buyer");
    assert(pdB.modelScope === "global", "score sourced from the global corpus model");
    assert(pdB.pd > 0.5, "global model ranks the defaulter high-PD");
  },
};
