/**
 * Unit tests for the pure B2B frontend logic (client/src/lib/b2bLogic.ts).
 * Node environment, no React — covers status mapping, MOQ validation,
 * payment-mode enablement, aging bucketing, limit-gauge math and form
 * validation for the wave-8 supply-chain credit network UI.
 */
import { describe, expect, it } from "vitest";
import {
  agingBucketFor,
  computeAging,
  countPendingApprovals,
  creditFitForPo,
  dueCountdown,
  formatNaira,
  ledgerKindMeta,
  limitGauge,
  nextDueFromLedger,
  poPaymentModes,
  poStatusMeta,
  poSubtotal,
  summarizeCreditAccounts,
  validateLimitForm,
  validateMoq,
  validatePoLines,
} from "./b2bLogic";

describe("formatNaira", () => {
  it("formats numbers as NGN currency", () => {
    const out = formatNaira(1234.5);
    expect(out).toContain("₦");
    expect(out).toContain("1,234.50");
  });

  it("handles nullish and non-numeric input as ₦0.00", () => {
    expect(formatNaira(undefined)).toBe("₦0.00");
    expect(formatNaira(null)).toBe("₦0.00");
    expect(formatNaira("not-a-number")).toBe("₦0.00");
  });

  it("accepts numeric strings", () => {
    expect(formatNaira("2500")).toContain("2,500.00");
  });
});

describe("poStatusMeta", () => {
  it("maps known statuses to muted labels/classes", () => {
    expect(poStatusMeta("pending_approval").label).toBe("Pending approval");
    expect(poStatusMeta("pending_approval").className).toContain("amber");
    expect(poStatusMeta("approved").className).toContain("emerald");
    expect(poStatusMeta("rejected").className).toContain("red");
    // Muted outline style — never saturated solid backgrounds
    for (const s of ["draft", "pending_approval", "approved", "rejected", "invoiced", "paid", "fulfilled", "cancelled"] as const) {
      expect(poStatusMeta(s).className).not.toMatch(/bg-(red|green|amber|blue)-[5-9]00(?!\d)/);
    }
  });

  it("falls back gracefully for unknown statuses", () => {
    const meta = poStatusMeta("partially_received");
    expect(meta.label).toBe("partially received");
    expect(meta.className).toContain("muted-foreground");
  });
});

describe("ledgerKindMeta", () => {
  it("maps kinds and falls back for unknown", () => {
    expect(ledgerKindMeta("invoice_draw").label).toBe("Invoice draw");
    expect(ledgerKindMeta("repayment").className).toContain("emerald");
    expect(ledgerKindMeta("mystery").label).toBe("mystery");
  });
});

describe("validateMoq", () => {
  it("passes when subtotal meets or exceeds the MOQ", () => {
    expect(validateMoq(50_000, 50_000).ok).toBe(true);
    expect(validateMoq(60_000, 50_000).ok).toBe(true);
  });

  it("fails below the MOQ with the exact shortfall", () => {
    const r = validateMoq(30_000, 50_000);
    expect(r.ok).toBe(false);
    expect(r.shortfall).toBe(20_000);
    expect(r.reason).toContain("minimum order");
  });

  it("always passes when no MOQ is set", () => {
    expect(validateMoq(0, 0).ok).toBe(true);
    expect(validateMoq(0, undefined).ok).toBe(true);
    expect(validateMoq(5, null).ok).toBe(true);
  });
});

describe("poPaymentModes", () => {
  it("disables credit with a reason when there is no account", () => {
    const modes = poPaymentModes(null);
    const credit = modes.find((m) => m.mode === "credit")!;
    expect(credit.enabled).toBe(false);
    expect(credit.disabledReason).toContain("No credit account");
    expect(modes.find((m) => m.mode === "paynow")!.enabled).toBe(true);
  });

  it("disables credit when the account is frozen", () => {
    const credit = poPaymentModes({ status: "frozen" }).find((m) => m.mode === "credit")!;
    expect(credit.enabled).toBe(false);
    expect(credit.disabledReason).toContain("frozen");
  });

  it("enables credit with net-N label for active accounts", () => {
    const credit = poPaymentModes({ status: "active" }, 14).find((m) => m.mode === "credit")!;
    expect(credit.enabled).toBe(true);
    expect(credit.disabledReason).toBeNull();
    expect(credit.label).toBe("Pay on credit (net 14d)");
  });
});

