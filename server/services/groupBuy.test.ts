/**
 * W27 groupBuy — pure progress-bar/formatting unit tests (hermetic).
 * DB resolution paths (join/confirm/expire/sweep) are covered by journeys
 * J148–J149 on real PGlite.
 */
import { describe, it, expect } from "vitest";
import { renderProgressBar, formatDealForWhatsApp, type GroupDealProgress } from "./groupBuy";

const base: GroupDealProgress = {
  dealId: "d1",
  status: "open",
  currentQty: 30,
  thresholdQty: 100,
  remainingQty: 70,
  percent: 30,
  bar: renderProgressBar(30),
  participantCount: 3,
  deadline: new Date("2030-01-01T00:00:00Z"),
  expired: false,
};

describe("renderProgressBar", () => {
  it("renders a 10-cell bar deterministically", () => {
    expect(renderProgressBar(0)).toBe("░░░░░░░░░░");
    expect(renderProgressBar(50)).toBe("█████░░░░░");
    expect(renderProgressBar(100)).toBe("██████████");
    expect(renderProgressBar(30)).toBe("███░░░░░░░");
  });
  it("clamps out-of-range percentages", () => {
    expect(renderProgressBar(-10)).toBe("░░░░░░░░░░");
    expect(renderProgressBar(250)).toBe("██████████");
  });
});

describe("formatDealForWhatsApp", () => {
  it("open deal shows remaining units and deadline", () => {
    const s = formatDealForWhatsApp(base, "Cooking oil 25L", 1_200_000, "NGN");
    expect(s).toContain("Cooking oil 25L");
    expect(s).toContain("30/100 units");
    expect(s).toContain("70 more unit(s)");
  });
  it("confirmed deal announces unlock; expired announces refunds", () => {
    const won = formatDealForWhatsApp({ ...base, status: "confirmed" }, "X", 100, "NGN");
    expect(won).toContain("UNLOCKED");
    const lost = formatDealForWhatsApp({ ...base, status: "expired" }, "X", 100, "NGN");
    expect(lost).toContain("refunded or voided");
  });
});
