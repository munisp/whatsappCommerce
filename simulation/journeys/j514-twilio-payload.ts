// === W50 SMS ===
/**
 * J514 — Twilio payload shape contract.
 *
 *   POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json
 *   Basic auth base64(sid:token), form body To/From/Body.
 *   201 + sid captured; retriable 500 honored by fetchJson retry.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { meta, sms, smsBodyParams } from "../metaMock";

export const journey: Journey = {
  id: "J514",
  name: "Twilio SMS payload shape",
  feature: "W50 SMS: Twilio Messages.json contract + basic auth",
  async run(world: World) {
    const SID = "AC1234567890abcdef";
    const TOKEN = "twilio-auth-token-514";
    await world.db.execute(
      `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '${JSON.stringify({ sms: { provider: "twilio", sid: SID, token: TOKEN, from: "+15551234567" } })}'::jsonb WHERE id = '${TENANT_ID}'`,
    );
    const smsSender = await import("../../server/services/smsSender");
    const phone = world.newPhone("514");

    const res = await smsSender.sendSms(TENANT_ID, phone, "Twilio hello");
    assert(res.sent === true && res.provider === "twilio", "live Twilio send");
    assert(res.messageIds[0]?.startsWith("SM"), "Twilio message sid captured");

    assert(sms.calls.length === 1, "one provider HTTP call");
    const call = sms.calls[0];
    assert(call.method === "POST", "POST method");
    assert(
      call.url === `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`,
      `Twilio Messages.json URL (got ${call.url})`,
    );
    const expectedAuth = `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`;
    assert(call.authToken === expectedAuth, "basic auth carries sid:token (base64)");
    const params = smsBodyParams(call);
    assert(params.To === phone, "To form field");
    assert(params.From === "+15551234567", "From form field");
    assert(params.Body === "Twilio hello", "Body form field");

    // ── Retriable 500 → fetchJson retries then succeeds on clear ───────
    meta.hostStatus.set("api.twilio.com", 500);
    let threw = false;
    try {
      await smsSender.sendSms(TENANT_ID, phone, "will fail", { maxParts: 1 });
    } catch {
      threw = true;
    }
    assert(threw, "persistent 500 throws after bounded retries");
    assert(sms.calls.length >= 3, "fetchJson retried the retriable 500 (1 initial + 2 retries)");
    meta.hostStatus.delete("api.twilio.com");
    const ok = await smsSender.sendSms(TENANT_ID, phone, "recovered");
    assert(ok.sent === true, "send succeeds once the outage clears");
  },
};
