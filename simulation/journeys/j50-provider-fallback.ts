/**
 * J50 — Fallback under failure: tenant chain [paystack(priority 10),
 * flutterwave(priority 5)]. With the paystack init endpoint scripted to 500,
 * initiation captures a WARN to observability and flutters to the next chain
 * entry — the link is served by flutterwave, servedProvider='flutterwave' is
 * recorded on the intent, and the flw webhook confirms it. With BOTH
 * providers down, initiation fails gracefully (ProviderChainExhaustedError →
 * TRPC error, failed intent, nothing confirmed).
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { SUPPLIER_TENANT_ID } from "../world";
import { adminCaller, flutterwaveChargeSuccess, seedOrderForInitiate } from "./helpers";
import { setPayHostStatus } from "../metaMock";

const FLW_SECRET_KEY = "flw_sk_sim_fallback";
const FLW_SECRET_HASH = "flw_hash_sim_fallback";
const PS_SECRET_KEY = "sk_sim_fallback";

export const journey: Journey = {
  id: "J50",
  name: "provider fallback under failure",
  feature: "initiateWithFallback chain hop + exhaustion",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { upsertTenantProviderConfig, getProviderForTenant } = await import(
      "../../server/services/payments/providers/registry"
    );
    const { getRecentErrors, _resetRecentErrors } = await import("../../server/services/observability");
    _resetRecentErrors();

    // Chain: paystack (10) then flutterwave (5) on the supplier tenant.
    await upsertTenantProviderConfig({
      tenantId: SUPPLIER_TENANT_ID,
      provider: "paystack",
      creds: { secretKey: PS_SECRET_KEY },
      priority: 10,
    });
    await upsertTenantProviderConfig({
      tenantId: SUPPLIER_TENANT_ID,
      provider: "flutterwave",
      creds: { secretKey: FLW_SECRET_KEY, secretHash: FLW_SECRET_HASH },
      priority: 5,
    });
    const chain = await getProviderForTenant(SUPPLIER_TENANT_ID);
    assert(
      chain.length === 2 && chain[0].provider.id === "paystack" && chain[1].provider.id === "flutterwave",
      "priority-DESC chain [paystack, flutterwave]",
    );

    const caller = await adminCaller();

    // Wave 26 (F1): payment.initiate derives amount from the order row.
    await seedOrderForInitiate(world, { orderId: "order-j50-fallback", tenantId: SUPPLIER_TENANT_ID, amountMajor: 12_500 });
    await seedOrderForInitiate(world, { orderId: "order-j50-allfail", tenantId: SUPPLIER_TENANT_ID, amountMajor: 7_000 });

    // ── Paystack down → flutterwave serves ────────────────────────────────
    setPayHostStatus("api.paystack.co", 500);
    const init = await caller.payment.initiate({
      tenantId: SUPPLIER_TENANT_ID,
      orderId: "order-j50-fallback",
      amount: 12_500,
      currency: "NGN",
      provider: "paystack", // preferred — but it 500s, so the chain must hop
      customerPhone: world.newPhone("c"),
    });
    assert(init.provider === "flutterwave", `flutterwave served after paystack failure (got ${init.provider})`);
    assert(
      init.paymentUrl?.startsWith("https://checkout.flutterwave.com/sim/"),
      `flw link served (got ${init.paymentUrl})`,
    );

    // The failed paystack attempt hit the mock and was captured as a WARN.
    const psAttempt = world.outbound.all().find(
      (c) => c.url.includes("api.paystack.co/transaction/initialize") && JSON.stringify(c.body ?? {}).includes(init.reference),
    );
    assert(psAttempt, "paystack init was attempted first");
    const flwServed = world.outbound.all().find(
      (c) => c.url.includes("api.flutterwave.com/v3/payments") && JSON.stringify(c.body ?? {}).includes(init.reference),
    );
    assert(flwServed, "flutterwave init served the reference");
    const warns = getRecentErrors(50).filter(
      (e) => e.severity === "warn" && e.service === "payments/initiateWithFallback",
    );
    assert(warns.length >= 1, "fallback hop captured a WARN to observability");
    assert(JSON.stringify(warns[0]).includes("paystack"), "WARN names the failed provider");

    const [intent] = await world.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.providerPaymentId, init.reference)).limit(1);
    assert(intent, "fallback intent persisted");
    assert((intent.metadata as any)?.servedProvider === "flutterwave", "servedProvider=flutterwave recorded");
    assert(intent.provider === "flutterwave", "provider column records flutterwave");
    assert(
      Array.isArray((intent.metadata as any)?.providerResponse?.fallbackAttempts) &&
        (intent.metadata as any).providerResponse.fallbackAttempts[0]?.provider === "paystack",
      "failed attempts recorded on the intent metadata",
    );

    // flw webhook confirms the intent.
    const confirm = await flutterwaveChargeSuccess(world, {
      reference: init.reference,
      amountMajor: 12_500,
      secretHash: FLW_SECRET_HASH,
      metadata: { tenant_id: SUPPLIER_TENANT_ID },
    });
    assert(confirm.status === 200, `flw webhook accepted (got ${confirm.status})`);
    const [intentAfter] = await world.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, intent.id)).limit(1);
    assert(intentAfter.status === "completed", "fallback intent completed by flw webhook");

    // ── All providers down → graceful exhaustion, nothing confirmed ────────
    setPayHostStatus("api.flutterwave.com", 500);
    let threw: Error | null = null;
    try {
      await caller.payment.initiate({
        tenantId: SUPPLIER_TENANT_ID,
        orderId: "order-j50-allfail",
        amount: 7_000,
        currency: "NGN",
        provider: "paystack",
        customerPhone: world.newPhone("d"),
      });
    } catch (e: any) {
      threw = e;
    }
    assert(threw, "all-fail initiation throws");
    assert(
      /All payment providers failed|Payment initiation failed/.test(String(threw!.message)),
      `graceful exhaustion message (got ${threw!.message.slice(0, 200)})`,
    );
    const failedIntents = await world.db
      .select()
      .from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.orderId, "order-j50-allfail"));
    assert(failedIntents.length === 1, "one failed intent kept for audit");
    assert(failedIntents[0].status === "failed", `all-fail intent is failed (got ${failedIntents[0].status})`);
    assert(!failedIntents[0].completedAt, "all-fail intent never confirmed");
  },
};
