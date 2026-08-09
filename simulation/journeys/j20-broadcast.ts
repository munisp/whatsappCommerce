/**
 * J20 — Broadcast: the audience excludes non-consented contacts; in-window
 * recipients get free-form text, out-of-window get the approved template;
 * dryRun counts without sending; LOW quality blocks the send.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J20",
  name: "broadcast campaign",
  feature: "consent gate + window routing + quality block",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();

    // Audience: A consented + in-window, B consented + out-of-window, C NOT consented.
    const phoneA = world.newPhone("a");
    const phoneB = world.newPhone("b");
    const phoneC = world.newPhone("c");
    for (const [phone, name] of [[phoneA, "Ada Inwindow"], [phoneB, "Bayo Outwindow"], [phoneC, "Chi Noconsent"]] as const) {
      await world.db.insert(schema.customers).values({
        id: `cust-${phone}`, tenantId: TENANT_ID, whatsappPhone: phone, name,
      }).onConflictDoNothing();
    }
    await world.grantConsent(phoneA);
    await world.grantConsent(phoneB);
    // phoneC: no consent row at all.

    // A is inside the 24h window (recent inbound).
    await world.text(phoneA, "hi");

    // Campaign template body for in-window free-form text.
    await world.db.insert(schema.whatsappTemplates).values({
      id: "wtpl-sim-1",
      tenantId: TENANT_ID,
      name: "sim_broadcast",
      category: "custom",
      language: "en_US",
      bodyText: "Hello {{1}}, the Sim Weekend Sale is live! 🎉",
      approvalStatus: "approved",
      isActive: true,
    }).onConflictDoNothing();

    const { id: campaignId } = await caller.broadcast.create({
      tenantId: TENANT_ID,
      name: "Sim Weekend Sale",
      templateId: "wtpl-sim-1",
      templateName: "sim_broadcast",
    });
    assert(campaignId, "campaign created");

    // ── dryRun: counts only, nothing sent ────────────────────────────────
    // (other journeys share this world — compute expected audience from DB)
    const consentRows = await world.db.select().from(schema.consents);
    const customerRows = await world.db.select().from(schema.customers).where(eq(schema.customers.tenantId, TENANT_ID));
    const granted = new Set(consentRows.filter((c: any) => c.granted && c.tenantId === TENANT_ID).map((c: any) => c.phone));
    const expectedAudience = customerRows.filter((c: any) => c.whatsappPhone && granted.has(c.whatsappPhone)).length;

    const outboundBefore = world.outbound.all().length;
    const dry = await caller.broadcast.send({ campaignId, dryRun: true });
    assert(dry.dryRun === true, "dryRun flag");
    assert(dry.audienceCount === expectedAudience, `audience = all consented customers (got ${dry.audienceCount}, want ${expectedAudience})`);
    assert(dry.inWindowCount + dry.outOfWindowCount === dry.audienceCount, "audience partitions by window");
    assert(dry.inWindowCount >= 1, "at least one in-window recipient");
    assert(dry.outOfWindowCount >= 1, "at least one out-of-window recipient");
    assert(world.outbound.all().length === outboundBefore, "dryRun sent nothing");

    // ── real send: A gets text, B gets the template ──────────────────────
    const sent = await caller.broadcast.send({ campaignId });
    assert(sent.dryRun === false, "real send");
    assert(sent.total === expectedAudience, `recipients = consented audience (got ${sent.total})`);

    await world.waitFor(() => world.outbound.ofType("template").length > 0, 8000, "template send observed");
    const toA = world.outbound.toPhone(phoneA);
    const toB = world.outbound.toPhone(phoneB);
    const aText = toA.filter((c) => c.waType === "text");
    assert(aText.some((c) => JSON.stringify(c.body).includes("Sim Weekend Sale")), "in-window recipient got free-form text");
    const bTpl = toB.filter((c) => c.waType === "template");
    assert(bTpl.length === 1 && bTpl[0].body?.template?.name === "sim_broadcast", "out-of-window recipient got the approved template");
    assert(world.outbound.toPhone(phoneC).length === 0, "non-consented recipient never messaged");

    // ── LOW quality blocks the send ──────────────────────────────────────
    const before2 = world.outbound.all().length;
    await world.patchTenantSettings({
      waQuality: { rating: "LOW", tier: "TIER_1K", checkedAt: new Date().toISOString() },
    });
    let blocked = false;
    try {
      await caller.broadcast.send({ campaignId });
    } catch (e: any) {
      blocked = true;
      assertIncludes(String(e?.message), "LOW WhatsApp quality", "block reason mentions quality");
    }
    assert(blocked, "LOW quality rating blocked the broadcast");
    assert(world.outbound.all().length === before2, "blocked send produced no outbound calls");

    // Restore quality for later journeys.
    await world.patchTenantSettings({
      waQuality: { rating: "HIGH", tier: "TIER_10K", checkedAt: new Date().toISOString() },
    });
  },
};
