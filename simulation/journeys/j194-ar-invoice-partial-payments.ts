// === W31 ar-invoices ===
/**
 * J194 — Partial payments: ₦4,000 partial link → partially_paid → re-minted
 * remainder link ₦6,000 → paid. paid_cents accumulates honestly; a replayed
 * first webhook is a no-op (unique psp_reference, duplicate claim).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, paystackChargeSuccess } from "./helpers";

export const journey: Journey = {
  id: "J194",
  name: "AR invoice partial payments → partially_paid → paid; replay no-op",
  feature: "arInvoices partial accumulation + exactly-once recording",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();
    const customer = world.newPhone("arp");

    const inv = await caller.arInvoices.create({
      tenantId: TENANT_ID,
      customerName: "Bayo Partial",
      customerPhone: customer,
      description: "J194 partial-payment invoice",
      amountCents: 1_000_000, // ₦10,000
      currency: "NGN",
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
    });

    // ── 1. Partial link ₦4,000 → verified webhook → partially_paid ───────
    const p1 = await caller.arInvoices.send({ tenantId: TENANT_ID, invoiceId: inv.id, amountCents: 400_000 });
    assert(p1.reference.startsWith("AR-"), "partial link reference minted");
    const wh1 = await paystackChargeSuccess(world, { reference: p1.reference, amountMajor: 4_000 });
    assert(wh1.status === 200, `partial webhook accepted (got ${wh1.status})`);

    await world.waitFor(async () => {
      const [i] = await world.db.select().from(schema.arInvoices).where(eq(schema.arInvoices.id, inv.id)).limit(1);
      return i?.status === "partially_paid";
    }, 10000, "invoice partially_paid after partial webhook");
    let [cur] = await world.db.select().from(schema.arInvoices).where(eq(schema.arInvoices.id, inv.id)).limit(1);
    assert(Number(cur.paidCents) === 400_000, `paid_cents 400000 (got ${cur.paidCents})`);

    // ── 2. Webhook replay → duplicate, nothing accumulates twice ─────────
    const replay = await paystackChargeSuccess(world, { reference: p1.reference, amountMajor: 4_000 });
    assert(replay.status === 200, "replay acked");
    await world.settle(600);
    [cur] = await world.db.select().from(schema.arInvoices).where(eq(schema.arInvoices.id, inv.id)).limit(1);
    assert(Number(cur.paidCents) === 400_000, `replay did not double-count (got ${cur.paidCents})`);
    let payments = await world.db.select().from(schema.arInvoicePayments)
      .where(eq(schema.arInvoicePayments.invoiceId, inv.id));
    assert(payments.length === 1, `replay no-op: still one payment row (got ${payments.length})`);

    // ── 3. Remainder link (re-minted ₦6,000) → paid in full ──────────────
    const p2 = await caller.arInvoices.send({ tenantId: TENANT_ID, invoiceId: inv.id });
    assert(p2.reference !== p1.reference, "remainder link re-minted after partial payment");
    const [intent2] = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.providerPaymentId, p2.reference)).limit(1);
    assert(parseFloat(intent2.amount) === 6_000, `remainder link is ₦6,000 (got ${intent2.amount})`);

    const wh2 = await paystackChargeSuccess(world, { reference: p2.reference, amountMajor: 6_000 });
    assert(wh2.status === 200, "remainder webhook accepted");
    await world.waitFor(async () => {
      const [i] = await world.db.select().from(schema.arInvoices).where(eq(schema.arInvoices.id, inv.id)).limit(1);
      return i?.status === "paid";
    }, 10000, "invoice paid after remainder webhook");

    [cur] = await world.db.select().from(schema.arInvoices).where(eq(schema.arInvoices.id, inv.id)).limit(1);
    assert(Number(cur.paidCents) === 1_000_000, `paid_cents total 1000000 (got ${cur.paidCents})`);
    payments = await world.db.select().from(schema.arInvoicePayments)
      .where(eq(schema.arInvoicePayments.invoiceId, inv.id));
    assert(payments.length === 2, `two payment rows (got ${payments.length})`);

    // ── 4. Manual recordPayment on the paid invoice is an honest no-op ───
    const rec = await caller.arInvoices.recordPayment({ tenantId: TENANT_ID, invoiceId: inv.id });
    assert(rec.recorded === false && rec.reason === "already-paid", `recordPayment on paid invoice no-ops (got ${rec.reason})`);
  },
};
