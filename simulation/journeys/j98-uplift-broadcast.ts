/**
 * J98 — uplift-modeled broadcast targeting (W21).
 *
 * Seeds two cohorts on the sim tenant: a TREATED cohort (received a win-back
 * broadcast 20d ago) split into 25 responders (recent history + replied +
 * re-ordered inside the 14d label window) and 20 non-responders (dormant,
 * silent), plus a CONTROL cohort of 45 never-messaged dormant customers
 * (5 re-ordered anyway). Then:
 *   1. untrained tenant B → scoreUplift fallback (uplift null,
 *      fallbackUsed) and broadcast dry-run with rankByUplift falls back to
 *      the noOrderSinceDays heuristic unchanged;
 *   2. broadcast.trainUpliftModel trains BOTH arms (≥40 samples per arm);
 *   3. rankByUplift audience = modeled-uplift ranking INSTEAD of the
 *      heuristic: responders surface, non-responders/controls filtered out
 *      (uplift ≤ threshold), sorted highest-first, deterministic;
 *   4. frequency cap still enforced under uplift ranking (capped phone is
 *      deferred, quiet hours disabled via tenant policy for determinism);
 *   5. cross-tenant trainUpliftModel/upliftModelStatus → FORBIDDEN;
 *   6. cron /api/scheduled/uplift-model-tick re-trains deterministically
 *      (same data → identical weights on the next version, per role).
 */
import { eq, and } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

const TENANT_B = "sim-tenant-b";
const DAY = 24 * 60 * 60 * 1000;

interface Seeded { id: string; phone: string; name: string }

