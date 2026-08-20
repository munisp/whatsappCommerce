/**
 * server/services/discoveryMenu.ts — W25 WhatsApp-native geo discovery menus.
 *
 * PURE helpers (no DB, no deps beyond geoDiscovery types) so unit tests run
 * hermetically:
 *
 *   formatDiscoveryMenu(items, radiusKm)    — numbered nearby-merchant menu,
 *                                             sponsored entries first with the
 *                                             "★ Sponsored: " disclosure prefix
 *   formatCategoryMenu(categories)          — numbered category browse menu
 *   resolveCategorySelection(reply, cats)   — map a text reply (name or
 *                                             1-based index) to a category name
 *   extractDiscoverQuery(text)              — detect "near me" style intents,
 *                                             returning the residual query (""
 *                                             for a bare intent, null when the
 *                                             message is NOT a discovery intent)
 */
import type { CategoryNode, DiscoverItem } from "./geoDiscovery";

/** Max organic (non-sponsored) entries shown in a discovery menu. Sponsored
 *  entries are already capped upstream by GEO_SPONSORED_MAX_PER_PAGE and are
 *  shown as-flagged. */
export const DISCOVERY_MENU_MAX_ORGANIC = 10;

/** Format a distance in km for WhatsApp display. */
function formatKm(km: number): string {
  if (km >= 10) return String(Math.round(km));
  return Number.isInteger(km) ? String(km) : km.toFixed(1);
}

/**
 * Numbered menu of nearby merchants. Sponsored entries come first with the
 * "★ Sponsored: " disclosure prefix (paid-placement labeling), then organic
 * entries; at most DISCOVERY_MENU_MAX_ORGANIC organic rows are shown.
 * Friendly empty state when nothing was found.
 */
export function formatDiscoveryMenu(items: DiscoverItem[], radiusKm: number): string {
  if (items.length === 0) {
    return `🔍 No businesses found within ${formatKm(radiusKm)} km of you yet — try sharing a different location or check back soon.`;
  }
  const sponsored = items.filter((i) => i.sponsored);
  const organic = items.filter((i) => !i.sponsored).slice(0, DISCOVERY_MENU_MAX_ORGANIC);
  const ordered = [...sponsored, ...organic];
  const lines = ordered.map((item, n) => {
    const prefix = item.sponsored ? "★ Sponsored: " : "";
    const category = item.category ?? "Local business";
    return `${n + 1}. ${prefix}${item.businessName} — ${category} · ${formatKm(item.distanceKm)} km`;
  });
  return [`📍 Businesses near you (within ${formatKm(radiusKm)} km):`, ...lines].join("\n");
}

/** Numbered category browse menu (top-level taxonomy categories). */
export function formatCategoryMenu(categories: CategoryNode[]): string {
  if (categories.length === 0) {
    return "No categories are available yet — tell me what you're looking for instead.";
  }
  const lines = categories.map((c, n) => {
    const subs = c.subcategories.slice(0, 3).map((s) => s.name);
    return subs.length > 0 ? `${n + 1}. ${c.name} (${subs.join(", ")})` : `${n + 1}. ${c.name}`;
  });
  return [
    "🗂️ What are you looking for? Reply with a number or category name:",
    ...lines,
  ].join("\n");
}

/**
 * Resolve a user's reply to a category menu: either a 1-based index into the
 * menu or a category/subcategory name (exact, case-insensitive, then partial
 * containment). Returns the matched category NAME (discoverNearby lowercases
 * before matching) or null when the reply does not resolve.
 */
export function resolveCategorySelection(reply: string, categories: CategoryNode[]): string | null {
  const t = reply.trim().toLowerCase();
  if (!t) return null;
  const idx = Number(t);
  if (Number.isInteger(idx) && idx >= 1 && idx <= categories.length) {
    return categories[idx - 1].name;
  }
  for (const c of categories) {
    if (c.name.toLowerCase() === t) return c.name;
    const sub = c.subcategories.find((s) => s.name.toLowerCase() === t);
    if (sub) return c.name; // subcategory name → filter by its parent category
  }
  if (t.length >= 3) {
    for (const c of categories) {
      const n = c.name.toLowerCase();
      if (n.includes(t) || t.includes(n)) return c.name;
    }
  }
  return null;
}

/** Trigger phrases that mark a free-text message as a discovery intent. */
const DISCOVERY_TRIGGER = /\b(near\s*me|nearby|around\s*me|close\s*by|closest|nearest)\b/;

/** Leading filler verbs/phrases stripped from the residual query. */
const LEADING_FILLER = /^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:find|show(?:\s+me)?|search(?:\s+for)?|look(?:\s+for)?|looking\s+for|where\s+is|where's|where\s+are|what's|whats|what\s+is|what|i\s+need|i\s+want|i'm\s+looking\s+for|im\s+looking\s+for|get(?:\s+me)?|any|the|is\s+there|are\s+there)(?:\s+|$)/;

/**
 * Detect a "businesses near me" discovery intent in free text.
 * Returns:
 *  - null  → not a discovery intent
 *  - ""    → bare intent ("near me", "what's nearby") with no query terms
 *  - "x…"  → residual query string ("find a pharmacy near me" → "a pharmacy")
 */
export function extractDiscoverQuery(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!t || !DISCOVERY_TRIGGER.test(t)) return null;
  let r = t
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(DISCOVERY_TRIGGER, " ");
  let prev: string;
  do {
    prev = r.trim();
    r = prev.replace(LEADING_FILLER, "");
  } while (r.trim() !== prev && r.trim().length > 0);
  return r.replace(/\s+/g, " ").trim();
}
