/**
 * === W42 pipeline-durability (Coder A) ===
 * J308 — Publish/ingest failure is NEVER a silent 200-ack:
 *  (a) an unsigned Meta webhook is rejected (401), not acked;
 *  (b) a broker-side publish failure (Fluvio endpoint down) is counted +
 *      logged via getFluvioPublishFailureCount, not swallowed (PLT-5/PLT-6
 *      doctrine on the TS fan-out path; the Go ingestor's publish-fail→503
 *      contract is covered by services/webhook-ingestor Go tests).
 */
import { PHONE_NUMBER_ID, assert, type World } from "../world";
import * as payloads from "../payloads";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J308",
  name: "publish/ingest failure never silently acked",
  feature: "unsigned webhook 401 + fluvio publish failure counter",
  async run(world: World) {
    // (a) unsigned webhook → 401 (fail closed, no ack)
    const raw = JSON.stringify(payloads.inbound.text(PHONE_NUMBER_ID, world.newPhone("j308"), "unsigned j308"));
    const res = await fetch(`${world.baseUrl}/api/webhooks/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    });
    assert(res.status === 401, `unsigned webhook rejected with 401 (got ${res.status})`);

    // (b) fluvio publish failure surfaces in the failure counter
    const { publishEvents, getFluvioPublishFailureCount } = await import("../../server/kafka");
    const before = getFluvioPublishFailureCount();
    process.env.FLUVIO_ENDPOINT = "http://127.0.0.1:9"; // discard port — always down
    try {
      await publishEvents([{ topic: "wacommerce.orders", key: "j308", value: { orderId: "j308", tenantId: "sim-tenant" } }]);
    } finally {
      delete process.env.FLUVIO_ENDPOINT;
    }
    assert(getFluvioPublishFailureCount() > before,
      `fluvio publish failure counted loudly (before=${before}, after=${getFluvioPublishFailureCount()})`);
  },
};
