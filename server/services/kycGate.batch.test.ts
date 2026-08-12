/**
 * W12.1 — approvedKybTenantIds batch KYB lookup (kycGate).
 *
 * The procurement directory used to run one hasApprovedKyb query per
 * supplier row (N round-trips per directory page). The batch variant must:
 *  - issue ONE query for the whole page (inArray over kycApplications);
 *  - dedupe repeated tenant ids before querying;
 *  - return exactly the tenants with an approved KYB application;
 *  - exclude pending/rejected applications and non-KYB types;
 *  - fail closed (empty set) when the query errors;
 *  - short-circuit on empty input without touching the db.
 */
import { describe, it, expect, vi } from "vitest";
import { approvedKybTenantIds } from "./kycGate";

function makeDb(rows: any[] | Error) {
  const where = vi.fn(() =>
    rows instanceof Error
      ? Promise.reject(rows)
      : Promise.resolve(rows),
  );
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as any, select, from, where };
}

const approved = (tenantId: string) => ({ tenantId, type: "kyb", status: "approved" });

describe("approvedKybTenantIds (W12.1 batch)", () => {
  it("returns an empty set for empty input without querying the db", async () => {
    const { db, select } = makeDb([]);
    const r = await approvedKybTenantIds(db, []);
    expect(r.size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });

  it("issues exactly ONE query for a whole directory page", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `t-${i}`);
    const { db, select } = makeDb(ids.map(approved));
    const r = await approvedKybTenantIds(db, ids);
    expect(select).toHaveBeenCalledTimes(1);
    expect(r.size).toBe(25);
  });

  it("returns exactly the tenants with an approved KYB application", async () => {
    const { db } = makeDb([approved("t-a"), approved("t-c")]);
    const r = await approvedKybTenantIds(db, ["t-a", "t-b", "t-c"]);
    expect([...r].sort()).toEqual(["t-a", "t-c"]);
  });

  it("excludes pending/rejected applications and non-KYB types even if rows leak through", async () => {
    const { db } = makeDb([
      approved("t-ok"),
      { tenantId: "t-pending", type: "kyb", status: "pending" },
      { tenantId: "t-rejected", type: "kyb", status: "rejected" },
      { tenantId: "t-kyc", type: "kyc", status: "approved" },
    ]);
    const r = await approvedKybTenantIds(db, ["t-ok", "t-pending", "t-rejected", "t-kyc"]);
    expect([...r]).toEqual(["t-ok"]);
  });

  it("fails closed to an empty set when the query errors", async () => {
    const { db } = makeDb(new Error("connection reset"));
    const r = await approvedKybTenantIds(db, ["t-a", "t-b"]);
    expect(r.size).toBe(0);
  });
});
