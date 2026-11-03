import { describe, expect, it } from "vitest";
import { featureForPath, featureVisible } from "../shared/featureRollout";

describe("featureVisible", () => {
  it("shows a feature nobody has decided on, so existing shops lose nothing", () => {
    expect(featureVisible("/orders", undefined, undefined)).toBe(true);
  });
  it("hides an off feature from everyone, even an opted-in shop", () => {
    expect(featureVisible("/orders", "off", undefined)).toBe(false);
    expect(featureVisible("/orders", "off", true)).toBe(false);
  });
  it("shows a selected feature only to opted-in shops", () => {
    expect(featureVisible("/orders", "selected", undefined)).toBe(false);
    expect(featureVisible("/orders", "selected", false)).toBe(false);
    expect(featureVisible("/orders", "selected", true)).toBe(true);
  });
  it("shows an all-shops feature unless a shop is opted out", () => {
    expect(featureVisible("/orders", "all", undefined)).toBe(true);
    expect(featureVisible("/orders", "all", false)).toBe(false);
  });
  it("never hides an always-on feature", () => {
    expect(featureVisible("/portal", "off", false)).toBe(true);
  });
});

describe("featureForPath", () => {
  const keys = ["/portal", "/portal/wallet", "/orders"];
  it("matches a feature and its sub-pages, preferring the most specific", () => {
    expect(featureForPath("/orders", keys)).toBe("/orders");
    expect(featureForPath("/orders/12", keys)).toBe("/orders");
    expect(featureForPath("/portal/wallet/topup", keys)).toBe("/portal/wallet");
  });
  it("doesn't confuse a path that only shares a prefix", () => {
    expect(featureForPath("/orders-archive", keys)).toBeNull();
  });
});
