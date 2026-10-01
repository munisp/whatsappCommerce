// === W50 SMS ===
/**
 * J511 — SMS consent denial (first-contact NO).
 *
 * Mirrors the WA J1 / TG consent contract on the sms channel:
 *   1. First-contact "NO" records granted=false WITHOUT withdrawnAt
 *      (limited service, not a revocation) and answers with the denial copy.
 *   2. The denial reply goes out over SMS with SMS channel wording.
 *   3. An existing denial row does NOT re-prompt: the next message proceeds
 *      into the NLP conversation (denial blocks proactive sends only).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { sms, smsBodyParams } from "../metaMock";

export const journey: Journey = {
  id: "J511",
  name: "SMS consent denial: first-contact NO recorded, conversation proceeds",
  feature: "W50 SMS: consent gate on the sms channel identity",
  async run(world: World) {
    await world.db.execute(
      `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '{"sms":{"provider":"africa_talking","username":"sandbox","apiKey":"at-key-511","senderId":"SIMSHOP"}}'::jsonb WHERE id = '${TENANT_ID}'`,
    );
    const { appRouter } = await import("../../server/routers");
    const caller = appRouter.createCaller({ user: null } as any);
    const { getConsent } = await import("../../server/services/consent");
    const { sessionKeyFor } = await import("../../server/services/channelIdentity");
    const phone = world.newPhone("511");
    const sessionKey = sessionKeyFor("sms", phone);

    // ── 1+2. First-contact NO → denial recorded, denial copy over SMS ──
    const r1 = await caller.channels.processSms({ from: phone, to: "40404", body: "NO", tenantId: TENANT_ID });
    assert(r1.status === "replied" && r1.intent === "consent", "NO answered by the consent flow");
    const row = await getConsent(world.db, TENANT_ID, sessionKey, "sms");
    assert(row && row.granted === false, "denial recorded (granted=false)");
    assert(!row.withdrawnAt, "first-contact NO is NOT a revocation (no withdrawnAt)");
    const denialCall = sms.calls[sms.calls.length - 1];
    const denialBody = smsBodyParams(denialCall);
    assert(denialBody.to === phone, "denial reply addressed to sender");
    assert(!denialBody.message?.includes("WhatsApp"), "denial copy channel-swapped (no WhatsApp wording)");

    // ── 3. Existing denial row → conversation proceeds (no re-prompt) ──
    world.llm.when("do you deliver", {
      reply: "Yes, we deliver within Lagos.",
      intent: "faq",
      nextState: "idle",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.9,
    });
    const before = sms.calls.length;
    const r2 = await caller.channels.processSms({ from: phone, to: "40404", body: "do you deliver", tenantId: TENANT_ID });
    assert(r2.status === "replied", "post-denial message still gets an NLP reply (limited service)");
    assert(r2.intent !== "consent", "consent gate does not re-prompt on an existing row");
    const replyBody = smsBodyParams(sms.calls[sms.calls.length - 1]);
    assert((replyBody.message ?? "").toLowerCase().includes("deliver"), `NLP reply delivered, not a consent prompt (got: ${replyBody.message})`);
    assert(sms.calls.length === before + 1, "exactly one reply SMS for the post-denial message");
  },
};
