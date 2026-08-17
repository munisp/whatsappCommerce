/**
 * W14 — creditEnforcement suspension-check posture.
 *
 * The trade-credit lookup error path is governed by CREDIT_ENFORCEMENT_STRICT
 * (server/_core/env.isCreditEnforcementStrict):
 *   - strict (default in production-like envs): FAIL-CLOSED — a lookup error
 *     blocks PO submission with a transient "credit status unavailable, try
 *     again" verdict (unavailable: true), so delinquent buyers cannot order
 *     through a lookup outage.
 *   - non-strict (default in dev/test): FAIL-OPEN — ordering stays available
 *     with a warn log (historical behavior).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const credit = vi.hoisted(() => ({
  isOrderAccessSuspended: vi.fn(async (_b: string, _s: string) => false),
  getCreditAccount: vi.fn(async () => null as any),
}));
vi.mock("../tradeCredit", () => credit);

import {
  checkOrderSuspension,
  CREDIT_STATUS_UNAVAILABLE_REASON,
} from "./creditEnforcement";

beforeEach(() => {
  vi.clearAllMocks();
  credit.isOrderAccessSuspended.mockResolvedValue(false);
  credit.getCreditAccount.mockResolvedValue(null);
  delete process.env.CREDIT_ENFORCEMENT_STRICT;
});
afterEach(() => {
  delete process.env.CREDIT_ENFORCEMENT_STRICT;
});

describe("checkOrderSuspension — strict mode (CREDIT_ENFORCEMENT_STRICT=true)", () => {
  it("fails CLOSED on lookup error: suspended + unavailable + try-again copy", async () => {
    process.env.CREDIT_ENFORCEMENT_STRICT = "true";
    credit.isOrderAccessSuspended.mockRejectedValue(new Error("db down"));
    const res = await checkOrderSuspension("buyer-1", "supplier-1");
    expect(res.suspended).toBe(true);
    expect(res.unavailable).toBe(true);
    expect(res.reason).toBe("credit status unavailable, try again");
    expect(res.reason).toBe(CREDIT_STATUS_UNAVAILABLE_REASON);
    expect(res.outstandingCents).toBeNull();
  });

  it("logs a warn when blocking fail-closed", async () => {
    process.env.CREDIT_ENFORCEMENT_STRICT = "true";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    credit.isOrderAccessSuspended.mockRejectedValue(new Error("db down"));
    await checkOrderSuspension("buyer-1", "supplier-1");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("fail-closed"),
      "db down",
    );
    warn.mockRestore();
  });

  it("still honors a real suspension verdict in strict mode", async () => {
    process.env.CREDIT_ENFORCEMENT_STRICT = "true";
    credit.isOrderAccessSuspended.mockResolvedValue(true);
    credit.getCreditAccount.mockResolvedValue({
      suspensionReason: "Overdue balance past 30 days",
      outstandingCents: 250_000,
    });
    const res = await checkOrderSuspension("buyer-1", "supplier-1");
    expect(res).toMatchObject({
      suspended: true,
      reason: "Overdue balance past 30 days",
      outstandingCents: 250_000,
    });
    expect(res.unavailable).toBeUndefined();
  });
});

describe("checkOrderSuspension — non-strict mode (dev/test default)", () => {
  it("fails OPEN on lookup error when the flag is unset (test env default)", async () => {
    credit.isOrderAccessSuspended.mockRejectedValue(new Error("db down"));
    const res = await checkOrderSuspension("buyer-1", "supplier-1");
    expect(res).toEqual({ suspended: false, reason: null, outstandingCents: null });
  });

  it("fails OPEN when explicitly disabled even though the lookup errors", async () => {
    process.env.CREDIT_ENFORCEMENT_STRICT = "false";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    credit.isOrderAccessSuspended.mockRejectedValue(new Error("db down"));
    const res = await checkOrderSuspension("buyer-1", "supplier-1");
    expect(res.suspended).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("fail-open"),
      "db down",
    );
    warn.mockRestore();
  });

  it("missing contract stays fail-open in BOTH modes (pre-merge safety)", async () => {
    process.env.CREDIT_ENFORCEMENT_STRICT = "true";
    const orig = credit.isOrderAccessSuspended;
    // @ts-expect-error simulate pre-merge module shape
    delete credit.isOrderAccessSuspended;
    try {
      const res = await checkOrderSuspension("buyer-1", "supplier-1");
      expect(res.suspended).toBe(false);
    } finally {
      credit.isOrderAccessSuspended = orig;
    }
  });
});
