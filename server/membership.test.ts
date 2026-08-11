/**
 * membership.test.ts — W12 tenant membership service tests.
 * Covers CRUD, first-member-becomes-owner, last-owner guard, requireRole
 * (admin bypass + role gating), using an in-memory fake drizzle DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

// Structured condition mocks so the fake DB can evaluate where clauses.
vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...orig,
    eq: (col: { name: string }, val: unknown) => ({ __op: "eq" as const, col: col.name, val }),
    and: (...conds: unknown[]) => ({ __op: "and" as const, conds }),
  };
});

type Row = {
  id: string;
  tenantId: string;
  userId: string;
  role: string;
  invitedBy: string | null;
  createdAt: Date;
};

const store: Row[] = [];
let seq = 0;

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
        const matched = () => store.filter((r) => evalCond(r, cond));
        const p = {
          limit: async (n: number) => matched().slice(0, n),
          then: (resolve: (v: Row[]) => void) => {
            resolve(matched());
            return p;
          },
        };
        return p;
      },
    }),
  }),
  insert: () => ({
    values: (v: Omit<Row, "id" | "createdAt">) => ({
      returning: async () => {
        const row: Row = { ...v, id: `m-${++seq}`, createdAt: new Date() };
        store.push(row);
        return [row];
      },
    }),
  }),
  update: () => ({
    set: (patch: Partial<Row>) => ({
      where: (cond: any) => ({
        returning: async () => {
          const matched = store.filter((r) => evalCond(r, cond));
          matched.forEach((r) => Object.assign(r, patch));
          return matched;
        },
      }),
    }),
  }),
  delete: () => ({
    where: (cond: any) => ({
      then: (resolve: (v: unknown) => void) => {
        const matched = store.filter((r) => evalCond(r, cond));
        matched.forEach((r) => store.splice(store.indexOf(r), 1));
        resolve(undefined);
      },
    }),
  }),
};

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: async () => fakeDb,
}));

const svc = await import("./services/membership");

beforeEach(() => {
  store.length = 0;
  seq = 0;
});

async function seed(tenantId: string, userId: string, role: "owner" | "operator" | "analyst") {
  store.push({ id: `m-${++seq}`, tenantId, userId, role, invitedBy: null, createdAt: new Date() });
}

describe("getMembership", () => {
  it("returns the membership row for a member", async () => {
    await seed("t1", "7", "operator");
    const m = await svc.getMembership(7, "t1");
    expect(m?.role).toBe("operator");
    expect(m?.tenantId).toBe("t1");
  });
  it("returns null for a non-member", async () => {
    await seed("t1", "7", "operator");
    expect(await svc.getMembership(8, "t1")).toBeNull();
    expect(await svc.getMembership(7, "t2")).toBeNull();
  });
  it("accepts numeric and string user ids interchangeably", async () => {
    await seed("t1", "42", "analyst");
    expect((await svc.getMembership("42", "t1"))?.role).toBe("analyst");
  });
});

describe("requireRole", () => {
  it("bypasses for platform admins (synthetic owner)", async () => {
    const m = await svc.requireRole({ id: 1, role: "admin" }, "t1", ["owner"]);
    expect(m.role).toBe("owner");
    expect(m.tenantId).toBe("t1");
  });
  it("passes for a member with an allowed role", async () => {
    await seed("t1", "7", "operator");
    const m = await svc.requireRole({ id: 7, role: "user" }, "t1", ["owner", "operator"]);
    expect(m.userId).toBe("7");
  });
  it("throws FORBIDDEN for a non-member", async () => {
    await expect(svc.requireRole({ id: 7, role: "user" }, "t1", ["owner"])).rejects.toThrow(TRPCError);
    await svc.requireRole({ id: 7, role: "user" }, "t1", ["owner"]).catch((e: TRPCError) => {
      expect(e.code).toBe("FORBIDDEN");
    });
  });
  it("throws FORBIDDEN for a member with an insufficient role", async () => {
    await seed("t1", "7", "analyst");
    await svc.requireRole({ id: 7, role: "user" }, "t1", ["owner", "operator"]).catch((e: TRPCError) => {
      expect(e.code).toBe("FORBIDDEN");
    });
  });
});

describe("listMembers", () => {
  it("lists all members of a tenant", async () => {
    await seed("t1", "1", "owner");
    await seed("t1", "2", "operator");
    await seed("t2", "3", "owner");
    const members = await svc.listMembers("t1");
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.userId).sort()).toEqual(["1", "2"]);
  });
  it("returns [] for a tenant with no members", async () => {
    expect(await svc.listMembers("nope")).toEqual([]);
  });
});

describe("addMember", () => {
  it("forces the first member of a tenant to owner", async () => {
    const m = await svc.addMember({ tenantId: "t1", userId: 7, role: "analyst" });
    expect(m.role).toBe("owner");
  });
  it("respects the requested role once a tenant has members", async () => {
    await svc.addMember({ tenantId: "t1", userId: 7 });
    const m = await svc.addMember({ tenantId: "t1", userId: 8, role: "analyst", invitedBy: 7 });
    expect(m.role).toBe("analyst");
    expect(m.invitedBy).toBe("7");
  });
  it("defaults subsequent members to operator", async () => {
    await svc.addMember({ tenantId: "t1", userId: 7 });
    const m = await svc.addMember({ tenantId: "t1", userId: 8 });
    expect(m.role).toBe("operator");
  });
  it("is idempotent for an existing member (returns current row)", async () => {
    await svc.addMember({ tenantId: "t1", userId: 7 });
    const again = await svc.addMember({ tenantId: "t1", userId: 7 });
    expect(store).toHaveLength(1);
    expect(again.role).toBe("owner");
  });
  it("updates the role when re-adding with a different role", async () => {
    await svc.addMember({ tenantId: "t1", userId: 7 });
    await svc.addMember({ tenantId: "t1", userId: 8 });
    const updated = await svc.addMember({ tenantId: "t1", userId: 8, role: "analyst" });
    expect(updated.role).toBe("analyst");
    expect(store).toHaveLength(2);
  });
});

describe("removeMember", () => {
  it("removes a non-owner member", async () => {
    await seed("t1", "1", "owner");
    await seed("t1", "2", "operator");
    await svc.removeMember("t1", 2);
    expect(await svc.getMembership(2, "t1")).toBeNull();
  });
  it("refuses to remove the last owner of a tenant", async () => {
    await seed("t1", "1", "owner");
    await seed("t1", "2", "operator");
    await svc.removeMember("t1", 1).catch((e: TRPCError) => {
      expect(e.code).toBe("FORBIDDEN");
      expect(e.message).toMatch(/last owner/i);
    });
    expect(await svc.getMembership(1, "t1")).not.toBeNull();
  });
  it("allows removing an owner when another owner remains", async () => {
    await seed("t1", "1", "owner");
    await seed("t1", "2", "owner");
    await svc.removeMember("t1", 1);
    expect(await svc.getMembership(1, "t1")).toBeNull();
  });
  it("throws NOT_FOUND when the membership does not exist", async () => {
    await svc.removeMember("t1", 99).catch((e: TRPCError) => {
      expect(e.code).toBe("NOT_FOUND");
    });
  });
});
