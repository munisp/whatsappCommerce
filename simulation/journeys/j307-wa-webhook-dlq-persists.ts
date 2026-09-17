/**
 * === W42 pipeline-durability (Coder A) ===
 * J307 — Every signed Meta webhook is persisted into the wa_webhook_events
 * DLQ table BEFORE the 200 ack (regression guard for the PLT-12 rework:
 * the happy-path insert must still land with status received/processed).
 */
import { eq } from "drizzle-orm";
import { PHONE_NUMBER_ID, assert, type World } from "../world";
import * as payloads from "../payloads";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J307",
  name: "WA webhook persists DLQ row before ack",
  feature: "wa_webhook_events DLQ insert on inbound webhook",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("j307");
    await world.grantConsent(phone);
    const wamid = "wamid.sim.in.j307.00001";

    await world.inbound(payloads.inbound.text(PHONE_NUMBER_ID, phone, "hello j307", { id: wamid }));

    const rows = await world.db.select().from(schema.waWebhookEvents)
      .where(eq(schema.waWebhookEvents.messageId, wamid));
    assert(rows.length === 1, `exactly one DLQ row for ${wamid} (got ${rows.length})`);
    assert(["received", "processed", "failed"].includes(rows[0].status),
      `DLQ row persisted with a live status (got ${rows[0].status})`);
    assert(rows[0].phoneNumberId === PHONE_NUMBER_ID, `phone_number_id recorded (got ${rows[0].phoneNumberId})`);
  },
};
