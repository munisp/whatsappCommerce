/**
 * tenantConfig.test.ts — per-tenant customization APIs.
 *
 * Covers: CRM customFields CRUD + pipelineStages, inventory/commerce/branding
 * get/set, waMenu full replace + item-level ops with contract validation
 * (unknown use-case ids, empty labels, order collisions, non-hex color),
 * previewWaMenu rendering with mocked products/orders, and cross-tenant
 * rejection. DB is mocked in-memory.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrpcContext } from "./_core/context";
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildDefaultTenantSettings } from "../shared/tenantConfig";
import { DEFAULT_WA_MENU } from "../shared/waMenu";

// ─── In-memory DB mock (same style as onboarding.test.ts) ────────────────────

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

const stores: Record<string, Record<string, unknown>[]> = {
  tenants: [],
  products: [],
  orders: [],
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
      continue;
    }
    const mIn = part.match(/"[\w]+"\."([\w]+)" in \(([^)]*)\)/i);
    if (mIn) {
      const prop = colMap[mIn[1]];
      const vals = mIn[2].split(",").map((s) => compiled.params[Number(s.trim().slice(1)) - 1]);
      if (prop) tests.push((r) => vals.some((v) => String(r[prop]) === String(v)));
      continue;
    }
    const mGt = part.match(/"[\w]+"\."([\w]+)" > \$(\d+)/);
    if (mGt) {
      const prop = colMap[mGt[1]];
      const val = compiled.params[Number(mGt[2]) - 1];
      if (prop) tests.push((r) => Number(r[prop]) > Number(val));
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
  self.groupBy = chain;
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
        const row = { createdAt: new Date(), updatedAt: new Date(), ...vals };
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
vi.mock("./permify", () => ({ permifyCheck: vi.fn().mockResolvedValue(true) }));

const { tenantConfigRouter } = await import("./routers/tenantConfig");

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function makeCtx(user: NonNullable<TrpcContext["user"]>): TrpcContext {
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

const callerA = () => tenantConfigRouter.createCaller(makeCtx(makeUser("user", TENANT_A)));
const callerB = () => tenantConfigRouter.createCaller(makeCtx(makeUser("user", TENANT_B)));

function seedTenant(id: string, name: string) {
  stores.tenants.push({
    id,
    name,
    slug: id,
    plan: "starter",
    status: "trial",
    whatsappPhoneNumberId: null,
    settings: buildDefaultTenantSettings(name),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(() => {
  stores.tenants = [];
  stores.products = [];
  stores.orders = [];
  seedTenant(TENANT_A, "Adire Atelier");
  seedTenant(TENANT_B, "Tenant B Shop");
});

// ─── CRM ─────────────────────────────────────────────────────────────────────

describe("crmConfig", () => {
  it("returns seeded defaults", async () => {
    const crm = await callerA().getCrmConfig({ tenantId: TENANT_A });
    expect(crm.pipelineStages).toEqual(["new", "qualified", "won", "lost"]);
    expect(crm.customFields).toEqual([]);
  });

  it("customFields CRUD", async () => {
    const field = { key: "size", label: "Dress size", type: "select" as const, required: false, options: ["S", "M", "L"] };
    let crm = await callerA().addCustomField({ tenantId: TENANT_A, field });
    expect(crm.customFields).toHaveLength(1);

    // duplicate key rejected
    await expect(callerA().addCustomField({ tenantId: TENANT_A, field })).rejects.toMatchObject({ code: "CONFLICT" });

    crm = await callerA().updateCustomField({ tenantId: TENANT_A, key: "size", patch: { label: "Size", required: true } });
    expect(crm.customFields[0]).toMatchObject({ key: "size", label: "Size", required: true });

    await expect(
      callerA().updateCustomField({ tenantId: TENANT_A, key: "missing", patch: { label: "X" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    crm = await callerA().removeCustomField({ tenantId: TENANT_A, key: "size" });
    expect(crm.customFields).toHaveLength(0);
    await expect(callerA().removeCustomField({ tenantId: TENANT_A, key: "size" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("zod rejects invalid custom fields and stages", async () => {
    // bad key format
    await expect(
      callerA().addCustomField({
        tenantId: TENANT_A,
        field: { key: "Bad Key!", label: "X", type: "text", required: false },
      }),
    ).rejects.toThrow();
    // empty label
    await expect(
      callerA().addCustomField({
        tenantId: TENANT_A,
        field: { key: "ok_key", label: "", type: "text", required: false },
      }),
    ).rejects.toThrow();
    // select without options
    await expect(
      callerA().addCustomField({
        tenantId: TENANT_A,
        field: { key: "sel", label: "Sel", type: "select", required: false },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // fewer than 2 stages
    await expect(callerA().setPipelineStages({ tenantId: TENANT_A, stages: ["only"] })).rejects.toThrow();
    // duplicate stages
    await expect(
      callerA().setPipelineStages({ tenantId: TENANT_A, stages: ["a", "a"] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("setPipelineStages persists", async () => {
    const crm = await callerA().setPipelineStages({
      tenantId: TENANT_A,
      stages: ["lead", "contacted", "won", "lost"],
    });
    expect(crm.pipelineStages).toEqual(["lead", "contacted", "won", "lost"]);
  });
});

// ─── Inventory / commerce / branding ─────────────────────────────────────────

describe("inventoryConfig / commerceConfig / brandingConfig", () => {
  it("inventory get/set + zod rejection", async () => {
    expect((await callerA().getInventoryConfig({ tenantId: TENANT_A })).source).toBe("local");
    const inv = await callerA().setInventoryConfig({
      tenantId: TENANT_A,
      config: { source: "medusa", lowStockThreshold: 12 },
    });
    expect(inv).toEqual({ source: "medusa", lowStockThreshold: 12 });
    await expect(
      callerA().setInventoryConfig({
        tenantId: TENANT_A,
        config: { source: "sap" as never, lowStockThreshold: 1 },
      }),
    ).rejects.toThrow();
  });

  it("commerce get/set with delivery zones + zod rejection", async () => {
    const cfg = {
      currency: "NGN",
      pickupEnabled: false,
      deliveryZones: [{ name: "Lagos Island", fee: 1500, estimatedDays: 1 }],
      feeOverrides: { deliveryFeeFlat: 1500 },
    };
    const saved = await callerA().setCommerceConfig({ tenantId: TENANT_A, config: cfg });
    expect(saved.deliveryZones).toHaveLength(1);
    expect(saved.pickupEnabled).toBe(false);
    await expect(
      callerA().setCommerceConfig({ tenantId: TENANT_A, config: { ...cfg, currency: "naira" } }),
    ).rejects.toThrow();
  });

  it("branding get/set + hex color enforcement", async () => {
    const branding = await callerA().setBrandingConfig({
      tenantId: TENANT_A,
      config: { name: "Adire", logoUrl: "https://cdn.example.com/logo.png", primaryColor: "#FF8800" },
    });
    expect(branding.primaryColor).toBe("#FF8800");
    await expect(
      callerA().setBrandingConfig({
        tenantId: TENANT_A,
        config: { name: "Adire", logoUrl: null, primaryColor: "red" },
      }),
    ).rejects.toThrow();
    await expect(
      callerA().setBrandingConfig({
        tenantId: TENANT_A,
        config: { name: "Adire", logoUrl: null, primaryColor: "#FFF" },
      }),
    ).rejects.toThrow();
  });
});

// ─── waMenu ──────────────────────────────────────────────────────────────────

describe("waMenuConfig", () => {
  it("returns the seeded default menu", async () => {
    const menu = await callerA().getWaMenuConfig({ tenantId: TENANT_A });
    expect(menu).toEqual(DEFAULT_WA_MENU);
  });

  it("full replace persists a valid menu", async () => {
    const custom = {
      greeting: "Hello from {businessName}",
      useCases: [
        { id: "shop" as const, label: "Browse", enabled: true, order: 2 },
        { id: "handoff" as const, label: "Agent", enabled: true, order: 1 },
      ],
      customItems: [{ key: "hours", label: "Opening hours", response: "9am-6pm daily" }],
      fallback: "menu" as const,
    };
    const saved = await callerA().setWaMenuConfig({ tenantId: TENANT_A, config: custom });
    expect(saved.fallback).toBe("menu");
    expect(saved.useCases.find((u) => u.id === "handoff")?.order).toBe(1);
  });

  it("rejects unknown use-case ids, empty labels, order collisions", async () => {
    const base = JSON.parse(JSON.stringify(DEFAULT_WA_MENU));
    // unknown id
    await expect(
      callerA().setWaMenuConfig({
        tenantId: TENANT_A,
        config: { ...base, useCases: [...base.useCases, { id: "lottery", label: "X", enabled: true, order: 9 }] },
      }),
    ).rejects.toThrow();
    // empty label
    await expect(
      callerA().setWaMenuConfig({
        tenantId: TENANT_A,
        config: { ...base, useCases: base.useCases.map((u: any) => (u.id === "shop" ? { ...u, label: "" } : u)) },
      }),
    ).rejects.toThrow();
    // order collision
    await expect(
      callerA().setWaMenuConfig({
        tenantId: TENANT_A,
        config: { ...base, useCases: base.useCases.map((u: any) => ({ ...u, order: 1 })) },
      }),
    ).rejects.toThrow(/order collision/i);
  });

  it("item-level add / update / remove / reorder", async () => {
    // add custom item
    let menu = await callerA().addWaMenuCustomItem({
      tenantId: TENANT_A,
      item: { key: "location", label: "Our location", response: "12 Marina Rd, Lagos" },
    });
    expect(menu.customItems).toHaveLength(1);
    await expect(
      callerA().addWaMenuCustomItem({
        tenantId: TENANT_A,
        item: { key: "location", label: "Dup", response: "x" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // update custom item response
    menu = await callerA().updateWaMenuItem({
      tenantId: TENANT_A,
      customKey: "location",
      patch: { response: "14 Marina Rd, Lagos" },
    });
    expect(menu.customItems[0].response).toBe("14 Marina Rd, Lagos");

    // update use-case label + enable support
    menu = await callerA().updateWaMenuItem({
      tenantId: TENANT_A,
      useCaseId: "support",
      patch: { label: "Help desk", enabled: true },
    });
    expect(menu.useCases.find((u) => u.id === "support")).toMatchObject({ label: "Help desk", enabled: true });

    // reorder: handoff first
    menu = await callerA().reorderWaMenuUseCases({
      tenantId: TENANT_A,
      orderedIds: ["handoff", "shop", "track", "support", "booking"],
    });
    expect(menu.useCases.find((u) => u.id === "handoff")?.order).toBe(1);
    expect(menu.useCases.find((u) => u.id === "booking")?.order).toBe(5);

    // reorder missing an id rejected
    await expect(
      callerA().reorderWaMenuUseCases({ tenantId: TENANT_A, orderedIds: ["shop", "track"] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // remove custom item
    menu = await callerA().removeWaMenuCustomItem({ tenantId: TENANT_A, key: "location" });
    expect(menu.customItems).toHaveLength(0);
    await expect(
      callerA().removeWaMenuCustomItem({ tenantId: TENANT_A, key: "location" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ─── previewWaMenu ───────────────────────────────────────────────────────────

describe("previewWaMenu", () => {
  it("renders greeting + numbered menu with live product/order data", async () => {
    // 6 in-stock products for tenant A, 1 out of stock, 1 for tenant B
    for (let i = 1; i <= 6; i++) {
      stores.products.push({
        id: `p${i}`, tenantId: TENANT_A, sku: `SKU${i}`, name: `Product ${i}`,
        price: "100.00", currency: "NGN", status: "active", stockQuantity: 10,
        createdAt: new Date(), updatedAt: new Date(),
      });
    }
    stores.products.push({
      id: "p0", tenantId: TENANT_A, sku: "SKU0", name: "Sold Out Thing",
      price: "50.00", currency: "NGN", status: "active", stockQuantity: 0,
      createdAt: new Date(), updatedAt: new Date(),
    });
    stores.products.push({
      id: "pb", tenantId: TENANT_B, sku: "SKUB", name: "B Widget",
      price: "10.00", currency: "NGN", status: "active", stockQuantity: 3,
      createdAt: new Date(), updatedAt: new Date(),
    });
    // orders: 2 open + 1 delivered + 1 cancelled for A; 1 open for B
    const mkOrder = (id: string, tenantId: string, status: string) => ({
      id, tenantId, customerId: "c1", orderNumber: id, status,
      totalAmount: "10.00", currency: "NGN", paymentStatus: "unpaid",
      createdAt: new Date(), updatedAt: new Date(),
    });
    stores.orders.push(
      mkOrder("o1", TENANT_A, "pending"),
      mkOrder("o2", TENANT_A, "shipped"),
      mkOrder("o3", TENANT_A, "delivered"),
      mkOrder("o4", TENANT_A, "cancelled"),
      mkOrder("ob", TENANT_B, "pending"),
    );

    const preview = await callerA().previewWaMenu({ tenantId: TENANT_A });
    const lines = preview.text.split("\n");

    expect(lines[0]).toBe("Welcome to Adire Atelier! How can we help you today?");
    // numbered enabled use cases by order: shop(1), track(2), handoff(5)
    expect(lines[2]).toBe("1. Shop products (6 items)");
    // top 5 in-stock product names as sub-lines (of 6 in stock)
    const subLines = lines.slice(3, 8);
    expect(subLines).toHaveLength(5);
    expect(subLines[0]).toMatch(/^   • Product /);
    expect(subLines.join("")).not.toContain("Sold Out Thing");
    expect(lines[8]).toBe("2. Track my order (2 open)");
    expect(lines[9]).toBe("3. Talk to a human");
    expect(preview.data.shopItemCount).toBe(6);
    expect(preview.data.openOrderCount).toBe(2);

    // tenant B sees its own data
    const previewB = await callerB().previewWaMenu({ tenantId: TENANT_B });
    expect(previewB.text).toContain("B Widget");
    expect(previewB.data.shopItemCount).toBe(1);
    expect(previewB.data.openOrderCount).toBe(1);
  });
});

// ─── Cross-tenant ────────────────────────────────────────────────────────────

describe("cross-tenant access", () => {
  it("tenant B cannot read or write tenant A config", async () => {
    await expect(callerB().getCrmConfig({ tenantId: TENANT_A })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerB().setInventoryConfig({ tenantId: TENANT_A, config: { source: "local", lowStockThreshold: 1 } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerB().setWaMenuConfig({ tenantId: TENANT_A, config: DEFAULT_WA_MENU }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerB().previewWaMenu({ tenantId: TENANT_A })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerB().addCustomField({
        tenantId: TENANT_A,
        field: { key: "x", label: "X", type: "text", required: false },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
