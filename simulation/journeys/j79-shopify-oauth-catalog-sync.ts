/**
 * J79 — Shopify OAuth + catalog sync e2e (W16 F7).
 *
 * NOTE (W16): this journey drives the shopifyIntegration services directly
 * with an injected fake fetch (setShopifyFetch) — no WhatsApp traffic, so
 * transcripts/J79.json is intentionally a header-only stub (messages: []).
 * Same convention as J75–J77.
 *
 * Flow:
 *   1. buildInstallUrl mints a signed state (<tenantId>.<nonce>.<hmac>) and
 *      persists the one-time nonce (10-min TTL) in tenant settings.
 *   2. Tampered state (bad HMAC) and an unknown-but-validly-signed nonce are
 *      both REJECTED before any token exchange.
 *   3. Valid callback → code exchanged against the scripted Shopify OAuth
 *      endpoint → token persisted ENCRYPTED (v1: envelope, raw token never
 *      appears in settings) and resolvable via getShopifyConnection; the
 *      nonce is consumed (replay rejected).
 *   4. syncCatalogToShopify: search-before-create ADOPTS a pre-existing
 *      Shopify product by handle, creates the rest; a re-run UPDATES all
 *      mapped products with ZERO create calls; dry-run performs ZERO
 *      network calls and mutates no state.
 */
import { eq } from "drizzle-orm";
import {
  assert,
  SHOPIFY_API_KEY_VALUE,
  SHOPIFY_API_SECRET_VALUE,
  TENANT_ID,
  type World,
} from "../world";
import type { Journey } from "../runner";

const SHOP = "shop-j79.myshopify.com";

