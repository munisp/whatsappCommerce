// === W48 integrations ===
/**
 * J484 — PERF-INT-12: retention sweep for unbounded webhook JSONB artifacts
 * (wa_webhook_events + wa_message_delivery_receipts), wired into the
 * recovery-sweeps plan (no new cron route).
 *
 * Asserts:
 *   1. Processed wa_webhook_events older than 7d are deleted; failed rows
 *      get a 30d window (retry heartbeat keeps its work); rows inside the
 *      window are untouched.
 *   2. Delivery receipts older than 72h are deleted; fresh ones survive.
 *   3. The sweep is part of the default recovery plan.
 */
import { inArray } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J484",
  name: "webhook artifact retention sweep (7d processed / 30d failed / 72h receipts)",
  feature: "PERF-INT-12",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { sweepWaWebhookArtifacts } = await import("../../server/services/webhookDedupe");
    const tag = crypto.randomUUID().slice(0, 8);
    const now = Date.now();
    const day = 24 * 3600 * 1000;

    const ids = {
      processedOld: `j484-po-${tag}`,
      processedNew: `j484-pn-${tag}`,
      failedOld: `j484-fo-${tag}`,
      failedNew: `j484-fn-${tag}`,
      receivedOld: `j484-ro-${tag}`,
    };
    const mk = (id: string, status: string, ageMs: number) => ({
      id,
      messageId: `wamid.${id}`,
      phoneNumberId: "pn-j484",
      waPhoneNumber: "+2348017000484",
      messageType: "text",
      rawPayload: { tag, pad: "x".repeat(64) },
      status,
      retryCount: 0,
      createdAt: new Date(now - ageMs),
      updatedAt: new Date(now - ageMs),
    });
    await world.db.insert(schema.waWebhookEvents).values([
      mk(ids.processedOld, "processed", 8 * day),
      mk(ids.processedNew, "processed", 2 * day),
      mk(ids.failedOld, "failed", 31 * day),
      mk(ids.failedNew, "failed", 10 * day),
      mk(ids.receivedOld, "received", 40 * day), // pending-retry rows NEVER swept
    ] as any);

    const receiptOld = `j484-rcpt-old-${tag}`;
    const receiptNew = `j484-rcpt-new-${tag}`;
    await world.db.insert(schema.waMessageDeliveryReceipts).values([
      { id: receiptOld, tenantId: "sim-tenant", waMessageId: `wamid.${receiptOld}`, status: "read", rawPayload: { tag }, timestamp: new Date(now - 80 * 3600 * 1000), createdAt: new Date(now - 80 * 3600 * 1000) },
      { id: receiptNew, tenantId: "sim-tenant", waMessageId: `wamid.${receiptNew}`, status: "delivered", rawPayload: { tag }, timestamp: new Date(now - 1 * 3600 * 1000), createdAt: new Date(now - 1 * 3600 * 1000) },
    ] as any);

    const res = await sweepWaWebhookArtifacts(world.db);
    assert(res.eventsDeleted >= 2 && res.receiptsDeleted >= 1, `sweep deleted rows (${JSON.stringify(res)})`);

    const remaining = await world.db.select({ id: schema.waWebhookEvents.id })
      .from(schema.waWebhookEvents)
      .where(inArray(schema.waWebhookEvents.id, Object.values(ids)));
    const remainingIds = remaining.map((r) => r.id).sort();
    assert(!remainingIds.includes(ids.processedOld), "processed > 7d deleted");
    assert(!remainingIds.includes(ids.failedOld), "failed > 30d deleted");
    assert(remainingIds.includes(ids.processedNew), "processed inside window kept");
    assert(remainingIds.includes(ids.failedNew), "failed inside window kept (retry heartbeat)");
    assert(remainingIds.includes(ids.receivedOld), "received (pending) rows never swept");

    const receipts = await world.db.select({ id: schema.waMessageDeliveryReceipts.id })
      .from(schema.waMessageDeliveryReceipts)
      .where(inArray(schema.waMessageDeliveryReceipts.id, [receiptOld, receiptNew]));
    const receiptIds = receipts.map((r) => r.id);
    assert(!receiptIds.includes(receiptOld), "receipt > 72h deleted");
    assert(receiptIds.includes(receiptNew), "fresh receipt kept");

    // Sweep is wired into the recovery plan.
    const { buildDefaultSweepPlan } = await import("../../server/_core/recoverySweeps");
    const names = buildDefaultSweepPlan(world.db).map((s) => s.name);
    assert(names.includes("wa-webhook-artifact-retention"), "sweep registered in the recovery plan");

    // Cleanup our residue.
    await world.db.delete(schema.waWebhookEvents).where(inArray(schema.waWebhookEvents.id, Object.values(ids)));
    await world.db.delete(schema.waMessageDeliveryReceipts).where(inArray(schema.waMessageDeliveryReceipts.id, [receiptOld, receiptNew]));
  },
};
