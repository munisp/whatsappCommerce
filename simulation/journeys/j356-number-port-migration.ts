/**
 * === W45 webhook-core (Coder A1) ===
 * J356 — MSG-12: a `system` message of type customer_changed_number migrates
 * the buyer's identity (customers), consent records and cart sessions from
 * the old wa_id to system.new_wa_id, opens the 24h window on the new number
 * and sends a confirmation there. Previously system messages were dropped,
 * orphaning identity/consent/cart on a number port.
 */
import { and, eq } from "drizzle-orm";
import { PHONE_NUMBER_ID, TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J356",
  name: "customer_changed_number migrates identity/consent/cart",
  feature: "MSG-12 number-port migration",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const oldPhone = world.newPhone("j356a");
    const newPhone = world.newPhone("j356b");

    // Seed pre-port state on the OLD number: customer, consent, cart session.
    const customerId = crypto.randomUUID();
    await world.db.insert(schema.customers).values({
      id: customerId, tenantId: TENANT_ID, whatsappPhone: oldPhone, name: "Port J356",
      createdAt: new Date(), updatedAt: new Date(),
    });
    await world.db.insert(schema.consents).values({
      tenantId: TENANT_ID, phone: oldPhone, channel: "whatsapp", granted: true,
      grantedAt: new Date(),
    });
    const cartId = crypto.randomUUID();
    await world.db.insert(schema.cartSessions).values({
      id: cartId, tenantId: TENANT_ID, waPhoneNumber: oldPhone, sessionData: { j: 356 },
      createdAt: new Date(), updatedAt: new Date(),
    });

    const wamid = "wamid.sim.in.j356.00001";
    const ts = String(Math.floor(Date.now() / 1000));
    const payload = {
      object: "whatsapp_business_account",
      entry: [{
        id: "waba_sim_001",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "2347000000001", phone_number_id: PHONE_NUMBER_ID },
            contacts: [{ profile: { name: "Port J356" }, wa_id: oldPhone }],
            messages: [{
              from: oldPhone,
              id: wamid,
              timestamp: ts,
              type: "system",
              system: {
                body: "User changed from old to new number",
                type: "customer_changed_number",
                new_wa_id: newPhone,
              },
            }],
          },
        }],
      }],
    };

    await world.inbound(payload);

    // Identity migrated (same customer row → conversations stay linked).
    const [cust] = await world.db.select().from(schema.customers)
      .where(eq(schema.customers.id, customerId));
    assert(cust?.whatsappPhone === newPhone,
      `customer phone migrated to new wa_id (got ${cust?.whatsappPhone})`);

    // Consent migrated.
    const [consent] = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, newPhone)));
    assert(consent?.granted === true, `consent migrated to new wa_id (got ${consent?.phone}/${consent?.granted})`);
    const [oldConsent] = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, oldPhone)));
    assert(!oldConsent, "no consent row left on the old number");

    // Cart migrated.
    const [cart] = await world.db.select().from(schema.cartSessions)
      .where(eq(schema.cartSessions.id, cartId));
    assert(cart?.waPhoneNumber === newPhone, `cart session migrated (got ${cart?.waPhoneNumber})`);

    // Confirmation sent to the NEW number.
    const notice = world.outbound.toPhone(newPhone).filter((c) => c.waType !== "read_receipt");
    assert(notice.length > 0, "number-port confirmation sent to the new wa_id");
  },
};
