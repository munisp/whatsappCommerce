/**
 * server/stepUpAdminPhone.test.ts — resolveTenantAdminPhone (services/stepUp.ts).
 *
 * QA follow-up: the fallback path used to grab ANY user whose users.tenantId
 * matched the tenant, no role check at all — so the first non-owner staff
 * member to link a phone (analyst, catalog, anyone) silently became the
 * recipient of every step-up OTP for the tenant, including the one gating
 * membership.add's "owner" grant. Fixed to only use that fallback for a
 * tenant with zero tenant_memberships rows (a legacy solo merchant); a
 * structured tenant with no owner phone on file must fail closed instead of
 * falling through to a staff member's phone.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { tenantMemberships, users } from "../drizzle/schema";

type Row = Record<string, unknown>;

let membershipRows: Row[] = [];
let userRows: Row[] = [];

function matches(row: Row, cond: any): boolean {
  if (!cond) return true;
  if (cond.__op === "eq") return row[cond.col] === cond.val;
  if (cond.__op === "and") return cond.conds.every((c: any) => matches(row, c));
  return true;
}

function makeChain(rows: Row[]) {
  let filtered = rows;
  const chain: any = {
    where(cond: any) {
      filtered = rows.filter((r) => matches(r, cond));
      return chain;
    },
    limit(n: number) {
      filtered = filtered.slice(0, n);
      return chain;
    },
    catch(fn: (e: unknown) => unknown) {
      return Promise.resolve(filtered).catch(fn);
    },
    then(resolve: (v: Row[]) => void, reject?: (e: unknown) => void) {
      return Promise.resolve(filtered).then(resolve, reject);
    },
  };
  return chain;
}

vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...orig,
    eq: (col: { name: string }, val: unknown) => ({ __op: "eq" as const, col: col.name, val }),
    and: (...conds: unknown[]) => ({ __op: "and" as const, conds }),
  };
});

const fakeDb = {
  select: (_fields?: unknown) => ({
    from: (table: unknown) => {
      if (table === tenantMemberships) return makeChain(membershipRows);
      if (table === users) return makeChain(userRows);
      return makeChain([]);
    },
  }),
} as any;

beforeEach(() => {
  membershipRows = [];
  userRows = [];
});

const { resolveTenantAdminPhone } = await import("./services/stepUp");

describe("resolveTenantAdminPhone", () => {
  it("uses the owner-role member's phone when one exists", async () => {
    membershipRows = [{ id: "m1", tenantId: "t1", userId: "1", role: "owner" }];
    userRows = [{ id: 1, phone: "+2348000000001" }];
    expect(await resolveTenantAdminPhone(fakeDb, "t1")).toBe("+2348000000001");
  });

  it("structured tenant, no owner phone on file: fails closed — never falls through to a staff member's phone", async () => {
    membershipRows = [
      { id: "m1", tenantId: "t1", userId: "1", role: "owner" }, // owner, no phone
      { id: "m2", tenantId: "t1", userId: "2", role: "analyst" },
    ];
    userRows = [
      { id: 1, phone: null, tenantId: "t1" }, // owner has no phone
      { id: 2, phone: "+2348000000002", tenantId: "t1" }, // analyst DOES have a phone — must NOT be used
    ];
    expect(await resolveTenantAdminPhone(fakeDb, "t1")).toBeNull();
  });

  it("legacy tenant with zero membership rows: falls back to any tenantId-matching user's phone", async () => {
    membershipRows = []; // no formal staff structure at all
    userRows = [{ id: 9, phone: "+2348000000009", tenantId: "t1" }];
    expect(await resolveTenantAdminPhone(fakeDb, "t1")).toBe("+2348000000009");
  });

  it("no membership rows and no phone anywhere: fails closed", async () => {
    membershipRows = [];
    userRows = [];
    expect(await resolveTenantAdminPhone(fakeDb, "t1")).toBeNull();
  });
});
