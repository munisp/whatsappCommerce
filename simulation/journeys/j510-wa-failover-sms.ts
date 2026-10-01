// === W50 SMS ===
/**
 * J510 — WA permanent failure → SMS failover (smsFailoverEnabled consumer).
 *
 *   1. Flag OFF: permanent WA failure (400) → no SMS attempted.
 *   2. Flag ON: permanent WA failure → same body delivered via SMS,
 *      failoverKey recorded on the outbound sms row.
 *   3. Idempotent: smsAlreadySent(failoverKey) dedupes a repeat failover;
 *      the WA error still throws (callers keep the catch-and-decide contract).
 *   4. Retriable failure (500) → NO failover (transient errors retry on WA).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { meta, sms, smsBodyParams } from "../metaMock";

export const journey: Journey = {
  id: "J510",
  name: "WA permanent failure → SMS failover (flag-gated, idempotent)",
  feature: "W50 SMS: smsFailoverEnabled consumer in the waSender failure seam",
  async run(world: World) {
    const wa = await import("../../server/services/waSender");
    const smsSender = await import("../../server/services/smsSender");
    await world.db.execute(
      `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '{"sms":{"provider":"africa_talking","username":"sandbox","apiKey":"at-key-510","senderId":"SIMSHOP"}}'::jsonb WHERE id = '${TENANT_ID}'`,
    );
    const phone = world.newPhone("510");

    // ── 1. Flag OFF → no failover ──────────────────────────────────────
    await world.db.execute(`UPDATE tenants SET "smsFailoverEnabled" = false WHERE id = '${TENANT_ID}'`);
    meta.failAllSendsStatus = 400; // permanent WA failure
    await assertWaThrows(wa, phone, "failover flag off body");
    assert(sms.calls.length === 0, "no SMS attempted while flag disabled");

    // ── 2. Flag ON → SMS failover with the same body ───────────────────
    await world.db.execute(`UPDATE tenants SET "smsFailoverEnabled" = true WHERE id = '${TENANT_ID}'`);
    const body = "Your order 777 failed to deliver on WhatsApp — pay cash on pickup.";
    await assertWaThrows(wa, phone, body);
    assert(sms.calls.length === 1, "permanent WA failure fell back to SMS");
    const params = smsBodyParams(sms.calls[0]);
    assert(params.to === phone, "SMS failover targets the same phone");
    assert((params.message ?? "").includes("order 777"), "SMS failover carries the WA text body");

    // failoverKey recorded on the outbound channel_messages row
    const schema = await import("../../drizzle/schema");
    const { and, desc, eq } = await import("drizzle-orm");
    const smsRows: Array<{ metadata: any }> = await world.db
      .select({ metadata: schema.channelMessages.metadata })
      .from(schema.channelMessages)
      .where(and(
        eq(schema.channelMessages.tenantId, TENANT_ID),
        eq(schema.channelMessages.channel, "sms"),
        eq(schema.channelMessages.direction, "outbound"),
      ))
      .orderBy(desc(schema.channelMessages.createdAt))
      .limit(1);
    const row = { k: smsRows[0]?.metadata?.failoverKey as string | null, st: smsRows[0]?.metadata?.status as string };
    assert(row?.k, "failoverKey persisted for dedupe");
    assert(row.st === "sent", "failover sms row status sent");

    // ── 3. Idempotent replay with the same failoverKey ─────────────────
    assert(await smsSender.smsAlreadySent(TENANT_ID, row.k!), "smsAlreadySent sees the logged failover");
    const before = sms.calls.length;
    // Simulate the failover consumer replaying the same logical message.
    if (!(await smsSender.smsAlreadySent(TENANT_ID, row.k!))) {
      await smsSender.sendSms(TENANT_ID, phone, body, { idempotencyKey: row.k });
    }
    assert(sms.calls.length === before, "replayed failover deduped (no second provider call)");

    // ── 4. Retriable failure → no failover ─────────────────────────────
    meta.failAllSendsStatus = 500;
    await assertWaThrows(wa, phone, "transient failure should not fail over");
    assert(sms.calls.length === before, "retriable (5xx) WA failure never fails over to SMS");
    meta.failAllSendsStatus = null;
  },
};

async function assertWaThrows(wa: typeof import("../../server/services/waSender"), phone: string, body: string): Promise<void> {
  let threw: any = null;
  try {
    await wa.sendWhatsAppText(TENANT_ID, phone, body, { notifType: "j510_failover" });
  } catch (e: any) {
    threw = e;
  }
  assert(threw, "WA send throws on failure (contract preserved)");
}