describe("aging buckets", () => {
  it("buckets by days past due at the backend bucketForDraw boundaries", () => {
    expect(agingBucketFor(-5)).toBe("current");
    expect(agingBucketFor(0)).toBe("current");
    expect(agingBucketFor(1)).toBe("days1to30");
    expect(agingBucketFor(30)).toBe("days1to30");
    expect(agingBucketFor(31)).toBe("days31to60");
    expect(agingBucketFor(60)).toBe("days31to60");
    expect(agingBucketFor(61)).toBe("days61to90");
    expect(agingBucketFor(90)).toBe("days61to90");
    expect(agingBucketFor(91)).toBe("days90plus");
  });

  it("computeAging splits debits across buckets", () => {
    const now = new Date("2026-03-15T12:00:00Z");
    const buckets = computeAging(
      [
        { kind: "invoice_draw", amount: 1000, dueDate: "2026-03-20T00:00:00Z" }, // not yet due → current
        { kind: "invoice_draw", amount: 500, dueDate: "2026-03-10T00:00:00Z" },  // 5d past → days1to30
        { kind: "invoice_draw", amount: 250, dueDate: "2026-02-01T00:00:00Z" },  // 42d past → days31to60
        { kind: "invoice_draw", amount: 100, dueDate: "2025-11-01T00:00:00Z" },  // 134d past → days90plus
        { kind: "invoice_draw", amount: 300, dueDate: null },                    // no due date → current
      ],
      now,
    );
    expect(buckets).toEqual({ current: 1300, days1to30: 500, days31to60: 250, days61to90: 0, days90plus: 100 });
  });
});

describe("nextDueFromLedger", () => {
  it("returns the earliest unsettled debit due date", () => {
    expect(
      nextDueFromLedger([
        { kind: "invoice_draw", dueDate: "2026-05-01", status: "posted" },
        { kind: "invoice_draw", dueDate: "2026-04-01", status: "posted" },
        { kind: "invoice_draw", dueDate: "2026-03-01", status: "settled" }, // settled — ignored
        { kind: "repayment", dueDate: "2026-02-01", status: "posted" },     // repayments don't age
        { kind: "adjustment", dueDate: null, status: "posted" },
      ]),
    ).toBe("2026-04-01");
  });

  it("returns null when nothing is due", () => {
    expect(nextDueFromLedger([])).toBeNull();
    expect(nextDueFromLedger([{ kind: "invoice_draw", dueDate: null, status: "posted" }])).toBeNull();
  });
});

describe("limitGauge", () => {
  it("computes clamped utilization with tones", () => {
    expect(limitGauge(0, 0)).toMatchObject({ pct: 0, tone: "ok", available: 0 });
    expect(limitGauge(500, 1000)).toMatchObject({ pct: 50, tone: "ok", available: 500 });
    expect(limitGauge(700, 1000).tone).toBe("warn");
    expect(limitGauge(900, 1000).tone).toBe("danger");
    expect(limitGauge(1500, 1000)).toMatchObject({ pct: 100, tone: "danger", available: 0 });
  });

  it("treats a zero limit with usage as fully utilized", () => {
    expect(limitGauge(100, 0)).toMatchObject({ pct: 100, tone: "danger" });
  });
});

describe("creditFitForPo", () => {
  it("classifies no-account / frozen / within / over", () => {
    expect(creditFitForPo(null, 100).status).toBe("no-account");
    expect(creditFitForPo({ status: "frozen", limit: 1000, outstanding: 0 }, 100).status).toBe("frozen");
    expect(
      creditFitForPo({ status: "active", limit: 10_000, outstanding: 4_000 }, 6_000).status,
    ).toBe("within-limit");
    expect(
      creditFitForPo({ status: "active", limit: 10_000, outstanding: 4_000 }, 6_001).status,
    ).toBe("over-limit");
  });
});

