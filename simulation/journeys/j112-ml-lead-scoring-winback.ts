/**
 * J112 (O3) — ML lead scoring driving a win-back motion end-to-end:
 *   1. Seed order history: 30 recently-active buyers (re-order inside the
 *      14d label window) + 30 lapsing buyers (quiet 45–60d, previously
 *      active) on the sim tenant.
 *   2. crm.trainLeadModel trains the per-tenant logistic-regression model
 *      (retrain on the shared tenant → version increments, never resets).
 *   3. crm.atRiskList surfaces the lapsing buyers with a numeric ML
 *      propensity and scoreSource 'ml' (not the rules fallback).
 *   4. crm.createWinBackCampaign builds a draft broadcast from the at-risk
 *      segment (minOrders 1 + noOrderSinceDays 30).
 *   5. Movement: a won-back lapsing buyer places a new order →
 *      crm.refreshScores → the buyer leaves the at-risk list and the
 *      pipelineSummary stage/band distribution shifts to reflect it.
 *
 * NOTE: services are imported LAZILY inside run() — loadJourneys() executes
 * before bootWorld() sets the sim env (see j101 header).
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

export const journey: Journey = {
  id: "J112",
  name: "ml lead scoring → at-risk win-back → pipeline movement (O3)",
  feature: "seed order history → trainLeadModel → atRiskList propensity + scoreSource ml → createWinBackCampaign → pipelineSummary movement",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();
    const now = Date.now();

    // ── 1. Seed order history ─────────────────────────────────────────────
    const lapsing: { id: string; phone: string; name: string }[] = [];
    for (let i = 0; i < 30; i++) {
      const phone = world.newPhone(`j112a${i}`);
      const id = `cust-${phone}`;
      await world.db.insert(schema.customers).values({
        id, tenantId: TENANT_ID, whatsappPhone: phone, name: `J112 Active ${i}`,
        totalOrders: 4, totalSpent: "40000.00", lastOrderAt: new Date(now - 3 * DAY),
      }).onConflictDoNothing();
      for (const [k, daysAgo] of [[0, 40], [1, 25], [2, 10], [3, 3]] as const) {
        await world.db.insert(schema.orders).values({
          id: `j112-aord-${i}-${k}`, tenantId: TENANT_ID, customerId: id,
          orderNumber: `J112A-${i}-${k}`, status: "delivered",
          totalAmount: "10000.00", currency: "NGN",
          createdAt: new Date(now - daysAgo * DAY), updatedAt: new Date(now - daysAgo * DAY),
        }).onConflictDoNothing();
      }
    }
    for (let i = 0; i < 30; i++) {
      const phone = world.newPhone(`j112l${i}`);
      const id = `cust-${phone}`;
      await world.db.insert(schema.customers).values({
        id, tenantId: TENANT_ID, whatsappPhone: phone, name: `J112 Lapsing ${i}`,
        totalOrders: 3, totalSpent: "25000.00", lastOrderAt: new Date(now - 60 * DAY),
      }).onConflictDoNothing();
      for (const [k, daysAgo] of [[0, 200], [1, 120], [2, 60]] as const) {
        await world.db.insert(schema.orders).values({
          id: `j112-lord-${i}-${k}`, tenantId: TENANT_ID, customerId: id,
          orderNumber: `J112L-${i}-${k}`, status: "delivered",
          totalAmount: "8000.00", currency: "NGN",
          createdAt: new Date(now - daysAgo * DAY), updatedAt: new Date(now - daysAgo * DAY),
        }).onConflictDoNothing();
      }
      lapsing.push({ id, phone, name: `J112 Lapsing ${i}` });
    }

    // ── 2. Train the ML lead model (retrain → version increments) ─────────
    const statusPre = await caller.crm.leadModelStatus({ tenantId: TENANT_ID });
    const trained = await caller.crm.trainLeadModel({ tenantId: TENANT_ID });
    assert(trained.trained === true, `lead model trained (got ${JSON.stringify(trained)})`);
    assert((trained.sampleCount ?? 0) >= 60, `≥60 labeled rows (got ${trained.sampleCount})`);
    if (statusPre.trained) {
      assert(trained.version === (statusPre.version ?? 0) + 1,
        `retrain increments the version (${statusPre.version} → ${trained.version})`);
    } else {
      assert(trained.version === 1, `first version = 1 (got ${trained.version})`);
    }

    // ── 3. At-risk list carries ML propensity + scoreSource 'ml' ──────────
    const atRisk = await caller.crm.atRiskList({ tenantId: TENANT_ID, limit: 200 });
    const riskRows = atRisk.filter((r: any) => String(r.name ?? "").startsWith("J112 Lapsing"));
    // Full-suite note: the at-risk list is capped at limit=200 by totalSpent
    // and earlier journeys leave their own dormant customers on the shared
    // tenant, so assert (near-)complete surfacing rather than exactly 30.
    assert(riskRows.length >= 25, `lapsing buyers on the at-risk list (got ${riskRows.length}/30)`);
    for (const r of riskRows) {
      assert(r.scoreSource === "ml", `at-risk entry scored by the ML model (got ${r.scoreSource})`);
      assert(typeof r.propensity === "number" && r.propensity >= 0 && r.propensity <= 1, "propensity in [0,1]");
      assert(r.daysSinceLastOrder >= 30, `lapsing ≥30d (got ${r.daysSinceLastOrder})`);
    }
    assert(!atRisk.some((r: any) => String(r.name ?? "").startsWith("J112 Active")), "active buyers not at-risk");
    // ML separation: lapsing buyers score materially below the actives.
    const { scoreCustomerMl } = await import("../../server/services/mlLeadScoring");
    const activeIds = (await world.db
      .select({ id: schema.customers.id, name: schema.customers.name })
      .from(schema.customers)
      .where(eq(schema.customers.tenantId, TENANT_ID)))
      .filter((c: any) => String(c.name).startsWith("J112 Active"));
    let sumActive = 0;
    for (const c of activeIds) {
      const r = await scoreCustomerMl(world.db, TENANT_ID, c.id);
      assert(r.fallbackUsed === false, "trained tenant → ML path for actives");
      sumActive += r.propensity;
    }
    const meanActive = sumActive / activeIds.length;
    const meanRisk = riskRows.reduce((s: number, r: any) => s + r.propensity, 0) / riskRows.length;
    assert(meanRisk < meanActive, `lapsing propensity (${meanRisk.toFixed(3)}) below active (${meanActive.toFixed(3)})`);

    // Pipeline snapshot BEFORE the win-back motion (refresh so the seeded
    // cohort is scored even when J112 runs standalone).
    const refreshPre = await caller.crm.refreshScores({ tenantId: TENANT_ID });
    assert(refreshPre.refreshed >= 1, `initial score refresh (got ${refreshPre.refreshed})`);
    const summaryBefore = await caller.crm.pipelineSummary({ tenantId: TENANT_ID });
    assert(summaryBefore.total >= 1, "pipeline has scored customers");
    const stageTotal = Object.values(summaryBefore.stages).reduce((s: number, st: any) => s + st.count, 0);
    assert(stageTotal === summaryBefore.total, "stage buckets partition the scored customers");

    // ── 4. One-click win-back campaign from the at-risk list ─────────────
    await world.db.insert(schema.whatsappTemplates).values({
      id: "wtpl-sim-j112", tenantId: TENANT_ID, name: "sim_broadcast",
      category: "custom", language: "en_US",
      bodyText: "Hello {{1}}, we miss you — come back for a deal!",
      approvalStatus: "approved", isActive: true,
    }).onConflictDoNothing();

    const { id: campaignId } = await caller.crm.createWinBackCampaign({
      tenantId: TENANT_ID, name: "J112 Win-back", templateName: "sim_broadcast",
    });
    const [campaign] = await world.db
      .select()
      .from(schema.broadcastCampaigns)
      .where(eq(schema.broadcastCampaigns.id, campaignId))
      .limit(1);
    assert(campaign.status === "draft", "win-back campaign starts as a draft");
    assert((campaign.segmentFilter as any)?.noOrderSinceDays === 30, "audience = at-risk (no order in 30d+)");
    assert((campaign.segmentFilter as any)?.minOrders === 1, "audience = previously-active buyers only");

    // ── 5. Movement: a won-back buyer orders again → leaves at-risk ───────
    // Pick a lapsing buyer that is actually ON the list (the 200-cap above).
    const won = lapsing.find((l) => riskRows.some((r: any) => r.customerId === l.id)) ?? lapsing[0];
    await world.db.insert(schema.orders).values({
      id: "j112-wonback-ord", tenantId: TENANT_ID, customerId: won.id,
      orderNumber: "J112-WONBACK", status: "delivered",
      totalAmount: "12000.00", currency: "NGN",
      createdAt: new Date(now - DAY), updatedAt: new Date(now - DAY),
    }).onConflictDoNothing();
    await world.db.update(schema.customers)
      .set({ lastOrderAt: new Date(now - DAY), totalOrders: 4 })
      .where(and(eq(schema.customers.id, won.id), eq(schema.customers.tenantId, TENANT_ID)));

    const refreshed = await caller.crm.refreshScores({ tenantId: TENANT_ID });
    assert(refreshed.refreshed >= 1, `scores refreshed (got ${refreshed.refreshed})`);

    const atRiskAfter = await caller.crm.atRiskList({ tenantId: TENANT_ID, limit: 200 });
    assert(!atRiskAfter.some((r: any) => r.customerId === won.id), "won-back buyer leaves the at-risk list");
    const remaining = atRiskAfter.filter((r: any) => String(r.name ?? "").startsWith("J112 Lapsing"));
    // 29 lapsing buyers qualify now; a previously-capped-out row may take the
    // freed slot, so the visible count drops by at most one.
    assert(remaining.length >= riskRows.length - 1 && remaining.length <= 29,
      `lapsing at-risk count moved (${riskRows.length} → ${remaining.length})`);

    const summaryAfter = await caller.crm.pipelineSummary({ tenantId: TENANT_ID });
    assert(summaryAfter.total === summaryBefore.total, "same scored population");
    assert(
      JSON.stringify(summaryAfter.stages) !== JSON.stringify(summaryBefore.stages) ||
      JSON.stringify(summaryAfter.bands) !== JSON.stringify(summaryBefore.bands),
      "pipelineSummary reflects the won-back movement (stage/band distribution shifted)",
    );
    // The won-back buyer re-scores with fresh recency: their score improves.
    const wonBreakdown = await caller.crm.getScoreBreakdown({ tenantId: TENANT_ID, customerId: won.id });
    assert(wonBreakdown.factors.some((f: any) => f.factor === "recency:ordered_within_7d"),
      "won-back buyer scores the recency factor again");
  },
};
