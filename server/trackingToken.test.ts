/**
 * Tracking token — unit tests
 * Round-trip generation/verification + wrong-token rejection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generateTrackingToken,
  verifyTrackingToken,
  trackingUrlFor,
} from "./services/trackingToken";

describe("tracking tokens", () => {
  beforeEach(() => vi.stubEnv("TRACKING_SECRET", "test-secret"));
  afterEach(() => vi.unstubAllEnvs());

  it("round-trips a generated token", () => {
    const token = generateTrackingToken("order-abc-123");
    expect(verifyTrackingToken(token)).toBe("order-abc-123");
  });

  it("rejects a tampered order id", () => {
    const token = generateTrackingToken("order-abc-123");
    const tampered = token.replace("order-abc-123", "order-xyz-999");
    expect(verifyTrackingToken(tampered)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = generateTrackingToken("order-abc-123");
    vi.stubEnv("TRACKING_SECRET", "other-secret");
    expect(verifyTrackingToken(token)).toBeNull();
  });

  it("rejects garbage tokens", () => {
    expect(verifyTrackingToken("")).toBeNull();
    expect(verifyTrackingToken("no-separator")).toBeNull();
    expect(verifyTrackingToken("order.")).toBeNull();
    expect(verifyTrackingToken(".sig")).toBeNull();
    expect(verifyTrackingToken("order.short-but-wrong")).toBeNull();
  });

  it("builds tracking URLs from APP_URL without hardcoding a domain", () => {
    vi.stubEnv("APP_URL", "https://shop.example.com/");
    const url = trackingUrlFor("order-1");
    expect(url.startsWith("https://shop.example.com/track/order-1.")).toBe(true);
    expect(verifyTrackingToken(url.split("/track/")[1])).toBe("order-1");
  });
});
