/**
 * Credit-bureau PULL adapter (W18, roadmap F3 part 3).
 *
 * Complements the W14 PUSH adapter (compliance/bureau.ts): where push
 * REPORTS credit events to the bureau, this module PULLS a credit report
 * for a subject (buyer) at facility-approval time. Wired into
 * approveCreditAccountTx (accounts.ts) behind BUREAU_PULL_REQUIRED.
 *
 * Providers (BUREAU_PULL_PROVIDER, default 'disabled'):
 *   - 'disabled': no-op — pullReport returns null and logs a structured
 *     'bureau_pull_disabled' line. Approval is untouched.
 *   - 'sandbox': deterministic hash-derived report from the subject +
 *     consentRef — same input always yields the same report (testing).
 *   - 'http': generic POST to BUREAU_PULL_URL with BUREAU_PULL_API_KEY as a
 *     bearer token; 8s default timeout (BUREAU_PULL_TIMEOUT_MS override);
 *     the response is validated by zod — malformed bodies are errors.
 *
 * Guarantees:
 *   - pullBureauReport NEVER throws: on any failure it returns
 *     { report: null, error } and logs a warn line. Bureau outages must
 *     never block the money/approval path.
 *   - Consent is mandatory: callers pass the bureau_consent_ref captured at
 *     request/approve time; the fail-closed policy (required + no consent →
 *     decline) lives in the approval wiring, not here.
 *   - Secrets never leave the process: the api key is sent only in the
 *     Authorization header and redacted from any error text.
 *
 * Tests inject a FakeHttp (compliance/fakeHttp.ts) — no real network.
 */

import { createHash } from "crypto";
import { z } from "zod";
import {
  nodeFetchHttp,
  redactSecrets,
  DEFAULT_TIMEOUT_MS,
  type HttpClient,
} from "../compliance/fakeHttp";

// ── Types ───────────────────────────────────────────────────────────────────

export type BureauPullProvider = "disabled" | "sandbox" | "http";

export interface BureauSubject {
  phone?: string;
  bvn?: string;
  businessName?: string;
}

export interface BureauReport {
  score: number | null;
  totalFacilities: number;
  activeDefaults: number;
  delinquentCount: number;
  enquiryCount90d: number;
  rawRef: string;
}

export interface BureauPullAdapter {
  name: BureauPullProvider;
  /**
   * Pull one report for the subject. Returns null when no report is
   * available (disabled provider). Throws on transport/validation failure —
   * callers must treat a throw as "no report" (see pullBureauReport).
   */
  pullReport(subject: BureauSubject, consentRef: string): Promise<BureauReport | null>;
}

export interface BureauPullDeps {
  env?: NodeJS.ProcessEnv;
  http?: HttpClient;
}

export interface BureauPullResult {
  provider: BureauPullProvider;
  report: BureauReport | null;
  error?: string;
}

// ── Config ──────────────────────────────────────────────────────────────────

export function bureauPullProvider(env: NodeJS.ProcessEnv = process.env): BureauPullProvider {
  const raw = (env.BUREAU_PULL_PROVIDER ?? "disabled").trim().toLowerCase();
  if (raw === "sandbox" || raw === "http") return raw;
  return "disabled";
}

/** BUREAU_PULL_REQUIRED=true makes the bureau pull a hard approval gate. */
export function bureauPullRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.BUREAU_PULL_REQUIRED ?? "").trim().toLowerCase() === "true";
}

/** Minimum bureau score for approval when the pull is required (default 300). */
export function bureauPullMinScore(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BUREAU_PULL_MIN_SCORE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 300;
}

export function bureauPullTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BUREAU_PULL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS; // 8s default
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Upstream http response contract — malformed bodies are rejected. */
export const bureauReportSchema = z.object({
  score: z.number().int().min(0).max(1000).nullable(),
  totalFacilities: z.number().int().min(0),
  activeDefaults: z.number().int().min(0),
  delinquentCount: z.number().int().min(0),
  enquiryCount90d: z.number().int().min(0),
  rawRef: z.string().min(1).max(128),
});

