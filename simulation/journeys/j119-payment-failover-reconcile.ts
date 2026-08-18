/**
 * J119 — E1 stakeholder journey (payments engineer): payment initiation
 * with Paystack failing (simulated 500) → automatic Flutterwave fallback
 * serves the checkout link → the flw webhook confirms → the confirmation
 * reconciles to the CORRECT provider (intent.provider = flutterwave,
 * servedProvider recorded, failed attempts kept) → a compliance audit event
 * (payment.confirm) is written. Then both providers down → graceful
 * exhaustion, failed intent, nothing confirmed.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, flutterwaveChargeSuccess, tenantCaller } from "./helpers";
import { setPayHostStatus } from "../metaMock";

const FLW_SECRET_KEY = "flw_sk_sim_j119";
const FLW_SECRET_HASH = "flw_hash_sim_j119";
const PS_SECRET_KEY = "sk_sim_j119";

export const journey: Journey = {
  id: "J119",
  name: "paystack outage → flutterwave failover → reconciled confirmation",
  feature: "E1 provider failover end-to-end",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { upsertTenantProviderConfig } = await import("../../server/services/payments/providers/registry");
    const { getRecentErrors, _resetRecentErrors } = await import("../../server/services/observability");
    _resetRecentErrors();

    const admin = await adminCaller();
    const tenant = (await admin.onboarding.start({ name: "J119 Failover Tenant" })).tenantId;
    const caller = await tenantCaller(tenant, { userId: 1190 });

    // Chain: paystack (10) then flutterwave (5).
    await upsertTenantProviderConfig({ tenantId: tenant, provider: "paystack", creds: { secretKey: PS_SECRET_KEY }, priority: 10 });
    await upsertTenantProviderConfig({
      tenantId: tenant, provider: "flutterwave",
      creds: { secretKey: FLW_SECRET_KEY, secretHash: FLW_SECRET_HASH }, priority: 5,
    });

    // ── 1. Paystack down → flutterwave serves the initiation ─────────────
    setPayHostStatus("api.paystack.co", 500);
    const init = await caller.payment.initiate({
      tenantId: tenant,
      orderId: "order-j119-failover",
      amount: 9_750,
      currency: "NGN",
      provider: "paystack", // preferred — but it 500s, so the chain must hop
      customerPhone: world.newPhone("e1"),
    });
    assert(init.provider === "flutterwave", `flutterwave served after paystack failure (got ${init.provider})`);
    assert(init.paymentUrl?.startsWith("https://checkout.flutterwave.com/sim/"),
      `flw checkout link (got ${init.paymentUrl})`);

    const psAttempt = world.outbound.all().find(
      (c) => c.url.includes("api.paystack.co/transaction/initialize") && JSON.stringify(c.body ?? {}).includes(init.reference),
    );
    assert(psAttempt, "paystack attempted first");
    const warns = getRecentErrors(50).filter((e) => e.severity === "warn" && e.service === "payments/initiateWithFallback");
    assert(warns.length >= 1 && JSON.stringify(warns[0]).includes("paystack"), "fallback hop WARN captured");

    // ── 2. flw webhook confirms → reconciles to the correct provider ─────
    const confirm = await flutterwaveChargeSuccess(world, {
      reference: init.reference,
      amountMajor: 9_750,
      secretHash: FLW_SECRET_HASH,
      metadata: { tenant_id: tenant },
    });
    assert(confirm.status === 200, `flw webhook accepted (got ${confirm.status})`);
    const [intent] = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.providerPaymentId, init.reference)).limit(1);
    assert(intent.status === "completed", "intent completed by the flw webhook");
    assert(intent.provider === "flutterwave", `reconciled provider is flutterwave (got ${intent.provider})`);
    assert((intent.metadata as any)?.servedProvider === "flutterwave", "servedProvider recorded");
    assert((intent.metadata as any)?.providerResponse?.fallbackAttempts?.[0]?.provider === "paystack",
      "failed paystack attempt kept on the intent");

    // ── 3. Compliance audit event written for the confirmation ───────────
    const audits = await world.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.tenantId, tenant));
    const confirmAudit = audits.find((a: any) => a.action === "payment.confirm" && a.entityId === intent.id);
    assert(confirmAudit, "payment.confirm audit event written");
    assert(JSON.stringify(confirmAudit).includes("flutterwave") || JSON.stringify(confirmAudit.after ?? {}).includes("completed"),
      "audit event carries the reconciled outcome");

    // ── 4. Both providers down → graceful exhaustion, nothing confirmed ──
    setPayHostStatus("api.flutterwave.com", 500);
    let threw: Error | null = null;
    try {
      await caller.payment.initiate({
        tenantId: tenant,
        orderId: "order-j119-allfail",
        amount: 3_000,
        currency: "NGN",
        provider: "paystack",
        customerPhone: world.newPhone("e1b"),
      });
    } catch (e: any) {
      threw = e;
    } finally {
      setPayHostStatus("api.paystack.co", null);
      setPayHostStatus("api.flutterwave.com", null);
    }
    assert(threw && /All payment providers failed|Payment initiation failed/.test(String(threw.message)),
      `graceful exhaustion (got ${String(threw?.message).slice(0, 160)})`);
    const failedIntents = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.orderId, "order-j119-allfail"));
    assert(failedIntents.length === 1 && failedIntents[0].status === "failed" && !failedIntents[0].completedAt,
      "all-fail intent kept as failed, never confirmed");
  },
};
