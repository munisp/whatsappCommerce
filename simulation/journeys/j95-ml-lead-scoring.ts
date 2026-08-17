/**
 * J95 — ML propensity lead scoring (W20).
 *
 * Seeds 60 customers with order history (30 active → ordered again within the
 * 14d label window; 30 dormant → quiet for 150d+), trains the per-tenant
 * logistic-regression model via crm.trainLeadModel, and asserts:
 *   1. below-gate/untrained tenant → rules fallback (fallbackUsed, scoreSource)
 *   2. after training, active customers get materially higher propensity than
 *      dormant ones (ML learned the recency/frequency signal)
 *   3. atRiskList entries carry propensity + scoreSource ('ml' post-training)
 *   4. cross-tenant guard on trainLeadModel / leadModelStatus
 *   5. cron /api/scheduled/lead-model-tick re-trains deterministically
 *      (same data → identical weights on the next version)
 */
import { eq, and } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

const TENANT_B = "sim-tenant-b";
const DAY = 24 * 60 * 60 * 1000;

async function seedOrderBook(world: World) {
  const schema = await import("../../drizzle/schema");
  const now = Date.now();
  for (let i = 0; i < 30; i++) {
    const phone = world.newPhone(`j95a${i}`);
    const id = `cust-${phone}`;
    await world.db.insert(schema.customers).values({
      id, tenantId: TENANT_ID, whatsappPhone: phone, name: `J95 Active ${i}`,
      totalOrders: 3, totalSpent: "30000.00", lastOrderAt: new Date(now - 3 * DAY),
    }).onConflictDoNothing();
    for (const [k, daysAgo] of [[0, 40], [1, 20], [2, 3]] as const) {
      await world.db.insert(schema.orders).values({
        id: `j95-aord-${i}-${k}`, tenantId: TENANT_ID, customerId: id,
        orderNumber: `J95A-${i}-${k}`, status: "delivered",
        totalAmount: "10000.00", currency: "NGN",
        createdAt: new Date(now - daysAgo * DAY), updatedAt: new Date(now - daysAgo * DAY),
      }).onConflictDoNothing();
    }
  }
  for (let i = 0; i < 30; i++) {
    const phone = world.newPhone(`j95d${i}`);
    const id = `cust-${phone}`;
    await world.db.insert(schema.customers).values({
      id, tenantId: TENANT_ID, whatsappPhone: phone, name: `J95 Dormant ${i}`,
      totalOrders: 2, totalSpent: "20000.00", lastOrderAt: new Date(now - 150 * DAY),
    }).onConflictDoNothing();
    for (const [k, daysAgo] of [[0, 200], [1, 150]] as const) {
      await world.db.insert(schema.orders).values({
        id: `j95-dord-${i}-${k}`, tenantId: TENANT_ID, customerId: id,
        orderNumber: `J95D-${i}-${k}`, status: "delivered",
        totalAmount: "10000.00", currency: "NGN",
        createdAt: new Date(now - daysAgo * DAY), updatedAt: new Date(now - daysAgo * DAY),
      }).onConflictDoNothing();
    }
  }
  // Tenant B: customers with history but NO trained model (fallback proof).
  const schemaB = schema;
  for (let i = 0; i < 2; i++) {
    const phone = world.newPhone(`j95b${i}`);
    await world.db.insert(schemaB.customers).values({
      id: `cust-${phone}`, tenantId: TENANT_B, whatsappPhone: phone, name: `J95 B ${i}`,
      totalOrders: 3, totalSpent: "15000.00", lastOrderAt: new Date(now - 60 * DAY),
    }).onConflictDoNothing();
  }
}

