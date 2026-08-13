/**
 * Credit-bureau reporting for the trade-credit book (W14, roadmap F3).
 *
 * Nigerian bureaus: CRC Credit Bureau ('crc') and CreditRegistry
 * ('creditregistry'), plus a declarative 'customHttp' adapter for any
 * REST-shaped bureau endpoint. Default 'disabled' — no network, events are
 * still logged to bureau_report_log as 'pending' so enabling a provider
 * later lets retryFailedReports() backfill.
 *
 * Guarantees:
 *   - reportEvent NEVER throws (fire-and-forget safe from the money path).
 *   - Consent-gated: accounts without bureau_consent_at are EXCLUDED from
 *     reporting (skip + structured log line with reason). Consent is captured
 *     at facility request/approval (routers/tradeCredit.ts).
 *   - Every attempt is persisted to bureau_report_log FIRST (status
 *     'pending'), then the send is attempted (8s default timeout,
 *     BUREAU_TIMEOUT_MS override). Success → 'sent' (+response); failure →
 *     'failed' and the row stays retryable via retryFailedReports().
 *   - Fail-closed in production: with BUREAU_PROVIDER configured, a send
 *     failure additionally raises captureException (severity 'warn') so ops
 *     sees bureau drift instead of silently accumulating pending rows.
 *   - Redaction: API keys never leave the process — payloads are stripped of
 *     secret-ish keys before persist, and logged error text is redacted via
 *     redactSecrets.
 *
 * Tests inject a FakeHttp (see compliance/fakeHttp.ts) — no real network.
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  bureauReportLog,
  creditAccounts,
  type BureauReportLogEntry,
} from "../../../drizzle/schema";
import type { TxHandle } from "../tradeCredit/accounts";
import {
  nodeFetchHttp,
  redactSecrets,
  DEFAULT_TIMEOUT_MS,
  type HttpClient,
} from "./fakeHttp";
import { captureException } from "../observability";
import { isProd } from "../../_core/env";

// ── Types ───────────────────────────────────────────────────────────────────

export type BureauProvider = "disabled" | "crc" | "creditregistry" | "customHttp";

export type BureauEventType =
  | "disbursement"
  | "repayment"
  | "delinquency"
  | "cure"
  | "closure";

export interface BureauEvent {
  accountId: string;
  eventType: BureauEventType;
  payload: Record<string, unknown>;
}

export interface BureauReportResult {
  reported: boolean;
  reason?: "consent_missing" | "provider_disabled" | "account_not_found" | "send_failed";
  logId?: string;
  status?: "pending" | "sent" | "failed";
}

export interface BureauAdapter {
  name: BureauProvider;
  /** Send one event. Returns the parsed upstream response; throws on failure. */
  send(event: BureauEvent): Promise<unknown>;
}

export interface BureauDeps {
  env?: NodeJS.ProcessEnv;
  http?: HttpClient;
}

// ── Config ──────────────────────────────────────────────────────────────────

export function bureauProvider(env: NodeJS.ProcessEnv = process.env): BureauProvider {
  const raw = (env.BUREAU_PROVIDER ?? "disabled").trim().toLowerCase();
  if (raw === "crc" || raw === "creditregistry" || raw === "customhttp") {
    return raw === "customhttp" ? "customHttp" : raw;
  }
  return "disabled";
}

export function bureauTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BUREAU_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS; // 8s default
}

/** Payload keys that must never be persisted or sent off-process. */
const SENSITIVE_KEY_RE = /(token|secret|password|authorization|api[-_]?key)$/i;

/** Recursively strip secret-ish keys from a payload before persist/send. */
export function redactPayload(value: unknown, depth = 0): unknown {
  if (value == null || typeof value !== "object") return value;
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redactPayload(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redactPayload(v, depth + 1);
  }
  return out;
}

// ── Adapters ────────────────────────────────────────────────────────────────

