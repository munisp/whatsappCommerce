/**
 * W12 authz — kyc router: tenant scoping on application create/read and
 * document upload; document rows must carry the application's real tenantId.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));
vi.mock("../../storage", () => ({ storagePut: vi.fn(async () => ({ url: "https://cdn.example.com/file", key: "k" })) }));

import { getDb } from "../../db";
import { kycRouter } from "../kyc";

const T1 = "tenant-1";
const T2 = "tenant-2";

function makeChain(rows: any) {
  const p = Promise.resolve(rows);
  const c: any = { then: (res: any, rej: any) => p.then(res, rej), catch: (rej: any) => p.catch(rej) };
  for (const m of ["from", "where", "limit", "orderBy", "set", "values"]) c[m] = () => c;
  return c;
}

function makeDb(selectResponses: any[] = []) {
  let i = 0;
  const inserted: any[] = [];
  const db: any = {
    select: vi.fn(() => makeChain(selectResponses[i++] ?? [])),
    insert: vi.fn(() => ({
      values: vi.fn((v: any) => {
        inserted.push(v);
        return makeChain([]);
      }),
    })),
    update: vi.fn(() => makeChain([])),
  };
  return { db, inserted };
}

const OWN = { user: { id: 2, role: "user", tenantId: T1 } } as any;
const appRow = { id: "app-1", tenantId: T1, type: "kyb", status: "not_started" };
const otherAppRow = { id: "app-2", tenantId: T2, type: "kyb", status: "not_started" };

beforeEach(() => {
  vi.clearAllMocks();
  // KYC microservice must not be hit in tests; it is best-effort/caught anyway.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
});

describe("kyc.getOrCreateApplication", () => {
  it("rejects cross-tenant creation", async () => {
    const { db } = makeDb();
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(OWN);
    await expect(caller.getOrCreateApplication({ tenantId: T2, type: "kyb" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns existing application for own tenant", async () => {
    const { db } = makeDb([[appRow]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(OWN);
    const r = await caller.getOrCreateApplication({ tenantId: T1, type: "kyb" });
    expect(r.id).toBe("app-1");
  });
});

describe("kyc.getApplication", () => {
  it("rejects reading another tenant's application (documents + liveness)", async () => {
    const { db } = makeDb([[otherAppRow]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(OWN);
    await expect(caller.getApplication({ applicationId: "app-2" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns own application with documents", async () => {
    const { db } = makeDb([[appRow], [{ id: "doc-1" }], []]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(OWN);
    const r = await caller.getApplication({ applicationId: "app-1" });
    expect(r?.id).toBe("app-1");
    expect(r?.documents).toEqual([{ id: "doc-1" }]);
  });

  it("returns null for unknown application", async () => {
    const { db } = makeDb([[]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(OWN);
    await expect(caller.getApplication({ applicationId: "nope" })).resolves.toBeNull();
  });
});

describe("kyc.uploadDocument", () => {
  it("rejects upload into another tenant's application", async () => {
    const { db, inserted } = makeDb([[otherAppRow]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(OWN);
    await expect(
      caller.uploadDocument({ applicationId: "app-2", documentType: "passport", fileBase64: "AA==" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(inserted).toHaveLength(0);
  });

  it("own-tenant upload stores the application's real tenantId (not 'unknown')", async () => {
    const { db, inserted } = makeDb([[appRow]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(OWN);
    const r = await caller.uploadDocument({ applicationId: "app-1", documentType: "passport", fileBase64: "AA==" });
    expect(r.ok).toBe(true);
    expect(inserted[0].tenantId).toBe(T1);
  });

  it("unknown application → NOT_FOUND, no document row", async () => {
    const { db, inserted } = makeDb([[]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(OWN);
    await expect(
      caller.uploadDocument({ applicationId: "ghost", documentType: "passport", fileBase64: "AA==" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(inserted).toHaveLength(0);
  });
});

describe("kyc.submit / updateApplication / createLivenessSession", () => {
  it("submit: cross-tenant rejected", async () => {
    const { db } = makeDb([[otherAppRow]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(OWN);
    await expect(caller.submit({ applicationId: "app-2" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("updateApplication: cross-tenant rejected", async () => {
    const { db } = makeDb([[otherAppRow]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(OWN);
    await expect(caller.updateApplication({ applicationId: "app-2", applicantName: "X" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("createLivenessSession: cross-tenant rejected", async () => {
    const { db } = makeDb();
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(OWN);
    await expect(caller.createLivenessSession({ applicationId: "app-1", tenantId: T2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
