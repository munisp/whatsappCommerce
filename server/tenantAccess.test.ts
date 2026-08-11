/**
 * tenantAccess.test.ts — W12 assertTenantAccess membership fallback and
 * operatorProcedure / analystProcedure helper behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { TrpcContext } from "./_core/context";

// In-memory membership directory keyed `${userId}:${tenantId}`.
const directory = new Map<string, { role: "owner" | "operator" | "analyst" }>();

vi.mock("./services/membership", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./services/membership")>();
  return {
    ...orig,
    getMembership: async (userId: string | number, tenantId: string) => {
      const m = directory.get(`${userId}:${tenantId}`);
      return m
        ? { id: "x", tenantId, userId: String(userId), role: m.role, invitedBy: null, createdAt: new Date() }
        : null;
    },
  };
});

const { assertTenantAccess, operatorProcedure, analystProcedure, router } = await import("./_core/trpc");

beforeEach(() => directory.clear());

// ─── assertTenantAccess (sync; existing callers unchanged) ───────────────────
describe("assertTenantAccess", () => {
  it("passes synchronously for platform admins (unchanged behavior)", () => {
    expect(() => assertTenantAccess({ role: "admin", tenantId: null }, "t1")).not.toThrow();
  });
  it("passes synchronously when users.tenantId matches (unchanged behavior)", () => {
    expect(() => assertTenantAccess({ role: "user", tenantId: "t1" }, "t1")).not.toThrow();
  });
  it("passes for a member without users.tenantId (membership fallback)", () => {
    expect(() =>
      assertTenantAccess({ role: "user", tenantId: null, memberships: ["t1"] }, "t1"),
    ).not.toThrow();
  });
  it("passes for a member whose users.tenantId points at another tenant", () => {
    expect(() =>
      assertTenantAccess({ role: "operator", tenantId: "t0", memberships: ["t1", "t2"] }, "t2"),
    ).not.toThrow();
  });
  it("403s for a non-member with a different users.tenantId", () => {
    expect(() => assertTenantAccess({ role: "user", tenantId: "t9" }, "t1")).toThrowError(
      /own tenant/i,
    );
  });
  it("403s for a non-member without users.tenantId and no memberships", () => {
    expect(() => assertTenantAccess({ role: "user", tenantId: null }, "t1")).toThrowError(
      /own tenant/i,
    );
  });
  it("403s when memberships are present but do not include the tenant", () => {
    expect(() =>
      assertTenantAccess({ role: "user", tenantId: null, memberships: ["t2"] }, "t1"),
    ).toThrowError(/own tenant/i);
  });
  it("throws a TRPCError with code FORBIDDEN", () => {
    try {
      assertTenantAccess({ role: "user", tenantId: "t9" }, "t1");
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("FORBIDDEN");
    }
  });
});

// ─── operatorProcedure / analystProcedure ────────────────────────────────────
const testRouter = router({
  op: operatorProcedure.input(z.object({ tenantId: z.string() })).query(() => "op-ok"),
  an: analystProcedure.input(z.object({ tenantId: z.string() })).query(() => "an-ok"),
});

function ctxFor(user: { id: number; role: string } | null): TrpcContext {
  return {
    user: user as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    resolvedTenantId: "default",
  };
}

describe("operatorProcedure", () => {
  it("allows an owner member", async () => {
    directory.set("1:t1", { role: "owner" });
    await expect(testRouter.createCaller(ctxFor({ id: 1, role: "user" })).op({ tenantId: "t1" })).resolves.toBe("op-ok");
  });
  it("allows an operator member", async () => {
    directory.set("2:t1", { role: "operator" });
    await expect(testRouter.createCaller(ctxFor({ id: 2, role: "user" })).op({ tenantId: "t1" })).resolves.toBe("op-ok");
  });
  it("rejects an analyst member", async () => {
    directory.set("3:t1", { role: "analyst" });
    await expect(testRouter.createCaller(ctxFor({ id: 3, role: "user" })).op({ tenantId: "t1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("rejects a non-member", async () => {
    await expect(testRouter.createCaller(ctxFor({ id: 4, role: "user" })).op({ tenantId: "t1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("allows a platform admin without any membership", async () => {
    await expect(testRouter.createCaller(ctxFor({ id: 5, role: "admin" })).op({ tenantId: "t1" })).resolves.toBe("op-ok");
  });
  it("rejects unauthenticated callers", async () => {
    await expect(testRouter.createCaller(ctxFor(null)).op({ tenantId: "t1" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("analystProcedure", () => {
  it("allows an analyst member", async () => {
    directory.set("1:t1", { role: "analyst" });
    await expect(testRouter.createCaller(ctxFor({ id: 1, role: "user" })).an({ tenantId: "t1" })).resolves.toBe("an-ok");
  });
  it("allows owner and operator members", async () => {
    directory.set("2:t1", { role: "owner" });
    directory.set("3:t1", { role: "operator" });
    await expect(testRouter.createCaller(ctxFor({ id: 2, role: "user" })).an({ tenantId: "t1" })).resolves.toBe("an-ok");
    await expect(testRouter.createCaller(ctxFor({ id: 3, role: "user" })).an({ tenantId: "t1" })).resolves.toBe("an-ok");
  });
  it("rejects a non-member", async () => {
    await expect(testRouter.createCaller(ctxFor({ id: 4, role: "user" })).an({ tenantId: "t1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("allows a platform admin without any membership", async () => {
    await expect(testRouter.createCaller(ctxFor({ id: 5, role: "admin" })).an({ tenantId: "t1" })).resolves.toBe("an-ok");
  });
});
