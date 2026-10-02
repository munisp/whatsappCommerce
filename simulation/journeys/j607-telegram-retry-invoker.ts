// === W61 dataloss ===
/**
 * J607 — telegram_outbox retry invoker parity (audit CRITICAL #2).
 * runTelegramSendRetries existed with NO production invoker; failed
 * telegram_outbox rows sat in 'failed' forever and the dead-letter admin
 * alert never fired. This journey proves the new scheduled route exists, is
 * in the scheduler allowlist (J178 parity), and actually drives the retrier:
 * a due failed outbox row is resent via the REAL cron route.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type World, TENANT_ID } from "../world";
import { meta } from "../metaMock";
import type { Journey } from "../runner";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHAT = "770607";

export const journey: Journey = {
  id: "J607",
  name: "telegram send-retry: scheduled invoker exists and drives runTelegramSendRetries",
  feature: "W61 dataloss: telegram_outbox retry invoker",
  async run(world: World) {
    // ── 1. Route + scheduler allowlist parity (J178) ─────────────────────
    const idx = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf-8");
    assert(idx.includes('app.post("/api/scheduled/telegram-send-retry"'), "scheduled route registered");
    const scheduler = await import("../../services/scheduler/scheduler.mjs");
    assert(
      scheduler.SCHEDULE.some((x: { path: string }) => x.path === "/api/scheduled/telegram-send-retry"),
      "scheduler allowlist entry",
    );

    // ── 2. The cron route actually drives the retrier ────────────────────
    process.env.TELEGRAM_ENABLED = "true";
    try {
      const { encryptSecret } = await import("../../server/services/crypto/secrets");
      const tgCfg = JSON.stringify({ telegram: { botToken: encryptSecret("123456:SIM_BOT_TOKEN"), enabled: true } });
      await world.db.execute(
        `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '${tgCfg}'::jsonb WHERE id = '${TENANT_ID}'`,
      );
      const id = crypto.randomUUID();
      await world.db.execute(
        `INSERT INTO telegram_outbox (id, tenant_id, chat_id, kind, payload, status, attempts, next_retry_at)
         VALUES ('${id}', '${TENANT_ID}', '${CHAT}', 'text',
                 '{"method":"sendMessage","body":{"text":"j607 retry"}}'::jsonb,
                 'failed', 1, now() - interval '1 minute')`,
      );
      meta.hostStatus.set("api.telegram.org", 200);
      const run = await world.runCron("/api/scheduled/telegram-send-retry");
      assert(run.status === 200, `cron route 200 (got ${run.status}: ${JSON.stringify(run.json)})`);
      assert((run.json?.run?.resent ?? 0) >= 1, `retrier resent via cron route (got ${JSON.stringify(run.json?.run)})`);
      const row = await world.db.execute(`SELECT status FROM telegram_outbox WHERE id = '${id}'`);
      assert(((row.rows ?? row)[0] as any).status === "sent", "outbox row recovered to sent");
    } finally {
      meta.hostStatus.delete("api.telegram.org");
      delete process.env.TELEGRAM_ENABLED;
      await world.db.execute(`DELETE FROM telegram_outbox WHERE chat_id = '${CHAT}'`).catch(() => {});
    }
  },
};
