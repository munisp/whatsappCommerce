/**
 * W30 (Coder C) unit tests — feature-ring money truth guards.
 * DB-backed behaviour is covered by journeys J170–J173; these cover the
 * hermetic guard/label logic.
 */
import { afterEach, describe, expect, it } from "vitest";

const ORIG_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe("insurance deployment guard (V1#2)", () => {
  it("mock-only production deployment disables the add-on honestly", async () => {
    const { insuranceAddonDisabledReason, isMockOnlyDeployment } = await import("./insurance");
    process.env.INSURANCE_ADAPTER = "mock";
    expect(isMockOnlyDeployment()).toBe(true);
    process.env.NODE_ENV = "production";
    expect(insuranceAddonDisabledReason()).toMatch(/unavailable in this deployment/i);
    process.env.NODE_ENV = "test";
    expect(insuranceAddonDisabledReason()).toBeNull();
    process.env.NODE_ENV = "production";
    process.env.INSURANCE_ADAPTER = "real-underwriter";
    expect(isMockOnlyDeployment()).toBe(false);
    expect(insuranceAddonDisabledReason()).toBeNull();
  });
});

describe("mobile money façade guard (V3#14)", () => {
  it("is simulated unless MOBILE_MONEY_LIVE=true", async () => {
    const { mobileMoneyLive } = await import("../routers/mobileMoney");
    delete process.env.MOBILE_MONEY_LIVE;
    expect(mobileMoneyLive()).toBe(false);
    process.env.MOBILE_MONEY_LIVE = "true";
    expect(mobileMoneyLive()).toBe(true);
    process.env.MOBILE_MONEY_LIVE = "false";
    expect(mobileMoneyLive()).toBe(false);
  });
});

describe("stokvel wallet keys (V1#1)", () => {
  it("are deterministic and fit the tenant_id column", async () => {
    const { stokvelWalletTenantKey } = await import("./stokvel");
    const a = stokvelWalletTenantKey("+2348012345678");
    expect(a).toBe(stokvelWalletTenantKey("+2348012345678"));
    expect(a).not.toBe(stokvelWalletTenantKey("+2348099999999"));
    expect(a.length).toBeLessThanOrEqual(36);
    expect(a).toMatch(/^stokvel-w-[0-9a-f]{20}$/);
  });
});
