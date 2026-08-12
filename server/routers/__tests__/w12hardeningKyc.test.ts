/**
 * W12.1 hardening — kyc.review document-verification gate.
 *
 * An application may not reach 'approved' while any of its documents is
 * still awaiting OCR/VLM verification (processedAt unset). Proves:
 *  - approval with pending docs fails closed with PRECONDITION_FAILED;
 *  - the failure names the pending document types;
 *  - waivePendingDocuments=true approves AND records the waiver on each
 *    pending document and in the application's reviewNotes;
 *  - fully-processed documents approve without a waiver;
 *  - the gate applies only to approval (rejection is unaffected);
 *  - review stays admin-only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));
vi.mock("../../storage", () => ({ storagePut: vi.fn(async () => ({ url: "https://cdn.example.com/file", key: "k" })) }));

import { getDb } from "../../db";
import { kycRouter } from "../kyc";

function makeChain(rows: any) {
  const p = Promise.resolve(rows);
  const c: any = { then: (res: any, rej: any) => p.then(res, rej), catch: (rej: any) => p.catch(rej) };
  for (const m of ["from", "where", "limit", "orderBy", "set", "values"]) c[m] = () => c;
  return c;
}

function makeDb(docs: any[]) {
  const updates: Array<{ set: any }> = [];
  const db: any = {
    select: vi.fn(() => makeChain(docs)),
    update: vi.fn(() => ({
      set: vi.fn((v: any) => {
        updates.push({ set: v });
        return makeChain([]);
      }),
    })),
  };
  return { db, updates };
}

const ADMIN = { user: { id: 1, role: "admin", name: "Root Admin", tenantId: null } } as any;
const APP_ID = "app-1";

const pendingDoc = (id: string, documentType: string) => ({
  id,
  applicationId: APP_ID,
  documentType,
  processedAt: null,
  verificationNotes: null,
});
const processedDoc = (id: string, documentType: string) => ({
  ...pendingDoc(id, documentType),
  processedAt: new Date("2025-01-01T00:00:00Z"),
});

beforeEach(() => vi.clearAllMocks());

describe("kyc.review document gate (W12.1)", () => {
  it("blocks approval while documents are pending verification (PRECONDITION_FAILED)", async () => {
    const { db } = makeDb([pendingDoc("d1", "cac_certificate"), processedDoc("d2", "passport")]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(ADMIN);
    await expect(caller.review({ applicationId: APP_ID, decision: "approved" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("the failure message names the pending document types", async () => {
    const { db } = makeDb([pendingDoc("d1", "cac_certificate"), pendingDoc("d3", "utility_bill")]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(ADMIN);
    await expect(caller.review({ applicationId: APP_ID, decision: "approved" })).rejects.toThrow(
      /cac_certificate.*utility_bill|utility_bill.*cac_certificate/,
    );
  });

  it("waivePendingDocuments=true approves and records the waiver on docs and reviewNotes", async () => {
    const { db, updates } = makeDb([pendingDoc("d1", "cac_certificate"), processedDoc("d2", "passport")]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(ADMIN);
    const r = await caller.review({
      applicationId: APP_ID,
      decision: "approved",
      notes: "looks fine",
      waivePendingDocuments: true,
    });
    expect(r.ok).toBe(true);
    // One update per pending doc (waiver note) + one application update.
    expect(updates.length).toBe(2);
    expect(updates[0].set.verificationNotes).toContain("[doc-waiver]");
    expect(updates[0].set.verificationNotes).toContain("Root Admin");
    expect(updates[1].set.status).toBe("approved");
    expect(updates[1].set.reviewNotes).toContain("[doc-waiver]");
    expect(updates[1].set.reviewNotes).toContain("looks fine");
  });

  it("approves without a waiver when every document is fully processed", async () => {
    const { db, updates } = makeDb([processedDoc("d1", "cac_certificate"), processedDoc("d2", "passport")]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(ADMIN);
    const r = await caller.review({ applicationId: APP_ID, decision: "approved" });
    expect(r.ok).toBe(true);
    expect(updates.length).toBe(1);
    expect(updates[0].set.status).toBe("approved");
  });

  it("rejection is not blocked by pending documents", async () => {
    const { db, updates } = makeDb([pendingDoc("d1", "cac_certificate")]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = kycRouter.createCaller(ADMIN);
    const r = await caller.review({ applicationId: APP_ID, decision: "rejected", rejectionReason: "blurry scan" });
    expect(r.ok).toBe(true);
    expect(updates.length).toBe(1);
    expect(updates[0].set.status).toBe("rejected");
  });
});

describe("kyc.review admin gate", () => {
  it("rejects non-admin reviewers before touching the db", async () => {
    const caller = kycRouter.createCaller({ user: { id: 2, role: "user", tenantId: "t-1" } } as any);
    await expect(caller.review({ applicationId: APP_ID, decision: "approved" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(vi.mocked(getDb)).not.toHaveBeenCalled();
  });
});
