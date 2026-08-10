/**
 * Platform ops — unit tests.
 *
 * Covers: webhook dedupe ledger (claim / duplicate / sweep / dev fallback /
 * prod fail-closed), recon auto-match, usage metering + quotas, env boot
 * gate, /health/ready deep checks, and the ETA engine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./redis", () => ({ getRedis: vi.fn() }));
vi.mock("./services/paymentConfirm", () => ({ confirmProviderPayment: vi.fn() }));
vi.mock("./services/waSender", () => ({
  resolveTenantWaCredentials: vi.fn(),
  sendWhatsAppText: vi.fn().mockResolvedValue({ sent: true, simulated: false, wamids: [], chunks: 1 }),
}));

import { getDb } from "./db";
import { getRedis } from "./redis";
import { confirmProviderPayment } from "./services/paymentConfirm";
import { sendWhatsAppText } from "./services/waSender";
import {
  claimWebhookEvent, sweepProcessedWebhookEvents, __resetMemoryLedgerForTests,
} from "./services/webhookDedupe";
import {
  recordUsage, getUsage, getUsageCount, getPlan, setPlan, evaluateQuota,
  claimQuotaWarning, notifyQuotaWarning, currentPeriod, DEFAULT_PLAN,
  __resetQuotaWarnLedgerForTests,
} from "./services/metering";
import { matchSettlement, matchSettlements } from "./services/reconMatch";
import { checkReadiness, readinessHttpStatus } from "./services/healthReady";
import {
  estimateDelivery, zoneBaseEtaMinutes, formatEtaLine, estimateShipmentRemainingEta,
  DEFAULT_ETA_SAME_CITY_MINUTES, DEFAULT_ETA_INTERCITY_MINUTES,
} from "./services/eta";

// ── Drizzle chain mock helpers ───────────────────────────────────────────────

function mockInsertReturning(returning: any[]) {
  const returningFn = vi.fn().mockResolvedValue(returning);
  const onConflictDoNothing = vi.fn(() => ({ returning: returningFn }));
  const onConflictDoUpdate = vi.fn(() => ({ returning: returningFn }));
  const values = vi.fn(() => ({ onConflictDoNothing, onConflictDoUpdate }));
  return { insert: vi.fn(() => ({ values })), returningFn, onConflictDoNothing, onConflictDoUpdate };
}

function mockDeleteReturning(returning: any[]) {
  const returningFn = vi.fn().mockResolvedValue(returning);
  const where = vi.fn(() => ({ returning: returningFn }));
  return { delete: vi.fn(() => ({ where })), returningFn };
}

/** Sequential select results: each .limit() (or terminal .where()) pops the next array. */
function mockSelectSequential(results: any[][]) {
  let call = 0;
  const next = () => Promise.resolve(results[call++] ?? []);
  const limit = vi.fn().mockImplementation(next);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy, limit, then: (res: any, rej: any) => next().then(res, rej) }));
  const from = vi.fn(() => ({ where }));
  return { select: vi.fn(() => ({ from })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetMemoryLedgerForTests();
  __resetQuotaWarnLedgerForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── 1. Webhook idempotency ledger ────────────────────────────────────────────

describe("webhook dedupe ledger", () => {
  it("claims the first delivery and skips the retry", async () => {
    const first = mockInsertReturning([{ id: "wamid.abc" }]);
    const second = mockInsertReturning([]); // ON CONFLICT DO NOTHING → no row
    const db = { insert: vi.fn()
      .mockImplementationOnce(first.insert)
      .mockImplementationOnce(second.insert) } as any;

    const claim1 = await claimWebhookEvent(db, { id: "wamid.abc", tenantId: "t1", type: "text" });
    const claim2 = await claimWebhookEvent(db, { id: "wamid.abc", tenantId: "t1", type: "text" });
    expect(claim1).toBe("claimed");
    expect(claim2).toBe("duplicate");
    expect(first.onConflictDoNothing).toHaveBeenCalled();
  });

  it("sweeps ledger rows older than the retention window", async () => {
    const del = mockDeleteReturning([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const deleted = await sweepProcessedWebhookEvents({ delete: del.delete } as any, 7);
    expect(deleted).toBe(3);
    expect(del.delete).toHaveBeenCalled();
  });

  it("dev/test falls back to the in-memory ledger when the table is missing", async () => {
    const err = Object.assign(new Error('relation "processed_webhook_events" does not exist'), { code: "42P01" });
    const returningFn = vi.fn().mockRejectedValue(err);
    const values = vi.fn(() => ({ onConflictDoNothing: () => ({ returning: returningFn }) }));
    const db = { insert: vi.fn(() => ({ values })) } as any;

    const claim1 = await claimWebhookEvent(db, { id: "wamid.x", tenantId: "t1", type: "text" });
    const claim2 = await claimWebhookEvent(db, { id: "wamid.x", tenantId: "t1", type: "text" });
    expect(claim1).toBe("claimed");
    expect(claim2).toBe("duplicate"); // in-memory Set dedupes the retry
  });

  it("production fails closed when the ledger table is missing", async () => {
    const saved: Record<string, string | undefined> = {};
    const set = (k: string, v: string) => { saved[k] = process.env[k]; process.env[k] = v; };
    // Satisfy the env boot gate so env.ts loads under production semantics.
    set("NODE_ENV", ""); // anything not development/test → production semantics
    set("DATABASE_URL", "postgres://x");
    set("JWT_SECRET", "a-strong-secret");
    set("KEYCLOAK_URL", "https://kc.example");
    set("APP_URL", "https://app.example");
    set("REDIS_URL", "redis://localhost:6379");
    set("SECRETS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.resetModules();
    try {
      const { claimWebhookEvent: prodClaim } = await import("./services/webhookDedupe");
      const err = Object.assign(new Error('relation "processed_webhook_events" does not exist'), { code: "42P01" });
      const values = vi.fn(() => ({ onConflictDoNothing: () => ({ returning: vi.fn().mockRejectedValue(err) }) }));
      const db = { insert: vi.fn(() => ({ values })) } as any;
      await expect(prodClaim(db, { id: "wamid.y", tenantId: "t1", type: "text" })).rejects.toThrow(/does not exist/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      vi.resetModules();
    }
  });
});

// ── 2. Recon auto-match ──────────────────────────────────────────────────────

describe("recon auto-match", () => {
  const ORDER = {
    id: "order-9", tenantId: "t1", customerId: "2348012345678",
    orderNumber: "ORD-9", status: "pending", paymentStatus: "unpaid",
    totalAmount: "6300.00", currency: "NGN", createdAt: new Date(),
    metadata: { receiptReview: true },
  };
  const TX = { id: "tx-1", orderId: "order-9", providerRef: "WC-REF-1", provider: "paystack", currency: "NGN", status: "initiated" };

  it("matches a flagged receipt by amount+recency and confirms via paymentConfirm", async () => {
    const sel = mockSelectSequential([[ORDER], [TX], [{ settings: { adminPhone: "23480999000" } }]]);
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhere })) }));
    (confirmProviderPayment as any).mockResolvedValue({ ok: true, action: "confirmed" });
    const db = { select: sel.select, update } as any;

    const result = await matchSettlement(db, { tenantId: "t1", amount: 6300, reference: "SETL-1" });

    expect(result.outcome).toBe("confirmed");
    expect(result.orderId).toBe("order-9");
    // Confirmed through the shared money path — never bypassed.
    expect(confirmProviderPayment).toHaveBeenCalledWith(db, expect.objectContaining({
      provider: "paystack",
      reference: "WC-REF-1",
      amountMajor: 6300,
      rawPayload: expect.objectContaining({ source: "recon_settlement", settlementReference: "SETL-1" }),
    }));
    // Buyer + admin notified.
    const sentPhones = (sendWhatsAppText as any).mock.calls.map((c: any[]) => c[1]);
    expect(sentPhones).toContain("2348012345678"); // buyer
    expect(sentPhones).toContain("23480999000");   // admin
    // receiptReview flag cleared.
    expect(update).toHaveBeenCalled();
  });

  it("leaves unmatched settlements flagged and never calls paymentConfirm", async () => {
    const sel = mockSelectSequential([[]]); // no candidate orders
    const update = vi.fn();
    const db = { select: sel.select, update } as any;

    const result = await matchSettlement(db, { tenantId: "t1", amount: 99999, reference: "SETL-2" });

    expect(result.outcome).toBe("unmatched");
    expect(confirmProviderPayment).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled(); // stays flagged for manual review
  });

  it("rejects invalid settlements and isolates batch failures", async () => {
    const sel = mockSelectSequential([[]]);
    const db = { select: sel.select, update: vi.fn() } as any;
    const summary = await matchSettlements(db, [
      { tenantId: "", amount: -5 },                      // invalid
      { tenantId: "t1", amount: 1000, reference: "S3" }, // unmatched
    ]);
    expect(summary.results[0].outcome).toBe("invalid");
    expect(summary.results[1].outcome).toBe("unmatched");
    expect(summary.confirmed).toBe(0);
    expect(summary.unmatched).toBe(1);
  });
});

