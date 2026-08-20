/**
 * W25 geoDiscovery unit tests — haversine accuracy on known city pairs,
 * geohash known vectors + prefilter coverage, and discoverNearbyPure
 * radius/category/query/openNow filtering plus sponsored-boost determinism
 * with a seeded in-memory fixture (no DB).
 */
import { describe, it, expect } from "vitest";
import {
  buildCategoryTree,
  computeOpenNow,
  decodeGeohashBounds,
  discoverNearbyPure,
  encodeGeohash,
  geohashPrefilterCells,
  haversineKm,
  GEOHASH_PRECISION,
  type MerchantCandidate,
  type SponsoredCandidate,
} from "./geoDiscovery";

// ─── haversineKm ─────────────────────────────────────────────────────────────
describe("haversineKm", () => {
  // Known city-pair great-circle distances (reference: geopy/NOAA).
  const pairs: Array<[number, number, number, number, number]> = [
    // Lagos (6.5244, 3.3792) → Abuja (9.0765, 7.3986) ≈ 525.9 km
    [6.5244, 3.3792, 9.0765, 7.3986, 525.9],
    // Lagos → Kano (12.0022, 8.5920) ≈ 835.5 km
    [6.5244, 3.3792, 12.0022, 8.5920, 835.5],
    // Nairobi (-1.2921, 36.8219) → Lagos ≈ 3812.2 km
    [-1.2921, 36.8219, 6.5244, 3.3792, 3812.2],
  ];
  for (const [a, b, c, d, expected] of pairs) {
    it(`(${a},${b})→(${c},${d}) ≈ ${expected}km (±1%)`, () => {
      const got = haversineKm(a, b, c, d);
      expect(Math.abs(got - expected) / expected).toBeLessThan(0.01);
    });
  }
  it("is zero for identical points and symmetric", () => {
    expect(haversineKm(6.5, 3.4, 6.5, 3.4)).toBe(0);
    expect(haversineKm(6.5, 3.4, 9.0, 7.4)).toBeCloseTo(haversineKm(9.0, 7.4, 6.5, 3.4), 12);
  });
});

