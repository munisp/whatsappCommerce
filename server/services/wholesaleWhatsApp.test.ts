/**
 * W27 wholesaleWhatsApp — pure command-parser unit tests (hermetic).
 */
import { describe, it, expect } from "vitest";
import { parseWholesaleCommand } from "./wholesaleWhatsApp";

describe("parseWholesaleCommand", () => {
  it("parses browse variants", () => {
    expect(parseWholesaleCommand("wholesale")).toEqual({ kind: "browse" });
    expect(parseWholesaleCommand("Wholesale rice")).toEqual({ kind: "browse", query: "rice" });
    expect(parseWholesaleCommand("  WHOLESALE   palm oil 25l ")).toEqual({ kind: "browse", query: "palm oil 25l" });
  });

  it("parses buy with menu index + quantity", () => {
    expect(parseWholesaleCommand("buy 1 100")).toEqual({ kind: "buy", index: 1, quantity: 100 });
    expect(parseWholesaleCommand("buy 2 x50")).toEqual({ kind: "buy", index: 2, quantity: 50 });
    expect(parseWholesaleCommand("buy 2 x 50")).toEqual({ kind: "buy", index: 2, quantity: 50 });
  });

  it("parses deals list and deal progress", () => {
    expect(parseWholesaleCommand("deals")).toEqual({ kind: "deals" });
    expect(parseWholesaleCommand("group deals")).toEqual({ kind: "deals" });
    expect(parseWholesaleCommand("deal ab12cd34")).toEqual({ kind: "dealProgress", dealRef: "ab12cd34" });
  });

  it("parses join with deal ref + quantity", () => {
    expect(parseWholesaleCommand("join ab12cd34 5")).toEqual({ kind: "join", dealRef: "ab12cd34", quantity: 5 });
    expect(parseWholesaleCommand("JOIN AB12CD34 x5")).toEqual({ kind: "join", dealRef: "ab12cd34", quantity: 5 });
  });

  it("returns null for unrelated messages", () => {
    expect(parseWholesaleCommand("hello")).toBeNull();
    expect(parseWholesaleCommand("order status")).toBeNull();
    expect(parseWholesaleCommand("buy")).toBeNull();
    expect(parseWholesaleCommand("join")).toBeNull();
    expect(parseWholesaleCommand("wholesalee")).toBeNull();
  });
});
