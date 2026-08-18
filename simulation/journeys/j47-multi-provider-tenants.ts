/**
 * J47 — Provider registry tenant isolation + single-gateway checkout.
 *
 * Originally this journey proved per-tenant payment routing: tenant A used
 * a seeded Paystack config, tenant B a Flutterwave config written via
 * upsertTenantProviderConfig, and chat checkout picked whichever provider
 * was configured for that tenant. That routing was removed deliberately —
 * every order now charges the PLATFORM's own gateway key (custodyMode
 * "psp": tenants get their share via wallet payout, not their own gateway
 * credentials), so chat checkout no longer consults the per-tenant registry
 * at all. Tenant B's Flutterwave config is still written and still proven
 * isolated/encrypted at rest below — that machinery is real and still used
 * elsewhere (server/services/payments/initiateWithFallback.ts,
 * unifiedWebhook.ts) — but BOTH tenants' chat checkouts now resolve to the
 * same platform-wide Paystack link, and both confirm via Paystack webhooks.
 * Order/receipt isolation between the two tenants is still asserted.
 */
import crypto from "crypto";
import { eq, and, desc } from "drizzle-orm";
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { SUPPLIER_TENANT_ID, SUPPLIER_PRODUCTS, TENANT_ID } from "../world";
import { createChatOrderViaNlp, paystackChargeSuccess } from "./helpers";

const FLW_SECRET_KEY = "flw_sk_sim_b";
const FLW_SECRET_HASH = "flw_hash_sim_b";

/** Chat order on the SUPPLIER tenant's channel (crates × 2 = ₦5,000). */
async function createSupplierChatOrder(world: World, phone: string) {
  const tag = crypto.randomUUID().slice(0, 8);
  const addText = `i need crates [${tag}]`;
  world.llm.when(addText, {
    reply: "Added to your cart!",
    intent: "add_to_cart",
    nextState: "add_to_cart",
    extractedItems: [{ product: SUPPLIER_PRODUCTS.crates.name, quantity: 2 }],
    extractedProduct: null,
    extractedQuantity: null,
    extractedAddress: null,
    confidence: 0.95,
  });
  await world.supplierText(phone, addText);
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
  await world.supplierText(phone, confirmText);
  await new Promise((r) => setTimeout(r, 5));
  await world.supplierText(phone, "1"); // pickup

  const schema = await import("../../drizzle/schema");
  const [order] = await world.db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.tenantId, SUPPLIER_TENANT_ID), eq(schema.orders.customerId, phone)))
    .orderBy(desc(schema.orders.createdAt))
    .limit(1);
  assert(order, "supplier-tenant chat order was created");
  const [tx] = await world.db
    .select()
    .from(schema.paymentTransactions)
    .where(eq(schema.paymentTransactions.orderId, order.id))
    .orderBy(desc(schema.paymentTransactions.createdAt))
    .limit(1);
  return { order, tx };
}

