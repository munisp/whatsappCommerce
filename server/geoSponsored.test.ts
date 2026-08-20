/**
 * W25 sponsored-placement CRUD tests (geo.merchant.*): tenant guard, the
 * discoverable-location precondition on create, tenant-ownership on
 * pause/resume, and the paused-only resume transition. DB is mocked with a
 * sequential result queue (same approach as server/routers/crm.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));

import { getDb } from "./db";
import { geoRouter } from "./routers/geo";

const TENANT = { user: { id: 2, role: "user", tenantId: "t1" } } as any;
const OTHER_TENANT = { user: { id: 3, role: "user", tenantId: "t2" } } as any;
const NO_TENANT = { user: { id: 4, role: "user", tenantId: null } } as any;

const VALID = {
  name: "Weekend boost",
  categories: ["groceries"],
  centerLat: 6.5244,
  centerLng: 3.3792,
  radiusKm: 5,
  bidCents: 50,
  dailyBudgetCents: 1000,
};

beforeEach(() => vi.clearAllMocks());

/**
 * Mock db where every select/insert/update chain resolves, in order, to the
 * next entry of `results` (regardless of the chained method calls).
 */
function mockDbSequence(results: any[][]) {
  const queue = [...results];
  const chain = (): any =>
    new Proxy(function () {}, {
      get: (_t, prop) =>
        prop === "then" ? (res: any) => res(queue.shift() ?? []) : () => chain(),
      apply: () => chain(),
    });
  vi.mocked(getDb).mockResolvedValue({
    select: vi.fn(chain),
    insert: vi.fn(chain),
    update: vi.fn(chain),
  } as any);
}

describe("geo.merchant.createSponsoredListing", () => {
  it("requires a tenant on the session", async () => {
    mockDbSequence([]);
    await expect(
      geoRouter.createCaller(NO_TENANT).merchant.createSponsoredListing(VALID),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects when the tenant has no discoverable location", async () => {
    mockDbSequence([[{ id: "loc1", discoverable: false }]]);
    await expect(
      geoRouter.createCaller(TENANT).merchant.createSponsoredListing(VALID),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    mockDbSequence([[]]); // no location row at all
    await expect(
      geoRouter.createCaller(TENANT).merchant.createSponsoredListing(VALID),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("inserts an active placement when the location is discoverable", async () => {
    const inserted = { id: "sl1", tenantId: "t1", status: "active", ...VALID };
    mockDbSequence([[{ id: "loc1", discoverable: true }], [inserted]]);
    const row = await geoRouter.createCaller(TENANT).merchant.createSponsoredListing(VALID);
    expect(row).toMatchObject({ id: "sl1", status: "active" });
  });

  it("validates input (radius bounds, integer cents, name length)", async () => {
    mockDbSequence([[{ id: "loc1", discoverable: true }]]);
    const caller = geoRouter.createCaller(TENANT);
    await expect(
      caller.merchant.createSponsoredListing({ ...VALID, radiusKm: 0.1 }),
    ).rejects.toThrow();
    await expect(
      caller.merchant.createSponsoredListing({ ...VALID, bidCents: 1.5 }),
    ).rejects.toThrow();
    await expect(
      caller.merchant.createSponsoredListing({ ...VALID, name: "" }),
    ).rejects.toThrow();
    await expect(
      caller.merchant.createSponsoredListing({ ...VALID, dailyBudgetCents: 0 }),
    ).rejects.toThrow();
  });
});

describe("geo.merchant.listSponsoredListings", () => {
  it("returns the tenant's rows", async () => {
    const rows = [{ id: "a" }, { id: "b" }];
    mockDbSequence([rows]);
    const got = await geoRouter.createCaller(TENANT).merchant.listSponsoredListings();
    expect(got).toEqual(rows);
  });
});

describe("geo.merchant.pauseSponsoredListing", () => {
  const id = "11111111-1111-4111-8111-111111111111";

  it("pauses an owned listing", async () => {
    mockDbSequence([[{ id, tenantId: "t1", status: "paused" }]]);
    const row = await geoRouter.createCaller(TENANT).merchant.pauseSponsoredListing({ id });
    expect(row.status).toBe("paused");
  });

  it("NOT_FOUND when the row belongs to another tenant (scoped update)", async () => {
    mockDbSequence([[]]);
    await expect(
      geoRouter.createCaller(OTHER_TENANT).merchant.pauseSponsoredListing({ id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("geo.merchant.resumeSponsoredListing", () => {
  const id = "22222222-2222-4222-8222-222222222222";

  it("resumes a paused listing", async () => {
    mockDbSequence([[{ id, tenantId: "t1", status: "active" }]]);
    const row = await geoRouter.createCaller(TENANT).merchant.resumeSponsoredListing({ id });
    expect(row.status).toBe("active");
  });

  it("rejects when the listing is not paused (or not owned)", async () => {
    mockDbSequence([[]]);
    await expect(
      geoRouter.createCaller(TENANT).merchant.resumeSponsoredListing({ id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
