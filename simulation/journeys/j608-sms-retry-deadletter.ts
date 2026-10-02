// === W61 dataloss ===
/**
 * J608 — SMS retry sweep: bounded backoff, recovery, dead-letter + admin
 * alert (audit CRITICAL #3). smsSender failures used to be logged to
 * channel_messages with NO retry path — WA→SMS failover messages could be
 * silently lost.
 *
 *   1. Due failed row + provider 500 → claimed, retried, backoff pushed.
 *   2. Provider recovers → next sweep resends (status 'sent').
 *   3. Row at the attempt cap + provider 500 → status 'dead' + admin WA
 *      alert (never silent).
 *   4. Route + scheduler allowlist parity (J178).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type World, TENANT_ID, ADMIN_PHONE } from "../world";
import { meta, outbound } from "../metaMock";
import type { Journey } from "../runner";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TO = "2348070608000";

async function insertFailedSms(world: World, retryCount: number): Promise<string> {
  const id = crypto.randomUUID();
  const meta_ = {
    status: "failed",
    failureClass: "retriable",
    failReason: "sim: seeded failure",
    retryCount,
    nextRetryAt: new Date(Date.now() - 60_000).toISOString(),
    failoverKey: `j608:${id}`,
  };
  await world.db.execute(
    `INSERT INTO channel_messages (id, channel, direction, "fromAddress", "toAddress", "tenantId", body, metadata, processed, "createdAt")
     VALUES ('${id}', 'sms', 'outbound', 'SIMSHOP', '${TO}', '${TENANT_ID}', 'j608 retry me',
             '${JSON.stringify(meta_)}'::jsonb, false, now())`,
  );
  return id;
}

async function smsRow(world: World, id: string) {
  const r = await world.db.execute(`SELECT metadata, processed FROM channel_messages WHERE id = '${id}'`);
  return (r.rows ?? r)[0] as any;
}

export const journey: Journey = {
  id: "J608",
  name: "sms-retry sweep: claim-first backoff, recovery, dead-letter after 4",
  feature: "W61 dataloss: SMS retry sweep",
  async run(world: World) {
    const smsRetry = await import("../../server/services/smsRetry");
    const { encryptSecret } = await import("../../server/services/crypto/secrets");
    const smsCfg = JSON.stringify({ sms: { provider: "africa_talking", username: "j608user", apiKey: encryptSecret("j608-key"), senderId: "SIMSHOP" } });
    await world.db.execute(
      `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '${smsCfg}'::jsonb WHERE id = '${TENANT_ID}'`,
    );
    const ids: string[] = [];
    try {
      // ── 1. Retriable failure → backoff ────────────────────────────────
      meta.hostStatus.set("api.africastalking.com", 500);
      const a = await insertFailedSms(world, 0); ids.push(a);
      const s1 = await smsRetry.runSmsSendRetries(world.db);
      assert(s1.claimed >= 1 && s1.retried >= 1, `first sweep retried (got ${JSON.stringify(s1)})`);
      let rowA = await smsRow(world, a);
      assert(rowA.metadata.status === "failed" && rowA.metadata.retryCount === 1, "attempt recorded, still failed");
      assert(new Date(rowA.metadata.nextRetryAt).getTime() > Date.now(), "backoff pushed into the future");

      // ── 2. Provider recovers → resend ─────────────────────────────────
      meta.hostStatus.delete("api.africastalking.com");
      await world.db.execute(
        `UPDATE channel_messages SET metadata = metadata || '{"nextRetryAt": "${new Date(Date.now() - 1000).toISOString()}"}'::jsonb WHERE id = '${a}'`,
      );
      const s2 = await smsRetry.runSmsSendRetries(world.db);
      assert(s2.resent >= 1, `recovery sweep resent (got ${JSON.stringify(s2)})`);
      rowA = await smsRow(world, a);
      assert(rowA.metadata.status === "sent" && rowA.processed === true, "row recovered to sent");

      // ── 3. Attempt cap → dead + admin alert ───────────────────────────
      meta.hostStatus.set("api.africastalking.com", 500);
      const b = await insertFailedSms(world, 3); ids.push(b);
      const before = outbound.ofType("text", ADMIN_PHONE).length;
      const s3 = await smsRetry.runSmsSendRetries(world.db);
      assert(s3.dead >= 1, `cap-exhausted row dead-lettered (got ${JSON.stringify(s3)})`);
      const rowB = await smsRow(world, b);
      assert(rowB.metadata.status === "dead" && rowB.metadata.retryCount === 4, "dead after 4 attempts");
      const alerts = outbound.ofType("text", ADMIN_PHONE).slice(before);
      assert(
        alerts.some((c: any) => String(c.body?.text?.body ?? "").includes("SMS dead-lettered")),
        "admin alerted via the WA ops alert path (never silent)",
      );

      // ── 4. Route + scheduler allowlist parity (J178) ──────────────────
      const idx = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf-8");
      assert(idx.includes('app.post("/api/scheduled/sms-retry"'), "scheduled route registered");
      const scheduler = await import("../../services/scheduler/scheduler.mjs");
      assert(scheduler.SCHEDULE.some((x: { path: string }) => x.path === "/api/scheduled/sms-retry"), "scheduler allowlist entry");
    } finally {
      meta.hostStatus.delete("api.africastalking.com");
      for (const id of ids) await world.db.execute(`DELETE FROM channel_messages WHERE id = '${id}'`).catch(() => {});
      await world.db.execute(`UPDATE tenants SET settings = settings - 'sms' WHERE id = '${TENANT_ID}'`).catch(() => {});
    }
  },
};
