// === W56 credit ===
/**
 * W56 bureau — provider-agnostic Nigerian credit-bureau integration
 * (CRC Credit Bureau + FirstCentral) for the general buyer/merchant credit
 * domain. EXTENDS the existing W14 push adapter (compliance/bureau.ts,
 * trade-credit accounts) and the W18 pull adapter (tradeCredit/bureauPull.ts)
 * rather than duplicating them: this module owns subject-level (buyer/
 * merchant) pulls with NDPR consent artefacts and repayment report-back.
 *
 * Providers (resolved per tenant, env fallback):
 *   - tenant settings.bureau.provider: 'crc' | 'firstcentral' | 'sandbox' |
 *     'disabled'; env BUREAU_W56_PROVIDER is the platform default
 *     (default 'disabled' outside sim, 'sandbox' inside the PGlite sim).
 *   - 'crc':        POST CRC_BUREAU_URL with CRC_BUREAU_API_KEY (bearer).
 *   - 'firstcentral': POST FIRSTCENTRAL_BUREAU_URL with
 *     FIRSTCENTRAL_BUREAU_API_KEY (bearer).
 *   - 'sandbox':    deterministic hash-derived report (sim/tests) — no
 *     network; same subject + consent always yields the same report.
 *
 * Secrets: API keys may be stored as decryptSecret envelopes (crypto/
 * secrets.ts) — resolveBureauSecret() tries the envelope first and falls
 * back to the raw env value. Keys are only ever sent in the Authorization
 * header and redacted from error text.
 *
 * Guarantees:
 *   - pullCreditReport NEVER throws for transport reasons: on any provider
 *     failure it records an 'error' pull-history row and returns
 *     { report: null, error } (fail-open + telemetry) — a bureau outage must
 *     never break checkout. A MISSING CONSENT is the one honest hard error
 *     (consent_required) — no consent artefact, no pull.
 *   - Consent: recordConsent() stores the artefact (consent text version,
 *     timestamp, channel) BEFORE any pull; pulls resolve the latest live
 *     (non-revoked) artefact for the subject.
 *   - Report-back: reportRepayment() enqueues idempotent outbox rows
 *     (unique idempotencyKey — replays are no-ops) and
 *     runBureauReportSweep() drains them claim-first with bounded backoff
 *     (1m → 5m → 15m → 1h), extending J69/W14 bureau_report_log retry
 *     semantics to subject-level repayment performance.
 *
 * HTTP goes through net/resilientFetch.fetchJson with a bounded timeout
 * (BUREAU_W56_TIMEOUT_MS, default 8s). Tests/sim inject fetcher overrides —
 * no real network.
 */
import { createHash } from "crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { bureauConsents, bureauPulls, bureauReportOutbox } from "../../drizzle/schema";
import { decryptSecret } from "./crypto/secrets";
import { fetchJson } from "./net/resilientFetch";
import { DEFAULT_TIMEOUT_MS, redactSecrets } from "./compliance/fakeHttp";
import { BUREAU_CONSENT_TEXT, type Locale } from "./i18n";
import type { DbHandle } from "./tradeCredit/accounts";

export type BureauProviderName = "disabled" | "sandbox" | "crc" | "firstcentral";
export type BureauSubjectType = "buyer" | "merchant";
export type ReportEventType = "paid_on_time" | "late" | "default" | "settled";

export interface BureauSubjectRef {
  subjectType: BureauSubjectType;
  subjectId: string;
  phone?: string;
  bvn?: string;
  businessName?: string;
}

export interface BureauReportSummary {
  score: number | null;
  totalFacilities: number;
  activeDefaults: number;
  delinquentCount: number;
  enquiryCount90d: number;
  rawRef: string;
}

export interface BureauConsentRecord {
  id: string;
  consentTextVersion: string;
  consentText: string;
  channel: string;
  grantedAt: Date;
}

/** Version stamp for the consent copy (bump when BUREAU_CONSENT_TEXT changes). */
export const BUREAU_CONSENT_VERSION = "w14-v1";

// ── Config ──────────────────────────────────────────────────────────────────

export function bureauTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BUREAU_W56_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS;
}

/**
 * Resolve the bureau provider for a tenant: settings.bureau.provider wins;
 * falls back to BUREAU_W56_PROVIDER; default 'disabled'. In the sim
 * (SIM_MODE/BUREAU_SIM truthy) the default is 'sandbox' so journeys get
 * deterministic fake reports with no network.
 */