export const journey: Journey = {
  id: "J95",
  name: "ml propensity lead scoring",
  feature: "logistic-regression propensity model + rules fallback + cron retrain",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { scoreCustomerMl } = await import("../../server/services/mlLeadScoring");
    const caller = await adminCaller();

    await seedOrderBook(world);

    // ── 1. Untrained main tenant → rules fallback (never throws) ──────────
    const firstActiveId = (await world.db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(and(eq(schema.customers.tenantId, TENANT_ID), eq(schema.customers.name, "J95 Active 0")))
      .limit(1))[0].id;
    const pre = await scoreCustomerMl(world.db, TENANT_ID, firstActiveId);
    assert(pre.fallbackUsed === true, "untrained tenant → rules fallback");
    assert(pre.modelVersion === null, "no model version before training");
    assert(pre.propensity >= 0 && pre.propensity <= 1, "fallback propensity in [0,1]");

    const statusPre = await caller.crm.leadModelStatus({ tenantId: TENANT_ID });
    assert(statusPre.trained === false, "no model trained yet");
    assert(statusPre.sampleCount === 0, "untrained status sampleCount 0");

    // ── 2. Train the model ────────────────────────────────────────────────
    // (Other journeys may have left their own customers/orders on the shared
    // sim tenant, so the labeled-row count is ≥ the 60 we just seeded.)
    const trained = await caller.crm.trainLeadModel({ tenantId: TENANT_ID });
    assert(trained.trained === true, `model trained (got ${JSON.stringify(trained)})`);
    assert(trained.sampleCount! >= 60, `≥60 labeled rows (got ${trained.sampleCount})`);
    assert(trained.version === 1, `first version = 1 (got ${trained.version})`);
    assert(typeof trained.logloss === "number" && trained.logloss! >= 0, "logloss recorded");

    const status = await caller.crm.leadModelStatus({ tenantId: TENANT_ID });
    assert(status.trained === true, "status reports trained");
    assert(status.version === 1, "status version 1");
    assert(status.sampleCount === trained.sampleCount, "status sampleCount matches training");

    // ── 3. Active vs dormant propensities differ sensibly ─────────────────
    const activeRows = await world.db
      .select({ id: schema.customers.id, name: schema.customers.name })
      .from(schema.customers)
      .where(eq(schema.customers.tenantId, TENANT_ID));
    const actives = activeRows.filter((c: any) => String(c.name).startsWith("J95 Active"));
    const dormants = activeRows.filter((c: any) => String(c.name).startsWith("J95 Dormant"));
    assert(actives.length === 30 && dormants.length === 30, "seeded 30+30 customers");

    const pActive: number[] = [];
    const pDormant: number[] = [];
    for (const c of actives) {
      const r = await scoreCustomerMl(world.db, TENANT_ID, c.id);
      assert(r.fallbackUsed === false, "trained tenant → ML path");
      assert(r.modelVersion === 1, "scores use model v1");
      pActive.push(r.propensity);
    }
    for (const c of dormants) {
      const r = await scoreCustomerMl(world.db, TENANT_ID, c.id);
      assert(r.fallbackUsed === false, "trained tenant → ML path");
      pDormant.push(r.propensity);
    }
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const meanA = mean(pActive);
    const meanD = mean(pDormant);
    assert(meanA > meanD + 0.2, `active propensity (${meanA.toFixed(3)}) ≫ dormant (${meanD.toFixed(3)})`);
    assert(Math.min(...pActive) > 0.5, `every active customer > 0.5 (min ${Math.min(...pActive).toFixed(3)})`);
    assert(Math.max(...pDormant) < 0.5, `every dormant customer < 0.5 (max ${Math.max(...pDormant).toFixed(3)})`);

    // ── 4. atRiskList carries propensity + scoreSource ────────────────────
    const atRisk = await caller.crm.atRiskList({ tenantId: TENANT_ID, limit: 200 });
    const riskRows = atRisk.filter((r: any) => String(r.name ?? "").startsWith("J95 Dormant"));
    assert(riskRows.length === 30, `dormant buyers on at-risk list (got ${riskRows.length})`);
    for (const r of riskRows) {
      assert(r.scoreSource === "ml", `at-risk entry scored by ML (got ${r.scoreSource})`);
      assert(typeof r.propensity === "number" && r.propensity >= 0 && r.propensity <= 1, "propensity in [0,1]");
    }
    assert(!atRisk.some((r: any) => String(r.name ?? "").startsWith("J95 Active")), "active buyers not at-risk");

    // ── 5. Tenant B (untrained) → rules fallback through the router ───────
    const atRiskB = await caller.crm.atRiskList({ tenantId: TENANT_B });
    assert(atRiskB.length === 2, `tenant B at-risk rows (got ${atRiskB.length})`);
    for (const r of atRiskB) {
      assert(r.scoreSource === "rules", `untrained tenant → rules source (got ${r.scoreSource})`);
      assert(typeof r.propensity === "number", "rules fallback propensity present");
    }
    const trainedB = await caller.crm.trainLeadModel({ tenantId: TENANT_B });
    assert(trainedB.trained === false, "tenant B below the sample gate");
    assert(trainedB.reason === "insufficient_samples", "gate reason reported");

    // ── 6. Cross-tenant guard ─────────────────────────────────────────────
    const { appRouter } = await import("../../server/routers");
    const outsider = appRouter.createCaller({
      user: { id: 99, openId: "sim-outsider", role: "user", tenantId: "someone-else" } as any,
      req: { protocol: "http", headers: {} },
    } as any);
    const trainDenied = await outsider.crm.trainLeadModel({ tenantId: TENANT_ID }).then(() => false, (e: any) => e?.code === "FORBIDDEN");
    assert(trainDenied, "trainLeadModel rejects cross-tenant");
    const statusDenied = await outsider.crm.leadModelStatus({ tenantId: TENANT_ID }).then(() => false, (e: any) => e?.code === "FORBIDDEN");
    assert(statusDenied, "leadModelStatus rejects cross-tenant");

    // ── 7. Cron retrain is deterministic (same data → identical weights) ──
    const tick = await world.runCron("/api/scheduled/lead-model-tick");
    assert(tick.status === 200, `cron tick 200 (got ${tick.status})`);
    assert(tick.json?.ok === true, "cron tick ok");
    assert(tick.json.trained >= 1, `cron trained ≥1 tenant (got ${tick.json.trained})`);
    assert(tick.json.tenants >= 2, "cron visited both tenants");

    const models = await world.db
      .select()
      .from(schema.leadScoreModels)
      .where(eq(schema.leadScoreModels.tenantId, TENANT_ID));
    assert(models.length === 2, `two model versions after cron (got ${models.length})`);
    const v1 = models.find((m: any) => m.version === 1)!;
    const v2 = models.find((m: any) => m.version === 2)!;
    assert(v1 && v2, "versions 1 and 2 persisted");
    assert(
      JSON.stringify(v1.weights) === JSON.stringify(v2.weights),
      "deterministic retrain: identical weights for identical data",
    );
    assert(v1.sampleCount === v2.sampleCount && v2.sampleCount >= 60, "sample counts recorded");
  },
};
