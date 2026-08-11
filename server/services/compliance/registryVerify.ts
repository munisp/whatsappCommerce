/**
 * Business-registry verification (wave 12) — Nigeria CAC + generic adapters.
 *
 * Mirrors the wave-11 payment provider pattern: an env-gated registry selects
 * one provider implementation:
 *
 *   COMPLIANCE_REGISTRY_PROVIDER = 'cac' | 'customHttp' | 'disabled' (default)
 *
 *   cac         — Nigeria Corporate Affairs Commission public registry API.
 *                 Requires CAC_API_BASE and CAC_API_KEY.
 *   customHttp  — declarative env config for any registry:
 *                   COMPLIANCE_REGISTRY_BASE_URL   (required)
 *                   COMPLIANCE_REGISTRY_API_KEY    (optional, sent as Bearer)
 *                   COMPLIANCE_REGISTRY_AUTH_HEADER (optional, default Authorization)
 *   disabled    — always returns status 'unavailable' (fail-closed in prod).
 *
 * Fail-closed semantics: in production with the KYB gate active
 * (KYB_GATE_ACTIVE != 'false'), a provider 'unavailable' result must NOT be
 * treated as verified — `isVerifiedForGate()` enforces this regardless of
 * caller mistakes.
 *
 * No retries on 4xx (deterministic client errors); one retry allowed for
 * network/5xx via `withRetry` is intentionally NOT implemented — registry
 * lookups are advisory and must fail fast to keep onboarding latency low.
 */

import {
  nodeFetchHttp,
  redactSecrets,
  DEFAULT_TIMEOUT_MS,
  type HttpClient,
} from "./fakeHttp";

export type RegistryStatus = "verified" | "mismatch" | "not_found" | "unavailable";

export interface RegistryVerifyInput {
  registrationNumber: string;
  businessName: string;
  country: string; // ISO-ish, e.g. 'NG'
}

export interface RegistryVerifyResult {
  verified: boolean;
  matchedName?: string;
  status: RegistryStatus;
  provider: string;
}

interface RegistryProvider {
  id: string;
  verify(input: RegistryVerifyInput): Promise<RegistryVerifyResult>;
}

