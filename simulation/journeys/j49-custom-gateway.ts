/**
 * J49 — Zero-code custom gateway: the tenant configures a declarative
 * customHttp provider (fictional "AfriPay": bearer auth, bodyTemplate,
 * dot-path response/webhook mappings, hmac-sha256 hex signatures) as a plain
 * payment_gateway_configs row — NO adapter code. Initiation renders the
 * template onto the mock gateway and maps the hosted link; the custom-signed
 * webhook through the unified route confirms the order; a tampered signature
 * is 401-rejected and leaves intent/order state UNTOUCHED.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { TENANT_ID } from "../world";
import { createChatOrderViaNlp, adminCaller, customGatewayWebhook } from "./helpers";
import { registerCustomGatewayHost } from "../metaMock";

const AFRIPAY_HOST = "api.afripay.example";
const AFRIPAY_TOKEN = "afri-live-token-sim";
const AFRIPAY_WHSEC = "afri-whsec-sim";

/** The declarative AfriPay config — stored verbatim in credentials.customHttp. */
const AFRIPAY_CONFIG = {
  id: "afripay",
  displayName: "AfriPay",
  baseUrl: `https://${AFRIPAY_HOST}`,
  authStyle: "bearer",
  initiate: {
    path: "/v1/charges",
    method: "POST",
    bodyTemplate:
      '{"amount_minor":{{amountCents}},"currency":"{{currency}}","ref":"{{reference}}","redirect":"{{callbackUrl}}","phone":"{{customerPhone}}","email":"{{customerEmail}}","meta":{{metadataJson}}}',
    responseMapping: { authorizationUrl: "$.data.hosted_url", reference: "$.data.ref" },
  },
  status: {
    path: "/v1/charges/{{reference}}",
    mapping: { status: "$.charge.state", amountCents: "$.charge.amount_minor" },
  },
  webhook: {
    signatureHeader: "x-afripay-sig",
    algo: "hmac-sha256",
    secret: AFRIPAY_WHSEC,
    signatureEncoding: "hex",
    referencePath: "$.payload.ref",
    amountPath: "$.payload.amount_minor",
    metadataPath: "$.payload.meta",
  },
} as const;

export const journey: Journey = {
  id: "J49",
  name: "zero-code custom gateway",
  feature: "customHttp declarative provider end-to-end",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { upsertTenantProviderConfig, getProviderForTenant } = await import(
      "../../server/services/payments/providers/registry"
    );
    registerCustomGatewayHost(AFRIPAY_HOST);

    // ── Configure AfriPay for the sim tenant (no code, just config) ───────
    const up = await upsertTenantProviderConfig({
      tenantId: TENANT_ID,
      provider: "afripay",
      creds: { token: AFRIPAY_TOKEN, customHttp: AFRIPAY_CONFIG },
      priority: 7, // leads the chain over the seeded paystack row
    });
    assert(up.ok, "afripay customHttp config upserted");
    const chain = await getProviderForTenant(TENANT_ID);
    assert(chain[0]?.provider.id === "afripay", "afripay leads the tenant chain");

    // ── Chat order → payment.initiate served by AfriPay ───────────────────
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, {
      items: [{ product: "Jollof Rice", quantity: 1 }, { product: "Grilled Chicken", quantity: 1 }],
    });
    assert(order.total === 5500, `order total 5500 (got ${order.total})`);

    const caller = await adminCaller();
    const init = await caller.payment.initiate({
      tenantId: TENANT_ID,
      orderId: order.orderId,
      amount: order.total,
      currency: "NGN",
      provider: "stripe", // preference absent from the chain → afripay (priority 7) serves
      customerPhone: phone,
    });
    assert(init.provider === "afripay", `afripay served the initiation (got ${init.provider})`);
    assert(
      init.paymentUrl === `https://pay.${AFRIPAY_HOST}/sim/${init.reference}`,
      `afripay hosted link mapped (got ${init.paymentUrl})`,
    );

    // The mock gateway saw the rendered template + bearer auth.
    const gwCall = world.outbound.all().find((c) => c.url === `https://${AFRIPAY_HOST}/v1/charges`);
    assert(gwCall, "custom gateway init call intercepted");
    assert(gwCall.authToken === AFRIPAY_TOKEN, "bearer token reached the gateway");
    assert(gwCall.body?.amount_minor === 550_000, "template rendered the minor-unit amount");
    assert(gwCall.body?.ref === init.reference, "template rendered the reference");
    assert(gwCall.body?.currency === "NGN", "template rendered the currency");
    assert(gwCall.body?.meta?.tenant_id === TENANT_ID, "metadataJson rendered into the body");

    const [intent] = await world.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.providerPaymentId, init.reference)).limit(1);
    assert(intent, "afripay intent persisted");
    assert((intent.metadata as any)?.servedProvider === "afripay", "servedProvider=afripay on the intent");

    const webhookRaw = JSON.stringify({
      event: "charge.success",
      payload: {
        ref: init.reference,
        amount_minor: 550_000,
        currency: "NGN",
        meta: { payment_intent_id: intent.id, tenant_id: TENANT_ID },
      },
    });
    const signOpts = {
      provider: "afripay",
      raw: webhookRaw,
      signatureHeader: "x-afripay-sig",
      algo: "hmac-sha256" as const,
      secret: AFRIPAY_WHSEC,
      encoding: "hex" as const,
    };

    // ── Tampered signature → 401, state UNTOUCHED ─────────────────────────
    const tampered = await customGatewayWebhook(world, { ...signOpts, overrideSignature: "deadbeef".repeat(8) });
    assert(tampered.status === 401, `tampered signature rejected (got ${tampered.status})`);
    const [intentAfterTamper] = await world.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, intent.id)).limit(1);
    assert(intentAfterTamper.status === "initiated", `intent untouched by tampered webhook (got ${intentAfterTamper.status})`);
    const [orderAfterTamper] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
    assert(orderAfterTamper.status === "pending", "order still pending after tampered webhook");
    const receiptsAfterTamper = world.outbound.findByBody("Payment Receipt", phone);
    assert(receiptsAfterTamper.length === 0, "no receipt emitted by tampered webhook");

    // ── Valid custom-signed webhook → order confirmed ──────────────────────
    const ok = await customGatewayWebhook(world, signOpts);
    assert(ok.status === 200, `valid afripay webhook accepted (got ${ok.status}: ${JSON.stringify(ok.json)})`);
    await world.waitFor(async () => {
      const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
      return o?.status === "confirmed";
    }, 10000, "order confirmed by afripay webhook");
    const [intentAfter] = await world.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, intent.id)).limit(1);
    assert(intentAfter.status === "completed", "intent completed after valid webhook");

    // ── Replay is claim-first idempotent (no duplicate confirm effects) ────
    const replay = await customGatewayWebhook(world, signOpts);
    assert(replay.status === 200, "replay accepted");
    assert(replay.json?.action === "already-completed", `replay is a no-op (got ${replay.json?.action})`);
  },
};
