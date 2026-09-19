// === W47 stakeholders ===
/**
 * w47stakeholders.test.ts — ONB-S-6/S-7 capability-gate hardening:
 *  - lookup ERROR fails CLOSED (no legacy shortcut fallback during a DB
 *    wobble) for assertCapabilityAccess AND assertMoneyAccess;
 *  - once a tenant has ANY membership row, the legacy users.tenantId /
 *    memberships shortcuts no longer pass;
 *  - a tenant with no staff rows keeps the legacy behavior;
 *  - scoped roles stay scoped (finance ≠ catalog).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...orig,
    eq: (col: { name: string }, val: unknown) => ({ __op: "eq" as const, col: col.name, val }),
    and: (...conds: unknown[]) => ({ __op: "and" as const, conds }),
  };
});

const getDbMock = vi.fn();
vi.mock("./db", () => ({ getDb: (...args: unknown[]) => getDbMock(...args) }));

import { assertCapabilityAccess } from "./services/capabilities";
import { assertMoneyAccess } from "./_core/trpc";

type Row = { id: string; tenantId: string; userId: string; role: string };
let store: Row[] = [];
let broken = false;

function evalCond(row: Row, cond: any): boolean {
  if (!cond) return true;
  if (cond.__op === "eq") return (row as any)[cond.col] === cond.val;
  if (cond.__op === "and") return cond.conds.every((c: any) => evalCond(row, c));
  return true;
}

const fakeDb = {
  select: () => ({
    from: () => ({
      where: (cond: any) => {
        if (broken) throw new Error("simulated DB wobble");
        const matched = store.filter((r) => evalCond(r, cond));
        return { limit: async (n: number) => matched.slice(0, n) };
      },
    }),
  }),
} as any;

beforeEach(() => {
  store = [];
  broken = false;
  getDbMock.mockResolvedValue(fakeDb);
});

const user = (over: Partial<{ id: number; role: string; tenantId: string | null; memberships: string[] | null }> = {}) => ({
  id: 42, role: "user", tenantId: null, memberships: null, ...over,
});

describe("ONB-S-6/S-7: capability gates fail closed + legacy shortcut tightening", () => {
  it("denies the legacy users.tenantId shortcut once the tenant has staff rows", async () => {
    store.push({ id: "m1", tenantId: "t1", userId: "7", role: "owner" });
    void 0;
    await expect(assertCapabilityAccess(user({ tenantId: "t1" }), "t1", "finance"))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    void 0;
    await expect(assertMoneyAccess(user({ tenantId: "t1" }), "t1"))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails CLOSED on membership lookup error (no legacy fallback)", async () => {
    store.push({ id: "m1", tenantId: "t1", userId: "7", role: "owner" });
    broken = true;
    void 0;
    await expect(assertCapabilityAccess(user({ tenantId: "t1" }), "t1", "finance"))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/fail closed/i) });
    void 0;
    await expect(assertMoneyAccess(user({ tenantId: "t1" }), "t1"))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps legacy shortcuts for tenants with NO staff rows", async () => {
    void 0;
    await expect(assertCapabilityAccess(user({ tenantId: "t9" }), "t9", "catalog")).resolves.toBeUndefined();
    void 0;
    await expect(assertMoneyAccess(user({ memberships: ["t9"] }), "t9")).resolves.toBeUndefined();
  });

  it("scoped roles stay scoped (finance passes finance, never catalog)", async () => {
    store.push({ id: "m1", tenantId: "t1", userId: "42", role: "finance" });
    void 0;
    await expect(assertCapabilityAccess(user(), "t1", "finance")).resolves.toBeUndefined();
    await expect(assertCapabilityAccess(user(), "t1", "catalog"))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
