/**
 * J102 — M1 stakeholder journey: brand-new merchant end-to-end.
 *
 *   new merchant onboarding (onboarding.start) → KYB verification
 *   (kyc.getOrCreateApplication → submit → admin approve) → go-live
 *   (onboarding.activate) → first product listed (product.create) →
 *   first WhatsApp sale on the merchant's OWN phone number id (scripted
 *   LLM add_to_cart → confirm → pickup) → Paystack webhook confirmation
 *   (paymentConfirm) → merchant wallet credited (PSP custody mode:
 *   escrow hold credits merchant_wallets + wallet_transactions).
 *
 * Custody mode is flipped to "psp" for the sale and restored in a finally
 * block so no other journey observes the change.
 */
import crypto from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, paystackChargeSuccess, tenantCaller } from "./helpers";
import * as payloads from "../payloads";

const J102_PHONE_NUMBER_ID = "pn_sim_j102_001";
const J102_SKU = "J102-ANKARA-6YD";
const J102_PRODUCT_NAME = "Ankara Wax Print 6yd";
const J102_PRICE_NGN = 4500;

export const journey: Journey = {
  id: "J102",
  name: "new merchant onboarding → first sale → wallet credit",
  feature: "onboarding.start → KYB approve → activate → product.create → WhatsApp sale → paystack confirm → merchant wallet credit",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();

    // ── 1. New merchant onboarding ────────────────────────────────────────
    const started = await admin.onboarding.start({ name: "J102 Adaeze Fabrics", plan: "starter" });
    const tenantId = started.tenantId;
    assert(tenantId, "new tenant provisioned");

    // ── 2. KYB verification ───────────────────────────────────────────────
    const merchant = await tenantCaller(tenantId, { userId: 1020 });
    const kyb = await merchant.kyc.getOrCreateApplication({ tenantId, type: "kyb" });
    await merchant.kyc.submit({ applicationId: kyb.id });
    const review = await admin.kyc.review({ applicationId: kyb.id, decision: "approved", notes: "sim: CAC docs verified" });
    assert(review.ok, "admin approved the merchant KYB");

    // ── 3. Go-live ────────────────────────────────────────────────────────
    const { setOnboardingStatus } = await import("../../server/services/onboarding");
    await setOnboardingStatus(tenantId, "validating", { validationPassed: true });
    const activated = await merchant.onboarding.activate({ tenantId });
    assert(activated.ok, "merchant went live after KYB approval");
    const [tenantRow] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    assert(tenantRow.status === "active", "tenant status active");

    // ── 4. First product listed ───────────────────────────────────────────
    const created = await merchant.product.create({
      tenantId,
      sku: J102_SKU,
      name: J102_PRODUCT_NAME,
      price: J102_PRICE_NGN.toFixed(2),
      currency: "NGN",
      stockQuantity: 10,
    });
    assert(created, "product.create returned");
    const [product] = await world.db
      .select()
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.sku, J102_SKU)))
      .limit(1);
    assert(product, "first product persisted for the new merchant");

    // ── 5. First WhatsApp sale on the merchant's own number ───────────────
    // Attach the merchant's own phone number id + access token (plaintext
    // passes through decryptSecret) so waSender makes REAL Graph calls that
    // the harness records in outbound[].
    const [tRow] = await world.db.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    await world.db
      .update(schema.tenants)
      .set({
        whatsappPhoneNumberId: J102_PHONE_NUMBER_ID,
        settings: { ...((tRow?.settings as any) ?? {}), whatsapp: { accessToken: "sim-wa-access-token" } },
      })
      .where(eq(schema.tenants.id, tenantId));

    const buyer = world.newPhone("b");
    const { recordConsent } = await import("../../server/services/consent");
    await recordConsent(world.db, { tenantId, phone: buyer, granted: true });

    const tag = crypto.randomUUID().slice(0, 8);
    const addText = `i want ankara [${tag}]`;
    world.llm.when(addText, {
      reply: "Added to your cart!",
      intent: "add_to_cart",
      nextState: "add_to_cart",
      extractedItems: [{ product: J102_PRODUCT_NAME, quantity: 1 }],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.95,
    });
    await world.inbound(payloads.inbound.text(J102_PHONE_NUMBER_ID, buyer, addText));
    const confirmText = `confirm please [${tag}]`;
    world.llm.when(confirmText, {
      reply: "Let me confirm that.",
      intent: "confirm_order",
      nextState: "checkout_confirm",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.95,
    });
    await world.inbound(payloads.inbound.text(J102_PHONE_NUMBER_ID, buyer, confirmText));
    await new Promise((r) => setTimeout(r, 5));
    await world.inbound(payloads.inbound.text(J102_PHONE_NUMBER_ID, buyer, "1")); // pickup

    await world.waitFor(async () => {
      const [o] = await world.db
        .select()
        .from(schema.orders)
        .where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.customerId, buyer)))
        .orderBy(desc(schema.orders.createdAt))
        .limit(1);
      return !!o;
    }, 10000, "merchant's first WhatsApp order created");
    const [order] = await world.db
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.customerId, buyer)))
      .orderBy(desc(schema.orders.createdAt))
      .limit(1);
    assert(Number(order.totalAmount) === J102_PRICE_NGN, `order total ₦${J102_PRICE_NGN} (got ${order.totalAmount})`);

    const [tx] = await world.db
      .select()
      .from(schema.paymentTransactions)
      .where(eq(schema.paymentTransactions.orderId, order.id))
      .orderBy(desc(schema.paymentTransactions.createdAt))
      .limit(1);
    assert(tx?.providerRef, "paystack payment initiated (provider ref present)");
    assert(tx.paymentUrl, "paystack payment URL issued");

    // ── 6. Payment confirmed → merchant wallet credited (PSP custody) ─────
    const [cfgBefore] = await world.db.select().from(schema.escrowConfig).where(eq(schema.escrowConfig.id, 1)).limit(1);
    const priorMode = cfgBefore?.custodyMode ?? "pssp";
    await world.db
      .update(schema.escrowConfig)
      .set({ custodyMode: "psp" })
      .where(eq(schema.escrowConfig.id, 1));
    try {
      const result = await paystackChargeSuccess(world, { reference: tx.providerRef, amountMajor: J102_PRICE_NGN });
      assert(result.status === 200, `paystack webhook accepted (got ${result.status})`);

      await world.waitFor(async () => {
        const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.id)).limit(1);
        return o?.status === "confirmed" && o?.paymentStatus === "completed";
      }, 10000, "order confirmed after webhook");

      await world.waitFor(
        async () => bodyText(world.outbound.lastOfType("text", buyer)).includes("Payment Receipt"),
        20000, "buyer received the payment receipt");
      const receipt = bodyText(world.outbound.lastOfType("text", buyer));
      assertIncludes(receipt, "Payment Receipt", "buyer received the receipt");

      const [wallet] = await world.db
        .select()
        .from(schema.merchantWallets)
        .where(eq(schema.merchantWallets.tenantId, tenantId))
        .limit(1);
      assert(wallet, "merchant wallet created by payment confirmation");
      assert(Number(wallet.escrowBalance) === J102_PRICE_NGN,
        `wallet escrow balance credited ₦${J102_PRICE_NGN} (got ${wallet.escrowBalance})`);
      const walletTxs = await world.db
        .select()
        .from(schema.walletTransactions)
        .where(eq(schema.walletTransactions.walletId, wallet.id));
      assert(walletTxs.length === 1 && walletTxs[0].type === "escrow_credit",
        "wallet escrow_credit transaction recorded");
      assert(Number(walletTxs[0].amount) === J102_PRICE_NGN, "wallet tx amount matches the sale");
    } finally {
      await world.db
        .update(schema.escrowConfig)
        .set({ custodyMode: priorMode })
        .where(eq(schema.escrowConfig.id, 1));
    }
  },
};
