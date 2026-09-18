/**
 * === W45 webhook-core (Coder A1) ===
 * J352 — MSG-4: a single Meta webhook POST carrying MULTIPLE entry[]/changes[]
 * fan-out is fully processed: every message in every change is claimed and
 * dispatched (previously only entry[0].changes[0] was read and the rest were
 * silently dropped after the 200 ack), and the DLQ row flips to processed.
 */
import { eq, inArray } from "drizzle-orm";
import { PHONE_NUMBER_ID, SUPPLIER_PHONE_NUMBER_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J352",
  name: "multi-entry webhook fan-out all processed",
  feature: "MSG-4 iterate ALL entry[]/changes[] + DLQ processed flip",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phoneA = world.newPhone("j352a");
    const phoneB = world.newPhone("j352b");
    await world.grantConsent(phoneA);
    await world.grantConsent(phoneB);
    const wamidA = "wamid.sim.in.j352.0000a";
    const wamidB = "wamid.sim.in.j352.0000b";
    const ts = String(Math.floor(Date.now() / 1000));

    // Two entries × one change each; second entry targets the SUPPLIER
    // tenant's phone_number_id (cross-tenant fan-out in a single POST).
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_sim_001",
          changes: [{
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "2347000000001", phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name: "Fanout A" }, wa_id: phoneA }],
              messages: [{ from: phoneA, id: wamidA, timestamp: ts, type: "text", text: { body: "hello j352 first entry" } }],
            },
          }],
        },
        {
          id: "waba_sim_supplier_001",
          changes: [{
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "2347000000099", phone_number_id: SUPPLIER_PHONE_NUMBER_ID },
              contacts: [{ profile: { name: "Fanout B" }, wa_id: phoneB }],
              messages: [{ from: phoneB, id: wamidB, timestamp: ts, type: "text", text: { body: "hello j352 second entry" } }],
            },
          }],
        },
      ],
    };

    await world.inbound(payload);

    // Both messages claimed in the dedupe ledger (second change not dropped).
    const claims = await world.db.select().from(schema.processedWebhookEvents)
      .where(inArray(schema.processedWebhookEvents.id, [wamidA, wamidB]));
    const claimedIds = claims.map((c) => c.id).sort();
    assert(claimedIds.length === 2,
      `both fan-out messages claimed (got ${JSON.stringify(claimedIds)})`);

    // Both senders got SOME reply over their own tenant channel.
    assert(world.outbound.toPhone(phoneA).length > 0, `first-entry sender got a reply (${phoneA})`);
    assert(world.outbound.toPhone(phoneB).length > 0, `second-entry sender got a reply (${phoneB})`);

    // MSG-7: the single DLQ row for the delivery flips to processed.
    const [dlq] = await world.db.select().from(schema.waWebhookEvents)
      .where(eq(schema.waWebhookEvents.messageId, wamidA));
    assert(dlq, "DLQ row persisted for the multi-entry delivery");
    assert(dlq!.status === "processed", `DLQ row flipped to processed (got ${dlq!.status})`);
  },
};
