/**
 * W22 — graph-based collusion detection for the credit/anti-gaming stack.
 *
 * Pure TypeScript, no npm dependencies. Builds the tenant-level
 * trade-interaction graph from existing data and flags buyers whose trade
 * pattern looks collusive:
 *
 *   Graph construction (platform-wide, deterministic):
 *     · Nodes are buyer TENANTS, resolved from phones: an order placed at
 *       seller tenant S by a customer whose WhatsApp phone belongs to a user
 *       of tenant B (users.phone) is an edge B → S. Self-loops (B === S)
 *       are self-dealing, already handled by antiGaming.ts, and excluded.
 *     · Edges are weighted by order volumeCents (integer cents) and order
 *       count, and carry shared-identifier evidence: a phone claimed by
 *       users of multiple tenants ("phone-multi-tenant") or an identical
 *       shipping address used by two different buyer tenants
 *       ("shared-address").
 *
 *   Detection signals (per buyer, score 0..1):
 *     (a) cycle — money/order flow loops A→B→A (and A→B→C→A) within the
 *         window; score = share of the buyer's out-volume on cycle edges.
 *     (b) concentration — share of the buyer's out-volume with a single
 *         counterparty ≥ CONCENTRATION_THRESHOLD (extends the anti-gaming
 *         70% circular-concentration rule into the graph); score = share.
 *     (c) cluster — strongly-connected components (closed trade loops) of
 *         size ≥ CLUSTER_MIN_SIZE whose members trade mostly among themselves
 *         (internal share ≥ CLUSTER_INTERNAL_SHARE) — possible collusion
 *         rings; score = internal share.
 *
 *   Output: scanGraphCollusionTx persists one alert per (buyer, signal) with
 *   score ≥ ALERT_SCORE_THRESHOLD to graph_alerts, idempotent per
 *   (tenant_id, buyer_id, signal, window_bucket) via unique index +
 *   onConflictDoNothing. Evidence carries the cycle path / concentration
 *   share / cluster members for auditability.
 *
 * Determinism: all iteration is over sorted keys and the clock is injectable
 * (opts.now), so tests and journeys are fully deterministic.
 *
 * Min-data gate: fewer than MIN_ORDERS_FOR_GRAPH orders in the window →
 * { insufficient: true } and no alerts (a tiny graph proves nothing).
 *
 * FAIL-OPEN: scanGraphCollusionTx and hasGraphCollusionSignalTx never throw.
 * Any internal error is swallowed and reported ({ error } / not flagged), so
 * a detector bug can never break scoring or compliance callers.
 */
import { and, eq, gte } from "drizzle-orm";
import { customers, graphAlerts, orders, users } from "../../drizzle/schema";

// ── Tunables (single exported block) ────────────────────────────────────────
/** Detection window — trailing 30 days of orders build the graph. */
export const GRAPH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Idempotency bucket — re-scans within the same UTC day upsert-nothing. */
export const GRAPH_BUCKET_MS = 24 * 60 * 60 * 1000;
/** Minimum in-window orders before the graph proves anything. */
export const MIN_ORDERS_FOR_GRAPH = 10;
/** Share of a buyer's out-volume with one counterparty that flags concentration. */
export const CONCENTRATION_THRESHOLD = 0.7;
/** Minimum mutually-trading component size that can be a collusion cluster. */
export const CLUSTER_MIN_SIZE = 3;
/** Internal-trade share at/above which a component is a collusion cluster. */
export const CLUSTER_INTERNAL_SHARE = 0.8;
/** Minimum signal score persisted as an alert. */
export const ALERT_SCORE_THRESHOLD = 0.7;
/** Minimum open-alert score that adds the 'graph-collusion' flag in scoring. */
export const SCORING_FLAG_THRESHOLD = 0.7;
/** antiGaming flag added by the scoring integration. */
export const GRAPH_FLAG = "graph-collusion";

