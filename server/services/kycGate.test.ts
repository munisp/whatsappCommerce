/**
 * kycGate unit tests — pure core + thin db wrapper, no real database.
 *
 * The db wrapper is exercised against an in-memory fake (same philosophy as
 * services/tradeCredit/fakeDb.ts): the drizzle chain is honored and row
 * filtering happens in the pure evaluateKybRows core, so the fail-closed
 * semantics are provably exercised.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

const dbHolder = vi.hoisted(() => ({ db: null as any }));
vi.mock("../db", () => ({ getDb: vi.fn(async () => dbHolder.db) }));

import {
  evaluateKybRows,
  kycGateDisabledFor,
  makeKycGate,
  hasApprovedKyb,
  isKybApproved,
  requireApprovedKyb,
} from "./kycGate";

/** Minimal fake honoring the drizzle chain used by hasApprovedKyb. */
function fakeKycDb(rows: any[], opts: { throwOnQuery?: boolean } = {}) {
  const result = opts.throwOnQuery ? Promise.reject(new Error("db down")) : rows;
  const chain: any = {
    limit: () => chain,
    then: (res: (v: any) => any, rej?: (e: any) => any) =>
      Promise.resolve(result).then(res, rej),
    catch: (rej: (e: any) => any) => Promise.resolve(result).catch(rej),
  };
  return {
    select: () => ({ from: () => ({ where: () => chain }) }),
  };
}

const approved = { tenantId: "t-1", type: "kyb", status: "approved" };

beforeEach(() => {
  dbHolder.db = null;
});

describe("evaluateKybRows (pure core)", () => {
  it("true only for type=kyb + status=approved for the SAME tenant", () => {
    expect(evaluateKybRows([approved], "t-1")).toBe(true);
    expect(evaluateKybRows([{ ...approved, type: "kyc" }], "t-1")).toBe(false);
    expect(evaluateKybRows([{ ...approved, status: "pending" }], "t-1")).toBe(false);
    expect(evaluateKybRows([{ ...approved, status: "under_review" }], "t-1")).toBe(false);
    expect(evaluateKybRows([{ ...approved, status: "rejected" }], "t-1")).toBe(false);
    expect(evaluateKybRows([approved], "t-other")).toBe(false);
    expect(evaluateKybRows([], "t-1")).toBe(false);
  });
});

describe("kycGateDisabledFor (escape hatch)", () => {
  it("honored only in development/test with the explicit flag", () => {
    expect(kycGateDisabledFor("test", "true")).toBe(true);
    expect(kycGateDisabledFor("development", "true")).toBe(true);
  });
  it("ignored in production / staging / unset NODE_ENV (fail closed)", () => {
    expect(kycGateDisabledFor("production", "true")).toBe(false);
    expect(kycGateDisabledFor("staging", "true")).toBe(false);
    expect(kycGateDisabledFor(undefined, "true")).toBe(false);
    expect(kycGateDisabledFor("", "true")).toBe(false);
  });
  it("no effect without the flag", () => {
    expect(kycGateDisabledFor("test", undefined)).toBe(false);
    expect(kycGateDisabledFor("test", "false")).toBe(false);
    expect(kycGateDisabledFor("production", undefined)).toBe(false);
  });
});

describe("makeKycGate (injectable)", () => {
  it("requireApprovedKyb throws FORBIDDEN with a clear message when unapproved", async () => {
    const gate = makeKycGate(async () => false);
    const err = await gate.requireApprovedKyb("t-1").catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toContain("t-1");
    expect(err.message).toMatch(/KYB/);
  });
  it("passes when approved; isKybApproved reflects the reader", async () => {
    const gate = makeKycGate(async (tid) => tid === "t-ok");
    await expect(gate.requireApprovedKyb("t-ok")).resolves.toBeUndefined();
    expect(await gate.isKybApproved("t-ok")).toBe(true);
    expect(await gate.isKybApproved("t-no")).toBe(false);
  });
  it("disabled option bypasses the reader entirely", async () => {
    const reader = vi.fn(async () => false);
    const gate = makeKycGate(reader, { disabled: true });
    await expect(gate.requireApprovedKyb("t-no")).resolves.toBeUndefined();
    expect(await gate.isKybApproved("t-no")).toBe(true);
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("db-backed wrappers (fake db)", () => {
  it("hasApprovedKyb finds the approved KYB row", async () => {
    expect(await hasApprovedKyb(fakeKycDb([approved]) as any, "t-1")).toBe(true);
    expect(await hasApprovedKyb(fakeKycDb([]) as any, "t-1")).toBe(false);
  });
  it("query errors fail closed (false, not throw)", async () => {
    expect(await hasApprovedKyb(fakeKycDb([], { throwOnQuery: true }) as any, "t-1")).toBe(false);
  });
  it("isKybApproved fails closed when the db is unavailable", async () => {
    dbHolder.db = null;
    expect(await isKybApproved("t-1")).toBe(false);
    await expect(requireApprovedKyb("t-1")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("requireApprovedKyb resolves with an approved KYB via getDb", async () => {
    dbHolder.db = fakeKycDb([approved]);
    await expect(requireApprovedKyb("t-1")).resolves.toBeUndefined();
    await expect(requireApprovedKyb("t-2")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("KYC_GATE_DISABLED=true bypasses in test env", async () => {
    vi.stubEnv("KYC_GATE_DISABLED", "true");
    try {
      dbHolder.db = null; // even with no db at all
      expect(await isKybApproved("t-anything")).toBe(true);
      await expect(requireApprovedKyb("t-anything")).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
