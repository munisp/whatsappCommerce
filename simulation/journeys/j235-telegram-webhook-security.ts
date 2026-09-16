/**
 * === W37 telegram (Coder B) ===
 * J235 — POST /api/webhooks/telegram/:tenantId security + ack + dedupe.
 *
 *  1. Fail-closed secret validation: missing/wrong
 *     X-Telegram-Bot-Api-Secret-Token → 401; unknown tenant → 404; tenant
 *     with telegram disabled → 404 (no config oracle).
 *  2. Valid update → immediate 200 ack, processing happens after the ack
 *     (Bot API sendMessage recorded post-response).
 *  3. Dedupe namespace: the claim lands in processed_webhook_events as
 *     `tg:<update_id>` and a re-delivery is acked as duplicate without
 *     reprocessing.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const TG_TOKEN = "123456789:simtelegrambottokenabcdefgh0123456789";
export const TG_SECRET = "sim-telegram-webhook-secret-0123456789";

export async function ensureTelegramConfig(world: World, enabled = true): Promise<void> {
  // === W37 merger === Coder A's journeys delete TELEGRAM_ENABLED on cleanup,
  // so each B journey (re)enables it explicitly instead of relying on the
  // world boot env (order-dependent leakage under the full suite).
  process.env.TELEGRAM_ENABLED = "true";
  process.env.TELEGRAM_MEDIA_ENABLED = "true";
  // === END W37 merger ===
  const { encryptSecret } = await import("../../server/services/crypto/secrets");
  await world.patchTenantSettings({
    telegram: {
      enabled,
      botUsername: "simstore_bot",
      botToken: encryptSecret(TG_TOKEN),
      webhookSecret: encryptSecret(TG_SECRET),
    },
  });
}

export async function tgPost(
  world: World,
  tenantId: string,
  secret: string | null,
  update: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${world.baseUrl}/api/webhooks/telegram/${tenantId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret !== null ? { "x-telegram-bot-api-secret-token": secret } : {}),
    },
    body: JSON.stringify(update),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

export function tgTextUpdate(updateId: number, chatId: string, fromId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from: { id: fromId, first_name: "Tg", last_name: "User", username: `tguser${fromId}` },
      chat: { id: Number(chatId), type: "private" },
      date: 1788000000,
      text,
    },
  };
}

export const journey: Journey = {
  id: "J235",
  name: "telegram webhook: fail-closed secret + ack-then-process + tg:<update_id> dedupe",
  feature: "W37 telegram inbound webhook",
  async run(world: World) {
    const { tg } = await import("../metaMock");
    await ensureTelegramConfig(world);

    // 1. Fail-closed validation.
    const upd = tgTextUpdate(970001, "880001", 770001, "hello");
    const noSecret = await tgPost(world, TENANT_ID, null, upd);
    assert(noSecret.status === 401, `missing secret must 401, got ${noSecret.status}`);
    const wrongSecret = await tgPost(world, TENANT_ID, "wrong-secret", upd);
    assert(wrongSecret.status === 401, `wrong secret must 401, got ${wrongSecret.status}`);
    const unknownTenant = await tgPost(world, "tenant-does-not-exist", TG_SECRET, upd);
    assert(unknownTenant.status === 404, `unknown tenant must 404, got ${unknownTenant.status}`);
    // Disabled tenant config → 404 (fail closed, no oracle).
    await ensureTelegramConfig(world, false);
    const disabled = await tgPost(world, TENANT_ID, TG_SECRET, upd);
    assert(disabled.status === 404, `telegram-disabled tenant must 404, got ${disabled.status}`);
    await ensureTelegramConfig(world, true);

    // 2. Valid update → 200 ack, processing after the ack.
    const before = tg.callsFor("sendMessage").length;
    const ok = await tgPost(world, TENANT_ID, TG_SECRET, upd);
    assert(ok.status === 200, `valid update must 200, got ${ok.status}`);
    assert(ok.json?.received === true, "ack body must be {received:true}");
    await world.waitFor(
      () => tg.callsFor("sendMessage").length > before,
      5000,
      "telegram reply (post-ack processing: consent prompt)",
    );

    // 3. Dedupe namespace + duplicate short-circuit.
    const row = await world.pg.query(
      `SELECT id, "tenantId", type FROM processed_webhook_events WHERE id = $1`,
      [`tg:${upd.update_id}`],
    );
    const rows = (row as any).rows ?? row;
    assert(rows.length === 1, `dedupe ledger must contain tg:${upd.update_id}`);
    assert(rows[0].tenantId === TENANT_ID && rows[0].type === "telegram_update", "ledger row shape wrong");

    const midCount = tg.callsFor("sendMessage").length;
    const dup = await tgPost(world, TENANT_ID, TG_SECRET, upd);
    assert(dup.status === 200 && dup.json?.duplicate === true, `redelivery must ack duplicate, got ${dup.status} ${JSON.stringify(dup.json)}`);
    await world.settle(150, 300);
    assert(tg.callsFor("sendMessage").length === midCount, "duplicate must NOT be reprocessed (no new sendMessage)");

    // A different update_id IS processed (namespace is per-update, not per-chat).
    const ok2 = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(970002, "880001", 770001, "YES"));
    assert(ok2.status === 200 && !ok2.json?.duplicate, "fresh update_id must process");
    await world.waitFor(() => tg.callsFor("sendMessage").length > midCount, 5000, "fresh update reply");
  },
};
