// === W45 messaging-services (Coder A2) ===
/**
 * J359 — Suppression list (MSG-10): a failed delivery receipt with a
 * permanent recipient-level Meta error code (131026) puts the number on the
 * tenant's suppression list; transient codes (131047 window) do not.
 * Suppressed numbers are excluded from the broadcast audience and the WA
 * send-retry sweep skips them (retry schedule cleared).
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J359",
  name: "delivery-failure suppression list",
  feature: "MSG-10 suppression consulted by broadcast + retries",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { applyWaDeliveryStatus, runWaSendRetries } = await import("../../server/services/waSender");
    const { isSuppressed, addToSuppressionList, removeFromSuppressionList, getSuppressedPhones } =
      await import("../../server/services/waSuppressionList");
    const phone = world.newPhone("j359a");
    const phoneCtrl = world.newPhone("j359b");
    await world.grantConsent(phone);
    await world.grantConsent(phoneCtrl);
    const t = Math.floor(Date.now() / 1000);

    // ── Failed receipt with 131026 suppresses; 131047 does not ─────────
    for (const [wamid, p, code] of [
      ["wamid.j359.sup", phone, 131026],
      ["wamid.j359.ctrl", phoneCtrl, 131047],
    ] as const) {
      await world.db.insert(schema.whatsappNotificationLog).values({
        id: crypto.randomUUID(),
        tenantId: TENANT_ID,
        phone: p,
        notifType: "conversation_reply",
        status: "sent",
        wamid,
        sentAt: new Date(),
      });
      await applyWaDeliveryStatus(world.db, TENANT_ID, {
        id: wamid,
        status: "failed",
        timestamp: String(t),
        recipient_id: p,
        errors: [{ code, title: code === 131026 ? "Message undeliverable" : "Re-engagement message" }],
      });
    }
    assert(await isSuppressed(world.db, TENANT_ID, phone), "131026 recipient suppressed");
    assert(!(await isSuppressed(world.db, TENANT_ID, phoneCtrl)), "131047 (window) is NOT a suppression signal");
    const supRows = await world.db.select().from(schema.waSuppressionList)
      .where(eq(schema.waSuppressionList.tenantId, TENANT_ID));
    assert(supRows.some((r) => r.phone === phone && r.reasonCode === "131026"), "durable PG suppression row written");

    // ── Broadcast audience excludes suppressed numbers ──────────────────
    for (const [p, name] of [[phone, "Sup Pressed"], [phoneCtrl, "Ctrl Customer"]] as const) {
      await world.db.insert(schema.customers).values({
        id: `cust-${p}`, tenantId: TENANT_ID, whatsappPhone: p, name,
      }).onConflictDoNothing();
    }
    const { buildBroadcastAudience } = await import("../../server/routers/broadcast");
    const audience = await buildBroadcastAudience(world.db, TENANT_ID);
    assert(!audience.some((m) => m.phone === phone), "suppressed phone excluded from broadcast audience");
    assert(audience.some((m) => m.phone === phoneCtrl), "control phone still in the audience");

    // ── Retry sweep skips suppressed numbers (and clears the schedule) ──
    const past = new Date(Date.now() - 60_000);
    const supRetryId = crypto.randomUUID();
    const ctrlRetryId = crypto.randomUUID();
    const retryPayload = { type: "text", text: { preview_url: true, body: "retry me" } };
    await world.db.insert(schema.whatsappNotificationLog).values([
      { id: supRetryId, tenantId: TENANT_ID, phone, notifType: "conversation_reply", status: "failed", payload: retryPayload, attempts: 1, nextRetryAt: past },
      { id: ctrlRetryId, tenantId: TENANT_ID, phone: phoneCtrl, notifType: "conversation_reply", status: "failed", payload: retryPayload, attempts: 1, nextRetryAt: past },
    ]);
    // W45 merger: the sweep defaults to limit 25 with no ORDER BY — leftover
    // failed rows from earlier merged-suite journeys can push this journey's
    // rows past the cap (full-suite-only flake). Pass an explicit limit so
    // both of this journey's rows are always in the selected batch.
    const run = await runWaSendRetries({ now: new Date(), limit: 1000 });
    assert(run.skipped >= 1, `suppressed row skipped (got ${JSON.stringify(run)})`);
    const [supRow] = await world.db.select().from(schema.whatsappNotificationLog)
      .where(eq(schema.whatsappNotificationLog.id, supRetryId));
    assert(supRow.nextRetryAt == null, "suppressed row retry schedule cleared");
    assert(supRow.status === "failed", "suppressed row not re-sent");
    const [ctrlRow] = await world.db.select().from(schema.whatsappNotificationLog)
      .where(eq(schema.whatsappNotificationLog.id, ctrlRetryId));
    assert(ctrlRow.status === "sent", `control row retried successfully (got ${ctrlRow.status})`);

    // ── Removal path (number ported back / ops override) ────────────────
    await removeFromSuppressionList(world.db, TENANT_ID, phone);
    assert(!(await isSuppressed(world.db, TENANT_ID, phone)), "removal clears suppression");
    // Re-add idempotently (unique tenant+phone).
    await addToSuppressionList(world.db, TENANT_ID, phone, { reasonCode: "131026", source: "manual" });
    await addToSuppressionList(world.db, TENANT_ID, phone, { reasonCode: "131026", source: "manual" });
    const set = await getSuppressedPhones(world.db, TENANT_ID);
    assert(set.has(phone), "re-added phone in the tenant suppression set");
  },
};
