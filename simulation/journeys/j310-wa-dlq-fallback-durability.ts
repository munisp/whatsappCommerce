/**
 * === W42 pipeline-durability (Coder A) ===
 * J310 — PLT-12: a WA webhook DLQ-insert failure is preserved in a DURABLE
 * fallback. In the sim there is no Redis, so the append-only JSONL file is
 * the fallback; the record survives a simulated restart (all in-memory
 * state dropped — the file is the only copy) and replays into
 * wa_webhook_events once the DB is healthy, draining the file.
 */
import { readFile } from "fs/promises";
import { eq } from "drizzle-orm";
import { PHONE_NUMBER_ID, assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J310",
  name: "WA DLQ fallback durable across restart + replay",
  feature: "PLT-12 durable fallback (JSONL) + replay into wa_webhook_events",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const mod = await import("../../server/services/waWebhookDlqFallback");
    const tmp = `/tmp/wa-dlq-fallback-j310-${Date.now()}.jsonl`;
    process.env.WA_WEBHOOK_DLQ_FALLBACK_FILE = tmp;
    const rec = {
      id: crypto.randomUUID(),
      messageId: "wamid.j310.00001",
      phoneNumberId: PHONE_NUMBER_ID,
      waPhoneNumber: "2348000000310",
      messageType: "text",
      rawPayload: { journey: "J310" },
      status: "received",
      retryCount: 0,
      fallbackReason: "simulated db outage",
    };
    try {
      const backend = await mod.persistWaWebhookFallback(rec);
      assert(backend === "file", `sim falls back to the durable JSONL file (got ${backend})`);

      // Simulated restart: nothing is held in memory — the file is the only
      // copy of the dead-lettered event.
      const onDisk = await readFile(tmp, "utf8");
      assertIncludes(onDisk, "wamid.j310.00001", "record durable on disk across restart");

      const replay = await mod.replayWaWebhookFallback(world.db);
      assert(replay.file.replayed === 1 && replay.file.remaining === 0,
        `replay drained the file (got ${JSON.stringify(replay.file)})`);

      const [row] = await world.db.select().from(schema.waWebhookEvents)
        .where(eq(schema.waWebhookEvents.id, rec.id));
      assert(row, "replayed record now lives in wa_webhook_events");
      assert(row!.messageId === "wamid.j310.00001" && row!.status === "received",
        `replayed row re-queued as received (got ${row!.messageId}/${row!.status})`);

      const after = await readFile(tmp, "utf8");
      assert(after.trim() === "", "fallback file empty after successful replay");
    } finally {
      delete process.env.WA_WEBHOOK_DLQ_FALLBACK_FILE;
    }
  },
};
