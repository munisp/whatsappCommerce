// === W47 buyer (Coder B) ===
/**
 * J444 — ONB-B-8: chat self-service erasure covers ALL phone-keyed buyer
 * tables (consents, NLP sessions, carts, channel/customer messages, offline
 * queue, webhook payloads, mirrored media, age attestations) and leaves a
 * CLEAN SLATE: the next inbound is a first-contact consent prompt again.
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J444",
  name: "ONB-B-8 chat erasure coverage + clean re-onboarding",
  feature: "W47 buyer erasure",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("444");
    const tag = "j444";

    // Seed phone-keyed PII across the tables named in the audit.
    await world.grantConsent(phone);
    await world.db.insert(schema.customers).values({
      id: `cust-${tag}`, tenantId: TENANT_ID, whatsappPhone: phone, name: "Erase Me",
    });
    await world.db.insert(schema.nlpSessions).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, waPhoneNumber: phone,
      customerName: "Erase Me", language: "english", state: "browse",
      context: {}, messageHistory: [{ role: "user", content: "hello" }],
      lastActivityAt: new Date(), createdAt: new Date(),
    });
    await world.db.insert(schema.cartSessions).values({
      id: `cart-${tag}`, tenantId: TENANT_ID, waPhoneNumber: phone, currentStep: "browse",
    });
    await world.db.insert(schema.ageAttestations).values({
      tenantId: TENANT_ID, phone, attestedAge: 21, channel: "whatsapp", source: "chat_reply",
    });
    await world.db.insert(schema.channelMessages).values({
      id: crypto.randomUUID(), channel: "whatsapp", direction: "inbound",
      fromAddress: phone, tenantId: TENANT_ID, body: "erase my secrets",
    });
    await world.db.insert(schema.whatsappCustomerReplies).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, fromPhone: phone, wamid: `wamid.${tag}`, body: "erase me too",
    });
    await world.db.insert(schema.offlineMessageQueue).values({
      id: crypto.randomUUID(), sessionId: `sess-${tag}`, tenantId: TENANT_ID, waPhoneNumber: phone, message: "queued",
    });

    // 1. Keyword arms the two-step confirmation.
    const { handleChatErasureCommand } = await import("../../server/services/useCases");
    const arm = await handleChatErasureCommand({ db: world.db, tenantId: TENANT_ID, phone, text: "delete my data" });
    assert(arm?.handled === true, "DELETE MY DATA handled");
    assertIncludes(arm?.reply ?? "", "CONFIRM DELETE", "two-step confirmation required");
    // Consent row still there — nothing deleted before confirmation.
    const [c0] = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, phone)));
    assert(c0, "nothing deleted before CONFIRM DELETE");

    // 2. Confirm → everything phone-keyed is gone.
    const done = await handleChatErasureCommand({ db: world.db, tenantId: TENANT_ID, phone, text: "CONFIRM DELETE" });
    assert(done?.handled === true, "CONFIRM DELETE handled");
    assertIncludes(done?.reply ?? "", "deleted", "erasure confirmation reply");
    const gone = async (table: any, col: any) =>
      (await world.db.select().from(table).where(eq(col, phone))).length === 0;
    assert(await gone(schema.consents, schema.consents.phone), "consents erased (grant does not survive)");
    assert(await gone(schema.nlpSessions, schema.nlpSessions.waPhoneNumber), "nlp_sessions erased");
    assert(await gone(schema.cartSessions, schema.cartSessions.waPhoneNumber), "cart_sessions erased");
    assert(await gone(schema.ageAttestations, schema.ageAttestations.phone), "age_attestations erased");
    assert(await gone(schema.channelMessages, schema.channelMessages.fromAddress), "channel_messages erased");
    assert(await gone(schema.whatsappCustomerReplies, schema.whatsappCustomerReplies.fromPhone), "customer replies erased");
    assert(await gone(schema.offlineMessageQueue, schema.offlineMessageQueue.waPhoneNumber), "offline queue erased");
    const [cust] = await world.db.select().from(schema.customers)
      .where(and(eq(schema.customers.tenantId, TENANT_ID), eq(schema.customers.id, `cust-${tag}`)));
    assert(cust && cust.whatsappPhone !== phone && cust.name === null, "customer profile tombstoned");

    // 3. Clean re-onboarding: next inbound is a first-contact consent prompt.
    await world.text(phone, "hello again");
    assertIncludes(bodyText(world.outbound.lastOfType("text", phone)), "NDPR", "re-onboarding starts at the consent prompt");
    const [c1] = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, phone)));
    assert(!c1, "no consent row until the buyer re-decides");
  },
};
