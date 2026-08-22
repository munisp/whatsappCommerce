/**
 * J155 — W28 odoo-sync: paid order → customer invoice posted to Odoo.
 * A paid order is seeded (integer cents from decimal major units); the
 * tenant runs "odoo sync now" (WhatsApp admin command) which sweeps the
 * paid order into the exactly-once outbox and the claim-before-send worker
 * posts it. The deterministic mock asserts: partner created, one invoice
 * with correct lines + integer cents, outbox row sent with an odooRef.
 * Re-running sync posts NO duplicates.
 */
import crypto from "crypto";
import { assert, assertIncludes, bodyText, ADMIN_PHONE, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J155",
  name: "odoo paid order → invoice",
  feature: "W28 odoo-sync sale → customer invoice",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const tenant = await tenantCaller(TENANT_ID);

    // Connect + enable (ondemand mode: explicit sync only).
    await tenant.odooSync.saveConfig({
      url: "mock://odoo", db: "sim-db", username: "api@sim.local",
      apiKey: "k155", syncMode: "ondemand", enabled: true,
    });

    // Seed a paid order: ₦42,300.50 → 4,230,050 cents.
    const orderId = crypto.randomUUID();
    await world.db.insert(schema.orders).values({
      id: orderId,
      tenantId: TENANT_ID,
      customerId: "sim-customer-j155",
      orderNumber: `ODOO-155-${crypto.randomUUID().slice(0, 8)}`,
      status: "delivered",
      totalAmount: "42300.50",
      currency: "NGN",
      paymentStatus: "completed",
    });
    // An UNPAID order must never be synced.
    const unpaidId = crypto.randomUUID();
    await world.db.insert(schema.orders).values({
      id: unpaidId,
      tenantId: TENANT_ID,
      customerId: "sim-customer-j155",
      orderNumber: `ODOO-155-UNPAID`,
      status: "pending",
      totalAmount: "99999.00",
      currency: "NGN",
      paymentStatus: "unpaid",
    });

    // WhatsApp: admin runs "odoo sync now".
    await world.text(ADMIN_PHONE, "odoo sync now");
    const reply = bodyText(world.outbound.lastOfType("text", ADMIN_PHONE));
    assertIncludes(reply, "Odoo sync run complete", "sync summary reply");

    // Outbox row for OUR order: sent, exactly once, with an odooRef.
    // (Assertions are scoped to this journey's entities — historical paid
    // orders from earlier journeys share the tenant and also sync.)
    const rows = (await world.db.select().from(schema.odooSyncOutbox)
      .where(eq(schema.odooSyncOutbox.tenantId, TENANT_ID)))
      .filter((r) => r.entityId === orderId);
    assert(rows.length === 1, `exactly one outbox row for the order (got ${rows.length})`);
    const row = rows[0];
    assert(row.entityType === "sale" && row.entityId === orderId, "row identifies the paid order");
    assert(row.status === "sent", `row sent (got ${row.status})`);
    assert(row.attempts === 1, "single attempt");
    assert(row.odooRef?.startsWith("invoice:"), `odoo ref recorded (got ${row.odooRef})`);

    // Mock Odoo state: partner + invoice with integer-cents lines.
    const { getMockOdooAdapter } = await import("../../server/services/odoo/adapter");
    const mock = getMockOdooAdapter(TENANT_ID);
    assert(mock, "mock adapter resolved for tenant");
    const ourInvoices = mock!.state.invoices.filter((i) => i.input.reference.startsWith("ODOO-155-"));
    assert(ourInvoices.length === 1, "exactly one invoice posted for our order");
    const inv = ourInvoices[0];
    assert(inv.input.totalCents === 4230050, `integer cents total (got ${inv.input.totalCents})`);
    assert(inv.input.lines.length === 1 && inv.input.lines[0].unitPriceCents === 4230050, "line cents match");
    assert(typeof inv.input.reference === "string" && inv.input.reference.startsWith("ODOO-155-"), "invoice carries the order number as ref");
    assert(inv.input.partnerRef === "customer:sim-customer-j155", "partner ref derived from customer");
    assert(mock!.state.partners.some((p) => p.ref === "customer:sim-customer-j155"), "partner created");
    // The unpaid order was never enqueued.
    const unpaidRows = (await world.db.select().from(schema.odooSyncOutbox)
      .where(eq(schema.odooSyncOutbox.tenantId, TENANT_ID)))
      .filter((r) => r.entityId === unpaidId);
    assert(unpaidRows.length === 0, "unpaid order never synced");

    // Idempotent re-run: no duplicates, no new sends.
    const again = await tenant.odooSync.syncNow();
    assert(again.worker.sent === 0, "re-run sends nothing");
    assert(again.stats.pending === 0 && again.stats.failed === 0, "stats stable");
    const stillOurs = mock!.state.invoices.filter((i) => i.input.reference.startsWith("ODOO-155-"));
    assert(stillOurs.length === 1, "still exactly one invoice (no dupes)");
    const rowsAfter = (await world.db.select().from(schema.odooSyncOutbox)
      .where(eq(schema.odooSyncOutbox.tenantId, TENANT_ID)))
      .filter((r) => r.entityId === orderId);
    assert(rowsAfter.length === 1, "still exactly one outbox row (exactly-once)");
  },
};
