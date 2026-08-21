/**
 * W27 delivery aggregation unit tests — deterministic local-dispatch quoting
 * (distance-priced via haversine, integer cents), registry resolution, and
 * quote-selection tie-breaking. No DB.
 */
import { describe, it, expect } from "vitest";
import {
  LOCAL_BASE_FEE_CENTS,
  LOCAL_HANDLING_MINUTES,
  LOCAL_PER_KG_CENTS,
  LOCAL_PER_KM_CENTS,
  quoteLocalDispatch,
} from "./localDispatch";
import { getCourierAdapter, listCourierAdapters, registerCourierAdapter } from "./registry";
import type { CourierAdapter, Quote } from "./types";

const PICKUP = { lat: 6.5244, lng: 3.3792 }; // Lagos
const DROPOFF_NEAR = { lat: 6.53, lng: 3.3792 }; // ~0.6 km
const DROPOFF_FAR = { lat: 6.6018, lng: 3.3515 }; // Ikeja-ish ~9 km

describe("local dispatch quoting", () => {
  it("is deterministic — same request, same quote", async () => {
    const req = { tenantId: "t1", pickup: PICKUP, dropoff: DROPOFF_NEAR, weightKg: 2 };
    const a = quoteLocalDispatch(req);
    const b = quoteLocalDispatch({ ...req });
    expect(a).toEqual(b);
    expect(a.quoteId).toBe(b.quoteId);
  });

  it("prices base + ceil(km) * perKm + extra weight, integer cents", () => {
    const near = quoteLocalDispatch({ tenantId: "t1", pickup: PICKUP, dropoff: DROPOFF_NEAR });
    const far = quoteLocalDispatch({ tenantId: "t1", pickup: PICKUP, dropoff: DROPOFF_FAR });
    expect(near.distanceKm).toBeCloseTo(0.6, 1);
    expect(near.feeCents).toBe(LOCAL_BASE_FEE_CENTS + Math.ceil(near.distanceKm!) * LOCAL_PER_KM_CENTS);
    expect(far.feeCents).toBeGreaterThan(near.feeCents);
    const heavy = quoteLocalDispatch({ tenantId: "t1", pickup: PICKUP, dropoff: DROPOFF_NEAR, weightKg: 3 });
    expect(heavy.feeCents).toBe(near.feeCents + 2 * LOCAL_PER_KG_CENTS);
    expect(Number.isInteger(near.feeCents)).toBe(true);
  });

  it("falls back to the honest zone rate without coordinates", () => {
    const lagos = quoteLocalDispatch({ tenantId: "t1", dropoffAddress: "Lekki Phase 1, Lagos" });
    const abuja = quoteLocalDispatch({ tenantId: "t1", dropoffAddress: "Wuse 2, Abuja" });
    expect(lagos.distanceKm).toBeNull();
    expect(lagos.feeCents).toBe(150_000); // same-city Sendbox anchor ₦1,500
    expect(abuja.feeCents).toBe(250_000); // intercity GIG anchor ₦2,500
  });

  it("ETA grows with distance", () => {
    const near = quoteLocalDispatch({ tenantId: "t1", pickup: PICKUP, dropoff: DROPOFF_NEAR });
    const far = quoteLocalDispatch({ tenantId: "t1", pickup: PICKUP, dropoff: DROPOFF_FAR });
    expect(near.etaMinutes).toBeGreaterThanOrEqual(LOCAL_HANDLING_MINUTES);
    expect(far.etaMinutes).toBeGreaterThan(near.etaMinutes);
  });

  it("booking ids are deterministic per order", async () => {
    const adapter = getCourierAdapter("local_dispatch")!;
    const quote: Quote = quoteLocalDispatch({ tenantId: "t1", pickup: PICKUP, dropoff: DROPOFF_NEAR });
    const b1 = await adapter.book({ tenantId: "t1", orderId: "order-1", quote, pickup: null, dropoff: { phone: "2348000000000" } });
    const b2 = await adapter.book({ tenantId: "t1", orderId: "order-1", quote, pickup: null, dropoff: { phone: "2348000000000" } });
    const b3 = await adapter.book({ tenantId: "t1", orderId: "order-2", quote, pickup: null, dropoff: { phone: "2348000000000" } });
    expect(b1.externalId).toBe(b2.externalId);
    expect(b1.externalId).not.toBe(b3.externalId);
    expect(b1.status).toBe("booked");
  });
});

describe("courier registry", () => {
  it("ships the built-in adapters", () => {
    const ids = listCourierAdapters().map((a) => a.id);
    expect(ids).toContain("local_dispatch");
    expect(ids).toContain("moto_dispatch");
  });

  it("getCourierAdapter resolves by name (FROZEN CONTRACT)", () => {
    expect(getCourierAdapter("local_dispatch")?.displayName).toContain("Local");
    expect(getCourierAdapter("nope")).toBeUndefined();
  });

  it("registerCourierAdapter adds a custom adapter", () => {
    const custom: CourierAdapter = {
      id: "test_courier",
      displayName: "Test Courier",
      quote: async () => ({ courier: "test_courier", quoteId: "q1", feeCents: 100, currency: "NGN", distanceKm: null, etaMinutes: 10, label: "t" }),
      book: async () => ({ courier: "test_courier", externalId: "x", status: "booked" }),
      status: async (id) => ({ courier: "test_courier", externalId: id, status: "booked", at: new Date().toISOString() }),
    };
    registerCourierAdapter(custom);
    expect(getCourierAdapter("test_courier")).toBe(custom);
  });

  it("moto_dispatch stub fails loudly when unconfigured", async () => {
    const stub = getCourierAdapter("moto_dispatch")!;
    await expect(stub.quote({ tenantId: "t1" })).rejects.toThrow(/not configured/);
  });
});
