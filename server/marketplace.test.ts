/**
 * marketplace.test.ts — integrations marketplace lite (F7).
 *
 * Covers: catalog integrity (descriptor binding, valid categories,
 * capabilities), status enrichment per state, fail-closed install,
 * idempotent + audited uninstall, health aggregation with a throwing
 * connector, 60s cache behaviour (per-tenant, TTL), router gating,
 * cross-tenant isolation, and shopify absent-module tolerance.
 * DB is mocked in-memory (same style as erpProvision.test.ts); all external
 * HTTP is intercepted via a stubbed global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TrpcContext } from "./_core/context";
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// ─── In-memory DB mock ───────────────────────────────────────────────────────

const stores: Record<string, Record<string, unknown>[]> = {
  tenants: [],
  odoo_integrations: [],
  twenty_integrations: [],
  tenant_integrations: [],
  tenant_memberships: [],
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
    delete: (table: unknown) => ({
      where: (cond: unknown) => {
        const name = getTableName(table as never);
        const matched = filterRows(table, cond, stores[name] ?? []);
        stores[name] = (stores[name] ?? []).filter((r) => !matched.includes(r));
        return Promise.resolve(matched);
      },
    }),
  };
  return db;
}

vi.mock("./db", () => ({
  getDb: vi.fn().mockImplementation(() => Promise.resolve(makeMockDb())),
}));

// ─── External HTTP stub ──────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

const world = {
  down: new Set<string>(), // hosts returning 500
  throwHosts: new Set<string>(), // hosts whose fetch rejects (network error)
  requests: [] as string[],
};

async function fetchStub(url: string | URL, init?: RequestInit): Promise<Response> {
  const u = String(url);
  world.requests.push(`${init?.method ?? "GET"} ${u}`);
  const host = new URL(u).host;
  if (world.throwHosts.has(host)) throw new Error("network unreachable");
  if (world.down.has(host)) return jsonResponse({ error: "server down" }, 500);

  if (u.includes("odoo") && u.endsWith("/jsonrpc")) {
    return jsonResponse({ result: 7 }); // common.authenticate
  }
  if (u.includes("twenty")) {
    return jsonResponse({ data: { __schema: { queryType: { name: "Query" } } } });
  }
  if (u.includes("medusa")) {
    if (u.includes("/admin/products")) return jsonResponse({ products: [] });
    return jsonResponse({}, 404);
  }
  return jsonResponse({ error: `no stub for ${u}` }, 500);
}

const service = await import("./services/marketplace");
const { marketplaceRouter } = await import("./routers/marketplace");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const T1 = "tenant-1";
const T2 = "tenant-2";

function seedTenant(id: string, name = "Ada Stores", settings: Record<string, unknown> = {}) {
  stores.tenants.push({ id, name, slug: id, settings });
}

function seedOdoo(tenantId: string) {
  stores.odoo_integrations.push({
    id: `odoo-${tenantId}`,
    tenantId,
    baseUrl: "https://odoo.test.local",
    database: "shop",
    username: "bot",
    apiKey: "plain-key",
  });
}

function seedTwenty(tenantId: string) {
  stores.twenty_integrations.push({
    id: `twenty-${tenantId}`,
    tenantId,
    baseUrl: "https://twenty.test.local",
    apiKey: "plain-key",
    workspaceId: null,
  });
}

function seedMedusa(tenantId: string) {
  stores.tenant_integrations.push({
    id: `medusa-${tenantId}`,
    tenantId,
    integrationType: "medusa",
    status: "active",
    baseUrl: "https://medusa.test.local",
    apiKey: "admin-key",
    apiSecret: null,
  });
}

const tenantSettings = (id: string) =>
  (stores.tenants.find((t) => t.id === id)?.settings ?? {}) as Record<string, any>;

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

const auditRows = () => stores.audit_logs;
const odooRequests = () => world.requests.filter((r) => r.includes("odoo"));

beforeEach(() => {
  for (const key of Object.keys(stores)) stores[key] = [];
  world.down.clear();
  world.throwHosts.clear();
  world.requests = [];
  service.clearHealthCache();
  vi.stubGlobal("fetch", vi.fn(fetchStub));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── Catalog integrity ───────────────────────────────────────────────────────

describe("catalog integrity", () => {
  it("lists exactly the 4 built-in connectors with unique keys", () => {
    const keys = service.CONNECTOR_CATALOG.map((e) => e.key);
    expect(keys.sort()).toEqual(["medusa", "odoo", "shopify", "twenty"]);
    expect(new Set(keys).size).toBe(4);
  });

  it("every catalog entry has a descriptor bound (and vice versa)", () => {
    for (const entry of service.CONNECTOR_CATALOG) {
      const d = service.getConnectorDescriptor(entry.key);
      expect(d, `descriptor for ${entry.key}`).toBeTruthy();
      expect(d!.key).toBe(entry.key);
      expect(d!.name).toBe(entry.name);
      expect(d!.category).toBe(entry.category);
      expect(d!.logoKey).toBe(entry.logoKey);
    }
    for (const d of service.CONNECTOR_DESCRIPTORS) {
      expect(service.getCatalogEntry(d.key), `catalog entry for ${d.key}`).toBeTruthy();
    }
  });

  it("every entry has a valid category", () => {
    for (const entry of service.CONNECTOR_CATALOG) {
      expect(service.CONNECTOR_CATEGORIES).toContain(entry.category);
    }
    expect(service.getCatalogEntry("odoo")!.category).toBe("erp");
    expect(service.getCatalogEntry("twenty")!.category).toBe("crm");
    expect(service.getCatalogEntry("medusa")!.category).toBe("storefront");
    expect(service.getCatalogEntry("shopify")!.category).toBe("storefront");
  });

  it("every entry has non-empty capabilities, tagline, setupTime, requiredConfigFields", () => {
    for (const entry of service.CONNECTOR_CATALOG) {
      expect(entry.capabilities.length).toBeGreaterThan(0);
      expect(entry.tagline.length).toBeGreaterThan(0);
      expect(entry.setupTime.length).toBeGreaterThan(0);
      expect(entry.requiredConfigFields.length).toBeGreaterThan(0);
    }
  });

  it("descriptor capabilities match catalog capabilities", () => {
    for (const d of service.CONNECTOR_DESCRIPTORS) {
      expect(d.capabilities).toEqual(service.getCatalogEntry(d.key)!.capabilities);
    }
  });

  it("descriptors expose the frozen seam", () => {
    for (const d of service.CONNECTOR_DESCRIPTORS) {
      expect(typeof d.isConfigured).toBe("function");
      expect(typeof d.healthCheck).toBe("function");
      expect(Array.isArray(d.capabilities)).toBe(true);
    }
  });
});

// ─── listConnectors status enrichment ───────────────────────────────────────

describe("listConnectors", () => {
  it("all connectors are not_installed with null health when nothing is installed", async () => {
    seedTenant(T1);
    const list = await service.listConnectors({ tenantId: T1 });
    expect(list).toHaveLength(4);
    for (const item of list) {
      expect(item.status).toBe("not_installed");
      expect(item.health).toBeNull();
      expect(item.installedAt).toBeNull();
    }
  });

  it("active + healthy → status configured", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    await service.installConnector({ tenantId: T1, key: "odoo", actorId: "op-1" });
    const list = await service.listConnectors({ tenantId: T1 });
    const odoo = list.find((c) => c.key === "odoo")!;
    expect(odoo.status).toBe("configured");
    expect(odoo.health).toEqual({ ok: true });
    expect(odoo.installedAt).toBeTruthy();
  });

  it("active + failing health → status error", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    await service.installConnector({ tenantId: T1, key: "odoo", actorId: "op-1" });
    world.down.add("odoo.test.local");
    const list = await service.listConnectors({ tenantId: T1 });
    const odoo = list.find((c) => c.key === "odoo")!;
    expect(odoo.status).toBe("error");
    expect(odoo.health?.ok).toBe(false);
    expect(odoo.health?.detail).toMatch(/odoo/);
  });

  it("active but credentials removed after install → status error", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    await service.installConnector({ tenantId: T1, key: "odoo", actorId: "op-1" });
    stores.odoo_integrations = [];
    const list = await service.listConnectors({ tenantId: T1 });
    expect(list.find((c) => c.key === "odoo")!.status).toBe("error");
  });

  it("shopify configured without module → degraded after install", async () => {
    seedTenant(T1, "Shopify Store", {
      integrations: { shopify: { url: "https://shop.myshopify.com", apiKey: "shpat_x", enabled: true } },
    });
    const res = await service.installConnector({ tenantId: T1, key: "shopify", actorId: "op-1" });
    expect(res.status).toBe("active");
    const list = await service.listConnectors({ tenantId: T1 });
    const shopify = list.find((c) => c.key === "shopify")!;
    expect(shopify.status).toBe("degraded");
    expect(shopify.health?.ok).toBe(true);
    expect(shopify.health?.detail).toMatch(/pending shopify connector module/);
  });

  it("installUrl is null for connectors without one (odoo)", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    const list = await service.listConnectors({ tenantId: T1 });
    expect(list.find((c) => c.key === "odoo")!.installUrl).toBeNull();
  });
});

// ─── installConnector ────────────────────────────────────────────────────────

describe("installConnector", () => {
  it("rejects unknown connector keys", async () => {
    seedTenant(T1);
    await expect(service.installConnector({ tenantId: T1, key: "kommo" })).rejects.toThrow(
      /Unknown connector/,
    );
  });

  it("returns awaiting_config with required fields when not configured (nothing persisted)", async () => {
    seedTenant(T1);
    const res = await service.installConnector({ tenantId: T1, key: "odoo", actorId: "op-1" });
    expect(res.status).toBe("awaiting_config");
    if (res.status === "awaiting_config") {
      expect(res.requiredFields).toEqual(["baseUrl", "database", "username", "apiKey"]);
    }
    expect(tenantSettings(T1).marketplace).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
  });

  it("fails closed on a failed health check: no activation, audit row written", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    world.down.add("odoo.test.local");
    const res = await service.installConnector({ tenantId: T1, key: "odoo", actorId: "op-1" });
    expect(res.status).toBe("failed");
    if (res.status === "failed") expect(res.health.ok).toBe(false);
    expect(tenantSettings(T1).marketplace).toBeUndefined();
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "marketplace.connector.install_failed",
      entityType: "marketplace_connector",
      entityId: "odoo",
      tenantId: T1,
      actorId: "op-1",
    });
  });

  it("activates on a healthy probe, persists state and audits", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    const res = await service.installConnector({ tenantId: T1, key: "odoo", actorId: "op-1" });
    expect(res.status).toBe("active");
    const rec = tenantSettings(T1).marketplace.connectors.odoo;
    expect(rec.status).toBe("active");
    expect(rec.installedBy).toBe("op-1");
    expect(auditRows().map((r) => r.action)).toEqual(["marketplace.connector.install"]);
  });

  it("is idempotent: second install is a no-op with no duplicate audit", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    await service.installConnector({ tenantId: T1, key: "odoo", actorId: "op-1" });
    const res = await service.installConnector({ tenantId: T1, key: "odoo", actorId: "op-2" });
    expect(res).toMatchObject({ status: "active", alreadyInstalled: true });
    expect(auditRows()).toHaveLength(1);
    expect(tenantSettings(T1).marketplace.connectors.odoo.installedBy).toBe("op-1");
  });

  it("twenty install succeeds via its own seam", async () => {
    seedTenant(T1);
    seedTwenty(T1);
    const res = await service.installConnector({ tenantId: T1, key: "twenty", actorId: "op-1" });
    expect(res.status).toBe("active");
    expect(tenantSettings(T1).marketplace.connectors.twenty.status).toBe("active");
  });

  it("shopify install succeeds with settings-only config (absent module)", async () => {
    seedTenant(T1, "Shopify Store", {
      integrations: { shopify: { url: "https://shop.myshopify.com", apiKey: "shpat_x", enabled: true } },
    });
    const res = await service.installConnector({ tenantId: T1, key: "shopify", actorId: "op-1" });
    expect(res.status).toBe("active");
  });

  it("shopify install awaits config when disabled or incomplete", async () => {
    seedTenant(T1, "Shopify Store", {
      integrations: { shopify: { url: "https://shop.myshopify.com", apiKey: "", enabled: false } },
    });
    const res = await service.installConnector({ tenantId: T1, key: "shopify", actorId: "op-1" });
    expect(res.status).toBe("awaiting_config");
    if (res.status === "awaiting_config") {
      expect(res.requiredFields).toEqual(["shopDomain", "accessToken"]);
    }
  });
});

// ─── uninstallConnector ──────────────────────────────────────────────────────

describe("uninstallConnector", () => {
  it("deactivates, preserves the record, returns a data-retention note, audits", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    await service.installConnector({ tenantId: T1, key: "odoo", actorId: "op-1" });
    const res = await service.uninstallConnector({ tenantId: T1, key: "odoo", actorId: "op-2" });
    expect(res.status).toBe("uninstalled");
    expect(res.dataRetention).toMatch(/No synced data was deleted/);
    const rec = tenantSettings(T1).marketplace.connectors.odoo;
    expect(rec.status).toBe("uninstalled");
    expect(rec.installedBy).toBe("op-1"); // trail preserved
    expect(rec.uninstalledBy).toBe("op-2");
    const uninstall = auditRows().find((r) => r.action === "marketplace.connector.uninstall")!;
    expect(uninstall.before).toMatchObject({ status: "active" });
    expect(uninstall.after).toMatchObject({ status: "uninstalled" });
  });

  it("is idempotent when never installed", async () => {
    seedTenant(T1);
    const res = await service.uninstallConnector({ tenantId: T1, key: "odoo", actorId: "op-1" });
    expect(res).toMatchObject({ status: "not_installed", alreadyUninstalled: true });
    expect(auditRows()).toHaveLength(0);
  });

  it("is idempotent when already uninstalled", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    await service.installConnector({ tenantId: T1, key: "odoo" });
    await service.uninstallConnector({ tenantId: T1, key: "odoo" });
    const res = await service.uninstallConnector({ tenantId: T1, key: "odoo" });
    expect(res).toMatchObject({ status: "not_installed", alreadyUninstalled: true });
    expect(auditRows().filter((r) => r.action === "marketplace.connector.uninstall")).toHaveLength(1);
  });

  it("listing returns to not_installed after uninstall", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    await service.installConnector({ tenantId: T1, key: "odoo" });
    await service.uninstallConnector({ tenantId: T1, key: "odoo" });
    const list = await service.listConnectors({ tenantId: T1 });
    const odoo = list.find((c) => c.key === "odoo")!;
    expect(odoo.status).toBe("not_installed");
    expect(odoo.installedAt).toBeNull();
  });

  it("re-install after uninstall works", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    await service.installConnector({ tenantId: T1, key: "odoo" });
    await service.uninstallConnector({ tenantId: T1, key: "odoo" });
    const res = await service.installConnector({ tenantId: T1, key: "odoo" });
    expect(res.status).toBe("active");
    expect(tenantSettings(T1).marketplace.connectors.odoo.status).toBe("active");
  });

  it("rejects unknown connector keys", async () => {
    seedTenant(T1);
    await expect(service.uninstallConnector({ tenantId: T1, key: "kommo" })).rejects.toThrow(
      /Unknown connector/,
    );
  });
});

// ─── marketplaceHealth ───────────────────────────────────────────────────────

describe("marketplaceHealth", () => {
  it("returns one entry per connector and never throws for an unknown tenant", async () => {
    const res = await service.marketplaceHealth({ tenantId: "ghost" });
    expect(res.connectors).toHaveLength(4);
    for (const c of res.connectors) {
      expect(c.health.ok).toBe(false);
      expect(c.installed).toBe(false);
    }
  });

  it("one connector failing leaves the others unaffected", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    seedTwenty(T1);
    seedMedusa(T1);
    world.down.add("odoo.test.local");
    const res = await service.marketplaceHealth({ tenantId: T1 });
    const by = Object.fromEntries(res.connectors.map((c) => [c.key, c]));
    expect(by.odoo.health.ok).toBe(false);
    expect(by.twenty.health).toEqual({ ok: true });
    expect(by.medusa.health).toEqual({ ok: true });
  });

  it("a descriptor that throws degrades to { ok: false } instead of throwing", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    const odoo = service.getConnectorDescriptor("odoo")!;
    const spy = vi.spyOn(odoo, "healthCheck").mockRejectedValueOnce(new Error("boom"));
    const res = await service.marketplaceHealth({ tenantId: T1 });
    expect(res.connectors.find((c) => c.key === "odoo")!.health).toMatchObject({ ok: false });
    spy.mockRestore();
  });

  it("flags installed/configured per connector", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    await service.installConnector({ tenantId: T1, key: "odoo" });
    const res = await service.marketplaceHealth({ tenantId: T1 });
    const by = Object.fromEntries(res.connectors.map((c) => [c.key, c]));
    expect(by.odoo.installed).toBe(true);
    expect(by.odoo.configured).toBe(true);
    expect(by.twenty.installed).toBe(false);
    expect(by.twenty.configured).toBe(false);
  });

  it("caches per connector for 60s (second call does not re-probe)", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    const first = await service.marketplaceHealth({ tenantId: T1 });
    expect(first.connectors.find((c) => c.key === "odoo")!.cached).toBe(false);
    const n = odooRequests().length;
    expect(n).toBeGreaterThan(0);
    const second = await service.marketplaceHealth({ tenantId: T1 });
    const odoo = second.connectors.find((c) => c.key === "odoo")!;
    expect(odoo.cached).toBe(true);
    expect(odooRequests()).toHaveLength(n); // no new odoo HTTP
  });

  it("cache expires after the TTL", async () => {
    vi.useFakeTimers();
    seedTenant(T1);
    seedOdoo(T1);
    await service.marketplaceHealth({ tenantId: T1 });
    const n = odooRequests().length;
    vi.setSystemTime(Date.now() + 61_000);
    const res = await service.marketplaceHealth({ tenantId: T1 });
    expect(res.connectors.find((c) => c.key === "odoo")!.cached).toBe(false);
    expect(odooRequests().length).toBeGreaterThan(n);
  });

  it("cache is per-tenant (no cross-tenant leakage)", async () => {
    seedTenant(T1);
    seedTenant(T2);
    seedOdoo(T1);
    seedOdoo(T2);
    await service.marketplaceHealth({ tenantId: T1 });
    const n = odooRequests().length;
    const res2 = await service.marketplaceHealth({ tenantId: T2 });
    expect(res2.connectors.find((c) => c.key === "odoo")!.cached).toBe(false);
    expect(odooRequests().length).toBeGreaterThan(n);
  });

  it("install invalidates the cached health entry", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    world.down.add("odoo.test.local");
    await service.marketplaceHealth({ tenantId: T1 }); // caches { ok:false }
    world.down.clear();
    await service.installConnector({ tenantId: T1, key: "odoo" });
    const res = await service.marketplaceHealth({ tenantId: T1 });
    expect(res.connectors.find((c) => c.key === "odoo")!.health.ok).toBe(true);
  });
});

// ─── Cross-tenant isolation ──────────────────────────────────────────────────

describe("cross-tenant isolation", () => {
  it("install in one tenant does not leak into another", async () => {
    seedTenant(T1);
    seedTenant(T2);
    seedOdoo(T1);
    seedOdoo(T2);
    await service.installConnector({ tenantId: T1, key: "odoo", actorId: "op-1" });
    const list1 = await service.listConnectors({ tenantId: T1 });
    const list2 = await service.listConnectors({ tenantId: T2 });
    expect(list1.find((c) => c.key === "odoo")!.status).toBe("configured");
    expect(list2.find((c) => c.key === "odoo")!.status).toBe("not_installed");
    expect(tenantSettings(T2).marketplace).toBeUndefined();
  });

  it("audit rows are tenant-scoped", async () => {
    seedTenant(T1);
    seedTenant(T2);
    seedOdoo(T1);
    seedOdoo(T2);
    await service.installConnector({ tenantId: T1, key: "odoo" });
    await service.installConnector({ tenantId: T2, key: "odoo" });
    expect(auditRows().map((r) => r.tenantId).sort()).toEqual([T1, T2]);
  });
});

// ─── Shopify absent-module tolerance ─────────────────────────────────────────

describe("shopify descriptor (absent module)", () => {
  it("isConfigured is false without settings", async () => {
    seedTenant(T1);
    const d = service.getConnectorDescriptor("shopify")!;
    await expect(d.isConfigured(T1)).resolves.toBe(false);
  });

  it("healthCheck fails closed when not configured", async () => {
    seedTenant(T1);
    const d = service.getConnectorDescriptor("shopify")!;
    await expect(d.healthCheck(T1)).resolves.toMatchObject({ ok: false });
  });

  it("installUrl resolves to null without the module", async () => {
    seedTenant(T1);
    const d = service.getConnectorDescriptor("shopify")!;
    await expect(d.installUrl!(T1)).resolves.toBeNull();
  });
});

// ─── Router gating ───────────────────────────────────────────────────────────

describe("marketplaceRouter (connectors)", () => {
  it("reads require authentication", async () => {
    const caller = marketplaceRouter.createCaller(makeCtx(null));
    await expect(caller.listConnectors({ tenantId: T1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.connectorHealth({ tenantId: T1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("mutations require authentication", async () => {
    const caller = marketplaceRouter.createCaller(makeCtx(null));
    await expect(caller.installConnector({ tenantId: T1, key: "odoo" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.uninstallConnector({ tenantId: T1, key: "odoo" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("listConnectors is forbidden across tenants", async () => {
    seedTenant(T1);
    const outsider = marketplaceRouter.createCaller(makeCtx(makeUser("user", T2)));
    await expect(outsider.listConnectors({ tenantId: T1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("install requires owner/operator membership (analyst forbidden)", async () => {
    seedTenant(T1);
    seedMembership(2, T1, "analyst");
    const caller = marketplaceRouter.createCaller(makeCtx(makeUser("user", null)));
    await expect(caller.installConnector({ tenantId: T1, key: "odoo" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("install requires membership (non-member forbidden)", async () => {
    seedTenant(T1);
    const caller = marketplaceRouter.createCaller(makeCtx(makeUser("user", T1)));
    await expect(caller.installConnector({ tenantId: T1, key: "odoo" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("operator membership can install and uninstall", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    seedMembership(2, T1, "operator");
    const caller = marketplaceRouter.createCaller(makeCtx(makeUser("user", null)));
    const res = await caller.installConnector({ tenantId: T1, key: "odoo" });
    expect(res.status).toBe("active");
    const un = await caller.uninstallConnector({ tenantId: T1, key: "odoo" });
    expect(un.status).toBe("uninstalled");
  });

  it("platform admin bypasses membership on mutations", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    const admin = marketplaceRouter.createCaller(makeCtx(makeUser("admin", null)));
    const res = await admin.installConnector({ tenantId: T1, key: "odoo" });
    expect(res.status).toBe("active");
  });

  it("unknown connector surfaces as BAD_REQUEST", async () => {
    seedTenant(T1);
    seedMembership(2, T1, "owner");
    const caller = marketplaceRouter.createCaller(makeCtx(makeUser("user", null)));
    await expect(caller.installConnector({ tenantId: T1, key: "kommo" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("tenant member can read their own connector health", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    const caller = marketplaceRouter.createCaller(makeCtx(makeUser("user", T1)));
    const res = await caller.connectorHealth({ tenantId: T1 });
    expect(res.connectors).toHaveLength(4);
  });

  it("pre-existing seller marketplace procedures still work", async () => {
    seedTenant(T1);
    const caller = marketplaceRouter.createCaller(makeCtx(makeUser("user", T1)));
    const stats = await caller.marketplaceStats({ tenantId: T1 });
    expect(stats).toMatchObject({ totalSellers: 0 });
  });
});
