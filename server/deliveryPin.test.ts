/**
 * Delivery PIN — unit tests
 * PIN generation format + the accept/reject/admin-bypass gate.
 */
import { describe, it, expect } from "vitest";
import { generateDeliveryPin, checkDeliveryPin } from "./routers/logistics";

describe("generateDeliveryPin", () => {
  it("generates a 4-digit PIN", () => {
    for (let i = 0; i < 50; i++) {
      const pin = generateDeliveryPin();
      expect(pin).toMatch(/^\d{4}$/);
      expect(Number(pin)).toBeGreaterThanOrEqual(1000);
      expect(Number(pin)).toBeLessThanOrEqual(9999);
    }
  });
});

describe("checkDeliveryPin", () => {
  it("accepts a matching PIN", () => {
    expect(() =>
      checkDeliveryPin({ deliveryPin: "1910", providedPin: "1910", isAdmin: false }),
    ).not.toThrow();
  });

  it("rejects a wrong PIN", () => {
    expect(() =>
      checkDeliveryPin({ deliveryPin: "1910", providedPin: "0000", isAdmin: false }),
    ).toThrowError(/delivery PIN/i);
  });

  it("rejects a missing PIN when one is set", () => {
    expect(() =>
      checkDeliveryPin({ deliveryPin: "1910", providedPin: null, isAdmin: false }),
    ).toThrowError(/delivery PIN/i);
  });

  it("lets admins bypass the PIN (dashboard simulate override)", () => {
    expect(() =>
      checkDeliveryPin({ deliveryPin: "1910", providedPin: null, isAdmin: true }),
    ).not.toThrow();
  });

  it("requires nothing when the shipment has no PIN", () => {
    expect(() =>
      checkDeliveryPin({ deliveryPin: null, providedPin: null, isAdmin: false }),
    ).not.toThrow();
  });
});
