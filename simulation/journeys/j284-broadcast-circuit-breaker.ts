/**
 * === W40 MSG-3 ===
 * J284 — Broadcast circuit breaker: a campaign whose real sends fail above
 * the threshold (>20% after >=20 attempts) AUTO-PAUSES mid-fan-out:
 *   status → 'paused', pausedReason documents the trip, the tenant admin
 *   gets a WhatsApp alert, and the remaining recipients are never attempted.
 */
import { eq } from "drizzle-orm";
import { ADMIN_PHONE, TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";
import { failNextSends } from "../metaMock";

export const journey: Journey = {
  id: "J284",
  name: "failing campaign auto-pauses + alerts (MSG-3)",
  feature: "broadcast circuit breaker (>20% failures after >=20 sends)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();

    // Quiet hours off so the send is wall-clock independent (J20 pattern).
    const origSettings = await world.tenantSettings();
    await world.patchTenantSettings({ marketingFrequency: { quietStart: "00:00", quietEnd: "00:00" } });

    try {
      // Audience: 30 consented customers, all OUTSIDE the 24h window → the
      // out-of-window template path (sendWhatsAppTemplate → /messages POST).
      const phones: string[] = [];
      for (let i = 0; i < 30; i++) {
        const phone = world.newPhone("c");
        phones.push(phone);
        await world.db.insert(schema.customers).values({
          id: `cust-${phone}`, tenantId: TENANT_ID, whatsappPhone: phone, name: `Breaker ${i}`,
        }).onConflictDoNothing();
        await world.grantConsent(phone);
      }
      await world.db.insert(schema.whatsappTemplates).values({
        id: "wtpl-j284-1",
        tenantId: TENANT_ID,
        name: "j284_broadcast",
        category: "custom",
        language: "en_US",
        bodyText: "Hello {{1}}, breaker test",
        approvalStatus: "approved",
        isActive: true,
      }).onConflictDoNothing();

      // Meta fails every send (Graph 500 storm).
      failNextSends(500, 30);

      const adminBefore = world.outbound.toPhone(ADMIN_PHONE).length;
      const { id: campaignId } = await caller.broadcast.create({
        tenantId: TENANT_ID,
        name: "J284 Breaker Campaign",
        templateId: "wtpl-j284-1",
        templateName: "j284_broadcast",
      });
      const result = await caller.broadcast.send({ campaignId });

      // ── Breaker tripped after the first 25-attempt chunk ──────────────
      assert((result as any).paused === true, `send result must report paused, got ${JSON.stringify(result)}`);
      assertIncludes(String((result as any).pausedReason ?? ""), "circuit_breaker", "pausedReason explains the trip");
      assert(result.failed === 25, `25 attempts failed before the trip, got ${result.failed}`);
      assert(result.sent === 0, "no successful sends in a full failure storm");

      const [campaign] = await world.db.select().from(schema.broadcastCampaigns)
        .where(eq(schema.broadcastCampaigns.id, campaignId)).limit(1);
      assert(campaign?.status === "paused", `campaign auto-paused, got ${campaign?.status}`);
      assertIncludes(campaign?.pausedReason ?? "", "circuit_breaker", "pausedReason persisted");
      assert(campaign?.pausedAt, "pausedAt stamped");

      // Remaining 5 recipients were never attempted (breaker stopped fan-out).
      const attempted = await world.db.select().from(schema.broadcastRecipients)
        .where(eq(schema.broadcastRecipients.campaignId, campaignId));
      assert(attempted.length === 25, `only the first chunk attempted, got ${attempted.length} recipient rows`);

      // Admin WhatsApp alert fired.
      await world.waitFor(
        () => world.outbound.toPhone(ADMIN_PHONE).length > adminBefore, 5000, "breaker admin alert");
      const alert = bodyText(world.outbound.lastOfType("text", ADMIN_PHONE));
      assertIncludes(alert, "AUTO-PAUSED", "admin alert names the auto-pause");
      assertIncludes(alert, "J284 Breaker Campaign", "admin alert names the campaign");
    } finally {
      await world.patchTenantSettings({ marketingFrequency: (origSettings as any)?.marketingFrequency ?? {} });
    }
  },
};
