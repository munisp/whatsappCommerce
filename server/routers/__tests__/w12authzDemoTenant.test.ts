/**
 * W12 authz — DEMO_TENANT fallback removal in menu/template/odoo/twenty.
 * An authenticated user WITHOUT a tenantId must no longer be silently mapped
 * onto the shared "demo-tenant-001" data — reads and writes fail closed (403).
 * Platform admins keep the legacy demo-tenant fallback; users with a real
 * tenantId are unaffected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../../db";
import { menuRouter } from "../menu";
import { templateRouter } from "../template";
import { odooRouter } from "../odoo";
import { twentyRouter } from "../twenty";

const T1 = "tenant-1";

function makeChain(rows: any) {
  const p = Promise.resolve(rows);
  const c: any = { then: (res: any, rej: any) => p.then(res, rej), catch: (rej: any) => p.catch(rej) };
  for (const m of ["from", "where", "limit", "orderBy", "set", "values", "leftJoin", "groupBy"]) c[m] = () => c;
  return c;
}

function makeDb(selectRows: any = []) {
  const inserted: any[] = [];
  const db: any = {
    select: vi.fn(() => makeChain(selectRows)),
    insert: vi.fn(() => ({
      values: vi.fn((v: any) => {
        inserted.push(v);
        return makeChain([]);
      }),
    })),
    update: vi.fn(() => makeChain([])),
    delete: vi.fn(() => makeChain([])),
  };
  return { db, inserted };
}

const TENANTLESS = { user: { id: 3, role: "user", tenantId: null } } as any;
const ADMIN = { user: { id: 1, role: "admin", tenantId: null } } as any;
const TENANT_USER = { user: { id: 2, role: "user", tenantId: T1 } } as any;

beforeEach(() => vi.clearAllMocks());

describe("menu router — no silent demo-tenant mapping", () => {
  it("list: tenantless authenticated user rejected", async () => {
    const { db } = makeDb();
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = menuRouter.createCaller(TENANTLESS);
    await expect(caller.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("create (write): tenantless authenticated user rejected — never writes to demo tenant", async () => {
    const { db, inserted } = makeDb();
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = menuRouter.createCaller(TENANTLESS);
    await expect(caller.create({ name: "Evil menu" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(inserted).toHaveLength(0);
  });

  it("list: tenant user reads own tenant", async () => {
    const { db } = makeDb([{ id: "m1", tenantId: T1 }]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = menuRouter.createCaller(TENANT_USER);
    const r = await caller.list();
    expect(r).toEqual([{ id: "m1", tenantId: T1 }]);
  });

  it("create: tenant user's rows carry their own tenantId", async () => {
    const { db, inserted } = makeDb();
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = menuRouter.createCaller(TENANT_USER);
    await caller.create({ name: "My menu" });
    expect(inserted[0].tenantId).toBe(T1);
  });

  it("list: platform admin keeps demo-tenant fallback", async () => {
    const { db } = makeDb([]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = menuRouter.createCaller(ADMIN);
    await expect(caller.list()).resolves.toEqual([]);
  });
});

describe("template router — no silent demo-tenant mapping", () => {
  it("list: tenantless authenticated user rejected", async () => {
    const { db } = makeDb();
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = templateRouter.createCaller(TENANTLESS);
    await expect(caller.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("create (write): tenantless user rejected", async () => {
    const { db, inserted } = makeDb();
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = templateRouter.createCaller(TENANTLESS);
    await expect(
      caller.create({ name: "t", category: "custom", language: "en", bodyText: "hi" } as any),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(inserted).toHaveLength(0);
  });
});

describe("odoo router — no silent demo-tenant mapping", () => {
  it("getConfig: tenantless authenticated user rejected", async () => {
    const { db } = makeDb();
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = odooRouter.createCaller(TENANTLESS);
    await expect(caller.getConfig()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("getConfig: platform admin keeps demo-tenant fallback", async () => {
    const { db } = makeDb([]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = odooRouter.createCaller(ADMIN);
    await expect(caller.getConfig()).resolves.toBeNull();
  });
});

describe("twenty router — no silent demo-tenant mapping", () => {
  it("getConfig: tenantless authenticated user rejected", async () => {
    const { db } = makeDb();
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = twentyRouter.createCaller(TENANTLESS);
    await expect(caller.getConfig()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("listContacts: tenantless authenticated user rejected", async () => {
    const { db } = makeDb();
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = twentyRouter.createCaller(TENANTLESS);
    await expect(caller.listContacts({ limit: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
