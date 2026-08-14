/**
 * J84 — New-tenant Wave-16 distribution e2e (W16 F7+F9).
 *
 * A brand-new tenant goes from zero to live entirely through Wave-16 rails:
 *   1. Tenant row created with NO WhatsApp credentials.
 *   2. Embedded signup (scripted Meta exchange, session-info hints) → the
 *      tenant's WABA/phone-number columns + settings.whatsapp are populated.
 *   3. Template pre-approval: the welcome template is submitted to the new
 *      WABA via the real createMetaTemplate path (metaMock Graph seam).
 *   4. Shopify connect (signed-state OAuth, injected fetch) → catalog sync
 *      pushes the tenant's product to the scripted shop.
 *   5. A Shopify orders/create webhook bridges the tenant's FIRST order
 *      (kobo totals, customer matched/created by phone).
 *   6. The same customer messages the tenant's NEW WhatsApp number and flows
 *      through the EXISTING consent → menu path — the replies leave via the
 *      embedded-signup credentials (pn_j84 + meta-token-j84), proving the
 *      Wave-16 onboarding rails plug into the unmodified send pipeline.
 *
 * This journey DOES produce WhatsApp traffic (the leg-6 conversation), so
 * transcripts/J84.json captures it.
 */
import { eq } from "drizzle-orm";
import { assert, bodyText, META_APP_ID_VALUE, type World } from "../world";
import type { Journey } from "../runner";
import * as payloads from "../payloads";

const T84 = "sim-w16-tenant";
const T84_NAME = "Wave16 Fresh Stores";
const SHOP = "shop-j84.myshopify.com";
const WABA84 = "waba_j84";
const PN84 = "pn_j84";

