/**
 * J34 — Overdraw refusal: with ₦490,000 already outstanding on the ₦500,000
 * facility, approving a ₦29,000 PO exceeds the limit → drawOnCredit returns
 * over_limit → the PO is NOT invoiced; the buyer gets the fallback options
 * (pay now / request limit increase / leave it); the ledger is untouched.
 */
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { SUPPLIER_ADMIN_PHONE, CREDIT_ACCOUNT_ID } from "../world";
import {
  buildProcurementPoViaChat,
  creditAccount,
  creditLedgerRows,
  enableProcurementMenu,
  restoreMenu,
} from "./helpers";

export const journey: Journey = {
  id: "J34",
  name: "overdraw refusal",
  feature: "drawOnCredit over_limit → buyer fallback, no ledger write",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const before = await enableProcurementMenu(world);

    // Outstanding at ₦490,000 — a ₦29,000 draw would breach the ₦500,000 limit.
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    await world.db
      .update(schema.creditAccounts)
      .set({ outstandingCents: 49_000_000, updatedAt: new Date() })
      .where(eq(schema.creditAccounts.id, CREDIT_ACCOUNT_ID));

    const po = await buildProcurementPoViaChat(world, phone, { paymentMode: "credit" });
    const ledgerBefore = (await creditLedgerRows(world)).length;

    await world.supplierButtonReply(SUPPLIER_ADMIN_PHONE, `po_approve:${po.poId}`, "Approve");

    // ── Supplier told the draw was refused ────────────────────────────────
    const supplierReply = bodyText(world.outbound.lastOfType("text", SUPPLIER_ADMIN_PHONE));
    assertIncludes(supplierReply, "Can't approve", "supplier told the approval failed");
    assertIncludes(supplierReply, "credit limit is too low", "over-limit reason surfaced");

    // ── PO NOT invoiced; still awaiting approval ──────────────────────────
    const [row] = await world.db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, po.poId)).limit(1);
    assert(row.status === "submitted", `PO NOT invoiced on over-limit (got ${row.status})`);
    assert(!row.dueDate, "no due_date on a refused draw");

    // ── Buyer receives the fallback options ───────────────────────────────
    const buyerMsg = world.outbound.findByBody("couldn't be approved on credit", phone).pop();
    assert(buyerMsg, "buyer received the credit-refusal fallback");
    const buyerText = bodyText(buyerMsg);
    assertIncludes(buyerText, po.poNumber, "fallback references the PO");
    assertIncludes(buyerText, "Pay now instead", "fallback offers pay-now");
    assertIncludes(buyerText, "Request a credit limit increase", "fallback offers limit increase");

    // ── Money state untouched ─────────────────────────────────────────────
    const account = await creditAccount(world);
    assert(Number(account.outstandingCents) === 49_000_000, `outstanding unchanged (got ${account.outstandingCents})`);
    const ledgerAfter = await creditLedgerRows(world);
    assert(ledgerAfter.length === ledgerBefore, `ledger unchanged (${ledgerBefore} → ${ledgerAfter.length})`);
    assert(ledgerAfter.every((r: any) => r.poId !== po.poId), "no ledger row for the refused PO");

    await restoreMenu(world, before);
  },
};
