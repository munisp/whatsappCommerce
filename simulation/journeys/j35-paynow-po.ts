/**
 * J35 — Pay-now PO: payment_mode paynow → supplier approve → a Paystack
 * payment link is created for the buyer (mock intercept) → the provider
 * confirm webhook (HMAC-signed, metadata type po_payment) settles the PO to
 * 'paid' and notifies both sides → a webhook REPLAY does not double-settle.
 */
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { SUPPLIER_ADMIN_PHONE, SUPPLIER_TENANT_ID } from "../world";
import {
  buildProcurementPoViaChat,
  enableProcurementMenu,
  paystackChargeSuccess,
  restoreMenu,
} from "./helpers";

export const journey: Journey = {
  id: "J35",
  name: "pay-now PO",
  feature: "po_payment link → webhook settle → replay idempotent",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const before = await enableProcurementMenu(world);
    const po = await buildProcurementPoViaChat(world, phone, { paymentMode: "paynow" });
    assert(po.paymentMode === "paynow" && po.termsDays === null, "PO is pay-now");

    await world.supplierButtonReply(SUPPLIER_ADMIN_PHONE, `po_approve:${po.poId}`, "Approve");

    // ── Approved pending payment + link created via the Paystack mock ─────
    const schema = await import("../../drizzle/schema");
    const { eq, desc } = await import("drizzle-orm");
    const [row] = await world.db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, po.poId)).limit(1);
    assert(row.status === "approved", `PO approved pending payment (got ${row.status})`);

    // payment.initiate runs inside the webhook's async pipeline and waits out
    // the (offline) Temporal connect deadline before proceeding — poll for
    // the intent rather than racing it.
    let intent: any;
    await world.waitFor(async () => {
      const intents = await world.db
        .select()
        .from(schema.paymentIntents)
        .where(eq(schema.paymentIntents.tenantId, SUPPLIER_TENANT_ID))
        .orderBy(desc(schema.paymentIntents.createdAt))
        .limit(10);
      intent = intents.find(
        (i: any) => (i.metadata as any)?.type === "po_payment" && (i.metadata as any)?.poId === po.poId
          && i.status === "initiated" && (i.metadata as any)?.paymentUrl,
      );
      return !!intent;
    }, 30_000, "po_payment intent initiated");
    assert(parseFloat(intent.amount) === 29_000, `intent amount ₦29,000 major (got ${intent.amount})`);
    const reference = intent.providerPaymentId as string;
    const paymentUrl = (intent.metadata as any)?.paymentUrl as string;
    assert(paymentUrl?.startsWith("https://checkout.paystack.com/sim/"), `payment link from the mock (got ${paymentUrl})`);

    // The Paystack initialize call hit the mock with the same reference.
    const psInit = world.outbound.all().find(
      (c) => c.url.includes("api.paystack.co/transaction/initialize") && JSON.stringify(c.body ?? {}).includes(reference),
    );
    assert(psInit, "Paystack initialize intercepted for the PO reference");

    // Buyer received the link (sent inside the webhook pipeline just after
    // the intent flips to initiated — poll, don't race it).
    await world.waitFor(
      () => world.outbound.findByBody(paymentUrl, phone).length > 0,
      15_000,
      "buyer received the payment link",
    );
    const buyerLink = world.outbound.findByBody(paymentUrl, phone).pop();
    assert(buyerLink, "buyer received the payment link");
    // No credit was drawn for a pay-now PO.
    const account = await (await import("./helpers")).creditAccount(world);
    assert(Number(account.outstandingCents) === 0, "pay-now PO draws no credit");

    // ── Provider confirm webhook settles the PO ───────────────────────────
    const settle = await paystackChargeSuccess(world, { reference, amountMajor: 29_000 });
    assert(settle.status === 200, `paystack webhook accepted (got ${settle.status})`);
    const [paid] = await world.db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, po.poId)).limit(1);
    assert(paid.status === "paid", `PO settled to paid (got ${paid.status})`);

    const buyerPaid = world.outbound.findByBody("Payment received", phone).pop();
    assert(buyerPaid, "buyer notified of payment");
    assertIncludes(bodyText(buyerPaid), po.poNumber, "buyer payment notice references the PO");
    const supplierPaid = world.outbound.findByBody("now PAID", SUPPLIER_ADMIN_PHONE).pop();
    assert(supplierPaid, "supplier notified to fulfil");

    // ── Replay: no double-settle, no duplicate notifications ──────────────
    const buyerCount = world.outbound.toPhone(phone).length;
    const supplierCount = world.outbound.toPhone(SUPPLIER_ADMIN_PHONE).length;
    const replay = await paystackChargeSuccess(world, { reference, amountMajor: 29_000 });
    assert(replay.status === 200, "replay accepted");
    assert(replay.json?.action === "already-completed", `replay is a no-op (got ${replay.json?.action})`);
    const [stillPaid] = await world.db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, po.poId)).limit(1);
    assert(stillPaid.status === "paid", "PO remains paid after replay");
    assert(world.outbound.toPhone(phone).length === buyerCount, "replay sends the buyer nothing new");
    assert(world.outbound.toPhone(SUPPLIER_ADMIN_PHONE).length === supplierCount, "replay sends the supplier nothing new");

    await restoreMenu(world, before);
  },
};
