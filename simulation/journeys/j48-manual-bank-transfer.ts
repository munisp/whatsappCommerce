/**
 * J48 — Manual / bank-transfer provider: a tenant whose chain leads with the
 * `manual` adapter gets settlement INSTRUCTIONS (bank / account / amount /
 * reference) from payment.initiate — NOT a hosted URL and NO gateway init
 * call leaves the process. The existing receipt-upload verification path
 * (J08) still confirms the order end-to-end.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { TENANT_ID } from "../world";
import { createChatOrderViaNlp, adminCaller } from "./helpers";
import { scriptMedia } from "../metaMock";

export const journey: Journey = {
  id: "J48",
  name: "manual bank-transfer provider",
  feature: "manual adapter instructions + receipt confirm",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { upsertTenantProviderConfig } = await import("../../server/services/payments/providers/registry");

    // Manual provider leads the tenant chain (priority above the seeded
    // paystack row) with declarative bank details in the credentials jsonb.
    const up = await upsertTenantProviderConfig({
      tenantId: TENANT_ID,
      provider: "manual",
      creds: {
        bankName: "Sim Bank PLC",
        accountNumber: "0123456789",
        accountName: "Sim Store Enterprises",
      },
      priority: 5,
    });
    assert(up.ok, "manual provider config upserted");

    // ── Chat order creates the pending storefront order ────────────────────
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, {
      items: [{ product: "Jollof Rice", quantity: 1 }],
    });
    assert(order.total === 2500, `order total 2500 (got ${order.total})`);

    // ── payment.initiate resolves the manual adapter via the chain ─────────
    // input.provider is only a PREFERENCE; 'stripe' is absent from the chain
    // so the priority order stands and manual (priority 5) serves first.
    const caller = await adminCaller();
    const init = await caller.payment.initiate({
      tenantId: TENANT_ID,
      orderId: order.orderId,
      amount: order.total,
      currency: "NGN",
      provider: "stripe",
      customerPhone: phone,
    });
    assert(init.provider === "manual", `manual served the initiation (got ${init.provider})`);
    assert(init.paymentUrl === null, "manual provider returns NO hosted URL");
    assert(typeof init.instructions === "string" && init.instructions.length > 0, "settlement instructions returned");
    assertIncludes(init.instructions, "Pay NGN 2500.00 by bank transfer", "instructions carry the amount");
    assertIncludes(init.instructions, "Bank: Sim Bank PLC", "instructions carry the bank");
    assertIncludes(init.instructions, "Account number: 0123456789", "instructions carry the account number");
    assertIncludes(init.instructions, "Account name: Sim Store Enterprises", "instructions carry the account name");
    assertIncludes(init.instructions, `Reference: ${init.reference}`, "instructions carry the payment reference");

    // No gateway init call left the process for this reference.
    const gatewayCalls = world.outbound
      .all()
      .filter((c) => /paystack\.co|flutterwave\.com|stripe\.com|monnify\.com/.test(c.url) && JSON.stringify(c.body ?? {}).includes(init.reference));
    assert(gatewayCalls.length === 0, "no outbound gateway init for a manual payment");

    const [intent] = await world.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.providerPaymentId, init.reference)).limit(1);
    assert(intent, "manual intent persisted");
    assert((intent.metadata as any)?.servedProvider === "manual", "servedProvider=manual recorded on the intent");
    assert((intent.metadata as any)?.instructions?.includes("Sim Bank PLC"), "instructions persisted on the intent");

    // ── The existing receipt-upload path still confirms the order ──────────
    world.llm.when(
      (userText: string) => userText.includes("[image:"),
      () => ({
        receiptType: "bank_transfer_receipt",
        summary: "Simulated receipt scan",
        confidence: 0.96,
        keyFields: { amount: "2500.00", currency: "NGN", sender: "SIM USER", reference: "SIM-TRF-M" },
        extractedText: "Paid 2500.00",
      }),
    );
    scriptMedia("m-receipt-manual", "SIMIMG receipt amount=2500.00");
    await world.image(phone, "m-receipt-manual");

    await world.waitFor(async () => {
      const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
      return o?.status === "confirmed";
    }, 15000, "order confirmed via receipt-upload path");
    const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
    assert(o.paymentStatus === "completed", "order payment completed via receipt verification");
  },
};
