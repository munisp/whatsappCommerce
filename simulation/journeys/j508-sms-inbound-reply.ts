// === W50 SMS ===
/**
 * J508 — SMS inbound → consent → nlp.processMessage → SMS reply loop.
 *
 *   1. First-contact SMS gets the consent prompt (over SMS, channel-swapped
 *      copy); "YES" records channel opt-in for session key sms:<phone>.
 *   2. A normal message goes through nlp.processMessage (channel "sms") and
 *      the reply is delivered via Africa's Talking (provider call recorded).
 *   3. channel_messages carries both the inbound and the outbound rows.
 */
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { sms, smsBodyParams } from "../metaMock";

async function setSmsSettings(world: World, cfg: Record<string, unknown>) {
  await world.db.execute(
    `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '${JSON.stringify({ sms: cfg })}'::jsonb WHERE id = '${TENANT_ID}'`,
  );
}

async function smsCaller() {
  const { appRouter } = await import("../../server/routers");
  return appRouter.createCaller({ user: null } as any);
}

export const journey: Journey = {
  id: "J508",
  name: "SMS inbound → reply loop via nlp.processMessage",
  feature: "W50 SMS: channels.processSms consent gate + NLP dispatch + smsSender reply",
  async run(world: World) {
    await setSmsSettings(world, { provider: "africa_talking", username: "sandbox", apiKey: "at-key-508", senderId: "SIMSHOP" });
    const caller = await smsCaller();
    const phone = world.newPhone("508");

    // ── 1. First contact → consent prompt over SMS ─────────────────────
    const r1 = await caller.channels.processSms({ from: phone, to: "40404", body: "hello there", tenantId: TENANT_ID });
    assert(r1.status === "replied" && r1.replied === true, "first contact answered (consent prompt)");
    assert(r1.intent === "consent", `consent intent tag (got ${r1.intent})`);
    let atCalls = sms.calls.filter((c) => c.url.includes("api.africastalking.com"));
    assert(atCalls.length >= 1, "consent prompt sent via Africa's Talking");
    // The prompt may be segmented into concatenated SMS parts — reassemble.
    const promptText = atCalls.map((c) => smsBodyParams(c).message ?? "").join(" ");
    assert(atCalls[0] && smsBodyParams(atCalls[0]).to === phone, "prompt addressed to the sender");
    assert(promptText.includes("YES"), "consent prompt asks for YES/NO");
    assert(promptText.includes("SMS"), "channel-generic consent copy swapped WhatsApp→SMS");
    assert(!promptText.includes("WhatsApp"), "no WhatsApp wording leaks onto SMS");

    // ── 2. YES → opt-in recorded + granted reply ───────────────────────
    const r2 = await caller.channels.processSms({ from: phone, to: "40404", body: "YES", tenantId: TENANT_ID });
    assert(r2.status === "replied", "YES answered");
    const { getConsent } = await import("../../server/services/consent");
    const { sessionKeyFor } = await import("../../server/services/channelIdentity");
    const consentRow = await getConsent(world.db, TENANT_ID, sessionKeyFor("sms", phone), "sms");
    assert(consentRow?.granted === true && !consentRow.withdrawnAt, "sms channel opt-in recorded");

    // ── 3. Normal message → nlp.processMessage → SMS reply ─────────────
    world.llm.when("what are your prices", {
      reply: "Our prices start at NGN 500. Reply MENU to browse.",
      intent: "product_inquiry",
      nextState: "idle",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.9,
    });
    const before = sms.calls.length;
    const r3 = await caller.channels.processSms({ from: phone, to: "40404", body: "what are your prices", tenantId: TENANT_ID });
    assert(r3.status === "replied" && r3.replied === true, `NLP reply sent (got ${r3.status})`);
    assert(sms.calls.length > before, "provider call(s) for the reply");
    const replyText = sms.calls.slice(before).map((c) => smsBodyParams(c).message ?? "").join(" ");
    assert(replyText.length > 5, `NLP reply body delivered over SMS (got: ${replyText.slice(0, 80)})`);
    assert(!replyText.includes("Reply YES"), "reply is conversational, not a consent prompt");

    // ── 4. channel_messages: inbound + outbound rows ───────────────────
    const schema = await import("../../drizzle/schema");
    const { and, eq, or } = await import("drizzle-orm");
    const list: Array<{ direction: string }> = await world.db
      .select({ direction: schema.channelMessages.direction })
      .from(schema.channelMessages)
      .where(and(
        eq(schema.channelMessages.tenantId, TENANT_ID),
        eq(schema.channelMessages.channel, "sms"),
        or(eq(schema.channelMessages.fromAddress, phone), eq(schema.channelMessages.toAddress, phone)),
      ));
    assert(list.filter((r) => r.direction === "inbound").length >= 3, "3 inbound sms rows logged");
    assert(list.filter((r) => r.direction === "outbound").length >= 3, "outbound sms rows logged (prompt+granted+reply)");
  },
};
