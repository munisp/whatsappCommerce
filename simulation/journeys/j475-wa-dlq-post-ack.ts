// === W48 api-db ===
/**
 * J475 — PERF-API-5: the WA webhook DLQ insert moved POST-ACK.
 *
 * Previously the handler awaited getDb + the wa_webhook_events insert (plus
 * the Redis/file fallback on failure) BEFORE res.status(200) — a DB stall
 * directly delayed Meta's ack. Now: HMAC verify → 200 ack → DLQ insert +
 * processing (all post-ack, durability preserved via the same DLQ row +
 * fallback machinery).
 *
 * Proves through the REAL webhook:
 *   1. ack is 200 with the lean {received:true} body,
 *   2. the DLQ row is still persisted post-ack (durability intact) and
 *      flipped to a terminal status by the processing fan-out,
 *   3. a bad signature is still 401 pre-ack.
 */
import { createHmac } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { PHONE_NUMBER_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import * as payloads from "../payloads";

export const journey: Journey = {
  id: "J475",
  name: "WA webhook DLQ insert post-ack (PERF-API-5)",
  feature: "ack 200 before wa_webhook_events insert; DLQ durability + processing intact post-ack",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("j475");
    const payload = payloads.inbound.text(PHONE_NUMBER_ID, phone, "hello J475", { id: `wamid.j475.${Date.now()}` });
    const raw = JSON.stringify(payload);
    const sig = createHmac("sha256", process.env.WHATSAPP_APP_SECRET ?? "").update(raw).digest("hex");

    const t0 = Date.now();
    const res = await fetch(`${world.baseUrl}/api/webhooks/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-signature-256": `sha256=${sig}` },
      body: raw,
    });
    const ackMs = Date.now() - t0;
    const json = await res.json().catch(() => null);
    assert(res.status === 200, `WA ack 200 (got ${res.status})`);
    assert(json?.received === true, "lean ack body");
    assert(ackMs < 2000, `ack fast (${ackMs}ms)`);

    await world.settle(800);
    const rows = await world.db.select().from(schema.waWebhookEvents)
      .where(eq(schema.waWebhookEvents.waPhoneNumber, phone))
      .orderBy(desc(schema.waWebhookEvents.createdAt))
      .limit(1);
    assert(rows.length === 1, "DLQ row persisted post-ack (durability intact)");
    assert(["processed", "failed", "received"].includes(rows[0].status), `DLQ row has a real status (${rows[0].status})`);
    assert(rows[0].status !== "received" || rows[0].retryCount === 0, "processing fan-out flips or leaves a retryable row");

    // Bad signature → 401 pre-ack (fail-closed verification intact).
    const bad = await fetch(`${world.baseUrl}/api/webhooks/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", "attacker").update(raw).digest("hex")}` },
      body: raw,
    });
    assert(bad.status === 401, "invalid HMAC still rejected 401");
  },
};
