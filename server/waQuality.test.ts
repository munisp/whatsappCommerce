/**
 * waQuality tests: Meta pull + caching, graceful degradation on API denial,
 * and the broadcast throttle (LOW blocks, MEDIUM halves).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./services/waSender", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./services/waSender")>();
  return { ...orig, resolveTenantWaCredentials: vi.fn() };
});

import { resolveTenantWaCredentials } from "./services/waSender";
import {
  applyQualityThrottle,
  getWaQuality,
  mapMetaQuality,
  parseWaQuality,
  refreshWaQuality,
} from "./services/waQuality";

function makeDb(settings: any) {
  const updates: any[] = [];
  const db: any = {
    select: vi.fn(() => {
      const c: any = {
        from: vi.fn(() => c),
        where: vi.fn(() => c),
        limit: vi.fn(() => Promise.resolve([{ settings }])),
        catch: vi.fn(() => Promise.resolve([{ settings }])),
      };
      return c;
    }),
    update: vi.fn(() => ({
      set: vi.fn((v: any) => {
        updates.push(v);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    })),
  };
  return { db, updates };
}

function jsonFetch(payload: any, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveTenantWaCredentials).mockResolvedValue({
    phoneNumberId: "pn-1",
    accessToken: "tok",
    source: "tenant",
  });
});

describe("mapMetaQuality", () => {
  it("maps GREEN/YELLOW/RED to HIGH/MEDIUM/LOW, UNKNOWN otherwise", () => {
    expect(mapMetaQuality("GREEN")).toBe("HIGH");
    expect(mapMetaQuality("yellow")).toBe("MEDIUM");
    expect(mapMetaQuality("RED")).toBe("LOW");
    expect(mapMetaQuality("UNKNOWN")).toBe("UNKNOWN");
    expect(mapMetaQuality(undefined)).toBe("UNKNOWN");
  });
});

describe("parseWaQuality / getWaQuality", () => {
  it("parses a cached snapshot and tolerates junk", async () => {
    const q = parseWaQuality({ waQuality: { rating: "MEDIUM", tier: "TIER_2", checkedAt: "2025-01-01" } });
    expect(q).toMatchObject({ rating: "MEDIUM", tier: "TIER_2" });
    expect(parseWaQuality({ waQuality: { rating: "BANANA" } })?.rating).toBe("UNKNOWN");
    expect(parseWaQuality({})).toBeNull();

    const { db } = makeDb({ waQuality: { rating: "LOW", tier: null, checkedAt: "2025-01-01" } });
    expect((await getWaQuality(db, "t1"))?.rating).toBe("LOW");
  });
});

describe("refreshWaQuality", () => {
  it("pulls quality_rating + tier from Meta and caches them", async () => {
    const { db, updates } = makeDb({});
    const fetchFn = jsonFetch({ quality_rating: "YELLOW", messaging_limit_tier: "TIER_10K" });
    const q = await refreshWaQuality(db, "t1", fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("/pn-1?fields=quality_rating"),
      expect.objectContaining({ headers: { Authorization: "Bearer tok" } }),
    );
    expect(q).toMatchObject({ rating: "MEDIUM", tier: "TIER_10K" });
    expect(updates[0].settings).toBeDefined(); // sql fragment embedding settings.waQuality
  });

  it("degrades gracefully: keeps the previous rating when the API denies", async () => {
    const { db } = makeDb({ waQuality: { rating: "HIGH", tier: "TIER_1K", checkedAt: "2025-01-01" } });
    const q = await refreshWaQuality(db, "t1", jsonFetch({ error: "permission denied" }, 403));
    expect(q?.rating).toBe("HIGH"); // previous kept
    expect(q?.lastError).toContain("403");
  });

  it("degrades gracefully on network errors and missing credentials", async () => {
    const { db } = makeDb({});
    const errFetch = vi.fn(async () => { throw new Error("ECONNRESET"); }) as any;
    const q1 = await refreshWaQuality(db, "t1", errFetch);
    expect(q1?.rating).toBe("UNKNOWN");
    expect(q1?.lastError).toContain("ECONNRESET");

    vi.mocked(resolveTenantWaCredentials).mockResolvedValue(null);
    const q2 = await refreshWaQuality(db, "t1", jsonFetch({}));
    expect(q2?.lastError).toContain("no WhatsApp credentials");
  });
});

describe("applyQualityThrottle", () => {
  it("LOW blocks the broadcast with a clear reason", () => {
    const t = applyQualityThrottle({ waQuality: { rating: "LOW", checkedAt: "x" } }, 30);
    expect(t.blocked).toBe(true);
    expect(t.reason).toContain("LOW");
    expect(t.ratePerMin).toBe(30);
  });

  it("MEDIUM halves the rate (floor 1/min)", () => {
    expect(applyQualityThrottle({ waQuality: { rating: "MEDIUM", checkedAt: "x" } }, 30).ratePerMin).toBe(15);
    expect(applyQualityThrottle({ waQuality: { rating: "MEDIUM", checkedAt: "x" } }, 1).ratePerMin).toBe(1);
  });

  it("HIGH / UNKNOWN / never-checked leave the rate unchanged", () => {
    expect(applyQualityThrottle({ waQuality: { rating: "HIGH", checkedAt: "x" } }, 30)).toEqual({ blocked: false, ratePerMin: 30 });
    expect(applyQualityThrottle({ waQuality: { rating: "UNKNOWN", checkedAt: "x" } }, 30).blocked).toBe(false);
    expect(applyQualityThrottle({}, 30)).toEqual({ blocked: false, ratePerMin: 30 });
  });
});
