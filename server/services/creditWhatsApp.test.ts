/**
 * W27 credit — WhatsApp CREDIT command parsing + admin-phone resolution
 * (pure parts; the db-backed handler runs end-to-end in journey J138).
 */
import { describe, it, expect } from "vitest";
import { parseCreditCommand, resolveAdminPhone } from "./creditWhatsApp";

describe("parseCreditCommand", () => {
  it("parses bare CREDIT as score", () => {
    expect(parseCreditCommand("credit")).toEqual({ cmd: "score" });
    expect(parseCreditCommand("CREDIT SCORE")).toEqual({ cmd: "score" });
  });
  it("parses OFFERS / STATUS", () => {
    expect(parseCreditCommand("CREDIT OFFERS")).toEqual({ cmd: "offers" });
    expect(parseCreditCommand("credit status")).toEqual({ cmd: "status" });
  });
  it("parses ACCEPT with and without an amount", () => {
    expect(parseCreditCommand("CREDIT ACCEPT")).toEqual({ cmd: "accept", amountMajor: null });
    expect(parseCreditCommand("credit accept 50000")).toEqual({ cmd: "accept", amountMajor: 50000 });
    expect(parseCreditCommand("CREDIT ACCEPT 1234.50")).toEqual({ cmd: "accept", amountMajor: 1234.5 });
  });
  it("ignores non-credit text and lookalikes", () => {
    expect(parseCreditCommand("hello")).toBeNull();
    expect(parseCreditCommand("creditor report")).toBeNull();
    expect(parseCreditCommand("CREDITFOO")).toBeNull();
  });
});

describe("resolveAdminPhone", () => {
  it("follows the chatDispute resolution chain", () => {
    expect(resolveAdminPhone({ adminPhone: "2348000000001" })).toBe("2348000000001");
    expect(resolveAdminPhone({ whatsapp: { adminPhone: "2348000000002" } })).toBe("2348000000002");
    expect(resolveAdminPhone({ notifications: { adminPhone: "2348000000003" } })).toBe("2348000000003");
    expect(resolveAdminPhone({})).toBeNull();
    expect(resolveAdminPhone(null)).toBeNull();
    expect(resolveAdminPhone({ adminPhone: "  " })).toBeNull();
  });
});
