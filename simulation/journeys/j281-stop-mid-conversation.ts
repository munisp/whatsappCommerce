/**
 * === W40 MSG-1 ===
 * J281 — STOP is honored MID-CONVERSATION on WhatsApp.
 *
 * Through the REAL /api/webhooks/whatsapp pipeline:
 *   1. A consented, actively-chatting user sends "STOP" → consent is
 *      revoked (granted=false + withdrawn_at stamped) BEFORE any reply
 *      generation, a consent.withdrawn audit row exists, and exactly one
 *      suppressed-reply confirmation goes out (Meta policy).
 *   2. Every subsequent inbound ("hello", "menu", "2") is blocked — the
 *      bot sends NOTHING further to that phone.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J281",
  name: "STOP honored mid-conversation (MSG-1)",
  feature: "always-on opt-out interceptor: revoke + one confirmation + silence thereafter",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("s");

    // Opt in and start an actual conversation (menu reply proves mid-conversation).
    await world.text(phone, "hello there");
    await world.text(phone, "YES");
    const [granted] = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, phone))).limit(1);
    assert(granted?.granted === true, "setup: consented");
    await world.text(phone, "menu");
    assert(world.outbound.toPhone(phone).length >= 2, "setup: bot actively replying mid-conversation");

    // ── 1. STOP mid-conversation → revocation + single confirmation ──────
    await world.text(phone, "STOP");
    const [revoked] = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, phone))).limit(1);
    assert(revoked?.granted === false, `STOP must revoke consent, got granted=${revoked?.granted}`);
    assert(revoked?.withdrawnAt, "STOP must stamp withdrawnAt (explicit withdrawal)");
    const confirm = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(confirm, "unsubscribed", "suppressed-reply confirmation");
    assertIncludes(confirm, "YES", "confirmation documents the resubscribe path");

    // TEN-16 adjacency: the withdrawal leaves an audit evidence row.
    const auditRows = await world.db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.tenantId, TENANT_ID), eq(schema.auditLogs.action, "consent.withdrawn")));
    assert(auditRows.some((r) => r.entityId?.includes(phone)), "consent.withdrawn audit row for this phone");

    // ── 2. All subsequent inbound blocked — bot silent ───────────────────
    for (const text of ["hello again", "menu", "2", "no"]) {
      const before = world.outbound.toPhone(phone).length;
      await world.text(phone, text);
      assert(
        world.outbound.toPhone(phone).length === before,
        `revoked identity must get NO reply to "${text}" (bot silent)`,
      );
    }
  },
};