async function seedCohorts(world: World) {
  const schema = await import("../../drizzle/schema");
  const now = Date.now();

  // Template for the ranked send (standalone-safe; J91 seeds the same name).
  await world.db.insert(schema.whatsappTemplates).values({
    id: "wtpl-sim-j98", tenantId: TENANT_ID, name: "sim_broadcast",
    category: "custom", language: "en_US",
    bodyText: "Hello {{1}}, we miss you — come back for a deal!",
    approvalStatus: "approved", isActive: true,
  }).onConflictDoNothing();

  // Historical win-back campaign whose sent recipients define the treatment arm.
  await world.db.insert(schema.broadcastCampaigns).values({
    id: "j98-hist-campaign", tenantId: TENANT_ID, name: "J98 historical win-back",
    segment: "custom", status: "completed", createdBy: "sim",
    createdAt: new Date(now - 21 * DAY), updatedAt: new Date(now - 21 * DAY),
  }).onConflictDoNothing();

  const responders: Seeded[] = [];
  const nonResponders: Seeded[] = [];
  const controls: Seeded[] = [];

  const mkCustomer = async (tag: string, name: string, lastOrderDaysAgo: number, totalOrders: number, spent: string) => {
    const phone = world.newPhone(tag);
    const id = `cust-${phone}`;
    await world.db.insert(schema.customers).values({
      id, tenantId: TENANT_ID, whatsappPhone: phone, name,
      totalOrders, totalSpent: spent, lastOrderAt: new Date(now - lastOrderDaysAgo * DAY),
    }).onConflictDoNothing();
    await world.grantConsent(phone);
    return { id, phone, name };
  };
  const mkOrder = async (id: string, custId: string, daysAgo: number) => {
    await world.db.insert(schema.orders).values({
      id, tenantId: TENANT_ID, customerId: custId, orderNumber: id.toUpperCase(),
      status: "delivered", totalAmount: "10000.00", currency: "NGN",
      createdAt: new Date(now - daysAgo * DAY), updatedAt: new Date(now - daysAgo * DAY),
    }).onConflictDoNothing();
  };

  // ── Treatment arm: 25 responders + 20 non-responders, all messaged 20d ago
  for (let i = 0; i < 25; i++) {
    const c = await mkCustomer(`j98r${i}`, `J98R Responder ${i}`, 5, 4, "40000.00");
    responders.push(c);
    // Recent pre-reference history (reference = now − 14d).
    for (const [k, d] of [[0, 20], [1, 18], [2, 16]] as const) await mkOrder(`j98-rord-${i}-${k}`, c.id, d);
    // Label 1: re-ordered inside the label window.
    await mkOrder(`j98-rord-${i}-post`, c.id, 5);
    // The message itself (before the reference date).
    await world.db.insert(schema.broadcastRecipients).values({
      id: `j98-hist-rcp-r${i}`, campaignId: "j98-hist-campaign", phone: c.phone,
      name: c.name, status: "sent", sentAt: new Date(now - 20 * DAY),
      createdAt: new Date(now - 20 * DAY),
    }).onConflictDoNothing();
    // Engaged: 5 inbound replies before the reference date (replyRate = 1.0 —
    // a treatment-only discriminator: control-arm customers never have it).
    for (let k = 0; k < 5; k++) {
      await world.db.insert(schema.whatsappCustomerReplies).values({
        tenantId: TENANT_ID, fromPhone: c.phone, body: `interested ${k}`,
        wamid: `wamid-j98-r${i}-${k}`,
        createdAt: new Date(now - (19 - k) * DAY),
      }).onConflictDoNothing();
    }
  }
  for (let i = 0; i < 20; i++) {
    const c = await mkCustomer(`j98n${i}`, `J98N NonResponder ${i}`, 150, 2, "20000.00");
    nonResponders.push(c);
    for (const [k, d] of [[0, 200], [1, 150]] as const) await mkOrder(`j98-nord-${i}-${k}`, c.id, d);
    await world.db.insert(schema.broadcastRecipients).values({
      id: `j98-hist-rcp-n${i}`, campaignId: "j98-hist-campaign", phone: c.phone,
      name: c.name, status: "sent", sentAt: new Date(now - 20 * DAY),
      createdAt: new Date(now - 20 * DAY),
    }).onConflictDoNothing();
  }

  // ── Control arm: 45 never-messaged dormant customers (5 buy anyway) ──────
  for (let i = 0; i < 45; i++) {
    const c = await mkCustomer(`j98c${i}`, `J98C Control ${i}`, 150, 2, "20000.00");
    controls.push(c);
    for (const [k, d] of [[0, 200], [1, 150]] as const) await mkOrder(`j98-cord-${i}-${k}`, c.id, d);
    if (i < 5) await mkOrder(`j98-cord-${i}-post`, c.id, 3);
  }

  // ── Tenant B: history but no message arms at all (fallback proof) ────────
  for (let i = 0; i < 3; i++) {
    const phone = world.newPhone(`j98b${i}`);
    await world.db.insert(schema.customers).values({
      id: `cust-${phone}`, tenantId: TENANT_B, whatsappPhone: phone, name: `J98 B ${i}`,
      totalOrders: 2, totalSpent: "20000.00", lastOrderAt: new Date(now - 60 * DAY),
    }).onConflictDoNothing();
  }

  return { responders, nonResponders, controls };
}

