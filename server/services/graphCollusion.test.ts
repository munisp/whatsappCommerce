/**
 * W22 graph collusion — pure graph construction/detection, the fail-open db
 * scan (idempotent alert writes), and the scoring integration flag.
 */
import { describe, it, expect } from "vitest";
import {
  buildInteractionGraph,
  detectCollusion,
  scanGraphCollusionTx,
  hasGraphCollusionSignalTx,
  windowBucketStart,
  alertThreshold,
  MIN_ORDERS_FOR_GRAPH,
  CONCENTRATION_THRESHOLD,
  CLUSTER_MIN_SIZE,
  CLUSTER_INTERNAL_SHARE,
  GRAPH_FLAG,
  type GraphOrder,
  type GraphEdge,
} from "./graphCollusion";
import { makeFakeDb } from "./tradeCredit/fakeDb";
import { suggestLimitTx } from "./tradeCredit/scoring";
import { graphAlerts } from "../../drizzle/schema";

const NOW = new Date("2025-06-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const edge = (from: string, to: string, volumeCents: number, orderCount = 1): GraphEdge =>
  ({ from, to, volumeCents, orderCount, sharedIdentifiers: [] });

describe("buildInteractionGraph", () => {
  it("aggregates volume and count per ordered pair, excluding self-loops, deterministically", () => {
    const orders: GraphOrder[] = [
      { buyerTenantId: "b", sellerTenantId: "a", amountCents: 1000, sharedIdentifiers: [], addressKey: "" },
      { buyerTenantId: "b", sellerTenantId: "a", amountCents: 500, sharedIdentifiers: ["phone-multi-tenant"], addressKey: "" },
      { buyerTenantId: "a", sellerTenantId: "a", amountCents: 999, sharedIdentifiers: [], addressKey: "" }, // self-loop
    ];
    const g1 = buildInteractionGraph(orders);
    const g2 = buildInteractionGraph([...orders].reverse());
    expect(g1).toEqual(g2);
    expect(g1).toHaveLength(1);
    expect(g1[0]).toMatchObject({ from: "b", to: "a", volumeCents: 1500, orderCount: 2, sharedIdentifiers: ["phone-multi-tenant"] });
  });

  it("marks shared-address evidence when two buyer tenants ship to the same address", () => {
    const addr = JSON.stringify({ street: "1 Marina Rd" });
    const g = buildInteractionGraph([
      { buyerTenantId: "b1", sellerTenantId: "s", amountCents: 100, sharedIdentifiers: [], addressKey: addr },
      { buyerTenantId: "b2", sellerTenantId: "s", amountCents: 100, sharedIdentifiers: [], addressKey: addr },
      { buyerTenantId: "b3", sellerTenantId: "s", amountCents: 100, sharedIdentifiers: [], addressKey: JSON.stringify({ street: "Other" }) },
    ]);
    expect(g.find((e) => e.from === "b1")!.sharedIdentifiers).toContain("shared-address");
    expect(g.find((e) => e.from === "b2")!.sharedIdentifiers).toContain("shared-address");
    expect(g.find((e) => e.from === "b3")!.sharedIdentifiers).toEqual([]);
  });
});

describe("detectCollusion — cycles", () => {
  it("flags a 2-cycle A↔B with the cycle-volume share", () => {
    const sigs = detectCollusion([edge("a", "b", 800), edge("b", "a", 700)]);
    const a = sigs.find((s) => s.buyerId === "a" && s.signal === "cycle");
    const b = sigs.find((s) => s.buyerId === "b" && s.signal === "cycle");
    expect(a?.score).toBe(1);
    expect(b?.score).toBe(1);
    expect((a?.evidence.cyclePaths as string[])[0]).toBe("a→b→a");
  });

  it("flags a 3-cycle A→B→C→A once per member (canonical path)", () => {
    const sigs = detectCollusion([edge("c", "a", 100), edge("a", "b", 100), edge("b", "c", 100)]);
    const cycleBuyers = sigs.filter((s) => s.signal === "cycle").map((s) => s.buyerId).sort();
    expect(cycleBuyers).toEqual(["a", "b", "c"]);
    const a = sigs.find((s) => s.buyerId === "a" && s.signal === "cycle");
    expect(a?.evidence.cyclePaths).toEqual(["a→b→c→a"]);
    // A↔C is not a separate 2-cycle: only the reverse edge of c→a is a→c.
    expect(sigs.filter((s) => s.signal === "cycle")).toHaveLength(3);
  });

  it("scores partial cycles below 1 when the buyer also trades outside the ring", () => {
    const sigs = detectCollusion([
      edge("a", "b", 600), edge("b", "a", 600),
      edge("a", "honest", 400),
    ]);
    const a = sigs.find((s) => s.buyerId === "a" && s.signal === "cycle");
    expect(a?.score).toBeCloseTo(0.6, 6);
  });

  it("is deterministic regardless of edge order", () => {
    const edges = [edge("a", "b", 100), edge("b", "c", 100), edge("c", "a", 100), edge("x", "y", 50), edge("y", "x", 50)];
    expect(detectCollusion(edges)).toEqual(detectCollusion([...edges].reverse()));
  });
});

describe("detectCollusion — concentration", () => {
  it(`flags a buyer with ≥ ${CONCENTRATION_THRESHOLD} of out-volume at one counterparty`, () => {
    const sigs = detectCollusion([edge("a", "s1", 800), edge("a", "s2", 200)]);
    const c = sigs.find((s) => s.buyerId === "a" && s.signal === "concentration");
    expect(c?.score).toBeCloseTo(0.8, 6);
    expect(c?.evidence.counterparty).toBe("s1");
  });

  it("does not flag dispersed trade", () => {
    const sigs = detectCollusion([edge("a", "s1", 40), edge("a", "s2", 30), edge("a", "s3", 30)]);
    expect(sigs.filter((s) => s.signal === "concentration")).toHaveLength(0);
  });
});

describe("detectCollusion — clusters", () => {
  it(`flags a mutually-trading component of size ≥ ${CLUSTER_MIN_SIZE} with ≥ ${CLUSTER_INTERNAL_SHARE} internal trade`, () => {
    // Ring of 3 trading only among themselves (mutual edges all round).
    const edges = [
      edge("a", "b", 100), edge("b", "a", 100),
      edge("b", "c", 100), edge("c", "b", 100),
      edge("c", "a", 100), edge("a", "c", 100),
    ];
    const sigs = detectCollusion(edges);
    const cluster = sigs.filter((s) => s.signal === "cluster");
    expect(cluster.map((s) => s.buyerId).sort()).toEqual(["a", "b", "c"]);
    expect(cluster[0].score).toBe(1);
    expect(cluster[0].evidence.clusterSize).toBe(3);
    expect(cluster[0].evidence.members).toEqual(["a", "b", "c"]);
  });

  it("does not flag a 2-node component or one with material outside trade", () => {
    const pair = detectCollusion([edge("a", "b", 100), edge("b", "a", 100)]);
    expect(pair.filter((s) => s.signal === "cluster")).toHaveLength(0);
    const leaky = detectCollusion([
      edge("a", "b", 100), edge("b", "a", 100),
      edge("b", "c", 100), edge("c", "b", 100),
      edge("c", "a", 100), edge("a", "c", 100),
      edge("a", "out", 500), // a trades heavily outside → internal share 600/1100 < 0.8
    ]);
    expect(leaky.filter((s) => s.signal === "cluster")).toHaveLength(0);
  });
});

// ── Db scan (fakeDb) ─────────────────────────────────────────────────────────

/** Seed a 3-tenant ring (ra→rb→rc→ra) + honest buyers into a fakeDb store. */
function ringSeed() {
  const users = [
    { tenantId: "ra", phone: "+234100" },
    { tenantId: "rb", phone: "+234101" },
    { tenantId: "rc", phone: "+234102" },
    { tenantId: "h1", phone: "+234200" },
    { tenantId: "h2", phone: "+234201" },
  ];
  const customers: { id: string; tenantId: string; whatsappPhone: string }[] = [];
  const orders: { tenantId: string; totalAmount: string; createdAt: Date; customerId: string }[] = [];
  let n = 0;
  const trade = (seller: string, buyerPhone: string, amount: string, days: number) => {
    const cid = `c-${seller}-${buyerPhone.slice(-3)}`;
    if (!customers.some((c) => c.id === cid)) customers.push({ id: cid, tenantId: seller, whatsappPhone: buyerPhone });
    orders.push({ tenantId: seller, customerId: cid, totalAmount: amount, createdAt: daysAgo(days) });
    n += 1;
  };
  // Ring: each member buys heavily from the next (≥10 orders total platform-wide).
  for (let i = 0; i < 4; i++) {
    trade("rb", "+234100", "5000.00", 2 + i); // ra → rb
    trade("rc", "+234101", "5000.00", 3 + i); // rb → rc
    trade("ra", "+234102", "5000.00", 4 + i); // rc → ra
  }
  // Honest buyers: dispersed trade, no cycle, no concentration ≥ 0.7.
  trade("ra", "+234200", "300.00", 2);
  trade("rb", "+234200", "300.00", 3);
  trade("rc", "+234200", "300.00", 4);
  trade("ra", "+234201", "200.00", 5);
  trade("rb", "+234201", "200.00", 6);
  return { users, customers, orders, count: n };
}

describe("scanGraphCollusionTx", () => {
  it("flags the ring (cycle + concentration + cluster) and leaves honest buyers clean; idempotent re-scan", async () => {
    const { db, store } = makeFakeDb(ringSeed() as any);
    const r1 = await scanGraphCollusionTx(db, "ra", { now: NOW });
    expect(r1.insufficient).toBe(false);
    expect(r1.error).toBeUndefined();
    expect(r1.ordersScanned).toBe(17);

    const ringBuyers = new Set(r1.alerts.map((a) => a.buyerId));
    expect(ringBuyers.has("ra")).toBe(true);
    expect(ringBuyers.has("rb")).toBe(true);
    expect(ringBuyers.has("rc")).toBe(true);
    expect(ringBuyers.has("h1")).toBe(false);
    expect(ringBuyers.has("h2")).toBe(false);

    const signalsOf = (b: string) => r1.alerts.filter((a) => a.buyerId === b).map((a) => a.signal).sort();
    expect(signalsOf("ra")).toEqual(["cluster", "concentration", "cycle"]);
    // Every alert carries evidence and a score ≥ threshold.
    for (const row of store.graphAlerts) {
      expect(row.score).toBeGreaterThanOrEqual(alertThreshold());
      expect(row.evidence).toBeTruthy();
      expect(row.status).toBe("open");
    }
    const cycle = store.graphAlerts.find((a) => a.buyerId === "ra" && a.signal === "cycle")!;
    expect((cycle.evidence as any).cyclePaths).toEqual(["ra→rb→rc→ra"]);

    // Idempotency: same bucket → zero new rows.
    const before = store.graphAlerts.length;
    const r2 = await scanGraphCollusionTx(db, "ra", { now: NOW });
    expect(r2.alertsCreated).toBe(0);
    expect(store.graphAlerts.length).toBe(before);

    // Scoring hook sees ring buyers, not honest ones.
    expect((await hasGraphCollusionSignalTx(db, "ra")).flagged).toBe(true);
    expect((await hasGraphCollusionSignalTx(db, "h1")).flagged).toBe(false);
  });

  it("min-data gate: < MIN_ORDERS_FOR_GRAPH orders → insufficient, no alerts", async () => {
    const { db, store } = makeFakeDb({
      orders: [{ tenantId: "x", totalAmount: "10.00", createdAt: daysAgo(1), customerId: "c1" }],
      customers: [{ id: "c1", tenantId: "x", whatsappPhone: "+2341" }],
      users: [{ tenantId: "y", phone: "+2341" }],
    });
    const r = await scanGraphCollusionTx(db, "x", { now: NOW });
    expect(r.insufficient).toBe(true);
    expect(r.ordersScanned).toBeLessThan(MIN_ORDERS_FOR_GRAPH);
    expect(store.graphAlerts).toHaveLength(0);
  });

  it("fail-open: db errors are swallowed and reported, never thrown", async () => {
    const bad = { select: () => { throw new Error("db down"); } };
    const r = await scanGraphCollusionTx(bad as any, "t", { now: NOW });
    expect(r.error).toContain("db down");
    expect(r.alertsCreated).toBe(0);
    expect((await hasGraphCollusionSignalTx(bad as any, "t")).flagged).toBe(false);
  });

  it("window buckets are UTC-day aligned (idempotency key)", () => {
    expect(windowBucketStart(NOW).toISOString()).toBe("2025-06-01T00:00:00.000Z");
  });
});

// ── Scoring integration ──────────────────────────────────────────────────────

describe("suggestLimitTx — W22 graph-collusion flag (additive, fail-open)", () => {
  const baseSeed = {
    orders: [{ tenantId: "buyer-1", totalAmount: "100000.00", createdAt: daysAgo(5), customerId: "c9" }],
    customers: [{ id: "c9", tenantId: "buyer-1", whatsappPhone: "+234900" }],
    users: [{ tenantId: "buyer-1", phone: "+234999" }],
  };

  it("open graph alert ≥ threshold adds the flag and the 0.2 confidence penalty", async () => {
    const clean = makeFakeDb(baseSeed as any);
    const flagged = makeFakeDb({
      ...baseSeed,
      graphAlerts: [{
        id: "ga-1", tenantId: "op", buyerId: "buyer-1", signal: "cycle", score: 0.9,
        evidence: { cyclePaths: ["a→b→a"] }, status: "open", windowBucket: daysAgo(0), createdAt: daysAgo(0),
      }],
    } as any);
    const cleanRes = await suggestLimitTx(clean.db, "buyer-1", "supplier-1", NOW);
    const flaggedRes = await suggestLimitTx(flagged.db, "buyer-1", "supplier-1", NOW);
    expect(cleanRes.antiGamingFlags).not.toContain(GRAPH_FLAG);
    expect(flaggedRes.antiGamingFlags).toContain(GRAPH_FLAG);
    expect(flaggedRes.reasons.some((r) => r.includes(GRAPH_FLAG))).toBe(true);
    // Same 0.2-per-flag penalty pattern: volume contribution shrinks.
    expect(flaggedRes.score).toBeLessThan(cleanRes.score);
  });

  it("dismissed alerts do not flag; existing 0.5 penalty cap is respected", async () => {
    const dismissed = makeFakeDb({
      ...baseSeed,
      graphAlerts: [{
        id: "ga-2", tenantId: "op", buyerId: "buyer-1", signal: "cycle", score: 0.9,
        evidence: null, status: "dismissed", windowBucket: daysAgo(0), createdAt: daysAgo(0),
      }],
    } as any);
    const r = await suggestLimitTx(dismissed.db, "buyer-1", "supplier-1", NOW);
    expect(r.antiGamingFlags).not.toContain(GRAPH_FLAG);
  });

  it("graph lookup failure is fail-open (no flag, heuristics unchanged)", async () => {
    const { db } = makeFakeDb(baseSeed as any);
    // Sabotage only the graph_alerts select.
    const orig = db.select;
    (db as any).select = (fields?: any) => {
      const chain = orig(fields);
      const from = chain.from;
      chain.from = (table: any) => {
        if (table && (table as any)[Symbol.for("drizzle:Name")] === "graph_alerts") throw new Error("graph down");
        return from(table);
      };
      return chain;
    };
    const r = await suggestLimitTx(db, "buyer-1", "supplier-1", NOW);
    expect(r.antiGamingFlags).not.toContain(GRAPH_FLAG);
    expect(r.score).toBeGreaterThan(0);
  });
});