function httpAdapter(
  name: BureauProvider,
  path: string,
  authHeader: (apiKey: string) => Record<string, string>,
  deps: BureauDeps,
): BureauAdapter {
  const env = deps.env ?? process.env;
  const http = deps.http ?? nodeFetchHttp;
  return {
    name,
    async send(event) {
      const base = (env.BUREAU_API_BASE ?? "").trim().replace(/\/+$/, "");
      if (!base) throw new Error(`BUREAU_API_BASE is required for provider '${name}'`);
      const apiKey = (env.BUREAU_API_KEY ?? "").trim();
      const res = await http.request({
        url: `${base}${path}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? authHeader(apiKey) : {}),
        },
        body: JSON.stringify({
          bureau_event: event.eventType,
          account_ref: event.accountId,
          ...redactPayload(event.payload) as Record<string, unknown>,
        }),
        timeoutMs: bureauTimeoutMs(env),
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(
          redactSecrets(`bureau '${name}' responded HTTP ${res.status}`, [apiKey]),
        );
      }
      return res.body;
    },
  };
}

/**
 * Resolve the configured bureau adapter. 'disabled' (default) is an explicit
 * no-op adapter whose send never runs — reportEvent short-circuits before it.
 */
export function getBureauAdapter(deps: BureauDeps = {}): BureauAdapter {
  const provider = bureauProvider(deps.env);
  switch (provider) {
    case "crc":
      // CRC Credit Bureau (Nigeria) — bearer-auth JSON report endpoint.
      return httpAdapter("crc", "/v1/reports", (k) => ({ authorization: `Bearer ${k}` }), deps);
    case "creditregistry":
      // CreditRegistry (Nigeria) — x-api-key auth JSON report endpoint.
      return httpAdapter("creditregistry", "/api/reports", (k) => ({ "x-api-key": k }), deps);
    case "customHttp":
      // Declarative: BUREAU_API_BASE is the full endpoint (path ''), bearer key.
      return httpAdapter("customHttp", "", (k) => ({ authorization: `Bearer ${k}` }), deps);
    default:
      return { name: "disabled", async send() { return null; } };
  }
}

// ── Reporting ───────────────────────────────────────────────────────────────

function logSkip(reason: string, event: BureauEvent): void {
  try {
    process.stdout.write(
      JSON.stringify({
        level: "warn",
        metric: "bureau_report_skipped",
        reason,
        accountId: event.accountId,
        eventType: event.eventType,
      }) + "\n",
    );
  } catch {
    /* logging must never break the money path */
  }
}

/**
 * Report one credit event to the configured bureau. NEVER throws.
 *
 * Order of operations: consent check → persist 'pending' log row → attempt
 * send → flip to 'sent'/'failed'. A 'failed' row keeps the original payload
 * and is re-attempted by retryFailedReports().
 */
export async function reportEvent(
  db: Pick<TxHandle, "select" | "insert" | "update">,
  event: BureauEvent,
  deps: BureauDeps = {},
): Promise<BureauReportResult> {
  try {
    const env = deps.env ?? process.env;
    // Consent gate: never report an account whose buyer has not accepted the
    // bureau-reporting terms (stamped at request/approve time).
    const [account] = await db
      .select({
        id: creditAccounts.id,
        bureauConsentAt: creditAccounts.bureauConsentAt,
      })
      .from(creditAccounts)
      .where(eq(creditAccounts.id, event.accountId))
      .limit(1);
    if (!account) {
      logSkip("account_not_found", event);
      return { reported: false, reason: "account_not_found" };
    }
    if (!account.bureauConsentAt) {
      logSkip("consent_missing", event);
      return { reported: false, reason: "consent_missing" };
    }

    const adapter = getBureauAdapter(deps);
    const safePayload = redactPayload(event.payload) as Record<string, unknown>;

    // 1. Persist the attempt first (durable outbox — survives a crash
    //    between send and status flip; 'pending' rows are retried).
    const [row] = await db
      .insert(bureauReportLog)
      .values({
        accountId: event.accountId,
        eventType: event.eventType,
        bureau: adapter.name,
        status: "pending",
        payload: safePayload,
      })
      .returning({ id: bureauReportLog.id });
    const logId = row?.id;

    // 2. Disabled provider: leave the row 'pending' for later backfill.
    if (adapter.name === "disabled") {
      logSkip("provider_disabled", event);
      return { reported: false, reason: "provider_disabled", logId, status: "pending" };
    }

    // 3. Attempt the send (hard timeout inside the adapter).
    try {
      const response = await adapter.send({ ...event, payload: safePayload });
      if (logId) {
        await db
          .update(bureauReportLog)
          .set({ status: "sent", response: response as never, updatedAt: new Date() })
          .where(eq(bureauReportLog.id, logId));
      }
      return { reported: true, logId, status: "sent" };
    } catch (err: any) {
      const apiKey = (env.BUREAU_API_KEY ?? "").trim();
      const message = redactSecrets(String(err?.message ?? err), [apiKey]);
      if (logId) {
        await db
          .update(bureauReportLog)
          .set({
            status: "failed",
            response: { error: message } as never,
            updatedAt: new Date(),
          })
          .where(eq(bureauReportLog.id, logId));
      }
      console.warn(
        `[compliance/bureau] send failed (account=${event.accountId} event=${event.eventType}): ${message}`,
      );
      // Fail-closed in production: with a provider configured, a failed send
      // is bureau drift — surface it to ops, never swallow silently.
      if (isProd && bureauProvider(env) !== "disabled") {
        captureException(err, {
          service: "compliance/bureau",
          operation: "reportEvent",
          severity: "warn",
          extra: { accountId: event.accountId, eventType: event.eventType, provider: adapter.name },
        });
      }
      return { reported: false, reason: "send_failed", logId, status: "failed" };
    }
  } catch (err: any) {
    // Absolute last resort: bureau reporting must never break the caller.
    console.error(`[compliance/bureau] reportEvent error: ${err?.message ?? err}`);
    captureException(err, {
      service: "compliance/bureau",
      operation: "reportEvent",
      severity: "warn",
      extra: { accountId: event.accountId, eventType: event.eventType },
    });
    return { reported: false, reason: "send_failed" };
  }
}

/**
 * Re-attempt every unsent report (status 'pending' or 'failed'). Returns
 * counts; per-row failures flip the row back to 'failed' and the sweep
 * continues. Never throws.
 */
export async function retryFailedReports(
  db: Pick<TxHandle, "select" | "insert" | "update">,
  deps: BureauDeps = {},
  limit = 100,
): Promise<{ attempted: number; sent: number; failed: number }> {
  const out = { attempted: 0, sent: 0, failed: 0 };
  try {
    const adapter = getBureauAdapter(deps);
    if (adapter.name === "disabled") return out;
    const rows = await db
      .select()
      .from(bureauReportLog)
      .where(
        and(
          inArray(bureauReportLog.status, ["pending", "failed"]),
          // Only retry rows a live provider can serve (not 'disabled' logs
          // from before a provider was configured... those ARE retryable:
          // the adapter name on the row is informational only).
        ),
      )
      .limit(limit);
    for (const row of rows as BureauReportLogEntry[]) {
      out.attempted += 1;
      // Re-check consent on retry — a disputed/withdrawn consent must stop
      // further reporting of the account.
      const [account] = await db
        .select({ bureauConsentAt: creditAccounts.bureauConsentAt })
        .from(creditAccounts)
        .where(eq(creditAccounts.id, row.accountId))
        .limit(1);
      if (!account?.bureauConsentAt) continue;
      try {
        const response = await adapter.send({
          accountId: row.accountId,
          eventType: row.eventType as BureauEventType,
          payload: (row.payload as Record<string, unknown>) ?? {},
        });
        await db
          .update(bureauReportLog)
          .set({
            status: "sent",
            bureau: adapter.name,
            response: response as never,
            updatedAt: new Date(),
          })
          .where(eq(bureauReportLog.id, row.id));
        out.sent += 1;
      } catch (err: any) {
        const apiKey = ((deps.env ?? process.env).BUREAU_API_KEY ?? "").trim();
        const message = redactSecrets(String(err?.message ?? err), [apiKey]);
        await db
          .update(bureauReportLog)
          .set({
            status: "failed",
            response: { error: message } as never,
            updatedAt: new Date(),
          })
          .where(eq(bureauReportLog.id, row.id));
        out.failed += 1;
      }
    }
  } catch (err: any) {
    console.error(`[compliance/bureau] retryFailedReports error: ${err?.message ?? err}`);
    captureException(err, {
      service: "compliance/bureau",
      operation: "retryFailedReports",
      severity: "warn",
    });
  }
  return out;
}

/**
 * Flag a logged report as disputed by the buyer (NDPR data-subject right).
 * A disputed row is excluded from retry (status leaves pending|failed).
 * Returns the updated row, or null when the id does not exist.
 */
export async function markDisputed(
  db: Pick<TxHandle, "select" | "insert" | "update">,
  logId: string,
): Promise<BureauReportLogEntry | null> {
  const [row] = await db
    .update(bureauReportLog)
    .set({ status: "disputed", updatedAt: new Date() })
    .where(eq(bureauReportLog.id, logId))
    .returning();
  return row ?? null;
}
