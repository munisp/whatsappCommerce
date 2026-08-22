/**
 * J156 — W28 odoo-sync: confirmed expense → Odoo vendor bill + receipt
 * attachment. A merchant-confirmed expense is swept into the outbox and the
 * worker posts a vendor bill with exact integer cents; an expense confirmed
 * through the WhatsApp receipt flow (onExpenseConfirmed hook with receipt
 * image) enqueues immediately (push mode) and the receipt is attached to
 * the bill. Unconfirmed (awaiting_receipt / pending_confirm) expenses are
 * never synced.
 */
import crypto from "crypto";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J156",
  name: "odoo expense → vendor bill + receipt",
  feature: "W28 odoo-sync expense → vendor bill",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const tenant = await tenantCaller(TENANT_ID);

    // Push mode: event hooks deliver immediately.
    await tenant.odooSync.saveConfig({
      url: "mock://odoo", db: "sim-db", username: "api@sim.local",
      apiKey: "k156", syncMode: "push", enabled: true,
    });

    // ── 1. Manual confirmed expense (router) → sweep picks it up ────────
    const added = await (tenant as any).bookkeeping.expenses.add({
      amount: "1250.75", vendor: "Musa Supplies", category: "stock",
    });
    // A pending (awaiting receipt) expense must NOT sync.
    await world.db.insert(schema.expenses).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, amountCents: 999999,
      expenseDate: new Date(), status: "awaiting_receipt", source: "receipt_photo",
    });

    const sync1 = await tenant.odooSync.syncNow();
    assert(sync1.sweep.expensesEnqueued === 1, `one expense swept (got ${sync1.sweep.expensesEnqueued})`);
    assert(sync1.worker.sent >= 1, "vendor bill posted");

    const { getMockOdooAdapter } = await import("../../server/services/odoo/adapter");
    const mock = getMockOdooAdapter(TENANT_ID);
    assert(mock, "mock adapter resolved");
    // Scoped to this journey's vendor (historical paid orders may also sync).
    const musaBills = mock!.state.vendorBills.filter((b) => b.input.vendorName === "Musa Supplies");
    assert(musaBills.length === 1, "exactly one vendor bill for our expense");
    const bill = musaBills[0];
    assert(bill.input.amountCents === 125075, `integer cents (got ${bill.input.amountCents})`);
    assert(bill.input.vendorName === "Musa Supplies", "vendor carried");
    assert(bill.input.category === "stock", "category carried");

    // ── 2. Receipt-photo confirm (push mode): immediate post + attachment ──
    const { onExpenseConfirmed } = await import("../../server/services/odoo/sync");
    const receiptExpense = {
      id: crypto.randomUUID(),
      tenantId: TENANT_ID,
      amountCents: 42000,
      currency: "NGN",
      vendor: "Adaeze Wholesale",
      category: "stock",
      expenseDate: new Date("2026-02-10T00:00:00Z"),
      status: "confirmed",
      source: "receipt_photo",
      note: "market run",
      mediaId: "wa-media-1",
    };
    await world.db.insert(schema.expenses).values(receiptExpense as any);
    const b64 = Buffer.from("fake-jpeg-bytes-j156").toString("base64");
    await onExpenseConfirmed(world.db, TENANT_ID, receiptExpense, { base64: b64, mimeType: "image/jpeg" });

    // Push mode → delivered synchronously by the hook.
    const adaezeBills = mock!.state.vendorBills.filter((b) => b.input.vendorName === "Adaeze Wholesale");
    assert(adaezeBills.length === 1, "second vendor bill posted on event (push)");
    const bill2 = adaezeBills[0];
    assert(bill2.input.amountCents === 42000, "receipt expense cents");
    assert(bill2.input.expenseDate === "2026-02-10", "expense date carried");
    assert(mock!.state.attachments.length === 1, "receipt attached");
    const att = mock!.state.attachments[0];
    assert(att.att.billId === bill2.id, "attachment bound to the right bill");
    assert(att.att.base64 === b64 && att.att.mimeType === "image/jpeg", "receipt bytes carried");

    const expenseRows = (await world.db.select().from(schema.odooSyncOutbox)
      .where(eq(schema.odooSyncOutbox.tenantId, TENANT_ID)))
      .filter((r) => r.entityType === "expense");
    assert(expenseRows.length === 2, `two expense outbox rows (got ${expenseRows.length})`);
    assert(expenseRows.every((r) => r.status === "sent"), "both sent");
    assert(expenseRows.every((r) => r.odooRef?.startsWith("bill:")), "bill refs recorded");

    // Re-run is a no-op (exactly-once).
    const sync2 = await tenant.odooSync.syncNow();
    assert(sync2.sweep.expensesEnqueued === 0 && sync2.worker.sent === 0, "no re-sync");
    assert(mock!.state.vendorBills.filter((b) => b.input.vendorName === "Musa Supplies").length === 1, "no duplicate bills");
    assert(mock!.state.vendorBills.filter((b) => b.input.vendorName === "Adaeze Wholesale").length === 1, "no duplicate receipt bill");
    assert(mock!.state.attachments.length === 1, "still exactly one attachment");
  },
};