// ── 3. Usage metering + quotas ───────────────────────────────────────────────

describe("usage metering + quotas", () => {
  it("upsert-increments counters and reads them back", async () => {
    const ins = mockInsertReturning([{ count: 7 }]);
    const db = { insert: ins.insert } as any;
    const count = await recordUsage(db, "t1", "messages", 3);
    expect(count).toBe(7);
    expect(ins.onConflictDoUpdate).toHaveBeenCalled();
  });

  it("rolls over by monthly period (yyyymm)", () => {
    expect(currentPeriod(new Date(Date.UTC(2026, 0, 5)))).toBe("202601");
    expect(currentPeriod(new Date(Date.UTC(2026, 11, 31)))).toBe("202612");
  });

  it("getUsage / getUsageCount read the current period", async () => {
    const sel = mockSelectSequential([[{ metric: "messages", period: currentPeriod(), count: 42 }], [{ count: 42 }]]);
    const db = { select: sel.select } as any;
    const rows = await getUsage(db, "t1");
    expect(rows[0].count).toBe(42);
    const n = await getUsageCount(db, "t1", "messages");
    expect(n).toBe(42);
  });

  it("resolves the plan from settings.plan with DEFAULT_PLAN fallback", async () => {
    const withPlan = mockSelectSequential([[{ settings: { plan: { tier: "growth", limits: { messagesPerMonth: 5000, ordersPerMonth: 2000 } } } }]]);
    const plan = await getPlan({ select: withPlan.select } as any, "t1");
    expect(plan.tier).toBe("growth");
    expect(plan.limits.messagesPerMonth).toBe(5000);

    const noPlan = mockSelectSequential([[{ settings: {} }]]);
    const def = await getPlan({ select: noPlan.select } as any, "t1");
    expect(def).toEqual(DEFAULT_PLAN);
  });

  it("setPlan merges settings.plan additively", async () => {
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where: updateWhere }));
    const db = { update: vi.fn(() => ({ set })) } as any;
    await setPlan(db, "t1", { tier: "pro", limits: { messagesPerMonth: 9000, ordersPerMonth: 4000 } });
    expect(set).toHaveBeenCalled();
    expect(updateWhere).toHaveBeenCalled();
  });

  it("quota evaluation: 80% warn, 100% warn, hard stop only past 110% grace", () => {
    const limit = 1000;
    expect(evaluateQuota(500, limit).warnLevel).toBeNull();
    expect(evaluateQuota(800, limit).warnLevel).toBe(80);
    expect(evaluateQuota(1000, limit).warnLevel).toBe(100);
    expect(evaluateQuota(1000, limit).allowed).toBe(true);   // grace
    expect(evaluateQuota(1100, limit).allowed).toBe(true);   // 110% boundary still allowed
    const hard = evaluateQuota(1101, limit);
    expect(hard.allowed).toBe(false);
    expect(hard.hardStopped).toBe(true);
    // Metering unavailable → degrade open, never block.
    expect(evaluateQuota(null, limit).degraded).toBe(true);
    expect(evaluateQuota(null, limit).allowed).toBe(true);
  });

  it("admin warning fires once per period at each threshold (Redis NX dedupe)", async () => {
    const redisSet = vi.fn().mockResolvedValueOnce("OK").mockResolvedValue(null);
    (getRedis as any).mockResolvedValue({ set: redisSet });
    const sel = mockSelectSequential([[{ settings: { adminPhone: "23480999000" } }]]);
    const db = { select: sel.select } as any;

    const decision = evaluateQuota(800, 1000);
    await notifyQuotaWarning(db, "t1", decision);
    await notifyQuotaWarning(db, "t1", decision); // repeat — deduped
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    expect((sendWhatsAppText as any).mock.calls[0][1]).toBe("23480999000");
    expect((sendWhatsAppText as any).mock.calls[0][2]).toMatch(/80%/);
    expect(redisSet).toHaveBeenCalledWith(expect.stringContaining("quota-warn:t1:"), "1", "EX", expect.any(Number), "NX");
  });

  it("claimQuotaWarning dedupes within a period and re-arms next period", async () => {
    const redisSet = vi.fn()
      .mockResolvedValueOnce("OK")   // first claim this period
      .mockResolvedValueOnce(null)   // repeat — already claimed
      .mockResolvedValueOnce("OK");  // next period — new key
    (getRedis as any).mockResolvedValue({ set: redisSet });
    expect(await claimQuotaWarning("t1", "messages", "202601", 80)).toBe(true);
    expect(await claimQuotaWarning("t1", "messages", "202601", 80)).toBe(false);
    expect(await claimQuotaWarning("t1", "messages", "202602", 80)).toBe(true);
  });
});

