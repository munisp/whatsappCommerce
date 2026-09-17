/**
 * === W45 webhook-core (Coder A1) ===
 * J355 — MSG-3/TEN-21: a webhook delivered to an UNKNOWN phone_number_id is
 * quarantined — never claimed, never dispatched under the shared "default"
 * tenant (cross-tenant contamination), no reply sent. The DLQ row is still
 * persisted for forensics. (Sim runs NODE_ENV=test with no
 * WHATSAPP_DEFAULT_TENANT_ID, so the quarantine branch is active.)
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J355",
  name: "unknown phone_number_id quarantined (no default-tenant dispatch)",
  feature: "MSG-3 quarantine unknown phone_number_id",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("j355");
    const wamid = "wamid.sim.in.j355.00001";
    const ts = String(Math.floor(Date.now() / 1000));

    const payload = {
      object: "whatsapp_business_account",
      entry: [{
        id: "waba_sim_rogue",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "2347000000999", phone_number_id: "pn_sim_unknown_999" },
            contacts: [{ profile: { name: "Rogue J355" }, wa_id: phone }],
            messages: [{ from: phone, id: wamid, timestamp: ts, type: "text", text: { body: "hello j355 rogue" } }],
          },
        }],
      }],
    };

    await world.inbound(payload);

    // Never claimed in the dedupe ledger (quarantine precedes the claim).
    const claims = await world.db.select().from(schema.processedWebhookEvents)
      .where(eq(schema.processedWebhookEvents.id, wamid));
    assert(claims.length === 0, `quarantined message never claimed (got ${claims.length})`);

    // No outbound reply of any kind to the sender.
    const sends = world.outbound.toPhone(phone).filter((c) => c.waType !== "read_receipt");
    assert(sends.length === 0, `no dispatch/reply for quarantined message (got ${sends.length})`);

    // No cross-contamination into the shared "default" tenant.
    const defaultReplies = await world.db.select().from(schema.whatsappCustomerReplies)
      .where(eq(schema.whatsappCustomerReplies.fromPhone, phone));
    assert(defaultReplies.length === 0, `no customer-reply rows leaked for ${phone} (got ${defaultReplies.length})`);

    // DLQ row persisted (forensics) and NOT left inert at "received".
    const [dlq] = await world.db.select().from(schema.waWebhookEvents)
      .where(eq(schema.waWebhookEvents.messageId, wamid));
    assert(dlq, "DLQ row persisted for quarantined delivery");
    assert(dlq!.phoneNumberId === "pn_sim_unknown_999", `unknown pnid recorded (got ${dlq!.phoneNumberId})`);
    assert(dlq!.status === "processed" || dlq!.status === "failed",
      `DLQ row not inert (got ${dlq!.status})`);
  },
};
