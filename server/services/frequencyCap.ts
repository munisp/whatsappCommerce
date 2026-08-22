/**
 * frequencyCap.ts — Meta marketing-frequency-aware send scheduling (W17 F8).
 *
 * Meta penalises numbers whose marketing messages are too frequent; GDPR/NDPR
 * grading also expects senders to honour quiet hours. This module is consulted
 * by journey execution (runDueJourneySteps) and by the broadcast send path
 * before a marketing send is attempted.
 *
 * Policy resolution order: tenant settings (`settings.marketingFrequency`) →
 * defaults below. Defaults: max 2 marketing messages per customer per 7 days,
 * quiet hours 21:00–08:00 Africa/Lagos.
 *
 * "Marketing" sends are rows in whatsapp_notification_log whose notifType is
 * broadcast- or journey-originated (MARKETING_NOTIF_TYPES). Transactional
 * sends (order confirmations etc.) never count against the cap.
 */
import { sql } from "drizzle-orm";
import { normalizeWaPhone } from "./waSender";

export interface MarketingFrequencyPolicy {
  /** Max marketing sends per customer inside the rolling window. */
  maxPerWindow: number;
  /** Rolling window length in days. */
  windowDays: number;
  /** Quiet-hours start, minutes after local midnight (default 21:00 → 1260). */
  quietStartMinutes: number;
  /** Quiet-hours end, minutes after local midnight (default 08:00 → 480). */
  quietEndMinutes: number;
  /**
   * Fixed UTC offset in minutes for the tenant's market. Africa/Lagos is
   * UTC+1 year-round (no DST), so a fixed offset is DST-safe by construction:
   * all arithmetic is done in UTC and shifted by this constant.
   */
  tzOffsetMinutes: number;
}

export const DEFAULT_MARKETING_FREQUENCY_POLICY: MarketingFrequencyPolicy = {
  maxPerWindow: 2,
  windowDays: 7,
  quietStartMinutes: 21 * 60,
  quietEndMinutes: 8 * 60,
  tzOffsetMinutes: 60, // Africa/Lagos, UTC+1, no DST
};

/** notifType values in whatsapp_notification_log that count as marketing. */
export const MARKETING_NOTIF_TYPES = ["broadcast", "journey_template"] as const;

