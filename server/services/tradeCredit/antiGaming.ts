/**
 * Anti-gaming on GMV inputs (W18) — self-dealing / wash-trading signals on
 * the 30-day order-volume input to credit scoring.
 *
 * A buyer tenant can inflate their apparent GMV (and hence their suggested
 * credit limit) by ordering from themselves. Three deterministic detectors:
 *
 *   1. SELF-DEALING  — orders placed by a customer whose WhatsApp phone is
 *      the tenant owner's or a staff member's phone (users.phone for the
 *      tenant's home users). Excluded in full. Flag: 'self_dealing_volume'.
 *   2. VELOCITY SPIKE — order volume concentrated in ≤2 days where each such
 *      day exceeds 5× the trailing-90-day daily average. Only evaluated when
 *      the trailing window has ≥ MIN_ACTIVE_DAYS active order days (a sparse
 *      new tenant's first orders are not "suspicious"). Spike days beyond
 *      the multiplier are excluded. Flag: 'velocity_spike'.
 *   3. CIRCULAR CONCENTRATION — one customer phone accounts for >70% of the
 *      (post self-dealing) 30-day GMV; that customer's excess-above-70%
 *      volume is excluded (largest orders first). Flag:
 *      'circular_concentration'.
 *
 * Output: adjustedVolumeCents (suspicious volume excluded), the flag list,
 * and a confidencePenalty (0.2 per flag, capped at 0.5) which the scorer
 * applies as a cap on the volume factor's score contribution.
 *
 * FAIL-OPEN: any error inside the enrichment/detection path returns the
 * unadjusted volume with the single flag 'anti_gaming_unavailable' — scoring
 * must never break because the abuse heuristic did.
 */
import { and, eq, gte } from "drizzle-orm";
import { customers, orders, users } from "../../../drizzle/schema";
import type { TxHandle } from "./accounts";

export const VELOCITY_SPIKE_MULTIPLIER = 5;
export const VELOCITY_WINDOW_DAYS = 2;
export const CIRCULAR_SHARE_THRESHOLD = 0.7;
export const CONFIDENCE_PENALTY_PER_FLAG = 0.2;
export const CONFIDENCE_PENALTY_CAP = 0.5;
/** Minimum active order days in the trailing 90d before velocity rules bite. */
export const MIN_ACTIVE_DAYS = 10;
/** Minimum in-window orders before the concentration rule bites (a tiny
 * tenant with one or two genuine customers is not "circular"). */
export const MIN_ORDERS_FOR_CIRCULAR = 3;

export const FLAG_SELF_DEALING = "self_dealing_volume";
export const FLAG_VELOCITY_SPIKE = "velocity_spike";
export const FLAG_CIRCULAR = "circular_concentration";
export const FLAG_UNAVAILABLE = "anti_gaming_unavailable";

export interface AntiGamingOrder {
  amountCents: number;
  createdAt: Date;
  customerPhone: string | null;
}

