/**
 * === W45 webhook-core (Coder A1) ===
 * J354 — MSG-7/8: DLQ lifecycle end-to-end.
 *  (a) a healthy inbound flips its wa_webhook_events row to processed;
 *  (b) a failed row is re-dispatched by the retry heartbeat through the SAME
 *      per-message pipeline (reply actually delivered);
 *  (c) the retry is idempotent — the namespaced claim means a second
 *      heartbeat run does NOT re-send, and a "retried" row is never picked
 *      up again.
 */
import { eq } from "drizzle-orm";
import { PHONE_NUMBER_ID, TENANT_ID, assert, type World } from "../world";
import * as payloads from "../payloads";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J354",
  name: "DLQ processed/failed flip + idempotent heartbeat retry",
  feature: "MSG-7 per-message processed/failed + MSG-8 pipeline re-dispatch",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    // (a) healthy inbound → DLQ row processed
    const phoneOk = world.newPhone("j354a");
    await world.grantConsent(phoneOk);
    const wamidOk = "wamid.sim.in.j354.0000a";
    await world.inbound(payloads.inbound.text(PHONE_NUMBER_ID, phoneOk, "hello j354 healthy", { id: wamidOk }));
    const [okRow] = await world.db.select().from(schema.waWebhookEvents)
      .where(eq(schema.waWebhookEvents.messageId, wamidOk));
    assert(okRow?.status === "processed", `healthy inbound flips DLQ row to processed (got ${okRow?.status})`);

    // (b) failed row → heartbeat re-dispatch through the full pipeline
    const phone = world.newPhone("j354b");
    await world.grantConsent(phone);
    const wamid = "wamid.sim.in.j354.0000b";
    const failedId = crypto.randomUUID();
    const ts = String(Math.floor(Date.now() / 1000));
    await world.db.insert(schema.waWebhookEvents).values({
      id: failedId,
      messageId: wamid,
      phoneNumberId: PHONE_NUMBER_ID,
      waPhoneNumber: phone,
      messageType: "text",
      rawPayload: {
        object: "whatsapp_business_account",
        entry: [{
          id: "waba_sim_001",
          changes: [{
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "2347000000001", phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name: "Retry J354" }, wa_id: phone }],
              messages: [{ from: phone, id: wamid, timestamp: ts, type: "text", text: { body: "hello j354 retry" } }],
            },
          }],
        }],
      },
      status: "failed",
      retryCount: 0,
      lastError: "simulated downstream failure",
    });

    const r1 = await world.runCron("/api/scheduled/wa-webhook-retry");
    assert(r1.status === 200, `retry heartbeat 200 (got ${r1.status}: ${JSON.stringify(r1.json)})`);
    const [retried] = await world.db.select().from(schema.waWebhookEvents)
      .where(eq(schema.waWebhookEvents.id, failedId));
    assert(retried?.status === "retried" && retried.retryCount === 1,
      `failed row retried via heartbeat (got ${retried?.status}/retries=${retried?.retryCount})`);
    const sendsAfterRetry = world.outbound.toPhone(phone)
      .filter((c) => c.waType !== "read_receipt");
    assert(sendsAfterRetry.length > 0, "retry re-dispatch actually replied to the buyer");
    // the namespaced claim landed in the dedupe ledger
    const [claimRow] = await world.db.select().from(schema.processedWebhookEvents)
      .where(eq(schema.processedWebhookEvents.id, `dlqr1:${wamid}`));
    assert(claimRow?.tenantId === TENANT_ID,
      `namespaced retry claim recorded (got ${claimRow?.id}/${claimRow?.tenantId})`);

    // (c) second heartbeat run: nothing due (row is "retried") → no re-send
    const before = world.outbound.toPhone(phone).length;
    const r2 = await world.runCron("/api/scheduled/wa-webhook-retry");
    assert(r2.status === 200, `second heartbeat 200 (got ${r2.status})`);
    const after = world.outbound.toPhone(phone).length;
    assert(after === before, `idempotent retry — no duplicate sends (before=${before} after=${after})`);
    const [still] = await world.db.select().from(schema.waWebhookEvents)
      .where(eq(schema.waWebhookEvents.id, failedId));
    assert(still?.status === "retried" && still.retryCount === 1, "row untouched by second heartbeat");
  },
};
