// === W50 SMS ===
/**
 * J513 — Africa's Talking payload shape contract.
 *
 *   POST https://api.africastalking.com/version1/messaging
 *   headers: apiKey (tenant secret, decrypted), form body username/to/message/from.
 *   201 + SMSMessageData.Recipients[0].messageId captured; send logged
 *   (channel_messages outbound, status sent).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { sms, smsBodyParams } from "../metaMock";

export const journey: Journey = {
  id: "J513",
  name: "Africa's Talking SMS payload shape",
  feature: "W50 SMS: AT messaging endpoint contract + credential decryption",
  async run(world: World) {
    const { encryptSecret } = await import("../../server/services/crypto/secrets");
    const KEY = "at-live-key-513";
    await world.db.execute(
      `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '${JSON.stringify({ sms: { provider: "africa_talking", username: "liveuser", apiKey: encryptSecret(KEY), senderId: "SIMSHOP" } })}'::jsonb WHERE id = '${TENANT_ID}'`,
    );
    const smsSender = await import("../../server/services/smsSender");
    const phone = world.newPhone("513");

    const res = await smsSender.sendSms(TENANT_ID, phone, "Your order is ready.");
    assert(res.sent === true && res.simulated === false, "live AT send");
    assert(res.provider === "africa_talking", "provider tagged africa_talking");
    assert(res.messageIds.length === 1 && res.messageIds[0].startsWith("atx."), "AT messageId captured");

    assert(sms.calls.length === 1, "one provider HTTP call");
    const call = sms.calls[0];
    assert(call.method === "POST", "POST method");
    assert(call.url === "https://api.africastalking.com/version1/messaging", `AT messaging URL (got ${call.url})`);
    assert(call.headers["apikey"] === KEY, "decrypted apiKey header on the wire");
    assert(String(call.headers["content-type"]).includes("x-www-form-urlencoded"), "form-encoded body");
    const params = smsBodyParams(call);
    assert(params.username === "liveuser", "username form field");
    assert(params.to === phone, "to form field");
    assert(params.message === "Your order is ready.", "message form field");
    assert(params.from === "SIMSHOP", "senderId → from form field");

    const schema = await import("../../drizzle/schema");
    const { and, desc, eq } = await import("drizzle-orm");
    const rows: Array<{ metadata: any }> = await world.db
      .select({ metadata: schema.channelMessages.metadata })
      .from(schema.channelMessages)
      .where(and(
        eq(schema.channelMessages.tenantId, TENANT_ID),
        eq(schema.channelMessages.channel, "sms"),
        eq(schema.channelMessages.direction, "outbound"),
      ))
      .orderBy(desc(schema.channelMessages.createdAt))
      .limit(1);
    const meta0 = rows[0]?.metadata ?? {};
    assert(meta0.status === "sent" && meta0.provider === "africa_talking" && String(meta0.externalId ?? "").startsWith("atx."), "outbound row logged (sent/provider/externalId)");
  },
};
