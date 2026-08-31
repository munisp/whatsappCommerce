/**
 * W33 ai-qa-forecast (Coder B) — financeQa canonical intent matching
 * (deterministic keyword fallback; must answer without any LLM key) +
 * migration-independent pure behavior. DB-backed answers are covered by
 * journeys J209–J211 (real PGlite queries).
 */
import { describe, it, expect } from "vitest";
import { matchFinanceIntent, FINANCE_INTENTS } from "./financeQa";

describe("financeQa.matchFinanceIntent — 6 canonical intents", () => {
  it("has exactly 6 canonical intents", () => {
    expect(FINANCE_INTENTS).toHaveLength(6);
  });

  it("bills due this week → bills_due", () => {
    expect(matchFinanceIntent("bills due this week")?.intent).toBe("bills_due");
    expect(matchFinanceIntent("What bills are due?")?.intent).toBe("bills_due");
    expect(matchFinanceIntent("any upcoming bills to pay")?.intent).toBe("bills_due");
  });

  it("who do I owe most → top_creditor", () => {
    expect(matchFinanceIntent("who do I owe most")?.intent).toBe("top_creditor");
    expect(matchFinanceIntent("biggest supplier debt?")?.intent).toBe("top_creditor");
  });

  it("invoice paid? → invoice_paid (with number extraction)", () => {
    const m = matchFinanceIntent("has invoice 12 been paid?");
    expect(m?.intent).toBe("invoice_paid");
    expect(m?.invoiceNo).toBe(12);
    expect(matchFinanceIntent("invoice paid?")?.intent).toBe("invoice_paid");
    expect(matchFinanceIntent("invoice #7 paid")?.invoiceNo).toBe(7);
  });

  it("expected inflows → expected_inflows", () => {
    expect(matchFinanceIntent("expected inflows")?.intent).toBe("expected_inflows");
    expect(matchFinanceIntent("what money is coming in this month")?.intent).toBe("expected_inflows");
  });

  it("who owes me most → top_debtor", () => {
    expect(matchFinanceIntent("who owes me most")?.intent).toBe("top_debtor");
    expect(matchFinanceIntent("biggest unpaid invoice?")?.intent).toBe("top_debtor");
  });

  it("cash forecast → cash_forecast", () => {
    expect(matchFinanceIntent("cash forecast please")?.intent).toBe("cash_forecast");
    expect(matchFinanceIntent("will I run out of money?")?.intent).toBe("cash_forecast");
    expect(matchFinanceIntent("any cashflow shortfall coming?")?.intent).toBe("cash_forecast");
  });

  it("non-finance chat falls through (null)", () => {
    expect(matchFinanceIntent("hello")).toBeNull();
    expect(matchFinanceIntent("menu")).toBeNull();
    expect(matchFinanceIntent("track my order")).toBeNull();
    expect(matchFinanceIntent("I want to buy rice")).toBeNull();
  });

  it("matching works with no LLM key configured (pure function, no env)", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.LLM_API_KEY;
    for (const [text, intent] of [
      ["bills due this week", "bills_due"],
      ["who do I owe most", "top_creditor"],
      ["invoice 3 paid?", "invoice_paid"],
      ["expected inflows", "expected_inflows"],
      ["who owes me most", "top_debtor"],
      ["cash forecast", "cash_forecast"],
    ] as const) {
      expect(matchFinanceIntent(text)?.intent).toBe(intent);
    }
  });
});
