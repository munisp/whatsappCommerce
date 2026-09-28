// === W48 integrations ===
/**
 * J482 — PERF-INT-7: the WA webhook 200 ack is no longer gated behind the
 * DLQ JSONB insert. The ack goes out immediately after HMAC verification +
 * body parse; the wa_webhook_events row (and its W42 PLT-12 Redis/file
 * fallback + ops alert) persists post-ack.
 *
 * Asserts:
 *   1. Source ordering: res.status(200) precedes db.insert(waWebhookEvents)
 *      inside the WA webhook handler.
 *   2. The durable fallback chain (persistWaWebhookFallback +
 *      alertWaDlqInsertFailure) is intact post-ack.
 *   3. Processing + DLQ status flip (processed/failed) still happen after
 *      the insert — the retry heartbeat keeps its work.
 */
import { readFile } from "node:fs/promises";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J482",
  name: "WA webhook ack precedes DLQ persistence (ack < 300ms path)",
  feature: "PERF-INT-7",
  async run(_world: World) {
    const src = await readFile(new URL("../../server/_core/index.ts", import.meta.url), "utf8");
    const start = src.indexOf('app.post("/api/webhooks/whatsapp"');
    const end = src.indexOf('app.post("/api/webhooks/telegram');
    assert(start > 0 && end > start, "WA webhook handler located");
    const handler = src.slice(start, end);

    const ackIdx = handler.indexOf("res.status(200).json({ received: true })");
    const dlqIdx = handler.indexOf("db.insert(waWebhookEvents)");
    assert(ackIdx > 0, "200 ack present");
    assert(dlqIdx > 0, "DLQ insert present");
    assert(ackIdx < dlqIdx, "ack is sent BEFORE the DLQ insert (PERF-INT-7)");

    // HMAC verification still precedes the ack (fail-closed signature gate).
    const hmacIdx = handler.indexOf("verifyHmacSignature");
    assert(hmacIdx > 0 && hmacIdx < ackIdx, "HMAC verify still gates the ack");

    // Durable fallback + post-ack processing intact.
    assert(handler.includes("persistWaWebhookFallback"), "Redis/file fallback intact");
    assert(handler.includes("alertWaDlqInsertFailure"), "ops alert on DLQ failure intact");
    const statusFlip = handler.indexOf('.set({ status: "processed"');
    assert(statusFlip > dlqIdx, "DLQ row flips to processed/failed after fan-out (retry heartbeat preserved)");
    assert(handler.includes("handleTemplateStatusWebhook"), "template-status handling intact");
  },
};
