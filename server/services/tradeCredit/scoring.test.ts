/**
 * suggestLimit / scoring — determinism, formula factors, cold start, reasons.
 */
import { describe, it, expect } from "vitest";
import {
  suggestLimitTx,
  formatNairaCompact,
  FLOOR_LIMIT_CENTS,
  CAP_LIMIT_CENTS,
  COLD_START_SCORE,
  VOLUME_TARGET_CENTS,
} from "./scoring";
import { makeFakeDb } from "./fakeDb";

const NOW = new Date("2025-06-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 864e5);

describe("formatNairaCompact", () => {
  it("formats millions, thousands and small amounts", () => {
    expect(formatNairaCompact(240_000_000)).toBe("₦2.4M");
    expect(formatNairaCompact(500_000_000)).toBe("₦5M");
    expect(formatNairaCompact(85_000_000)).toBe("₦850k");
    expect(formatNairaCompact(1_200_000)).toBe("₦12,000");
    expect(formatNairaCompact(0)).toBe("₦0");
  });
});

describe("suggestLimitTx", () => {
  it("cold start (no orders, no payments) → conservative floor and score", async () => {
    const { db } = makeFakeDb();
    const res = await suggestLimitTx(db, "buyer-new", "supplier-1", NOW);
    expect(res.score).toBe(COLD_START_SCORE);
    expect(res.suggestedLimitCents).toBe(FLOOR_LIMIT_CENTS);
    expect(res.reasons[0]).toContain("cold-start");
    expect(res.reasons).toHaveLength(3);
  });

  it("deterministic: same inputs → identical output", async () => {
    const seed = {
      orders: [
        { tenantId: "buyer-1", totalAmount: "10000.00", createdAt: daysAgo(5) },
        { tenantId: "buyer-1", totalAmount: "20000.00", createdAt: daysAgo(400) },
      ],
      payments: [
        { tenantId: "buyer-1", status: "completed", createdAt: daysAgo(10), paidAt: daysAgo(9) },
      ],
    };
    const a = await suggestLimitTx(makeFakeDb(seed).db, "buyer-1", "supplier-1", NOW);
    const b = await suggestLimitTx(makeFakeDb(seed).db, "buyer-1", "supplier-1", NOW);
    expect(a).toEqual(b);
  });

  it("perfect history: 100% on-time + target volume + 12m tenure → score 100", async () => {
    const { db } = makeFakeDb({
      orders: [
        { tenantId: "buyer-1", totalAmount: "5000000.00", createdAt: daysAgo(3) }, // ₦5M in 30d
        { tenantId: "buyer-1", totalAmount: "1.00", createdAt: daysAgo(365) }, // 12m tenure
      ],
      payments: [
        { tenantId: "buyer-1", status: "completed", createdAt: daysAgo(20), paidAt: new Date(daysAgo(20).getTime() + 3600e3) },
        { tenantId: "buyer-1", status: "completed", createdAt: daysAgo(10), paidAt: new Date(daysAgo(10).getTime() + 2 * 3600e3) },
      ],
    });
    const res = await suggestLimitTx(db, "buyer-1", "supplier-1", NOW);
    expect(res.score).toBe(100);
    expect(res.suggestedLimitCents).toBe(VOLUME_TARGET_CENTS);
    expect(res.reasons[0]).toBe("on-time rate 100%");
    expect(res.reasons[1]).toBe("₦5M 30-day volume");
    expect(res.reasons[2]).toBe("12 months tenure");
  });

  it("late payments lower the score vs on-time history (0.5 weight on on-time)", async () => {
    const mk = (onTime: boolean) => makeFakeDb({
      orders: [{ tenantId: "b", totalAmount: "1000000.00", createdAt: daysAgo(3) }],
      payments: [{
        tenantId: "b", status: "completed", createdAt: daysAgo(10),
        paidAt: new Date(daysAgo(10).getTime() + (onTime ? 3600e3 : 72 * 3600e3)),
      }],
    });
    const good = await suggestLimitTx(mk(true).db, "b", "s", NOW);
    const bad = await suggestLimitTx(mk(false).db, "b", "s", NOW);
    expect(good.score).toBeGreaterThan(bad.score);
    expect(bad.reasons[0]).toBe("on-time rate 0%");
    expect(good.suggestedLimitCents).toBeGreaterThan(bad.suggestedLimitCents);
  });

  it("no completed payments → neutral prior, noted in reasons", async () => {
    const { db } = makeFakeDb({
      orders: [{ tenantId: "b", totalAmount: "1000000.00", createdAt: daysAgo(3) }],
      payments: [{ tenantId: "b", status: "failed", createdAt: daysAgo(10), paidAt: null }],
    });
    const res = await suggestLimitTx(db, "b", "s", NOW);
    expect(res.reasons[0]).toContain("neutral");
    expect(res.score).toBeGreaterThan(0);
  });

  it("orders older than 30d count for tenure but not for 30-day volume", async () => {
    const { db } = makeFakeDb({
      orders: [{ tenantId: "b", totalAmount: "9000000.00", createdAt: daysAgo(420) }],
    });
    const res = await suggestLimitTx(db, "b", "s", NOW);
    expect(res.reasons[1]).toBe("₦0 30-day volume");
    expect(res.reasons[2]).toBe("14 months tenure");
    expect(res.suggestedLimitCents).toBe(FLOOR_LIMIT_CENTS); // volume 0 → floor
  });

  it("suggested limit is clamped at the cap for very large volume", async () => {
    const { db } = makeFakeDb({
      orders: [
        { tenantId: "b", totalAmount: "99999999.00", createdAt: daysAgo(2) },
        { tenantId: "b", totalAmount: "1.00", createdAt: daysAgo(800) },
      ],
      payments: [{ tenantId: "b", status: "completed", createdAt: daysAgo(5), paidAt: daysAgo(4) }],
    });
    const res = await suggestLimitTx(db, "b", "s", NOW);
    expect(res.suggestedLimitCents).toBeLessThanOrEqual(CAP_LIMIT_CENTS);
  });

  it("ignores other tenants' history (buyer scoping)", async () => {
    const { db } = makeFakeDb({
      orders: [{ tenantId: "someone-else", totalAmount: "5000000.00", createdAt: daysAgo(2) }],
      payments: [{ tenantId: "someone-else", status: "completed", createdAt: daysAgo(2), paidAt: daysAgo(1) }],
    });
    const res = await suggestLimitTx(db, "buyer-1", "supplier-1", NOW);
    expect(res.score).toBe(COLD_START_SCORE);
    expect(res.suggestedLimitCents).toBe(FLOOR_LIMIT_CENTS);
  });

  it("supplierTenantId does not change platform-wide scoring (documented)", async () => {
    const seed = {
      orders: [{ tenantId: "b", totalAmount: "1000000.00", createdAt: daysAgo(2) }],
    };
    const a = await suggestLimitTx(makeFakeDb(seed).db, "b", "supplier-A", NOW);
    const b = await suggestLimitTx(makeFakeDb(seed).db, "b", "supplier-B", NOW);
    expect(a).toEqual(b);
  });
});
