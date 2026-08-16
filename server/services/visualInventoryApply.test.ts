/**
 * CV-1 unit tests — calibrated auto-apply policy + shrinkage/variance alerts.
 *
 * The shared apply core (services/visualInventoryApply.ts) is exercised
 * against a recording in-memory db fake; every assertion fails if the
 * corresponding feature code is reverted (mutation-proof by construction):
 *  - variance alert IS emitted when |variance| >= threshold, with exact
 *    old/new/pct payload, and NOT emitted below the threshold;
 *  - the 4-band calibration matrix (auto-apply / review × 2 / excluded).
 */
import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  applyVisualCounts,
  classifyDetectedItem,
  classifyDetectedItems,
  computeVariancePct,
  getViPolicy,
  VI_POLICY_DEFAULTS,
} from "./visualInventoryApply";
import {
  inventorySnapshots,
  merchantNotifications,
  products,
  visualInventoryMappings,
} from "../../drizzle/schema";

// ── Recording db fake ────────────────────────────────────────────────────────

function makeFakeDb(opts: { prevSnapshots?: Record<string, string> } = {}) {
  const inserted: Record<string, any[]> = {
    [getTableName(merchantNotifications)]: [],
    [getTableName(inventorySnapshots)]: [],
    [getTableName(visualInventoryMappings)]: [],
  };
  const productUpdates: any[] = [];
  const db: any = {
    select: () => ({
      from: (table: any) => ({
        where: () => ({
          limit: () => {
            // applyVisualCounts only SELECTs the previous snapshot.
            const wanted = Object.entries(opts.prevSnapshots ?? {});
            return Promise.resolve(
              wanted.length > 0 ? [{ stockQty: wanted[0][1] }] : [],
            );
          },
        }),
      }),
    }),
    update: (table: any) => ({
      set: (values: any) => ({
        where: () => {
          if (getTableName(table) === getTableName(products)) productUpdates.push(values);
          return Promise.resolve();
        },
      }),
    }),
    insert: (table: any) => ({
      values: (values: any) => {
        inserted[getTableName(table)]?.push(values);
        return {
          onConflictDoUpdate: () => Promise.resolve(),
          then: (res: (v: any) => any) => Promise.resolve(undefined).then(res),
        };
      },
    }),
  };
  return { db, inserted, productUpdates, notifications: inserted[getTableName(merchantNotifications)] };
}

const TENANT = "t-cv1";

// ── Policy parsing ────────────────────────────────────────────────────────────

describe("getViPolicy", () => {
  it("defaults: 0.95 auto-apply / 0.60 review / 20% variance", () => {
    expect(getViPolicy(null)).toEqual({ autoApplyConfidence: 0.95, reviewConfidence: 0.6, varianceAlertPct: 20 });
    expect(getViPolicy({})).toEqual(VI_POLICY_DEFAULTS);
  });
  it("tenant overrides win; garbage falls back to defaults", () => {
    expect(getViPolicy({ visualInventoryAutoApplyConfidence: 0.9 }).autoApplyConfidence).toBe(0.9);
    expect(getViPolicy({ visualInventoryReviewConfidence: "0.5" }).reviewConfidence).toBe(0.5);
    expect(getViPolicy({ visualInventoryVarianceAlertPct: 10 }).varianceAlertPct).toBe(10);
    expect(getViPolicy({ visualInventoryVarianceAlertPct: "junk" }).varianceAlertPct).toBe(20);
  });
});

// ── Calibration matrix (4 bands) ─────────────────────────────────────────────

describe("classifyDetectedItem — calibrated auto-apply matrix", () => {
  const policy = getViPolicy(null); // 0.95 / 0.60
  const verified = { productId: "p-1", isVerified: true };
  const unverified = { productId: "p-1", isVerified: false };

  it("band 1: confidence >= autoApply AND verified mapping → auto_apply", () => {
    const r = classifyDetectedItem({ label: "Indomie Pack", confidence: 0.97 }, verified, policy);
    expect(r.decision).toBe("auto_apply");
    expect(r.productId).toBe("p-1");
    expect(r.reason).toBe("calibrated_auto_apply");
  });
  it("band 1 boundary: exactly 0.95 + verified → auto_apply", () => {
    expect(classifyDetectedItem({ label: "x", confidence: 0.95 }, verified, policy).decision).toBe("auto_apply");
  });
  it("band 2: high confidence WITHOUT verified mapping → review (never auto)", () => {
    const r1 = classifyDetectedItem({ label: "Indomie Pack", confidence: 0.99 }, undefined, policy);
    expect(r1.decision).toBe("review");
    expect(r1.reason).toBe("no_verified_mapping");
    const r2 = classifyDetectedItem({ label: "Indomie Pack", confidence: 0.99 }, unverified, policy);
    expect(r2.decision).toBe("review");
  });
  it("band 3: review <= confidence < autoApply (verified) → review", () => {
    const r = classifyDetectedItem({ label: "Pure Water Sachet", confidence: 0.8 }, verified, policy);
    expect(r.decision).toBe("review");
    expect(r.reason).toBe("below_auto_apply_confidence");
    expect(r.productId).toBe("p-1");
  });
  it("band 3 boundary: exactly 0.60 → review (not excluded)", () => {
    expect(classifyDetectedItem({ label: "x", confidence: 0.6 }, verified, policy).decision).toBe("review");
  });
  it("band 4: confidence < review → excluded + flagged", () => {
    const r = classifyDetectedItem({ label: "Blurry Thing", confidence: 0.42 }, verified, policy);
    expect(r.decision).toBe("excluded");
    expect(r.reason).toBe("below_review_confidence");
    expect(r.productId).toBeNull();
  });
  it("classifyDetectedItems annotates a whole set", () => {
    const out = classifyDetectedItems(
      [
        { label: "a", count: 12, confidence: 0.97 },
        { label: "b", count: 30, confidence: 0.8 },
        { label: "c", count: 3, confidence: 0.3 },
      ],
      new Map([
        ["a", verified],
        ["b", verified],
        ["c", verified],
      ]),
      policy,
    );
    expect(out.map((o) => o.decision)).toEqual(["auto_apply", "review", "excluded"]);
  });
});

