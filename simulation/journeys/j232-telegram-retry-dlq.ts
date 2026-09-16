// === W37 telegram (Coder A) ===
/**
 * J232 — telegramSender retry classification + DLQ parity with waSender.
 *
 *   1. classifyTelegramSendError: 429/5xx/network retriable, other 4xx
 *      permanent — same policy as waSender (same fn reused).
 *   2. 429 retry_after parsed from the Bot API error body.
 *   3. Failed live send → telegram_outbox row (status failed, attempts=1,
 *      nextRetryAt ≈ now + 1m backoff).
 *   4. runTelegramSendRetries: 5xx → retried with pushed-back nextRetryAt;
 *      200 → resent (status sent); 400 → dead immediately; attempts hitting
 *      the 4-attempt cap → dead + admin alert via the EXISTING alert path
 *      (WhatsApp text to settings.adminPhone).
 */
import { assert, type World, TENANT_ID, ADMIN_PHONE } from "../world";
import type { Journey } from "../runner";
import { meta, outbound } from "../metaMock";

const CHAT = "770101";

async function insertOutbox(world: World, row: { status: string; attempts: number; kind?: string; payload?: unknown }) {
  const id = crypto.randomUUID();
  await world.db.execute(
    `INSERT INTO telegram_outbox (id, tenant_id, chat_id, kind, payload, status, attempts, next_retry_at)
     VALUES ('${id}', '${TENANT_ID}', '${CHAT}', '${row.kind ?? "text"}',
             '${JSON.stringify(row.payload ?? { method: "sendMessage", body: { text: "retry me" } })}'::jsonb,
             '${row.status}', ${row.attempts}, now() - interval '1 minute')`,
  );
  return id;
}

async function outboxRow(world: World, id: string) {
  const r = await world.db.execute(`SELECT status, attempts, next_retry_at, last_error FROM telegram_outbox WHERE id = '${id}'`);
  return (r.rows ?? r)[0] as any;
}

