/**
 * W28 medusa-storefront — deterministic unit tests for the adapter mock and
 * the pure sync helpers. DB-touching paths are exercised end-to-end by
 * journeys J158–J161 (PGlite world); these tests never hit a live endpoint.
 */
import { describe, expect, it } from "vitest";
import { MockMedusaAdapter, type MedusaProduct } from "./adapter";
import { centsToDecimalString } from "./sync";

describe("centsToDecimalString", () => {
  it("converts integer cents to exact 2dp decimal strings", () => {
    expect(centsToDecimalString(250000)).toBe("2500.00");
    expect(centsToDecimalString(125050)).toBe("1250.50");
    expect(centsToDecimalString(30010)).toBe("300.10");
    expect(centsToDecimalString(0)).toBe("0.00");
    expect(centsToDecimalString(5)).toBe("0.05");
  });
  it("never drifts (no float math) and truncates sub-cent input", () => {
    expect(centsToDecimalString(1999)).toBe("19.99");
    expect(centsToDecimalString(123.9)).toBe("1.23");
  });
});

const sampleProduct = (id: string, amount: number): MedusaProduct => ({
  id,
  title: `Product ${id}`,
  status: "published",
  sales_channels: [{ id: "sc_1" }],
  variants: [{ id: `var_${id}`, title: "Default", prices: [{ currency_code: "ngn", amount }], inventory_quantity: 3 }],
});

describe("MockMedusaAdapter", () => {
  it("derives deterministic order ids from the platform order id", async () => {
    const a = new MockMedusaAdapter();
    const input = {
      platformOrderId: "order-1",
      platformOrderNumber: "SIM-1",
      currency: "NGN",
      email: "x@y.local",
      phone: "+234",
      items: [{ variantId: "var_p1", title: "P1", quantity: 2, unitPriceCents: 150050 }],
      totalCents: 300100,
    };
    const o1 = await a.createOrder(input);
    const b = new MockMedusaAdapter();
    const o2 = await b.createOrder(input);
    expect(o1.id).toBe(o2.id); // HMAC-derived, no Math.random / Date.now
    expect(o1.id).toMatch(/^medusa_order_[0-9a-f]{24}$/);
    expect(o1.total).toBe(300100);
    expect(Number.isInteger(o1.total)).toBe(true);
  });

  it("is idempotent per platform order (retry returns the same order)", async () => {
    const a = new MockMedusaAdapter();
    const input = {
      platformOrderId: "order-dup",
      platformOrderNumber: "SIM-2",
      currency: "NGN",
      email: "x@y.local",
      phone: "+234",
      items: [{ variantId: "var_p1", title: "P1", quantity: 1, unitPriceCents: 100 }],
      totalCents: 100,
    };
    const first = await a.createOrder(input);
    const second = await a.createOrder(input);
    expect(second.id).toBe(first.id);
    expect(a.createOrderCalls).toHaveLength(1); // one recorded outbound call
  });

  it("lists seeded products deterministically (sorted, paginated)", async () => {
    const a = new MockMedusaAdapter();
    a.seedProducts([sampleProduct("p_b", 200), sampleProduct("p_a", 100), sampleProduct("p_c", 300)]);
    const all = await a.listProducts();
    expect(all.count).toBe(3);
    expect(all.products.map((p) => p.id)).toEqual(["p_a", "p_b", "p_c"]);
    const page = await a.listProducts({ limit: 2, offset: 2 });
    expect(page.products.map((p) => p.id)).toEqual(["p_c"]);
  });

  it("scripts connection failures for testConnection", async () => {
    const a = new MockMedusaAdapter();
    expect((await a.testConnection()).ok).toBe(true);
    a.scriptedConnectionError = "connection refused";
    const r = await a.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("connection refused");
  });

  it("reset clears all recorded state", async () => {
    const a = new MockMedusaAdapter();
    a.seedProducts([sampleProduct("p1", 100)]);
    await a.createOrder({
      platformOrderId: "o1", platformOrderNumber: "N1", currency: "NGN",
      email: "e", phone: "p", items: [], totalCents: 0,
    });
    a.reset();
    expect((await a.listProducts()).count).toBe(0);
    expect(a.orders.size).toBe(0);
    expect(a.createOrderCalls).toHaveLength(0);
  });
});
