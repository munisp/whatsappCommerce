/**
 * W17 F8 — journeys + consents routers: tenant gating, validation wiring,
 * withdrawal flow, and the broadcast send-path withdrawal gate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../../db";
import { journeysRouter } from "../journeys";
import { consentsRouter } from "../consents";
import { getConsentedPhones } from "../broadcast";

const T1 = "tenant-1";
const T2 = "tenant-2";
const OWNER_T1 = { user: { id: 2, role: "user", tenantId: T1 } } as any;
const ANON = { user: null } as any;

function fakeDb(over: Partial<Record<string, any>> = {}) {
  const updates: any[] = [];
  const inserts: any[] = [];
  const executed: any[] = [];
  const selectResults = [...(over.selectQueue ?? [])];
  const chain: any = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(() => Promise.resolve(selectResults.shift() ?? [])),
    then: (resolve: any, reject: any) => Promise.resolve(selectResults.shift() ?? []).then(resolve, reject),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  const db: any = {
    select: vi.fn(() => chain),
    update: vi.fn(() => ({
      set: vi.fn((vals: any) => {
        updates.push(vals);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: any) => {
        inserts.push(v);
        return { returning: vi.fn(() => Promise.resolve([{ id: "c-new" }])) };
      }),
    })),
    execute: vi.fn((q: any) => {
      executed.push(q);
      return Promise.resolve({ rows: [] });
    }),
  };
  return { db, updates, inserts, executed };
}

beforeEach(() => vi.clearAllMocks());

const VALID_STEPS = [
  { id: "s1", type: "send_template", templateName: "welcome" },
  { id: "s2", type: "exit" },
];

describe("journeys router gating", () => {
  it("list rejects anonymous callers", async () => {
    await expect(journeysRouter.createCaller(ANON).list({ tenantId: T1 }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("list rejects cross-tenant callers", async () => {
    await expect(journeysRouter.createCaller(OWNER_T1).list({ tenantId: T2 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("create rejects invalid step graphs (BAD_REQUEST)", async () => {
    vi.mocked(getDb).mockResolvedValue(fakeDb().db);
    await expect(
      journeysRouter.createCaller(OWNER_T1).create({
        tenantId: T1,
        name: "Bad",
        steps: [{ id: "s1", type: "wait", durationMinutes: 99 * 24 * 60 }] as any,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("create persists a draft journey for the owning tenant", async () => {
    const { db, inserts } = fakeDb();
    const insertSpy = vi.fn(() => ({
      values: vi.fn((v: any) => { inserts.push(v); return Promise.resolve(); }),
    }));
    db.insert = insertSpy;
    vi.mocked(getDb).mockResolvedValue(db);
    const res = await journeysRouter.createCaller(OWNER_T1).create({
      tenantId: T1, name: "Onboarding", steps: VALID_STEPS as any,
    });
    expect(res.id).toBeTruthy();
    expect(inserts[0]).toMatchObject({ tenantId: T1, name: "Onboarding", status: "draft" });
  });

  it("get guards by the journey's owning tenant", async () => {
    const { db } = fakeDb({ selectQueue: [[{ id: "j1", tenantId: T2, steps: VALID_STEPS }]] });
    vi.mocked(getDb).mockResolvedValue(db);
    await expect(journeysRouter.createCaller(OWNER_T1).get({ journeyId: "j1" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("consents router", () => {
  it("list rejects cross-tenant callers", async () => {
    await expect(consentsRouter.createCaller(OWNER_T1).list({ tenantId: T2 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("recordWithdrawal sets granted=false + withdrawnAt on the existing row", async () => {
    const { db, updates } = fakeDb({ selectQueue: [[{ id: "c1", tenantId: T1, phone: "+2348011111111", channel: "whatsapp" }]] });
    vi.mocked(getDb).mockResolvedValue(db);
    const res = await consentsRouter.createCaller(OWNER_T1).recordWithdrawal({ tenantId: T1, phone: "+2348011111111" });
    expect(res).toMatchObject({ id: "c1", updated: true });
    expect(res.withdrawnAt).toBeInstanceOf(Date);
    expect(updates[0]).toMatchObject({ granted: false, withdrawnAt: expect.any(Date) });
  });

  it("recordWithdrawal inserts a denied+withdrawn row when none exists", async () => {
    const { db, inserts } = fakeDb({ selectQueue: [[]] });
    vi.mocked(getDb).mockResolvedValue(db);
    const res = await consentsRouter.createCaller(OWNER_T1).recordWithdrawal({ tenantId: T1, phone: "+2348055555555" });
    expect(res).toMatchObject({ id: "c-new", updated: false });
    expect(inserts[0]).toMatchObject({ granted: false, withdrawnAt: expect.any(Date), source: "tenant_dashboard" });
  });

  it("exportCsv returns CSV-ready headers + rows", async () => {
    const row = {
      phone: "+2348011111111", channel: "whatsapp", scope: "marketing", granted: true,
      grantedAt: new Date("2026-03-01T10:00:00Z"), source: "whatsapp_reply",
      withdrawnAt: null, updatedAt: new Date("2026-03-01T10:00:00Z"),
    };
    const { db } = fakeDb({ selectQueue: [[row]] });
    vi.mocked(getDb).mockResolvedValue(db);
    const res = await consentsRouter.createCaller(OWNER_T1).exportCsv({ tenantId: T1 });
    expect(res.headers).toContain("withdrawnAt");
    expect(res.rows[0]).toMatchObject({ phone: "+2348011111111", granted: "true", withdrawnAt: "" });
  });
});

describe("broadcast send path withdrawal gate", () => {
  it("getConsentedPhones filters withdrawn consent rows in SQL", async () => {
    const { db, executed } = fakeDb();
    await getConsentedPhones(db, T1);
    expect(executed.length).toBe(1);
    // Inspect the SQL chunks for the withdrawal predicate.
    const text = JSON.stringify(executed[0]?.queryChunks?.map((c: any) => c?.value ?? "") ?? executed[0]);
    expect(text).toContain("withdrawn_at IS NULL");
    expect(text).toContain("granted = true");
  });
});