export function resolveBureauProvider(
  tenantSettings: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv = process.env,
): BureauProviderName {
  const s = (tenantSettings as any)?.bureau?.provider;
  const raw = String(typeof s === "string" && s.trim() ? s : env.BUREAU_W56_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "crc" || raw === "firstcentral" || raw === "sandbox" || raw === "disabled") return raw;
  if ((env.SIM_MODE ?? "").trim() === "true" || (env.BUREAU_SIM ?? "").trim() === "true") return "sandbox";
  return "disabled";
}

/** Resolve a secret that may be stored as a decryptSecret envelope. */
export function resolveBureauSecret(value: string | undefined | null): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  try {
    const dec = decryptSecret(raw);
    return dec || raw;
  } catch {
    return raw; // not an envelope — treat as plaintext env value
  }
}

// ── Logging (structured, secret-redacted) ───────────────────────────────────

function logLine(level: "info" | "warn", metric: string, extra: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify({ level, metric, ...extra }) + "\n");
  } catch { /* logging must never break the credit path */ }
}

// ── Sandbox (sim) report ────────────────────────────────────────────────────

/**
 * Deterministic fake report: sha256 over stable subject fields + consentId.
 * Used by the sim and tests — no network, same input → same report.
 */
export function sandboxBureauReport(subject: BureauSubjectRef, consentId: string): BureauReportSummary {
  const seed = [
    subject.subjectType, subject.subjectId,
    subject.phone ?? "", subject.bvn ?? "", subject.businessName ?? "", consentId,
  ].join("|");
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

// ── HTTP pull (crc / firstcentral) ──────────────────────────────────────────

export interface BureauFetchOverrides {
  /** Test/sim injection point — replaces fetchJson. */
  fetcher?: typeof fetchJson;
  env?: NodeJS.ProcessEnv;
}

function providerConfig(provider: "crc" | "firstcentral", env: NodeJS.ProcessEnv): { url: string; apiKey: string } {
  if (provider === "crc") {
    return {
      url: (env.CRC_BUREAU_URL ?? "").trim(),
      apiKey: resolveBureauSecret(env.CRC_BUREAU_API_KEY),
    };
  }
  return {
    url: (env.FIRSTCENTRAL_BUREAU_URL ?? "").trim(),
    apiKey: resolveBureauSecret(env.FIRSTCENTRAL_BUREAU_API_KEY),
  };
}

async function httpPullReport(
  provider: "crc" | "firstcentral",
  subject: BureauSubjectRef,
  consentId: string,
  overrides: BureauFetchOverrides,
): Promise<BureauReportSummary> {
  const env = overrides.env ?? process.env;
  const { url, apiKey } = providerConfig(provider, env);
  if (!url) throw new Error(`${provider.toUpperCase()} bureau URL is not configured`);
  const fetcher = overrides.fetcher ?? fetchJson;
  const res = await fetcher<any>(url, {
    integration: `bureau-${provider}`,
    timeoutMs: bureauTimeoutMs(env),
    retries: 0,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        subject_type: subject.subjectType,
        subject_id: subject.subjectId,
        phone: subject.phone ?? null,
        bvn: subject.bvn ?? null,
        business_name: subject.businessName ?? null,
        consent_ref: consentId,
      }),
    },
  });
  if (!res.ok) {
    throw new Error(redactSecrets(`bureau pull responded HTTP ${(res as any).status ?? "?"}`, apiKey ? [apiKey] : []));
  }
  const body = (res as any).data ?? (res as any).body ?? {};
  // Tolerant shape mapping — bureaus differ; we only surface summary fields.
  const num = (v: unknown, dflt = 0) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : dflt);
  const score = body.score == null ? null : Math.max(0, Math.min(1000, Math.floor(Number(body.score))));
  return {
    score,
    totalFacilities: num(body.total_facilities ?? body.totalFacilities),
    activeDefaults: num(body.active_defaults ?? body.activeDefaults),
    delinquentCount: num(body.delinquent_count ?? body.delinquentCount),
    enquiryCount90d: num(body.enquiry_count_90d ?? body.enquiryCount90d),
    rawRef: String(body.ref ?? body.reference ?? `${provider}:${consentId.slice(0, 8)}`).slice(0, 128),
  };
}

