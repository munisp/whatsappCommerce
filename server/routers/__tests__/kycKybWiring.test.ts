/**
 * A3-F01 — KYB wiring: runKybChecks is called from the KYB lifecycle.
 *  - updateApplication persists a [kyb-screen] recommendation to reviewNotes
 *  - submit blocks on a persisted reject recommendation
 *  - review approval fails closed on reject OR sanctions.degraded
 *  - provider disabled + no SANCTIONS_LIST_URL → screening skipped (legacy)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));
vi.mock("../../storage", () => ({ storagePut: vi.fn(async () => ({ url: "https://cdn.example.com/f", key: "k" })) }));
vi.mock("../../services/compliance", () => ({ runKybChecks: vi.fn() }));

import { getDb } from "../../db";
import { runKybChecks } from "../../services/compliance";
import { kycRouter } from "../kyc";

const T1 = "tenant-1";
const ADMIN = { user: { id: 9, role: "admin", tenantId: T1, name: "Admin" } } as any;
const OWN = { user: { id: 2, role: "user", tenantId: T1 } } as any;

function makeChain(rows: any) {
  const p = Promise.resolve(rows);
  const c: any = { then: (res: any, rej: any) => p.then(res, rej), catch: (rej: any) => p.catch(rej) };
  for (const m of ["from", "where", "limit", "orderBy", "set", "values"]) c[m] = () => c;
  return c;
}

function makeDb(selectResponses: any[] = []) {
  let i = 0;
  const updates: any[] = [];
  const db: any = {
    select: vi.fn(() => makeChain(selectResponses[i++] ?? [])),
    insert: vi.fn(() => ({ values: vi.fn(() => makeChain([])) })),
    update: vi.fn(() => {
      const c = makeChain([]);
      c.set = (v: any) => { updates.push(v); return c; };
      return c;
    }),
  };
  return { db, updates };
}

const appRow = {
  id: "app-1",
  tenantId: T1,
  type: "kyb",
  status: "pending",
  businessName: "Acme Ltd",
  businessRegistrationNumber: "RC12345",
  businessCountry: "NG",
  reviewNotes: null as string | null,
};

const KYB_OK = {
  registry: { status: "verified", provider: "stub" },
  sanctions: { hit: false, matches: [], screenedAt: "t", source: "remote" },
  recommendation: "auto_approve",
  reasons: ["registry verified via stub", "no sanctions hits"],
} as any;

const KYB_DEGRADED = {
  ...KYB_OK,
  sanctions: { hit: true, matches: [], screenedAt: "t", source: "degraded", degraded: true },
  recommendation: "manual_review",
  reasons: ["sanctions screening degraded (list unavailable) — manual review required"],
} as any;

const ENV_KEYS = ["COMPLIANCE_REGISTRY_PROVIDER", "SANCTIONS_LIST_URL", "KYB_SCREENING_DISABLED"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.COMPLIANCE_REGISTRY_PROVIDER = "stub";
  delete process.env.SANCTIONS_LIST_URL;
  delete process.env.KYB_SCREENING_DISABLED;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("A3-F01 KYB wiring", () => {
  it("review approval triggers screening and approves on clean result", async () => {
    vi.mocked(runKybChecks).mockResolvedValue(KYB_OK);
    const { db, updates } = makeDb([[appRow], []]); // app, docs
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(ADMIN);
    const res = await caller.review({ applicationId: "app-1", decision: "approved" });
    expect(res.ok).toBe(true);
    expect(runKybChecks).toHaveBeenCalledTimes(1);
    expect(updates.some((u) => u.status === "approved")).toBe(true);
  });

  it("review approval blocks when sanctions screening is degraded (fail-closed)", async () => {
    vi.mocked(runKybChecks).mockResolvedValue(KYB_DEGRADED);
    const { db } = makeDb([[appRow]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(ADMIN);
    await expect(
      caller.review({ applicationId: "app-1", decision: "approved" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("review approval blocks on reject recommendation", async () => {
    vi.mocked(runKybChecks).mockResolvedValue({ ...KYB_OK, recommendation: "reject", reasons: ["sanctions hit"] });
    const { db } = makeDb([[appRow]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(ADMIN);
    await expect(
      caller.review({ applicationId: "app-1", decision: "approved" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("KYB_SCREENING_DISABLED=true (non-prod) → screening skipped, legacy approval preserved", async () => {
    // W30 merge (V2#10): the legacy provider-gated default is gone — screening
    // is default-ON and is skipped ONLY via the explicit non-prod escape hatch.
    process.env.KYB_SCREENING_DISABLED = "true";
    const { db } = makeDb([[appRow], []]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(ADMIN);
    const res = await caller.review({ applicationId: "app-1", decision: "approved" });
    expect(res.ok).toBe(true);
    expect(runKybChecks).not.toHaveBeenCalled();
  });

  it("updateApplication persists a [kyb-screen] recommendation to reviewNotes", async () => {
    vi.mocked(runKybChecks).mockResolvedValue(KYB_OK);
    const { db, updates } = makeDb([[appRow]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(OWN);
    const res = await caller.updateApplication({ applicationId: "app-1", businessName: "Acme Ltd" });
    expect(res.ok).toBe(true);
    expect(runKybChecks).toHaveBeenCalledTimes(1);
    expect(res.kybScreen).toMatch(/\[kyb-screen\] recommendation=auto_approve/);
    expect(updates.some((u) => typeof u.reviewNotes === "string" && u.reviewNotes.includes("[kyb-screen]"))).toBe(true);
  });

  it("submit blocks on a persisted reject recommendation", async () => {
    const rejected = { ...appRow, reviewNotes: "[kyb-screen] recommendation=reject at t — sanctions hit" };
    const { db } = makeDb([[rejected]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(OWN);
    await expect(caller.submit({ applicationId: "app-1" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("submit succeeds when screening is skipped (disabled provider)", async () => {
    process.env.COMPLIANCE_REGISTRY_PROVIDER = "disabled";
    delete process.env.SANCTIONS_LIST_URL;
    const { db, updates } = makeDb([[appRow]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(OWN);
    const res = await caller.submit({ applicationId: "app-1" });
    expect(res.ok).toBe(true);
    expect(runKybChecks).not.toHaveBeenCalled();
    expect(updates.some((u) => u.status === "pending")).toBe(true);
  });
});
