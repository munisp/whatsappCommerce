/**
 * === W40 MSG-2 ===
 * J283 — message_template_status_update REJECTED webhook.
 *
 * Through the REAL /api/webhooks/whatsapp handler:
 *   1. A REJECTED event for the tenant's template flips the local
 *      whatsapp_templates row to approvalStatus='rejected' (with the Meta
 *      reason) and alerts the tenant admin over WhatsApp — a dead template
 *      is never silent.
 *   2. A campaign referencing the now-dead template is BLOCKED honestly
 *      (PRECONDITION_FAILED, campaign marked failed, admin alerted) instead
 *      of blasting into per-recipient failures.
 */
import { and, eq } from "drizzle-orm";
import { ADMIN_PHONE, TENANT_ID, WABA_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

const TPL_ID = "wtpl-j283-1";
const TPL_NAME = "j283_promo";

export const journey: Journey = {
  id: "J283",
  name: "template REJECTED webhook disables template + blocks campaign (MSG-2)",
  feature: "message_template_status_update handling + dead-template send gate",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();

    // Seed: an APPROVED local template + a consented customer audience.
    await world.db.insert(schema.whatsappTemplates).values({
      id: TPL_ID,
      tenantId: TENANT_ID,
      name: TPL_NAME,
      category: "custom",
      language: "en_US",
      bodyText: "Hello {{1}}, promo!",
      approvalStatus: "approved",
      isActive: true,
    }).onConflictDoNothing();
    const phone = world.newPhone("t");
    await world.db.insert(schema.customers).values({
      id: `cust-${phone}`, tenantId: TENANT_ID, whatsappPhone: phone, name: "Tpl Target",
    }).onConflictDoNothing();
    await world.grantConsent(phone);

    // ── 1. REJECTED webhook updates the store + alerts the admin ─────────
    const adminBefore = world.outbound.toPhone(ADMIN_PHONE).length;
    await world.inbound({
      object: "whatsapp_business_account",
      entry: [{
        id: WABA_ID,
        changes: [{
          field: "message_template_status_update",
          value: {
            event: "REJECTED",
            message_template_id: 991283,
            message_template_name: TPL_NAME,
            message_template_language: "en_US",
            reason: "ABUSIVE_CONTENT",
          },
        }],
      }],
    });
    const [tpl] = await world.db.select().from(schema.whatsappTemplates)
      .where(and(eq(schema.whatsappTemplates.tenantId, TENANT_ID), eq(schema.whatsappTemplates.name, TPL_NAME)))
      .limit(1);
    assert(tpl?.approvalStatus === "rejected", `webhook must mark the template rejected, got ${tpl?.approvalStatus}`);
    assert(tpl?.rejectionReason === "ABUSIVE_CONTENT", `rejection reason persisted, got ${tpl?.rejectionReason}`);
    await world.waitFor(
      () => world.outbound.toPhone(ADMIN_PHONE).length > adminBefore, 5000, "admin template alert");
    const alert = bodyText(world.outbound.lastOfType("text", ADMIN_PHONE));
    assertIncludes(alert, TPL_NAME, "admin alert names the dead template");
    assertIncludes(alert, "REJECTED", "admin alert names the Meta event");

    // ── 2. Campaign using the dead template is blocked honestly ──────────
    const adminBeforeBlock = world.outbound.toPhone(ADMIN_PHONE).length;
    const { id: campaignId } = await caller.broadcast.create({
      tenantId: TENANT_ID,
      name: "J283 Dead Template Campaign",
      templateId: TPL_ID,
      templateName: TPL_NAME,
    });
    let blocked: any = null;
    try {
      await caller.broadcast.send({ campaignId });
    } catch (e: any) {
      blocked = e;
    }
    assert(blocked, "send with a REJECTED template must throw");
    assertIncludes(String(blocked?.message ?? blocked), "rejected", "honest dead-template error");
    const [campaign] = await world.db.select().from(schema.broadcastCampaigns)
      .where(eq(schema.broadcastCampaigns.id, campaignId)).limit(1);
    assert(campaign?.status === "failed", `blocked campaign marked failed, got ${campaign?.status}`);
    assert(campaign?.sentCount === 0, "no recipient was sent to");
    await world.waitFor(
      () => world.outbound.toPhone(ADMIN_PHONE).length > adminBeforeBlock, 5000, "admin blocked-campaign alert");
  },
};
