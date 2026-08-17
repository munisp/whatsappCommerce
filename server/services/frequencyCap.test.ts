/**
 * W17 F8 — marketing frequency cap + quiet hours scheduler matrix.
 *
 * Covers: cap hit deferral, quiet-hours boundaries (both edges, overnight
 * window), DST-safety (fixed UTC offset, host-tz independent), backfill
 * (oldest send aging out of the window), policy parsing, and the async
 * nextAllowedSendAt wrapper.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKETING_FREQUENCY_POLICY as DEF,
  adjustForQuietHours,
  computeNextAllowedSendAt,
  isQuietHours,
  localMinutesAfterMidnight,
  nextAllowedSendAt,
  parseHm,
  parseMarketingFrequencyPolicy,
} from "./frequencyCap";

const d = (iso: string) => new Date(iso);

describe("parseHm", () => {
  it("parses HH:MM", () => {
    expect(parseHm("21:00")).toBe(1260);
    expect(parseHm("08:30")).toBe(510);
    expect(parseHm("0:05")).toBe(5);
  });
  it("rejects malformed input", () => {
    expect(() => parseHm("25:00")).toThrow();
    expect(() => parseHm("abc")).toThrow();
    expect(() => parseHm("12:60")).toThrow();
  });
});

describe("policy parsing", () => {
  it("defaults: 2 per 7 days, quiet 21:00–08:00 Lagos (UTC+1)", () => {
    expect(DEF.maxPerWindow).toBe(2);
    expect(DEF.windowDays).toBe(7);
    expect(DEF.quietStartMinutes).toBe(21 * 60);
    expect(DEF.quietEndMinutes).toBe(8 * 60);
    expect(DEF.tzOffsetMinutes).toBe(60);
  });
  it("reads tenant settings.marketingFrequency with validation", () => {
    const p = parseMarketingFrequencyPolicy({
      marketingFrequency: { maxPerWindow: 5, windowDays: 3, quietStart: "22:30", quietEnd: "07:15", tzOffsetMinutes: 120 },
    });
    expect(p).toEqual({ maxPerWindow: 5, windowDays: 3, quietStartMinutes: 1350, quietEndMinutes: 435, tzOffsetMinutes: 120 });
  });
  it("falls back to defaults on garbage", () => {
    const p = parseMarketingFrequencyPolicy({ marketingFrequency: { maxPerWindow: -1, quietStart: "nope", tzOffsetMinutes: 99999 } });
    expect(p).toEqual(DEF);
    expect(parseMarketingFrequencyPolicy(null)).toEqual(DEF);
    expect(parseMarketingFrequencyPolicy(undefined)).toEqual(DEF);
  });
});

describe("quiet hours (overnight 21:00–08:00, UTC+1)", () => {
  // Lagos local = UTC + 1h.
  it("inside: 22:00 Lagos (21:00 UTC)", () => {
    expect(isQuietHours(d("2026-03-02T21:00:00Z"), DEF)).toBe(true); // 22:00 local
  });
  it("inside: 03:00 Lagos (02:00 UTC)", () => {
    expect(isQuietHours(d("2026-03-02T02:00:00Z"), DEF)).toBe(true); // 03:00 local
  });
  it("boundary start: 21:00 Lagos is quiet, 20:59 is not", () => {
    expect(isQuietHours(d("2026-03-02T20:00:00Z"), DEF)).toBe(true);  // 21:00 local
    expect(isQuietHours(d("2026-03-02T19:59:00Z"), DEF)).toBe(false); // 20:59 local
  });
  it("boundary end: 08:00 Lagos is open, 07:59 is quiet", () => {
    expect(isQuietHours(d("2026-03-02T07:00:00Z"), DEF)).toBe(false); // 08:00 local
    expect(isQuietHours(d("2026-03-02T06:59:00Z"), DEF)).toBe(true);  // 07:59 local
  });
  it("midday is open", () => {
    expect(isQuietHours(d("2026-03-02T11:00:00Z"), DEF)).toBe(false); // 12:00 local
  });
  it("equal start/end disables quiet hours", () => {
    const p = { ...DEF, quietStartMinutes: 0, quietEndMinutes: 0 };
    expect(isQuietHours(d("2026-03-02T02:00:00Z"), p)).toBe(false);
  });
  it("DST-safe: local time derives from UTC+offset only (host-tz independent)", () => {
    // Same UTC instant must yield the same local minutes regardless of the
    // process timezone — pure arithmetic on the fixed +60 offset.
    expect(localMinutesAfterMidnight(d("2026-06-15T23:30:00Z"), DEF)).toBe(30); // 00:30 local next day
    expect(localMinutesAfterMidnight(d("2026-01-15T23:30:00Z"), DEF)).toBe(30); // same in "winter"
  });
});

describe("adjustForQuietHours", () => {
  it("defers an evening send to 08:00 local next morning", () => {
    const out = adjustForQuietHours(d("2026-03-02T21:30:00Z"), DEF); // 22:30 local
    expect(out.toISOString()).toBe("2026-03-03T07:00:00.000Z");       // 08:00 local
  });
  it("defers an early-morning send to 08:00 local same morning", () => {
    const out = adjustForQuietHours(d("2026-03-02T02:00:00Z"), DEF); // 03:00 local
    expect(out.toISOString()).toBe("2026-03-02T07:00:00.000Z");      // 08:00 local
  });
  it("passes through outside quiet hours", () => {
    const now = d("2026-03-02T12:00:00Z");
    expect(adjustForQuietHours(now, DEF).getTime()).toBe(now.getTime());
  });
});

describe("computeNextAllowedSendAt — cap matrix", () => {
  const noon = d("2026-03-10T11:00:00Z"); // 12:00 Lagos, outside quiet hours

  it("no prior sends → allowed now", () => {
    expect(computeNextAllowedSendAt(noon, [], DEF).getTime()).toBe(noon.getTime());
  });

  it("one send inside the window → still allowed (cap=2)", () => {
    const sends = [d("2026-03-09T11:00:00Z")];
    expect(computeNextAllowedSendAt(noon, sends, DEF).getTime()).toBe(noon.getTime());
  });

  it("cap hit: defers until the oldest of the last 2 sends ages out (+7d)", () => {
    const sends = [d("2026-03-08T11:00:00Z"), d("2026-03-09T11:00:00Z")];
    const out = computeNextAllowedSendAt(noon, sends, DEF);
    // Blocker = 2026-03-08T11:00Z + 7d + 1s = 2026-03-15T11:00:01Z (11:00 UTC = 12:01 local, outside quiet hours)
    expect(out.toISOString()).toBe("2026-03-15T11:00:01.000Z");
  });

  it("backfill: sends older than the window do not count", () => {
    const sends = [d("2026-02-01T11:00:00Z"), d("2026-02-20T11:00:00Z")]; // both > 7d old
    expect(computeNextAllowedSendAt(noon, sends, DEF).getTime()).toBe(noon.getTime());
  });

  it("backfill: one stale + one fresh → allowed (only fresh counts)", () => {
    const sends = [d("2026-02-01T11:00:00Z"), d("2026-03-10T10:00:00Z")];
    expect(computeNextAllowedSendAt(noon, sends, DEF).getTime()).toBe(noon.getTime());
  });

  it("cap expiry landing inside quiet hours is pushed to 08:00 local", () => {
    // Oldest send expires at 2026-03-16T02:00:01Z = 03:00 local → quiet → 07:00Z.
    const sends = [d("2026-03-09T02:00:00Z"), d("2026-03-09T03:00:00Z")];
    const out = computeNextAllowedSendAt(d("2026-03-10T11:00:00Z"), sends, DEF);
    expect(out.toISOString()).toBe("2026-03-16T07:00:00.000Z");
  });

  it("allowed-now inside quiet hours defers to quiet end", () => {
    const night = d("2026-03-10T22:30:00Z"); // 23:30 local
    const out = computeNextAllowedSendAt(night, [], DEF);
    expect(out.toISOString()).toBe("2026-03-11T07:00:00.000Z"); // 08:00 local
  });

  it("unordered input is tolerated", () => {
    const sends = [d("2026-03-09T11:00:00Z"), d("2026-03-08T11:00:00Z")];
    const out = computeNextAllowedSendAt(noon, sends, DEF);
    expect(out.toISOString()).toBe("2026-03-15T11:00:01.000Z");
  });

  it("custom policy (max 1 per 1 day) defers by a day", () => {
    const p = { ...DEF, maxPerWindow: 1, windowDays: 1 };
    const out = computeNextAllowedSendAt(noon, [d("2026-03-10T09:00:00Z")], p);
    expect(out.toISOString()).toBe("2026-03-11T09:00:01.000Z");
  });
});

describe("nextAllowedSendAt (async wrapper)", () => {
  it("uses the injected countSends seam", async () => {
    const now = d("2026-03-10T11:00:00Z");
    const out = await nextAllowedSendAt({} as any, {
      tenantId: "t1",
      phone: "+2348011111111",
      now,
      countSends: async () => [d("2026-03-09T11:00:00Z"), d("2026-03-08T11:00:00Z")],
    });
    expect(out.toISOString()).toBe("2026-03-15T11:00:01.000Z");
  });

  it("db lookup failure fails open (allowed now, outside quiet hours)", async () => {
    const now = d("2026-03-10T11:00:00Z");
    const db = { execute: async () => { throw new Error("boom"); } };
    const out = await nextAllowedSendAt(db as any, { tenantId: "t1", phone: "+2348011111111", now });
    expect(out.getTime()).toBe(now.getTime());
  });

  it("db rows are read from whatsapp_notification_log shape", async () => {
    const now = d("2026-03-10T11:00:00Z");
    const db = {
      execute: async () => ({ rows: [{ sent_at: "2026-03-09T11:00:00Z" }, { sent_at: "2026-03-08T11:00:00Z" }] }),
    };
    const out = await nextAllowedSendAt(db as any, { tenantId: "t1", phone: "+2348011111111", now });
    expect(out.toISOString()).toBe("2026-03-15T11:00:01.000Z");
  });
});