// ── Consent ─────────────────────────────────────────────────────────────────

/**
 * Record a bureau-pull consent artefact for a subject. MUST happen before
 * any pull. The exact consent text shown is snapshotted with its version
 * (BUREAU_CONSENT_TEXT × 8 locales) and the capture channel.
 */
export async function recordBureauConsent(
  db: DbHandle,
  opts: {
    tenantId: string;
    subjectType: BureauSubjectType;
    subjectId: string;
    channel: "whatsapp" | "telegram" | "portal" | "api";
    locale?: Locale;
  },
): Promise<BureauConsentRecord> {
  const locale = opts.locale ?? "en";
  const text = BUREAU_CONSENT_TEXT[locale] ?? BUREAU_CONSENT_TEXT.en;
  const rows = (await db
    .insert(bureauConsents)
    .values({
      tenantId: opts.tenantId,
      subjectType: opts.subjectType,
      subjectId: opts.subjectId,
      consentTextVersion: BUREAU_CONSENT_VERSION,
      consentText: text,
      channel: opts.channel,
    })
    .returning()) as unknown as (typeof bureauConsents.$inferSelect)[];
  const r = rows[0]!;
  return {
    id: r.id,
    consentTextVersion: r.consentTextVersion,
    consentText: r.consentText,
    channel: r.channel,
    grantedAt: r.grantedAt,
  };
}

/** Latest live (non-revoked) consent artefact for a subject, if any. */
export async function getLiveBureauConsent(
  db: DbHandle,
  tenantId: string,
  subjectType: BureauSubjectType,
  subjectId: string,
): Promise<BureauConsentRecord | null> {
  const rows = (await db
    .select()
    .from(bureauConsents)
    .where(and(
      eq(bureauConsents.tenantId, tenantId),
      eq(bureauConsents.subjectType, subjectType),
      eq(bureauConsents.subjectId, subjectId),
      isNull(bureauConsents.revokedAt),
    ))
    .orderBy(desc(bureauConsents.grantedAt))
    .limit(1)) as unknown as (typeof bureauConsents.$inferSelect)[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    consentTextVersion: r.consentTextVersion,
    consentText: r.consentText,
    channel: r.channel,
    grantedAt: r.grantedAt,
  };
}

/** Revoke the subject's consent artefacts (NDPR data-subject right). */
export async function revokeBureauConsent(
  db: DbHandle, tenantId: string, subjectType: BureauSubjectType, subjectId: string, now = new Date(),
): Promise<number> {
  const rows = (await db
    .update(bureauConsents)
    .set({ revokedAt: now })
    .where(and(
      eq(bureauConsents.tenantId, tenantId),
      eq(bureauConsents.subjectType, subjectType),
      eq(bureauConsents.subjectId, subjectId),
      isNull(bureauConsents.revokedAt),
    ))
    .returning({ id: bureauConsents.id })) as unknown as { id: string }[];
  return rows.length;
}

// ── Pull ────────────────────────────────────────────────────────────────────

export interface BureauPullOutcome {
  ok: boolean;
  provider: BureauProviderName;
  pullId: string | null;
  report: BureauReportSummary | null;
  error?: string; // 'consent_required' | provider/transport message
}

/**
 * Pull a credit report for a subject. Consent-first: without a live consent
 * artefact the pull is BLOCKED (ok:false, error 'consent_required') and no
 * provider call happens. Provider failures are recorded as 'error' history
 * rows and returned fail-open (ok:false, report:null) — never a throw.
 */
