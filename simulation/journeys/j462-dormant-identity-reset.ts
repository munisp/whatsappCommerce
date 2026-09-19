// === W47 crosscutting ===
/**
 * J462 — ONB-ID-3: recycled-number protection.
 *
 * A WhatsApp identity dormant > ONB_DORMANT_DAYS (default 90) must NOT
 * inherit the prior owner's session/cart/consent:
 *   - the dormant nlp_sessions row is wiped and a FRESH session is created;
 *   - the stale consent decision is deleted (consent prompt re-fires) and the
 *     reset is audit-logged;
 *   - a FRESH (non-dormant) identity keeps its session + consent.
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { publicCaller } from "./helpers";

export const journey: Journey = {
  id: "J462",
  name: "dormant number re-verification + consent re-prompt",
  feature: "ONB-ID-3 recycled-number protection",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await publicCaller();
    const dormantPhone = world.newPhone("dorm462");
    const freshPhone = world.newPhone("fresh462");
    const old = new Date(Date.now() - 120 * 86_400_000); // 120 days dormant
    const recent = new Date(Date.now() - 5 * 86_400_000); // 5 days — active

    const seed = async (phone: string, last: Date) => {
      const id = crypto.randomUUID();
      await world.db.insert(schema.nlpSessions).values({
        id, tenantId: TENANT_ID, waPhoneNumber: phone, state: "ordering",
        context: { cart: [{ productId: "p-jollof", qty: 2 }] },
        messageHistory: [], lastActivityAt: last, createdAt: last,
      });
      await world.db.insert(schema.consents).values({
        tenantId: TENANT_ID, phone, channel: "whatsapp", granted: true,
        grantedAt: last, source: "whatsapp_reply",
      });
      return id;
    };
    const dormantId = await seed(dormantPhone, old);
    const freshId = await seed(freshPhone, recent);

    // Dormant identity: first contact wipes and restarts.
    await caller.nlp.processMessage({ tenantId: TENANT_ID, waPhoneNumber: dormantPhone, message: "hello" });
    const dormantRows = await world.db.select().from(schema.nlpSessions)
      .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, dormantPhone)));
    assert(dormantRows.length === 1, "single session after dormant reset");
    assert(dormantRows[0].id !== dormantId, "dormant session row wiped + recreated");
    const ctx = (dormantRows[0].context ?? {}) as any;
    assert(!ctx.cart, "prior cart does NOT carry across the dormancy gap");
    const dormantConsent = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, dormantPhone)));
    assert(dormantConsent.length === 0, "stale consent deleted (prompt re-fires)");
    const audit = await world.db.select().from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "consent.dormant_identity_reset"));
    assert(audit.length >= 1, "dormant reset is audit-logged");

    // Fresh identity: untouched.
    await caller.nlp.processMessage({ tenantId: TENANT_ID, waPhoneNumber: freshPhone, message: "hello" });
    const freshRows = await world.db.select().from(schema.nlpSessions)
      .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, freshPhone)));
    assert(freshRows.length === 1 && freshRows[0].id === freshId, "active session survives");
    const freshConsent = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, freshPhone)));
    assert(freshConsent.length === 1 && freshConsent[0].granted === true, "active consent survives");
  },
};