/** Parse "HH:MM" → minutes after midnight. Throws on malformed input. */
export function parseHm(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`invalid HH:MM time: ${value}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`invalid HH:MM time: ${value}`);
  return h * 60 + min;
}

/** Read settings.marketingFrequency for a tenant (falls back to defaults). */
export function parseMarketingFrequencyPolicy(settings: unknown): MarketingFrequencyPolicy {
  const f = (((settings as Record<string, unknown> | null)?.marketingFrequency ?? {}) as Record<string, unknown>);
  const d = DEFAULT_MARKETING_FREQUENCY_POLICY;
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : fallback;
  const hm = (v: unknown, fallback: number) => {
    if (typeof v !== "string") return fallback;
    try { return parseHm(v); } catch { return fallback; }
  };
  return {
    maxPerWindow: num(f.maxPerWindow ?? f.maxPer7Days, d.maxPerWindow, 1, 100),
    windowDays: num(f.windowDays, d.windowDays, 1, 90),
    quietStartMinutes: hm(f.quietStart, d.quietStartMinutes),
    quietEndMinutes: hm(f.quietEnd, d.quietEndMinutes),
    tzOffsetMinutes: num(f.tzOffsetMinutes, d.tzOffsetMinutes, -12 * 60, 14 * 60),
  };
}

/**
 * Local wall-clock minutes after midnight for a UTC instant under the fixed
 * tenant offset (pure UTC+offset math — immune to host timezone and DST).
 */
export function localMinutesAfterMidnight(nowUtc: Date, policy: MarketingFrequencyPolicy): number {
  const shifted = nowUtc.getTime() + policy.tzOffsetMinutes * 60_000;
  const dayMs = 24 * 60 * 60_000;
  const msIntoDay = ((shifted % dayMs) + dayMs) % dayMs;
  return Math.floor(msIntoDay / 60_000);
}

/** True when `nowUtc` falls inside the tenant's quiet hours. */
export function isQuietHours(nowUtc: Date, policy: MarketingFrequencyPolicy): boolean {
  const m = localMinutesAfterMidnight(nowUtc, policy);
  const { quietStartMinutes: s, quietEndMinutes: e } = policy;
  if (s === e) return false; // disabled
  return s < e ? m >= s && m < e : m >= s || m < e; // overnight window (21:00–08:00)
}

/**
 * If `nowUtc` is inside quiet hours, return the next quiet-hours END as a UTC
 * instant; otherwise return `nowUtc` unchanged.
 */
export function adjustForQuietHours(nowUtc: Date, policy: MarketingFrequencyPolicy): Date {
  if (!isQuietHours(nowUtc, policy)) return nowUtc;
  const { quietEndMinutes: e, tzOffsetMinutes } = policy;
  const shifted = nowUtc.getTime() + tzOffsetMinutes * 60_000;
  const dayMs = 24 * 60 * 60_000;
  const msIntoDay = ((shifted % dayMs) + dayMs) % dayMs;
  const endMs = e * 60_000;
  // Time until the next local quiet-end, in shifted (local) milliseconds.
  let delta = endMs - msIntoDay;
  if (delta <= 0) delta += dayMs;
  return new Date(nowUtc.getTime() + delta);
}

/**
 * Pure scheduling decision (unit-tested directly):
 * given the timestamps of a customer's recent marketing sends (ascending or
 * unordered), decide the earliest instant a new marketing send is allowed.
 *
 * - Fewer than `maxPerWindow` sends inside the window → allowed now (modulo
 *   quiet hours).
 * - Cap reached → defer until the oldest of the last `maxPerWindow` sends
 *   ages out of the window, then re-apply quiet hours.
 */
export function computeNextAllowedSendAt(
  now: Date,
  recentSendAts: Date[],
  policy: MarketingFrequencyPolicy = DEFAULT_MARKETING_FREQUENCY_POLICY,
): Date {
  const windowMs = policy.windowDays * 24 * 60 * 60_000;
  const cutoff = now.getTime() - windowMs;
  const inWindow = recentSendAts
    .map((d) => d.getTime())
    .filter((t) => Number.isFinite(t) && t > cutoff && t <= now.getTime() + 60_000)
    .sort((a, b) => a - b);
  let candidate: Date;
  if (inWindow.length >= policy.maxPerWindow) {
    // The send that must age out is the (len - max)-th oldest in the window.
    const blocker = inWindow[inWindow.length - policy.maxPerWindow];
    candidate = new Date(blocker + windowMs + 1_000); // +1s: strictly outside the window
  } else {
    candidate = now;
  }
  return adjustForQuietHours(candidate, policy);
}

type DbLike = { execute: (q: any) => Promise<any> };

// ─── Clock seam (test/simulation only) ───────────────────────────────────────
// The marketing send paths consult quiet hours (21:00–08:00 Africa/Lagos)
// against the wall clock, which made time-of-day-dependent simulations
// (e.g. journey J91) flaky. This override lets a simulation pin the clock the
// frequency policy sees. Production code never sets it.
let marketingClockOverride: (() => Date) | null = null;

/** Test/simulation seam: pin (or clear, with null) the marketing-frequency clock. */
export function setMarketingClockOverride(fn: (() => Date) | null): void {
  marketingClockOverride = fn;
}

/** The current instant as seen by the marketing frequency policy. */
export function marketingNow(): Date {
  return marketingClockOverride?.() ?? new Date();
}

/**
 * Recent marketing send timestamps for (tenant, phone) from
 * whatsapp_notification_log. Defensive: any query error yields [] (fail
 * open on scheduling metadata, never on consent).
 */
export async function recentMarketingSends(
  db: DbLike,
  tenantId: string,
  phone: string,
  windowDays: number,
  now: Date,
): Promise<Date[]> {
  try {
    const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60_000);
    const to = normalizeWaPhone(phone);
    const res: any = await db.execute(sql`
      SELECT "sentAt" AS sent_at FROM whatsapp_notification_log
      WHERE "tenantId" = ${tenantId}
        AND "phone" = ${to}
        AND "notifType" IN ('broadcast', 'journey_template')
        AND "sentAt" IS NOT NULL
        AND "sentAt" > ${cutoff.toISOString()}
      ORDER BY "sentAt" ASC
    `);
    const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
    return rows
      .map((r) => (r?.sent_at ? new Date(r.sent_at) : null))
      .filter((d): d is Date => !!d && !Number.isNaN(d.getTime()));
  } catch (e: any) {
    console.warn("[frequencyCap] marketing-send lookup failed (treating as none):", e?.message);
    return [];
  }
}

export interface NextAllowedSendAtOpts {
  tenantId: string;
  phone: string;
  now?: Date;
  policy?: MarketingFrequencyPolicy;
  /** Test seam: override the recent-send lookup. */
  countSends?: (windowDays: number, now: Date) => Promise<Date[]>;
}

/**
 * Earliest allowed instant for the next marketing send to this customer.
 * Journey execution defers `nextRunAt` and the broadcast send path defers /
 * skips when this returns a future instant.
 */
export async function nextAllowedSendAt(db: DbLike, opts: NextAllowedSendAtOpts): Promise<Date> {
  const now = opts.now ?? new Date();
  const policy = opts.policy ?? DEFAULT_MARKETING_FREQUENCY_POLICY;
  const sends = opts.countSends
    ? await opts.countSends(policy.windowDays, now)
    : await recentMarketingSends(db, opts.tenantId, opts.phone, policy.windowDays, now);
  return computeNextAllowedSendAt(now, sends, policy);
}

/**
 * Tenant-settings-aware variant used by the send paths: loads the tenant row,
 * resolves the effective policy, then applies the scheduling decision.
 */
export async function nextAllowedSendAtForTenant(
  db: DbLike,
  tenantId: string,
  phone: string,
  now: Date = new Date(),
): Promise<Date> {
  let policy = DEFAULT_MARKETING_FREQUENCY_POLICY;
  try {
    const res: any = await db.execute(sql`SELECT "settings" FROM tenants WHERE "id" = ${tenantId} LIMIT 1`);
    const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
    policy = parseMarketingFrequencyPolicy(rows[0]?.settings);
  } catch { /* defaults */ }
  return nextAllowedSendAt(db, { tenantId, phone, now, policy });
}
