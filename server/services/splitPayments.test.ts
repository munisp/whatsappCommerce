/**
 * W41 (Coder B) — pure split-payment share math + contract shape. DB-backed
 * behavior (claim-first tally, no-negative race, timeout refunds) is covered
 * end-to-end by journeys J293–J299.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeShares } from "./splitPayments";

describe("computeShares", () => {
  it("splits evenly when divisible", () => {
    const parts = computeShares(30000, ["a", "b", "c"]);
    expect(parts.map((p) => p.shareCents)).toEqual([10000, 10000, 10000]);
    expect(parts.every((p) => p.paidCents === 0 && p.status === "pending")).toBe(true);
  });

  it("assigns the remainder kobo to the first participant so Σshares === target", () => {
    const parts = computeShares(10001, ["a", "b", "c"]);
    expect(parts.map((p) => p.shareCents)).toEqual([3335, 3333, 3333]);
    expect(parts.reduce((s, p) => s + p.shareCents, 0)).toBe(10001);
  });

  it("rejects non-positive / non-integer targets and empty participant lists", () => {
    expect(() => computeShares(0, ["a"])).toThrow();
    expect(() => computeShares(-5, ["a"])).toThrow();
    expect(() => computeShares(10.5, ["a"])).toThrow();
    expect(() => computeShares(1000, [])).toThrow();
  });
});

describe("binding contracts for Coders A/C (SPEC_W41 merger seam)", () => {
  const walletSrc = readFileSync(join(__dirname, "customerWallet.ts"), "utf8");
  it("exports creditWallet / debitWallet / walletBalance with the contracted signatures", () => {
    expect(walletSrc).toMatch(/export async function creditWallet\(\s*tenantId: string,\s*customerRef[\s\S]*amountCents: number,\s*reason: WalletCreditReason,\s*refId: string/);
    expect(walletSrc).toMatch(/export async function debitWallet\(\s*tenantId: string,\s*customerRef[\s\S]*amountCents: number,\s*reason: WalletDebitReason,\s*refId: string/);
    expect(walletSrc).toMatch(/export async function walletBalance\(\s*tenantId: string,\s*customerRef/);
  });
  it("refund-to-wallet respects the W38 cumulative cap vocabulary", () => {
    expect(walletSrc).toContain("refund_cap_exceeded");
    expect(walletSrc).toContain("'pending','approved','processed'");
    expect(walletSrc).toContain('method: "wallet"');
  });
  it("contains no stub markers", () => {
    expect(walletSrc).not.toContain("TEMP" + " STUB");
    expect(readFileSync(join(__dirname, "splitPayments.ts"), "utf8")).not.toContain("TEMP" + " STUB");
  });
});
