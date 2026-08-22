/**
 * J91 — CRM lead scoring + win-back (W17 F11).
 *
 * A customer with a strong order history scores HOT after refresh; the
 * merchant views the CRM pipeline summary; a previously-active buyer who has
 * gone quiet for 45 days shows up on the at-risk list; the merchant creates
 * a one-click win-back broadcast (draft → real send via the existing
 * broadcast seams, at-risk segment = consent-gated template send); the
 * customer replies; a score refresh reflects the engagement
 * (replied_to_broadcast_within_24h + whatsapp_active_within_7d factors).
 */
import { eq, and } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J91",
  name: "crm lead scoring + win-back",
  feature: "RFM+credit lead score → pipeline → at-risk win-back broadcast → reply lifts score",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    // ── Cast: HOT buyer (strong recent history) + AT-RISK buyer (quiet 45d)
    const hotPhone = world.newPhone("j91hot");
    const riskPhone = world.newPhone("j91risk");
    const hotId = `cust-${hotPhone}`;
    const riskId = `cust-${riskPhone}`;

    await world.db.insert(schema.customers).values({
      id: hotId, tenantId: TENANT_ID, whatsappPhone: hotPhone, name: "J91 Hot Buyer",
      totalOrders: 6, totalSpent: "120000.00", lastOrderAt: new Date(now - 2 * day),
    }).onConflictDoNothing();
    await world.db.insert(schema.customers).values({
      id: riskId, tenantId: TENANT_ID, whatsappPhone: riskPhone, name: "J91 Quiet Buyer",
      totalOrders: 4, totalSpent: "30000.00", lastOrderAt: new Date(now - 45 * day),
    }).onConflictDoNothing();

    // Strong recent order book for the hot buyer (frequency + recency RFM).
    for (let i = 0; i < 5; i++) {
      await world.db.insert(schema.orders).values({
        id: `j91-ord-${i}`, tenantId: TENANT_ID, customerId: hotId,
        orderNumber: `J91-${i}`, status: "delivered",
        totalAmount: "20000.00", currency: "NGN",
        createdAt: new Date(now - (i + 1) * day), updatedAt: new Date(now - (i + 1) * day),
      }).onConflictDoNothing();
    }

    // Both buyers consented so the broadcast audience gate lets them through.
    await world.grantConsent(riskPhone);

    // ── 1. Merchant refreshes scores → hot buyer is HOT, explainably ──────
    const refreshed = await caller.crm.refreshScores({ tenantId: TENANT_ID });
    assert(refreshed.refreshed >= 2, `scores refreshed (got ${refreshed.refreshed})`);

    const hotBreakdown = await caller.crm.getScoreBreakdown({ tenantId: TENANT_ID, customerId: hotId });
    assert(hotBreakdown.score >= 70, `strong history → hot score (got ${hotBreakdown.score})`);
    assert(hotBreakdown.band === "hot", `band hot (got ${hotBreakdown.band})`);
    const factorNames = hotBreakdown.factors.map((f: any) => f.factor);
    for (const expected of ["recency:ordered_within_7d", "frequency:orders_last_90d", "monetary:lifetime_value"]) {
      assert(factorNames.includes(expected), `explainable factor ${expected} present`);
    }

    // ── 2. Merchant views the pipeline summary ────────────────────────────
    const summary = await caller.crm.pipelineSummary({ tenantId: TENANT_ID });
    assert(summary.total >= 2, `pipeline has scored customers (got ${summary.total})`);
    assert(summary.bands.hot >= 1, "at least one hot customer in the band distribution");
    const stageTotal = Object.values(summary.stages).reduce((s: number, st: any) => s + st.count, 0);
    assert(stageTotal === summary.total, "stage buckets partition the scored customers");
    assert(summary.stages.repeat.count >= 1, "hot buyer bucketed as repeat");

    // ── 3. At-risk list surfaces the quiet buyer ──────────────────────────
    const atRisk = await caller.crm.atRiskList({ tenantId: TENANT_ID });
    const riskRow = atRisk.find((r: any) => r.customerId === riskId);
    assert(riskRow, "quiet repeat buyer is on the at-risk list");
    assert(riskRow!.daysSinceLastOrder >= 30, `quiet ≥30d (got ${riskRow!.daysSinceLastOrder})`);
    assert(!atRisk.some((r: any) => r.customerId === hotId), "active hot buyer is NOT at-risk");

    // ── 4. One-click win-back broadcast to the at-risk segment ────────────
    await world.db.insert(schema.whatsappTemplates).values({
      id: "wtpl-sim-1",
      tenantId: TENANT_ID,
      name: "sim_broadcast",
      category: "custom",
      language: "en_US",
      bodyText: "Hello {{1}}, we miss you — come back for a deal!",
      approvalStatus: "approved",
      isActive: true,
    }).onConflictDoNothing();

    const { id: campaignId } = await caller.crm.createWinBackCampaign({
      tenantId: TENANT_ID,
      name: "J91 Win-back",
      templateName: "sim_broadcast",
    });
    assert(campaignId, "win-back draft campaign created");
    const [campaign] = await world.db
      .select()
      .from(schema.broadcastCampaigns)
      .where(eq(schema.broadcastCampaigns.id, campaignId))
      .limit(1);
    assert(campaign.status === "draft", "win-back campaign starts as a draft");
    assert((campaign.segmentFilter as any)?.noOrderSinceDays === 30, "audience = no order in 30d+");

    // Pin the marketing-frequency clock to 12:00 Africa/Lagos so the
    // quiet-hours gate (21:00–08:00) in frequencyCap is deterministic —
    // without this the journey flaked whenever the suite ran at night.
    const { setMarketingClockOverride } = await import("../../server/services/frequencyCap");
    const pinnedNoonLagos = () => {
      const n = new Date();
      // Lagos = UTC+1 → 12:00 Lagos == 11:00 UTC, same calendar day.
      return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 11, 0, 0, 0));
    };
    setMarketingClockOverride(pinnedNoonLagos);
    let sent: { total: number };
    try {
      sent = await caller.broadcast.send({ campaignId });
    } finally {
      setMarketingClockOverride(null);
    }
    assert(sent.total >= 1, `win-back sent to at-risk audience (got ${sent.total})`);
    await world.waitFor(
      () => world.outbound.toPhone(riskPhone).some((c) => c.waType === "template"),
      8000,
      "win-back template delivered to at-risk buyer",
    );
    assert(
      world.outbound.toPhone(hotPhone).length === 0,
      "recently-active buyer excluded from the win-back audience",
    );

    // ── 5. Customer replies → refresh reflects the engagement ─────────────
    await world.text(riskPhone, "I'm interested!");

    await world.waitFor(async () => {
      const rows = await world.db
        .select()
        .from(schema.whatsappCustomerReplies)
        .where(and(
          eq(schema.whatsappCustomerReplies.tenantId, TENANT_ID),
          eq(schema.whatsappCustomerReplies.fromPhone, riskPhone),
        ))
        .limit(5);
      return rows.length > 0;
    }, 10000, "inbound reply recorded");

    await caller.crm.refreshScores({ tenantId: TENANT_ID });
    const riskBreakdown = await caller.crm.getScoreBreakdown({ tenantId: TENANT_ID, customerId: riskId });
    const riskFactors = riskBreakdown.factors.map((f: any) => f.factor);
    assert(riskFactors.includes("engagement:replied_to_broadcast_within_24h"), "reply within 24h lifts the score");
    assert(riskFactors.includes("engagement:whatsapp_active_within_7d"), "whatsapp activity recency lifts the score");
  },
};
