// === W31 ar-invoices ===
/**
 * J195 — Overdue sweep + reminder cadence: past-due sent invoice flips to
 * overdue via /api/scheduled/ar-reminders; polite WA reminders max 3 with
 * 3-day spacing (last_reminder_at dedupe), then the cadence stops.
 */
import { eq } from "drizzle-orm";
import { assert, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

const DAY = 86400000;

async function invoiceRow(world: World, id: string) {
  const schema = await import("../../drizzle/schema");
  const [i] = await world.db.select().from(schema.arInvoices).where(eq(schema.arInvoices.id, id)).limit(1);
  return i;
}

async function reminderCount(world: World, phone: string): Promise<number> {
  return world.outbound.findByBody("Friendly reminder", phone).length;
}

export const journey: Journey = {
  id: "J195",
  name: "AR overdue sweep → 3-spaced reminders → stop",
  feature: "W31 AR reminders cron (max 3, 3d spacing, dedupe)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();
    const customer = world.newPhone("arr");

    const inv = await caller.arInvoices.create({
      tenantId: TENANT_ID,
      customerName: "Chika Remind",
      customerPhone: customer,
      description: "J195 overdue invoice",
      amountCents: 500_000, // ₦5,000
      currency: "NGN",
      dueDate: new Date(Date.now() + DAY).toISOString(),
    });
    const sent = await caller.arInvoices.send({ tenantId: TENANT_ID, invoiceId: inv.id });
    assert(sent.paymentUrl, "link minted");

    // Push the due date into the past (sim time travel for the sweep).
    await world.db.update(schema.arInvoices)
      .set({ dueDate: new Date(Date.now() - DAY) })
      .where(eq(schema.arInvoices.id, inv.id));

    // ── Sweep 1: flip overdue + reminder #1 ──────────────────────────────
    const c1 = await world.runCron("/api/scheduled/ar-reminders");
    assert(c1.status === 200, `cron accepted (got ${c1.status})`);
    assert((c1.json?.overdueFlipped ?? 0) >= 1, "overdue flip counted");
    assert((c1.json?.remindersSent ?? 0) >= 1, `reminder #1 sent (${JSON.stringify(c1.json)})`);
    let cur = await invoiceRow(world, inv.id);
    assert(cur.status === "overdue", `overdue (got ${cur.status})`);
    assert(cur.reminderCount === 1, `reminder_count 1 (got ${cur.reminderCount})`);
    await world.waitFor(async () => (await reminderCount(world, customer)) >= 1, 8000, "reminder #1 WA delivered");

    // ── Sweep 2 same day: spacing dedupe — NO second reminder ────────────
    const c2 = await world.runCron("/api/scheduled/ar-reminders");
    assert((c2.json?.remindersSent ?? 0) === 0, `spacing dedupe (got ${JSON.stringify(c2.json)})`);
    cur = await invoiceRow(world, inv.id);
    assert(cur.reminderCount === 1, "still 1 reminder within 3-day spacing");

    // ── Time-travel last_reminder_at back 3 days → reminder #2 ───────────
    await world.db.update(schema.arInvoices)
      .set({ lastReminderAt: new Date(Date.now() - 3 * DAY - 60000) })
      .where(eq(schema.arInvoices.id, inv.id));
    const c3 = await world.runCron("/api/scheduled/ar-reminders");
    assert((c3.json?.remindersSent ?? 0) >= 1, "reminder #2 after spacing");
    cur = await invoiceRow(world, inv.id);
    assert(cur.reminderCount === 2, `reminder_count 2 (got ${cur.reminderCount})`);

    // ── …and again → reminder #3 (final) ─────────────────────────────────
    await world.db.update(schema.arInvoices)
      .set({ lastReminderAt: new Date(Date.now() - 3 * DAY - 60000) })
      .where(eq(schema.arInvoices.id, inv.id));
    await world.runCron("/api/scheduled/ar-reminders");
    cur = await invoiceRow(world, inv.id);
    assert(cur.reminderCount === 3, `reminder_count 3 (got ${cur.reminderCount})`);
    await world.waitFor(async () => (await reminderCount(world, customer)) >= 3, 8000, "all 3 reminders delivered");

    // ── Cadence stops: max 3 ─────────────────────────────────────────────
    await world.db.update(schema.arInvoices)
      .set({ lastReminderAt: new Date(Date.now() - 3 * DAY - 60000) })
      .where(eq(schema.arInvoices.id, inv.id));
    const c5 = await world.runCron("/api/scheduled/ar-reminders");
    cur = await invoiceRow(world, inv.id);
    assert(cur.reminderCount === 3, `max 3 enforced (got ${cur.reminderCount})`);
    const body = bodyText(world.outbound.lastOfType("text", customer));
    assert(body.includes("final reminder") || (await reminderCount(world, customer)) === 3, "final reminder wording or count holds");
  },
};
