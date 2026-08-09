/**
 * J22 — CTWA: an inbound campaign keyword tags the customer
 * (campaign:<keyword>) and runs the mapped campaign action.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J22",
  name: "CTWA campaign keyword",
  feature: "ctwa attribution + action",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);

    // Inbound campaign keyword (as a Click-to-WhatsApp ad deep-link would send).
    await world.text(phone, "simdeal");
    const reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "Sim Deal campaign", "campaign reply delivered");
    assertIncludes(reply, "SIM10", "campaign reply carries the mapped promo code");

    // Customer tagged campaign:simdeal.
    const schema = await import("../../drizzle/schema");
    const [customer] = await world.db.select().from(schema.customers)
      .where(and(eq(schema.customers.tenantId, TENANT_ID), eq(schema.customers.whatsappPhone, phone)))
      .limit(1);
    assert(customer, "customer row exists for the CTWA contact");
    const tags = (customer.tags as string[]) ?? [];
    assert(tags.includes("campaign:simdeal"), `customer tagged campaign:simdeal (got ${JSON.stringify(tags)})`);

    // A non-keyword message does NOT claim the campaign path.
    world.llm.when("just a regular hello", {
      reply: "Hello! How can I help?",
      intent: "greeting",
      nextState: "browse",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.9,
    });
    await world.text(phone, "just a regular hello");
    const regular = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(regular, "How can I help", "non-keyword text flows through the normal pipeline, not CTWA");
    const [customerAfter] = await world.db.select().from(schema.customers)
      .where(and(eq(schema.customers.tenantId, TENANT_ID), eq(schema.customers.whatsappPhone, phone)))
      .limit(1);
    assert((customerAfter.tags as string[]).length === 1, "no extra campaign tags from regular traffic");
  },
};
