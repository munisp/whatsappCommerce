// === W62 findings ===
/**
 * J612 — F9: email_outbox durable retry + dead-letter (audit W61 MEDIUM #9).
 * Emails were fire-and-forget. This journey proves:
 *   1. enqueueEmail persists claim-first with an idempotency key — a
 *      duplicate enqueue is a no-op (single row).
 *   2. A failing send (no RESEND_API_KEY in sim) goes status='failed' with
 *      backoff, and the /api/scheduled/email-send-retry cron route drives
 *      runEmailSendRetries (route + scheduler allowlist parity, J178).
 *   3. Exhausting WA_RETRY_MAX_ATTEMPTS dead-letters the row and alerts the
 *      tenant admin over WhatsApp (fail-open telemetry).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type World, TENANT_ID, ADMIN_PHONE } from "../world";
import { outbound } from "../metaMock";
import type { Journey } from "../runner";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J612",
  name: "email outbox: idempotent enqueue, cron retry, dead-letter admin alert",
  feature: "W62 findings F9: durable email outbox",
  async run(world: World) {
    const { enqueueEmail, runEmailSendRetries } = await import("../../server/services/emailOutbox");
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const KEY = "j612:welcome:test@example.com";
    try {
      // ── 1. Idempotent claim-first enqueue ──────────────────────────────
      const first = await enqueueEmail({
        tenantId: TENANT_ID,
        idempotencyKey: KEY,
        kind: "welcome",
        to: "test@example.com",
        subject: "Welcome",
        html: "<p>hi</p>",
      });
      assert(first === false, "sim-mode send fails but the row is durable");
      const dupe = await enqueueEmail({
        tenantId: TENANT_ID,
        idempotencyKey: KEY,
        kind: "welcome",
        to: "test@example.com",
        subject: "Welcome",
        html: "<p>hi</p>",
      });
      assert(dupe === false, "duplicate idempotency key is a no-op");
      const rows = await world.db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.idempotencyKey, KEY));
      assert(rows.length === 1, `exactly one outbox row (got ${rows.length})`);
      assert(rows[0].status === "failed" && rows[0].attempts === 1, `failed after 1 attempt (got ${rows[0].status}/${rows[0].attempts})`);
      assert(rows[0].nextRetryAt !== null, "backoff scheduled");

      // ── 2. Cron route drives the retrier ───────────────────────────────
      const idx = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf-8");
      assert(idx.includes('app.post("/api/scheduled/email-send-retry"'), "scheduled route registered");
      const scheduler = await import("../../services/scheduler/scheduler.mjs");
      assert(
        scheduler.SCHEDULE.some((x: { path: string }) => x.path === "/api/scheduled/email-send-retry"),
        "scheduler allowlist entry",
      );
      await world.db.execute(`UPDATE email_outbox SET next_retry_at = now() - interval '1 minute' WHERE idempotency_key = '${KEY}'`);
      const run = await world.runCron("/api/scheduled/email-send-retry");
      assert(run.status === 200, `cron 200 (got ${run.status}: ${JSON.stringify(run.json)})`);
      assert((run.json?.run?.retried ?? 0) >= 1, `retried via cron (got ${JSON.stringify(run.json?.run)})`);
      const [afterRetry] = await world.db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.idempotencyKey, KEY));
      assert(afterRetry.attempts === 2 && afterRetry.status === "failed", `attempt 2 still failed (got ${afterRetry.attempts}/${afterRetry.status})`);

      // ── 3. Exhaustion → dead + admin WA alert ──────────────────────────
      await world.db.execute(`UPDATE email_outbox SET attempts = 3, next_retry_at = now() - interval '1 minute' WHERE idempotency_key = '${KEY}'`);
      const before = outbound.ofType("text", ADMIN_PHONE).length;
      const run2 = await runEmailSendRetries({});
      assert(run2.dead >= 1, `dead-lettered (got ${JSON.stringify(run2)})`);
      const [dead] = await world.db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.idempotencyKey, KEY));
      assert(dead.status === "dead" && dead.nextRetryAt === null, `row dead (got ${dead.status})`);
      const alerts = outbound.ofType("text", ADMIN_PHONE).slice(before);
      assert(
        alerts.some((c: any) => String(c.body?.text?.body ?? "").includes("Email dead-lettered")),
        "tenant admin WA dead-letter alert sent",
      );
    } finally {
      await world.db.delete(schema.emailOutbox).where(eq(schema.emailOutbox.idempotencyKey, KEY)).catch(() => {});
    }
  },
};
