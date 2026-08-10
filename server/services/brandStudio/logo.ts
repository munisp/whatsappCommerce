/**
 * brandStudio/logo.ts — deterministic logo generation.
 *
 * Two tiers:
 *   1. Monogram (always available, zero deps): initials from the business
 *      name on a low-saturation palette derived from a hash of the name —
 *      same name → same logo, fully unit-testable, crisp SVG at any size.
 *   2. AI provider (opt-in, safe-default OFF): when IMAGE_GEN_API_KEY or
 *      OPENAI_API_KEY is set, attempt a real generated mark via the images
 *      API. ANY failure falls back to the monogram silently.
 *
 * Palette discipline: every generated color passes through clampSaturation()
 * (max 45% HSL saturation) so no neon output is possible.
 */

// ─── Color math ──────────────────────────────────────────────────────────────

/** Saturation ceiling for all generated brand colors (HSL, 0–1). */
export const MAX_SATURATION = 0.45;

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return { h: 0, s: 0, l: 0.5 };
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

export function hslToHex(h: number, s: number, l: number): string {
  const hn = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hn < 60) [r, g, b] = [c, x, 0];
  else if (hn < 120) [r, g, b] = [x, c, 0];
  else if (hn < 180) [r, g, b] = [0, c, x];
  else if (hn < 240) [r, g, b] = [0, x, c];
  else if (hn < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

/**
 * Hard guarantee that a color stays tasteful: any hex with HSL saturation
 * above MAX_SATURATION is pulled down to the ceiling. Neon in → muted out.
 */
export function clampSaturation(hex: string, max: number = MAX_SATURATION): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, Math.min(s, max), l);
}

// ─── Deterministic seed ──────────────────────────────────────────────────────

/** FNV-1a 32-bit hash — stable across runs/processes (unlike Math.random). */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (const ch of input.normalize("NFC")) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Derive a muted complementary palette from a seed.
 * primary: hue = seed % 360, s ∈ [0.25, 0.40], l ∈ [0.32, 0.46]
 * secondary: hue offset +150°–210°, lower lightness (accent, not rival).
 */
export function derivePalette(seed: number): { primaryColor: string; secondaryColor: string } {
  const h = seed % 360;
  const s = 0.25 + ((seed >>> 9) % 16) / 100; // 0.25–0.40
  const l = 0.32 + ((seed >>> 17) % 15) / 100; // 0.32–0.46
  const h2 = (h + 150 + ((seed >>> 24) % 60)) % 360; // 150°–210° complement
  const s2 = 0.20 + ((seed >>> 13) % 15) / 100; // 0.20–0.34
  const l2 = 0.55 + ((seed >>> 21) % 15) / 100; // 0.55–0.69 (lighter accent)
  return {
    primaryColor: clampSaturation(hslToHex(h, s, l)),
    secondaryColor: clampSaturation(hslToHex(h2, s2, l2)),
  };
}

// ─── Monogram ────────────────────────────────────────────────────────────────

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
};

export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

/**
 * Initials for the monogram:
 *   "Adire Threads" → "AT"     (first letter of first two words)
 *   "Zara"          → "ZA"     (first two letters of a single word)
 *   "X"             → "X"
 *   "Élodie Café"   → "ÉC"     (unicode-aware, NFC-normalized)
 *   "  "            → "?"      (degenerate input never crashes)
 * Skips non-letter leading characters (digits, emoji, punctuation).
 */
export function initialsFromName(name: string): string {
  const words = (name ?? "").normalize("NFC").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = (w: string) => Array.from(w).filter((ch) => /\p{L}/u.test(ch));
  if (words.length === 1) {
    const chars = letters(words[0]);
    return (chars.slice(0, 2).join("") || "?").toUpperCase();
  }
  const picked = words
    .map((w) => letters(w)[0] ?? "")
    .filter(Boolean)
    .slice(0, 2)
    .join("");
  return (picked || "?").toUpperCase();
}

/** Light monogram foreground that reads on any palette background. */
export const MONOGRAM_FG = "#F5F2EC";

export function buildMonogramSvg(initials: string, background: string, foreground: string = MONOGRAM_FG): string {
  const text = xmlEscape(initials);
  const fontSize = initials.length > 1 ? 200 : 240;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="logo">` +
    `<rect width="512" height="512" rx="96" fill="${xmlEscape(background)}"/>` +
    `<text x="256" y="262" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" ` +
    `font-weight="600" letter-spacing="8" fill="${xmlEscape(foreground)}" ` +
    `text-anchor="middle" dominant-baseline="central">${text}</text>` +
    `</svg>`
  );
}

export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export interface MonogramLogo {
  initials: string;
  primaryColor: string;
  secondaryColor: string;
  svg: string;
  dataUri: string;
}

/** Deterministic: same businessName always yields the same monogram+palette. */
export function generateMonogramLogo(businessName: string): MonogramLogo {
  const name = (businessName ?? "").trim() || "Shop";
  const seed = hashSeed(name);
  const { primaryColor, secondaryColor } = derivePalette(seed);
  const initials = initialsFromName(name);
  const svg = buildMonogramSvg(initials, primaryColor);
  return { initials, primaryColor, secondaryColor, svg, dataUri: svgToDataUri(svg) };
}

// ─── AI provider (opt-in, safe-default OFF) ──────────────────────────────────

export interface AiLogoResult {
  /** Either an https URL or a data: URI for the generated mark. */
  logoUrl: string;
  mime: string;
  /** Raw bytes when the provider returned base64 (null for plain URLs). */
  bytes: Buffer | null;
}

function imageGenConfig(): { apiKey: string; apiUrl: string; model: string } | null {
  const apiKey = process.env.IMAGE_GEN_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!apiKey) return null; // safe default: OFF unless explicitly configured
  return {
    apiKey,
    apiUrl: process.env.IMAGE_GEN_API_URL || "https://api.openai.com/v1/images/generations",
    model: process.env.IMAGE_GEN_MODEL || "gpt-image-1",
  };
}

/**
 * Attempt a real generated logo mark. Returns null on ANY failure (missing
 * config, network error, bad payload) — callers always keep the monogram.
 */
export async function tryGenerateAiLogo(businessName: string, vibe?: string): Promise<AiLogoResult | null> {
  const cfg = imageGenConfig();
  if (!cfg) return null;
  try {
    const prompt =
      `Minimal flat vector logo mark for a small business named "${businessName}"` +
      (vibe ? ` with a ${vibe} feel` : "") +
      ", muted low-saturation colors, simple geometric monogram style, plain background, no text watermark";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let res: Response;
    try {
      res = await fetch(cfg.apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, prompt, size: "1024x1024", n: 1 }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      console.warn(`[brandStudio] image provider HTTP ${res.status} — falling back to monogram`);
      return null;
    }
    const body: any = await res.json();
    const first = body?.data?.[0];
    if (typeof first?.b64_json === "string" && first.b64_json.length > 0) {
      return { logoUrl: `data:image/png;base64,${first.b64_json}`, mime: "image/png", bytes: Buffer.from(first.b64_json, "base64") };
    }
    if (typeof first?.url === "string" && /^https:\/\//.test(first.url)) {
      return { logoUrl: first.url, mime: "image/png", bytes: null };
    }
    console.warn("[brandStudio] image provider returned no usable image — falling back to monogram");
    return null;
  } catch (e: any) {
    console.warn(`[brandStudio] image generation failed (${e?.message ?? e}) — falling back to monogram`);
    return null;
  }
}
