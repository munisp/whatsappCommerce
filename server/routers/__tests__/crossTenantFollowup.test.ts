/**
 * QA follow-up: procedures the role×functionality matrix flagged as never
 * consulting the caller (`ctx`) yet reading or WRITING tenant-bearing data.
 *
 *  - webhookDlq.listEvents/stats  raw inbound WhatsApp payloads, all tenants (no tenantId column) -> admin
 *  - revenue.*                    every tenant's GMV / business name / COGS rate -> admin
 *  - cogsDispute.list             all-tenants COGS review queue (review() was already admin) -> admin
 *  - nlp.getOrderTimeline         any tenant's order by number alone -> tenant-asserted
 *  - productImages.clearClassBboxes / exportManifest
 *                                 wrote/read EVERY tenant's images -> scoped to the caller's tenant
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("../../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../../db";
import { webhookDlqRouter } from "../webhookDlq";
import { revenueRouter } from "../revenue";
import { cogsDisputeRouter } from "../cogsDispute";
import { nlpRouter } from "../nlp";
import { productImagesRouter } from "../productImages";
import { mlAbTestRouter, datasetSnapshotRouter } from "../mlOps";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const USER_A = { user: { id: 5, role: "user", tenantId: TENANT_A, openId: "a" } } as any;
const ADMIN = { user: { id: 1, role: "admin", tenantId: null, openId: "admin" } } as any;

const sqlOf = (cond: any) => (cond ? new PgDialect().sqlToQuery(cond) : null);

beforeEach(() => vi.clearAllMocks());

describe("platform-wide data is admin-only", () => {
  it.each([
    ["webhookDlq.listEvents", (c: any) => webhookDlqRouter.createCaller(c).listEvents({})],
    ["webhookDlq.stats", (c: any) => webhookDlqRouter.createCaller(c).stats()],
    ["revenue.summary", (c: any) => revenueRouter.createCaller(c).summary()],
    ["revenue.tenantBreakdown", (c: any) => revenueRouter.createCaller(c).tenantBreakdown({})],
    ["revenue.gmvLeaderboard", (c: any) => revenueRouter.createCaller(c).gmvLeaderboard({})],
    ["revenue.monthlyTrend", (c: any) => revenueRouter.createCaller(c).monthlyTrend({})],
    ["cogsDispute.list", (c: any) => cogsDisputeRouter.createCaller(c).list({})],
  ])("%s: a tenant user is FORBIDDEN and the DB is never queried", async (_n, call) => {
    await expect(call(USER_A)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("webhookDlq.listEvents / cogsDispute.list still work for a platform admin", async () => {
    const chain: any = { from: () => chain, leftJoin: () => chain, where: () => chain, orderBy: () => chain, limit: () => Promise.resolve([]), then: (r: any) => Promise.resolve([]).then(r) };
    vi.mocked(getDb).mockResolvedValue({ select: () => chain } as any);
    await expect(webhookDlqRouter.createCaller(ADMIN).listEvents({})).resolves.toEqual([]);
    await expect(cogsDisputeRouter.createCaller(ADMIN).list({})).resolves.toEqual([]);
  });
});

describe("platform ML-governance writes are admin-only", () => {
  it.each([
    ["mlAbTest.create", (c: any) => mlAbTestRouter.createCaller(c).create({ modelName: "m", championVersion: "v1", challengerVersion: "v2" })],
    ["mlAbTest.conclude", (c: any) => mlAbTestRouter.createCaller(c).conclude({ id: "x", winner: "champion" })],
    ["datasetSnapshot.create", (c: any) => datasetSnapshotRouter.createCaller(c).create({ totalImages: 1, bboxImages: 0, qualityImages: 0, classStats: {} })],
  ])("%s: a tenant user is FORBIDDEN and the DB is never queried", async (_n, call) => {
    await expect(call(USER_A)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getDb).not.toHaveBeenCalled();
  });
});

describe("nlp.getOrderTimeline — tenant asserted after the order is loaded", () => {
  function dbWithOrderOf(tenantId: string) {
    let call = 0;
    const select = vi.fn(() => {
      const rows = call++ === 0 ? [{ id: "o1", tenantId, orderNumber: "ORD-1", status: "confirmed", createdAt: new Date(), updatedAt: new Date() }] : [];
      const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, limit: () => Promise.resolve(rows), then: (r: any) => Promise.resolve(rows).then(r) };
      return chain;
    });
    return { select };
  }

  it("another tenant's order number is FORBIDDEN and no items/payments are read", async () => {
    const db = dbWithOrderOf(TENANT_B);
    vi.mocked(getDb).mockResolvedValue(db as any);
    await expect(nlpRouter.createCaller(USER_A).getOrderTimeline({ orderNumber: "ORD-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.select).toHaveBeenCalledTimes(1); // only the order lookup happened
  });

  it("the caller's own order passes the tenant check", async () => {
    vi.mocked(getDb).mockResolvedValue(dbWithOrderOf(TENANT_A) as any);
    await expect(nlpRouter.createCaller(USER_A).getOrderTimeline({ orderNumber: "ORD-1" })).resolves.toBeDefined();
  });
});

describe("productImages dataset-wide operations are tenant-scoped", () => {
  function capturingDb() {
    const wheres: any[] = [];
    const db: any = {
      update: () => ({ set: () => ({ where: (c: any) => { wheres.push({ op: "update", c }); return Promise.resolve([]); } }) }),
      select: () => ({ from: () => ({ where: (c: any) => { wheres.push({ op: "select", c }); return { orderBy: () => Promise.resolve([]) }; }, orderBy: () => Promise.resolve([]) }) }),
    };
    return { db, wheres };
  }

  it("clearClassBboxes: a tenant user's UPDATE is constrained to their own tenantId", async () => {
    const { db, wheres } = capturingDb();
    vi.mocked(getDb).mockResolvedValue(db);
    await productImagesRouter.createCaller(USER_A).clearClassBboxes({ className: "rice_50kg" });
    const q = sqlOf(wheres[0].c)!;
    expect(q.sql).toContain('"tenantId"');
    expect(q.params).toEqual(expect.arrayContaining(["rice_50kg", TENANT_A]));
  });

  it("clearClassBboxes: a platform admin keeps the class-wide (all-tenant) operation", async () => {
    const { db, wheres } = capturingDb();
    vi.mocked(getDb).mockResolvedValue(db);
    await productImagesRouter.createCaller(ADMIN).clearClassBboxes({ className: "rice_50kg" });
    const q = sqlOf(wheres[0].c)!;
    expect(q.sql).not.toContain('"tenantId"');
    expect(q.params).toEqual(["rice_50kg"]);
  });

  it("exportManifest: both the read AND the 'mark used in training' write are limited to the caller's tenant", async () => {
    const { db, wheres } = capturingDb();
    vi.mocked(getDb).mockResolvedValue(db);
    await productImagesRouter.createCaller(USER_A).exportManifest();
    expect(wheres.map((w) => w.op)).toEqual(["select", "update"]);
    for (const w of wheres) {
      const q = sqlOf(w.c)!;
      expect(q.sql).toContain('"tenantId"');
      expect(q.params).toEqual([TENANT_A]);
    }
  });

  it("exportManifest: a platform admin gets the platform-wide set (no tenant filter)", async () => {
    const { db, wheres } = capturingDb();
    vi.mocked(getDb).mockResolvedValue(db);
    await productImagesRouter.createCaller(ADMIN).exportManifest();
    for (const w of wheres) expect(w.c).toBeUndefined();
  });
});
