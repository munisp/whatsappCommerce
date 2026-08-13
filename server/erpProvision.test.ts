/**
 * erpProvision.test.ts — ERP-aware agentic configuration (F5).
 *
 * Covers: per-connector provisioning (odoo/twenty/medusa), idempotency,
 * partial-failure isolation, dry-run safety, connection gating, state
 * persistence + audit, every copilot config intent (happy path, validation
 * failures, idempotency, no-confirm dry-run), and router tenant/role gating.
 * DB is mocked in-memory (same style as onboardingCopilot.test.ts); all
 * external ERP HTTP is intercepted via a stubbed global fetch.
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

// ─── External ERP HTTP stub ──────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

interface ErpWorld {
  odooSearchResults: Record<string, number[]>;
  odooCreateCalls: string[];
  odooNextId: number;
  twentyCompanies: Array<{ id: string; name: string }>;
  twentyCreateCompanyCalls: number;
  medusaSalesChannels: Array<{ id: string; name: string }>;
  medusaRegions: Array<{ id: string; currency_code: string }>;
  down: Set<string>; // hosts that fail with 500
  requests: string[];
}

let world: ErpWorld;

function resetWorld() {
  world = {
    odooSearchResults: {},
    odooCreateCalls: [],
    odooNextId: 100,
    twentyCompanies: [],
    twentyCreateCompanyCalls: 0,
    medusaSalesChannels: [],
    medusaRegions: [{ id: "reg_ngn", currency_code: "ngn" }],
    down: new Set(),
    requests: [],
  };
}

async function fetchStub(url: string | URL, init?: RequestInit): Promise<Response> {
  const u = String(url);
  world.requests.push(`${init?.method ?? "GET"} ${u}`);
  const host = new URL(u).host;
  if (world.down.has(host)) return jsonResponse({ error: "server down" }, 500);

  // ── Odoo JSON-RPC ──
  if (u.includes("odoo") && u.endsWith("/jsonrpc")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const p = body.params ?? {};
    if (p.service === "common") return jsonResponse({ result: 7 });
    if (p.service === "object") {
      const [, , , model, method] = p.args as unknown[];
      if (method === "search" || method === "search_read") {
        return jsonResponse({ result: world.odooSearchResults[String(model)] ?? [] });
      }
      if (method === "create") {
        world.odooCreateCalls.push(String(model));
        return jsonResponse({ result: world.odooNextId++ });
      }
    }
    return jsonResponse({ result: null });
  }

  // ── Twenty GraphQL ──
  if (u.includes("twenty")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const q: string = body.query ?? "";
    if (q.includes("__schema")) return jsonResponse({ data: { __schema: { queryType: { name: "Query" } } } });
    if (q.includes("companies(")) {
      const name = (body.variables?.name as string) ?? "";
      const found = world.twentyCompanies.filter((c) => c.name === name);
      return jsonResponse({ data: { companies: { edges: found.map((c) => ({ node: { id: c.id } })) } } });
    }
    if (q.includes("createCompany")) {
      world.twentyCreateCompanyCalls++;
      const company = { id: `co_${world.twentyCreateCompanyCalls}`, name: body.variables?.name ?? "" };
      world.twentyCompanies.push(company);
      return jsonResponse({ data: { createCompany: { id: company.id } } });
    }
    return jsonResponse({ data: {} });
  }

  // ── Medusa Admin API ──
  if (u.includes("medusa")) {
    if (u.includes("/admin/products")) return jsonResponse({ products: [] });
    if (u.includes("/admin/sales_channels") && (init?.method ?? "GET") === "GET") {
      const name = new URL(u).searchParams.get("name");
      const found = name ? world.medusaSalesChannels.filter((c) => c.name === name) : world.medusaSalesChannels;
      return jsonResponse({ sales_channels: found });
    }
    if (u.includes("/admin/sales_channels") && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      const ch = { id: `sc_${world.medusaSalesChannels.length + 1}`, name: body.name };
      world.medusaSalesChannels.push(ch);
      return jsonResponse({ sales_channel: ch });
    }
    if (u.includes("/admin/regions")) return jsonResponse({ regions: world.medusaRegions });
    return jsonResponse({}, 404);
  }

  return jsonResponse({ error: `no stub for ${u}` }, 500);
}

const service = await import("./services/erpProvision");
const { erpProvisionRouter } = await import("./routers/erpProvision");

// ─── Test helpers ────────────────────────────────────────────────────────────

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
    apiKey: "plain-key", // legacy plaintext passes decryptSecret through
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

function seedMedusa(tenantId: string, opts: { withAdminKey?: boolean } = {}) {
  stores.tenant_integrations.push({
    id: `medusa-${tenantId}`,
    tenantId,
    integrationType: "medusa",
    status: "active",
    baseUrl: "https://medusa.test.local",
    apiKey: opts.withAdminKey === false ? null : "admin-key",
    apiSecret: null,
  });
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

const tenantSettings = (id: string) =>
  (stores.tenants.find((t) => t.id === id)?.settings ?? {}) as Record<string, any>;

beforeEach(() => {
  for (const key of Object.keys(stores)) stores[key] = [];
  resetWorld();
  vi.stubGlobal("fetch", vi.fn(fetchStub));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Provisioning: service level ─────────────────────────────────────────────

describe("provisionErpTenantObjects", () => {
  it("skips every ERP when nothing is configured and persists the run", async () => {
    seedTenant(T1);
    const report = await service.provisionErpTenantObjects({ tenantId: T1 });
    expect(report.ok).toBe(true);
    expect(report.results).toHaveLength(7);
    expect(report.results.every((r) => r.status === "skipped")).toBe(true);
    const state = tenantSettings(T1).erpProvision;
    expect(state.lastResults).toHaveLength(7);
    expect(stores.audit_logs.some((a) => a.action === "erp_provision.run" && a.tenantId === T1)).toBe(true);
  });

  it("throws for an unknown tenant", async () => {
    await expect(service.provisionErpTenantObjects({ tenantId: "nope" })).rejects.toThrow(/not found/i);
  });

  it("odoo: creates partner-category, partner and price-list", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    const report = await service.provisionErpTenantObjects({ tenantId: T1 });
    const odoo = report.results.filter((r) => r.erp === "odoo");
    expect(odoo.map((r) => r.status)).toEqual(["created", "created", "created"]);
    expect(odoo.every((r) => r.externalId)).toBe(true);
    expect(world.odooCreateCalls).toEqual(["res.partner.category", "res.partner", "product.pricelist"]);
    expect(report.ok).toBe(true);
  });

  it("odoo: second run is idempotent (exists, no duplicate creates)", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    await service.provisionErpTenantObjects({ tenantId: T1 });
    const creates = world.odooCreateCalls.length;
    const second = await service.provisionErpTenantObjects({ tenantId: T1 });
    expect(second.results.filter((r) => r.erp === "odoo").map((r) => r.status)).toEqual([
      "exists",
      "exists",
      "exists",
    ]);
    expect(world.odooCreateCalls.length).toBe(creates);
  });

  it("odoo: adopts pre-existing remote objects instead of duplicating", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    world.odooSearchResults["res.partner.category"] = [55];
    world.odooSearchResults["res.partner"] = [56];
    world.odooSearchResults["product.pricelist"] = [57];
    const report = await service.provisionErpTenantObjects({ tenantId: T1 });
    const odoo = report.results.filter((r) => r.erp === "odoo");
    expect(odoo.map((r) => r.status)).toEqual(["exists", "exists", "exists"]);
    expect(odoo.map((r) => r.externalId)).toEqual(["55", "56", "57"]);
    expect(world.odooCreateCalls).toHaveLength(0);
  });

  it("odoo: isolates a single object failure (pricelist fails, others created)", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    const origCreate = world.odooNextId;
    void origCreate;
    // Make pricelist create fail by returning an Odoo error envelope.
    const base = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    base.mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes("odoo") && String(init?.body ?? "").includes('"product.pricelist"') && String(init?.body ?? "").includes('"create"')) {
        return jsonResponse({ error: { message: "pricelist create denied" } });
      }
      return fetchStub(url, init);
    });
    const report = await service.provisionErpTenantObjects({ tenantId: T1 });
    const odoo = report.results.filter((r) => r.erp === "odoo");
    expect(odoo.find((r) => r.object === "partner-category")?.status).toBe("created");
    expect(odoo.find((r) => r.object === "partner")?.status).toBe("created");
    expect(odoo.find((r) => r.object === "price-list")?.status).toBe("failed");
    expect(report.ok).toBe(false);
  });

  it("twenty: creates the company and records the pipeline mapping", async () => {
    seedTenant(T1);
    seedTwenty(T1);
    const report = await service.provisionErpTenantObjects({ tenantId: T1 });
    const twenty = report.results.filter((r) => r.erp === "twenty");
    expect(twenty.find((r) => r.object === "company")?.status).toBe("created");
    expect(twenty.find((r) => r.object === "company")?.externalId).toBe("co_1");
    expect(twenty.find((r) => r.object === "pipeline")?.status).toBe("created");
    expect(world.twentyCompanies).toHaveLength(1);
    expect(world.twentyCompanies[0].name).toBe("Ada Stores");
  });

  it("twenty: second run is idempotent", async () => {
    seedTenant(T1);
    seedTwenty(T1);
    await service.provisionErpTenantObjects({ tenantId: T1 });
    const second = await service.provisionErpTenantObjects({ tenantId: T1 });
    const twenty = second.results.filter((r) => r.erp === "twenty");
    expect(twenty.map((r) => r.status)).toEqual(["exists", "exists"]);
    expect(world.twentyCompanies).toHaveLength(1);
  });

  it("medusa: creates the sales channel and adopts a matching region", async () => {
    seedTenant(T1);
    seedMedusa(T1);
    const report = await service.provisionErpTenantObjects({ tenantId: T1 });
    const medusa = report.results.filter((r) => r.erp === "medusa");
    expect(medusa.find((r) => r.object === "sales-channel")?.status).toBe("created");
    expect(medusa.find((r) => r.object === "region")).toMatchObject({ status: "exists", externalId: "reg_ngn" });
  });

  it("medusa: skips region mapping when no region exists", async () => {
    seedTenant(T1);
    seedMedusa(T1);
    world.medusaRegions = [];
    const report = await service.provisionErpTenantObjects({ tenantId: T1 });
    const region = report.results.find((r) => r.erp === "medusa" && r.object === "region");
    expect(region?.status).toBe("skipped");
  });

  it("medusa: not configured when admin api key missing", async () => {
    seedTenant(T1);
    seedMedusa(T1, { withAdminKey: false });
    delete process.env.MEDUSA_API_URL;
    const report = await service.provisionErpTenantObjects({ tenantId: T1 });
    const medusa = report.results.filter((r) => r.erp === "medusa");
    expect(medusa.every((r) => r.status === "skipped")).toBe(true);
  });

  it("partial failure isolation: odoo down does not block twenty/medusa", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    seedTwenty(T1);
    seedMedusa(T1);
    world.down.add("odoo.test.local");
    const report = await service.provisionErpTenantObjects({ tenantId: T1 });
    expect(report.ok).toBe(false);
    expect(report.results.filter((r) => r.erp === "odoo").every((r) => r.status === "failed")).toBe(true);
    expect(report.results.find((r) => r.erp === "twenty" && r.object === "company")?.status).toBe("created");
    expect(report.results.find((r) => r.erp === "medusa" && r.object === "sales-channel")?.status).toBe("created");
  });

  it("dry-run: no writes, no state persisted, no audit, previews what would be created", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    const report = await service.provisionErpTenantObjects({ tenantId: T1 }, { dryRun: true });
    expect(report.dryRun).toBe(true);
    const odoo = report.results.filter((r) => r.erp === "odoo");
    expect(odoo.every((r) => r.status === "skipped" && /dry-run/.test(r.error ?? ""))).toBe(true);
    expect(world.odooCreateCalls).toHaveLength(0);
    expect(tenantSettings(T1).erpProvision).toBeUndefined();
    expect(stores.audit_logs).toHaveLength(0);
  });

  it("dry-run after a real run reports exists", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    await service.provisionErpTenantObjects({ tenantId: T1 });
    const dry = await service.provisionErpTenantObjects({ tenantId: T1 }, { dryRun: true });
    expect(dry.results.filter((r) => r.erp === "odoo").every((r) => r.status === "exists")).toBe(true);
  });

  it("all three ERPs provisioned in one run and recorded in state objects", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    seedTwenty(T1);
    seedMedusa(T1);
    const report = await service.provisionErpTenantObjects({ tenantId: T1 });
    expect(report.ok).toBe(true);
    const objects = tenantSettings(T1).erpProvision.objects;
    expect(Object.keys(objects).sort()).toEqual([
      "medusa:region",
      "medusa:sales-channel",
      "odoo:partner",
      "odoo:partner-category",
      "odoo:price-list",
      "twenty:company",
      "twenty:pipeline",
    ]);
  });
});

// ─── Config intents ──────────────────────────────────────────────────────────

describe("applyCopilotConfig", () => {
  it("set_delivery_zones: dry-run previews without persisting", async () => {
    seedTenant(T1);
    const res = await service.applyCopilotConfig({
      tenantId: T1,
      intent: "set_delivery_zones",
      params: { zones: [{ name: "Lagos Island", fee: 1500 }] },
    });
    expect(res.dryRun).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.after).toEqual([{ name: "Lagos Island", fee: 1500 }]);
    expect(tenantSettings(T1).commerce).toBeUndefined();
    expect(stores.audit_logs).toHaveLength(0);
  });

  it("set_delivery_zones: confirm persists and upserts by zone name", async () => {
    seedTenant(T1, "Ada Stores", {
      commerce: { currency: "NGN", pickupEnabled: true, deliveryZones: [{ name: "Lekki", fee: 1000 }] },
    });
    const res = await service.applyCopilotConfig({
      tenantId: T1,
      intent: "set_delivery_zones",
      confirm: true,
      params: { zones: [{ name: "Lekki", fee: 1200 }, { name: "Ikoyi", fee: 2000 }] },
    });
    expect(res.dryRun).toBe(false);
    expect(res.changed).toBe(true);
    const zones = tenantSettings(T1).commerce.deliveryZones;
    expect(zones).toEqual([
      { name: "Lekki", fee: 1200 },
      { name: "Ikoyi", fee: 2000 },
    ]);
  });

  it("set_delivery_zones: replace mode drops unlisted zones", async () => {
    seedTenant(T1, "Ada Stores", {
      commerce: { currency: "NGN", pickupEnabled: true, deliveryZones: [{ name: "Lekki", fee: 1000 }] },
    });
    await service.applyCopilotConfig({
      tenantId: T1,
      intent: "set_delivery_zones",
      confirm: true,
      params: { mode: "replace", zones: [{ name: "Yaba", fee: 800 }] },
    });
    expect(tenantSettings(T1).commerce.deliveryZones).toEqual([{ name: "Yaba", fee: 800 }]);
  });

  it("set_delivery_zones: rejects invalid params (empty zone list / bad zone)", async () => {
    seedTenant(T1);
    await expect(
      service.applyCopilotConfig({ tenantId: T1, intent: "set_delivery_zones", confirm: true, params: { zones: [] } }),
    ).rejects.toThrow();
    await expect(
      service.applyCopilotConfig({
        tenantId: T1,
        intent: "set_delivery_zones",
        confirm: true,
        params: { zones: [{ name: "", fee: -5 }] },
      }),
    ).rejects.toThrow();
    expect(stores.audit_logs).toHaveLength(0);
  });

  it("set_pickup_enabled: applies and is idempotent (no-op second apply)", async () => {
    seedTenant(T1);
    const first = await service.applyCopilotConfig({
      tenantId: T1,
      intent: "set_pickup_enabled",
      confirm: true,
      params: { enabled: false },
    });
    expect(first.changed).toBe(true);
    expect(tenantSettings(T1).commerce.pickupEnabled).toBe(false);
    const second = await service.applyCopilotConfig({
      tenantId: T1,
      intent: "set_pickup_enabled",
      confirm: true,
      params: { enabled: false },
    });
    expect(second.changed).toBe(false);
  });

  it("set_pipeline_stages: replaces stages; duplicates rejected", async () => {
    seedTenant(T1);
    const res = await service.applyCopilotConfig({
      tenantId: T1,
      intent: "set_pipeline_stages",
      confirm: true,
      params: { stages: ["new", "contacted", "won", "lost"] },
    });
    expect(res.changed).toBe(true);
    expect(tenantSettings(T1).crm.pipelineStages).toEqual(["new", "contacted", "won", "lost"]);
    await expect(
      service.applyCopilotConfig({
        tenantId: T1,
        intent: "set_pipeline_stages",
        confirm: true,
        params: { stages: ["new", "new", "won"] },
      }),
    ).rejects.toThrow();
  });

  it("set_low_stock_threshold: applies and validates range", async () => {
    seedTenant(T1);
    await service.applyCopilotConfig({
      tenantId: T1,
      intent: "set_low_stock_threshold",
      confirm: true,
      params: { threshold: 12 },
    });
    expect(tenantSettings(T1).inventory.lowStockThreshold).toBe(12);
    await expect(
      service.applyCopilotConfig({
        tenantId: T1,
        intent: "set_low_stock_threshold",
        confirm: true,
        params: { threshold: -1 },
      }),
    ).rejects.toThrow();
  });

  it("toggle_catalog_sync: flips settings.integrations.<provider>.enabled", async () => {
    seedTenant(T1, "Ada Stores", {
      integrations: { odoo: { url: "https://odoo.test.local", apiKey: "k", enabled: false } },
    });
    const res = await service.applyCopilotConfig({
      tenantId: T1,
      intent: "toggle_catalog_sync",
      confirm: true,
      params: { provider: "odoo", enabled: true },
    });
    expect(res.changed).toBe(true);
    expect(tenantSettings(T1).integrations.odoo.enabled).toBe(true);
    const again = await service.applyCopilotConfig({
      tenantId: T1,
      intent: "toggle_catalog_sync",
      confirm: true,
      params: { provider: "odoo", enabled: true },
    });
    expect(again.changed).toBe(false);
  });

  it("toggle_catalog_sync: refuses unconfigured provider", async () => {
    seedTenant(T1);
    await expect(
      service.applyCopilotConfig({
        tenantId: T1,
        intent: "toggle_catalog_sync",
        confirm: true,
        params: { provider: "twenty", enabled: true },
      }),
    ).rejects.toThrow(/not configured/);
  });

  it("update_branding: applies partial fields; empty update rejected", async () => {
    seedTenant(T1);
    await service.applyCopilotConfig({
      tenantId: T1,
      intent: "update_branding",
      confirm: true,
      params: { tagline: "Fresh groceries fast", waProfileAbout: "Order on WhatsApp" },
    });
    expect(tenantSettings(T1).branding.tagline).toBe("Fresh groceries fast");
    expect(tenantSettings(T1).branding.waProfileAbout).toBe("Order on WhatsApp");
    await expect(
      service.applyCopilotConfig({ tenantId: T1, intent: "update_branding", confirm: true, params: {} }),
    ).rejects.toThrow();
  });

  it("writes an audit entry per applied intent", async () => {
    seedTenant(T1);
    await service.applyCopilotConfig({
      tenantId: T1,
      intent: "set_pickup_enabled",
      confirm: true,
      params: { enabled: false },
      actorId: "42",
    });
    const audit = stores.audit_logs.find((a) => a.action === "erp_provision.config.set_pickup_enabled");
    expect(audit).toBeTruthy();
    expect(audit?.tenantId).toBe(T1);
    expect(audit?.actorId).toBe("user:42");
  });

  it("tenant isolation: intents only ever touch the given tenant", async () => {
    seedTenant(T1);
    seedTenant(T2, "Bola Foods");
    await service.applyCopilotConfig({
      tenantId: T1,
      intent: "set_low_stock_threshold",
      confirm: true,
      params: { threshold: 99 },
    });
    expect(tenantSettings(T1).inventory.lowStockThreshold).toBe(99);
    expect(tenantSettings(T2).inventory).toBeUndefined();
  });

  it("unknown intent is rejected", async () => {
    seedTenant(T1);
    await expect(
      service.applyCopilotConfig({
        tenantId: T1,
        intent: "drop_database" as never,
        confirm: true,
        params: {},
      }),
    ).rejects.toThrow(/Unknown config intent/);
  });
});

// ─── Router gating ───────────────────────────────────────────────────────────

describe("erpProvisionRouter", () => {
  it("requires authentication", async () => {
    const caller = erpProvisionRouter.createCaller(makeCtx(null));
    await expect(caller.provision({ tenantId: T1, dryRun: true })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.getState({ tenantId: T1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("provision: owner membership passes (dry-run)", async () => {
    seedTenant(T1);
    seedOdoo(T1);
    seedMembership(2, T1, "owner");
    const caller = erpProvisionRouter.createCaller(makeCtx(makeUser("user", null)));
    const res = await caller.provision({ tenantId: T1, dryRun: true });
    expect(res.dryRun).toBe(true);
  });

  it("provision: non-member is forbidden", async () => {
    seedTenant(T1);
    const caller = erpProvisionRouter.createCaller(makeCtx(makeUser("user", T2)));
    await expect(caller.provision({ tenantId: T1, dryRun: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("applyConfig: analyst role is forbidden (owner/operator only)", async () => {
    seedTenant(T1);
    seedMembership(2, T1, "analyst");
    const caller = erpProvisionRouter.createCaller(makeCtx(makeUser("user", null)));
    await expect(
      caller.applyConfig({ tenantId: T1, intent: "set_pickup_enabled", params: { enabled: false }, confirm: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("applyConfig: without confirm returns a dry-run preview and persists nothing", async () => {
    seedTenant(T1);
    seedMembership(2, T1, "operator");
    const caller = erpProvisionRouter.createCaller(makeCtx(makeUser("user", null)));
    const res = await caller.applyConfig({
      tenantId: T1,
      intent: "set_pickup_enabled",
      params: { enabled: false },
      confirm: false,
    });
    expect(res.dryRun).toBe(true);
    expect(tenantSettings(T1).commerce).toBeUndefined();
  });

  it("applyConfig: validation failure surfaces as BAD_REQUEST", async () => {
    seedTenant(T1);
    seedMembership(2, T1, "owner");
    const caller = erpProvisionRouter.createCaller(makeCtx(makeUser("user", null)));
    await expect(
      caller.applyConfig({ tenantId: T1, intent: "set_low_stock_threshold", params: { threshold: -3 }, confirm: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("getState: forbidden for another tenant, allowed for platform admin", async () => {
    seedTenant(T1, "Ada Stores", { erpProvision: { objects: {}, lastRunAt: null, lastResults: [], runs: [] } });
    const outsider = erpProvisionRouter.createCaller(makeCtx(makeUser("user", T2)));
    await expect(outsider.getState({ tenantId: T1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const admin = erpProvisionRouter.createCaller(makeCtx(makeUser("admin", null)));
    const state = await admin.getState({ tenantId: T1 });
    expect(state).toMatchObject({ objects: {} });
  });

  it("listIntents exposes the intent catalog", async () => {
    const caller = erpProvisionRouter.createCaller(makeCtx(makeUser("user", T1)));
    const intents = await caller.listIntents();
    expect(intents.map((i) => i.intent).sort()).toEqual([...service.CONFIG_INTENTS].sort());
  });
});
