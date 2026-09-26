/**
 * J473 — the unified provider webhook quarantines a mismatched payment the
 * same way the dedicated Paystack/Flutterwave routes do (assurance finding
 * AF-02).
 *
 * Before the fix, /api/webhooks/payments/:provider (stripe, monnify, custom
 * gateways) called confirmProviderPayment but never the PAY-13 quarantine
 * seam: a payment collected at the wrong amount was marked failed and then
 * forgotten — no payment_mismatch_quarantine row, no ops alert, no refund
 * attempt, money left sitting in the PSP account.
 */
import { eq } from "drizzle-orm";
import { assert, SUPPLIER_TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, seedOrderForInitiate, stripeCheckoutCompleted } from "./helpers";

const STRIPE_WHSEC = "whsec_sim_j473";

export const journey: Journey = {
  id: "J473",
  name: "unified webhook quarantines mismatches (AF-02)",
  feature: "PAY-13 seam on /api/webhooks/payments/:provider",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { getRecentErrors, _resetRecentErrors } = await import("../../server/services/observability");
    const { upsertTenantProviderConfig } = await import("../../server/services/payments/providers/registry");
    _resetRecentErrors();

    const up = await upsertTenantProviderConfig({
      tenantId: SUPPLIER_TENANT_ID,
      provider: "stripe",
      creds: { secretKey: "sk_stripe_sim_j473", webhookSecret: STRIPE_WHSEC },
      priority: 0,
    });
    assert(up.ok, "stripe config upserted");

    const orderId = "order-j473-stripe";
    await seedOrderForInitiate(world, { orderId, tenantId: SUPPLIER_TENANT_ID, amountMajor: 4_000 });
    const caller = await adminCaller();
    const init = await caller.payment.initiate({
      tenantId: SUPPLIER_TENANT_ID,
      orderId,
      amount: 4_000,
      currency: "NGN",
      provider: "stripe",
      customerPhone: world.newPhone("j473"),
    });
    assert(init.provider === "stripe", `stripe served (got ${init.provider})`);

    // Stripe reports ₦500 more than the intent — money in hand, wrong amount.
    const res = await stripeCheckoutCompleted(world, {
      reference: init.reference,
      amountCents: 450_000,
      webhookSecret: STRIPE_WHSEC,
      metadata: { tenant_id: SUPPLIER_TENANT_ID },
    });
    assert(res.status === 200, `webhook acked (got ${res.status})`);

    const [intent] = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.providerPaymentId, init.reference)).limit(1);
    assert(intent.status === "failed", `mismatched intent failed (got ${intent.status})`);

    const q = await world.db.select().from(schema.paymentMismatchQuarantine)
      .where(eq(schema.paymentMismatchQuarantine.reference, init.reference));
    assert(q.length === 1, `mismatch quarantined on the unified route (got ${q.length} rows)`);
    assert(q[0].tenantId === SUPPLIER_TENANT_ID, "quarantine is tenant-scoped");
    assert(q[0].expectedAmountMinor === 400_000 && q[0].actualAmountMinor === 450_000,
      `expected/actual recorded (got ${q[0].expectedAmountMinor}/${q[0].actualAmountMinor})`);
    assert(q[0].status !== "quarantined", `auto-refund outcome tracked (got ${q[0].status})`);
    const alerts = getRecentErrors(50).filter((e) => e.service === "payments/paymentMismatchQuarantine" && e.severity === "critical");
    assert(alerts.length >= 1, "critical ops alert captured");

    // Replay → still exactly one quarantine row.
    await stripeCheckoutCompleted(world, {
      reference: init.reference,
      amountCents: 450_000,
      webhookSecret: STRIPE_WHSEC,
      metadata: { tenant_id: SUPPLIER_TENANT_ID },
    });
    const again = await world.db.select().from(schema.paymentMismatchQuarantine)
      .where(eq(schema.paymentMismatchQuarantine.reference, init.reference));
    assert(again.length === 1, "replay did not double-quarantine");
  },
};
