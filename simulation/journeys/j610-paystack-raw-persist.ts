// === W61 dataloss ===
/**
 * J610 — Paystack webhook: raw event persisted BEFORE the 200 ack (audit
 * HIGH #5). The ack-first route used to confirm asynchronously with no raw
 * persistence — a crash between ack and confirm left money unconfirmed with
 * no PSP retry and no outbox row.
 *
 *   1. charge.success → 200 ack AND a raw_webhook_events row carrying the
 *      full payload, marked processed once the confirm chain settles.
 *   2. Source-order proof: the raw insert (and its fail-closed 500 path)
 *      precede res.status(200) in the handler.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { paystackChargeSuccess } from "./helpers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J610",
  name: "paystack webhook: raw-persist-then-ack (crash-after-ack recoverable)",
  feature: "W61 dataloss: raw_webhook_events landing pad",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const ref = `j610-${crypto.randomUUID().slice(0, 12)}`;

    // ── 1. Webhook acks 200 and the raw event is durable ────────────────
    const res = await paystackChargeSuccess(world, { reference: ref, amountMajor: 1234.5, currency: "NGN" });
    assert(res.status === 200, `webhook acked 200 (got ${res.status})`);
    const rows = await world.db.select().from(schema.rawWebhookEvents).where(eq(schema.rawWebhookEvents.reference, ref));
    assert(rows.length === 1, `raw event persisted (got ${rows.length})`);
    const raw = rows[0];
    assert(raw.provider === "paystack" && raw.eventType === "charge.success", "provider/eventType recorded");
    assert((raw.payload as any)?.reference === ref, "full payload preserved for recovery");
    assert(raw.processed === true && raw.processedAt != null, "marked processed after the confirm chain settled");

    // ── 2. Source-order: raw insert BEFORE the ack, fail-closed on error ─
    const idx = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf-8");
    const handlerStart = idx.indexOf('app.post("/api/webhooks/paystack"');
    const handler = idx.slice(handlerStart, handlerStart + 12000);
    const insertAt = handler.indexOf("db.insert(rawWebhookEvents)");
    const ackAt = handler.indexOf('res.status(200).json({ received: true })');
    assert(insertAt > 0 && ackAt > 0 && insertAt < ackAt, "raw insert precedes the 200 ack");
    assert(handler.includes("raw-persist-failed"), "fail-closed 500 when the raw insert fails (Paystack retries)");
  },
};
