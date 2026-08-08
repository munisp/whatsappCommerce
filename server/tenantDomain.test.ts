/**
 * Multi-domain tenant resolution — host → tenant mapping, caching,
 * default fallback, and the public tenantTheme procedure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "./db";
import {
  clearTenantDomainCache,
  normalizeHost,
  resolveTenantForHost,
  tenantDomains,
  DEFAULT_TENANT_ID,
} from "./_core/tenantDomain";
import { tenantRouter } from "./routers/tenant";

const TENANTS = [
  { id: "t-acme", slug: "acme", settings: { domains: ["shop.acme.com", "www.acme.ng"] } },
  { id: "t-beta", slug: "beta", settings: {} },
];

function mockDbTenants(rows: any[]) {
  // The query CHAIN is thenable (so awaiting a query without .limit works),
  // but the root db object must NOT be thenable or `await getDb()` would
  // assimilate it.
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  chain.then = (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject);
  return {
    select: chain.select,
    from: chain.from,
    where: chain.where,
    limit: chain.limit,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTenantDomainCache();
});

describe("normalizeHost / tenantDomains", () => {
  it("strips port, lowercases, strips trailing dot", () => {
    expect(normalizeHost("Shop.Acme.COM:443")).toBe("shop.acme.com");
    expect(normalizeHost("example.com.")).toBe("example.com");
    expect(normalizeHost(undefined)).toBe("");
  });

  it("reads settings.domains defensively", () => {
    expect(tenantDomains({ domains: ["A.com:8080", 42, "b.com"] })).toEqual(["a.com", "b.com"]);
    expect(tenantDomains(null)).toEqual([]);
    expect(tenantDomains({})).toEqual([]);
  });
});

describe("resolveTenantForHost", () => {
  it("resolves a known custom domain to its tenant", async () => {
    vi.mocked(getDb).mockResolvedValue(mockDbTenants(TENANTS));
    await expect(resolveTenantForHost("shop.acme.com")).resolves.toBe("t-acme");
    await expect(resolveTenantForHost("www.acme.ng:8443")).resolves.toBe("t-acme");
  });

  it("resolves {slug}.{APP_URL base} subdomains to the tenant by slug", async () => {
    vi.mocked(getDb).mockResolvedValue(mockDbTenants(TENANTS));
    // Default APP_URL is http://localhost:3000 → base host "localhost".
    await expect(resolveTenantForHost("beta.localhost")).resolves.toBe("t-beta");
  });

  it("falls back to the default tenant for unknown hosts", async () => {
    vi.mocked(getDb).mockResolvedValue(mockDbTenants(TENANTS));
    await expect(resolveTenantForHost("unknown.example.com")).resolves.toBe(DEFAULT_TENANT_ID);
    await expect(resolveTenantForHost("nobody.localhost")).resolves.toBe(DEFAULT_TENANT_ID);
  });

  it("serves the platform's own domain as the default tenant without a DB hit", async () => {
    await expect(resolveTenantForHost("localhost:3000")).resolves.toBe(DEFAULT_TENANT_ID);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("caches resolution for 60s (second lookup does not hit the DB)", async () => {
    const db = mockDbTenants(TENANTS);
    vi.mocked(getDb).mockResolvedValue(db);
    await resolveTenantForHost("shop.acme.com");
    await resolveTenantForHost("shop.acme.com");
    expect(getDb).toHaveBeenCalledTimes(1);
  });

  it("falls back to default (uncached) when the DB is unavailable", async () => {
    vi.mocked(getDb).mockResolvedValue(null as never);
    await expect(resolveTenantForHost("shop.acme.com")).resolves.toBe(DEFAULT_TENANT_ID);
    // not cached → retries DB next time
    vi.mocked(getDb).mockResolvedValue(mockDbTenants(TENANTS));
    await expect(resolveTenantForHost("shop.acme.com")).resolves.toBe("t-acme");
  });
});

describe("tenant.tenantTheme (public)", () => {
  it("returns branding for the resolved tenant", async () => {
    const db = mockDbTenants([
      {
        id: "t-acme",
        name: "Acme Stores",
        defaultCurrency: "NGN",
        settings: { branding: { logoUrl: "https://cdn.acme.com/logo.png", primaryColor: "#FF0000" } },
      },
    ]);
    vi.mocked(getDb).mockResolvedValue(db);

    const caller = tenantRouter.createCaller({ resolvedTenantId: "t-acme", user: null } as any);
    const theme = await caller.tenantTheme();
    expect(theme).toEqual({
      tenantId: "t-acme",
      name: "Acme Stores",
      logoUrl: "https://cdn.acme.com/logo.png",
      primaryColor: "#FF0000",
      currency: "NGN",
    });
  });

  it("returns safe defaults when the tenant has no branding row", async () => {
    const db = mockDbTenants([]); // no tenant row
    vi.mocked(getDb).mockResolvedValue(db);

    const caller = tenantRouter.createCaller({ resolvedTenantId: DEFAULT_TENANT_ID, user: null } as any);
    const theme = await caller.tenantTheme();
    expect(theme).toEqual({
      tenantId: DEFAULT_TENANT_ID,
      name: "WhatsApp Commerce",
      logoUrl: null,
      primaryColor: "#25D366",
      currency: "USD",
    });
  });
});
