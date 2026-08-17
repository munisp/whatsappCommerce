/**
 * J66 — Supplier-direct settlement (W13). A credit PO approved by the
 * supplier draws on the facility and settles DIRECTLY to the supplier: the
 * PO reaches its paid/fulfillable state ('paid', notes "Paid via credit
 * draw …") with NO payment link ever issued — zero paystack initialize
 * outbounds, zero payment intents, zero checkout URLs in buyer messages.
 * The supplier sees the funds-credit event (the invoice_draw ledger row +
 * the approval ack); the buyer sees "Paid via credit — due {date}".
 */
import { eq } from "drizzle-orm";
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
  id: "J66",
  name: "supplier-direct settlement",
  feature: "credit PO → paid-via-credit, zero payment-link outbounds",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const before = await enableProcurementMenu(world);
    const po = await buildProcurementPoViaChat(world, phone, { paymentMode: "credit" });

    // Snapshot pay-link surfaces BEFORE approval, then approve on credit.
    const payInitsBefore = world.outbound.all().filter((c) =>
      c.url.includes("api.paystack.co/transaction/initialize") ||
      c.url.includes("api.flutterwave.com/v3/payments"),
    ).length;
    await world.supplierButtonReply(SUPPLIER_ADMIN_PHONE, `po_approve:${po.poId}`, "Approve");

    // ── PO reaches its paid/fulfillable state — NO payment link ──────────
    const [row] = await world.db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, po.poId)).limit(1);
    assert(row.status === "paid", `PO paid-via-credit after the draw (got ${row.status})`);
    assert(typeof row.notes === "string" && row.notes.includes("Paid via credit draw"), `settlement note recorded (got ${row.notes})`);
    assert(row.creditAccountId, "PO linked to the credit account");
    assert(row.dueDate, "PO due_date set (net 14)");

    // Zero payment-link outbounds for the credit PO.
    const payInitsAfter = world.outbound.all().filter((c) =>
      c.url.includes("api.paystack.co/transaction/initialize") ||
      c.url.includes("api.flutterwave.com/v3/payments"),
    ).length;
    assert(payInitsAfter === payInitsBefore, "NO provider payment-link initialization for the credit PO");
    const intents = await world.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.orderId, po.poId));
    assert(intents.length === 0, "no payment intent rows for the credit PO");
    const buyerTexts = world.outbound.toPhone(phone).map((c) => bodyText(c)).join("\n");
    assert(!/checkout\.(paystack|flutterwave)\.com/.test(buyerTexts), "buyer never receives a checkout URL");

    // ── Buyer sees "Paid via credit — due {date}" ────────────────────────
    const buyerMsg = world.outbound.findByBody("Paid via credit", phone).pop();
    assert(buyerMsg, "buyer notified: paid via credit");
    const buyerText = bodyText(buyerMsg);
    assertIncludes(buyerText, po.poNumber, "buyer notice references the PO");
    assertIncludes(buyerText, "due", "buyer notice carries the due date");
    assertIncludes(buyerText, "net 14d", "buyer notice carries the terms");

    // ── Supplier sees the funds-credit event ──────────────────────────────
    const supplierAck = bodyText(world.outbound.lastOfType("text", SUPPLIER_ADMIN_PHONE));
    assertIncludes(supplierAck, "approved on credit", "supplier ack confirms the credit settlement");
    assertIncludes(supplierAck, po.poNumber, "supplier ack references the PO");
    const draws = await creditLedgerRows(world, "invoice_draw");
    assert(draws.length === 1, "one invoice_draw funds-credit row");
    assert(draws[0].poId === po.poId && Number(draws[0].amountCents) === po.subtotalCents, "draw = the PO subtotal");
    assert(draws[0].status === "posted", "draw posted (awaiting repayment)");
    assert(Number((await creditAccount(world)).outstandingCents) === po.subtotalCents, "outstanding = the draw");

    // The supplier can fulfil immediately: the PO is not awaiting any buyer payment.
    assert(row.paymentMode === "credit", "PO stays a credit PO");

    await restoreMenu(world, before);
  },
};
