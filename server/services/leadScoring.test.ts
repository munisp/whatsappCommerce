/**
 * W17 F11 lead scoring tests: pure scoring matrix (every factor band incl.
 * edge boundaries, no-credit-history neutral), stage derivation, refresh
 * upsert idempotency (fake db), and the env-gated Twenty sync seam.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./integrationSync", () => ({
  getTwentyIntegrationConfig: vi.fn(),
}));

import {
  computeLeadScore,
  bandForScore,
  deriveLeadStage,
  refreshLeadScores,
  syncScoreToTwenty,
  setTwentyScoreFetch,
  isCrmSyncEnabled,
  LEAD_SCORE_WEIGHTS as W,
  type LeadScoreSignals,
} from "./leadScoring";
import { getTwentyIntegrationConfig } from "./integrationSync";

const NEUTRAL: LeadScoreSignals = {
  daysSinceLastOrder: null,
  ordersLast90d: 0,
  totalOrders: 0,
  totalSpent: 0,
  hasOnTimeRepayment: false,
  hasLateRepayment: false,
  hasActiveDefault: false,
  creditLimitCents: null,
  creditOutstandingCents: null,
  repliedToLastBroadcastWithin24h: false,
  daysSinceLastWhatsAppActivity: null,
};

const sig = (over: Partial<LeadScoreSignals>): LeadScoreSignals => ({ ...NEUTRAL, ...over });
const deltaOf = (r: ReturnType<typeof computeLeadScore>, factor: string) =>
  r.factors.find((f) => f.factor === factor)?.delta ?? 0;

describe("computeLeadScore — RFM recency bands", () => {
  it.each([
    [0, W.recency.within7d],
    [7, W.recency.within7d],
    [8, W.recency.within30d],
    [30, W.recency.within30d],
    [31, W.recency.within90d],
    [90, W.recency.within90d],
    [91, 0],
  ])("daysSinceLastOrder=%d → %d", (days, expected) => {
    const r = computeLeadScore(sig({ daysSinceLastOrder: days }));
    expect(deltaOf(r, "recency:ordered_within_7d") || deltaOf(r, "recency:ordered_within_30d") || deltaOf(r, "recency:ordered_within_90d")).toBe(expected);
    const recencyTotal = r.factors.filter((f) => f.factor.startsWith("recency:")).reduce((s, f) => s + f.delta, 0);
    expect(recencyTotal).toBe(expected);
  });

  it("never ordered → no recency points", () => {
    const r = computeLeadScore(sig({}));
    expect(r.factors.some((f) => f.factor.startsWith("recency:"))).toBe(false);
  });
});

describe("computeLeadScore — frequency + monetary caps", () => {
  it("frequency +5/order, capped at +25", () => {
    expect(deltaOf(computeLeadScore(sig({ ordersLast90d: 1 })), "frequency:orders_last_90d")).toBe(5);
    expect(deltaOf(computeLeadScore(sig({ ordersLast90d: 5 })), "frequency:orders_last_90d")).toBe(25);
    expect(deltaOf(computeLeadScore(sig({ ordersLast90d: 12 })), "frequency:orders_last_90d")).toBe(W.frequency.cap);
  });

  it("monetary bands (high → low) capped at +20", () => {
    expect(deltaOf(computeLeadScore(sig({ totalSpent: 0 })), "monetary:lifetime_value")).toBe(0);
    expect(deltaOf(computeLeadScore(sig({ totalSpent: 1 })), "monetary:lifetime_value")).toBe(5);
    expect(deltaOf(computeLeadScore(sig({ totalSpent: 5_000 })), "monetary:lifetime_value")).toBe(10);
    expect(deltaOf(computeLeadScore(sig({ totalSpent: 25_000 })), "monetary:lifetime_value")).toBe(15);
    expect(deltaOf(computeLeadScore(sig({ totalSpent: 100_000 })), "monetary:lifetime_value")).toBe(20);
    expect(deltaOf(computeLeadScore(sig({ totalSpent: 9_999_999 })), "monetary:lifetime_value")).toBe(W.monetary.cap);
  });
});

describe("computeLeadScore — credit behavior (the moat)", () => {
  it("no credit history is neutral: zero credit factors", () => {
    const r = computeLeadScore(sig({}));
    expect(r.factors.some((f) => f.factor.startsWith("credit:"))).toBe(false);
    expect(r.score).toBe(0);
    expect(r.band).toBe("cold");
  });

  it("on-time repayment history +15", () => {
    const r = computeLeadScore(sig({ hasOnTimeRepayment: true }));
    expect(deltaOf(r, "credit:on_time_repayment_history")).toBe(W.credit.onTimeRepayment);
  });

  it("late repayment −10, active default −25 (stacking)", () => {
    const late = computeLeadScore(sig({ hasOnTimeRepayment: true, hasLateRepayment: true }));
    expect(deltaOf(late, "credit:late_repayment")).toBe(W.credit.lateRepayment);
    const def = computeLeadScore(sig({ hasOnTimeRepayment: true, hasActiveDefault: true }));
    expect(deltaOf(def, "credit:active_default")).toBe(W.credit.activeDefault);
    // default suppresses the healthy-utilization bonus
    expect(def.factors.some((f) => f.factor === "credit:healthy_utilization")).toBe(false);
  });

  it("healthy utilization band +5 at/below 70%, none above", () => {
    const ok = computeLeadScore(sig({ creditLimitCents: 100_000, creditOutstandingCents: 70_000 }));
    expect(deltaOf(ok, "credit:healthy_utilization")).toBe(W.credit.healthyUtilization);
    const over = computeLeadScore(sig({ creditLimitCents: 100_000, creditOutstandingCents: 70_001 }));
    expect(over.factors.some((f) => f.factor === "credit:healthy_utilization")).toBe(false);
  });
});

describe("computeLeadScore — engagement", () => {
  it("broadcast reply within 24h +5, whatsapp activity ≤7d +5 (boundary)", () => {
    const r = computeLeadScore(sig({ repliedToLastBroadcastWithin24h: true, daysSinceLastWhatsAppActivity: 7 }));
    expect(deltaOf(r, "engagement:replied_to_broadcast_within_24h")).toBe(W.engagement.repliedWithin24hToLastBroadcast);
    expect(deltaOf(r, "engagement:whatsapp_active_within_7d")).toBe(W.engagement.whatsAppActiveWithin7d);
    const stale = computeLeadScore(sig({ daysSinceLastWhatsAppActivity: 8 }));
    expect(stale.factors.some((f) => f.factor === "engagement:whatsapp_active_within_7d")).toBe(false);
  });
});

describe("computeLeadScore — score clamp + band boundaries", () => {
  it("maxes at 100 and never below 0", () => {
    const maxed = computeLeadScore(sig({
      daysSinceLastOrder: 1, ordersLast90d: 20, totalSpent: 1e9,
      hasOnTimeRepayment: true, creditLimitCents: 100, creditOutstandingCents: 0,
      repliedToLastBroadcastWithin24h: true, daysSinceLastWhatsAppActivity: 0,
    }));
    expect(maxed.score).toBe(100);
    expect(maxed.band).toBe("hot");
    const floored = computeLeadScore(sig({ hasLateRepayment: true, hasActiveDefault: true }));
    expect(floored.score).toBe(0);
  });

  it("band boundaries: hot ≥70, warm 40–69, cold <40", () => {
    expect(bandForScore(70)).toBe("hot");
    expect(bandForScore(69)).toBe("warm");
    expect(bandForScore(40)).toBe("warm");
    expect(bandForScore(39)).toBe("cold");
  });

  it("every delta is listed (explainable)", () => {
    const r = computeLeadScore(sig({ daysSinceLastOrder: 3, ordersLast90d: 2 }));
    expect(r.score).toBe(r.factors.reduce((s, f) => s + f.delta, 0));
    expect(r.factors.length).toBeGreaterThan(0);
  });
});

describe("deriveLeadStage", () => {
  const base = { score: 80, band: "hot" as const, totalOrders: 0, daysSinceLastOrder: null };
  it("new_lead with no orders and no signal", () => {
    expect(deriveLeadStage({ ...base, score: 0, band: "cold" })).toBe("new_lead");
  });
  it("engaged with signal but no orders", () => {
    expect(deriveLeadStage({ ...base, score: 10, band: "cold" })).toBe("engaged");
  });
  it("first_order → repeat → vip ladder", () => {
    expect(deriveLeadStage({ ...base, totalOrders: 1, daysSinceLastOrder: 2 })).toBe("first_order");
    expect(deriveLeadStage({ ...base, totalOrders: 5, daysSinceLastOrder: 2 })).toBe("repeat");
    expect(deriveLeadStage({ ...base, totalOrders: 10, daysSinceLastOrder: 2 })).toBe("vip");
  });
  it("at_risk: bought before, gone quiet 30d+, no longer hot", () => {
    expect(deriveLeadStage({ score: 30, band: "cold", totalOrders: 4, daysSinceLastOrder: 45 })).toBe("at_risk");
    // still hot → not at-risk yet
    expect(deriveLeadStage({ score: 80, band: "hot", totalOrders: 4, daysSinceLastOrder: 45 })).toBe("repeat");
  });
});

// ── refreshLeadScores upsert idempotency (fake db) ──────────────────────────
function makeRefreshDb(custs: any[]) {
  const inserts: any[] = [];
  const conflicts: any[] = [];
  const chain = (rows: any[]): any => {
    const c: any = new Proxy(() => {}, {
      get: (_t, prop) => {
        if (prop === "then") return (res: any) => res(rows);
        return () => chain(rows);
      },
      apply: () => chain(rows),
    });
    return c;
  };
  const db: any = {
    select: vi.fn((sel: any) => {
      // customers select has `whatsappPhone`; count select has `n`
      const rows = sel && "n" in sel ? [{ n: 0 }] : custs;
      return chain(rows);
    }),
    insert: vi.fn(() => ({
      values: vi.fn((v: any) => {
        inserts.push(v);
        return {
          onConflictDoUpdate: (c: any) => {
            conflicts.push(c);
            return Promise.resolve([]);
          },
        };
      }),
    })),
  };
  return { db, inserts, conflicts };
}

describe("refreshLeadScores", () => {
  it("upserts every customer (idempotent rerun, same score for same now)", async () => {
    const cust = { id: "c1", whatsappPhone: null, totalOrders: 3, totalSpent: "6000.00", lastOrderAt: new Date("2026-01-01") };
    const { db, inserts, conflicts } = makeRefreshDb([cust]);
    const now = new Date("2026-01-10");
    const r1 = await refreshLeadScores(db, "t1", now);
    const r2 = await refreshLeadScores(db, "t1", now);
    expect(r1).toEqual({ refreshed: 1 });
    expect(r2).toEqual({ refreshed: 1 });
    expect(inserts).toHaveLength(2);
    expect(conflicts).toHaveLength(2); // every write went through onConflictDoUpdate
    // same inputs → identical upsert payload (idempotent)
    const strip = (v: any) => { const { id, ...rest } = v; return rest; };
    expect(strip(inserts[0])).toEqual(strip(inserts[1]));
    expect(inserts[0].tenantId).toBe("t1");
    expect(inserts[0].customerId).toBe("c1");
    expect(inserts[0].score).toBeGreaterThan(0);
    expect(Array.isArray(inserts[0].factors)).toBe(true);
  });
});

// ── Twenty sync seam (env-gated) ────────────────────────────────────────────
describe("syncScoreToTwenty (CRM_SYNC_ENABLED gate)", () => {
  const OLD = process.env.CRM_SYNC_ENABLED;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    if (OLD == null) delete process.env.CRM_SYNC_ENABLED;
    else process.env.CRM_SYNC_ENABLED = OLD;
    setTwentyScoreFetch((...args: any[]) => (fetch as any)(...args));
  });

  it("isCrmSyncEnabled parses true/1 only", () => {
    expect(isCrmSyncEnabled({})).toBe(false);
    expect(isCrmSyncEnabled({ CRM_SYNC_ENABLED: "false" })).toBe(false);
    expect(isCrmSyncEnabled({ CRM_SYNC_ENABLED: "true" })).toBe(true);
    expect(isCrmSyncEnabled({ CRM_SYNC_ENABLED: "1" })).toBe(true);
  });

  it("disabled by default: no fetch, no Twenty config lookup", async () => {
    delete process.env.CRM_SYNC_ENABLED;
    const fetchMock = vi.fn();
    setTwentyScoreFetch(fetchMock as any);
    const r = await syncScoreToTwenty({ tenantId: "t1", customerId: "c1", score: 80, band: "hot" });
    expect(r).toEqual({ pushed: false, reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(getTwentyIntegrationConfig)).not.toHaveBeenCalled();
  });

  it("enabled + configured: pushes score mutation to Twenty graphql", async () => {
    process.env.CRM_SYNC_ENABLED = "true";
    vi.mocked(getTwentyIntegrationConfig).mockResolvedValue({ baseUrl: "https://twenty.example", apiKey: "k", workspaceId: null } as any);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    setTwentyScoreFetch(fetchMock as any);
    const r = await syncScoreToTwenty({ tenantId: "t1", customerId: "c1", score: 80, band: "hot" });
    expect(r.pushed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://twenty.example/graphql");
    expect(JSON.parse(init.body).variables).toEqual({ customerId: "c1", score: 80, band: "hot" });
  });

  it("enabled but Twenty not configured: skipped quietly", async () => {
    process.env.CRM_SYNC_ENABLED = "true";
    vi.mocked(getTwentyIntegrationConfig).mockResolvedValue(null);
    const r = await syncScoreToTwenty({ tenantId: "t1", customerId: "c1", score: 10, band: "cold" });
    expect(r).toEqual({ pushed: false, reason: "twenty-not-configured" });
  });

  it("enabled but fetch throws: swallowed (fire-and-forget)", async () => {
    process.env.CRM_SYNC_ENABLED = "true";
    vi.mocked(getTwentyIntegrationConfig).mockResolvedValue({ baseUrl: "https://t", apiKey: "k", workspaceId: null } as any);
    setTwentyScoreFetch(vi.fn().mockRejectedValue(new Error("boom")) as any);
    const r = await syncScoreToTwenty({ tenantId: "t1", customerId: "c1", score: 10, band: "cold" });
    expect(r.pushed).toBe(false);
    expect(r.reason).toBe("boom");
  });
});
