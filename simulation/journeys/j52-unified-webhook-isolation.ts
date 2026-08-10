/**
 * J52 — Unified webhook isolation: the same /api/webhooks/payments/:provider
 * route normalizes a correctly-signed stripe event for a stripe-configured
 * tenant (intent confirmed), while a tampered stripe signature → 401, the
 * SAME body delivered to the paystack adapter → 401 (wrong adapter
 * verification), and an unknown provider slug → 404. Every non-confirm
 * attempt leaves intent state untouched.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { SUPPLIER_TENANT_ID } from "../world";
import { adminCaller, stripeCheckoutCompleted, postProviderWebhook } from "./helpers";

const STRIPE_SECRET_KEY = "sk_stripe_sim";
const STRIPE_WHSEC = "whsec_sim_stripe";

export const journey: Journey = {
  id: "J52",
  name: "unified webhook isolation",
  feature: "per-adapter verify + slug routing",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { upsertTenantProviderConfig } = await import("../../server/services/payments/providers/registry");

    // Stripe-configured tenant (supplier tenant carries ONLY a stripe row here).
    const up = await upsertTenantProviderConfig({
      tenantId: SUPPLIER_TENANT_ID,
      provider: "stripe",
      creds: { secretKey: STRIPE_SECRET_KEY, webhookSecret: STRIPE_WHSEC },
      priority: 0,
    });
    assert(up.ok, "stripe config upserted");

    // ── Initiation served by stripe (Checkout Session mock) ───────────────
    const caller = await adminCaller();
    const init = await caller.payment.initiate({
      tenantId: SUPPLIER_TENANT_ID,
      orderId: "order-j52-stripe",
      amount: 9_900,
      currency: "NGN",
      provider: "stripe",
      customerPhone: world.newPhone("a"),
    });
    assert(init.provider === "stripe", `stripe served (got ${init.provider})`);
    assert(
      init.paymentUrl === `https://checkout.stripe.com/sim/pay/${init.reference}`,
      `stripe checkout link (got ${init.paymentUrl})`,
    );
    const stripeInit = world.outbound.all().find(
      (c) => c.url === "https://api.stripe.com/v1/checkout/sessions" && c.method === "POST",
    );
    assert(stripeInit, "stripe checkout session POST intercepted");
    assert(String(stripeInit.body).includes(`client_reference_id=${init.reference}`), "form body carries the reference");
    assert(stripeInit.authToken === STRIPE_SECRET_KEY, "stripe bearer token reached the API");

    const [intent] = await world.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.providerPaymentId, init.reference)).limit(1);
    assert(intent, "stripe intent persisted");
    assert(intent.status === "initiated", "intent initiated");
    const amountCents = 990_000;

    // ── Tampered stripe signature → 401, intent untouched ─────────────────
    const tampered = await stripeCheckoutCompleted(world, {
      reference: init.reference,
      amountCents,
      webhookSecret: STRIPE_WHSEC,
      overrideSignature: "f".repeat(64),
      metadata: { tenant_id: SUPPLIER_TENANT_ID },
    });
    assert(tampered.status === 401, `tampered stripe signature rejected (got ${tampered.status})`);
    let [cur] = await world.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, intent.id)).limit(1);
    assert(cur.status === "initiated", "intent untouched by tampered stripe webhook");

    // ── Wrong route: stripe-shaped body to the paystack adapter → 401 ──────
    const stripeRaw = JSON.stringify({
      id: "evt_sim_wrong",
      type: "checkout.session.completed",
      data: { object: { client_reference_id: init.reference, amount_total: amountCents, metadata: { reference: init.reference } } },
    });
    const wrongAdapter = await postProviderWebhook(world, "paystack", stripeRaw, {
      "x-paystack-signature": "0".repeat(128),
    });
    assert(wrongAdapter.status === 401, `stripe body to paystack route rejected (got ${wrongAdapter.status})`);
    [cur] = await world.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, intent.id)).limit(1);
    assert(cur.status === "initiated", "intent untouched by wrong-adapter delivery");

    // ── Unknown provider slug → 404 ────────────────────────────────────────
    const unknown = await postProviderWebhook(world, "nosuchgateway", stripeRaw, {});
    assert(unknown.status === 404, `unknown provider slug 404s (got ${unknown.status})`);
    [cur] = await world.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, intent.id)).limit(1);
    assert(cur.status === "initiated", "intent untouched by unknown-slug delivery");

    // ── Correctly-signed stripe webhook → normalized → confirmed ───────────
    const ok = await stripeCheckoutCompleted(world, {
      reference: init.reference,
      amountCents,
      webhookSecret: STRIPE_WHSEC,
      metadata: { tenant_id: SUPPLIER_TENANT_ID },
    });
    assert(ok.status === 200, `stripe webhook accepted (got ${ok.status}: ${JSON.stringify(ok.json)})`);
    [cur] = await world.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, intent.id)).limit(1);
    assert(cur.status === "completed", "intent completed by valid stripe webhook");
    assert(cur.completedAt, "completedAt stamped");
  },
};
