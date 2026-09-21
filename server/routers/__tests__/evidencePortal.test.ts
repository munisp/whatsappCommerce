/**
 * QA follow-up (found while building the section-8 role×functionality
 * matrix): listTokens and revokeToken had NO tenant-ownership check at all.
 * listTokens returned the raw bearer token — the sole secret that
 * authorizes a buyer to submit dispute evidence — for ANY tenant's dispute
 * to ANY authenticated user who supplied that disputeId; revokeToken could
 * invalidate any tenant's token the same way. Both now load the token's/
 * dispute's own row and verify it belongs to the caller's tenant first,
 * matching the pattern their sibling listSubmissions already used correctly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../../db";
import { evidencePortalRouter } from "../evidencePortal";
import { escrowDisputes, disputeEvidenceTokens } from "../../../drizzle/schema";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const DISPUTE_A = "dispute-belongs-to-a";
const TOKEN_A = "a".repeat(64); // shape of a real 32-byte hex token

const USER_A = { user: { id: 1, role: "user", tenantId: TENANT_A } } as any;
const USER_B = { user: { id: 2, role: "user", tenantId: TENANT_B } } as any;

/** Per-table-aware select mock: resolves differently depending on .from(table). */
function makeDb(opts: { disputeRows: any[]; tokenRows: any[] }) {
  const updateSpy = vi.fn();
  const db: any = {
    select: vi.fn(() => {
      const chain: any = {};
      chain.from = vi.fn((table: any) => {
        chain._table = table;
        return chain;
      });
      chain.where = vi.fn(() => chain);
      chain.then = (res: any, rej: any) => {
        const rows = chain._table === escrowDisputes ? opts.disputeRows : opts.tokenRows;
        return Promise.resolve(rows).then(res, rej);
      };
      return chain;
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn((...args: any[]) => {
          updateSpy(...args);
          return Promise.resolve([]);
        }),
      })),
    })),
  };
  return { db, updateSpy };
}

beforeEach(() => vi.clearAllMocks());

describe("evidencePortal.listTokens — cross-tenant token disclosure closed", () => {
  it("tenant B cannot read tenant A's dispute evidence tokens (disputeId belongs to A)", async () => {
    const { db } = makeDb({
      disputeRows: [], // B's tenantId filter finds nothing — dispute belongs to A, not B
      tokenRows: [{ token: TOKEN_A, disputeId: DISPUTE_A }],
    });
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = evidencePortalRouter.createCaller(USER_B);
    await expect(caller.listTokens({ disputeId: DISPUTE_A })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("tenant A can read its own dispute's tokens", async () => {
    const { db } = makeDb({
      disputeRows: [{ id: DISPUTE_A, tenantId: TENANT_A }],
      tokenRows: [{ token: TOKEN_A, disputeId: DISPUTE_A }],
    });
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = evidencePortalRouter.createCaller(USER_A);
    const r = await caller.listTokens({ disputeId: DISPUTE_A });
    expect(r).toEqual([{ token: TOKEN_A, disputeId: DISPUTE_A }]);
  });
});

describe("evidencePortal.revokeToken — cross-tenant revocation closed", () => {
  it("tenant B cannot revoke tenant A's token (owning dispute belongs to A)", async () => {
    const { db, updateSpy } = makeDb({
      disputeRows: [], // B's tenantId filter finds nothing for A's dispute
      tokenRows: [{ token: TOKEN_A, disputeId: DISPUTE_A }],
    });
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = evidencePortalRouter.createCaller(USER_B);
    await expect(caller.revokeToken({ token: TOKEN_A })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("tenant A can revoke its own dispute's token", async () => {
    const { db, updateSpy } = makeDb({
      disputeRows: [{ id: DISPUTE_A, tenantId: TENANT_A }],
      tokenRows: [{ token: TOKEN_A, disputeId: DISPUTE_A }],
    });
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = evidencePortalRouter.createCaller(USER_A);
    const r = await caller.revokeToken({ token: TOKEN_A });
    expect(r).toEqual({ success: true });
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("tenantless authenticated user rejected before any lookup", async () => {
    const { db, updateSpy } = makeDb({ disputeRows: [], tokenRows: [] });
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = evidencePortalRouter.createCaller({ user: { id: 9, role: "user", tenantId: null } } as any);
    await expect(caller.revokeToken({ token: TOKEN_A })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