export const journey: Journey = {
  id: "J47",
  name: "provider registry isolation + single-gateway checkout",
  feature: "provider registry per-tenant chains (data layer) vs platform-wide checkout routing",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { upsertTenantProviderConfig, getProviderForTenant } = await import(
      "../../server/services/payments/providers/registry"
    );
    const { recordConsent } = await import("../../server/services/consent");

    // ── Tenant B: flutterwave config via the encrypt-on-write registry path ─
    // Still real, still-used machinery (initiateWithFallback/unifiedWebhook) —
    // just no longer consulted by chat checkout, which is what's proven below.
    const up = await upsertTenantProviderConfig({
      tenantId: SUPPLIER_TENANT_ID,
      provider: "flutterwave",
      creds: { secretKey: FLW_SECRET_KEY, secretHash: FLW_SECRET_HASH },
      priority: 0,
    });
    assert(up.ok, "flutterwave config upserted for tenant B");

    // Tenant isolation of the registry chains — data-layer correctness,
    // independent of whether chat checkout currently reads it.
    const chainA = await getProviderForTenant(TENANT_ID);
    const chainB = await getProviderForTenant(SUPPLIER_TENANT_ID);
    assert(chainA.length === 1 && chainA[0].provider.id === "paystack", "tenant A chain = [paystack]");
    assert(chainB.length === 1 && chainB[0].provider.id === "flutterwave", "tenant B chain = [flutterwave]");
    assert((chainB[0].creds as any).secretKey === FLW_SECRET_KEY, "tenant B creds decrypt back to the flw secret");
    assert((chainB[0].creds as any).secretHash === FLW_SECRET_HASH, "tenant B creds carry the flw secret hash");

    // At rest the secret is AES-256-GCM encrypted (v1: envelope, no plaintext).
    const [rowB] = await world.db
      .select()
      .from(schema.paymentGatewayConfigs)
      .where(and(eq(schema.paymentGatewayConfigs.tenantId, SUPPLIER_TENANT_ID), eq(schema.paymentGatewayConfigs.provider, "flutterwave")))
      .limit(1);
    assert(rowB, "tenant B config row persisted");
    assert(typeof rowB.secretKey === "string" && rowB.secretKey.startsWith("v1:"), "tenant B secretKey encrypted at rest");
    assert(!rowB.secretKey.includes(FLW_SECRET_KEY), "no plaintext secret at rest");

    // ── Tenant A checkout → platform's paystack link ────────────────────────
    const phoneA = world.newPhone("a");
    await world.grantConsent(phoneA);
    const orderA = await createChatOrderViaNlp(world, phoneA, {
      items: [{ product: "Jollof Rice", quantity: 1 }],
    });
    assert(orderA.paymentRef && orderA.paymentUrl, "tenant A payment link created");
    assert(
      orderA.paymentUrl!.startsWith("https://checkout.paystack.com/sim/"),
      `tenant A link served by the platform's paystack gateway (got ${orderA.paymentUrl})`,
    );
    const psInitA = world.outbound.all().find(
      (c) => c.url.includes("api.paystack.co/transaction/initialize") && JSON.stringify(c.body ?? {}).includes(orderA.paymentRef!),
    );
    assert(psInitA, "paystack initialize intercepted for tenant A's reference");

    // ── Tenant B checkout → SAME platform paystack link, despite tenant B ──
    // having its own (unused-by-checkout) flutterwave config on file.
    const phoneB = world.newPhone("b");
    await recordConsent(world.db, { tenantId: SUPPLIER_TENANT_ID, phone: phoneB, granted: true });
    const { order: orderB, tx: txB } = await createSupplierChatOrder(world, phoneB);
    assert(txB?.providerRef && txB?.paymentUrl, "tenant B payment link created");
    assert(
      String(txB.paymentUrl).startsWith("https://checkout.paystack.com/sim/"),
      `tenant B link also served by the platform's paystack gateway, not its own flutterwave config (got ${txB.paymentUrl})`,
    );
    const psInitB = world.outbound.all().find(
      (c) => c.url.includes("api.paystack.co/transaction/initialize") && JSON.stringify(c.body ?? {}).includes(txB.providerRef),
    );
    assert(psInitB, "paystack initialize intercepted for tenant B's reference");
    assert(Number(orderB.totalAmount) === 5000, `tenant B order total 5000 (got ${orderB.totalAmount})`);

    // ── B's paystack-signed webhook confirms B only ─────────────────────────
    const result = await paystackChargeSuccess(world, {
      reference: txB.providerRef,
      amountMajor: 5000,
    });
    assert(result.status === 200, `paystack webhook accepted (got ${result.status}: ${JSON.stringify(result.json)})`);

    await world.waitFor(async () => {
      const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderB.id)).limit(1);
      return o?.status === "confirmed";
    }, 10000, "tenant B order confirmed by paystack webhook");
    const [oB] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderB.id)).limit(1);
    assert(oB.paymentStatus === "completed", "tenant B payment completed");
    const [txBAfter] = await world.db.select().from(schema.paymentTransactions).where(eq(schema.paymentTransactions.id, txB.id)).limit(1);
    assert(txBAfter.status === "completed", "tenant B transaction completed");

    // ── A unaffected: still pending, no confirm side effects ───────────────
    const [oA] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderA.orderId)).limit(1);
    assert(oA.status === "pending", `tenant A order still pending (got ${oA.status})`);
    assert(oA.paymentStatus !== "completed", "tenant A payment not completed by B's webhook");
    const receiptA = world.outbound.findByBody("Payment Receipt", phoneA);
    assert(receiptA.length === 0, "tenant A received no receipt from B's webhook");
    const receiptB = world.outbound.findByBody("Payment Receipt", phoneB);
    assert(receiptB.length > 0, "tenant B received its payment receipt");
    assertIncludes(bodyText(receiptB[receiptB.length - 1]), txB.providerRef, "tenant B receipt carries the paystack reference");
  },
};
