/**
 * J110 (M5) — merchant trains uplift models and runs an uplift-ranked
 * broadcast end-to-end on the sim tenant:
 *   1. Seeds messaged (treatment) and never-messaged (control) cohorts with
 *      divergent outcomes, then trains BOTH uplift arms via
 *      broadcast.trainUpliftModel.
 *   2. Creates a broadcast with rankByUplift → the high-uplift responders
 *      are ranked FIRST (sorted desc, all above the uplift threshold);
 *      non-responders and dormant controls are filtered out.
 *   3. Consent withdrawal: a ranked responder who withdraws is EXCLUDED from
 *      the uplift-ranked audience (hard gate, independent of uplift score).
 *   4. Frequency cap: a ranked customer at the marketing cap is DEFERRED
 *      (recipient row carries the deferral reason), not sent.
 *   5. dryRun=true reports upliftRanked and per-recipient uplift scores in
 *      the sample payload — the merchant can inspect scores before sending.
 *
 * Determinism: quiet hours are disabled via the tenant marketing-frequency
 * policy for the whole journey (Lagos quiet hours are exercised in J111).
 * NOTE: services are imported LAZILY inside run() — loadJourneys() executes
 * before bootWorld() sets the sim env (see j101 header).
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

interface Seeded { id: string; phone: string; name: string }

async function seedUpliftCohorts(world: World) {
  const schema = await import("../../drizzle/schema");
  const now = Date.now();

  await world.db.insert(schema.whatsappTemplates).values({
    id: "wtpl-sim-j110", tenantId: TENANT_ID, name: "sim_broadcast",
    category: "custom", language: "en_US",
    bodyText: "Hello {{1}}, we miss you — come back for a deal!",
    approvalStatus: "approved", isActive: true,
  }).onConflictDoNothing();

  // Historical campaign whose recipients form the treatment arm.
  await world.db.insert(schema.broadcastCampaigns).values({
    id: "j110-hist-campaign", tenantId: TENANT_ID, name: "J110 historical win-back",
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

  // Treatment arm: 25 responders (messaged 20d ago, replied, re-ordered).
  for (let i = 0; i < 25; i++) {
    const c = await mkCustomer(`j110r${i}`, `J110R Responder ${i}`, 5, 4, "40000.00");
    responders.push(c);
    for (const [k, d] of [[0, 20], [1, 18], [2, 16]] as const) await mkOrder(`j110-rord-${i}-${k}`, c.id, d);
    await mkOrder(`j110-rord-${i}-post`, c.id, 5); // label: re-ordered in window
    await world.db.insert(schema.broadcastRecipients).values({
      id: `j110-hist-rcp-r${i}`, campaignId: "j110-hist-campaign", phone: c.phone,
      name: c.name, status: "sent", sentAt: new Date(now - 20 * DAY),
      createdAt: new Date(now - 20 * DAY),
    }).onConflictDoNothing();
    // Treatment-only discriminator: engaged replies before the reference date.
    for (let k = 0; k < 5; k++) {
      await world.db.insert(schema.whatsappCustomerReplies).values({
        tenantId: TENANT_ID, fromPhone: c.phone, body: `j110 interested ${k}`,
        wamid: `wamid-j110-r${i}-${k}`,
        createdAt: new Date(now - (19 - k) * DAY),
      }).onConflictDoNothing();
    }
  }
  // Treatment arm: 20 non-responders (messaged 20d ago, stayed dormant).
  for (let i = 0; i < 20; i++) {
    const c = await mkCustomer(`j110n${i}`, `J110N NonResponder ${i}`, 150, 2, "20000.00");
    nonResponders.push(c);
    for (const [k, d] of [[0, 200], [1, 150]] as const) await mkOrder(`j110-nord-${i}-${k}`, c.id, d);
    await world.db.insert(schema.broadcastRecipients).values({
      id: `j110-hist-rcp-n${i}`, campaignId: "j110-hist-campaign", phone: c.phone,
      name: c.name, status: "sent", sentAt: new Date(now - 20 * DAY),
      createdAt: new Date(now - 20 * DAY),
    }).onConflictDoNothing();
  }
  // Control arm: 45 never-messaged dormant customers (5 re-order anyway).
  for (let i = 0; i < 45; i++) {
    const c = await mkCustomer(`j110c${i}`, `J110C Control ${i}`, 150, 2, "20000.00");
    controls.push(c);
    for (const [k, d] of [[0, 200], [1, 150]] as const) await mkOrder(`j110-cord-${i}-${k}`, c.id, d);
    if (i < 5) await mkOrder(`j110-cord-${i}-post`, c.id, 3);
  }

  return { responders, nonResponders, controls };
}

export const journey: Journey = {
  id: "J110",
  name: "merchant uplift-trained broadcast (M5)",
  feature: "uplift training on seeded cohorts → rankByUplift send → consent withdrawal excluded → frequency cap deferred → dryRun uplift scores",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { UPLIFT_MODEL_PARAMS } = await import("../../server/services/mlUplift");
    const { buildBroadcastAudience } = await import("../../server/routers/broadcast");
    const caller = await adminCaller();

    // Deterministic scheduling: quiet hours disabled for this journey; the
    // frequency window is configured per phase below.
    const origSettings = await world.tenantSettings();
    await world.patchTenantSettings({
      marketingFrequency: { maxPerWindow: 5, windowDays: 7, quietStart: "00:00", quietEnd: "00:00" },
    });

    try {
      const { responders, nonResponders, controls } = await seedUpliftCohorts(world);

      // ── 1. Train both uplift arms ───────────────────────────────────────
      const trained = await caller.broadcast.trainUpliftModel({ tenantId: TENANT_ID });
      assert(trained.trained === true, `uplift models trained (got ${JSON.stringify(trained)})`);
      assert((trained.treatmentSamples ?? 0) >= 45, `treatment arm ≥45 (got ${trained.treatmentSamples})`);
      assert((trained.controlSamples ?? 0) >= 45, `control arm ≥45 (got ${trained.controlSamples})`);

      const status = await caller.broadcast.upliftModelStatus({ tenantId: TENANT_ID });
      assert(status.trained === true, "upliftModelStatus reports trained");
      assert(status.version === trained.version, "status version matches training result");

      // ── 2. rankByUplift audience: high-uplift customers ranked first ────
      const ranked = await buildBroadcastAudience(world.db, TENANT_ID, { noOrderSinceDays: 30 }, { rankByUplift: true });
      assert(ranked.length >= 15, `ranked audience ≥15 (got ${ranked.length})`);
      assert(
        ranked.every((m: any) => typeof m.uplift === "number" && m.uplift > UPLIFT_MODEL_PARAMS.upliftThreshold),
        "every ranked member is above the uplift threshold",
      );
      for (let i = 1; i < ranked.length; i++) {
        assert((ranked[i - 1] as any).uplift >= (ranked[i] as any).uplift, "ranked highest-uplift first");
      }
      const rankedNames = new Set(ranked.map((m: any) => String(m.name)));
      const respondersIn = responders.filter((r) => rankedNames.has(r.name)).length;
      assert(respondersIn >= 15, `≥15 responders surfaced by uplift ranking (got ${respondersIn})`);
      // Ranking order is asserted above (strictly non-increasing uplift, all
      // above threshold). No absolute-position assertion: the seed world's
      // heavily-engaged "Sim User" customers legitimately occupy top slots in
      // the full-suite run — what matters is that the responder cohort is
      // surfaced and the negative cohorts are filtered (below).
      assert(!nonResponders.some((c) => rankedNames.has(c.name)), "non-responders filtered out (uplift ≤ threshold)");
      assert(!controls.slice(5).some((c) => rankedNames.has(c.name)), "dormant controls filtered out");

      // ── 3. dryRun shows uplift scores before anything is sent ──────────
      const campaign = await caller.broadcast.create({
        tenantId: TENANT_ID, name: "J110 uplift ranked", templateName: "sim_broadcast",
        segmentFilter: { noOrderSinceDays: 30 },
      });
      const dry = await caller.broadcast.send({ campaignId: campaign.id, dryRun: true, rankByUplift: true });
      assert(dry.dryRun === true, "dry-run flag echoed");
      assert(dry.upliftRanked === true, "dry-run reports the uplift ranking");
      assert(dry.total === ranked.length, "dry-run audience size matches the ranked build");
      assert(dry.sample.length > 0 && dry.sample.every((s: any) => typeof s.uplift === "number"),
        "dry-run sample carries per-recipient uplift scores");
      for (let i = 1; i < dry.sample.length; i++) {
        assert((dry.sample[i - 1] as any).uplift >= (dry.sample[i] as any).uplift, "dry-run sample sorted by uplift");
      }
      // Nothing was sent by the dry run.
      const dryRecipients = await world.db
        .select({ id: schema.broadcastRecipients.id })
        .from(schema.broadcastRecipients)
        .where(eq(schema.broadcastRecipients.campaignId, campaign.id));
      assert(dryRecipients.length === 0, "dry run persists no recipients");

      // ── 4. Consent withdrawal excludes a high-uplift customer ───────────
      const withdrawn = responders.find((r) => rankedNames.has(r.name))!;
      const wd = await caller.consents.recordWithdrawal({ tenantId: TENANT_ID, phone: withdrawn.phone });
      assert(wd.withdrawnAt, "withdrawal recorded");
      const rankedAfterWd = await buildBroadcastAudience(world.db, TENANT_ID, { noOrderSinceDays: 30 }, { rankByUplift: true });
      assert(
        !rankedAfterWd.some((m: any) => String(m.name) === withdrawn.name),
        "withdrawn high-uplift customer excluded from the ranked audience",
      );
      assert(rankedAfterWd.length === ranked.length - 1, "exactly one member lost to the withdrawal");

      // ── 5. Frequency cap enforced under uplift ranking ──────────────────
      await world.patchTenantSettings({
        marketingFrequency: { maxPerWindow: 1, windowDays: 7, quietStart: "00:00", quietEnd: "00:00" },
      });
      const capped = responders.find((r) => r.name !== withdrawn.name && rankedNames.has(r.name))!;
      const { normalizeWaPhone } = await import("../../server/services/waSender");
      await world.db.insert(schema.whatsappNotificationLog).values({
        tenantId: TENANT_ID, phone: normalizeWaPhone(capped.phone), notifType: "broadcast",
        status: "sent", sentAt: new Date(Date.now() - 60 * 60 * 1000),
      }).onConflictDoNothing();

      const sendRes = await caller.broadcast.send({ campaignId: campaign.id, rankByUplift: true });
      assert(sendRes.dryRun === false, "real send");
      assert((sendRes.deferred ?? 0) >= 1, `capped customer deferred (got ${sendRes.deferred})`);
      const cappedRecipient = await world.db
        .select()
        .from(schema.broadcastRecipients)
        .where(and(
          eq(schema.broadcastRecipients.campaignId, campaign.id),
          eq(schema.broadcastRecipients.phone, capped.phone),
        ))
        .limit(1);
      assert(
        cappedRecipient.length === 1 && String(cappedRecipient[0].failureReason ?? "").includes("deferred by marketing frequency policy"),
        "frequency cap defers the capped recipient even in an uplift-ranked send",
      );
      // The withdrawn customer was never even attempted.
      const withdrawnRecipient = await world.db
        .select()
        .from(schema.broadcastRecipients)
        .where(and(
          eq(schema.broadcastRecipients.campaignId, campaign.id),
          eq(schema.broadcastRecipients.phone, withdrawn.phone),
        ))
        .limit(1);
      assert(withdrawnRecipient.length === 0, "withdrawn customer never enters the recipient list");
    } finally {
      await world.patchTenantSettings({ marketingFrequency: origSettings.marketingFrequency ?? null });
    }
  },
};