export type GraphSignal = "cycle" | "concentration" | "cluster";

export interface GraphOrder {
  sellerTenantId: string;
  buyerTenantId: string;
  amountCents: number;
  /** Shared-identifier evidence attached to this order ("phone-multi-tenant"). */
  sharedIdentifiers: string[];
  /** Stable key of the shipping address ("" when absent). */
  addressKey: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  volumeCents: number;
  orderCount: number;
  sharedIdentifiers: string[];
}

export interface BuyerSignal {
  buyerId: string;
  signal: GraphSignal;
  score: number;
  evidence: Record<string, unknown>;
}

export interface GraphScanOptions {
  /** Injectable clock — determinism for tests/journeys. */
  now?: Date;
  /** Detection window (default 30d). */
  windowMs?: number;
  /** Override the alert threshold (default: env GRAPH_COLLUSION_THRESHOLD or 0.7). */
  threshold?: number;
}

export interface GraphScanResult {
  insufficient: boolean;
  ordersScanned: number;
  edges: number;
  buyersScored: number;
  alertsCreated: number;
  alerts: Array<{ buyerId: string; signal: GraphSignal; score: number; id: string | null }>;
  error?: string;
}

type DbLike = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
};

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Resolved alert threshold (option override > env > default). */
export function alertThreshold(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override)) return clamp01(override);
  const raw = process.env.GRAPH_COLLUSION_THRESHOLD;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) return clamp01(n);
  }
  return ALERT_SCORE_THRESHOLD;
}

/** Bucket start for idempotent alert keys (UTC day buckets by default). */
export function windowBucketStart(now: Date, bucketMs: number = GRAPH_BUCKET_MS): Date {
  return new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);
}

// ── Pure graph construction ─────────────────────────────────────────────────

/**
 * Aggregate orders into a sorted, deduplicated edge list. Deterministic:
 * edges are keyed `from→to` and emitted sorted by (from, to).
 */
export function buildInteractionGraph(ordersList: GraphOrder[]): GraphEdge[] {
  const acc = new Map<string, GraphEdge>();
  for (const o of ordersList) {
    if (o.buyerTenantId === o.sellerTenantId) continue; // self-loop: self-dealing, see antiGaming
    const key = `${o.buyerTenantId}→${o.sellerTenantId}`;
    let e = acc.get(key);
    if (!e) {
      e = { from: o.buyerTenantId, to: o.sellerTenantId, volumeCents: 0, orderCount: 0, sharedIdentifiers: [] };
      acc.set(key, e);
    }
    e.volumeCents += o.amountCents;
    e.orderCount += 1;
    for (const s of o.sharedIdentifiers) {
      if (!e.sharedIdentifiers.includes(s)) e.sharedIdentifiers.push(s);
    }
  }
  // Shared-address evidence: an address used by ≥2 distinct buyer tenants.
  const addrBuyers = new Map<string, Set<string>>();
  for (const o of ordersList) {
    if (!o.addressKey) continue;
    let set = addrBuyers.get(o.addressKey);
    if (!set) addrBuyers.set(o.addressKey, (set = new Set()));
    set.add(o.buyerTenantId);
  }
  const sharedAddrs = new Set<string>();
  addrBuyers.forEach((buyers, addr) => {
    if (buyers.size >= 2) sharedAddrs.add(addr);
  });
  if (sharedAddrs.size > 0) {
    for (const o of ordersList) {
      if (!o.addressKey || !sharedAddrs.has(o.addressKey)) continue;
      const e = acc.get(`${o.buyerTenantId}→${o.sellerTenantId}`);
      if (e && !e.sharedIdentifiers.includes("shared-address")) e.sharedIdentifiers.push("shared-address");
    }
  }
  const edges = Array.from(acc.values());
  for (const e of edges) e.sharedIdentifiers.sort();
  edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  return edges;
}

// ── Pure detection ──────────────────────────────────────────────────────────

