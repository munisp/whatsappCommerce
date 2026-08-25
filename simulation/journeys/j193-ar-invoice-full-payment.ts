// === W31 ar-invoices ===
/**
 * J193 — AR invoice happy path: create (draft) → send (PSP link via the
 * provider fallback chain, sim metaMock paystack) → WA to customer with the
 * link → public link view (no tenant leakage) → customer pays in full via
 * the REAL paystack webhook (pinned confirmProviderPayment rail) → invoice
 * paid; payment_intents completed + ar_invoice_payments row asserted.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, paystackChargeSuccess, publicCaller } from "./helpers";

export const journey: Journey = {
  id: "J193",
  name: "AR invoice create → send link → customer pays in full",
  feature: "arInvoices create/send + paymentConfirm webhook rail → paid",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();
    const customer = world.newPhone("arc");
    await world.grantConsent(customer);

    // ── 1. Create draft ──────────────────────────────────────────────────
    const inv = await caller.arInvoices.create({
      tenantId: TENANT_ID,
      customerName: "Adaeze Okafor",
      customerPhone: customer,
      description: "J193 wholesale ankara order",
      amountCents: 1_000_000, // ₦10,000
      currency: "NGN",
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
    });
    assert(inv.status === "draft", `draft created (got ${inv.status})`);
    assert(typeof inv.invoiceNo === "number" && inv.invoiceNo >= 1, "tenant-scoped invoice_no assigned");

    // ── 2. Send → PSP link minted + WA to customer ───────────────────────
    const sent = await caller.arInvoices.send({ tenantId: TENANT_ID, invoiceId: inv.id });
    assert(sent.paymentUrl?.includes("/sim/"), `sim paystack link minted (got ${sent.paymentUrl})`);
    assert(sent.reference.startsWith("AR-"), `payment_link_ref issued (got ${sent.reference})`);

    await world.waitFor(() => {
      const msg = world.outbound.lastOfType("text", customer);
      return !!msg && bodyText(msg).includes(sent.paymentUrl!);
    }, 10000, "WA invoice message with link delivered");

    const [stored] = await world.db.select().from(schema.arInvoices)
      .where(eq(schema.arInvoices.id, inv.id)).limit(1);
    assert(stored.status === "sent", `invoice sent (got ${stored.status})`);
    assert(stored.paymentLinkRef === sent.reference, "payment_link_ref stored");

    // Idempotent re-send reuses the open link.
    const resend = await caller.arInvoices.send({ tenantId: TENANT_ID, invoiceId: inv.id });
    assert(resend.reference === sent.reference, "re-send reuses the open link");

    // ── 3. Public link view — invoice fields only, no tenant leakage ─────
    const pub = await publicCaller();
    const view = await pub.arInvoices.getByLinkRef({ ref: sent.reference });
    assert(view.invoiceNo === inv.invoiceNo, "public view shows the invoice number");
    assert(view.amountCents === 1_000_000, "public view shows the amount");
    assert((view as any).tenantId === undefined, "public view never leaks tenantId");
    assert(view.customerFirstName === "Adaeze", "first name only on public view");

    // ── 4. Customer pays in full via the verified webhook rail ───────────
    const wh = await paystackChargeSuccess(world, { reference: sent.reference, amountMajor: 10_000 });
    assert(wh.status === 200, `webhook accepted (got ${wh.status})`);

    await world.waitFor(async () => {
      const [i] = await world.db.select().from(schema.arInvoices).where(eq(schema.arInvoices.id, inv.id)).limit(1);
      return i?.status === "paid";
    }, 10000, "invoice marked paid after verified webhook");

    // Money rails asserted: intent completed (pinned paymentConfirm) + the
    // ar_invoice_payments ledger row with the unique psp_reference.
    const [intent] = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.providerPaymentId, sent.reference)).limit(1);
    assert(intent?.status === "completed", `payment intent completed (got ${intent?.status})`);
    const payments = await world.db.select().from(schema.arInvoicePayments)
      .where(eq(schema.arInvoicePayments.invoiceId, inv.id));
    assert(payments.length === 1, `exactly one payment recorded (got ${payments.length})`);
    assert(Number(payments[0].amountCents) === 1_000_000, "payment amount matches invoice");

    const [paid] = await world.db.select().from(schema.arInvoices).where(eq(schema.arInvoices.id, inv.id)).limit(1);
    assert(Number(paid.paidCents) === 1_000_000, "paid_cents accumulated in full");
    assert(paid.paidAt, "paid_at stamped");

    // Receipt-style confirmation to the customer mentions the invoice.
    const waMsgs = world.outbound.lastOfType("text", customer);
    assertIncludes(bodyText(waMsgs), sent.paymentUrl!, "customer WA carried the payment link");
  },
};
