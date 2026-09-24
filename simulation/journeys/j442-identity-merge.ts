// === W47 buyer (Coder B) ===
/**
 * J442 — ONB-B-6: WA+TG identity merge. resolveIdentity /
 * findTelegramIdentityByPhone are wired into the session/order/consent
 * paths; a Telegram STOP propagates revocation to the LINKED WhatsApp
 * phone; and nlp_sessions accepts long telegram:<chat_id> keys (mig 0165
 * widening) with a unique (tenant, key) constraint (mig 0166).
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J442",
  name: "ONB-B-6 cross-channel identity merge + widened session keys",
  feature: "W47 buyer identity merge",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const ci = await import("../../server/services/channelIdentity");
    await ensureTelegramConfig(world);

    // 1. Bind a Telegram chat to a phone; resolveIdentity surfaces the link.
    const phone = world.newPhone("442");
    const chatId = "77442001";
    await ci.bindTelegramPhone(world.db, {
      tenantId: TENANT_ID, chatId, phoneE164: phone, username: "tg442", linkedVia: "telegram_contact_share",
    });
    const resolved = await ci.resolveIdentity(world.db, TENANT_ID, "telegram", chatId);
    assert(resolved.phoneE164 === phone, "resolveIdentity returns the linked phone");
    const byPhone = await ci.findTelegramIdentityByPhone(world.db, TENANT_ID, phone);
    assert(byPhone?.sessionKey === `telegram:${chatId}`, "findTelegramIdentityByPhone round-trips");

    // 2. nlp.ts wires resolveIdentity into the order/cancel path (buyerKey).
    const { readFile } = await import("node:fs/promises");
    const nlp = await readFile(new URL("../../server/routers/nlp.ts", import.meta.url), "utf8");
    assertIncludes(nlp, "resolveIdentity", "nlp resolves channel identity");
    assertIncludes(nlp, "waPhoneNumber: buyerKey", "orders/attestations keyed by canonical buyer identity");

    // 3. Widened column: a 13-digit signed chat id key (22+ chars) inserts fine.
    const longKey = "telegram:-1001234567890123"; // 26 chars — overflowed the old width
    await world.db.insert(schema.nlpSessions).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, waPhoneNumber: longKey,
      customerName: "Tg Long", language: "english", state: "greeting",
      context: {}, messageHistory: [], lastActivityAt: new Date(), createdAt: new Date(),
    });
    const [sess] = await world.db.select().from(schema.nlpSessions)
      .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, longKey)));
    assert(sess?.waPhoneNumber === longKey, "long telegram session key persisted (ONB-B-6 widening)");
    // Unique constraint (ONB-B-10): a duplicate insert conflicts.
    let dupFailed = false;
    try {
      await world.db.insert(schema.nlpSessions).values({
        id: crypto.randomUUID(), tenantId: TENANT_ID, waPhoneNumber: longKey,
        language: "english", state: "greeting", context: {}, messageHistory: [],
        lastActivityAt: new Date(), createdAt: new Date(),
      });
    } catch {
      dupFailed = true;
    }
    assert(dupFailed, "duplicate (tenant, phone) session rejected by unique index");

    // 4. Consent merge: TG STOP propagates revocation to the linked WA phone.
    await world.grantConsent(phone);
    const { recordChannelOptIn } = await import("../../server/services/consent");
    await recordChannelOptIn(world.db, { tenantId: TENANT_ID, sessionKey: `telegram:${chatId}`, channel: "telegram" });
    await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: 88442999,
      message: {
        message_id: 992, from: { id: 44201, first_name: "Tg" }, chat: { id: Number(chatId), type: "private" },
        date: 1788000000, text: "STOP",
      },
    });
    await world.settle();
    const [waRow] = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, phone), eq(schema.consents.channel, "whatsapp")));
    assert(waRow?.withdrawnAt, "TG STOP revoked the linked WA consent (single buyer identity)");
  },
};