// ── 4. Env boot gate ─────────────────────────────────────────────────────────

describe("env boot gate", () => {
  const BOOT_VARS = ["DATABASE_URL", "POSTGRES_URL", "JWT_SECRET", "KEYCLOAK_URL", "APP_URL", "REDIS_URL", "REDIS_TLS_URL"];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(BOOT_VARS.concat("NODE_ENV").map(k => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    vi.resetModules();
  });

  it("production boot throws listing every missing required var", async () => {
    for (const k of BOOT_VARS) delete process.env[k];
    process.env.NODE_ENV = ""; // production semantics
    process.env.JWT_SECRET = "a-strong-secret"; // isolate the REQUIRED_BY_ENV gate
    vi.resetModules();
    await expect(import("./_core/env")).rejects.toThrow(
      /missing required environment variables: DATABASE_URL, KEYCLOAK_URL, APP_URL, REDIS_URL/,
    );
  });

  it("development boot only warns", async () => {
    for (const k of BOOT_VARS) delete process.env[k];
    process.env.NODE_ENV = "development";
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("./_core/env");
    expect(mod.ENV).toBeDefined();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/missing required environment variables/);
    warn.mockRestore();
  });

  it("production boot succeeds when all required vars are set", async () => {
    process.env.NODE_ENV = "";
    process.env.DATABASE_URL = "postgres://x";
    process.env.JWT_SECRET = "a-strong-secret";
    process.env.KEYCLOAK_URL = "https://kc.example";
    process.env.APP_URL = "https://app.example";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    vi.resetModules();
    const mod = await import("./_core/env");
    expect(mod.REQUIRED_BY_ENV.DATABASE_URL).toBe("postgres://x");
  });
});

