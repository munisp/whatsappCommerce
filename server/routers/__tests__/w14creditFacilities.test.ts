/**
 * W14 F4 — creditFacilities router: admin-gating (non-admin 403) and
 * end-to-end procedure behavior on the creditFacilities fakeDb.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../../db";
import { creditFacilitiesRouter } from "../creditFacilities";
import { makeFakeDb, seedAccountExt, seedFacility } from "../../services/creditFacilities/fakeDb";

const ADMIN = { user: { id: 1, role: "admin", tenantId: null } } as any;
const TENANT_USER = { user: { id: 2, role: "user", tenantId: "tenant-1" } } as any;
const ANON = { user: null } as any;

beforeEach(() => vi.clearAllMocks());

describe("admin gating (non-admin → FORBIDDEN)", () => {
  it.each([
    ["createFacility", (c: any) => c.createFacility({ lenderName: "L", facilityRef: "R", commitmentCents: 1 })],
    ["listFacilities", (c: any) => c.listFacilities()],
    ["assignAccount", (c: any) => c.assignAccount({ accountId: "a", facilityId: "f" })],
    ["generateTape", (c: any) => c.generateTape({})],
    ["covenantCheck", (c: any) => c.covenantCheck({ facilityId: "f" })],
    ["tapeEmailPreview", (c: any) => c.tapeEmailPreview({ facilityId: "f" })],
  ])("%s rejects tenant user", async (_name, call) => {
    const caller = creditFacilitiesRouter.createCaller(TENANT_USER);
    await expect(call(caller)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it.each([
    ["createFacility", (c: any) => c.createFacility({ lenderName: "L", facilityRef: "R", commitmentCents: 1 })],
    ["listFacilities", (c: any) => c.listFacilities()],
    ["generateTape", (c: any) => c.generateTape({})],
  ])("%s rejects unauthenticated", async (_name, call) => {
    const caller = creditFacilitiesRouter.createCaller(ANON);
    await expect(call(caller)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("procedure behavior (admin)", () => {
  it("create → assign → list with utilization", async () => {
    const { db, store } = makeFakeDb({ accounts: [seedAccountExt({ id: "a1", outstandingCents: 250_000 })] });
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = creditFacilitiesRouter.createCaller(ADMIN);

    const fac = await caller.createFacility({
      lenderName: "Kuda MFB",
      facilityRef: "FAC-1",
      commitmentCents: 1_000_000,
      advanceRateBps: 8000,
    });
    expect(fac.facilityRef).toBe("FAC-1");

    await caller.assignAccount({ accountId: "a1", facilityId: fac.id });
    expect(store.accounts[0].facilityId).toBe(fac.id);

    const list = await caller.listFacilities();
    expect(list).toHaveLength(1);
    expect(list[0].utilization.outstandingCents).toBe(250_000);
    expect(list[0].utilization.utilizationBps).toBe(2500);
    expect(list[0].utilization.availableToAdvanceCents).toBe(800_000 - 250_000);
  });

  it("duplicate facilityRef → CONFLICT", async () => {
    const { db } = makeFakeDb({ facilities: [seedFacility({ facilityRef: "FAC-1" })] });
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = creditFacilitiesRouter.createCaller(ADMIN);
    await expect(
      caller.createFacility({ lenderName: "L", facilityRef: "FAC-1", commitmentCents: 1 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("assignAccount with unknown facility → NOT_FOUND", async () => {
    const { db } = makeFakeDb({ accounts: [seedAccountExt({ id: "a1" })] });
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = creditFacilitiesRouter.createCaller(ADMIN);
    await expect(caller.assignAccount({ accountId: "a1", facilityId: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("generateTape json returns rows + summary", async () => {
    const fac = seedFacility({ id: "f1", facilityRef: "FAC-1" });
    const { db } = makeFakeDb({
      facilities: [fac],
      accounts: [seedAccountExt({ id: "a1", facilityId: "f1", outstandingCents: 100 })],
    });
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = creditFacilitiesRouter.createCaller(ADMIN);
    const tape = await caller.generateTape({ facilityId: "f1", format: "json" });
    expect(tape.format).toBe("json");
    expect(tape).toMatchObject({ facilityRef: "FAC-1" });
    expect((tape as any).rows).toHaveLength(1);
    expect((tape as any).summary.totalOutstandingCents).toBe(100);
  });

  it("generateTape csv returns a downloadable document", async () => {
    const { db } = makeFakeDb({ accounts: [seedAccountExt({ id: "a1", outstandingCents: 100 })] });
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = creditFacilitiesRouter.createCaller(ADMIN);
    const out = await caller.generateTape({ format: "csv" });
    expect(out.format).toBe("csv");
    expect(out).toMatchObject({ contentType: "text/csv" });
    expect((out as any).filename).toMatch(/^loan-book-tape-\d{4}-\d{2}-\d{2}\.csv$/);
    expect((out as any).content).toContain("accountId,buyerTenantId");
  });

  it("covenantCheck + tapeEmailPreview run for admin", async () => {
    const fac = seedFacility({ id: "f1", commitmentCents: 1_000_000, covenants: { maxUtilizationPct: 10 } });
    const { db } = makeFakeDb({
      facilities: [fac],
      accounts: [seedAccountExt({ facilityId: "f1", outstandingCents: 500_000 })],
    });
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = creditFacilitiesRouter.createCaller(ADMIN);
    const cov = await caller.covenantCheck({ facilityId: "f1" });
    expect(cov.compliant).toBe(false);
    expect(cov.breaches[0].covenant).toBe("utilization");
    const preview = await caller.tapeEmailPreview({ facilityId: "f1" });
    expect(preview.text).toContain("FAC-");
  });
});
