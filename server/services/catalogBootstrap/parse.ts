/**
 * Normalization for extracted catalog items (W15, roadmap F5).
 *
 * Pure functions — no I/O, fully unit-tested:
 *   - name cleanup (OCR noise, bullets, trailing punctuation),
 *   - price parsing to integer cents (₦ / N / $ formats, thousands commas,
 *     decimal major units, ranges "500-700" → lower bound, per-unit suffixes
 *     like "/dozen", "per pack"),
 *   - currency detection with NGN default,
 *   - deterministic confidence scoring,
 *   - dedupe: within the extraction and against the existing catalog.
 */

export const DEFAULT_CURRENCY = "NGN";

export interface ParsedPrice {
  priceCents: number;
  currency: string;
  unit?: string;
  /** true when the source text was a range ("500-700") — lower bound taken. */
  fromRange?: boolean;
}

const CURRENCY_SYMBOLS: Array<[RegExp, string]> = [
  [/₦|\bNGN\b|\bN(?=\s*\d)/i, "NGN"],
  [/GH₵|\bGHS\b/i, "GHS"],
  [/KSh\b|\bKES\b/i, "KES"],
  [/€|\bEUR\b/i, "EUR"],
  [/£|\bGBP\b/i, "GBP"],
  [/US\$|\$|\bUSD\b/i, "USD"],
];

/** Plausibility bounds for a unit price in cents (₦0.50 … ₦10,000,000). */
const MIN_PRICE_CENTS = 50;
const MAX_PRICE_CENTS = 1_000_000_000;

// ── Name cleanup ────────────────────────────────────────────────────────────

/** Clean an OCR'd product name; returns '' when unusable. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let s = raw
    .replace(/[•●▪◦*#>|~_]+/g, " ") // OCR bullets / separators
    .replace(/[^A-Za-z0-9\u00C0-\u024F\s'&().-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Strip leading list markers / stray punctuation and trailing punctuation.
  s = s.replace(/^[-.\s:]+/, "").replace(/[-.,;:]+$/, "").trim();
  if (s.length < 2 || s.length > 120) return "";
  if (!/[A-Za-z\u00C0-\u024F]/.test(s)) return ""; // must contain at least one letter
  // Title-case fully-uppercase OCR output ("RICE 50KG" → "Rice 50kg").
  if (s === s.toUpperCase() && /[A-Z]{3}/.test(s)) {
    s = s.toLowerCase().replace(/(^|\s)([a-z\u00C0-\u024F])/g, (_m, sp, c) => `${sp}${c.toUpperCase()}`);
  }
  return s;
}

/** Case/space-insensitive key for dedupe ("Coca-Cola 50cl" → "coca-cola 50cl"). */
export function normalizeNameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ── Price parsing ───────────────────────────────────────────────────────────

function detectCurrency(text: string): string | null {
  for (const [re, cur] of CURRENCY_SYMBOLS) {
    if (re.test(text)) return cur;
  }
  return null;
}

const UNIT_RE = /(?:\/|per\s+)(dozen|pack|bag|carton|kg|g|litre|liter|cl|ml|piece|pc|set|pair|box|crate|bottle|tin|sachet|roll|yard)s?\b/i;

/**
 * Parse a price expression to integer cents. Accepts:
 *   "₦1,500" "N1500" "1500.00" "$2.50" "500-700" (range → 500)
 *   "₦6,000/dozen" (unit captured) "7.5k"? — NOT supported (ambiguous).
 * Returns null when no plausible price is found.
 */
export function parsePriceText(raw: unknown, defaultCurrency: string = DEFAULT_CURRENCY): ParsedPrice | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const cents = Math.round(raw * 100);
    return plausible(cents) ? { priceCents: cents, currency: defaultCurrency } : null;
  }
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;

  const currency = detectCurrency(text) ?? defaultCurrency;
  const unitM = text.match(UNIT_RE);
  const unit = unitM ? unitM[1].toLowerCase() : undefined;

  // Range "500-700" / "₦500 – ₦700" → lower bound, flagged.
  const rangeM = text.match(/(\d[\d,]*(?:\.\d{1,2})?)\s*[-–—]\s*(\d[\d,]*(?:\.\d{1,2})?)/);
  if (rangeM) {
    const lo = toCents(rangeM[1]);
    const hi = toCents(rangeM[2]);
    if (lo != null && hi != null && hi >= lo && plausible(lo)) {
      return { priceCents: lo, currency, unit, fromRange: true };
    }
    return null;
  }

  const numM = text.match(/\d[\d,]*(?:\.\d{1,2})?/);
  if (!numM) return null;
  const cents = toCents(numM[0]);
  if (cents == null || !plausible(cents)) return null;
  return { priceCents: cents, currency, unit };
}

function toCents(num: string): number | null {
  const cleaned = num.replace(/,/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function plausible(cents: number): boolean {
  return cents >= MIN_PRICE_CENTS && cents <= MAX_PRICE_CENTS;
}

// ── Confidence ──────────────────────────────────────────────────────────────

export interface NormalizedItem {
  name: string;
  priceCents: number;
  currency: string;
  sku?: string;
  unit?: string;
  rawText?: string;
  fromRange?: boolean;
  /** Extraction-provided confidence in [0,1], when present. */
  upstreamConfidence?: number;
}

/**
 * Deterministic confidence in [0,1]:
 *   0.45 base for surviving normalization
 * + 0.25 plausible price present
 * + 0.15 name is 3..60 chars with a letter
 * + 0.10 upstream confidence provided (scaled: +0.10 * upstream)
 * + 0.05 unit or sku present
 * − 0.10 price came from a range
 */
export function scoreConfidence(item: NormalizedItem): number {
  let c = 0.45;
  if (plausible(item.priceCents)) c += 0.25;
  if (item.name.length >= 3 && item.name.length <= 60 && /[A-Za-z\u00C0-\u024F]/.test(item.name)) c += 0.15;
  if (typeof item.upstreamConfidence === "number" && item.upstreamConfidence > 0) {
    c += 0.1 * Math.min(1, item.upstreamConfidence);
  }
  if (item.unit || item.sku) c += 0.05;
  if (item.fromRange) c -= 0.1;
  return Math.round(Math.max(0, Math.min(1, c)) * 100) / 100;
}
