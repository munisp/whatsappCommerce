/**
 * shopifyIntegration.test.ts — Shopify app connector (roadmap F7, W16).
 *
 * Covers: webhook HMAC verification (valid/invalid/timing-safe), OAuth state
 * nonce sign/verify + one-time consumption, token redaction + encrypted
 * persistence, catalog sync idempotency/dry-run/adoption/partial failure,
 * order bridge (kobo math, exactly-once dedupe, unknown SKU, phone match),
 * webhook express handler, ConnectorDescriptor frozen seam, router gating.
 *
 * DB is mocked in-memory (same style as erpProvision.test.ts); all Shopify
 * HTTP goes through the injected setShopifyFetch stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TrpcContext } from "./_core/context";
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Env must be set before server/_core/env.ts is evaluated.
vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = "test-api-secret";
  process.env.SHOPIFY_APP_URL = "https://app.test";
});

import crypto from "crypto";
import {
  verifyShopifyWebhookHmac,
  timingSafeEqualStr,
  signOAuthState,
  verifyOAuthState,
  redactShopifyPayload,
  redactShopifySecrets,
  setShopifyFetch,
  resetShopifyFetch,
  buildInstallUrl,
  handleOAuthCallback,
  uninstallShopify,
  syncCatalogToShopify,
  bridgeShopifyOrder,
  toKobo,
  shopifyConnector,
  getShopifyStatus,
} from "./services/shopifyIntegration";
import {
  handleShopifyWebhookExpress,
  handleShopifyOAuthCallbackExpress,
} from "./services/shopifyIntegration/webhook";
import { shopifyIntegrationRouter } from "./routers/shopifyIntegration";
import { encryptSecret } from "./services/crypto/secrets";

const SECRET = "test-api-secret";
const T1 = "tenant-1";
const T2 = "tenant-2";
const SHOP = "demo-store.myshopify.com";

// ─── In-memory DB mock ───────────────────────────────────────────────────────

const stores: Record<string, Record<string, unknown>[]> = {
  tenants: [],
  tenant_memberships: [],
  products: [],
  customers: [],
  orders: [],
  order_items: [],
  audit_logs: [],
};

const dialect = new PgDialect();

function filterRows(table: unknown, cond: unknown, rows: Record<string, unknown>[]) {
  if (!cond) return rows;
  let compiled: { sql: string; params: unknown[] };
  try {
    compiled = dialect.sqlToQuery(cond as never);
  } catch {
    return rows;
  }
  const colMap: Record<string, string> = {};
  try {
    for (const [prop, col] of Object.entries(getTableColumns(table as never))) {
      colMap[(col as { name: string }).name] = prop;
    }
  } catch {
    return rows;
  }
  const tests: Array<(r: Record<string, unknown>) => boolean> = [];
  for (const part of compiled.sql.split(/ and /)) {
    const mEq = part.match(/"[\w]+"\."([\w]+)" = \$(\d+)/);
    if (mEq) {
      const prop = colMap[mEq[1]];
      const val = compiled.params[Number(mEq[2]) - 1];
      if (prop) tests.push((r) => String(r[prop]) === String(val));
    }
  }
  return rows.filter((r) => tests.every((t) => t(r)));
}

function makeChain(rows: Record<string, unknown>[]): any {
  const self: any = {};
  const chain = () => makeChain(rows);
  self.orderBy = chain;
  self.limit = chain;
  self.offset = chain;
  self.returning = () => Promise.resolve(rows);
  self.then = (resolve: (v: unknown) => void) => {
    resolve(rows);
    return self;
  };
  self.catch = () => self;
  return self;
}

function makeMockDb() {
  const db: any = {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table as never);
        const all = stores[name] ?? [];
        const api: any = {};
        api.where = (cond: unknown) => makeChain(filterRows(table, cond, all));
        api.orderBy = () => ({ limit: () => Promise.resolve(all) });
        api.then = (resolve: (v: unknown) => void) => {
          resolve(all);
          return api;
        };
        return api;
      },
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        const name = getTableName(table as never);
        const row = { id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...vals };
        (stores[name] ??= []).push(row);
        return {
          returning: () => Promise.resolve([row]),
          then: (resolve: (v: unknown) => void) => resolve([row]),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const name = getTableName(table as never);
          const matched = filterRows(table, cond, stores[name] ?? []);
          const simpleVals: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(vals)) {
            if (v == null || typeof v !== "object" || v instanceof Date) simpleVals[k] = v;
            else if (!("sql" in (v as object))) simpleVals[k] = v;
          }
          for (const row of matched) Object.assign(row, simpleVals, { updatedAt: new Date() });
          return {
            returning: () => Promise.resolve(matched),
            then: (resolve: (v: unknown) => void) => resolve(matched),
          };
        },
      }),
    }),
  };
  return db;
}

vi.mock("./db", () => ({
  getDb: vi.fn().mockImplementation(() => Promise.resolve(makeMockDb())),
}));

// ─── Shopify HTTP stub ───────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

interface ShopifyWorld {
  products: Map<string, any>; // id → product
  byHandle: Map<string, string>;
  nextId: number;
  requests: string[];
  failCreatesFor: Set<string>; // sku → POST /products returns 500
  exchangeToken: string | null;
  deleted: string[];
}

let world: ShopifyWorld;

function resetWorld() {
  world = {
    products: new Map(),
    byHandle: new Map(),
    nextId: 5000,
    requests: [],
    failCreatesFor: new Set(),
    exchangeToken: "shpat_test_token_123",
    deleted: [],
  };
}

async function shopifyFetchStub(url: string, init: RequestInit) {
  const u = String(url);
  const method = init.method ?? "GET";
  world.requests.push(`${method} ${u}`);

  if (u.endsWith("/admin/oauth/access_token")) {
    if (!world.exchangeToken) return jsonResponse({ error: "invalid code" }, 401);
    return jsonResponse({ access_token: world.exchangeToken, scope: "read_products,write_products,read_orders" });
  }
  if (u.includes("/api_permissions/current.json")) {
    world.deleted.push(u);
    return jsonResponse({});
  }
  if (u.includes("/shop.json")) {
    return jsonResponse({ shop: { id: 1, name: "Demo", myshopify_domain: SHOP } });
  }
  const body = init.body ? JSON.parse(String(init.body)) : null;
  const prodMatch = u.match(/\/products\/(\d+)\.json/);
  if (prodMatch) {
    const id = prodMatch[1];
    if (method === "PUT") {
      const existing = world.products.get(id);
      if (!existing) return jsonResponse({ errors: "not found" }, 404);
      world.products.set(id, { ...existing, ...body.product });
      return jsonResponse({ product: world.products.get(id) });
    }
  }
  if (u.includes("/products.json")) {
    if (method === "GET") {
      const handle = new URL(u).searchParams.get("handle");
      const id = handle ? world.byHandle.get(handle) : undefined;
      return jsonResponse({ products: id ? [{ id: Number(id), handle }] : [] });
    }
    if (method === "POST") {
      const sku = body?.product?.variants?.[0]?.sku;
      if (sku && world.failCreatesFor.has(sku)) {
        return jsonResponse({ errors: `boom ${world.exchangeToken}` }, 500);
      }
      const id = String(world.nextId++);
      const product = { id: Number(id), ...body.product };
      world.products.set(id, product);
      world.byHandle.set(product.handle, id);
      return jsonResponse({ product }, 201);
    }
  }
  return jsonResponse({ errors: `unstubbed ${method} ${u}` }, 500);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function seedTenant(id: string) {
  stores.tenants.push({ id, name: `Tenant ${id}`, settings: {} });
}

function seedProduct(tenantId: string, sku: string, overrides: Record<string, unknown> = {}) {
  stores.products.push({
    id: `prod-${sku}`,
    tenantId,
    sku,
    name: `Product ${sku}`,
    description: `Desc ${sku}`,
    price: "12.50",
    currency: "NGN",
    imageUrl: null,
    status: "active",
    stockQuantity: 7,
    ...overrides,
  });
}

function seedConnected(tenantId: string) {
  const t = stores.tenants.find((r) => r.id === tenantId)!;
  // Encrypt through the real path so decrypt works on read.
  t.settings = {
    shopifyIntegration: {
      connection: {
        shop: SHOP,
        accessTokenEncrypted: encryptSecret("shpat_test_token_123"),
        scope: "read_products",
        installedAt: new Date().toISOString(),
      },
    },
  };
}

function tenantSettings(id: string) {
  return (stores.tenants.find((t) => t.id === id)?.settings ?? {}) as Record<string, any>;
}

function hmacHeader(rawBody: Buffer, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

function makeUser(role: "admin" | "user", tenantId: string | null): NonNullable<TrpcContext["user"]> {
  return {
    id: role === "admin" ? 1 : 2,
    openId: `openid-${role}-${tenantId}`,
    email: `${role}@example.com`,
    name: `${role} user`,
    loginMethod: "keycloak",
    role,
    tenantId,
    phone: null,
    phoneVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  } as NonNullable<TrpcContext["user"]>;
}

function makeCtx(user: NonNullable<TrpcContext["user"]> | null): TrpcContext {
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

function seedMembership(userId: number | string, tenantId: string, role: string) {
  stores.tenant_memberships.push({ id: `m-${userId}-${tenantId}`, userId: String(userId), tenantId, role });
}

function mockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.body = undefined;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  return res;
}

beforeEach(() => {
  for (const key of Object.keys(stores)) stores[key] = [];
  resetWorld();
  setShopifyFetch(shopifyFetchStub as never);
});

afterEach(() => {
  resetShopifyFetch();
});

// ─── HMAC / security ─────────────────────────────────────────────────────────

describe("webhook HMAC verification", () => {
  const body = Buffer.from(JSON.stringify({ id: 123, line_items: [] }));

  it("accepts a valid X-Shopify-Hmac-Sha256 signature", () => {
    expect(verifyShopifyWebhookHmac(body, SECRET, hmacHeader(body))).toBe(true);
  });

  it("rejects an invalid signature", () => {
    expect(verifyShopifyWebhookHmac(body, SECRET, hmacHeader(body, "wrong-secret"))).toBe(false);
  });

  it("rejects a tampered body", () => {
    const sig = hmacHeader(body);
    const tampered = Buffer.from(JSON.stringify({ id: 999 }));
    expect(verifyShopifyWebhookHmac(tampered, SECRET, sig)).toBe(false);
  });

  it("rejects missing/empty header and empty secret (fail closed)", () => {
    expect(verifyShopifyWebhookHmac(body, SECRET, undefined)).toBe(false);
    expect(verifyShopifyWebhookHmac(body, SECRET, "")).toBe(false);
    expect(verifyShopifyWebhookHmac(body, "", hmacHeader(body))).toBe(false);
  });

  it("rejects malformed base64 without throwing", () => {
    expect(verifyShopifyWebhookHmac(body, SECRET, "!!!not-base64!!!")).toBe(false);
  });

  it("timingSafeEqualStr is length-guarded and exact", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
  });
});

describe("redaction", () => {
  it("redacts secret-ish keys from payloads", () => {
    const out = redactShopifyPayload({ accessToken: "x", nested: { api_key: "y" }, keep: "z" }) as any;
    expect(out.accessToken).toBe("[redacted]");
    expect(out.nested.api_key).toBe("[redacted]");
    expect(out.keep).toBe("z");
  });

  it("redacts known secret values from free text", () => {
    expect(redactShopifySecrets("failed with shpat_abc123", ["shpat_abc123"])).toBe("failed with [redacted]");
    expect(redactShopifySecrets("no secrets here", ["shpat_abc123"])).toBe("no secrets here");
  });
});

// ─── OAuth state nonce ───────────────────────────────────────────────────────

describe("OAuth state nonce", () => {
  it("signs and verifies state payloads", () => {
    const sig = signOAuthState("t1.nonce1", SECRET);
    expect(verifyOAuthState("t1.nonce1", sig, SECRET)).toBe(true);
    expect(verifyOAuthState("t1.nonce2", sig, SECRET)).toBe(false);
    expect(verifyOAuthState("t1.nonce1", sig, "other")).toBe(false);
  });

  it("buildInstallUrl embeds client_id, scopes, redirect and signed state; persists nonce", async () => {
    seedTenant(T1);
    const url = await buildInstallUrl(T1, { shop: SHOP });
    expect(url).toBeTruthy();
    const u = new URL(url!);
    expect(u.host).toBe(SHOP);
    expect(u.searchParams.get("client_id")).toBe("test-api-key");
    expect(u.searchParams.get("scope")).toContain("read_products");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.test/api/shopify/callback");
    const state = u.searchParams.get("state")!;
    const [tenantId, nonce, sig] = state.split(".");
    expect(tenantId).toBe(T1);
    expect(verifyOAuthState(`${tenantId}.${nonce}`, sig, SECRET)).toBe(true);
    expect(tenantSettings(T1).shopifyIntegration.pendingOAuth.nonce).toBe(nonce);
  });
});

// ─── OAuth callback + token handling ─────────────────────────────────────────

describe("OAuth callback", () => {
  async function install(tenantId = T1) {
    seedTenant(tenantId);
    const url = await buildInstallUrl(tenantId, { shop: SHOP });
    const state = new URL(url!).searchParams.get("state")!;
    return handleOAuthCallback({ shop: SHOP, code: "auth-code", state });
  }

  it("exchanges code and persists an ENCRYPTED token (plaintext never stored)", async () => {
    const result = await install();
    expect(result.ok).toBe(true);
    const conn = tenantSettings(T1).shopifyIntegration.connection;
    expect(conn.shop).toBe(SHOP);
    expect(conn.accessTokenEncrypted).not.toContain("shpat_test_token_123");
    expect(conn.accessTokenEncrypted.startsWith("v1:")).toBe(true);
    // nonce consumed (one-time)
    expect(tenantSettings(T1).shopifyIntegration.pendingOAuth).toBeNull();
    expect(await shopifyConnector.isConfigured(T1)).toBe(true);
  });

  it("rejects a forged state signature", async () => {
    seedTenant(T1);
    const result = await handleOAuthCallback({ shop: SHOP, code: "x", state: `${T1}.fake.deadbeef` });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: "invalid state signature" });
  });

  it("rejects an unknown/reused nonce", async () => {
    await install();
    const url = await buildInstallUrl(T1, { shop: SHOP });
    const state = new URL(url!).searchParams.get("state")!;
    // consume it once
    const first = await handleOAuthCallback({ shop: SHOP, code: "c", state });
    expect(first.ok).toBe(true);
    // replay → rejected
    const replay = await handleOAuthCallback({ shop: SHOP, code: "c", state });
    expect(replay.ok).toBe(false);
    expect(replay).toMatchObject({ error: "unknown or already-used oauth nonce" });
  });

  it("rejects an invalid shop domain", async () => {
    seedTenant(T1);
    const url = await buildInstallUrl(T1);
    const state = new URL(url!).searchParams.get("state")!;
    const result = await handleOAuthCallback({ shop: "evil.example.com", code: "c", state });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: "invalid shop domain" });
  });

  it("surfaces a failed token exchange without persisting state", async () => {
    seedTenant(T1);
    world.exchangeToken = null;
    const url = await buildInstallUrl(T1);
    const state = new URL(url!).searchParams.get("state")!;
    const result = await handleOAuthCallback({ shop: SHOP, code: "bad", state });
    expect(result.ok).toBe(false);
    expect(tenantSettings(T1).shopifyIntegration.connection ?? null).toBeNull();
  });
});

describe("uninstall", () => {
  it("revokes the token at Shopify and clears the connection", async () => {
    seedTenant(T1);
    seedConnected(T1);
    const result = await uninstallShopify(T1);
    expect(result.ok).toBe(true);
    expect(result.revoked).toBe(true);
    expect(world.deleted.some((u) => u.includes("api_permissions/current"))).toBe(true);
    expect(tenantSettings(T1).shopifyIntegration.connection).toBeNull();
    expect(await shopifyConnector.isConfigured(T1)).toBe(false);
  });
});

// ─── Catalog sync out ────────────────────────────────────────────────────────

describe("catalog sync", () => {
  it("throws when not connected (non dry-run)", async () => {
    seedTenant(T1);
    await expect(syncCatalogToShopify(T1)).rejects.toThrow(/not connected/i);
  });

  it("dry-run plans actions with no network calls and no state mutation", async () => {
    seedTenant(T1);
    seedProduct(T1, "SKU-1");
    const summary = await syncCatalogToShopify(T1, { dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.items).toEqual([{ sku: "SKU-1", action: "created", externalId: undefined }]);
    expect(world.requests).toHaveLength(0);
    expect(tenantSettings(T1).shopifyIntegration ?? null).toBeNull();
  });

  it("creates unmapped products and persists the sku→id mapping", async () => {
    seedTenant(T1);
    seedConnected(T1);
    seedProduct(T1, "SKU-1");
    const summary = await syncCatalogToShopify(T1);
    expect(summary.created).toBe(1);
    expect(summary.items[0]).toMatchObject({ sku: "SKU-1", action: "created", externalId: "5000" });
    expect(tenantSettings(T1).shopifyIntegration.catalog.externalIds["SKU-1"]).toBe("5000");
    expect(world.products.get("5000")?.variants?.[0]?.sku).toBe("SKU-1");
  });

  it("is idempotent: second run updates instead of creating duplicates", async () => {
    seedTenant(T1);
    seedConnected(T1);
    seedProduct(T1, "SKU-1");
    await syncCatalogToShopify(T1);
    const second = await syncCatalogToShopify(T1);
    expect(second.updated).toBe(1);
    expect(second.created).toBe(0);
    expect(world.products.size).toBe(1);
    expect(world.requests.filter((r) => r.startsWith("POST"))).toHaveLength(1);
  });

  it("adopts an existing Shopify product by handle (no duplicate)", async () => {
    seedTenant(T1);
    seedConnected(T1);
    seedProduct(T1, "SKU-9");
    // Pre-existing product in Shopify with the same handle, created outside the platform.
    world.products.set("7777", { id: 7777, handle: "sku-9" });
    world.byHandle.set("sku-9", "7777");
    const summary = await syncCatalogToShopify(T1);
    expect(summary.items[0].action).toBe("adopted");
    expect(summary.items[0].externalId).toBe("7777");
    expect(world.products.size).toBe(1);
  });

  it("isolates per-item failures and persists a summary", async () => {
    seedTenant(T1);
    seedConnected(T1);
    seedProduct(T1, "OK-1");
    seedProduct(T1, "BAD-1");
    world.failCreatesFor.add("BAD-1");
    const summary = await syncCatalogToShopify(T1);
    expect(summary.ok).toBe(false);
    expect(summary.created).toBe(1);
    expect(summary.failed).toBe(1);
    const bad = summary.items.find((i) => i.sku === "BAD-1")!;
    expect(bad.action).toBe("failed");
    // Token never leaks into the captured error string.
    expect(bad.error).not.toContain("shpat_test_token_123");
    expect(bad.error).toContain("[redacted]");
    const persisted = tenantSettings(T1).shopifyIntegration.catalog.lastResults;
    expect(persisted.failed).toBe(1);
    expect(persisted.created).toBe(1);
  });

  it("recreates when the mapped product was deleted in Shopify (stale mapping)", async () => {
    seedTenant(T1);
    seedConnected(T1);
    seedProduct(T1, "SKU-1");
    await syncCatalogToShopify(T1);
    world.products.delete("5000"); // deleted externally
    const summary = await syncCatalogToShopify(T1);
    expect(summary.items[0].action).toBe("created");
    expect(summary.items[0].externalId).not.toBe("5000");
  });
});

// ─── Order bridge in ─────────────────────────────────────────────────────────

function shopifyOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 424242,
    name: "#1001",
    order_number: 1001,
    currency: "NGN",
    current_total_price: "37.50",
    financial_status: "pending",
    customer: { phone: "+2348012345678", email: "buyer@example.com", first_name: "Ada" },
    line_items: [
      { sku: "SKU-1", title: "Product SKU-1", quantity: 3, price: "12.50" },
    ],
    ...overrides,
  } as any;
}

describe("order bridge", () => {
  it("toKobo does exact integer minor-unit math", () => {
    expect(toKobo("12.50")).toBe(1250);
    expect(toKobo("0.01")).toBe(1);
    expect(toKobo(19.99)).toBe(1999);
    expect(toKobo(null)).toBe(0);
    expect(toKobo("not-a-number")).toBe(0);
  });

  it("creates a platform order with kobo-accurate totals and matched line items", async () => {
    seedTenant(T1);
    seedConnected(T1);
    seedProduct(T1, "SKU-1");
    const result = await bridgeShopifyOrder(T1, shopifyOrder());
    expect(result.action).toBe("created");
    const order = stores.orders.find((o) => o.tenantId === T1)!;
    expect(order.totalAmount).toBe("37.50");
    expect(order.currency).toBe("NGN");
    expect((order.metadata as any).totalKobo).toBe(3750);
    expect((order.metadata as any).shopifyOrderId).toBe("424242");
    expect(order.erpOrderId).toBe("424242");
    expect(stores.order_items).toHaveLength(1);
    expect(stores.order_items[0]).toMatchObject({ productId: "prod-SKU-1", quantity: 3, unitPrice: "12.50" });
  });

  it("is exactly-once: a replayed webhook returns duplicate and never double-books", async () => {
    seedTenant(T1);
    seedConnected(T1);
    seedProduct(T1, "SKU-1");
    const first = await bridgeShopifyOrder(T1, shopifyOrder());
    const second = await bridgeShopifyOrder(T1, shopifyOrder());
    expect(first.action).toBe("created");
    expect(second).toEqual({ action: "duplicate", orderId: (first as any).orderId });
    expect(stores.orders).toHaveLength(1);
    expect(tenantSettings(T1).shopifyIntegration.orders.processedIds["424242"]).toBe((first as any).orderId);
  });

  it("captures orders with unknown SKUs and flags unmatched items", async () => {
    seedTenant(T1);
    seedConnected(T1);
    const result = await bridgeShopifyOrder(T1, shopifyOrder({
      line_items: [{ sku: "GHOST-1", title: "Ghost", quantity: 1, price: "5.00" }],
      current_total_price: "5.00",
    }));
    expect(result.action).toBe("created");
    expect((result as any).unmatchedItems).toEqual(["GHOST-1"]);
    const order = stores.orders[0];
    expect((order.metadata as any).unmatchedItems).toEqual(["GHOST-1"]);
    expect((order.items as any)[0].unmatched).toBe(true);
    // No order_items row for unmatched SKUs (FK to products).
    expect(stores.order_items).toHaveLength(0);
  });

  it("matches the customer by phone", async () => {
    seedTenant(T1);
    seedConnected(T1);
    stores.customers.push({ id: "cust-1", tenantId: T1, whatsappPhone: "+2348012345678", name: "Ada" });
    const result = await bridgeShopifyOrder(T1, shopifyOrder());
    expect(result.action).toBe("created");
    expect(stores.orders[0].customerId).toBe("cust-1");
    expect(stores.customers).toHaveLength(1); // no duplicate customer
  });

  it("creates a placeholder customer when no phone matches", async () => {
    seedTenant(T1);
    seedConnected(T1);
    const result = await bridgeShopifyOrder(T1, shopifyOrder({ customer: null }));
    expect(result.action).toBe("created");
    expect(stores.customers).toHaveLength(1);
    expect(String(stores.customers[0].whatsappPhone)).toMatch(/^shopify-424242/);
  });

  it("marks paid Shopify orders as confirmed/completed", async () => {
    seedTenant(T1);
    seedConnected(T1);
    await bridgeShopifyOrder(T1, shopifyOrder({ financial_status: "paid" }));
    expect(stores.orders[0].status).toBe("confirmed");
    expect(stores.orders[0].paymentStatus).toBe("completed");
  });

  it("falls back to the line-item sum when the Shopify total is absent", async () => {
    seedTenant(T1);
    seedConnected(T1);
    seedProduct(T1, "SKU-1");
    await bridgeShopifyOrder(T1, shopifyOrder({ current_total_price: undefined, total_price: undefined }));
    expect(stores.orders[0].totalAmount).toBe("37.50"); // 3 × 12.50
  });

  it("fails gracefully on a payload without an order id", async () => {
    seedTenant(T1);
    const result = await bridgeShopifyOrder(T1, { id: undefined } as any);
    expect(result.action).toBe("failed");
    expect(stores.orders).toHaveLength(0);
  });
});

// ─── Webhook express handler ─────────────────────────────────────────────────

describe("webhook express handler", () => {
  function makeReq(payload: object, opts: { sign?: boolean; topic?: string; tenant?: string } = {}) {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const headers: Record<string, string> = {};
    if (opts.sign !== false) headers["x-shopify-hmac-sha256"] = hmacHeader(rawBody);
    if (opts.topic) headers["x-shopify-topic"] = opts.topic;
    return {
      body: rawBody,
      query: opts.tenant ? { t: opts.tenant } : {},
      headers,
    } as any;
  }

  it("bridges orders/create with a valid HMAC (200)", async () => {
    seedTenant(T1);
    seedConnected(T1);
    const res = mockRes();
    await handleShopifyWebhookExpress(makeReq(shopifyOrder(), { topic: "orders/create", tenant: T1 }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe("created");
    expect(stores.orders).toHaveLength(1);
  });

  it("rejects an invalid HMAC with 401 BEFORE any processing", async () => {
    seedTenant(T1);
    seedConnected(T1);
    const res = mockRes();
    const req = makeReq(shopifyOrder(), { topic: "orders/create", tenant: T1 });
    req.headers["x-shopify-hmac-sha256"] = hmacHeader(Buffer.from("{}"), "attacker-secret");
    await handleShopifyWebhookExpress(req, res);
    expect(res.statusCode).toBe(401);
    expect(stores.orders).toHaveLength(0);
  });

  it("rejects when no tenant can be resolved", async () => {
    const res = mockRes();
    await handleShopifyWebhookExpress(makeReq(shopifyOrder(), { topic: "orders/create" }), res);
    expect(res.statusCode).toBe(400);
  });

  it("clears the connection on app/uninstalled", async () => {
    seedTenant(T1);
    seedConnected(T1);
    const res = mockRes();
    await handleShopifyWebhookExpress(makeReq({}, { topic: "app/uninstalled", tenant: T1 }), res);
    expect(res.statusCode).toBe(200);
    expect(tenantSettings(T1).shopifyIntegration.connection).toBeNull();
  });

  it("acknowledges unsupported topics without processing", async () => {
    seedTenant(T1);
    const res = mockRes();
    await handleShopifyWebhookExpress(makeReq({}, { topic: "products/update", tenant: T1 }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.handled).toBe(false);
  });

  it("OAuth callback express endpoint completes the install", async () => {
    seedTenant(T1);
    const url = await buildInstallUrl(T1);
    const state = new URL(url!).searchParams.get("state")!;
    const res = mockRes();
    await handleShopifyOAuthCallbackExpress(
      { query: { shop: SHOP, code: "c", state } } as any,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tenantId: T1, shop: SHOP });
  });
});

// ─── ConnectorDescriptor frozen seam ─────────────────────────────────────────

describe("ConnectorDescriptor seam", () => {
  it("exposes the frozen descriptor shape", () => {
    expect(shopifyConnector.key).toBe("shopify");
    expect(shopifyConnector.name).toBe("Shopify");
    expect(shopifyConnector.category).toBe("storefront");
    expect(shopifyConnector.logoKey).toBe("shopify");
    expect(shopifyConnector.capabilities).toEqual(["catalog_sync_out", "order_bridge_in", "oauth"]);
    expect(typeof shopifyConnector.isConfigured).toBe("function");
    expect(typeof shopifyConnector.healthCheck).toBe("function");
    expect(typeof shopifyConnector.installUrl).toBe("function");
  });

  it("healthCheck reports not-connected, then connected", async () => {
    seedTenant(T1);
    expect(await shopifyConnector.healthCheck(T1)).toEqual({ ok: false, detail: "not connected" });
    seedConnected(T1);
    const healthy = await shopifyConnector.healthCheck(T1);
    expect(healthy.ok).toBe(true);
  });
});

// ─── Router gating ───────────────────────────────────────────────────────────

describe("router gating", () => {
  it("rejects unauthenticated calls (UNAUTHORIZED)", async () => {
    const caller = shopifyIntegrationRouter.createCaller(makeCtx(null));
    await expect(caller.syncNow({ tenantId: T1, dryRun: true })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.status({ tenantId: T1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("analyst membership is FORBIDDEN from operator mutations", async () => {
    seedTenant(T1);
    const user = makeUser("user", null);
    seedMembership(user.id, T1, "analyst");
    const caller = shopifyIntegrationRouter.createCaller(makeCtx(user));
    await expect(caller.syncNow({ tenantId: T1, dryRun: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.connect({ tenantId: T1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.disconnect({ tenantId: T1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("cross-tenant reads are rejected (FORBIDDEN by assertTenantAccess)", async () => {
    seedTenant(T1);
    seedTenant(T2);
    const user = makeUser("user", T2);
    const caller = shopifyIntegrationRouter.createCaller(makeCtx(user));
    await expect(caller.status({ tenantId: T1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.health({ tenantId: T1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("status for an unknown tenant → NOT_FOUND", async () => {
    const admin = makeUser("admin", null);
    const caller = shopifyIntegrationRouter.createCaller(makeCtx(admin));
    await expect(caller.status({ tenantId: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("operator can connect (install URL) and read status", async () => {
    seedTenant(T1);
    const user = { ...makeUser("user", T1) };
    seedMembership(user.id, T1, "operator");
    const caller = shopifyIntegrationRouter.createCaller(makeCtx(user));
    const connect = await caller.connect({ tenantId: T1, shop: SHOP });
    expect(connect.installUrl).toContain(`https://${SHOP}/admin/oauth/authorize`);
    const status = await caller.status({ tenantId: T1 });
    expect(status.connected).toBe(false);
    expect(status.scopes).toContain("read_products");
  });

  it("operator syncNow dry-run works without a connection", async () => {
    seedTenant(T1);
    seedProduct(T1, "SKU-1");
    const user = makeUser("user", null);
    seedMembership(user.id, T1, "operator");
    const caller = shopifyIntegrationRouter.createCaller(makeCtx(user));
    const summary = await caller.syncNow({ tenantId: T1, dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.items).toHaveLength(1);
  });

  it("callback mutation rejects a state bound to another tenant", async () => {
    seedTenant(T1);
    seedTenant(T2);
    const url = await buildInstallUrl(T1);
    const state = new URL(url!).searchParams.get("state")!;
    const admin = makeUser("admin", null);
    const caller = shopifyIntegrationRouter.createCaller(makeCtx(admin));
    await expect(
      caller.callback({ tenantId: T2, shop: SHOP, code: "c", state }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("status payload", () => {
  it("reports connection + sync state without secrets", async () => {
    seedTenant(T1);
    seedConnected(T1);
    seedProduct(T1, "SKU-1");
    await syncCatalogToShopify(T1);
    await bridgeShopifyOrder(T1, shopifyOrder());
    const status = await getShopifyStatus(T1);
    expect(status.connected).toBe(true);
    expect(status.shop).toBe(SHOP);
    expect(status.catalog.mappedProducts).toBe(1);
    expect(status.orders.bridgedCount).toBe(1);
    expect(JSON.stringify(status)).not.toContain("shpat_test_token_123");
  });
});
