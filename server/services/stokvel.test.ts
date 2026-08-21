import { describe, expect, it } from "vitest";
import { cyclePoolCents, generateMemberToken, payoutPositionForCycle, verifyMemberToken } from "./stokvel";

describe("stokvel rotation (pure)", () => {
  it("payout position rotates deterministically", () => {
    expect(payoutPositionForCycle(3, 0)).toBe(0);
    expect(payoutPositionForCycle(3, 1)).toBe(1);
    expect(payoutPositionForCycle(3, 2)).toBe(2);
    expect(payoutPositionForCycle(3, 3)).toBe(0); // wraps
    expect(payoutPositionForCycle(5, 7)).toBe(2);
  });
  it("rejects empty circles", () => {
    expect(() => payoutPositionForCycle(0, 0)).toThrow();
  });
  it("pool is the exact sum of paid contributions (integer cents)", () => {
    expect(cyclePoolCents([50_000, 50_000, 50_000])).toBe(150_000);
    expect(cyclePoolCents([])).toBe(0);
    expect(cyclePoolCents([1, 2, 3])).toBe(6);
  });
});

describe("stokvel member tokens", () => {
  it("round-trips and rejects tampering", () => {
    const t = generateMemberToken("member-123");
    expect(verifyMemberToken(t)).toBe("member-123");
    expect(verifyMemberToken(`${t}x`)).toBeNull();
    expect(verifyMemberToken("member-123." + "A".repeat(24))).toBeNull();
    expect(verifyMemberToken("no-dot")).toBeNull();
    expect(verifyMemberToken(t.replace("member-123", "member-999"))).toBeNull();
  });
});
