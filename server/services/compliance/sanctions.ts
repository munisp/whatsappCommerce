/**
 * Sanctions screening (wave 12).
 *
 * Sources, in priority order:
 *   1. SANCTIONS_LIST_URL — remote consolidated list (OFAC/UN/EU style),
 *      CSV or JSON, fetched with an 8s timeout and cached for 24h.
 *   2. Last-good cache (if the remote fetch fails but a cache entry exists,
 *      the stale cache is used and `staleCache` is flagged).
 *   3. Offline bundled minimal list (dev fallback only).
 *
 * Production fail-closed posture: if the list cannot be loaded from ANY
 * source (no remote, no cache, and the bundled list is explicitly disabled
 * via SANCTIONS_ALLOW_BUNDLED='false'), screening returns a DEGRADED
 * conservative result: { hit: true, matches: [], degraded: true }. Callers
 * must route degraded results to manual review — never auto-pass.
 *
 * Matching: normalize case/diacritics/punctuation, then token overlap
 * (containment) ≥ 0.8 counts as a fuzzy hit.
 */

import {
  nodeFetchHttp,
  redactSecrets,
  DEFAULT_TIMEOUT_MS,
  type HttpClient,
} from "./fakeHttp";
import { normalizeName, nameSimilarity } from "./registryVerify";

export interface SanctionsEntry {
  name: string;
  id?: string;
  list: string; // e.g. 'OFAC-SDN', 'UN', 'EU', 'BUNDLED'
}

export interface SanctionsMatch {
  name: string;
  score: number;
  list: string;
}

export interface SanctionsScreenResult {
  hit: boolean;
  matches: SanctionsMatch[];
  screenedAt: string; // ISO
  degraded?: boolean; // true => conservative fail-closed result, manual review required
  staleCache?: boolean;
  source: "remote" | "cache" | "bundled" | "degraded";
}

export interface ScreenInput {
  name: string;
  registrationNumber?: string;
}

export const MATCH_THRESHOLD = 0.8;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Minimal bundled list for DEV fallback only. Production must use a real
 * consolidated list via SANCTIONS_LIST_URL. Entries are placeholders of
 * well-known designated-entity name patterns.
 */
export const BUNDLED_MINIMAL_LIST: SanctionsEntry[] = [
  { name: "AL QAIDA", list: "BUNDLED" },
  { name: "ISLAMIC STATE OF IRAQ AND THE LEVANT", list: "BUNDLED" },
  { name: "BOKO HARAM", list: "BUNDLED" },
  { name: "ANSARU", list: "BUNDLED" },
  { name: "KOREA KWANGSON BANKING CORP", list: "BUNDLED" },
];

// ---------------------------------------------------------------------------
// Parsing (CSV / JSON consolidated-list formats)
// ---------------------------------------------------------------------------

export function parseSanctionsList(body: unknown, listLabel = "REMOTE"): SanctionsEntry[] {
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return parseSanctionsList(JSON.parse(trimmed), listLabel);
      } catch {
        return [];
      }
    }
    return parseCsv(trimmed, listLabel);
  }
  if (Array.isArray(body)) {
    const out: SanctionsEntry[] = [];
    for (const row of body) {
      if (row && typeof row === "object") {
        const r = row as Record<string, unknown>;
        const name =
          (typeof r.name === "string" && r.name) ||
          (typeof r.fullName === "string" && r.fullName) ||
          (typeof r.entityName === "string" && r.entityName) ||
          "";
        if (name) {
          out.push({
            name,
            id: typeof r.id === "string" || typeof r.id === "number" ? String(r.id) : undefined,
            list: typeof r.list === "string" ? r.list : listLabel,
          });
        }
      } else if (typeof row === "string" && row.trim()) {
        out.push({ name: row.trim(), list: listLabel });
      }
    }
    return out;
  }
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const key of ["entries", "sanctions", "results", "data"]) {
      if (Array.isArray(b[key])) return parseSanctionsList(b[key], listLabel);
    }
  }
  return [];
}

