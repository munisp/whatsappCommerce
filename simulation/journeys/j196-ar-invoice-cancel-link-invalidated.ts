// === W31 ar-invoices ===
/**
 * J196 — Cancel an unpaid AR invoice: the public payment link answers
 * honestly expired (410-equivalent PRECONDITION_FAILED), recordPayment
 * refuses to apply money to a cancelled invoice, and even a stray verified
 * provider webhook afterwards is NOT silently applied (invoice-cancelled,
 * critical alert) — cancel invalidates the link honestly.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, paystackChargeSuccess, publicCaller } from "./helpers";

export const journey: Journey = {
  id: "J196",
  name: "AR invoice cancel → link invalidated honestly",
  feature: "arInvoices cancel + honest 410 public surface + no silent money",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();
    const pub = await publicCaller();
    const customer = world.newPhone("arx");

    const inv = await caller.arInvoices.create({
      tenantId: TENANT_ID,
      customerName: "Dami Cancel",
      customerPhone: customer,
      description: "J196 cancelled invoice",
      amountCents: 750_000, // ₦7,500
      currency: "NGN",
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
    });
    const sent = await caller.arInvoices.send({ tenantId: TENANT_ID, invoiceId: inv.id });
    assert(sent.paymentUrl, "link minted pre-cancel");

    // Public link works pre-cancel.
    const view = await pub.arInvoices.getByLinkRef({ ref: sent.reference });
    assert(view.status === "sent" || view.status === "viewed", `public view live (got ${view.status})`);
    assert(view.paymentUrl === sent.paymentUrl, "public view carries the hosted link");

    // ── Cancel ───────────────────────────────────────────────────────────
    const cancelled = await caller.arInvoices.cancel({ tenantId: TENANT_ID, invoiceId: inv.id });
    assert(cancelled.status === "cancelled", "cancelled");

    // Public link now answers honestly expired (the 410-equivalent).
    const err = await expectTrpcError(
      pub.arInvoices.getByLinkRef({ ref: sent.reference }),
      "PRECONDITION_FAILED",
      "public link after cancel",
    );
    assertIncludes(String(err?.message ?? ""), "expired", "honest expiry wording");

    // recordPayment refuses to apply money to a cancelled invoice.
    const rec = await caller.arInvoices.recordPayment({ tenantId: TENANT_ID, invoiceId: inv.id });
    assert(rec.recorded === false && rec.reason === "invoice-cancelled", `recordPayment refused (got ${rec.reason})`);

    // ── Stray verified webhook AFTER cancel: never silently applied ──────
    const wh = await paystackChargeSuccess(world, { reference: sent.reference, amountMajor: 7_500 });
    assert(wh.status === 200, "webhook acked");
    await world.settle(600);
    const [cur] = await world.db.select().from(schema.arInvoices).where(eq(schema.arInvoices.id, inv.id)).limit(1);
    assert(cur.status === "cancelled", `stays cancelled (got ${cur.status})`);
    assert(Number(cur.paidCents) === 0, `no money applied to cancelled invoice (got ${cur.paidCents})`);
    const payments = await world.db.select().from(schema.arInvoicePayments)
      .where(eq(schema.arInvoicePayments.invoiceId, inv.id));
    assert(payments.length === 0, `no payment rows for cancelled invoice (got ${payments.length})`);

    // Idempotent cancel is a no-op, not an error.
    const again = await caller.arInvoices.cancel({ tenantId: TENANT_ID, invoiceId: inv.id });
    assert(again.alreadyCancelled === true, "second cancel is an honest no-op");
  },
};
