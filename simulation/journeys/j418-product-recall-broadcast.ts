// === W46 orders-p2 (Coder G) ===
/**
 * J418 — ORD-22: product recall → targeted broadcast. Buyers of the recalled
 * product inside the date range get the notice; buyers without consent are
 * NEVER sent and are durably logged as skipped_opt_out; re-dispatch is
 * exactly-once per order; orders outside the range are untouched.
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedOrder } from "./w46-orders-seed";

export const journey: Journey = {
  id: "J418",
  name: "product recall targeted broadcast with opt-out logging",
  feature: "ORD-22 recalls.dispatchRecall",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { createRecall, dispatchRecall, getRecallStats } = await import("../../server/services/recalls");

    const productId = `prod-w46-j418`;
    const inRange = new Date(Date.now() - 5 * 86_400_000);
    const outOfRange = new Date(Date.now() - 90 * 86_400_000);

    // Two affected orders in range (one consented buyer, one not) + one
    // outside the range that must be left alone.
    const consented = await seedOrder(world, "j418a", { productId, createdAt: inRange });
    const optedOut = await seedOrder(world, "j418b", { productId, createdAt: inRange });
    const outside = await seedOrder(world, "j418c", { productId, createdAt: outOfRange });
    await world.grantConsent(consented.phone);

    const recall = await createRecall(world.db, {
      tenantId: TENANT_ID,
      productId,
      reason: "Batch 42 contamination risk — stop use immediately",
      fromDate: new Date(Date.now() - 30 * 86_400_000),
      toDate: new Date(),
      createdBy: "j418",
    });
    assert(recall.status === "draft", "recall starts as draft");

    const res = await dispatchRecall(world.db, { tenantId: TENANT_ID, recallId: recall.id });
    assert(res.affectedOrders === 2, `2 orders in range affected (got ${res.affectedOrders})`);
    assert(res.sent === 1, `consented buyer sent (got sent=${res.sent})`);
    assert(res.skippedOptOut === 1, `non-consented buyer logged as opt-out (got ${res.skippedOptOut})`);

    await world.waitFor(
      () => world.outbound.findByBody("Product recall notice", consented.phone).length > 0,
      5000,
      "recall notice",
    );
    const notice = world.outbound.findByBody("Product recall notice", consented.phone).pop();
    assert(notice, "consented buyer received the recall notice");
    assert(world.outbound.findByBody("Product recall notice", optedOut.phone).length === 0,
      "opted-out buyer was NOT contacted");

    // Durable opt-out logging.
    const recipients = await world.db.select().from(schema.recallRecipients)
      .where(eq(schema.recallRecipients.recallId, recall.id));
    assert(recipients.length === 2, "one recipient row per affected order");
    const skipped = recipients.filter((r: any) => r.status === "skipped_opt_out");
    assert(skipped.length === 1 && skipped[0].orderId === optedOut.orderId && !skipped[0].sentAt,
      "opt-out logged durably (skipped_opt_out, never sent)");
    const sentRows = recipients.filter((r: any) => r.status === "sent");
    assert(sentRows.length === 1 && sentRows[0].orderId === consented.orderId && sentRows[0].sentAt,
      "sent recipient stamped");

    // The out-of-range order has NO recipient row.
    const outsideRows = recipients.filter((r: any) => r.orderId === outside.orderId);
    assert(outsideRows.length === 0, "order outside the date range untouched");

    // Exactly-once re-dispatch: no new rows, no new sends.
    const beforeCount = world.outbound.toPhone(consented.phone).length;
    const res2 = await dispatchRecall(world.db, { tenantId: TENANT_ID, recallId: recall.id });
    assert(res2.sent === 0 && res2.skippedOptOut === 0, "re-dispatch sends nothing new");
    const recipients2 = await world.db.select().from(schema.recallRecipients)
      .where(eq(schema.recallRecipients.recallId, recall.id));
    assert(recipients2.length === 2, "no duplicate recipient rows");
    assert(world.outbound.toPhone(consented.phone).length === beforeCount, "buyer not double-notified");

    // Stats surface the opt-out count for the merchant.
    const stats = await getRecallStats(world.db, { tenantId: TENANT_ID, recallId: recall.id });
    assert(stats.recall.status === "completed", "recall completed after dispatch");
    assert(stats.recipients.sent === 1 && stats.recipients.skipped_opt_out === 1, "stats include opt-out count");

    // Tenant scoping: another tenant cannot dispatch this recall.
    let scoped = false;
    try {
      await dispatchRecall(world.db, { tenantId: "sim-other", recallId: recall.id });
    } catch (e: any) {
      scoped = e?.code === "NOT_FOUND";
    }
    assert(scoped, "cross-tenant dispatch refused");
    void and;
  },
};
// === END W46 orders-p2 ===