/** Normalize a business name for comparison: case, diacritics, punctuation. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token-overlap similarity (Jaccard-style on word sets). */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeName(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeName(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  ta.forEach((t) => {
    if (tb.has(t)) inter++;
  });
  return inter / Math.max(ta.size, tb.size);
}

const NAME_MATCH_THRESHOLD = 0.8;

function secretsToRedact(env: NodeJS.ProcessEnv): string[] {
  return [env.CAC_API_KEY, env.COMPLIANCE_REGISTRY_API_KEY].filter(
    (s): s is string => typeof s === "string",
  );
}

function logSafe(env: NodeJS.ProcessEnv, msg: string, err?: unknown): void {
  const detail = err instanceof Error ? `${msg}: ${err.message}` : msg;
  // eslint-disable-next-line no-console
  console.warn(`[compliance:registry] ${redactSecrets(detail, secretsToRedact(env))}`);
}

/** Nigeria CAC public registry adapter. */
export function createCacProvider(
  env: NodeJS.ProcessEnv,
  http: HttpClient = nodeFetchHttp,
): RegistryProvider | null {
  const base = env.CAC_API_BASE;
  const apiKey = env.CAC_API_KEY;
  if (!base || !apiKey) {
    logSafe(env, "cac provider selected but CAC_API_BASE/CAC_API_KEY missing");
    return null;
  }
  return {
    id: "cac",
    async verify(input) {
      const url = `${base.replace(/\/$/, "")}/search?rcNumber=${encodeURIComponent(
        input.registrationNumber,
      )}`;
      let res;
      try {
        res = await http.request({
          url,
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
          timeoutMs: DEFAULT_TIMEOUT_MS,
        });
      } catch (err) {
        logSafe(env, "cac lookup failed", err);
        return { verified: false, status: "unavailable", provider: "cac" };
      }
      if (res.status === 404) {
        return { verified: false, status: "not_found", provider: "cac" };
      }
      if (res.status >= 400 && res.status < 500) {
        // no retry on 4xx — treat as unavailable, not as a negative result
        logSafe(env, `cac HTTP ${res.status}`);
        return { verified: false, status: "unavailable", provider: "cac" };
      }
      if (res.status >= 500) {
        logSafe(env, `cac HTTP ${res.status}`);
        return { verified: false, status: "unavailable", provider: "cac" };
      }
      const body = res.body as Record<string, unknown> | null;
      const matchedName =
        (body && typeof body.companyName === "string" && body.companyName) ||
        (body && typeof body.name === "string" && body.name) ||
        undefined;
      if (!matchedName) {
        return { verified: false, status: "not_found", provider: "cac" };
      }
      const score = nameSimilarity(input.businessName, matchedName);
      if (score >= NAME_MATCH_THRESHOLD) {
        return { verified: true, matchedName, status: "verified", provider: "cac" };
      }
      return { verified: false, matchedName, status: "mismatch", provider: "cac" };
    },
  };
}

/** Declarative custom HTTP registry adapter. */
export function createCustomHttpRegistryProvider(
  env: NodeJS.ProcessEnv,
  http: HttpClient = nodeFetchHttp,
): RegistryProvider | null {
  const base = env.COMPLIANCE_REGISTRY_BASE_URL;
  if (!base) {
    logSafe(env, "customHttp provider selected but COMPLIANCE_REGISTRY_BASE_URL missing");
    return null;
  }
  const apiKey = env.COMPLIANCE_REGISTRY_API_KEY;
  const authHeader = env.COMPLIANCE_REGISTRY_AUTH_HEADER ?? "Authorization";
  return {
    id: "customHttp",
    async verify(input) {
      const url = `${base.replace(/\/$/, "")}/verify?registrationNumber=${encodeURIComponent(
        input.registrationNumber,
      )}&country=${encodeURIComponent(input.country)}`;
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) headers[authHeader] = `Bearer ${apiKey}`;
      let res;
      try {
        res = await http.request({ url, headers, timeoutMs: DEFAULT_TIMEOUT_MS });
      } catch (err) {
        logSafe(env, "customHttp registry lookup failed", err);
        return { verified: false, status: "unavailable", provider: "customHttp" };
      }
      if (res.status === 404) {
        return { verified: false, status: "not_found", provider: "customHttp" };
      }
      if (res.status >= 400) {
        logSafe(env, `customHttp registry HTTP ${res.status}`);
        return { verified: false, status: "unavailable", provider: "customHttp" };
      }
      const body = res.body as Record<string, unknown> | null;
      const found = body?.found === true || body?.status === "active";
      const matchedName =
        body && typeof body.businessName === "string" ? body.businessName : undefined;
      if (!found || !matchedName) {
        return { verified: false, status: "not_found", provider: "customHttp" };
      }
      const score = nameSimilarity(input.businessName, matchedName);
      if (score >= NAME_MATCH_THRESHOLD) {
        return { verified: true, matchedName, status: "verified", provider: "customHttp" };
      }
      return { verified: false, matchedName, status: "mismatch", provider: "customHttp" };
    },
  };
}

const disabledProvider: RegistryProvider = {
  id: "disabled",
  async verify() {
    return { verified: false, status: "unavailable", provider: "disabled" };
  },
};

/** Select the configured provider; misconfiguration degrades to 'disabled'. */
export function selectRegistryProvider(
  env: NodeJS.ProcessEnv = process.env,
  http: HttpClient = nodeFetchHttp,
): RegistryProvider {
  const id = (env.COMPLIANCE_REGISTRY_PROVIDER ?? "disabled").trim();
  switch (id) {
    case "cac":
      return createCacProvider(env, http) ?? disabledProvider;
    case "customHttp":
      return createCustomHttpRegistryProvider(env, http) ?? disabledProvider;
    default:
      return disabledProvider;
  }
}

/**
 * Verify a business registration against the configured registry provider.
 * Never throws — all failure modes collapse into status 'unavailable'.
 */
export async function verifyBusinessRegistration(
  input: RegistryVerifyInput,
  deps: { env?: NodeJS.ProcessEnv; http?: HttpClient } = {},
): Promise<RegistryVerifyResult> {
  const env = deps.env ?? process.env;
  try {
    const provider = selectRegistryProvider(env, deps.http);
    return await provider.verify(input);
  } catch (err) {
    logSafe(env, "unexpected registry verification error", err);
    return { verified: false, status: "unavailable", provider: "unknown" };
  }
}

/**
 * Fail-closed gate semantics: in production with the KYB gate active,
 * 'unavailable' can NEVER count as verified. Dev environments with the gate
 * explicitly disabled may treat unavailable as passable.
 */
export function isVerifiedForGate(
  result: RegistryVerifyResult,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const gateActive = (env.KYB_GATE_ACTIVE ?? "true") !== "false";
  const isProd = env.NODE_ENV === "production";
  // Fail-closed: with the gate active in production, ONLY a positive registry
  // match counts. 'unavailable', 'not_found' and 'mismatch' never pass.
  // In dev/staging with the gate off we still never fabricate a verification,
  // so this function is intentionally conservative in every environment.
  void gateActive;
  void isProd;
  return result.verified && result.status === "verified";
}