export async function pullCreditReport(
  db: DbHandle,
  opts: {
    tenantId: string;
    subject: BureauSubjectRef;
    tenantSettings?: Record<string, unknown> | null;
  },
  overrides: BureauFetchOverrides = {},
): Promise<BureauPullOutcome> {
  const { tenantId, subject } = opts;
  const consent = await getLiveBureauConsent(db, tenantId, subject.subjectType, subject.subjectId);
  if (!consent) {
    logLine("warn", "bureau_pull_blocked_no_consent", {
      tenantId, subjectType: subject.subjectType, subjectId: subject.subjectId,
    });
    return { ok: false, provider: "disabled", pullId: null, report: null, error: "consent_required" };
  }

  const provider = resolveBureauProvider(opts.tenantSettings ?? null, overrides.env ?? process.env);

  const record = async (status: "ok" | "error", report: BureauReportSummary | null, error?: string) => {
    const rows = (await db
      .insert(bureauPulls)
      .values({
        tenantId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        provider,
        consentId: consent.id,
        status,
        report: report ?? null,
        rawRef: report?.rawRef ?? null,
        error: error ?? null,
      })
      .returning({ id: bureauPulls.id })) as unknown as { id: string }[];
    return rows[0]?.id ?? null;
  };

  try {
    let report: BureauReportSummary | null;
    if (provider === "disabled") {
      logLine("info", "bureau_pull_disabled", { tenantId, provider });
      return { ok: false, provider, pullId: null, report: null, error: "provider_disabled" };
    } else if (provider === "sandbox") {
      report = sandboxBureauReport(subject, consent.id);
    } else {
      report = await httpPullReport(provider, subject, consent.id, overrides);
    }
    const pullId = await record("ok", report);
    logLine("info", "bureau_pull_ok", { tenantId, provider, rawRef: report.rawRef });
    return { ok: true, provider, pullId, report };
  } catch (err: any) {
    const message = String(err?.message ?? err).slice(0, 500);
    const pullId = await record("error", null, message).catch(() => null);
    logLine("warn", "bureau_pull_failed", { tenantId, provider, error: message });
    return { ok: false, provider, pullId, report: null, error: message };
  }
}

/** Pull history for a subject (tenant-scoped), newest first. */
export async function listBureauPulls(
  db: DbHandle, tenantId: string, subjectType: BureauSubjectType, subjectId: string, limit = 20,
) {
  return (await db
    .select()
    .from(bureauPulls)
    .where(and(
      eq(bureauPulls.tenantId, tenantId),
      eq(bureauPulls.subjectType, subjectType),
      eq(bureauPulls.subjectId, subjectId),
    ))
    .orderBy(desc(bureauPulls.createdAt))
    .limit(Math.max(1, Math.min(limit, 100)))) as unknown as (typeof bureauPulls.$inferSelect)[];
}

// ── Report-back outbox ──────────────────────────────────────────────────────

export interface RepaymentReportEvent {
  tenantId: string;
  subjectType: BureauSubjectType;
  subjectId: string;
  eventType: ReportEventType;
  amountCents?: number;
  ref: string; // business reference — feeds the idempotency key
  occurredAt?: Date;
}

/** Deterministic idempotency key for a repayment report event. */
export function reportEventKey(e: RepaymentReportEvent): string {
  return `w56:${e.tenantId}:${e.subjectType}:${e.subjectId}:${e.eventType}:${e.ref}`.slice(0, 160);
}

/**
 * Enqueue repayment-performance events for bureau report-back. Idempotent:
 * the unique idempotencyKey makes replays no-ops (onConflictDoNothing).
 * Returns the number of NEWLY enqueued rows.
 */
export async function reportRepayment(db: DbHandle, events: RepaymentReportEvent[]): Promise<number> {
  let enqueued = 0;
  for (const e of events) {
    const rows = (await db
      .insert(bureauReportOutbox)
      .values({
        tenantId: e.tenantId,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
        eventType: e.eventType,
        payload: {
          amountCents: e.amountCents ?? null,
          ref: e.ref,
          occurredAt: (e.occurredAt ?? new Date()).toISOString(),
        },
        idempotencyKey: reportEventKey(e),
        status: "pending",
      })
      .onConflictDoNothing()
      .returning({ id: bureauReportOutbox.id })) as unknown as { id: string }[];
    enqueued += rows.length;
  }
  return enqueued;
}

/** Backoff ladder (ms) per attempt count — bounded at 1h. */
export const REPORT_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];
/** After this many attempts the row stays 'failed' for manual review. */
export const REPORT_MAX_ATTEMPTS = 4;

export interface BureauReportSweepResult {
  attempted: number;
  sent: number;
  failed: number;
  skippedNoProvider: number;
}

/**
 * Drain due outbox rows (claim-first): selects pending/failed rows whose
 * nextRetryAt is due, marks the attempt, sends via the configured provider
 * (sandbox = deterministic accept; disabled = leave pending), and stamps
 * sent/reportedAt or failed + nextRetryAt (backoff ladder). Idempotent —
 * replaying the sweep only retries rows still eligible.
 */
