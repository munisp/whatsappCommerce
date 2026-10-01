// === W55 parity (PARITY-3) ===
/**
 * J562 — TG permanent failure → SMS failover (channelParity seam, analogous
 * to waSender.maybeFailoverToSms):
 *   1. Flag OFF: permanent TG failure (403 bot blocked) → no SMS.
 *   2. Flag ON: transactional category (order_status) → SMS to the linked
 *      E.164 phone, content-hash failoverKey recorded; replay deduped.
 *   3. Marketing category (broadcast) NEVER fails over.
 *   4. Retriable TG failure (500) → no failover.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { meta, sms, smsBodyParams } from "../metaMock";
import { ensureTelegramConfig } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J562",
  name: "TG permanent failure → SMS failover (transactional only)",
  feature: "W55 parity: TG→SMS failover in channelParity (PARITY-3)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const parity = await import("../../server/services/channelParity");
    await ensureTelegramConfig(world);
    // Tenant SMS credentials so sends hit the scripted provider mock.
    await world.db.execute(
      `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '{"sms":{"provider":"africa_talking","username":"sandbox","apiKey":"at-key-562","senderId":"SIMSHOP"}}'::jsonb WHERE id = '${TENANT_ID}'`,
    );

    const chatId = "95562001";
    const phone = world.newPhone("562");
    await world.db.insert(schema.telegramIdentities).values({
      tenantId: TENANT_ID, chatId, phoneE164: phone, linkedVia: "j562_seed",
    }).onConflictDoNothing();
    const ref = { channel: "telegram", channelScopedId: chatId };
    const smsBefore = sms.calls.length;

    try {
      // ── 1. Flag OFF → permanent TG failure, no SMS ────────────────────
      await world.db.execute(`UPDATE tenants SET "smsFailoverEnabled" = false WHERE id = '${TENANT_ID}'`);
      meta.hostStatus.set("api.telegram.org", 403); // bot blocked = permanent
      const off = await parity.notifyCustomer(TENANT_ID, ref as any, "order_status",
        { text: "Your order 562-OFF is on the way.", notifType: "order_status" });
      assert(off.handled === true && off.sent === false, "TG failure stays fail-open (handled:true, sent:false)");
      assert(sms.calls.length === smsBefore, "no SMS failover while the flag is off");

      // ── 2. Flag ON → SMS failover for order_status ────────────────────
      await world.db.execute(`UPDATE tenants SET "smsFailoverEnabled" = true WHERE id = '${TENANT_ID}'`);
      const on = await parity.notifyCustomer(TENANT_ID, ref as any, "order_status",
        { text: "Your order 562-ON is out for delivery.", notifType: "order_status" });
      assert(on.handled === true && on.sent === false, "TG send still reports the failure honestly");
      assert(sms.calls.length === smsBefore + 1, "permanent TG failure fell back to SMS");
      const params = smsBodyParams(sms.calls[sms.calls.length - 1]);
      assert(params.to === phone, "SMS failover targets the identity's linked phone");
      assert((params.message ?? "").includes("562-ON"), "SMS carries the transactional body");

      // Idempotent: same logical message replays without a second provider call.
      const mid = sms.calls.length;
      await parity.notifyCustomer(TENANT_ID, ref as any, "order_status",
        { text: "Your order 562-ON is out for delivery.", notifType: "order_status" });
      assert(sms.calls.length === mid, "replayed failover deduped by content-hash key");

      // ── 3. Marketing category NEVER fails over ────────────────────────
      await parity.notifyCustomer(TENANT_ID, ref as any, "broadcast",
        { text: "PROMO: big sale this weekend!", notifType: "broadcast" });
      assert(sms.calls.length === mid, "broadcast (marketing) never fails over to SMS");

      // ── 4. Retriable failure (500) → no failover ──────────────────────
      meta.hostStatus.set("api.telegram.org", 500);
      await parity.notifyCustomer(TENANT_ID, ref as any, "payment_receipt",
        { text: "Payment received for order 562-R.", notifType: "payment_receipt" });
      assert(sms.calls.length === mid, "retriable (5xx) TG failure never fails over");
    } finally {
      meta.hostStatus.delete("api.telegram.org");
      await world.db.execute(`UPDATE tenants SET "smsFailoverEnabled" = false WHERE id = '${TENANT_ID}'`);
    }
  },
};