export const journey: Journey = {
  id: "J79",
  name: "shopify oauth + catalog sync e2e",
  feature: "signed-state OAuth → encrypted token → sync create/adopt/update → dry-run zero-write",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { buildInstallUrl, handleOAuthCallback } = await import("../../server/services/shopifyIntegration/oauth");
    const { setShopifyFetch, resetShopifyFetch } = await import("../../server/services/shopifyIntegration/client");
    const { signOAuthState } = await import("../../server/services/shopifyIntegration/security");
    const { syncCatalogToShopify } = await import("../../server/services/shopifyIntegration/catalogSync");
    const { readShopifyState, getShopifyConnection } = await import("../../server/services/shopifyIntegration/state");

    // ── Scripted Shopify Admin API ─────────────────────────────────────────
    const calls: Array<{ url: string; method: string; body: any }> = [];
    let nextProductId = 8000;
    const shopifyProducts = new Map<string, { id: number; handle: string }>();
    // Pre-existing product created OUTSIDE this flow — must be adopted.
    shopifyProducts.set("sim-jollof", { id: 9001, handle: "sim-jollof" });

    const fakeShopify = async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const method = String(init.method ?? "GET").toUpperCase();
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      const ok = (status: number, data: unknown) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => data,
        text: async () => JSON.stringify(data),
      });
      if (u.pathname === "/admin/oauth/access_token" && method === "POST") {
        if (body?.code !== "code-j79") return ok(400, { error: "invalid code" });
        return ok(200, { access_token: "shpat_j79_secret_token", scope: "read_products,write_products,read_orders" });
      }
      if (u.pathname.endsWith("/products.json") && method === "GET") {
        const handle = u.searchParams.get("handle") ?? "";
        const found = shopifyProducts.get(handle);
        return ok(200, { products: found ? [{ id: found.id, handle: found.handle }] : [] });
      }
      if (u.pathname.endsWith("/products.json") && method === "POST") {
        const id = ++nextProductId;
        const handle = body?.product?.handle ?? `p-${id}`;
        shopifyProducts.set(handle, { id, handle });
        return ok(201, { product: { id, handle } });
      }
      const putMatch = /\/products\/(\d+)\.json$/.exec(u.pathname);
      if (putMatch && method === "PUT") {
        const id = Number(putMatch[1]);
        const known = Array.from(shopifyProducts.values()).some((p) => p.id === id);
        if (!known) return ok(404, { errors: "not found" });
        return ok(200, { product: { id } });
      }
      return ok(404, { errors: `unscripted ${method} ${u.pathname}` });
    };
    setShopifyFetch(fakeShopify as any);

    const shopifyState = async () =>
      readShopifyState((await world.tenantSettings()) as any);

    try {
      // ── 1. Install URL + signed state ────────────────────────────────────
      const installUrl = await buildInstallUrl(TENANT_ID, { shop: SHOP });
      assert(installUrl, "install url built (app configured via sim env)");
      assert(installUrl!.startsWith(`https://${SHOP}/admin/oauth/authorize?`), "authorize url targets the shop");
      assert(installUrl!.includes(`client_id=${SHOPIFY_API_KEY_VALUE}`), "client id embedded");
      const state = new URL(installUrl!).searchParams.get("state") ?? "";
      const parts = state.split(".");
      assert(parts.length === 3 && parts[0] === TENANT_ID, "state = <tenantId>.<nonce>.<hmac>");
      assert((await shopifyState()).pendingOAuth?.nonce === parts[1], "one-time nonce persisted");

      // ── 2. Tampered + unknown-nonce states rejected pre-exchange ────────
      const tampered = state.slice(0, -1) + (state.endsWith("a") ? "b" : "a");
      const bad1 = await handleOAuthCallback({ shop: SHOP, code: "code-j79", state: tampered });
      assert(bad1.ok === false && bad1.error === "invalid state signature", "tampered state rejected (HMAC)");
      const forgedNonce = "00000000-0000-0000-0000-000000000000";
      const forgedPayload = `${TENANT_ID}.${forgedNonce}`;
      const forgedState = `${forgedPayload}.${signOAuthState(forgedPayload, SHOPIFY_API_SECRET_VALUE)}`;
      const bad2 = await handleOAuthCallback({ shop: SHOP, code: "code-j79", state: forgedState });
      assert(
        bad2.ok === false && bad2.error === "unknown or already-used oauth nonce",
        "validly-signed but never-persisted nonce rejected (one-time server-side nonce)",
      );
      const badShop = await handleOAuthCallback({ shop: "evil.example.com", code: "code-j79", state });
      assert(badShop.ok === false && badShop.error === "invalid shop domain", "non-myshopify domain rejected");
      assert(calls.length === 0, "no Shopify call made for rejected callbacks");

      // ── 3. Valid callback → exchange + encrypted persistence ────────────
      const cb = await handleOAuthCallback({ shop: SHOP, code: "code-j79", state });
      assert(cb.ok === true && cb.tenantId === TENANT_ID && cb.shop === SHOP, "oauth callback succeeds");
      assert(
        calls.length === 1 && calls[0].url === `https://${SHOP}/admin/oauth/access_token`,
        "exactly one token-exchange call",
      );

      const connState = (await shopifyState()).connection;
      assert(connState?.shop === SHOP, "connection persisted");
      assert(
        typeof connState?.accessTokenEncrypted === "string" && connState.accessTokenEncrypted.startsWith("v1:"),
        "access token stored ENCRYPTED (v1: envelope)",
      );
      const settingsRaw = JSON.stringify(await world.tenantSettings());
      assert(!settingsRaw.includes("shpat_j79_secret_token"), "raw token never appears in settings json");
      const live = await getShopifyConnection(TENANT_ID);
      assert(live?.accessToken === "shpat_j79_secret_token", "token decrypts back for live use");
      assert((await shopifyState()).pendingOAuth === null, "nonce consumed (one-time)");

      const replay = await handleOAuthCallback({ shop: SHOP, code: "code-j79", state });
      assert(replay.ok === false && replay.error === "unknown or already-used oauth nonce", "callback replay rejected");
      assert(calls.length === 1, "replay never reaches the token endpoint");

      const connectAudit = await world.db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, "shopify.connected"));
      assert(connectAudit.length === 1, "shopify.connected audit-logged");
      assert(!JSON.stringify(connectAudit[0]).includes("shpat_j79_secret_token"), "audit row carries no token");

      // ── 4. Catalog sync: adopt + create ──────────────────────────────────
      // Other journeys (J75) may leave extra tenant products behind — count
      // the live catalog instead of assuming exactly the 6 seeds.
      const catalogRows = await world.db
        .select({ sku: schema.products.sku })
        .from(schema.products)
        .where(eq(schema.products.tenantId, TENANT_ID));
      const totalProducts = catalogRows.length;
      const sync1 = await syncCatalogToShopify(TENANT_ID);
      assert(sync1.ok === true && sync1.failed === 0, `sync 1 clean (${JSON.stringify(sync1.items).slice(0, 200)})`);
      assert(
        sync1.created === totalProducts && sync1.updated === 0,
        `all ${totalProducts} tenant products created/adopted (got c=${sync1.created} u=${sync1.updated})`,
      );
      const jollof = sync1.items.find((i) => i.sku === "SIM-JOLLOF");
      assert(jollof?.action === "adopted" && jollof.externalId === "9001", "pre-existing shopify product ADOPTED by handle");
      const creates1 = calls.filter((c) => c.method === "POST" && c.url.endsWith("/products.json")).length;
      assert(creates1 === totalProducts - 1, `exactly ${totalProducts - 1} creates (1 adopted) — got ${creates1}`);
      const state1 = await shopifyState();
      assert(state1.catalog.externalIds["SIM-JOLLOF"] === "9001", "adopted externalId mapped");
      assert(Object.keys(state1.catalog.externalIds).length === totalProducts, "all skus mapped");
      assert(typeof state1.catalog.lastSyncAt === "string", "lastSyncAt persisted");

      // ── 5. Re-sync: update-in-place, zero creates ───────────────────────
      const sync2 = await syncCatalogToShopify(TENANT_ID);
      assert(
        sync2.ok === true && sync2.updated === totalProducts && sync2.created === 0,
        `re-sync updates all ${totalProducts}, creates none`,
      );
      const creates2 = calls.filter((c) => c.method === "POST" && c.url.endsWith("/products.json")).length;
      assert(creates2 === totalProducts - 1, "ZERO create calls on re-sync (no duplicates)");

      // ── 6. Dry-run: zero network, zero state mutation ───────────────────
      const callsBefore = calls.length;
      const syncAtBefore = (await shopifyState()).catalog.lastSyncAt;
      const dry = await syncCatalogToShopify(TENANT_ID, { dryRun: true });
      assert(dry.dryRun === true && dry.updated === totalProducts, "dry-run plans updates for mapped products");
      assert(calls.length === callsBefore, "dry-run made ZERO network calls");
      const state2 = await shopifyState();
      assert(state2.catalog.lastSyncAt === syncAtBefore, "dry-run persisted nothing");

      const syncAudit = await world.db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, "shopify.catalog.synced"));
      assert(syncAudit.length === 2, "two real syncs audit-logged (dry-run is not)");
    } finally {
      resetShopifyFetch();
    }
  },
};
