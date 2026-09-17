/**
 * === W41 Coder A (UC-1/UC-6) ===
 * J287 — Down payment at order confirm:
 *   1. The adjacent webhook hook activates the plan exactly once when the
 *      down-payment reference confirms (claim-first pending_down → active).
 *   2. With checkout save-card consent + a reusable authorization in the
 *      payload, the hook saves an encrypted customer token and attaches it
 *      to the plan (never plaintext, never a PAN).
 *   3. A replayed webhook does NOT re-activate or double-save.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J287",
  name: "installment down payment activates plan + consented token save (UC-1/UC-6)",
  feature: "runBuyerCreditWebhookHook: exactly-once activation; consent token saved v1:-encrypted; replay no-op",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/buyerInstallments");
    const tokensSvc = await import("../../server/services/customerPaymentTokens");
    const secrets = await import("../../server/services/crypto/secrets");
    const db = world.db;
    const buyer = "2348000000287";
    const orderId = `j287-order-${Date.now()}`;

    await svc.setBuyerInstallmentConfig(db, TENANT_ID, { enabled: true, minTotalCents: 0 });
    await db.insert(schema.orders).values({
      id: orderId, tenantId: TENANT_ID, customerId: buyer,
      orderNumber: `J287-${Date.now()}`, status: "pending",
      totalAmount: "900.00", currency: "NGN", paymentStatus: "unpaid",
      createdAt: new Date(), updatedAt: new Date(),
    });
    const plan = await svc.createBuyerPlan(db, {
      tenantId: TENANT_ID, orderId, buyerPhone: buyer,
      totalCents: 900_00, installments: 3, saveCardConsent: true,
    });

    // ── 1. Unrelated reference → not handled ─────────────────────────────
    const miss = await svc.runBuyerCreditWebhookHook(db, { provider: "fake", reference: "nope:123" });
    assert(miss.handled === false, "unrelated reference is not handled");

    // ── 2. Down-payment reference + reusable authorization → activate + save token
    const hit = await svc.runBuyerCreditWebhookHook(db, {
      provider: "fake",
      reference: plan.downPaymentRef,
      rawPayload: { fakeAuthorization: { token: "fake-auth-j287", label: "Dev card •••• 0001" } },
    });
    assert(hit.handled === true && hit.planId === plan.planId, "hook handled the down payment");

    const [after] = await db.select().from(schema.buyerInstallmentPlans)
      .where(eq(schema.buyerInstallmentPlans.id, plan.planId)).limit(1);
    assert(after?.status === "active", `plan active after down payment, got ${after?.status}`);
    assert(after?.downPaymentPaidAt != null, "downPaymentPaidAt stamped");
    assert(after?.tokenId != null, "consented token attached to the plan");

    const [token] = await db.select().from(schema.customerPaymentTokens)
      .where(eq(schema.customerPaymentTokens.id, after!.tokenId!)).limit(1);
    assert(token, "token row exists");
    assert(token!.status === "active", "token active");
    assert(token!.tokenEnc.startsWith("v1:"), "token stored encrypted v1:");
    assert(!token!.tokenEnc.includes("fake-auth-j287"), "never plaintext at rest");
    assert(secrets.decryptSecret(token!.tokenEnc) === "fake-auth-j287", "decrypts to the PSP handle");
    assertIncludes(token!.displayLabel ?? "", "0001", "masked display label only");
    assert((token!.consentText ?? "").length >= 10, "consent prompt persisted for audit");

    // ── 3. Webhook replay → exactly-once (no re-activation, no 2nd token) ─
    const replay = await svc.runBuyerCreditWebhookHook(db, {
      provider: "fake",
      reference: plan.downPaymentRef,
      rawPayload: { fakeAuthorization: { token: "fake-auth-j287", label: "Dev card •••• 0001" } },
    });
    assert(replay.handled === true, "replay still resolves the plan");
    const list = await tokensSvc.listCustomerTokens(db, TENANT_ID, buyer);
    assert(list.length === 1, `exactly one token saved, got ${list.length}`);
    const [still] = await db.select().from(schema.buyerInstallmentPlans)
      .where(eq(schema.buyerInstallmentPlans.id, plan.planId)).limit(1);
    assert(still?.status === "active" && still?.tokenId === after!.tokenId, "replay changes nothing");

    await svc.setBuyerInstallmentConfig(db, TENANT_ID, { enabled: false });
  },
};
