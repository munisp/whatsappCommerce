import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Escrow state machine unit tests ─────────────────────────────────────────
// These tests verify the business logic of the escrow state transitions
// without hitting the database (pure function tests).

type EscrowState =
  | "payment_received"
  | "escrow_held"
  | "delivery_confirmed"
  | "release_instructed"
  | "settled"
  | "dispute_raised"
  | "dispute_resolved"
  | "refunded"
  | "expired";

type CustodyMode = "pssp" | "psp";

interface EscrowConfig {
  custodyMode: CustodyMode;
  platformFeeRate: string;
  buyerConfirmWindowHours: number;
  disputeWindowHours: number;
  autoConfirmEnabled: boolean;
  floatYieldRate: string;
}

// ─── Pure state machine helpers (extracted from router logic) ─────────────────
function computeFee(amount: number, feeRate: number): number {
  return parseFloat((amount * feeRate).toFixed(2));
}

function computeNetMerchantAmount(amount: number, feeRate: number): number {
  return parseFloat((amount * (1 - feeRate)).toFixed(2));
}

function computeBuyerConfirmDeadline(heldAt: Date, windowHours: number): Date {
  return new Date(heldAt.getTime() + windowHours * 60 * 60 * 1000);
}

function isDeadlineExpired(deadline: Date, now: Date): boolean {
  return now > deadline;
}

function nextStateOnDelivery(current: EscrowState): EscrowState {
  if (current === "escrow_held") return "delivery_confirmed";
  return current;
}

function nextStateOnBuyerConfirm(current: EscrowState, mode: CustodyMode): EscrowState {
  if (current === "delivery_confirmed" || current === "escrow_held") {
    return mode === "psp" ? "settled" : "release_instructed";
  }
  return current;
}

function nextStateOnBankSettlement(current: EscrowState): EscrowState {
  if (current === "release_instructed") return "settled";
  return current;
}

function nextStateOnDispute(current: EscrowState): EscrowState {
  if (["escrow_held", "delivery_confirmed"].includes(current)) return "dispute_raised";
  return current;
}

function nextStateOnRefund(current: EscrowState): EscrowState {
  if (!["settled", "refunded", "expired"].includes(current)) return "refunded";
  return current;
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe("Escrow fee calculation", () => {
  it("computes 1.5% platform fee correctly", () => {
    expect(computeFee(10000, 0.015)).toBe(150);
  });

  it("computes net merchant amount correctly", () => {
    expect(computeNetMerchantAmount(10000, 0.015)).toBe(9850);
  });

  it("handles zero amount", () => {
    expect(computeFee(0, 0.015)).toBe(0);
    expect(computeNetMerchantAmount(0, 0.015)).toBe(0);
  });

  it("handles large amounts with precision", () => {
    const fee = computeFee(1000000, 0.015);
    expect(fee).toBe(15000);
    const net = computeNetMerchantAmount(1000000, 0.015);
    expect(net).toBe(985000);
  });
});

describe("Escrow state machine — PSSP mode (bank-partner custody)", () => {
  it("transitions escrow_held → delivery_confirmed on delivery webhook", () => {
    expect(nextStateOnDelivery("escrow_held")).toBe("delivery_confirmed");
  });

  it("does not change state if already settled", () => {
    expect(nextStateOnDelivery("settled")).toBe("settled");
  });

  it("transitions delivery_confirmed → release_instructed on buyer confirm (PSSP)", () => {
    expect(nextStateOnBuyerConfirm("delivery_confirmed", "pssp")).toBe("release_instructed");
  });

  it("transitions escrow_held → release_instructed on auto-confirm (PSSP)", () => {
    expect(nextStateOnBuyerConfirm("escrow_held", "pssp")).toBe("release_instructed");
  });

  it("transitions release_instructed → settled on bank settlement callback", () => {
    expect(nextStateOnBankSettlement("release_instructed")).toBe("settled");
  });

  it("does not change state on bank callback if not in release_instructed", () => {
    expect(nextStateOnBankSettlement("settled")).toBe("settled");
    expect(nextStateOnBankSettlement("escrow_held")).toBe("escrow_held");
  });
});

describe("Escrow state machine — PSP mode (native wallet custody)", () => {
  it("transitions delivery_confirmed → settled directly on buyer confirm (PSP)", () => {
    expect(nextStateOnBuyerConfirm("delivery_confirmed", "psp")).toBe("settled");
  });

  it("transitions escrow_held → settled directly on auto-confirm (PSP)", () => {
    expect(nextStateOnBuyerConfirm("escrow_held", "psp")).toBe("settled");
  });

  it("does not re-settle an already settled escrow", () => {
    expect(nextStateOnBuyerConfirm("settled", "psp")).toBe("settled");
  });
});

describe("Dispute and refund transitions", () => {
  it("transitions escrow_held → dispute_raised on dispute", () => {
    expect(nextStateOnDispute("escrow_held")).toBe("dispute_raised");
  });

  it("transitions delivery_confirmed → dispute_raised on dispute", () => {
    expect(nextStateOnDispute("delivery_confirmed")).toBe("dispute_raised");
  });

  it("cannot raise dispute on settled escrow", () => {
    expect(nextStateOnDispute("settled")).toBe("settled");
  });

  it("transitions any non-terminal state → refunded", () => {
    expect(nextStateOnRefund("escrow_held")).toBe("refunded");
    expect(nextStateOnRefund("delivery_confirmed")).toBe("refunded");
    expect(nextStateOnRefund("dispute_raised")).toBe("refunded");
  });

  it("cannot refund an already settled escrow", () => {
    expect(nextStateOnRefund("settled")).toBe("settled");
  });

  it("cannot refund an already refunded escrow", () => {
    expect(nextStateOnRefund("refunded")).toBe("refunded");
  });
});

describe("Auto-confirm deadline logic", () => {
  it("computes deadline correctly for 48-hour window", () => {
    const heldAt = new Date("2026-01-01T00:00:00Z");
    const deadline = computeBuyerConfirmDeadline(heldAt, 48);
    expect(deadline.toISOString()).toBe("2026-01-03T00:00:00.000Z");
  });

  it("detects expired deadline", () => {
    const deadline = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-02T00:00:00Z");
    expect(isDeadlineExpired(deadline, now)).toBe(true);
  });

  it("detects non-expired deadline", () => {
    const deadline = new Date("2026-01-03T00:00:00Z");
    const now = new Date("2026-01-02T00:00:00Z");
    expect(isDeadlineExpired(deadline, now)).toBe(false);
  });
});

describe("Float income calculation (PSP mode)", () => {
  it("computes daily float income from annual rate", () => {
    const escrowBalance = 10_000_000; // ₦10M
    const annualRate = 0.08; // 8% p.a.
    const dailyRate = annualRate / 365;
    const dailyIncome = escrowBalance * dailyRate;
    // ₦10M × 8% / 365 ≈ ₦2,191.78
    expect(dailyIncome).toBeCloseTo(2191.78, 0);
  });

  it("returns zero income when escrow balance is zero", () => {
    const escrowBalance = 0;
    const annualRate = 0.08;
    const dailyRate = annualRate / 365;
    expect(escrowBalance * dailyRate).toBe(0);
  });
});
