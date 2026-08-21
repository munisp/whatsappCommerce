import { describe, expect, it } from "vitest";
import { computePremiumCents } from "./insurance/adapters";
import { MockInsuranceAdapter } from "./insurance/adapters";

describe("insurance premium (deterministic, integer cents)", () => {
  it("proportional bps with flat floor", () => {
    // 250 bps = 2.5% of 250_000 cents = 6_250
    expect(computePremiumCents({ premiumBps: 250, flatPremiumCents: 500 }, 250_000)).toBe(6_250);
    // floor wins when proportional is smaller
    expect(computePremiumCents({ premiumBps: 100, flatPremiumCents: 500 }, 10_000)).toBe(500);
    // exact floor (no rounding surprises): floor division
    expect(computePremiumCents({ premiumBps: 33, flatPremiumCents: 0 }, 101)).toBe(Math.floor((101 * 33) / 10_000));
    expect(computePremiumCents({ premiumBps: 0, flatPremiumCents: 0 }, 10_000)).toBe(0);
  });
});

describe("MockInsuranceAdapter", () => {
  const product: any = {
    id: "delivery-basic", tenantId: "t1", name: "Delivery Insurance",
    premiumBps: 200, flatPremiumCents: 100, coverageCents: 50_000, active: true,
  };
  function makeAdapter() {
    const products = new Map([[product.id, product]]);
    const quotes = new Map<string, any>();
    const policies = new Map<string, any>();
    return { adapter: new MockInsuranceAdapter(products, quotes, policies), quotes, policies };
  }

  it("quote is deterministic for identical inputs", async () => {
    const { adapter } = makeAdapter();
    const ctx = { tenantId: "t1", orderId: "o1", orderAmountCents: 250_000 };
    const a = await adapter.quote("delivery-basic", ctx);
    const b = await adapter.quote("delivery-basic", ctx);
    expect(a.quoteRef).toBe(b.quoteRef);
    expect(a.premiumCents).toBe(5_000); // 2% of 250_000
    expect(a.coverageCents).toBe(50_000);
  });

  it("rejects unknown / inactive products", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.quote("nope", { tenantId: "t1" })).rejects.toThrow(/unknown/);
    products: {
      const p = { ...product, active: false };
      const a2 = new MockInsuranceAdapter(new Map([[p.id, p]]), new Map(), new Map());
      await expect(a2.quote(p.id, { tenantId: "t1" })).rejects.toThrow(/inactive|unknown/);
    }
  });

  it("bind + claim round-trip with deterministic refs", async () => {
    const { adapter, quotes, policies } = makeAdapter();
    const q = await adapter.quote("delivery-basic", { tenantId: "t1", orderAmountCents: 100_000 });
    quotes.set("q1", { ...q, tenantId: "t1" });
    const policy = await adapter.bind("q1");
    expect(policy.policyNumber).toMatch(/^POL-/);
    expect(policy.premiumCents).toBe(q.premiumCents);
    policies.set("p1", policy);
    const claim = await adapter.claim("p1", "parametric:delivery_failed");
    expect(claim.status).toBe("approved");
    expect(claim.payoutCents).toBe(policy.coverageCents);
    expect(claim.policyNumber).toBe(policy.policyNumber);
    await expect(adapter.claim("unknown", "x")).rejects.toThrow(/unknown policy/);
  });
});