// ─── geohash ─────────────────────────────────────────────────────────────────
describe("encodeGeohash", () => {
  it("matches known vectors", () => {
    // Reference vectors from geohash.org / pygeohash.
    expect(encodeGeohash(6.5244, 3.3792, 6)).toBe("s14mhg");
    expect(encodeGeohash(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
    expect(encodeGeohash(-25.38262, -49.26561, 8)).toBe("6gkzwgjz");
    expect(encodeGeohash(9.0765, 7.3986, 5)).toBe("s1t78");
  });
  it("precision 5 is default", () => {
    expect(encodeGeohash(6.5244, 3.3792)).toHaveLength(GEOHASH_PRECISION);
  });
  it("decode bounds contain the original point", () => {
    const h = encodeGeohash(6.5244, 3.3792, 7);
    const b = decodeGeohashBounds(h);
    expect(b.latMin).toBeLessThanOrEqual(6.5244);
    expect(b.latMax).toBeGreaterThanOrEqual(6.5244);
    expect(b.lngMin).toBeLessThanOrEqual(3.3792);
    expect(b.lngMax).toBeGreaterThanOrEqual(3.3792);
  });
  it("prefilter cells cover all points within one cell of the center", () => {
    const cells = new Set(geohashPrefilterCells(6.5244, 3.3792));
    expect(cells.size).toBe(9);
    // Sample points on a 1km grid around the center (≪ cell width) — every
    // one must land in the prefilter block.
    for (let dLat = -0.01; dLat <= 0.01; dLat += 0.005) {
      for (let dLng = -0.01; dLng <= 0.01; dLng += 0.005) {
        const h = encodeGeohash(6.5244 + dLat, 3.3792 + dLng);
        expect(cells.has(h)).toBe(true);
      }
    }
  });
});

// ─── fixture ─────────────────────────────────────────────────────────────────
const LAGOS = { lat: 6.5244, lng: 3.3792 };
function merchant(
  tenantId: string,
  lat: number,
  lng: number,
  extra: Partial<MerchantCandidate> = {},
): MerchantCandidate {
  return {
    tenantId,
    businessName: `Shop ${tenantId}`,
    latitude: lat,
    longitude: lng,
    geohash: encodeGeohash(lat, lng),
    categories: ["beverages"],
    productText: ["coke 50cl bottle", "chilled soft drinks"],
    kybVerified: true,
    trustScore: null,
    openHours: null,
    ...extra,
  };
}

const FIXTURE: MerchantCandidate[] = [
  merchant("t-near", 6.5290, 3.3820), // ~0.6 km
  merchant("t-mid", 6.5500, 3.3900), // ~3.0 km
  merchant("t-far", 9.0765, 7.3986), // Abuja ~537 km
  merchant("t-cat-food", 6.5300, 3.3800, { categories: ["food"], productText: ["rice 5kg bag"] }),
  merchant("t-hidden", 6.5280, 3.3810, { kybVerified: false }),
];

const OPTS = { lat: LAGOS.lat, lng: LAGOS.lng, now: new Date("2025-01-06T12:00:00Z") }; // Monday

describe("discoverNearbyPure", () => {
  it("radius filter: 2km keeps only the closest, 5km adds mid, default never Abuja", () => {
    const r2 = discoverNearbyPure({ ...OPTS, radiusKm: 2 }, { merchants: FIXTURE, sponsored: [] });
    expect(r2.items.map((i) => i.tenantId).sort()).toEqual(["t-cat-food", "t-near"]);
    const r5 = discoverNearbyPure({ ...OPTS, radiusKm: 5 }, { merchants: FIXTURE, sponsored: [] });
    expect(r5.items.map((i) => i.tenantId).sort()).toEqual(["t-cat-food", "t-mid", "t-near"]);
    const r50 = discoverNearbyPure({ ...OPTS, radiusKm: 50 }, { merchants: FIXTURE, sponsored: [] });
    expect(r50.items.some((i) => i.tenantId === "t-far")).toBe(false);
  });

  it("clamps radiusKm to GEO_MAX_RADIUS_KM (default 50)", () => {
    const r = discoverNearbyPure({ ...OPTS, radiusKm: 5000 }, { merchants: FIXTURE, sponsored: [] });
    expect(r.radiusKm).toBe(50);
  });

  it("excludes KYB-rejected merchants", () => {
    const r = discoverNearbyPure({ ...OPTS, radiusKm: 5 }, { merchants: FIXTURE, sponsored: [] });
    expect(r.items.some((i) => i.tenantId === "t-hidden")).toBe(false);
  });

  it("category filter matches taxonomy ids", () => {
    const r = discoverNearbyPure(
      { ...OPTS, radiusKm: 5, category: "Food" },
      { merchants: FIXTURE, sponsored: [] },
    );
    expect(r.items.map((i) => i.tenantId)).toEqual(["t-cat-food"]);
  });

  it("query matches business name and product text, case-insensitive", () => {
    const byProduct = discoverNearbyPure(
      { ...OPTS, radiusKm: 5, query: "RICE" },
      { merchants: FIXTURE, sponsored: [] },
    );
    expect(byProduct.items.map((i) => i.tenantId)).toEqual(["t-cat-food"]);
    const byName = discoverNearbyPure(
      { ...OPTS, radiusKm: 5, query: "shop t-mid" },
      { merchants: FIXTURE, sponsored: [] },
    );
    expect(byName.items.map((i) => i.tenantId)).toEqual(["t-mid"]);
  });

  it("openNow filter uses openHours against the reference instant", () => {
    const hours = { mon: [["09:00", "17:00"]] };
    const ms = [
      merchant("t-open", 6.5290, 3.3820, { openHours: hours }),
      merchant("t-closed", 6.5300, 3.3800, { openHours: { mon: [["18:00", "22:00"]] } }),
      merchant("t-unknown", 6.5310, 3.3810, { openHours: null }),
    ];
    expect(computeOpenNow(hours, OPTS.now)).toBe(true);
    const r = discoverNearbyPure({ ...OPTS, radiusKm: 5, openNow: true }, { merchants: ms, sponsored: [] });
    expect(r.items.map((i) => i.tenantId)).toEqual(["t-open"]);
  });

  it("ranks by trustScore − distanceKm, deterministic", () => {
    const ms = [
      merchant("t-trusted", 6.5400, 3.3860, { trustScore: 90 }), // ~1.8km
      merchant("t-close", 6.5255, 3.3795, { trustScore: 10 }), // ~0.1km
    ];
    const a = discoverNearbyPure({ ...OPTS, radiusKm: 5 }, { merchants: ms, sponsored: [] });
    const b = discoverNearbyPure({ ...OPTS, radiusKm: 5 }, { merchants: [...ms].reverse(), sponsored: [] });
    expect(a.items.map((i) => i.tenantId)).toEqual(["t-trusted", "t-close"]);
    expect(a.items.map((i) => i.tenantId)).toEqual(b.items.map((i) => i.tenantId));
  });

  it("sponsored boost: active listing within reach outranks and is flagged", () => {
    const sponsored: SponsoredCandidate[] = [{
      tenantId: "t-cat-food",
      categories: [],
      centerLat: LAGOS.lat, centerLng: LAGOS.lng,
      radiusKm: 10,
      bidCents: 500, // +5.0 boost
    }];
    const plain = discoverNearbyPure({ ...OPTS, radiusKm: 5 }, { merchants: FIXTURE, sponsored: [] });
    expect(plain.items[0].tenantId).toBe("t-near"); // closest wins without boost
    const boosted = discoverNearbyPure({ ...OPTS, radiusKm: 5 }, { merchants: FIXTURE, sponsored });
    expect(boosted.items[0].tenantId).toBe("t-cat-food");
    expect(boosted.items[0].sponsored).toBe(true);
    expect(boosted.items[1].sponsored).toBe(false);
  });

  it("sponsored listing outside its radiusKm does not boost", () => {
    const sponsored: SponsoredCandidate[] = [{
      tenantId: "t-cat-food",
      categories: [],
      centerLat: 9.0765, centerLng: 7.3986, // Abuja
      radiusKm: 10,
      bidCents: 5000,
    }];
    const r = discoverNearbyPure({ ...OPTS, radiusKm: 5 }, { merchants: FIXTURE, sponsored });
    expect(r.items[0].tenantId).toBe("t-near");
    expect(r.items.every((i) => !i.sponsored)).toBe(true);
  });

  it("sponsored categories must overlap the filter category (empty = all)", () => {
    const sponsored: SponsoredCandidate[] = [{
      tenantId: "t-cat-food",
      categories: ["beverages"], // does NOT overlap the 'food' filter
      centerLat: LAGOS.lat, centerLng: LAGOS.lng,
      radiusKm: 10,
      bidCents: 500,
    }];
    const r = discoverNearbyPure(
      { ...OPTS, radiusKm: 5, category: "food" },
      { merchants: FIXTURE, sponsored },
    );
    expect(r.items[0].tenantId).toBe("t-cat-food");
    expect(r.items[0].sponsored).toBe(false);
  });

  it("caps sponsored results per page (default 2)", () => {
    const ms = Array.from({ length: 5 }, (_, i) =>
      merchant(`t-s${i}`, 6.5260 + i * 0.001, 3.3800));
    const sponsored: SponsoredCandidate[] = ms.map((m) => ({
      tenantId: m.tenantId, categories: [],
      centerLat: LAGOS.lat, centerLng: LAGOS.lng, radiusKm: 10, bidCents: 1000,
    }));
    const r = discoverNearbyPure({ ...OPTS, radiusKm: 5 }, { merchants: ms, sponsored });
    expect(r.items.filter((i) => i.sponsored)).toHaveLength(2);
  });

  it("paginates deterministically with hasMore", () => {
    const ms = Array.from({ length: 7 }, (_, i) =>
      merchant(`t-p${i}`, 6.5260 + i * 0.001, 3.3800));
    const p0 = discoverNearbyPure({ ...OPTS, radiusKm: 5, page: 0, pageSize: 3 }, { merchants: ms, sponsored: [] });
    const p1 = discoverNearbyPure({ ...OPTS, radiusKm: 5, page: 1, pageSize: 3 }, { merchants: ms, sponsored: [] });
    const p2 = discoverNearbyPure({ ...OPTS, radiusKm: 5, page: 2, pageSize: 3 }, { merchants: ms, sponsored: [] });
    expect(p0.total).toBe(7);
    expect(p0.hasMore).toBe(true);
    expect(p1.hasMore).toBe(true);
    expect(p2.hasMore).toBe(false);
    expect(p0.items).toHaveLength(3);
    expect(p2.items).toHaveLength(1);
    const all = [...p0.items, ...p1.items, ...p2.items].map((i) => i.tenantId);
    expect(new Set(all).size).toBe(7);
  });

  it("serviceRadiusKm hides merchants beyond their own service area", () => {
    const ms = [merchant("t-local", 6.5400, 3.3860, { serviceRadiusKm: 1 })];
    const r = discoverNearbyPure({ ...OPTS, radiusKm: 5 }, { merchants: ms, sponsored: [] });
    expect(r.items).toHaveLength(0);
  });
});

describe("buildCategoryTree", () => {
  it("groups subcategories under categories, sorted, deduped", () => {
    const tree = buildCategoryTree([
      { category: "Beverages", subcategory: "Water" },
      { category: "Beverages", subcategory: "Malt Drinks" },
      { category: "Beverages", subcategory: "Water" },
      { category: "Noodles & Pasta", subcategory: null },
    ]);
    expect(tree.map((c) => c.id)).toEqual(["beverages", "noodles & pasta"]);
    expect(tree[0].subcategories.map((s) => s.id)).toEqual(["water", "malt drinks"]);
  });
});
