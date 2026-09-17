/**
 * === W45 webhook-core (Coder A1) ===
 * J353 — MSG-5: human-agent takeover suppresses bot replies in the LIVE
 * webhook path. While the (tenant, phone) conversation is human_active the
 * inbound message is persisted for the agent thread but no bot reply is
 * sent; after the agent releases the thread to the bot (bot_active), the
 * same sender gets normal bot replies again.
 */
import { and, eq } from "drizzle-orm";
import { PHONE_NUMBER_ID, TENANT_ID, assert, type World } from "../world";
import * as payloads from "../payloads";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J353",
  name: "human_active suppresses bot replies; release resumes",
  feature: "MSG-5 human-agent takeover suppression + release-to-bot",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("j353");
    await world.grantConsent(phone);

    // Seed the customer + a human_active conversation (agent owns the thread).
    const customerId = crypto.randomUUID();
    await world.db.insert(schema.customers).values({
      id: customerId, tenantId: TENANT_ID, whatsappPhone: phone, name: "J353 Human",
      createdAt: new Date(), updatedAt: new Date(),
    });
    const convId = crypto.randomUUID();
    await world.db.insert(schema.conversations).values({
      id: convId, tenantId: TENANT_ID, customerId, status: "human_active",
      channel: "whatsapp", messageCount: 0, aiHandled: false,
      createdAt: new Date(), updatedAt: new Date(),
    });

    await world.text(phone, "is anyone there? j353");

    // Bot replies suppressed: no text/interactive/template sends to the buyer
    // (mark-read receipts are allowed — they are not bot replies).
    const botSends = world.outbound.toPhone(phone)
      .filter((c) => c.waType !== "read_receipt");
    assert(botSends.length === 0,
      `no bot outbound while human_active (got ${botSends.length}: ${JSON.stringify(botSends.map((c) => c.waType))})`);

    // …but the inbound was persisted for the agent thread…
    const replies = await world.db.select().from(schema.whatsappCustomerReplies)
      .where(and(
        eq(schema.whatsappCustomerReplies.tenantId, TENANT_ID),
        eq(schema.whatsappCustomerReplies.fromPhone, phone),
      ));
    assert(replies.length === 1, `inbound persisted for agent thread (got ${replies.length})`);
    // …and the conversation counter moved.
    const [conv] = await world.db.select().from(schema.conversations)
      .where(eq(schema.conversations.id, convId));
    assert((conv?.messageCount ?? 0) >= 1, `conversation messageCount bumped (got ${conv?.messageCount})`);

    // Agent releases the thread back to the bot (the releaseToBot mutation's
    // transition) → normal bot replies resume.
    await world.db.update(schema.conversations)
      .set({ status: "bot_active", aiHandled: true, updatedAt: new Date() })
      .where(eq(schema.conversations.id, convId));
    await world.inbound(payloads.inbound.text(PHONE_NUMBER_ID, phone, "hello again j353"));
    const afterSends = world.outbound.toPhone(phone)
      .filter((c) => c.waType !== "read_receipt");
    assert(afterSends.length > 0, "bot replies resume after release-to-bot");
  },
};
