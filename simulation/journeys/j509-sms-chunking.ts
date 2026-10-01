// === W50 SMS ===
/**
 * J509 — SMS segmentation limits: 160 GSM-7 / 70 UCS-2 single, 153/67
 * concatenated, capped at 3 parts (overflow truncated, never silently
 * billed into unbounded multi-part).
 *
 *   1. ≤160 GSM-7 → single segment; encoding gsm7.
 *   2. 170 GSM-7 chars → 2 parts, each ≤153.
 *   3. Non-GSM text (CJK) → ucs2, 70/67 limits.
 *   4. Very long body → exactly 3 parts, truncated=true, ellipsis marker.
 *   5. stripSmsChrome: emoji/markdown/media annotations removed.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J509",
  name: "SMS chunking (160 GSM-7 / 70 UCS-2, max 3 parts)",
  feature: "W50 SMS: segmentation + rich-chrome stripping",
  async run(_world: World) {
    const { chunkSmsText, smsEncodingFor, stripSmsChrome, SMS_MAX_PARTS } = await import("../../server/services/smsSender");

    // ── 1. Single GSM-7 segment ────────────────────────────────────────
    const short = "Your order 1234 is ready for pickup.".padEnd(160, ".");
    const s = chunkSmsText(short);
    assert(s.chunks.length === 1 && s.encoding === "gsm7" && !s.truncated, "160 GSM-7 chars = 1 segment");

    // ── 2. Multi-part GSM-7 ────────────────────────────────────────────
    const long = "word ".repeat(40).trim(); // 199 chars
    const m = chunkSmsText(long);
    assert(m.chunks.length === 2, `199 GSM-7 chars → 2 parts (got ${m.chunks.length})`);
    for (const c of m.chunks) assert(c.length <= 153, `concat part ≤153 (got ${c.length})`);
    assert(m.chunks.join(" ").replace(/\s+/g, " ").includes("word"), "no content lost in 2-part split");
    assert(!m.truncated, "2-part split not truncated");

    // ── 3. UCS-2 ───────────────────────────────────────────────────────
    assert(smsEncodingFor("你好") === "ucs2", "CJK detected as ucs2");
    const ucs2 = "汉".repeat(100); // 100 ucs2 chars → 67/33
    const u = chunkSmsText(ucs2);
    assert(u.encoding === "ucs2" && u.chunks.length === 2, "100 ucs2 chars → 2 parts");
    for (const c of u.chunks) assert(c.length <= 67, `ucs2 concat part ≤67 (got ${c.length})`);
    const single70 = chunkSmsText("汉".repeat(70));
    assert(single70.chunks.length === 1, "70 ucs2 chars = 1 segment");

    // ── 4. Cap at 3 parts ──────────────────────────────────────────────
    assert(SMS_MAX_PARTS === 3, "SMS_MAX_PARTS = 3");
    const huge = "lorem ipsum dolor sit amet ".repeat(40); // ~1080 chars
    const h = chunkSmsText(huge);
    assert(h.chunks.length === 3, `huge body capped at 3 parts (got ${h.chunks.length})`);
    assert(h.truncated === true, "overflow flagged truncated");
    assert(h.chunks[2].endsWith("…"), "truncated part carries ellipsis marker");
    for (const c of h.chunks) assert(c.length <= 153, "every part ≤153");

    // ── 5. Chrome stripping ────────────────────────────────────────────
    const stripped = stripSmsChrome("Hello *World* 🎉\n\n[image: catalog.jpg] Your **total** is NGN 2,500 ✅");
    assert(!/[\uD800-\uDBFF]/.test(stripped), "emoji removed");
    assert(!stripped.includes("[image"), "media annotation removed");
    assert(!stripped.includes("*"), "markdown emphasis removed");
    assert(stripped.includes("World") && stripped.includes("NGN 2,500"), "plain text content preserved");
    const packish = stripSmsChrome("Reply 1 for menu");
    assert(packish === "Reply 1 for menu", "already-plain text passes through unchanged");
  },
};