describe("dueCountdown", () => {
  const now = new Date("2026-03-15T12:00:00Z");
  it("labels overdue, today, soon and later", () => {
    expect(dueCountdown("2026-03-10T00:00:00Z", now)).toMatchObject({ days: -5, tone: "danger", label: "5d overdue" });
    expect(dueCountdown("2026-03-15T18:00:00Z", now)).toMatchObject({ days: 1, tone: "warn" });
    expect(dueCountdown("2026-03-22T00:00:00Z", now).tone).toBe("warn");
    expect(dueCountdown("2026-04-01T00:00:00Z", now).tone).toBe("ok");
  });

  it("handles missing/invalid dates", () => {
    expect(dueCountdown(null, now).tone).toBe("none");
    expect(dueCountdown("junk", now).tone).toBe("none");
  });
});

describe("validateLimitForm", () => {
  it("accepts sane limits and terms", () => {
    expect(validateLimitForm({ limit: "500000", termsDays: "30" })).toEqual({});
    expect(validateLimitForm({ limit: "0", termsDays: "1" })).toEqual({});
  });

  it("rejects bad limits", () => {
    expect(validateLimitForm({ limit: "", termsDays: "30" }).limit).toBeTruthy();
    expect(validateLimitForm({ limit: "-5", termsDays: "30" }).limit).toBeTruthy();
    expect(validateLimitForm({ limit: "abc", termsDays: "30" }).limit).toBeTruthy();
    expect(validateLimitForm({ limit: "999999999", termsDays: "30" }).limit).toBeTruthy();
  });

  it("rejects bad terms", () => {
    expect(validateLimitForm({ limit: "100", termsDays: "0" }).termsDays).toBeTruthy();
    expect(validateLimitForm({ limit: "100", termsDays: "1.5" }).termsDays).toBeTruthy();
    expect(validateLimitForm({ limit: "100", termsDays: "-1" }).termsDays).toBeTruthy();
    expect(validateLimitForm({ limit: "100", termsDays: "91" }).termsDays).toBeTruthy();
  });
});

describe("PO lines", () => {
  it("validatePoLines requires at least one valid line", () => {
    expect(validatePoLines([])).toContain("at least one");
    expect(validatePoLines([{ name: "Rice", quantity: 0, unitPrice: 100 }])).toContain("quantity");
    expect(validatePoLines([{ name: " ", quantity: 1, unitPrice: 100 }])).toContain("name");
    expect(validatePoLines([{ name: "Rice", quantity: 2, unitPrice: 1500 }])).toBeNull();
  });

  it("poSubtotal sums quantity × price", () => {
    expect(poSubtotal([{ quantity: 2, unitPrice: 1500 }, { quantity: 1, unitPrice: 500 }])).toBe(3500);
    expect(poSubtotal([])).toBe(0);
  });
});

describe("dashboard derivations", () => {
  it("summarizeCreditAccounts totals, utilization and earliest due date", () => {
    const s = summarizeCreditAccounts([
      { outstanding: 4000, limit: 10_000, nextDueDate: "2026-04-01", status: "active" },
      { outstanding: 1000, limit: 10_000, nextDueDate: "2026-03-20", status: "active" },
      { outstanding: 9000, limit: 10_000, nextDueDate: null, status: "closed" }, // excluded
    ]);
    expect(s.totalOutstanding).toBe(5000);
    expect(s.totalLimit).toBe(20_000);
    expect(s.utilizationPct).toBe(25);
    expect(s.nextDueDate).toBe("2026-03-20");
    expect(s.accountCount).toBe(2);
  });

  it("countPendingApprovals counts only pending_approval", () => {
    expect(countPendingApprovals([
      { status: "pending_approval" },
      { status: "approved" },
      { status: "pending_approval" },
    ])).toBe(2);
    expect(countPendingApprovals([])).toBe(0);
  });
});
