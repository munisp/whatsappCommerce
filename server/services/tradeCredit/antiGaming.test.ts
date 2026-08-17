/**
 * W18 anti-gaming — self-dealing / velocity-spike / circular-concentration
 * detection on the 30-day GMV input, fail-open db wrapper.
 */
import { describe, it, expect } from "vitest";
import {
  analyzeVolume,
  adjustVolumeTx,
  FLAG_SELF_DEALING,
  FLAG_VELOCITY_SPIKE,
  FLAG_CIRCULAR,
  FLAG_UNAVAILABLE,
  VELOCITY_SPIKE_MULTIPLIER,
  CIRCULAR_SHARE_THRESHOLD,
  CONFIDENCE_PENALTY_CAP,
  type AntiGamingOrder,
} from "./antiGaming";
import { makeFakeDb } from "./fakeDb";

const NOW = new Date("2025-06-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 864e5);
const ord = (amountCents: number, daysBack: number, phone: string | null = null): AntiGamingOrder => ({
  amountCents,
  createdAt: daysAgo(daysBack),
  customerPhone: phone,
});

describe("analyzeVolume — pure detectors", () => {
  it("clean volume passes through unadjusted with no flags", () => {
    const r = analyzeVolume({
      orders90d: [ord(100_000, 5, "+234801"), ord(200_000, 12, "+234802")],
      staffPhones: new Set(["+234800"]),
      now: NOW,
    });
    expect(r.rawVolumeCents).toBe(300_000);
    expect(r.adjustedVolumeCents).toBe(300_000);
    expect(r.flags).toEqual([]);
    expect(r.confidencePenalty).toBe(0);
  });

  it("self-dealing: orders from owner/staff phones are excluded in full", () => {
    const r = analyzeVolume({
      orders90d: [
        ord(500_000, 2, "+234800"), // owner phone
        ord(500_000, 3, "+234899"), // staff phone
        ord(100_000, 4, "+234801"), // genuine customers
        ord(80_000, 5, "+234802"),
      ],
      staffPhones: new Set(["+234800", "+234899"]),
      now: NOW,
    });
    expect(r.adjustedVolumeCents).toBe(180_000);
    expect(r.flags).toEqual([FLAG_SELF_DEALING]);
    expect(r.confidencePenalty).toBe(0.2);
  });

  it("velocity spike: >5× trailing-90d daily average concentrated in 1 day is excluded", () => {
    // 20 quiet days of ₦1k orders (active-day floor satisfied), then a
    // ₦5,000,000 single-day spike (>> 5× daily average).
    const orders90d: AntiGamingOrder[] = [];
    for (let d = 20; d < 40; d++) orders90d.push(ord(1_000, d, `+2348${d}`));
    orders90d.push(ord(500_000_000, 1, "+234901"));
    const r = analyzeVolume({ orders90d, staffPhones: new Set(), now: NOW });
    expect(r.flags).toContain(FLAG_VELOCITY_SPIKE);
    expect(r.adjustedVolumeCents).toBeLessThan(r.rawVolumeCents);
    // The quiet-day volume inside the 30d window survives the exclusion
    // (11 quiet days: d=20..30, boundary day inclusive).
    expect(r.adjustedVolumeCents).toBe(11_000);
  });

  it("velocity rule does not bite below the active-days floor (sparse new tenant)", () => {
    // Only 2 active days — a new tenant's first orders are not "suspicious".
    const r = analyzeVolume({
      orders90d: [ord(50_000_000, 1, "+234901"), ord(50_000_000, 2, "+234902")],
      staffPhones: new Set(),
      now: NOW,
    });
    expect(r.flags).not.toContain(FLAG_VELOCITY_SPIKE);
    expect(r.adjustedVolumeCents).toBe(100_000_000);
  });

  it("circular concentration: one phone > 70% of GMV has its excess excluded", () => {
    const r = analyzeVolume({
      orders90d: [
        ord(800_000, 2, "+234855"), // 80% of ₦1,000,000
        ord(100_000, 3, "+234856"),
        ord(100_000, 4, "+234857"),
      ],
      staffPhones: new Set(),
      now: NOW,
    });
    expect(r.flags).toContain(FLAG_CIRCULAR);
    // Top customer's largest order excluded → only the two small ones remain.
    expect(r.adjustedVolumeCents).toBe(200_000);
  });

  it("exactly 70% share is NOT circular (threshold is strict)", () => {
    const r = analyzeVolume({
      orders90d: [ord(700_000, 2, "+234855"), ord(300_000, 3, "+234856")],
      staffPhones: new Set(),
      now: NOW,
    });
    expect(r.flags).not.toContain(FLAG_CIRCULAR);
    expect(r.adjustedVolumeCents).toBe(1_000_000);
  });

  it("confidence penalty stacks per flag and caps at 0.5", () => {
    const orders90d: AntiGamingOrder[] = [];
    for (let d = 20; d < 40; d++) orders90d.push(ord(1_000, d, `+2348${d}`));
    // self-dealing + spike + circular on top
    orders90d.push(ord(500_000_000, 1, "+234800"));
    const r = analyzeVolume({ orders90d, staffPhones: new Set(["+234800"]), now: NOW });
    expect(r.confidencePenalty).toBeLessThanOrEqual(CONFIDENCE_PENALTY_CAP);
    expect(r.confidencePenalty).toBe(Math.min(CONFIDENCE_PENALTY_CAP, 0.2 * r.flags.length));
    expect(r.flags).toContain(FLAG_SELF_DEALING);
  });

  it("orders older than 30 days never count toward the volume", () => {
    const r = analyzeVolume({
      orders90d: [ord(900_000, 45, "+234801")],
      staffPhones: new Set(),
      now: NOW,
    });
    expect(r.rawVolumeCents).toBe(0);
    expect(r.adjustedVolumeCents).toBe(0);
    expect(r.flags).toEqual([]);
  });

  it("deterministic: identical inputs → identical output", () => {
    const args = {
      orders90d: [ord(100_000, 1, "+234801"), ord(900_000, 2, "+234802")],
      staffPhones: new Set(["+234802"]),
      now: NOW,
    };
    expect(analyzeVolume(args)).toEqual(analyzeVolume(args));
  });
});

describe("adjustVolumeTx — db wrapper", () => {
  it("joins orders → customers.whatsappPhone and users.phone (staff) end to end", async () => {
    const { db } = makeFakeDb({
      orders: [
        { tenantId: "b", totalAmount: "5000.00", createdAt: daysAgo(2), customerId: "c1" },
        { tenantId: "b", totalAmount: "100.00", createdAt: daysAgo(3), customerId: "c2" },
        { tenantId: "b", totalAmount: "80.00", createdAt: daysAgo(4), customerId: "c3" },
      ],
      customers: [
        { id: "c1", tenantId: "b", whatsappPhone: "+234800" },
        { id: "c2", tenantId: "b", whatsappPhone: "+234801" },
        { id: "c3", tenantId: "b", whatsappPhone: "+234802" },
      ],
      users: [{ tenantId: "b", phone: "+234800" }],
    });
    const r = await adjustVolumeTx(db, "b", NOW);
    expect(r.rawVolumeCents).toBe(518_000);
    expect(r.adjustedVolumeCents).toBe(18_000); // self-dealing order excluded
    expect(r.flags).toEqual([FLAG_SELF_DEALING]);
    expect(r.confidencePenalty).toBe(0.2);
  });

  it("no orders → zeros, no flags", async () => {
    const r = await adjustVolumeTx(makeFakeDb().db, "b", NOW);
    expect(r).toMatchObject({ rawVolumeCents: 0, adjustedVolumeCents: 0, flags: [], confidencePenalty: 0 });
  });

  it("fail-open: detection errors return the unadjusted volume + anti_gaming_unavailable", async () => {
    const { db } = makeFakeDb({
      orders: [{ tenantId: "b", totalAmount: "2500.00", createdAt: daysAgo(2), customerId: "c1" }],
    });
    // Force the enrichment path to throw.
    const orig = db.select;
    let calls = 0;
    (db as any).select = (...a: any[]) => {
      calls += 1;
      if (calls > 1) throw new Error("boom"); // customers/users lookups fail
      return orig.apply(db, a as any);
    };
    const r = await adjustVolumeTx(db, "b", NOW);
    expect(r.adjustedVolumeCents).toBe(250_000);
    expect(r.flags).toEqual([FLAG_UNAVAILABLE]);
    expect(r.confidencePenalty).toBe(0.2);
  });
});