// ── Logging ─────────────────────────────────────────────────────────────────

function logLine(level: "info" | "warn", metric: string, extra: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify({ level, metric, ...extra }) + "\n");
  } catch {
    /* logging must never break the approval path */
  }
}

// ── Adapters ────────────────────────────────────────────────────────────────

/**
 * Deterministic sandbox report: sha256 over the STABLE subject fields +
 * consentRef. Same subject always yields the same report, so approval-flow
 * tests can assert on thresholds without mocking.
 */
function sandboxReport(subject: BureauSubject, consentRef: string): BureauReport {
  const seed = [subject.phone ?? "", subject.bvn ?? "", subject.businessName ?? "", consentRef].join("|");
  const digest = createHash("sha256").update(seed).digest();
  const n = (off: number) => digest.readUInt32BE(off * 4);
  return {
    score: 200 + (n(0) % 651), // 200..850
    totalFacilities: n(1) % 12,
    activeDefaults: n(2) % 3,
    delinquentCount: n(3) % 5,
    enquiryCount90d: n(4) % 10,
    rawRef: `sandbox:${digest.subarray(20, 36).toString("hex")}`,
  };
}

function httpPullAdapter(deps: BureauPullDeps): BureauPullAdapter {
  const env = deps.env ?? process.env;
  const http = deps.http ?? nodeFetchHttp;
  return {
    name: "http",
    async pullReport(subject, consentRef) {
      const url = (env.BUREAU_PULL_URL ?? "").trim();
      if (!url) throw new Error("BUREAU_PULL_URL is required for provider 'http'");
      const apiKey = (env.BUREAU_PULL_API_KEY ?? "").trim();
      const res = await http.request({
        url,
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          phone: subject.phone ?? null,
          bvn: subject.bvn ?? null,
          business_name: subject.businessName ?? null,
          consent_ref: consentRef,
        }),
        timeoutMs: bureauPullTimeoutMs(env),
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(redactSecrets(`bureau pull responded HTTP ${res.status}`, [apiKey]));
      }
      const parsed = bureauReportSchema.safeParse(res.body);
      if (!parsed.success) {
        throw new Error(
          redactSecrets(`bureau pull response failed validation: ${parsed.error.issues[0]?.message ?? "invalid"}`, [apiKey]),
        );
      }
      return parsed.data;
    },
  };
}

/**
 * Resolve the configured pull adapter. 'disabled' (default) is an explicit
 * no-op whose pullReport returns null and logs 'bureau_pull_disabled'.
 */
export function getBureauPullAdapter(deps: BureauPullDeps = {}): BureauPullAdapter {
  const provider = bureauPullProvider(deps.env);
  switch (provider) {
    case "sandbox":
      return { name: "sandbox", async pullReport(subject, consentRef) { return sandboxReport(subject, consentRef); } };
    case "http":
      return httpPullAdapter(deps);
    default:
      return {
        name: "disabled",
        async pullReport() {
          logLine("info", "bureau_pull_disabled", { provider: "disabled" });
          return null;
        },
      };
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Pull one bureau report for a subject. NEVER throws — on any failure
 * returns { report: null, error } and logs a warn line, so an upstream
 * outage can never block facility approval.
 */
export async function pullBureauReport(
  subject: BureauSubject,
  consentRef: string,
  deps: BureauPullDeps = {},
): Promise<BureauPullResult> {
  const adapter = getBureauPullAdapter(deps);
  try {
    const report = await adapter.pullReport(subject, consentRef);
    return { provider: adapter.name, report };
  } catch (err: any) {
    const apiKey = ((deps.env ?? process.env).BUREAU_PULL_API_KEY ?? "").trim();
    const message = redactSecrets(String(err?.message ?? err), apiKey ? [apiKey] : []);
    logLine("warn", "bureau_pull_failed", {
      provider: adapter.name,
      consentRef,
      error: message,
    });
    return { provider: adapter.name, report: null, error: message };
  }
}