export const journey: Journey = {
  id: "J84",
  name: "new-tenant w16 distribution e2e",
  feature: "embedded signup → template submit → shopify connect+sync → first bridged order → WhatsApp consent/menu on new creds",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const es = await import("../../server/services/embeddedSignup");
    const pre = await import("../../server/services/waTemplates/preApproval");
    const { buildInstallUrl, handleOAuthCallback } = await import("../../server/services/shopifyIntegration/oauth");
    const { setShopifyFetch, resetShopifyFetch } = await import("../../server/services/shopifyIntegration/client");
    const { syncCatalogToShopify } = await import("../../server/services/shopifyIntegration/catalogSync");
    const { bridgeShopifyOrder } = await import("../../server/services/shopifyIntegration/orderBridge");

    const customerPhone = world.newPhone("j84");

    // Scripted Meta (embedded-signup exchange only — hints carry the rest).
    const metaCalls: string[] = [];
    const fakeMeta = async (url: string): Promise<Response> => {
      metaCalls.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith("/oauth/access_token")) {
        assert(u.searchParams.get("client_id") === META_APP_ID_VALUE, "exchange under the sim Meta app");
        return new Response(JSON.stringify({ access_token: "meta-token-j84" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: "unscripted" } }), { status: 404 });
    };

    // Scripted Shopify shop.
    const shopifyCalls: Array<{ url: string; method: string }> = [];
    let nextProductId = 6000;
    const fakeShopify = async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const method = String(init.method ?? "GET").toUpperCase();
      shopifyCalls.push({ url, method });
      const ok = (status: number, data: unknown) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => data,
        text: async () => JSON.stringify(data),
      });
      if (u.pathname === "/admin/oauth/access_token") {
        return ok(200, { access_token: "shpat_j84", scope: "read_products,write_products,read_orders" });
      }
      if (u.pathname.endsWith("/products.json") && method === "GET") return ok(200, { products: [] });
      if (u.pathname.endsWith("/products.json") && method === "POST") {
        return ok(201, { product: { id: ++nextProductId } });
      }
      return ok(404, { errors: "unscripted" });
    };
    setShopifyFetch(fakeShopify as any);

    try {
      // ── 1. Fresh tenant + one product ────────────────────────────────────
      await world.db.insert(schema.tenants).values({
        id: T84,
        name: T84_NAME,
        slug: "sim-w16-tenant",
        plan: "growth",
        status: "active",
        defaultCurrency: "NGN",
        defaultLanguage: "en",
        settings: {
          plan: { tier: "growth", limits: { messagesPerMonth: 1000, ordersPerMonth: 1000 } },
          adminPhone: "2348099922222",
        },
      });
      await world.db.insert(schema.products).values({
        id: "p-w16-soap",
        tenantId: T84,
        sku: "W16-SOAP",
        name: "Shea Soap",
        description: "Handmade shea soap",
        category: "sim",
        price: "1200.00",
        currency: "NGN",
        imageUrl: "https://cdn.sim.local/soap.jpg",
        status: "active",
        stockQuantity: 25,
        lowStockThreshold: 3,
      });

      // ── 2. Embedded signup ───────────────────────────────────────────────
      const signup = await es.completeEmbeddedSignup(
        world.db,
        {
          tenantId: T84,
          code: "code-j84",
          wabaId: WABA84,
          phoneNumberId: PN84,
          displayPhoneNumber: "+234 703 555 6666",
        },
        fakeMeta as any,
      );
      assert(signup.replayed === false && signup.record.phoneNumberId === PN84, "signup completed");
      assert(metaCalls.length === 1, "hinted signup made only the exchange call");
      const [t84] = await world.db
        .select({ pn: schema.tenants.whatsappPhoneNumberId, waba: schema.tenants.whatsappBusinessAccountId })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, T84))
        .limit(1);
      assert(t84?.pn === PN84 && t84?.waba === WABA84, "tenant columns carry the new channel");

      // ── 3. Template pre-approval submit ──────────────────────────────────
      const tpl = await pre.submitTemplate(world.db, T84, "welcome_message", "en");
      assert(tpl.ok === true && tpl.submission.status === "submitted", "welcome template submitted");
      const tplPost = world.outbound.all().find((c) => c.url.includes(`/${WABA84}/message_templates`) && c.method === "POST");
      assert(tplPost?.body?.name === "w16_welcome_message", "library template POSTed to the NEW waba");
      assert(tplPost?.authToken === "meta-token-j84", "template submit used the exchanged token");

      // ── 4. Shopify connect + catalog sync ────────────────────────────────
      const installUrl = await buildInstallUrl(T84, { shop: SHOP });
      assert(installUrl, "install url minted for the fresh tenant");
      const state = new URL(installUrl!).searchParams.get("state") ?? "";
      const cb = await handleOAuthCallback({ shop: SHOP, code: "code-j84", state });
      assert(cb.ok === true && cb.tenantId === T84, "shopify connected");
      const sync = await syncCatalogToShopify(T84);
      assert(sync.ok === true && sync.created === 1 && sync.failed === 0, "one product synced out");
      assert(
        shopifyCalls.some((c) => c.method === "POST" && c.url.endsWith("/products.json")),
        "product created at the scripted shop",
      );

      // ── 5. First bridged order ───────────────────────────────────────────
      const bridged = await bridgeShopifyOrder(T84, {
        id: 88001,
        order_number: 5001,
        currency: "NGN",
        total_price: "1200.00",
        financial_status: "paid",
        customer: { phone: `+${customerPhone}`, first_name: "Fresh", last_name: "Buyer" },
        line_items: [{ sku: "W16-SOAP", title: "Shea Soap", quantity: 1, price: "1200.00" }],
      });
      assert(bridged.action === "created", "first shopify order bridged for the new tenant");
      const [order] = await world.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.tenantId, T84))
        .limit(1);
      assert(order?.orderNumber === "SHOPIFY-5001" && order.totalAmount === "1200.00", "bridged order persisted with kobo totals");

      // ── 6. Existing WhatsApp path on the new credentials ────────────────
      const outBefore = world.outbound.all().length;
      await world.inbound(payloads.inbound.text(PN84, customerPhone, "hello", { profileName: "Fresh Buyer" }));
      const prompt = world.outbound
        .all()
        .slice(outBefore)
        .find((c) => c.url.includes(`/${PN84}/messages`) && c.body?.text?.body);
      assert(prompt, "consent prompt went out on the embedded-signup number");
      assert(prompt!.authToken === "meta-token-j84", "reply sent with the exchanged token");
      const promptText = bodyText(prompt);
      assert(
        promptText.includes("NDPR") || promptText.includes("Reply YES"),
        `consent prompt copy (got ${JSON.stringify(promptText.slice(0, 200))})`,
      );

      await world.inbound(payloads.inbound.text(PN84, customerPhone, "YES"));
      const replies = world.outbound
        .all()
        .slice(outBefore)
        .filter((c) => c.url.includes(`/${PN84}/messages`) && c.body?.text?.body);
      const menu = replies.map((c) => bodyText(c)).find((t) => t.includes(`Welcome to ${T84_NAME}`));
      assert(menu, `post-consent menu rendered for the fresh tenant (got ${replies.map((c) => bodyText(c)).join(" | ").slice(0, 300)})`);
      assert(replies.every((c) => c.authToken === "meta-token-j84"), "every send used the new credentials");

      const [consent] = await world.db
        .select()
        .from(schema.consents)
        .where(eq(schema.consents.tenantId, T84))
        .limit(1)
        .catch(() => []);
      assert(consent?.granted === true, "consent recorded for the new tenant's customer");
    } finally {
      resetShopifyFetch();
      const ords = await world.db
        .select({ id: schema.orders.id })
        .from(schema.orders)
        .where(eq(schema.orders.tenantId, T84))
        .catch(() => [] as Array<{ id: string }>);
      for (const o of ords) {
        await world.db.delete(schema.orderItems).where(eq(schema.orderItems.orderId, o.id)).catch(() => {});
      }
      await world.db.delete(schema.orders).where(eq(schema.orders.tenantId, T84)).catch(() => {});
      await world.db.delete(schema.consents).where(eq(schema.consents.tenantId, T84)).catch(() => {});
      await world.db.delete(schema.products).where(eq(schema.products.tenantId, T84)).catch(() => {});
      await world.db.delete(schema.tenants).where(eq(schema.tenants.id, T84)).catch(() => {});
    }
  },
};