/**
 * Detect collusion signals over a sorted edge list. Deterministic: nodes are
 * iterated in sorted order; cycle paths are canonicalized to start at their
 * lexicographically smallest node so each cycle is reported once.
 */
export function detectCollusion(edges: GraphEdge[]): BuyerSignal[] {
  const out = new Map<string, GraphEdge[]>();
  const edgeByPair = new Map<string, GraphEdge>();
  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(e.from);
    nodes.add(e.to);
    let arr = out.get(e.from);
    if (!arr) out.set(e.from, (arr = []));
    arr.push(e);
    edgeByPair.set(`${e.from}→${e.to}`, e);
  }
  const sortedNodes = Array.from(nodes).sort();
  const totalOut = new Map<string, number>();
  for (const n of sortedNodes) {
    totalOut.set(n, (out.get(n) ?? []).reduce((s, e) => s + e.volumeCents, 0));
  }

  const signals: BuyerSignal[] = [];

  // ── (a) cycles: 2-cycles A↔B and 3-cycles A→B→C→A ──────────────────────
  // cycleOut[buyer] = out-volume of buyer on edges participating in a cycle
  // through buyer; cyclePaths[buyer] = canonical evidence paths.
  const cycleEdges = new Map<string, Set<string>>(); // buyer → distinct cycle edge keys
  const cyclePaths = new Map<string, string[]>();
  const seenCycles = new Set<string>();
  const addCycle = (path: string[]) => {
    // Canonical rotation: start at the lexicographically smallest node.
    let minI = 0;
    for (let i = 1; i < path.length; i++) if (path[i] < path[minI]) minI = i;
    const canon = path.map((_, i) => path[(minI + i) % path.length]);
    const key = canon.join("→");
    if (seenCycles.has(key)) return;
    seenCycles.add(key);
    for (let i = 0; i < canon.length; i++) {
      const buyer = canon[i];
      const edgeKey = `${canon[i]}→${canon[(i + 1) % canon.length]}`;
      let set = cycleEdges.get(buyer);
      if (!set) cycleEdges.set(buyer, (set = new Set()));
      set.add(edgeKey);
      const paths = cyclePaths.get(buyer) ?? [];
      paths.push(`${key}→${canon[0]}`);
      cyclePaths.set(buyer, paths);
    }
  };
  for (const a of sortedNodes) {
    for (const eAB of (out.get(a) ?? [])) {
      const b = eAB.to;
      if (edgeByPair.has(`${b}→${a}`)) addCycle([a, b]);
      for (const eBC of (out.get(b) ?? [])) {
        const c = eBC.to;
        if (c === a || c === b) continue;
        if (edgeByPair.has(`${c}→${a}`)) addCycle([a, b, c]);
      }
    }
  }
  for (const buyer of sortedNodes) {
    const keys = cycleEdges.get(buyer);
    const tot = totalOut.get(buyer) ?? 0;
    if (!keys || tot <= 0) continue;
    let cov = 0;
    keys.forEach((k) => { cov += edgeByPair.get(k)?.volumeCents ?? 0; });
    const score = clamp01(cov / tot);
    signals.push({
      buyerId: buyer,
      signal: "cycle",
      score,
      evidence: {
        cyclePaths: (cyclePaths.get(buyer) ?? []).sort(),
        cycleVolumeCents: cov,
        totalOutVolumeCents: tot,
        cycleShare: score,
      },
    });
  }

  // ── (b) concentration: one counterparty ≥ 70% of the buyer's out-volume ─
  for (const buyer of sortedNodes) {
    const tot = totalOut.get(buyer) ?? 0;
    if (tot <= 0) continue;
    let top: GraphEdge | null = null;
    for (const e of (out.get(buyer) ?? [])) {
      if (!top || e.volumeCents > top.volumeCents || (e.volumeCents === top.volumeCents && e.to < top.to)) top = e;
    }
    if (!top) continue;
    const share = top.volumeCents / tot;
    if (share >= CONCENTRATION_THRESHOLD) {
      signals.push({
        buyerId: buyer,
        signal: "concentration",
        score: clamp01(share),
        evidence: {
          counterparty: top.to,
          concentrationShare: share,
          counterpartyVolumeCents: top.volumeCents,
          totalOutVolumeCents: tot,
          orderCount: top.orderCount,
        },
      });
    }
  }

  // ── (c) clusters: strongly-connected components with little outside trade ─
  // A collusion ring trades in a closed loop (A→B→C→A), i.e. a strongly
  // connected component (SCC). Honest buyers attach with one-directional
  // edges and stay in singleton SCCs. Tarjan with sorted iteration keeps the
  // decomposition deterministic.
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let nextIndex = 0;
  const strongconnect = (v: string) => {
    index.set(v, nextIndex);
    lowlink.set(v, nextIndex);
    nextIndex += 1;
    stack.push(v);
    onStack.add(v);
    const nbrs = (out.get(v) ?? []).map((e) => e.to).sort();
    for (const w of nbrs) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      comp.sort();
      sccs.push(comp);
    }
  };
  for (const n of sortedNodes) if (!index.has(n)) strongconnect(n);
  sccs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const comp of sccs) {
    if (comp.length < CLUSTER_MIN_SIZE) continue;
    const member = new Set(comp);
    let internalCents = 0;
    let totalCents = 0;
    for (const n of comp) {
      for (const e of (out.get(n) ?? [])) {
        totalCents += e.volumeCents;
        if (member.has(e.to)) internalCents += e.volumeCents;
      }
    }
    if (totalCents <= 0) continue;
    const share = internalCents / totalCents;
    if (share >= CLUSTER_INTERNAL_SHARE) {
      for (const n of comp) {
        signals.push({
          buyerId: n,
          signal: "cluster",
          score: clamp01(share),
          evidence: {
            clusterSize: comp.length,
            members: comp,
            internalShare: share,
            internalVolumeCents: internalCents,
            totalVolumeCents: totalCents,
          },
        });
      }
    }
  }

  signals.sort((a, b) =>
    a.buyerId < b.buyerId ? -1 : a.buyerId > b.buyerId ? 1
      : a.signal < b.signal ? -1 : a.signal > b.signal ? 1 : 0);
  return signals;
}

