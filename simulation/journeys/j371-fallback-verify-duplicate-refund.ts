// === W45 money-intents (Coder B2) ===
/**
 * J371 — PAY-25: no double-minted checkouts + duplicate-completed detector.
 *
 * (a) Paystack initiate TIMES OUT (ambiguous) with a LIVE pending transaction
 *     provider-side → initiateWithFallback recovers provider A WITHOUT minting
 *     a Flutterwave checkout. With an INCONCLUSIVE verify, the chain ABORTS
 *     (ProviderChainExhaustedError) instead of falling back blind.
 * (b) Duplicate-completed detector: two completed intents for one order → the
 *     later payment is auto-refunded via the provider refund API + a critical
 *     ops alert fires; re-running is idempotent.
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { pay } from "../metaMock";

export const journey: Journey = {
  id: "J371",
  name: "PAY-25: verify-before-fallback + duplicate-completed auto-refund",
  feature: "W45 initiateWithFallback verify gate + duplicateCompletedPayments",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { getRecentErrors, _resetRecentErrors } = await import("../../server/services/observability");
    const { upsertTenantProviderConfig } = await import("../../server/services/payments/providers/registry");
    const { initiateWithFallback, ProviderChainExhaustedError } = await import(
      "../../server/services/payments/initiateWithFallback"
    );
    _resetRecentErrors();

    // Chain: paystack (10) → flutterwave (5).
    await upsertTenantProviderConfig({ tenantId: TENANT_ID, provider: "paystack", creds: { secretKey: "sk_sim_j371" }, priority: 10 });
    await upsertTenantProviderConfig({ tenantId: TENANT_ID, provider: "flutterwave", creds: { secretKey: "flw_sim_j371", secretHash: "hash_j371" }, priority: 5 });

    const mkCtx = (reference: string) => ({
      tenantId: TENANT_ID,
      amountCents: 5000,
      currency: "NGN",
      reference,
      metadata: { journey: "J371" },
      customer: { phone: "2348000000000", email: "j371@sim.local" },
    });

    // ── (a1) Ambiguous timeout + LIVE provider-side checkout → recover, no hop
    const refLive = `J371-LIVE-${Date.now()}`;
    pay.paystackInitiateTimeout = true;
    pay.verifyStatuses.set(refLive, "pending");
    const flwCallsBefore = pay.calls.filter((c) => c.url.includes("api.flutterwave.com/v3/payments")).length;
    const recovered = await initiateWithFallback(TENANT_ID, mkCtx(refLive));
    assert(recovered.providerId === "paystack", `recovered at provider A (got ${recovered.providerId})`);
    assert(recovered.recoveredViaVerify === true, "marked recoveredViaVerify");
    assert(recovered.result.ok === true, "recovered result ok");
    const flwCallsAfter = pay.calls.filter((c) => c.url.includes("api.flutterwave.com/v3/payments")).length;
    assert(flwCallsAfter === flwCallsBefore, "NO second checkout minted at flutterwave");

    // ── (a2) Ambiguous timeout + INCONCLUSIVE verify → chain ABORTS ────────
    const refUnknown = `J371-UNKNOWN-${Date.now()}`;
    // (verifyStatuses has no entry → the mock 404s → fetchStatus throws)
    const err = await initiateWithFallback(TENANT_ID, mkCtx(refUnknown)).catch((e) => e);
    assert(err instanceof ProviderChainExhaustedError, `inconclusive verify aborts (got ${err?.message ?? err})`);
    assert(err.attempts.length === 1, "only the ambiguous provider was attempted");
    assert(String(err.attempts[0].error).includes("verify inconclusive"), "abort reason recorded on the attempt");
    const flwCallsFinal = pay.calls.filter((c) => c.url.includes("api.flutterwave.com/v3/payments")).length;
    assert(flwCallsFinal === flwCallsBefore, "still NO blind flutterwave checkout");
    const refused = getRecentErrors(50).find((e) => e.service === "payments/initiateWithFallback" && e.operation === "fallbackRefused" && e.severity === "critical");
    assert(refused, "critical capture for the refused blind fallback");
    pay.paystackInitiateTimeout = false;

    // ── (b) Duplicate-completed detector ───────────────────────────────────
    const orderId = `order-j371-${randomUUID().slice(0, 8)}`;
    await world.db.insert(schema.orders).values({
      id: orderId,
      tenantId: TENANT_ID,
      customerId: "cust-j371",
      orderNumber: `SIM-${orderId}`,
      status: "confirmed",
      totalAmount: "5000.00",
      currency: "NGN",
      paymentStatus: "completed",
    });
    const mkCompletedIntent = async (ref: string, completedAt: Date) => {
      await world.db.insert(schema.paymentIntents).values({
        id: randomUUID(),
        tenantId: TENANT_ID,
        orderId,
        customerId: "cust-j371",
        amount: "5000.00",
        currency: "NGN",
        provider: "paystack",
        status: "completed",
        providerPaymentId: ref,
        idempotencyKey: `j371:${ref}`,
        metadata: {},
        completedAt,
        createdAt: completedAt,
        updatedAt: completedAt,
      });
    };
    const legitRef = `J371-DUP-A-${Date.now()}`;
    const dupRef = `J371-DUP-B-${Date.now()}`;
    await mkCompletedIntent(legitRef, new Date(Date.now() - 60_000));
    await mkCompletedIntent(dupRef, new Date()); // the duplicate (paid twice)

    const { detectDuplicateCompletedPayments } = await import("../../server/services/payments/duplicateCompletedPayments");
    const outcome = await detectDuplicateCompletedPayments(await world.db as any, { tenantId: TENANT_ID, orderId });
    assert(outcome.checked === 2, "both completed intents inspected");
    assert(outcome.duplicatesFound === 1, "exactly one duplicate detected");
    assert(outcome.refundsInitiated === 1, "duplicate auto-refund initiated");

    // The EARLIER payment stands; the LATER one was refunded.
    const [dupIntent] = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.providerPaymentId, dupRef)).limit(1);
    assert((dupIntent.metadata as any)?.duplicateRefundProcessed === true, "duplicate stamped as refund-processed");
    const refunds = await world.db.select().from(schema.refundAttempts)
      .where(eq(schema.refundAttempts.orderId, orderId));
    assert(refunds.some((a) => a.amountCents === 500000), "refund attempt for the duplicate amount journaled");
    const dupAlerts = getRecentErrors(50).filter(
      (e) => e.service === "payments/duplicateCompletedPayments" && e.severity === "critical",
    );
    assert(dupAlerts.length >= 1, "duplicate-payment ops alert captured");

    // Idempotent: a second detection run does NOT refund again.
    const outcome2 = await detectDuplicateCompletedPayments(await world.db as any, { tenantId: TENANT_ID, orderId });
    assert(outcome2.duplicatesFound === 0 && outcome2.refundsInitiated === 0, "detector is idempotent");
  },
};