function parseCsv(text: string, listLabel: string): SanctionsEntry[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = lines[0].toLowerCase().split(",").map((h) => h.trim());
  const hasHeader = header.includes("name");
  const nameIdx = hasHeader ? header.indexOf("name") : 0;
  const idIdx = hasHeader ? header.indexOf("id") : 1;
  const listIdx = hasHeader ? header.indexOf("list") : 2;
  const rows = hasHeader ? lines.slice(1) : lines;
  const out: SanctionsEntry[] = [];
  for (const line of rows) {
    const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const name = cols[nameIdx];
    if (!name || name.toLowerCase() === "name") continue;
    out.push({
      name,
      id: idIdx >= 0 ? cols[idIdx] || undefined : undefined,
      list: (listIdx >= 0 && cols[listIdx]) || listLabel,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  entries: SanctionsEntry[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

/** Test hook: reset the module-level list cache. */
export function __resetSanctionsCache(): void {
  cache = null;
}

export function getCacheAgeMs(now = Date.now()): number | null {
  return cache ? now - cache.fetchedAt : null;
}

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

export function matchEntries(
  input: ScreenInput,
  entries: SanctionsEntry[],
  threshold = MATCH_THRESHOLD,
): SanctionsMatch[] {
  const matches: SanctionsMatch[] = [];
  for (const e of entries) {
    const score = nameSimilarity(input.name, e.name);
    if (score >= threshold) {
      matches.push({ name: e.name, score, list: e.list });
      continue;
    }
    // exact registration-number/id match is a hard hit regardless of name score
    if (
      input.registrationNumber &&
      e.id &&
      input.registrationNumber.trim().toLowerCase() === e.id.trim().toLowerCase()
    ) {
      matches.push({ name: e.name, score: 1, list: e.list });
    }
  }
  return matches.sort((a, b) => b.score - a.score);
}

async function fetchRemoteList(
  env: NodeJS.ProcessEnv,
  http: HttpClient,
): Promise<SanctionsEntry[] | null> {
  const url = env.SANCTIONS_LIST_URL;
  if (!url) return null;
  try {
    const res = await http.request({ url, timeoutMs: DEFAULT_TIMEOUT_MS });
    if (res.status !== 200) return null;
    return parseSanctionsList(res.body, env.SANCTIONS_LIST_LABEL ?? "REMOTE");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[compliance:sanctions] ${redactSecrets(`list fetch failed: ${msg}`, [env.SANCTIONS_LIST_URL])}`);
    return null;
  }
}

/**
 * Screen an entity against the configured sanctions lists. Never throws.
 * See module header for the fail-closed degraded contract.
 */
export async function screenEntity(
  input: ScreenInput,
  deps: { env?: NodeJS.ProcessEnv; http?: HttpClient; now?: number } = {},
): Promise<SanctionsScreenResult> {
  const env = deps.env ?? process.env;
  const http = deps.http ?? nodeFetchHttp;
  const now = deps.now ?? Date.now();
  const screenedAt = new Date(now).toISOString();

  // 1. fresh cache
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS && cache.entries.length > 0) {
    const matches = matchEntries(input, cache.entries);
    return { hit: matches.length > 0, matches, screenedAt, source: "cache" };
  }

  // 2. remote fetch
  const remote = await fetchRemoteList(env, http);
  if (remote && remote.length > 0) {
    cache = { entries: remote, fetchedAt: now };
    const matches = matchEntries(input, remote);
    return { hit: matches.length > 0, matches, screenedAt, source: "remote" };
  }

  // 3. stale cache
  if (cache && cache.entries.length > 0) {
    const matches = matchEntries(input, cache.entries);
    return { hit: matches.length > 0, matches, screenedAt, staleCache: true, source: "cache" };
  }

  // 4. bundled dev fallback (non-prod only)
  // W30 (V2#15): fail-closed polarity — an UNSET NODE_ENV is treated as
  // production (matching the env.ts/kycGate convention), so the 5-entry
  // bundled stub list is usable ONLY in explicit development/test.
  // Previously NODE_ENV-unset silently allowed the bundled stub.
  const allowBundled = (env.SANCTIONS_ALLOW_BUNDLED ?? "true") !== "false";
  const isProd = env.NODE_ENV !== "development" && env.NODE_ENV !== "test";
  if (allowBundled && !isProd) {
    const matches = matchEntries(input, BUNDLED_MINIMAL_LIST);
    return { hit: matches.length > 0, matches, screenedAt, source: "bundled" };
  }

  // 5. DEGRADED — fail-closed. Never auto-pass an unscreened entity.
  return { hit: true, matches: [], screenedAt, degraded: true, source: "degraded" };
}
