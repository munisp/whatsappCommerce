// === W56 credit ===
/**
 * creditServicing unit tests — pure reschedule math (sum invariant, integer
 * cents, rescheduled stamps), input validation, and ×8 catalog coverage of
 * the servicing notice keys. End-to-end DB behavior (future-only fee
 * semantics, approval gate, dunning-respects-grace, WA+TG notify) is proven
 * by journeys J574–J578 against the embedded PG world.
 */
import { describe, expect, it } from "vitest";
import {
  buildReplacementSchedule,
  unpaidTotals,
  ServicingError,
  GRACE_MAX_DAYS,
  MAX_FEE_BPS,
  type ServicingScheduleEntry,
} from "./creditServicing";
import { SUPPORTED_LOCALES, t27 } from "./i18n";

const unpaid: ServicingScheduleEntry[] = [
  { seq: 2, dueAt: "2026-03-01T00:00:00.000Z", amountCents: 33_334, principalCents: 33_333, feeCents: 1, status: "due", paidAt: null },
  { seq: 3, dueAt: "2026-04-01T00:00:00.000Z", amountCents: 33_334, principalCents: 33_334, feeCents: 0, status: "overdue", paidAt: null },
];

describe("buildReplacementSchedule", () => {
  it("preserves the principal sum exactly (integer cents, no rounding loss)", () => {
    const total = unpaid.reduce((a, e) => a + e.principalCents, 0); // 66_667
    // 3-way split with a remainder riding the last slice.
    const per = Math.floor(total / 3);
    const slices = [
      { dueAt: "2026-05-01", principalCents: per, feeCents: 500 },
      { dueAt: "2026-06-01", principalCents: per, feeCents: 500 },
      { dueAt: "2026-07-01", principalCents: total - 2 * per, feeCents: 500 },
    ];
    const out = buildReplacementSchedule(1, unpaid, slices);
    expect(out.reduce((a, e) => a + e.principalCents, 0)).toBe(total);
    expect(out.every((e) => Number.isInteger(e.amountCents) && Number.isInteger(e.feeCents))).toBe(true);
    expect(out.map((e) => e.seq)).toEqual([2, 3, 4]); // continues after 1 paid slice
    expect(out.every((e) => e.rescheduled === true && e.status === "due" && e.paidAt === null)).toBe(true);
    expect(out[0].previousDueAt).toBe(unpaid[0].dueAt);
    expect(out[0].previousAmountCents).toBe(unpaid[0].amountCents);
    expect(out[2].previousDueAt).toBeNull(); // more slices than before
    // Fee delta is explicit: 1500 new vs 1 old.
    const delta = out.reduce((a, e) => a + e.feeCents, 0) - unpaid.reduce((a, e) => a + e.feeCents, 0);
    expect(delta).toBe(1_499);
  });

  it("refuses any principal drift (sum invariant)", () => {
    expect(() =>
      buildReplacementSchedule(0, unpaid, [
        { dueAt: "2026-05-01", principalCents: 66_668, feeCents: 0 },
      ]),
    ).toThrowError(ServicingError);
    expect(() =>
      buildReplacementSchedule(0, unpaid, [
        { dueAt: "2026-05-01", principalCents: 66_666, feeCents: 0 },
      ]),
    ).toThrowError(/principal sum invariant/);
  });

  it("shrinking to one slice works when the sum matches", () => {
    const out = buildReplacementSchedule(2, unpaid, [
      { dueAt: "2026-05-01", principalCents: 66_667, feeCents: 1 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].seq).toBe(3);
    expect(out[0].amountCents).toBe(66_668);
  });
});

describe("unpaidTotals", () => {
  it("sums only unpaid slices (paid slices excluded)", () => {
    const schedule: ServicingScheduleEntry[] = [
      { seq: 1, dueAt: "2026-02-01T00:00:00.000Z", amountCents: 33_333, principalCents: 33_333, feeCents: 0, status: "paid", paidAt: "2026-02-01T00:00:00.000Z" },
      ...unpaid,
    ];
    const t = unpaidTotals(schedule);
    expect(t.count).toBe(2);
    expect(t.principalCents).toBe(66_667);
    expect(t.amountCents).toBe(66_668);
    expect(t.feeCents).toBe(1);
  });
});

describe("servicing bounds + i18n", () => {
  it("bounds constants stay sane", () => {
    expect(GRACE_MAX_DAYS).toBe(90);
    expect(MAX_FEE_BPS).toBe(10_000);
  });

  it("servicing notice keys render in all 8 locales", () => {
    for (const key of ["creditFeeAdjusted", "creditRescheduled", "creditGraceExtended"] as const) {
      for (const locale of SUPPORTED_LOCALES) {
        const rendered = t27(locale, key, { oldBps: 150, newBps: 250, reason: "r", count: 2, delta: "1.00", days: 7 });
        expect(rendered.length).toBeGreaterThan(0);
        expect(rendered).not.toContain("{reason}"); // interpolation landed
      }
    }
  });
});
// === END W56 credit ===
