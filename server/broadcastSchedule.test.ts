/**
 * Scheduled + segmented broadcast tests.
 *
 * Covers: segment matchers (tags/minOrders/minSpendKobo/lastOrderWithinDays),
 * send with scheduleAt (future → status scheduled, nothing sent; past →
 * immediate send), dryRun segment-matched counts, dispatchCampaign for a due
 * scheduled campaign, and consent gating under segmentation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./_core/rateLimit", () => ({
  redisIncrExStrict: vi.fn(),
  RateLimitUnavailableError: class RateLimitUnavailableError extends Error {},
}));
vi.mock("./services/waSender", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./services/waSender")>();
  return { ...orig, sendWhatsAppText: vi.fn(), sendWhatsAppTemplate: vi.fn() };
});

import { getDb } from "./db";
import { redisIncrExStrict } from "./_core/rateLimit";
import { sendWhatsAppText, sendWhatsAppTemplate } from "./services/waSender";
import {
  broadcastRouter,
  matchesSegment,
  normalizeSegmentFilter,
  dispatchCampaign,
} from "./routers/broadcast";

/** Chainable mock db (same pattern as broadcast.test.ts). */
function makeDb(queue: any[], executeResults: any[] = []) {
  const results = [...queue];
  const execResults = [...executeResults];
  const inserted: any[] = [];
  const updates: any[] = [];
  const chain: any = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(() => Promise.resolve(results.shift() ?? [])),
    then: (resolve: any, reject: any) => Promise.resolve(results.shift() ?? []).then(resolve, reject),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  const db: any = {
    select: vi.fn(() => chain),
    insert: vi.fn(() => ({
      values: vi.fn((v: any) => {
        inserted.push(v);
        return { onConflictDoNothing: () => Promise.resolve() };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((vals: any) => {
        updates.push(vals);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    })),
    execute: vi.fn(() => Promise.resolve(execResults.shift() ?? { rows: [] })),
  };
  return { db, inserted, updates };
}

const CAMPAIGN = {
  id: "camp-1",
  tenantId: "t1",
  name: "Promo",
  templateId: "tpl-1",
  varMapping: {},
  segmentFilter: null,
  status: "draft",
};

const ADMIN_CTX = { user: { id: 1, role: "admin", tenantId: null } } as any;

const cust = (over: Record<string, unknown>) => ({
  id: "c1",
  whatsappPhone: "+2348011111111",
  name: "A",
  tags: null,
  totalOrders: 0,
  totalSpent: "0.00",
  lastOrderAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendWhatsAppText).mockResolvedValue({ sent: true, simulated: false, wamids: ["wamid.text"], chunks: 1 });
  vi.mocked(sendWhatsAppTemplate).mockResolvedValue({ sent: true, simulated: false, wamid: "wamid.tpl" });
  vi.mocked(redisIncrExStrict).mockResolvedValue(1);
});

describe("matchesSegment", () => {
  const now = new Date("2026-02-01T00:00:00Z");
  it("tags: matches ANY owned tag (case-insensitive)", () => {
    const c = cust({ tags: ["VIP", "lagos"] });
    expect(matchesSegment(c as any, { tags: ["vip"] }, now)).toBe(true);
    expect(matchesSegment(c as any, { tags: ["wholesale"] }, now)).toBe(false);
  });
  it("minOrders", () => {
    expect(matchesSegment(cust({ totalOrders: 5 }) as any, { minOrders: 3 }, now)).toBe(true);
    expect(matchesSegment(cust({ totalOrders: 2 }) as any, { minOrders: 3 }, now)).toBe(false);
  });
  it("minSpendKobo uses minor-unit math", () => {
    expect(matchesSegment(cust({ totalSpent: "5000.00" }) as any, { minSpendKobo: 500000 }, now)).toBe(true);
    expect(matchesSegment(cust({ totalSpent: "4999.99" }) as any, { minSpendKobo: 500000 }, now)).toBe(false);
  });
  it("lastOrderWithinDays", () => {
    const recent = cust({ lastOrderAt: new Date("2026-01-25T00:00:00Z") });
    const stale = cust({ lastOrderAt: new Date("2025-12-01T00:00:00Z") });
    expect(matchesSegment(recent as any, { lastOrderWithinDays: 30 }, now)).toBe(true);
    expect(matchesSegment(stale as any, { lastOrderWithinDays: 30 }, now)).toBe(false);
    expect(matchesSegment(cust({}) as any, { lastOrderWithinDays: 30 }, now)).toBe(false);
  });
  it("normalizeSegmentFilter drops empties and junk", () => {
    expect(normalizeSegmentFilter(null)).toBeUndefined();
    expect(normalizeSegmentFilter({})).toBeUndefined();
    expect(normalizeSegmentFilter({ tags: [] })).toBeUndefined();
    expect(normalizeSegmentFilter({ tags: ["vip"] })).toEqual({ tags: ["vip"] });
    expect(normalizeSegmentFilter("vip")).toBeUndefined();
  });
});

describe("broadcast.send scheduling", () => {
  it("scheduleAt in the future → status scheduled, nothing sent", async () => {
    const { db, updates } = makeDb([[CAMPAIGN]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = broadcastRouter.createCaller(ADMIN_CTX);
    const r = await caller.send({ campaignId: "camp-1", scheduleAt: Date.now() + 3600_000 });
    expect((r as any).scheduled).toBe(true);
    expect(updates.some((u) => u.status === "scheduled" && u.scheduledAt instanceof Date)).toBe(true);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("scheduleAt in the past → sends immediately", async () => {
    const { db } = makeDb(
      [
        [CAMPAIGN],
        [{ settings: { broadcast: { ratePerMin: 30 } } }],
        [cust({})],
        [{ bodyText: "Hi {{customer_name}}", name: "wac", language: "en" }],
      ],
      [{ rows: [{ phone: "2348011111111" }] }, { rows: [{ phone: "2348011111111", last_at: new Date() }] }],
    );
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = broadcastRouter.createCaller(ADMIN_CTX);
    const r = await caller.send({ campaignId: "camp-1", scheduleAt: Date.now() - 1000 });
    expect((r as any).scheduled ?? false).toBe(false);
    expect(r.sent).toBe(1);
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
  });
});

describe("broadcast.send segmentation", () => {
  it("dryRun returns segment-matched, consent-gated counts", async () => {
    const { db, updates } = makeDb(
      [
        [CAMPAIGN],
        [{ settings: { broadcast: { ratePerMin: 30 } } }],
        [
          cust({ id: "c1", whatsappPhone: "+2348011111111", tags: ["vip"] }),
          cust({ id: "c2", whatsappPhone: "+2348022222222", tags: ["vip"] }),
          cust({ id: "c3", whatsappPhone: "+2348033333333", tags: ["new"] }),
        ],
      ],
      [
        // only c1 and c2 consented — c3 neither matches the segment nor matters
        { rows: [{ phone: "+2348011111111" }, { phone: "+2348022222222" }] },
        { rows: [] },
      ],
    );
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = broadcastRouter.createCaller(ADMIN_CTX);
    const r = await caller.send({ campaignId: "camp-1", dryRun: true, segment: { tags: ["vip"] } });
    expect(r.dryRun).toBe(true);
    expect(r.audienceCount).toBe(2); // segment-matched (c3 excluded)
    expect((r as any).segment).toEqual({ tags: ["vip"] });
    // segment persisted on the campaign for the scheduled dispatch
    expect(updates.some((u) => u.segmentFilter)).toBe(true);
  });

  it("consent still enforced under segmentation (non-consented segment member excluded)", async () => {
    const { db } = makeDb(
      [
        [CAMPAIGN],
        [{ settings: {} }],
        [
          cust({ id: "c1", whatsappPhone: "+2348011111111", tags: ["vip"] }),
          cust({ id: "c2", whatsappPhone: "+2348022222222", tags: ["vip"] }), // NOT consented
        ],
      ],
      [{ rows: [{ phone: "+2348011111111" }] }, { rows: [] }],
    );
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = broadcastRouter.createCaller(ADMIN_CTX);
    const r = await caller.send({ campaignId: "camp-1", dryRun: true, segment: { tags: ["vip"] } });
    expect(r.audienceCount).toBe(1);
    expect(r.sample[0].phone).toBe("+2348011111111");
  });
});

describe("dispatchCampaign (due scheduled campaign)", () => {
  it("runs the real consent-gated, segment-filtered send", async () => {
    const scheduledCampaign = {
      ...CAMPAIGN,
      status: "scheduled",
      scheduledAt: new Date(Date.now() - 60_000),
      segmentFilter: { minOrders: 2 },
    };
    const { db, updates } = makeDb(
      [
        [{ settings: { broadcast: { ratePerMin: 30 } } }],                 // tenant settings
        [
          cust({ id: "c1", whatsappPhone: "+2348011111111", totalOrders: 5 }),
          cust({ id: "c2", whatsappPhone: "+2348022222222", totalOrders: 0 }), // segment-miss
        ],
        [{ bodyText: "Hi {{customer_name}}", name: "wac", language: "en" }], // template
      ],
      [
        { rows: [{ phone: "2348011111111" }, { phone: "2348022222222" }] }, // both consented
        { rows: [{ phone: "2348011111111", last_at: new Date() }] },        // c1 in window
      ],
    );
    const r = await dispatchCampaign(db, scheduledCampaign as any);
    expect(r.total).toBe(1); // only the segment-matched customer
    expect(r.sent).toBe(1);
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    expect(updates.some((u) => u.status === "completed" && u.sentCount === 1)).toBe(true);
  });
});