// ── Db wrapper ──────────────────────────────────────────────────────────────

/**
 * Scan the tenant-level trade graph and persist collusion alerts.
 * `tenantId` is the scanning (operator) tenant — alerts are keyed by it so a
 * tenant only sees the alerts its own scans produced. Never throws.
 */
export async function scanGraphCollusionTx(
  db: DbLike,
  tenantId: string,
  opts: GraphScanOptions = {},
): Promise<GraphScanResult> {
  const windowMs = opts.windowMs ?? GRAPH_WINDOW_MS;
  const now = opts.now ?? new Date();
  const bucket = windowBucketStart(now);
  const empty: GraphScanResult = {
    insufficient: false, ordersScanned: 0, edges: 0, buyersScored: 0, alertsCreated: 0, alerts: [],
  };
  try {
    const since = new Date(now.getTime() - windowMs);
    const orderRows = await db
      .select({
        tenantId: orders.tenantId,
        customerId: orders.customerId,
        totalAmount: orders.totalAmount,
        shippingAddress: orders.shippingAddress,
      })
      .from(orders)
      .where(gte(orders.createdAt, since));

    if (orderRows.length < MIN_ORDERS_FOR_GRAPH) {
      return { ...empty, insufficient: true, ordersScanned: orderRows.length };
    }

    // Phone resolution. The epoch-0 lower bounds are full-table scans by
    // design: the graph is platform-wide (cross-tenant flows are the point).
    const epoch = new Date(0);
    const customerRows = await db
      .select({ id: customers.id, tenantId: customers.tenantId, whatsappPhone: customers.whatsappPhone })
      .from(customers)
      .where(gte(customers.createdAt, epoch));
    const userRows = await db
      .select({ tenantId: users.tenantId, phone: users.phone })
      .from(users)
      .where(gte(users.createdAt, epoch));

    const phoneByCustomer = new Map<string, string>(); // `${tenantId}|${customerId}` → phone
    for (const c of customerRows) {
      if (c.whatsappPhone) phoneByCustomer.set(`${c.tenantId}|${c.id}`, c.whatsappPhone);
    }
    const tenantsByPhone = new Map<string, string[]>(); // phone → sorted tenant ids
    for (const u of userRows) {
      if (!u.phone || !u.tenantId) continue;
      let arr = tenantsByPhone.get(u.phone);
      if (!arr) tenantsByPhone.set(u.phone, (arr = []));
      if (!arr.includes(u.tenantId)) arr.push(u.tenantId);
    }
    tenantsByPhone.forEach((arr) => arr.sort());

    const graphOrders: GraphOrder[] = [];
    for (const o of orderRows) {
      const phone = phoneByCustomer.get(`${o.tenantId}|${o.customerId}`);
      if (!phone) continue;
      const buyerTenants = tenantsByPhone.get(phone) ?? [];
      if (buyerTenants.length === 0) continue;
      const shared: string[] = [];
      if (buyerTenants.length > 1) shared.push("phone-multi-tenant");
      const addressKey = o.shippingAddress ? JSON.stringify(o.shippingAddress) : "";
      for (const buyerTenantId of buyerTenants) {
        graphOrders.push({
          sellerTenantId: o.tenantId,
          buyerTenantId,
          amountCents: Math.round(Number(o.totalAmount) * 100),
          sharedIdentifiers: shared,
          addressKey,
        });
      }
    }

    const edges = buildInteractionGraph(graphOrders);
    const signals = detectCollusion(edges);
    const threshold = alertThreshold(opts.threshold);
    const result: GraphScanResult = {
      ...empty,
      ordersScanned: orderRows.length,
      edges: edges.length,
      buyersScored: new Set(signals.map((s) => s.buyerId)).size,
    };

    for (const s of signals) {
      if (s.score < threshold) continue;
      const inserted = await db
        .insert(graphAlerts)
        .values({
          tenantId,
          buyerId: s.buyerId,
          signal: s.signal,
          score: s.score,
          evidence: { ...s.evidence, windowMs } as any,
          status: "open",
          windowBucket: bucket,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();
      const row = Array.isArray(inserted) ? inserted[0] : inserted;
      result.alerts.push({ buyerId: s.buyerId, signal: s.signal, score: s.score, id: row?.id ?? null });
      if (row?.id) result.alertsCreated += 1;
    }
    return result;
  } catch (e: any) {
    // Fail-open: detector errors must never break callers.
    return { ...empty, error: String(e?.message ?? e) };
  }
}

/**
 * Scoring integration hook: does an open graph alert ≥ threshold exist for
 * this buyer? Never throws — any error means "no signal" (fail-open).
 */
export async function hasGraphCollusionSignalTx(
  db: DbLike,
  buyerTenantId: string,
  threshold: number = SCORING_FLAG_THRESHOLD,
): Promise<{ flagged: boolean; maxScore: number }> {
  try {
    const rows = await db
      .select({ score: graphAlerts.score })
      .from(graphAlerts)
      .where(and(
        eq(graphAlerts.buyerId, buyerTenantId),
        eq(graphAlerts.status, "open"),
        gte(graphAlerts.score, threshold),
      ));
    let max = 0;
    for (const r of rows) max = Math.max(max, Number(r.score) || 0);
    return { flagged: rows.length > 0, maxScore: max };
  } catch {
    return { flagged: false, maxScore: 0 };
  }
}
