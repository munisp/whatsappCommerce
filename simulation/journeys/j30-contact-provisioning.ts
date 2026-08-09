/**
 * J30 — Contact provisioning: a new phone with contacts[].profile.name gets
 * a customer row created with that name; a later different profile name does
 * not clobber it.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J30",
  name: "contact provisioning",
  feature: "waContacts auto-create",
  async run(world) {
    const phone = world.newPhone("a");
    const schema = await import("../../drizzle/schema");

    const findCustomer = async () => {
      const [c] = await world.db.select().from(schema.customers)
        .where(and(eq(schema.customers.tenantId, TENANT_ID), eq(schema.customers.whatsappPhone, phone)))
        .limit(1);
      return c ?? null;
    };

    assert(!(await findCustomer()), "no customer before first contact");

    // First inbound with a Meta profile name → customer created with it.
    await world.text(phone, "hello", { profileName: "Ade Simons" });
    const created = await findCustomer();
    assert(created, "customer row provisioned on first contact");
    assert(created.name === "Ade Simons", `profile name provisioned (got ${created.name})`);

    // A later message with a different profile name must NOT overwrite.
    await world.text(phone, "hello again", { profileName: "Different Name" });
    const after = await findCustomer();
    assert(after.name === "Ade Simons", "existing name preserved on later contacts");

    // A contact WITHOUT a profile name still gets a row.
    const phone2 = world.newPhone("b");
    await world.text(phone2, "hi");
    const [c2] = await world.db.select().from(schema.customers)
      .where(and(eq(schema.customers.tenantId, TENANT_ID), eq(schema.customers.whatsappPhone, phone2)))
      .limit(1);
    assert(c2, "row provisioned even without a profile name");
  },
};