// ── Variance math ─────────────────────────────────────────────────────────────

describe("computeVariancePct", () => {
  it("signed pct vs previous qty; zero-baseline rules", () => {
    expect(computeVariancePct(20, 30)).toBeCloseTo(50);
    expect(computeVariancePct(30, 20)).toBeCloseTo(-33.333, 2);
    expect(computeVariancePct(10, 10)).toBe(0);
    expect(computeVariancePct(0, 5)).toBe(100);
    expect(computeVariancePct(0, 0)).toBe(0);
  });
});

// ── Variance alerts on apply ─────────────────────────────────────────────────

describe("applyVisualCounts — shrinkage/variance anomaly alerts", () => {
  const item = { detectedLabel: "Indomie Pack", confirmedCount: 30, productId: "p-1" };

  it("emits a notification + alert record when |variance| >= threshold (20%)", async () => {
    const { db, notifications, productUpdates } = makeFakeDb({ prevSnapshots: { "p-1": "20" } });
    const result = await applyVisualCounts(db, {
      tenantId: TENANT,
      sessionId: "sess-1",
      items: [item],
      policy: getViPolicy(null),
    });
    expect(result.applied).toBe(1);
    expect(result.alerts).toHaveLength(1);
    const alert = result.alerts[0];
    expect(alert.productId).toBe("p-1");
    expect(alert.oldQty).toBe(20);
    expect(alert.newQty).toBe(30);
    expect(alert.variancePct).toBeCloseTo(50);
    expect(alert.sessionId).toBe("sess-1");
    // Notification row carries the structured payload.
    expect(notifications).toHaveLength(1);
    expect(notifications[0].tenantId).toBe(TENANT);
    expect(notifications[0].type).toBe("system");
    expect(notifications[0].metadata.kind).toBe("visual_inventory_variance");
    expect(notifications[0].metadata.oldQty).toBe(20);
    expect(notifications[0].metadata.newQty).toBe(30);
    expect(notifications[0].metadata.sessionId).toBe("sess-1");
    // Stock really was updated.
    expect(productUpdates).toHaveLength(1);
    expect(productUpdates[0].stockQuantity).toBe(30);
  });

  it("emits NO alert when variance is below the threshold", async () => {
    const { db, notifications } = makeFakeDb({ prevSnapshots: { "p-1": "28" } });
    const result = await applyVisualCounts(db, {
      tenantId: TENANT,
      sessionId: "sess-2",
      items: [item], // 30 vs 28 → +7.1%
      policy: getViPolicy(null),
    });
    expect(result.applied).toBe(1);
    expect(result.alerts).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  it("honors a custom tenant threshold", async () => {
    const { db, notifications } = makeFakeDb({ prevSnapshots: { "p-1": "25" } });
    // 30 vs 25 → +20% exactly; threshold 50 → no alert.
    const r1 = await applyVisualCounts(db, {
      tenantId: TENANT,
      sessionId: "sess-3",
      items: [item],
      policy: getViPolicy({ visualInventoryVarianceAlertPct: 50 }),
    });
    expect(r1.alerts).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    // Threshold 20 → alert at exactly +20%.
    const f2 = makeFakeDb({ prevSnapshots: { "p-1": "25" } });
    const r2 = await applyVisualCounts(f2.db, {
      tenantId: TENANT,
      sessionId: "sess-4",
      items: [item],
      policy: getViPolicy({ visualInventoryVarianceAlertPct: 20 }),
    });
    expect(r2.alerts).toHaveLength(1);
    expect(f2.notifications).toHaveLength(1);
  });

  it("no previous snapshot → baseline unknown → no alert, still applies", async () => {
    const { db, notifications } = makeFakeDb({ prevSnapshots: {} });
    const result = await applyVisualCounts(db, {
      tenantId: TENANT,
      sessionId: "sess-5",
      items: [item],
      policy: getViPolicy(null),
    });
    expect(result.applied).toBe(1);
    expect(result.inventoryUpdates[0].oldQty).toBeNull();
    expect(result.alerts).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });
});
