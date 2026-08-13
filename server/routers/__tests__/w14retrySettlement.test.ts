/**
 * W14 router — tradeCredit.retrySettlement (adminProcedure).
 *
 * Platform-ops re-attempt of a charge-success/settle-fail repayment.
 * Admin-only: non-admin callers (and the unauthenticated) get FORBIDDEN.
 * The mutation delegates to services/tradeCredit/capture.retrySettlement
 * (exactly-once: double invocation settles at most once).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../../db";
import { tradeCreditRouter } from "../tradeCredit";
import { makeFakeDb, seedAccount, seedDraw } from "../../services/tradeCredit/fakeDb";
import type { LedgerRow } from "../../services/tradeCredit/fakeDb";

const ADMIN = { user: { id: "u-admin", role: "admin", tenantId: null } } as any;
const NON_ADMIN = { user: { id: "u-user", role: "user", tenantId: "buyer-1" } } as any;
const UNAUTHENTICATED = { user: null } as any;

const REF = "cr-acct-1-20250310-000001";

function retryMarker(accountId: string, amountCents: number): LedgerRow {
  return {
    id: "marker-1",
    creditAccountId: accountId,
    kind: "adjustment",
    amountCents: 0,
    poId: null,
    dueDate: null,
    status: "posted",
    ref: REF,
    note: `[settlement_retry] {"amountCents":${amountCents}}`,
    createdAt: new Date("2025-03-10T12:00:00Z"),
  };
}

function useDb() {
  const account = seedAccount({ id: "acct-1", outstandingCents: 10_000 });
  const draw = seedDraw("acct-1", { amountCents: 10_000 });
  const { db, store } = makeFakeDb({
    accounts: [account],
    ledger: [draw, retryMarker("acct-1", 4_000)],
  });
  (getDb as any).mockResolvedValue(db);
  return { db, store };
}

beforeEach(() => vi.clearAllMocks());

describe("tradeCredit.retrySettlement", () => {
  it("admin settles a pending charge-success/settle-fail repayment", async () => {
    const { store } = useDb();
    const caller = tradeCreditRouter.createCaller(ADMIN);
    const res = await caller.retrySettlement({ accountId: "acct-1", reference: REF });
    expect(res).toMatchObject({ ok: true, status: "settled", reference: REF, outstandingAfter: 6_000 });
    expect(store.accounts[0].outstandingCents).toBe(6_000);
    expect(store.ledger.filter((l) => l.kind === "repayment")).toHaveLength(1);
  });

  it("exactly-once via the router: a second invocation is an already_settled no-op", async () => {
    const { store } = useDb();
    const caller = tradeCreditRouter.createCaller(ADMIN);
    await caller.retrySettlement({ accountId: "acct-1", reference: REF });
    const again = await caller.retrySettlement({ accountId: "acct-1", reference: REF });
    expect(again.status).toBe("already_settled");
    expect(store.ledger.filter((l) => l.kind === "repayment")).toHaveLength(1);
    expect(store.accounts[0].outstandingCents).toBe(6_000);
  });

  it("non-admin callers are rejected with FORBIDDEN", async () => {
    useDb();
    const caller = tradeCreditRouter.createCaller(NON_ADMIN);
    await expect(
      caller.retrySettlement({ accountId: "acct-1", reference: REF }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("unauthenticated callers are rejected with FORBIDDEN", async () => {
    useDb();
    const caller = tradeCreditRouter.createCaller(UNAUTHENTICATED);
    await expect(
      caller.retrySettlement({ accountId: "acct-1", reference: REF }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
