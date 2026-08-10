/**
 * custom.test.ts — the tenant-defined "custom" gateway adapter:
 *  - instructions from creds (direct, customConfig, default fallback)
 *  - webhook intake fails closed (no forged confirmations)
 *  - testConnection reflects config presence
 */
import { describe, it, expect } from "vitest";
import { customProvider } from "./custom";
import type { PaymentInitiateCtx } from "./types";

const CTX: PaymentInitiateCtx = {
  tenantId: "t1",
  amountCents: 12_345,
  currency: "NGN",
  reference: "REF-C1",
  metadata: {},
  customer: { phone: "+2348000000000" },
};

describe("customProvider.initiate", () => {
  it("renders the tenant's settlement instructions", async () => {
    const r = await customProvider.initiate(CTX, { instructions: "Pay to GTB 0123456789" });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("custom");
    expect(r.instructions).toBe("Pay to GTB 0123456789");
    expect(r.authorizationUrl).toBeUndefined();
  });

  it("falls back to customConfig.instructions", async () => {
    const r = await customProvider.initiate(CTX, { customConfig: { instructions: "USSD *737#" } });
    expect(r.instructions).toBe("USSD *737#");
  });

  it("renders a generic reference-quoting message when nothing is configured", async () => {
    const r = await customProvider.initiate(CTX, null);
    expect(r.ok).toBe(true);
    expect(r.instructions).toContain("REF-C1");
    expect(r.instructions).toContain("123.45");
  });
});

describe("customProvider safety rails", () => {
  it("verifyWebhook fails closed — custom gateways never confirm via webhook", () => {
    const r = customProvider.verifyWebhook({}, "{}", { instructions: "x" });
    expect(r.ok).toBe(false);
  });

  it("fetchStatus is always pending (receipt-confirmation path owns status)", async () => {
    expect((await customProvider.fetchStatus("REF-C1", null)).status).toBe("pending");
  });

  it("testConnection requires instructions or a customConfig", async () => {
    expect((await customProvider.testConnection({ instructions: "Pay X" })).ok).toBe(true);
    expect((await customProvider.testConnection({ customConfig: { baseUrl: "https://x" } })).ok).toBe(true);
    const bad = await customProvider.testConnection(null);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain("instructions");
  });
});