export const journey: Journey = {
  id: "J98",
  name: "uplift-modeled broadcast targeting",
  feature: "two-model uplift ranking replaces win-back heuristic; caps + consent unchanged; fallback when untrained",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { scoreUplift, UPLIFT_MODEL_PARAMS } = await import("../../server/services/mlUplift");
    const { buildBroadcastAudience } = await import("../../server/routers/broadcast");
    const caller = await adminCaller();

    const { responders, nonResponders, controls } = await seedCohorts(world);

    // ── 1. Untrained → fallback contract (never throws) ───────────────────
    const pre = await scoreUplift(world.db, TENANT_ID, responders[0].id);
    assert(pre.fallbackUsed === true, "untrained tenant → fallback");
    assert(pre.uplift === null, "fallback uplift is null");
    assert(pre.modelVersion === null, "no model version before training");

    const statusB = await caller.broadcast.upliftModelStatus({ tenantId: TENANT_B });
    assert(statusB.trained === false, "tenant B untrained");
    const trainedB = await caller.broadcast.trainUpliftModel({ tenantId: TENANT_B });
    assert(trainedB.trained === false && trainedB.reason === "insufficient_samples", "tenant B below the per-arm gate");

    // Untrained dry-run with rankByUplift → heuristic fallback unchanged.
    const preCampaign = await caller.broadcast.create({
      tenantId: TENANT_ID, name: "J98 pre-train", templateName: "sim_broadcast",
      segmentFilter: { noOrderSinceDays: 30 },
    });
    const preDry = await caller.broadcast.send({ campaignId: preCampaign.id, dryRun: true, rankByUplift: true });
    assert(preDry.upliftRanked === false, "untrained → heuristic fallback (not uplift-ranked)");
    const heuristicAudience = await buildBroadcastAudience(world.db, TENANT_ID, { noOrderSinceDays: 30 }, { rankByUplift: true });
    assert(heuristicAudience.every((m: any) => m.uplift === undefined), "heuristic fallback carries no uplift scores");
    assert(
      heuristicAudience.some((m: any) => String(m.name).startsWith("J98N")) &&
      !heuristicAudience.some((m: any) => String(m.name).startsWith("J98R")),
      "fallback = noOrderSinceDays heuristic: dormant in, recent responders out",
    );

    // ── 2. Train both arms ────────────────────────────────────────────────
    const trained = await caller.broadcast.trainUpliftModel({ tenantId: TENANT_ID });
    assert(trained.trained === true, `uplift models trained (got ${JSON.stringify(trained)})`);
    assert(trained.treatmentSamples! >= 45, `treatment arm ≥45 (got ${trained.treatmentSamples})`);
    assert(trained.controlSamples! >= 45, `control arm ≥45 (got ${trained.controlSamples})`);
    assert(trained.version === 1, `first version = 1 (got ${trained.version})`);

    const status = await caller.broadcast.upliftModelStatus({ tenantId: TENANT_ID });
    assert(status.trained === true && status.version === 1, "status reports trained v1");
    assert(status.treatmentSamples === trained.treatmentSamples && status.controlSamples === trained.controlSamples, "status arm counts match");

    // ── 3. Uplift ranking surfaces high-uplift customers ──────────────────
    const ranked = await buildBroadcastAudience(world.db, TENANT_ID, { noOrderSinceDays: 30 }, { rankByUplift: true });
    // (In the full suite, earlier journeys' leftover customers shift both
    // arms' base rates — the ranking must still surface the responders.)
    assert(ranked.length >= 15, `ranked audience ≥15 (got ${ranked.length})`);
    assert(ranked.every((m: any) => typeof m.uplift === "number" && m.uplift > UPLIFT_MODEL_PARAMS.upliftThreshold),
      "every ranked member above the uplift threshold");
    for (let i = 1; i < ranked.length; i++) {
      assert((ranked[i - 1] as any).uplift >= (ranked[i] as any).uplift, "ranked highest-uplift first");
    }
    const rankedNames = new Set(ranked.map((m: any) => String(m.name)));
    const respondersIn = responders.filter((r) => rankedNames.has(r.name)).length;
    assert(respondersIn >= 15, `≥15 responders surfaced by uplift (got ${respondersIn})`);
    assert(!nonResponders.some((c) => rankedNames.has(c.name)), "non-responders filtered out (uplift ≤ threshold)");
    // The 5 controls who re-ordered 3d ago are feature-identical to
    // responders at score time (recent + frequent) and legitimately rank;
    // the dormant controls must all be filtered out.
    assert(!controls.slice(5).some((c) => rankedNames.has(c.name)), "dormant control cohort filtered out");

    // Individual scores: responders ≫ non-responders.
    const r0 = await scoreUplift(world.db, TENANT_ID, responders[0].id);
    const n0 = await scoreUplift(world.db, TENANT_ID, nonResponders[0].id);
    assert(r0.fallbackUsed === false && n0.fallbackUsed === false, "trained tenant → ML path");
    assert(r0.uplift! > UPLIFT_MODEL_PARAMS.upliftThreshold, `responder uplift positive (got ${r0.uplift})`);
    assert(n0.uplift! <= UPLIFT_MODEL_PARAMS.upliftThreshold, `non-responder uplift below threshold (got ${n0.uplift})`);
    assert(r0.uplift! >= -1 && r0.uplift! <= 1, "uplift clamped to [−1,1]");

    // Trained dry-run reports the uplift ranking.
    const postCampaign = await caller.broadcast.create({
      tenantId: TENANT_ID, name: "J98 uplift ranked", templateName: "sim_broadcast",
      segmentFilter: { noOrderSinceDays: 30 },
    });
    const postDry = await caller.broadcast.send({ campaignId: postCampaign.id, dryRun: true, rankByUplift: true });
    assert(postDry.upliftRanked === true, "trained → dry-run reports uplift ranking");
    assert(postDry.total === ranked.length, "dry-run audience matches the ranked build");

    // ── 4. Frequency cap still enforced under uplift ranking ──────────────
    // Deterministic: quiet hours disabled via tenant policy; one ranked
    // customer is at the cap (1 prior marketing send, maxPerWindow 1).
    await world.patchTenantSettings({
      marketingFrequency: { maxPerWindow: 1, windowDays: 7, quietStart: "00:00", quietEnd: "00:00" },
    });
    const capped = responders.find((r) => rankedNames.has(r.name))!;
    const { normalizeWaPhone } = await import("../../server/services/waSender");
    await world.db.insert(schema.whatsappNotificationLog).values({
      tenantId: TENANT_ID, phone: normalizeWaPhone(capped.phone), notifType: "broadcast",
      status: "sent", sentAt: new Date(Date.now() - 60 * 60 * 1000),
    }).onConflictDoNothing();

    const sendRes = await caller.broadcast.send({ campaignId: postCampaign.id, rankByUplift: true });
    assert(sendRes.deferred >= 1, `capped customer deferred (got ${sendRes.deferred})`);
    const cappedRecipient = await world.db
      .select()
      .from(schema.broadcastRecipients)
      .where(and(
        eq(schema.broadcastRecipients.campaignId, postCampaign.id),
        eq(schema.broadcastRecipients.phone, capped.phone),
      ))
      .limit(1);
    assert(
      cappedRecipient.length === 1 && String(cappedRecipient[0].failureReason ?? "").includes("deferred by marketing frequency policy"),
      "frequency cap defers the capped recipient even in an uplift-ranked send",
    );

    // ── 5. Cross-tenant guard ─────────────────────────────────────────────
    const { appRouter } = await import("../../server/routers");
    const outsider = appRouter.createCaller({
      user: { id: 99, openId: "sim-outsider", role: "user", tenantId: "someone-else" } as any,
      req: { protocol: "http", headers: {} },
    } as any);
    const trainDenied = await outsider.broadcast.trainUpliftModel({ tenantId: TENANT_ID }).then(() => false, (e: any) => e?.code === "FORBIDDEN");
    assert(trainDenied, "trainUpliftModel rejects cross-tenant");
    const statusDenied = await outsider.broadcast.upliftModelStatus({ tenantId: TENANT_ID }).then(() => false, (e: any) => e?.code === "FORBIDDEN");
    assert(statusDenied, "upliftModelStatus rejects cross-tenant");

    // ── 6. Cron retrain is deterministic (same data → identical weights) ──
    const tick = await world.runCron("/api/scheduled/uplift-model-tick");
    assert(tick.status === 200, `cron tick 200 (got ${tick.status})`);
    assert(tick.json?.ok === true, "cron tick ok");
    assert(tick.json.trained >= 1, `cron trained ≥1 tenant (got ${tick.json.trained})`);
    assert(tick.json.tenants >= 2, "cron visited both tenants");

    const models = await world.db
      .select()
      .from(schema.upliftModels)
      .where(eq(schema.upliftModels.tenantId, TENANT_ID));
    assert(models.length === 4, `two versions × two roles after cron (got ${models.length})`);
    for (const role of ["treatment", "control"] as const) {
      const v1 = models.find((m: any) => m.role === role && m.version === 1)!;
      const v2 = models.find((m: any) => m.role === role && m.version === 2)!;
      assert(v1 && v2, `${role} versions 1 and 2 persisted`);
      assert(
        JSON.stringify(v1.weights) === JSON.stringify(v2.weights),
        `deterministic retrain: identical ${role} weights for identical data`,
      );
      assert(v2.sampleCount === v1.sampleCount && v2.sampleCount >= 40, `${role} arm sample counts recorded`);
    }
  },
};
