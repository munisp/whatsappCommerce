import { describe, it, expect } from "vitest";
import { riderToken, verifyRiderToken, riderUrlFor } from "./services/riderToken";
import { generateTrackingToken } from "./services/trackingToken";

describe("rider links", () => {
  it("a rider token opens only the order it was made for", () => {
    expect(verifyRiderToken(riderToken("order-1"))).toBe("order-1");
    expect(verifyRiderToken(riderToken("order-1").replace("order-1", "order-2"))).toBeNull();
  });
  it("the customer's tracking link is not a rider link", () => {
    expect(verifyRiderToken(generateTrackingToken("order-1"))).toBeNull();
  });
  it("junk is refused", () => {
    for (const t of ["", "abc", "order-1.", ".sig", 42, null, "x".repeat(300)]) expect(verifyRiderToken(t as any)).toBeNull();
  });
  it("the link opens the /deliver page", () => {
    expect(riderUrlFor("order-1")).toMatch(/\/deliver\/order-1\.[A-Za-z0-9_-]{32}$/);
  });
});
