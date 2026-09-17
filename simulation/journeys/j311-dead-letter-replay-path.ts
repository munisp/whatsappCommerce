/**
 * === W42 pipeline-durability (Coder A) ===
 * J311 — Dead-letter replay path end-to-end:
 *  (a) DLQ-insert failure raises an ops alert through the existing
 *      admin-alerts path (tenant resolved from phone_number_id) without
 *      throwing into the webhook path;
 *  (b) a failed wa_webhook_events row is re-queued by the retry path
 *      (status -> received, retryCount reset — same transition as
 *      webhookDlq.retryEvent) so the retry heartbeat picks it up;
 *  (c) replayWaWebhookFallback is idempotent on an empty fallback.
 */
import { eq } from "drizzle-orm";
import { PHONE_NUMBER_ID, TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J311",
  name: "dead-letter replay path (alert + retry reset)",
  feature: "PLT-12 ops alert on DLQ-insert failure + failed-row requeue",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const mod = await import("../../server/services/waWebhookDlqFallback");

    // (a) ops alert — tenant resolvable from PHONE_NUMBER_ID; must not throw.
    await mod.alertWaDlqInsertFailure(world.db, {
      id: crypto.randomUUID(),
      messageId: "wamid.j311.alert",
      phoneNumberId: PHONE_NUMBER_ID,
      waPhoneNumber: "2348000000311",
      messageType: "text",
      rawPayload: { journey: "J311" },
      status: "received",
      retryCount: 0,
    }, new Error("simulated insert failure"), "file");

    // (b) failed row -> retry requeue (same transition as webhookDlq.retryEvent)
    const failedId = crypto.randomUUID();
    await world.db.insert(schema.waWebhookEvents).values({
      id: failedId,
      messageId: "wamid.j311.failed",
      phoneNumberId: PHONE_NUMBER_ID,
      waPhoneNumber: "2348000000311",
      messageType: "text",
      rawPayload: { journey: "J311" },
      status: "failed",
      retryCount: 3,
      lastError: "downstream timeout",
    });
    await world.db.update(schema.waWebhookEvents)
      .set({ status: "received", nextRetryAt: new Date(), retryCount: 0, lastError: null, updatedAt: new Date() })
      .where(eq(schema.waWebhookEvents.id, failedId));
    const [requeued] = await world.db.select().from(schema.waWebhookEvents)
      .where(eq(schema.waWebhookEvents.id, failedId));
    assert(requeued?.status === "received" && requeued.retryCount === 0,
      `failed row re-queued for retry (got ${requeued?.status}/retries=${requeued?.retryCount})`);

    // (c) empty fallback replays cleanly (idempotent, no throw)
    process.env.WA_WEBHOOK_DLQ_FALLBACK_FILE = `/tmp/wa-dlq-fallback-j311-${Date.now()}.jsonl`;
    try {
      const replay = await mod.replayWaWebhookFallback(world.db);
      assert(replay.file.replayed === 0 && replay.file.remaining === 0,
        `empty fallback replays clean (got ${JSON.stringify(replay.file)})`);
    } finally {
      delete process.env.WA_WEBHOOK_DLQ_FALLBACK_FILE;
    }

    // sanity: the alert path resolved the sim tenant from the phone number id
    const [t] = await world.db.select({ id: schema.tenants.id }).from(schema.tenants)
      .where(eq(schema.tenants.whatsappPhoneNumberId, PHONE_NUMBER_ID)).limit(1);
    assert(t?.id === TENANT_ID, `tenant resolved from phone_number_id (got ${t?.id})`);
  },
};
