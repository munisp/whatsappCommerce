/**
 * KYB applications without the details screening needs (2026-11-09).
 *
 * Set up shop pre-filled the KYB form locally but Submit sent only the application id, so applications reached the
 * review queue with no business name, registration number or country. Screening can't run without them, approval
 * fails closed without screening, and every Approve answered 412 "KYB screening unavailable" — misleading, unlogged,
 * and with no way forward. Now:
 *  - submit refuses an application missing any of the three, naming them in plain words;
 *  - review says exactly what's missing and to request resubmission, without calling the screening provider;
 *  - a complete application still submits.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./routers/audit", () => ({ writeAuditLog: vi.fn(async () => {}) }));
const runKybChecks = vi.fn(async () => { throw new Error("screening must not be called for an incomplete application"); });
vi.mock("./services/compliance", () => ({ runKybChecks: (...a: unknown[]) => runKybChecks(...(a as [])) }));

import { getDb } from "./db";
import { kycRouter } from "./routers/kyc";
import { missingScreeningFields, listInWords } from "../shared/kybScreening";

const MERCHANT = { user: { id: 7, role: "user", tenantId: "t-1", name: "Merchant" } } as any;
const ADMIN = { user: { id: 1, role: "admin", tenantId: null, name: "Admin" } } as any;

let app: Record<string, unknown>;
const updates: Record<string, unknown>[] = [];

function fakeDb() {
  const rows = () => Promise.resolve([app]);
  const chain: any = {
    from: () => chain, where: () => chain, orderBy: () => Promise.resolve([]),
    limit: () => rows(), then: (res: any, rej: any) => Promise.resolve([]).then(res, rej),
  };
  return {
    select: () => chain,
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: () => { updates.push(v); return Promise.resolve(); } }) }),
  };
}

const empty = { id: "app-1", tenantId: "t-1", status: "not_started", reviewNotes: null, businessName: null, businessRegistrationNumber: "", businessCountry: null };
const complete = { ...empty, businessName: "Lagos Fresh Market Ltd", businessRegistrationNumber: "RC-1234567", businessCountry: "NG" };

beforeEach(() => {
  updates.length = 0; runKybChecks.mockClear();
  vi.mocked(getDb).mockResolvedValue(fakeDb() as any);
});

describe("the shared rule", () => {
  it("names each empty field in plain words, blanks count as empty", () => {
    expect(missingScreeningFields(empty)).toEqual(["registered business name", "registration number", "country"]);
    expect(missingScreeningFields({ ...complete, businessCountry: "  " })).toEqual(["country"]);
    expect(missingScreeningFields(complete)).toEqual([]);
    expect(listInWords(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("kyc.submit", () => {
  it("refuses an application without business name, registration number and country — and says which", async () => {
    app = { ...empty };
    const err = await kycRouter.createCaller(MERCHANT).submit({ applicationId: "app-1" }).catch((e) => e);
    expect(err.code).toBe("PRECONDITION_FAILED");
    expect(err.message).toBe("Add your registered business name, registration number and country and save your details before submitting.");
    expect(updates).toHaveLength(0); // never reaches the review queue
  });

  it("submits a complete application", async () => {
    app = { ...complete };
    await expect(kycRouter.createCaller(MERCHANT).submit({ applicationId: "app-1" })).resolves.toEqual({ ok: true });
    expect(updates[0]).toMatchObject({ status: "pending" });
  });
});

describe("kyc.review approve", () => {
  it("on an incomplete application names what's missing and the way forward, without calling screening", async () => {
    app = { ...empty, status: "pending", businessName: "Shop" };
    const err = await kycRouter.createCaller(ADMIN).review({ applicationId: "app-1", decision: "approved" }).catch((e) => e);
    expect(err.code).toBe("PRECONDITION_FAILED");
    expect(err.message).toContain("has no registration number and country, so screening can't run");
    expect(err.message).toContain('"Request resubmission"');
    expect(err.message).not.toContain("unavailable");
    expect(runKybChecks).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});