export const journey: Journey = {
  id: "J232",
  name: "telegramSender retry: classified backoff, 429 retry_after, dead-letter after 4",
  feature: "W37 telegram outbound: retry/DLQ parity with waSender",
  async run(world: World) {
    const tg = await import("../../server/services/telegramSender");
    const wa = await import("../../server/services/waSender");

    // ── 1. Classification parity ───────────────────────────────────────
    assert(tg.classifyTelegramSendError(429) === "retriable", "429 retriable");
    assert(tg.classifyTelegramSendError(500) === "retriable", "5xx retriable");
    assert(tg.classifyTelegramSendError(null) === "retriable", "network retriable");
    assert(tg.classifyTelegramSendError(400) === "permanent", "400 permanent");
    assert(tg.classifyTelegramSendError(403) === "permanent", "403 permanent");
    assert(tg.classifyTelegramSendError === wa.classifyWaSendError, "same classifier reused (parity by construction)");
    assert(tg.TG_RETRY_MAX_ATTEMPTS === 4 && tg.TG_RETRY_BACKOFF_MS.join() === "60000,300000,900000,3600000",
      "1m/5m/15m/1h backoff, 4 attempts — waSender constants reused");

    // ── 2. 429 retry_after parsing ─────────────────────────────────────
    assert(tg.parseTelegramRetryAfter('{"ok":false,"error_code":429,"parameters":{"retry_after":17}}') === 17,
      "retry_after extracted");
    assert(tg.parseTelegramRetryAfter('{"ok":false}') === null, "no retry_after → null");
    assert(tg.parseTelegramRetryAfter("not json") === null, "garbage → null");

    // Configure live telegram sends.
    process.env.TELEGRAM_ENABLED = "true";
    const { encryptSecret } = await import("../../server/services/crypto/secrets");
    const tgCfg = JSON.stringify({ telegram: { botToken: encryptSecret("123456:SIM_BOT_TOKEN"), enabled: true } });
    await world.db.execute(
      `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '${tgCfg}'::jsonb WHERE id = '${TENANT_ID}'`,
    );

    // ── 3. Failed live send → outbox row with classified retry ─────────
    meta.hostStatus.set("api.telegram.org", 500);
    let threw = false;
    try {
      await tg.sendTelegramText(TENANT_ID, CHAT, "will fail");
    } catch {
      threw = true;
    }
    assert(threw, "sender throws on Bot API failure (waSender contract)");
    const dueQ = await world.db.execute(
      `SELECT id, status, attempts, next_retry_at FROM telegram_outbox
       WHERE tenant_id = '${TENANT_ID}' AND chat_id = '${CHAT}' AND kind = 'text' ORDER BY created_at DESC LIMIT 1`,
    );
    const logged = (dueQ.rows ?? dueQ)[0] as any;
    assert(logged.status === "failed", `failure logged to telegram_outbox (got ${logged.status})`);
    assert(Number(logged.attempts) === 1, "attempts=1 after first failure");
    assert(logged.next_retry_at, "retriable failure has next_retry_at");

    // ── 4a. Retry still failing (5xx) → pushed back, still failed ──────
    const r1 = await tg.runTelegramSendRetries({ now: new Date(Date.now() + 120_000) });
    assert(r1.due >= 1 && r1.retried >= 1, `retry attempted (due=${r1.due} retried=${r1.retried})`);
    const after1 = await outboxRow(world, logged.id);
    assert(after1.status === "failed" && Number(after1.attempts) === 2, "attempt bumped, still failed");
    const nextMs = new Date(after1.next_retry_at).getTime();
    assert(nextMs > Date.now() + 4 * 60_000, `backoff pushed ≥5m out (got ${(nextMs - Date.now()) / 1000}s)`);

    // ── 4b. Retry succeeds → sent ──────────────────────────────────────
    meta.hostStatus.set("api.telegram.org", 200);
    await world.db.execute(`UPDATE telegram_outbox SET next_retry_at = now() - interval '1 minute' WHERE id = '${logged.id}'`);
    const r2 = await tg.runTelegramSendRetries();
    assert(r2.resent >= 1, "retry run reports resent");
    const after2 = await outboxRow(world, logged.id);
    assert(after2.status === "sent" && !after2.next_retry_at, "status sent, retry cleared");

    // ── 4c. Permanent 4xx → dead immediately ───────────────────────────
    meta.hostStatus.set("api.telegram.org", 400);
    const permId = await insertOutbox(world, { status: "failed", attempts: 1 });
    const r3 = await tg.runTelegramSendRetries();
    assert(r3.dead >= 1, "4xx dead-letters immediately");
    const perm = await outboxRow(world, permId);
    assert(perm.status === "dead" && !perm.next_retry_at, "permanent failure → dead, no retry");

    // ── 4d. Exhausted attempts → dead + admin alert via existing path ──
    meta.hostStatus.set("api.telegram.org", 503);
    const before = outbound.ofType("text", ADMIN_PHONE).length;
    const deadId = await insertOutbox(world, { status: "failed", attempts: 3 });
    const r4 = await tg.runTelegramSendRetries();
    assert(r4.dead >= 1, "4th attempt dead-letters");
    const dead = await outboxRow(world, deadId);
    assert(dead.status === "dead" && Number(dead.attempts) === 4, "dead after 4 attempts");
    const alerts = outbound.ofType("text", ADMIN_PHONE).slice(before);
    assert(
      alerts.some((c: any) => String(c.body?.text?.body ?? "").includes("Telegram message dead-lettered")),
      "admin alerted via the existing WA dead-letter alert path",
    );

    // ── 4e. Consent-blocked rows are skipped ───────────────────────────
    const { recordConsent } = await import("../../server/services/consent");
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: "770199", channel: "telegram", granted: false }).catch(() => null);
    const skipId = await insertOutbox(world, { status: "failed", attempts: 1 });
    await world.db.execute(`UPDATE telegram_outbox SET chat_id = '770199' WHERE id = '${skipId}'`);
    meta.hostStatus.set("api.telegram.org", 200);
    const r5 = await tg.runTelegramSendRetries();
    assert(r5.skipped >= 1, `consent-blocked skipped (got skipped=${r5.skipped})`);
    const skipped = await outboxRow(world, skipId);
    assert(skipped.status === "failed" && !skipped.next_retry_at, "consent-blocked: retry cleared quietly");

    // Restore env for later journeys.
    delete process.env.TELEGRAM_ENABLED;
    meta.hostStatus.delete("api.telegram.org");
  },
};