export interface AntiGamingResult {
  /** 30-day volume BEFORE exclusions. */
  rawVolumeCents: number;
  /** 30-day volume AFTER suspicious volume is excluded. */
  adjustedVolumeCents: number;
  flags: string[];
  /** Fraction (0..0.5) by which the scorer caps the volume contribution. */
  confidencePenalty: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function withPenalty(r: Omit<AntiGamingResult, "confidencePenalty">): AntiGamingResult {
  return {
    ...r,
    confidencePenalty: Math.min(
      CONFIDENCE_PENALTY_CAP,
      r.flags.length * CONFIDENCE_PENALTY_PER_FLAG,
    ),
  };
}

/** Pure detector core — unit-testable without a db. */
export function analyzeVolume(args: {
  /** All orders in the trailing 90 days (30-day subset is derived). */
  orders90d: AntiGamingOrder[];
  /** Tenant owner/staff phones (normalized string compare). */
  staffPhones: ReadonlySet<string>;
  now: Date;
}): AntiGamingResult {
  const { staffPhones, now } = args;
  const since30 = now.getTime() - 30 * DAY_MS;
  const orders30 = args.orders90d.filter((o) => new Date(o.createdAt).getTime() >= since30);
  const rawVolumeCents = orders30.reduce((s, o) => s + o.amountCents, 0);
  const flags: string[] = [];
  if (orders30.length === 0) {
    return withPenalty({ rawVolumeCents: 0, adjustedVolumeCents: 0, flags });
  }

  const excluded = new Set<number>(); // indexes into orders30

  // ── 1. Self-dealing: customer phone belongs to owner/staff ──────────────
  let selfDealing = false;
  orders30.forEach((o, i) => {
    if (o.customerPhone && staffPhones.has(o.customerPhone)) {
      excluded.add(i);
      selfDealing = true;
    }
  });
  if (selfDealing) flags.push(FLAG_SELF_DEALING);

  // ── 2. Velocity spike: >5× trailing-90d daily average in ≤2 days ────────
  const dayKey = (d: Date) => Math.floor(new Date(d).getTime() / DAY_MS);
  const totals90 = new Map<number, number>();
  for (const o of args.orders90d) {
    const k = dayKey(o.createdAt);
    totals90.set(k, (totals90.get(k) ?? 0) + o.amountCents);
  }
  const activeDays = totals90.size;
  if (activeDays >= MIN_ACTIVE_DAYS) {
    const total90 = args.orders90d.reduce((s, o) => s + o.amountCents, 0);
    const avgDaily = total90 / 90;
    const threshold = VELOCITY_SPIKE_MULTIPLIER * avgDaily;
    const days30 = new Map<number, number>();
    orders30.forEach((o, i) => {
      if (excluded.has(i)) return;
      const k = dayKey(o.createdAt);
      days30.set(k, (days30.get(k) ?? 0) + o.amountCents);
    });
    const dayEntries: [number, number][] = [];
    days30.forEach((v, k) => dayEntries.push([k, v]));
    const spikeDays = dayEntries
      .filter(([, v]) => v > threshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, VELOCITY_WINDOW_DAYS)
      .map(([k]) => k);
    if (spikeDays.length > 0) {
      const spikeSet = new Set(spikeDays);
      orders30.forEach((o, i) => {
        if (!excluded.has(i) && spikeSet.has(dayKey(o.createdAt))) excluded.add(i);
      });
      flags.push(FLAG_VELOCITY_SPIKE);
    }
  }

  // ── 3. Circular concentration: one phone > 70% of remaining GMV ─────────
  const remaining = orders30
    .map((o, i) => ({ o, i }))
    .filter(({ i }) => !excluded.has(i));
  const remainingTotal = remaining.reduce((s, { o }) => s + o.amountCents, 0);
  if (remainingTotal > 0 && remaining.length >= MIN_ORDERS_FOR_CIRCULAR) {
    const byPhone = new Map<string, { total: number; idx: number[] }>();
    for (const { o, i } of remaining) {
      if (!o.customerPhone) continue;
      const e = byPhone.get(o.customerPhone) ?? { total: 0, idx: [] };
      e.total += o.amountCents;
      e.idx.push(i);
      byPhone.set(o.customerPhone, e);
    }
    let top: { total: number; idx: number[] } | null = null;
    const phoneGroups: { total: number; idx: number[] }[] = [];
    byPhone.forEach((e) => phoneGroups.push(e));
    for (const e of phoneGroups) if (!top || e.total > top.total) top = e;
    if (top && top.total / remainingTotal > CIRCULAR_SHARE_THRESHOLD) {
      // Exclude the top customer's largest orders until their share of the
      // ORIGINAL remaining volume drops to ≤ 70%.
      const allowed = CIRCULAR_SHARE_THRESHOLD * remainingTotal;
      let kept = top.total;
      const sortedIdx = [...top.idx].sort(
        (a, b) => orders30[b].amountCents - orders30[a].amountCents,
      );
      for (const i of sortedIdx) {
        if (kept <= allowed) break;
        excluded.add(i);
        kept -= orders30[i].amountCents;
      }
      flags.push(FLAG_CIRCULAR);
    }
  }

  const adjustedVolumeCents = orders30.reduce(
    (s, o, i) => s + (excluded.has(i) ? 0 : o.amountCents),
    0,
  );
  return withPenalty({ rawVolumeCents, adjustedVolumeCents, flags });
}

/**
 * Db wrapper: gathers the buyer tenant's trailing-90-day orders, resolves
 * customer phones via the customers table and staff phones via users.phone
 * (the tenant's home users — owner + staff), and runs the pure detector.
 *
 * Fail-open: any query/detection error returns the unadjusted 30-day volume
 * with the single flag 'anti_gaming_unavailable'.
 */
export async function adjustVolumeTx(
  db: TxHandle,
  buyerTenantId: string,
  now: Date = new Date(),
): Promise<AntiGamingResult> {
  const since90 = new Date(now.getTime() - 90 * DAY_MS);
  const orderRows = await db
    .select({
      totalAmount: orders.totalAmount,
      createdAt: orders.createdAt,
      customerId: orders.customerId,
    })
    .from(orders)
    .where(and(eq(orders.tenantId, buyerTenantId), gte(orders.createdAt, since90)));
  const rawOrders = orderRows.map((o) => ({
    amountCents: Math.round(Number(o.totalAmount) * 100),
    createdAt: new Date(o.createdAt),
    customerId: o.customerId as string,
  }));
  const raw30 = rawOrders
    .filter((o) => o.createdAt.getTime() >= now.getTime() - 30 * DAY_MS)
    .reduce((s, o) => s + o.amountCents, 0);
  try {
    const customerRows = await db
      .select({ id: customers.id, whatsappPhone: customers.whatsappPhone })
      .from(customers)
      .where(eq(customers.tenantId, buyerTenantId));
    const phoneByCustomerId = new Map(customerRows.map((c) => [c.id, c.whatsappPhone]));
    const staffRows = await db
      .select({ phone: users.phone })
      .from(users)
      .where(eq(users.tenantId, buyerTenantId));
    const staffPhones = new Set(
      staffRows.map((u) => u.phone).filter((p): p is string => typeof p === "string" && p.length > 0),
    );
    return analyzeVolume({
      orders90d: rawOrders.map((o) => ({
        amountCents: o.amountCents,
        createdAt: o.createdAt,
        customerPhone: phoneByCustomerId.get(o.customerId) ?? null,
      })),
      staffPhones,
      now,
    });
  } catch {
    // Fail-open: enrichment failed — score on the unadjusted volume.
    return withPenalty({
      rawVolumeCents: raw30,
      adjustedVolumeCents: raw30,
      flags: [FLAG_UNAVAILABLE],
    });
  }
}
