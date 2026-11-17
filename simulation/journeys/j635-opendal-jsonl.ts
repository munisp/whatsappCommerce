// === W67 opendal ===
/**
 * J635 — JSONL append path through the OpenDAL facade: facade-level
 * append/read/rewrite roundtrip, then the WA webhook DLQ fallback end-to-end
 * (persist → durable on disk → replay drains + truncates) on the facade.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PHONE_NUMBER_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J635",
  name: "JSONL append/rewrite via OpenDAL facade + DLQ fallback end-to-end",
  feature: "W67 OpenDAL storage layer",
  async run(world: World) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "j635-opendal-"));
    const prevScheme = process.env.OPENDAL_SCHEME;
    const prevDlq = process.env.WA_WEBHOOK_DLQ_FALLBACK_FILE;
    process.env.OPENDAL_SCHEME = "fs";
    const dlqFile = path.join(dir, "wa-dlq-fallback.jsonl");
    process.env.WA_WEBHOOK_DLQ_FALLBACK_FILE = dlqFile;
    try {
      const od = await import("../../server/services/opendalStorage");
      od._resetOpendalForTests();

      // 1. Facade JSONL helpers: append (mkdirs), read, rewrite-truncate.
      const f = path.join(dir, "nested", "fewshot.jsonl");
      await od.jsonlAppend(f, JSON.stringify({ n: 1 }));
      await od.jsonlAppend(f, JSON.stringify({ n: 2 }) + "\n"); // trailing newline tolerated
      const all = await od.jsonlReadAll(f);
      assert(all.split("\n").filter((l) => l.trim()).length === 2, "two lines appended");
      assert(fs.readFileSync(f, "utf8") === all, "fs scheme writes the literal file path");
      assert((await od.jsonlReadAll(path.join(dir, "missing.jsonl"))) === "", "missing file reads as empty");
      await od.jsonlWriteAll(f, JSON.stringify({ n: 3 }) + "\n");
      assert((await od.jsonlReadAll(f)).trim() === '{"n":3}', "rewrite replaces content");
      await od.jsonlWriteAll(f, "");
      assert((await od.jsonlReadAll(f)) === "", "rewrite to empty truncates");

      // 2. DLQ fallback end-to-end through the facade (no Redis in sim → file).
      const mod = await import("../../server/services/waWebhookDlqFallback");
      const rec = {
        id: "j635-dlq-1",
        messageId: "wamid.j635.00001",
        phoneNumberId: PHONE_NUMBER_ID,
        waPhoneNumber: "2348000000635",
        messageType: "text",
        rawPayload: { journey: "J635" },
        status: "received",
        retryCount: 0,
        fallbackReason: "simulated db outage",
      };
      const backend = await mod.persistWaWebhookFallback(rec as any);
      assert(backend === "file", `file fallback via facade (got ${backend})`);
      const onDisk = fs.readFileSync(dlqFile, "utf8");
      assert(onDisk.includes("wamid.j635.00001"), "DLQ record durable at the same path as pre-OpenDAL");

      const replay = await mod.replayWaWebhookFallback(world.db);
      assert(replay.file.replayed === 1 && replay.file.remaining === 0,
        `replay drained the file (got ${JSON.stringify(replay.file)})`);
      assert(fs.readFileSync(dlqFile, "utf8") === "", "file truncated after full replay");

      const [row] = await world.db.select().from((await import("../../drizzle/schema")).waWebhookEvents)
        .where((await import("drizzle-orm")).eq((await import("../../drizzle/schema")).waWebhookEvents.id, "j635-dlq-1"))
        .limit(1);
      assert(row && row.messageId === "wamid.j635.00001", "replayed row in wa_webhook_events");
    } finally {
      if (prevScheme === undefined) delete process.env.OPENDAL_SCHEME; else process.env.OPENDAL_SCHEME = prevScheme;
      if (prevDlq === undefined) delete process.env.WA_WEBHOOK_DLQ_FALLBACK_FILE; else process.env.WA_WEBHOOK_DLQ_FALLBACK_FILE = prevDlq;
      const od = await import("../../server/services/opendalStorage");
      od._resetOpendalForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};