// ── 5. /health/ready deep checks ─────────────────────────────────────────────

describe("health/ready deep checks", () => {
  function stubInfra({ redisOk = true, keycloakOk = true, tbOk = true } = {}) {
    (getDb as any).mockResolvedValue({ execute: vi.fn().mockResolvedValue({ rows: [] }) });
    (getRedis as any).mockResolvedValue(redisOk ? { ping: vi.fn().mockResolvedValue("PONG") } : null);
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/protocol/openid-connect/certs")) {
        return Promise.resolve(keycloakOk
          ? { ok: true, json: async () => ({ keys: [{ kty: "RSA" }] }) }
          : { ok: false, status: 500, json: async () => ({}) });
      }
      return Promise.resolve(tbOk ? { ok: true } : { ok: false, status: 503 });
    }));
  }

  it("reports ok=true with all components healthy", async () => {
    stubInfra();
    const report = await checkReadiness();
    expect(report.ok).toBe(true);
    for (const c of Object.values(report.components)) expect(c.ok).toBe(true);
    expect(readinessHttpStatus(report, true)).toBe(200);
  });

  it.each([
    ["redis", { redisOk: false }],
    ["keycloak", { keycloakOk: false }],
    ["tigerbeetle", { tbOk: false }],
  ])("component failure (%s) → ok=false, 503 in prod / 200 in dev", async (_name, flags) => {
    stubInfra(flags);
    const report = await checkReadiness();
    expect(report.ok).toBe(false);
    expect(readinessHttpStatus(report, true)).toBe(503);
    expect(readinessHttpStatus(report, false)).toBe(200);
  });

  it("db failure → ok=false", async () => {
    stubInfra();
    (getDb as any).mockResolvedValue(null);
    const report = await checkReadiness();
    expect(report.ok).toBe(false);
    expect(report.components.db.ok).toBe(false);
  });
});

