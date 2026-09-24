/**
 * capabilities.test.ts — the shared role→capability map (shared/capabilities.ts),
 * the single source of truth both server/services/capabilities.ts and the
 * client's useCapability() hook read from.
 */
import { describe, it, expect } from "vitest";
import { ROLE_CAPABILITIES, roleHasCapability, membershipRoleEnum, type MembershipRole } from "../shared/capabilities";

describe("roleHasCapability", () => {
  it("owner holds every capability", () => {
    for (const cap of ["finance", "catalog", "orders", "reports"] as const) {
      expect(roleHasCapability("owner", cap)).toBe(true);
    }
  });

  it("operator holds finance (legacy compat), catalog and orders, but not reports", () => {
    expect(roleHasCapability("operator", "finance")).toBe(true);
    expect(roleHasCapability("operator", "catalog")).toBe(true);
    expect(roleHasCapability("operator", "orders")).toBe(true);
    expect(roleHasCapability("operator", "reports")).toBe(false);
  });

  it("analyst is read-only reporting, nothing else", () => {
    expect(roleHasCapability("analyst", "reports")).toBe(true);
    expect(roleHasCapability("analyst", "finance")).toBe(false);
    expect(roleHasCapability("analyst", "catalog")).toBe(false);
    expect(roleHasCapability("analyst", "orders")).toBe(false);
  });

  it("finance holds only finance", () => {
    expect(roleHasCapability("finance", "finance")).toBe(true);
    expect(roleHasCapability("finance", "catalog")).toBe(false);
    expect(roleHasCapability("finance", "orders")).toBe(false);
    expect(roleHasCapability("finance", "reports")).toBe(false);
  });

  it("catalog holds only catalog", () => {
    expect(roleHasCapability("catalog", "catalog")).toBe(true);
    expect(roleHasCapability("catalog", "finance")).toBe(false);
    expect(roleHasCapability("catalog", "orders")).toBe(false);
    expect(roleHasCapability("catalog", "reports")).toBe(false);
  });

  it("every role in the enum has a capability list, and vice versa", () => {
    const roles: readonly MembershipRole[] = membershipRoleEnum;
    expect(Object.keys(ROLE_CAPABILITIES).sort()).toEqual([...roles].sort());
  });
});
