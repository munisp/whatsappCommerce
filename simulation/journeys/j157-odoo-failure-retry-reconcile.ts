/**
 * J157 — W28 odoo-sync: failure → deterministic retry → reconciliation
 * surface. With the mock Odoo adapter failing, sync attempts exhaust
 * maxAttempts and the row lands in 'failed' — surfaced via the portal
 * reconciliation queue (outbox.list status=failed) and the WhatsApp
 * "odoo status" command. Retrying after recovery posts exactly ONE invoice
 * (claim-before-send + exactly-once outbox = no dupes on retry), and the
 * nightly cron endpoint (isCron-guarded) drains remaining work.
 */
import crypto from "crypto";
import { assert, assertIncludes, bodyText, ADMIN_PHONE, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J157",
  name: "odoo failure → retry → reconciliation",
  feature: "W28 odoo-sync retry + reconciliation queue",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { eq, and } = await import("drizzle-orm");
    const tenant = await tenantCaller(TENANT_ID);

    await tenant.odooSync.saveConfig({
      url: "mock://odoo", db: "sim-db", username: "api@sim.local",
      apiKey: "k157", syncMode: "ondemand", enabled: true,
    });

    // Prime the mock adapter (resolve once so we can inject failures).
    const { getMockOdooAdapter, getOdooAdapter, MockOdooAdapter } = await import("../../server/services/odoo/adapter");
    await getOdooAdapter(TENANT_ID);
    const mock = getMockOdooAdapter(TENANT_ID) as InstanceType<typeof MockOdooAdapter>;
    assert(mock, "mock adapter resolved");

    // Seed a paid order.
    const orderId = crypto.randomUUID();
    await world.db.insert(schema.orders).values({
      id: orderId, tenantId: TENANT_ID, customerId: "sim-customer-j157",
      orderNumber: `ODOO-157-${crypto.randomUUID().slice(0, 8)}`,
      status: "delivered", totalAmount: "10000.00", currency: "NGN",
      paymentStatus: "completed",
    });

    // Fail hard for a while: maxAttempts (5) worker runs exhaust retries.
    // Must outlast EVERY adapter call the sweep makes — syncNow also drains
    // historical paid orders left by earlier journeys, and the merged W28
    // tree accumulates more of them than Coder A's branch did alone (50 was
    // exhausted mid-sweep → our row flipped to 'sent'). Recovery below sets
    // failNext = 0 explicitly, so an effectively-unbounded budget is safe
    // and deterministic regardless of suite history.
    mock.failNext = 100_000;
    for (let i = 0; i < 5; i++) {
      await tenant.odooSync.syncNow();
    }
    const [failedRow] = await world.db.select().from(schema.odooSyncOutbox)
      .where(and(eq(schema.odooSyncOutbox.tenantId, TENANT_ID), eq(schema.odooSyncOutbox.entityId, orderId)));
    assert(failedRow, "outbox row exists");
    assert(failedRow.status === "failed", `row failed after exhaustion (got ${failedRow.status})`);
    assert(failedRow.attempts === failedRow.maxAttempts, "attempts exhausted deterministically");
    assert(failedRow.lastError?.includes("mock odoo failure"), `error recorded (got ${failedRow.lastError})`);
    assert(mock.state.invoices.length === 0, "nothing posted while failing");

    // Reconciliation surface: portal queue lists the failure (scoped —
    // historical paid orders swept in the same runs may also have failed).
    const queue = await tenant.odooSync.outbox.list({ status: "failed" });
    assert(queue.rows.some((r) => r.id === failedRow.id), "failed row in reconciliation queue");
    assert(queue.stats.failed >= 1, "stats surface the failure");

    // WhatsApp status surfaces it too.
    await world.text(ADMIN_PHONE, "odoo status");
    const status = bodyText(world.outbound.lastOfType("text", ADMIN_PHONE));
    assertIncludes(status, "Failed (needs attention)", "WA status surfaces failure");

    // Recover; retry via the portal action; sync posts exactly once.
    mock.failNext = 0;
    const retried = await tenant.odooSync.outbox.retry({ id: failedRow.id });
    assert(retried.ok === true, "retry requeues the failed row");
    const sync = await tenant.odooSync.syncNow();
    assert(sync.worker.sent >= 1, "retry delivered");
    const ourInvoices = mock.state.invoices.filter((i) => i.input.reference.startsWith("ODOO-157-"));
    assert(ourInvoices.length === 1, "exactly one invoice for our order (no dupes on retry)");
    assert(ourInvoices[0].input.totalCents === 1000000, "integer cents on retried invoice");

    const rows = (await world.db.select().from(schema.odooSyncOutbox)
      .where(eq(schema.odooSyncOutbox.tenantId, TENANT_ID)))
      .filter((r) => r.entityId === orderId);
    assert(rows.length === 1, "still one outbox row for our order (no dupes)");
    assert(rows[0].status === "sent" && rows[0].odooRef?.startsWith("invoice:"), "row sent with ref");
    const statsAfter = await tenant.odooSync.outbox.list({ status: "failed" });
    assert(!statsAfter.rows.some((r) => r.entityId === orderId), "our row cleared from reconciliation queue");

    // Nightly cron: isCron-guarded, drains batch-mode tenants idempotently.
    const denied = await world.runCron("/api/scheduled/odoo-sync").catch(() => null);
    assert(denied && denied.status === 200, `cron endpoint runs (got ${denied?.status})`);
    assert(denied.json?.ok === true, "cron ok");
    const afterCron = mock.state.invoices.filter((i) => i.input.reference.startsWith("ODOO-157-"));
    assert(afterCron.length === 1, "cron posts no dupes");
  },
};
