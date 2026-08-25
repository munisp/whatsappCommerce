/**
 * === W31 scheduled-batch ===
 * J190 — T-1 WhatsApp reminder: a pending payment due within 24h triggers
 * exactly ONE reminder to the tenant admin phone; the metadata.remindedAt
 * marker is claimed BEFORE sending, so cron replays never double-remind.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J190",
  name: "T-1 WhatsApp reminder sent once (metadata.remindedAt dedupe)",
  feature: "W31 scheduled payments: T-1 reminder with claim-before-send dedupe",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const now = new Date();
    // Tenant admin with a real phone (resolveTenantAdminPhone: owner
    // membership → users.phone).
    const adminPhone = world.newPhone("sched190-admin");
    const [u] = await world.db.insert(schema.users).values({
      openId: "sim-j190-admin", name: "J190 Admin", phone: adminPhone, tenantId: TENANT_ID, lastSignedIn: now,
    }).onConflictDoNothing().returning({ id: schema.users.id });
    const uid = u?.id ?? 190001;
    await world.db.insert(schema.tenantMemberships).values({ tenantId: TENANT_ID, userId: String(uid), role: "owner" }).onConflictDoNothing();
    const caller = await tenantCaller(TENANT_ID, { userId: uid });

    // Pending payment due in 12h (inside the T-1 window; wallet irrelevant —
    // reminders never execute the payment).
    const sched = await caller.scheduledPayments.schedule({
      tenantId: TENANT_ID, kind: "adhoc",
      recipient: { name: "Rent — Market Stalls Ltd" },
      amountCents: 750_000, currency: "NGN",
      executeAt: new Date(Date.now() + 12 * 3600 * 1000),
      idempotencyKey: "j190-reminder-1",
    });
    assert(sched.status === "pending", "scheduled pending");

    const before = world.outbound.toPhone(adminPhone).length;
    const tick1 = await world.runCron("/api/scheduled/execute-payments");
    assert(tick1.status === 200, `cron accepted (got ${tick1.status})`);
    assert(tick1.json.remindersSent >= 1, `reminder sent (${JSON.stringify(tick1.json)})`);

    let [row] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, sched.id));
    assert(row.status === "pending", "reminder does NOT execute or claim the payment");
    assert(typeof (row.metadata as any)?.remindedAt === "string", "metadata.remindedAt marker set");

    const reminder = bodyText(world.outbound.lastOfType("text", adminPhone));
    assertIncludes(reminder, "Reminder", "reminder text delivered to admin phone");
    assertIncludes(reminder, "7500.00", "amount included in reminder");

    // ── Cron replays never double-remind ────────────────────────────────
    const tick2 = await world.runCron("/api/scheduled/execute-payments");
    assert(tick2.status === 200, "replay cron accepted");
    assert(tick2.json.remindersSent === 0, `replay sends no reminder (${JSON.stringify(tick2.json)})`);
    const after = world.outbound.toPhone(adminPhone).length;
    assert(after - before === 1, `exactly one reminder message total (got ${after - before})`);
    [row] = await world.db.select().from(schema.scheduledPayments).where(eq(schema.scheduledPayments.id, sched.id));
    assert(row.status === "pending", "payment still pending after reminder ticks");

    // Cleanup: cancel so no later journey's cron tick picks this row up.
    const cancel = await caller.scheduledPayments.cancel({ tenantId: TENANT_ID, id: sched.id });
    assert(cancel.cancelled === true, "fixture cancelled");
  },
};
