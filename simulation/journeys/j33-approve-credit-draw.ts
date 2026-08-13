/**
 * J33 — Supplier approve → credit draw: the supplier taps Approve on the
 * action card → drawOnCredit succeeds → PO jumps submitted → invoiced with
 * due_date = now + 14d; the buyer is notified; outstanding rises by the
 * subtotal; an invoice_draw ledger row carries the due date.
 */
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { SUPPLIER_ADMIN_PHONE } from "../world";
import {
  buildProcurementPoViaChat,
  creditAccount,
  creditLedgerRows,
  enableProcurementMenu,
  restoreMenu,
} from "./helpers";

export const journey: Journey = {
  id: "J33",
  name: "approve → credit draw",
  feature: "po_approve → drawOnCredit → invoiced + ledger",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const before = await enableProcurementMenu(world);
    const po = await buildProcurementPoViaChat(world, phone, { paymentMode: "credit" });

    const approvedAt = Date.now();
    await world.supplierButtonReply(SUPPLIER_ADMIN_PHONE, `po_approve:${po.poId}`, "Approve");

    // ── Supplier-side ack ─────────────────────────────────────────────────
    const supplierReply = bodyText(world.outbound.lastOfType("text", SUPPLIER_ADMIN_PHONE));
    assertIncludes(supplierReply, "approved on credit", "supplier told the draw succeeded");
    assertIncludes(supplierReply, po.poNumber, "supplier ack references the PO");

    // ── PO paid-via-credit with due date now+14d (W13 supplier-direct
    // settlement flips invoiced → paid; no payment link is ever issued) ────
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await world.db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, po.poId)).limit(1);
    assert(row.status === "paid", `PO paid-via-credit after credit draw (got ${row.status})`);
    assert(row.dueDate, "PO due_date set");
    const dueMs = new Date(row.dueDate).getTime();
    const expected = approvedAt + 14 * 24 * 60 * 60 * 1000;
    assert(Math.abs(dueMs - expected) < 60_000, `due_date ≈ now+14d (got ${row.dueDate})`);
    assert(row.creditAccountId, "PO linked to the credit account");

    // ── Buyer notified "approved on credit … due <date>" ──────────────────
    const buyerMsg = world.outbound.findByBody("approved on credit", phone).pop();
    assert(buyerMsg, "buyer notified of credit approval");
    const buyerText = bodyText(buyerMsg);
    assertIncludes(buyerText, po.poNumber, "buyer notice references the PO");
    assertIncludes(buyerText, "₦29,000.00", "buyer notice shows the amount");
    assertIncludes(buyerText, "due", "buyer notice carries a due date");
    assertIncludes(buyerText, "net 14d", "buyer notice carries the terms");

    // ── Credit account + ledger ───────────────────────────────────────────
    const account = await creditAccount(world);
    assert(Number(account.outstandingCents) === 2_900_000, `outstanding rose by subtotal (got ${account.outstandingCents})`);
    assert(account.status === "active", "account stays active");

    const draws = await creditLedgerRows(world, "invoice_draw");
    assert(draws.length === 1, `one invoice_draw ledger row (got ${draws.length})`);
    const draw = draws[0];
    assert(Number(draw.amountCents) === 2_900_000, "draw amount = PO subtotal");
    assert(draw.poId === po.poId, "draw linked to the PO");
    assert(draw.status === "posted", "draw posted");
    assert(draw.dueDate, "draw due_date set");
    assert(Math.abs(new Date(draw.dueDate).getTime() - expected) < 60_000, "draw due_date ≈ now+14d");

    await restoreMenu(world, before);
  },
};
