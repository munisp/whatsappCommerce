// === W45 messaging-services (Coder A2) ===
/**
 * J358 — Monotonic delivery status (MSG-9): out-of-order receipts never
 * regress whatsapp_notification_log.status (sent < delivered < read; failed
 * terminal). Per-status timestamps still merge newer-wins, so a late
 * "delivered" after "read" is recorded but does not move the scalar.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

async function seedSentRow(world: World, wamid: string, phone: string): Promise<string> {
  const schema = await import("../../drizzle/schema");
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  await world.db.insert(schema.whatsappNotificationLog).values({
    id,
    tenantId: TENANT_ID,
    phone,
    notifType: "conversation_reply",
    status: "sent",
    wamid,
    sentAt: new Date(),
    statusTimestamps: { sent: nowIso },
  });
  return id;
}

export const journey: Journey = {
  id: "J358",
  name: "monotonic delivery status",
  feature: "MSG-9 sent<delivered<read scalar guard, failed terminal",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { applyWaDeliveryStatus } = await import("../../server/services/waSender");
    const phone = world.newPhone("j358");
    const t = Math.floor(Date.now() / 1000);

    // ── read arrives BEFORE delivered: scalar must not regress ─────────
    const wamid = "wamid.j358.a";
    const rowId = await seedSentRow(world, wamid, phone);
    const read = await applyWaDeliveryStatus(world.db, TENANT_ID, { id: wamid, status: "read", timestamp: String(t) });
    assert(read === true, "read receipt applied");
    let [row] = await world.db.select().from(schema.whatsappNotificationLog)
      .where(eq(schema.whatsappNotificationLog.id, rowId));
    assert(row.status === "read", "scalar advanced to read");

    const deliveredLate = await applyWaDeliveryStatus(world.db, TENANT_ID, { id: wamid, status: "delivered", timestamp: String(t + 5) });
    assert(deliveredLate === true, "late delivered receipt still matches the row");
    [row] = await world.db.select().from(schema.whatsappNotificationLog)
      .where(eq(schema.whatsappNotificationLog.id, rowId));
    assert(row.status === "read", `scalar did NOT regress to delivered (got ${row.status})`);
    const stamps = (row.statusTimestamps ?? {}) as Record<string, string>;
    assert(!!stamps.delivered, "late delivered timestamp still merged into statusTimestamps");
    assert(row.deliveredAt == null, "deliveredAt column untouched by the regressive receipt");

    // A stale "sent" replay is also ignored for the scalar.
    await applyWaDeliveryStatus(world.db, TENANT_ID, { id: wamid, status: "sent", timestamp: String(t + 9) });
    [row] = await world.db.select().from(schema.whatsappNotificationLog)
      .where(eq(schema.whatsappNotificationLog.id, rowId));
    assert(row.status === "read", "late sent replay did not regress the scalar");

    // A stale "read" with an OLDER timestamp must not rewrite the newer one.
    const before = ((row.statusTimestamps ?? {}) as Record<string, string>).read;
    await applyWaDeliveryStatus(world.db, TENANT_ID, { id: wamid, status: "read", timestamp: String(t - 3600) });
    [row] = await world.db.select().from(schema.whatsappNotificationLog)
      .where(eq(schema.whatsappNotificationLog.id, rowId));
    assert(((row.statusTimestamps ?? {}) as Record<string, string>).read === before, "older read timestamp did not overwrite the newer one");

    // ── failed is terminal: a post-failure "delivered" is ignored ──────
    const wamid2 = "wamid.j358.b";
    const row2Id = await seedSentRow(world, wamid2, phone);
    await applyWaDeliveryStatus(world.db, TENANT_ID, { id: wamid2, status: "failed", timestamp: String(t), errors: [{ code: 131047, title: "Re-engagement message" }], recipient_id: phone });
    let [row2] = await world.db.select().from(schema.whatsappNotificationLog)
      .where(eq(schema.whatsappNotificationLog.id, row2Id));
    assert(row2.status === "failed", "failed applied");
    assert(!!row2.failReason, "failure summary recorded");
    await applyWaDeliveryStatus(world.db, TENANT_ID, { id: wamid2, status: "delivered", timestamp: String(t + 30) });
    [row2] = await world.db.select().from(schema.whatsappNotificationLog)
      .where(eq(schema.whatsappNotificationLog.id, row2Id));
    assert(row2.status === "failed", `failed is terminal — delivered ignored (got ${row2.status})`);

    // Unknown wamids still ignored quietly.
    const unknown = await applyWaDeliveryStatus(world.db, TENANT_ID, { id: "wamid.j358.unknown", status: "read", timestamp: String(t) });
    assert(unknown === false, "unknown wamid ignored");
  },
};