// ── 6. ETA engine ────────────────────────────────────────────────────────────

describe("ETA engine", () => {
  it("uses zone defaults: 45 min same-city / 180 min intercity", () => {
    expect(zoneBaseEtaMinutes({ sameCity: true })).toBe(DEFAULT_ETA_SAME_CITY_MINUTES);
    expect(zoneBaseEtaMinutes({ sameCity: false })).toBe(DEFAULT_ETA_INTERCITY_MINUTES);
    expect(zoneBaseEtaMinutes({})).toBe(DEFAULT_ETA_SAME_CITY_MINUTES); // unknown → same-city
  });

  it("prefers a configured zone etaMinutes when the zone name matches", () => {
    const zones = [{ name: "Lekki", etaMinutes: 60 }, { name: "Abuja", etaMinutes: 240 }];
    expect(zoneBaseEtaMinutes({ zoneName: "lekki", zones })).toBe(60);
    expect(zoneBaseEtaMinutes({ zoneName: "nowhere", zones, sameCity: false })).toBe(180);
  });

  it("applies status offsets: picked_up 60%, out_for_delivery 30%, delivered 0", () => {
    expect(estimateDelivery({ status: "pending", sameCity: true })).toBe(45);
    expect(estimateDelivery({ status: "picked_up", sameCity: true })).toBe(25); // 45×0.6=27 → ~25 (5-min rounding)
    expect(estimateDelivery({ status: "out_for_delivery", sameCity: true })).toBe(15); // 45×0.3=13.5 → ~15
    expect(estimateDelivery({ status: "delivered", sameCity: true })).toBe(0);
    expect(estimateDelivery({ status: "in_transit", sameCity: false })).toBe(80); // 180×0.45=81 → ~80
  });

  it("formats the buyer-facing ETA line only when an ETA remains", () => {
    expect(formatEtaLine(45)).toBe("⏱ ETA ~45 min");
    expect(formatEtaLine(0)).toBeNull();
  });

  it("estimates a stored shipment's remaining ETA (tracking payload path)", async () => {
    const shipment = {
      id: "shp-1",
      status: "picked_up",
      senderAddress: { city: "Lagos" },
      recipientAddress: { city: "Ikeja" }, // both metro Lagos → same-city? cities differ → intercity default
    };
    const sel = mockSelectSequential([[shipment], [{ settings: { commerce: { deliveryZones: [] } } }]]);
    const eta = await estimateShipmentRemainingEta({ select: sel.select } as any, {
      shipmentId: "shp-1", status: "picked_up", tenantId: "t1",
    });
    // Lagos ≠ Ikeja by exact city match → intercity base 180 × 0.6 = 108 → ~110
    expect(eta).toBe(110);

    const sameCityShipment = { ...shipment, recipientAddress: { city: "Lagos" } };
    const sel2 = mockSelectSequential([[sameCityShipment], [{ settings: {} }]]);
    const eta2 = await estimateShipmentRemainingEta({ select: sel2.select } as any, {
      shipmentId: "shp-1", status: "out_for_delivery", tenantId: "t1",
    });
    expect(eta2).toBe(15); // same-city 45 × 0.3
  });
});