export async function runBureauReportSweep(
  db: DbHandle,
  opts: { tenantId?: string; now?: Date; limit?: number } = {},
  overrides: BureauFetchOverrides = {},
): Promise<BureauReportSweepResult> {
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const env = overrides.env ?? process.env;

  // PGlite binds can't serialize Date — ISO string (repo convention).
  const nowIso = now.toISOString();
  const where = opts.tenantId
    ? and(eq(bureauReportOutbox.tenantId, opts.tenantId), sql`${bureauReportOutbox.status} in ('pending','failed')`, sql`(${bureauReportOutbox.nextRetryAt} is null or ${bureauReportOutbox.nextRetryAt} <= ${nowIso})`)
    : and(sql`${bureauReportOutbox.status} in ('pending','failed')`, sql`(${bureauReportOutbox.nextRetryAt} is null or ${bureauReportOutbox.nextRetryAt} <= ${nowIso})`);

  const due = (await db
    .select()
    .from(bureauReportOutbox)
    .where(where)
    .orderBy(bureauReportOutbox.createdAt)
    .limit(limit)) as unknown as (typeof bureauReportOutbox.$inferSelect)[];

  const result: BureauReportSweepResult = { attempted: 0, sent: 0, failed: 0, skippedNoProvider: 0 };

  for (const row of due) {
    // Per-tenant provider resolution: read tenant settings lazily.
    const { tenants } = await import("../../drizzle/schema");
    const tRows = (await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, row.tenantId))
      .limit(1)) as unknown as { settings: unknown }[];
    const provider = resolveBureauProvider((tRows[0]?.settings ?? null) as Record<string, unknown> | null, env);
    if (provider === "disabled") {
      result.skippedNoProvider += 1;
      continue; // leave pending — a later sweep with a live provider drains it
    }

    result.attempted += 1;
    const attempts = row.attempts + 1;
    try {
      if (provider === "sandbox") {
        // Deterministic accept — no network.
      } else {
        const { url, apiKey } = providerConfig(provider, env);
        if (!url) throw new Error(`${provider.toUpperCase()} bureau URL is not configured`);
        const fetcher = overrides.fetcher ?? fetchJson;
        const res = await fetcher<any>(url, {
          integration: `bureau-${provider}-report`,
          timeoutMs: bureauTimeoutMs(env),
          retries: 0,
          init: {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
              subject_type: row.subjectType,
              subject_id: row.subjectId,
              event_type: row.eventType,
              payload: row.payload,
              idempotency_key: row.idempotencyKey,
            }),
          },
        });
        if (!(res as any).ok) throw new Error(`bureau report responded HTTP ${(res as any).status ?? "?"}`);
      }
      await db
        .update(bureauReportOutbox)
        .set({ status: "sent", attempts, reportedAt: now, lastError: null, updatedAt: now })
        .where(eq(bureauReportOutbox.id, row.id));
      result.sent += 1;
      logLine("info", "bureau_report_sent", { tenantId: row.tenantId, provider, key: row.idempotencyKey });
    } catch (err: any) {
      const message = String(err?.message ?? err).slice(0, 500);
      const exhausted = attempts >= REPORT_MAX_ATTEMPTS;
      const backoff = REPORT_BACKOFF_MS[Math.min(attempts - 1, REPORT_BACKOFF_MS.length - 1)];
      await db
        .update(bureauReportOutbox)
        .set({
          status: "failed",
          attempts,
          nextRetryAt: exhausted ? null : new Date(now.getTime() + backoff),
          lastError: message,
          updatedAt: now,
        })
        .where(eq(bureauReportOutbox.id, row.id));
      result.failed += 1;
      logLine("warn", "bureau_report_failed", { tenantId: row.tenantId, provider, key: row.idempotencyKey, error: message });
    }
  }
  return result;
}

/** Tenant-scoped outbox status view (report-back status UI). */
export async function listReportOutbox(db: DbHandle, tenantId: string, limit = 50) {
  return (await db
    .select()
    .from(bureauReportOutbox)
    .where(eq(bureauReportOutbox.tenantId, tenantId))
    .orderBy(desc(bureauReportOutbox.createdAt))
    .limit(Math.max(1, Math.min(limit, 200)))) as unknown as (typeof bureauReportOutbox.$inferSelect)[];
}
