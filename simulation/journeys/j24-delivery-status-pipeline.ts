/**
 * J24 — Delivery status pipeline: sent→delivered→read callbacks update the
 * notification log; a retriable send failure is rescheduled by the retry
 * cron and recovered; a permanent failure dead-letters with an admin alert.
 */
import { desc, eq } from "drizzle-orm";
import { ADMIN_PHONE, assert, assertIncludes, bodyText, type World } from "../world";
import { failNextSends } from "../metaMock";
import type { Journey } from "../runner";

async function latestLogRow(world: World, phone: string) {
  const schema = await import("../../drizzle/schema");
  const [row] = await world.db
    .select()
    .from(schema.whatsappNotificationLog)
    .where(eq(schema.whatsappNotificationLog.phone, phone))
    .orderBy(desc(schema.whatsappNotificationLog.createdAt))
    .limit(1);
  return row ?? null;
}

export const journey: Journey = {
  id: "J24",
  name: "delivery status pipeline",
  feature: "status callbacks + retry/dead-letter cron",
  async run(world) {
    const schema = await import("../../drizzle/schema");

    // ── sent → delivered → read ──────────────────────────────────────────
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    world.llm.when("status pipeline hello", {
      reply: "Hello from the status pipeline!",
      intent: "greeting",
      nextState: "browse",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.9,
    });
    await world.text(phone, "status pipeline hello");
    const logRow = await latestLogRow(world, phone);
    assert(logRow?.wamid, "outbound send logged with a wamid");
    assert(["sent", "pending"].includes(logRow.status), `send logged as sent/pending (got ${logRow.status})`);

    await world.status(logRow.wamid, "delivered", { recipientId: phone });
    let [updated] = await world.db.select().from(schema.whatsappNotificationLog).where(eq(schema.whatsappNotificationLog.id, logRow.id)).limit(1);
    assert(updated.status === "delivered", `delivered callback updated the log (got ${updated.status})`);

    await world.status(logRow.wamid, "read", { recipientId: phone });
    [updated] = await world.db.select().from(schema.whatsappNotificationLog).where(eq(schema.whatsappNotificationLog.id, logRow.id)).limit(1);
    assert(updated.status === "read", "read callback updated the log");

    const receipts = await world.db.select().from(schema.waMessageDeliveryReceipts)
      .where(eq(schema.waMessageDeliveryReceipts.waMessageId, logRow.wamid));
    assert(receipts.length === 2, "both status callbacks recorded as delivery receipts");

    // ── Retriable failure → retry reschedules → recovered ────────────────
    const phone2 = world.newPhone("b");
    await world.grantConsent(phone2);
    failNextSends(500, 1, (body) => body?.type === "text" && body?.to === phone2);
    world.llm.when("retry me please", {
      reply: "This reply fails once, then succeeds.",
      intent: "greeting",
      nextState: "browse",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.9,
    });
    await world.text(phone2, "retry me please");
    const failedRow = await latestLogRow(world, phone2);
    assert(failedRow?.status === "failed", `send marked failed after Graph 500 (got ${failedRow?.status})`);
    assert(failedRow.nextRetryAt != null, "retriable failure got a retry schedule");

    // Immediate retry run: backoff means nothing is due yet.
    const early = await world.runCron("/api/scheduled/wa-send-retry");
    assert(early.status === 200, "retry cron ok");
    assert((early.json?.run?.resent ?? 0) === 0, "no retry before the backoff elapses");

    // Backdate the schedule → retry succeeds.
    await world.backdate(`UPDATE whatsapp_notification_log SET "nextRetryAt" = NOW() - INTERVAL '1 minute' WHERE id = $1`, [failedRow.id]);
    const retry = await world.runCron("/api/scheduled/wa-send-retry");
    assert(retry.json?.run?.resent >= 1, `retry run resent (got ${JSON.stringify(retry.json?.run)})`);
    const [recovered] = await world.db.select().from(schema.whatsappNotificationLog).where(eq(schema.whatsappNotificationLog.id, failedRow.id)).limit(1);
    assert(recovered.status === "sent", "log row recovered to sent after retry");
    assert((recovered.attempts ?? 0) >= 1, `attempt counter incremented (got ${recovered.attempts})`);

    // ── Permanent failure → dead-letter + admin alert ────────────────────
    const phone3 = world.newPhone("c");
    await world.grantConsent(phone3);
    // First failure retriable (so a retry is scheduled)…
    failNextSends(500, 1, (body) => body?.to === phone3);
    world.llm.when("permanent failure please", {
      reply: "This one will die.",
      intent: "greeting",
      nextState: "browse",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.9,
    });
    await world.text(phone3, "permanent failure please");
    const row3 = await latestLogRow(world, phone3);
    assert(row3?.status === "failed" && row3.nextRetryAt != null, "first failure retriable and scheduled");

    // …then the retry itself hits a permanent Graph 400.
    failNextSends(400, 1, (body) => body?.to === phone3);
    await world.backdate(`UPDATE whatsapp_notification_log SET "nextRetryAt" = NOW() - INTERVAL '1 minute' WHERE id = $1`, [row3.id]);
    const adminBase = world.outbound.toPhone(ADMIN_PHONE).length;
    const deadRun = await world.runCron("/api/scheduled/wa-send-retry");
    assert(deadRun.json?.run?.dead >= 1, `permanent failure dead-lettered (got ${JSON.stringify(deadRun.json?.run)})`);
    const [dead] = await world.db.select().from(schema.whatsappNotificationLog).where(eq(schema.whatsappNotificationLog.id, row3.id)).limit(1);
    assert(dead.status === "dead", "row marked dead");
    assert(dead.nextRetryAt == null, "no further retries for the dead row");

    await world.waitFor(() => world.outbound.toPhone(ADMIN_PHONE).length > adminBase, 8000, "admin dead-letter alert sent");
    const alert = bodyText(world.outbound.toPhone(ADMIN_PHONE)[adminBase]);
    assertIncludes(alert, "dead-lettered", "admin alert mentions the dead-letter");
    assertIncludes(alert, phone3, "admin alert names the recipient");
  },
};
