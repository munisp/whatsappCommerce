/**
 * server/services/llmCopilot.ts — W22 LLM copilot for merchant Q&A and SOC2
 * incident triage.
 *
 * Two capabilities layered on the EXISTING provider wrapper
 * (server/_core/llm.ts `invokeLLM` — no new provider, no new npm deps):
 *
 *   triageIncident(tenantId, incidentId)
 *     Builds a prompt from the incident row + related anomaly_alerts + a
 *     keyword-retrieved excerpt of the SOC2 runbook docs (read from disk,
 *     cached in memory). The LLM reply is parsed into a structured
 *     suggestion { severitySuggestion, likelyCause, runbookSteps[],
 *     postmortemDraft }.
 *
 *   merchantAsk(tenantId, question)
 *     Merchant copilot: assembles a compact tenant-scoped aggregate snapshot
 *     (today's salesCents integer, order count, top products, credit
 *     balance) and answers the merchant's question grounded on those
 *     aggregates.
 *
 * Fallback contract: neither function EVER throws. The LLM is only invoked
 * when COPILOT_LLM_ENABLED=1 (default off — deterministic in tests/sim);
 * disabled / unavailable / parse-failure → deterministic heuristic fallback
 * (keyword rules / aggregate template) with `fallbackUsed: true`.
 *
 * Privacy: every string entering a prompt passes redactForPrompt() (phone
 * numbers, emails, bearer/API secrets — reusing compliance.redactSecrets).
 * Every invocation is logged to copilot_queries with a sha256 prompt hash,
 * fallback flag and latency — NEVER raw prompts or PII.
 */
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, gte } from "drizzle-orm";
import { ENV } from "../_core/env";
import { invokeLLM } from "../_core/llm";
import { getDb } from "../db";
import { redactSecrets } from "./compliance/fakeHttp";
import {
  anomalyAlerts,
  copilotQueries,
  creditAccounts,
  incidents,
  orders,
  type AnomalyAlert,
  type Incident,
} from "../../drizzle/schema";

type Db = any;

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Tunables (imported by tests — never hardcode elsewhere) ────────────────
export const COPILOT_PARAMS = {
  /** Max chars of runbook excerpt injected into the triage prompt. */
  runbookExcerptMaxChars: 1200,
  /** How many recent open alerts are attached to a triage prompt. */
  triageAlertLimit: 10,
  /** Lookback window for the merchant "top products" aggregate. */
  topProductsWindowDays: 30,
  /** Top-N products in the merchant snapshot. */
  topProductsN: 5,
  /** copilot.history default limit. */
  historyLimit: 50,
} as const;

// ─── LLM gating ─────────────────────────────────────────────────────────────
/**
 * Provider-gating: the copilot calls the shared LLM provider ONLY when
 * explicitly enabled (COPILOT_LLM_ENABLED=1/true) AND the shared wrapper has
 * an API key configured. Default is OFF so tests and the simulation are
 * fully deterministic on the heuristic fallback.
 */
export function isCopilotLlmEnabled(): boolean {
  const flag = (process.env.COPILOT_LLM_ENABLED ?? "").trim().toLowerCase();
  return (flag === "1" || flag === "true") && Boolean(ENV.llmApiKey);
}

// ─── Redaction ──────────────────────────────────────────────────────────────
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g; // 8+ digit phone-ish runs
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const SECRET_KV_RE = /\b(api[_-]?key|token|secret|password|authorization)(\s*[:=]\s*)(\S+)/gi;

/**
 * Redact PII/secrets from anything entering an LLM prompt. Reuses the
 * existing compliance redactSecrets for the configured provider key, plus
 * deterministic regexes for phone numbers, e-mails and key=value secrets.
 */
export function redactForPrompt(text: string): string {
  if (!text) return text ?? "";
  let out = String(text);
  out = redactSecrets(out, [ENV.llmApiKey]);
  out = out.replace(BEARER_RE, "$1[REDACTED]");
  out = out.replace(SECRET_KV_RE, (_m, k, sep) => `${k}${sep}[REDACTED]`);
  out = out.replace(EMAIL_RE, "[REDACTED-EMAIL]");
  out = out.replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 8 ? "[REDACTED-PHONE]" : m));
  return out;
}

/** sha256 hex of the fully-assembled (redacted) prompt — logged, never the prompt itself. */
export function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

// ─── SOC2 runbook retrieval (disk, cached) ─────────────────────────────────
export const COPILOT_DOCS_DIR = join(process.cwd(), "docs/SOC2");

interface DocChunk {
  file: string;
  heading: string;
  body: string;
  tokens: Set<string>;
}

let docCache: DocChunk[] | null = null;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

/** Load + chunk docs/SOC2/*.md by markdown section; cached in memory. */
export function loadRunbookChunks(dir: string = COPILOT_DOCS_DIR): DocChunk[] {
  if (docCache && dir === COPILOT_DOCS_DIR) return docCache;
  const chunks: DocChunk[] = [];
  try {
    if (existsSync(dir)) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
        const md = readFileSync(join(dir, file), "utf8");
        const sections = md.split(/\n(?=#{1,3}\s)/);
        for (const section of sections) {
          const headingMatch = section.match(/^#{1,3}\s+(.+)/m);
          const heading = headingMatch ? headingMatch[1].trim() : file;
          const body = section.trim();
          if (body.length < 20) continue;
          chunks.push({ file, heading, body, tokens: tokenize(`${heading} ${body}`) });
        }
      }
    }
  } catch {
    // Unreadable docs → retrieval returns "" (fallback still works).
  }
  if (dir === COPILOT_DOCS_DIR) docCache = chunks;
  return chunks;
}

/** Test-only: drop the in-memory docs cache. */
export function resetRunbookCache(): void {
  docCache = null;
}

/**
 * Simple keyword retrieval: score each chunk by query-token overlap, return
 * the best chunks joined and truncated to maxChars. Deterministic.
 */
export function retrieveRunbookExcerpt(
  query: string,
  maxChars: number = COPILOT_PARAMS.runbookExcerptMaxChars,
  dir: string = COPILOT_DOCS_DIR,
): string {
  const qTokens = tokenize(query);
  if (qTokens.size === 0) return "";
  const scored = loadRunbookChunks(dir)
    .map((c) => {
      let score = 0;
      qTokens.forEach((t) => { if (c.tokens.has(t)) score++; });
      return { c, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.c.file.localeCompare(b.c.file));
  let out = "";
  for (const { c } of scored) {
    const piece = `# ${c.heading} (${c.file})\n${c.body}\n\n`;
    if (out.length + piece.length > maxChars) {
      if (out.length === 0) out = piece.slice(0, maxChars);
      break;
    }
    out += piece;
    if (out.length >= maxChars * 0.8) break;
  }
  return out.trim();
}

// ─── Structured outputs ─────────────────────────────────────────────────────
export interface TriageSuggestion {
  severitySuggestion: "low" | "medium" | "high" | "critical";
  likelyCause: string;
  runbookSteps: string[];
  postmortemDraft: string;
}

export interface TriageResult extends TriageSuggestion {
  fallbackUsed: boolean;
  latencyMs: number;
}

export interface MerchantSnapshot {
  salesCentsToday: number; // integer cents
  ordersToday: number;
  topProducts: Array<{ name: string; quantity: number }>;
  creditOutstandingCents: number;
  creditLimitCents: number;
}

export interface AskResult {
  answer: string;
  snapshot: MerchantSnapshot;
  fallbackUsed: boolean;
  latencyMs: number;
}

// ─── Heuristic triage fallback (deterministic keyword rules) ───────────────
const CRITICAL_WORDS = ["breach", "purge", "exfiltrat", "export", "unauthoriz", "sensitive_event_rate", "off_hours"];
const HIGH_WORDS = ["payment", "webhook", "outage", "fraud", "anomaly", "failed", "downtime"];
const MEDIUM_WORDS = ["delay", "latency", "error", "degraded", "sync"];

function keywordSeverity(text: string, current: string): TriageSuggestion["severitySuggestion"] {
  const t = text.toLowerCase();
  if (CRITICAL_WORDS.some((w) => t.includes(w))) return "critical";
  if (HIGH_WORDS.some((w) => t.includes(w))) return "high";
  if (MEDIUM_WORDS.some((w) => t.includes(w))) return "medium";
  return (["low", "medium", "high", "critical"].includes(current)
    ? current
    : "low") as TriageSuggestion["severitySuggestion"];
}

export function heuristicTriage(
  incident: Incident | null,
  alerts: AnomalyAlert[],
  excerpt: string,
): TriageSuggestion {
  if (!incident) {
    return {
      severitySuggestion: "medium",
      likelyCause: "Incident record not found for this tenant; treat as untriaged and investigate manually.",
      runbookSteps: [
        "Confirm the incident id and tenant scope.",
        "Review the audit chain around the reported time window.",
        "Assign an incident owner and move status to investigating.",
      ],
      postmortemDraft:
        "Postmortem stub: incident could not be auto-triaged (record unavailable). Fill in timeline, root cause, impact, and corrective actions after manual investigation.",
    };
  }
  const corpus = [
    incident.title,
    incident.description ?? "",
    ...alerts.map((a) => `${a.signal} ${JSON.stringify(a.detail ?? {})}`),
  ].join("\n");
  const severitySuggestion = keywordSeverity(corpus, incident.severity);
  const topSignals = Array.from(new Set(alerts.map((a) => a.signal))).slice(0, 3);
  const likelyCause =
    alerts.length > 0
      ? `Audit-stream anomaly signals (${topSignals.join(", ")}) deviated from the tenant baseline; heuristic rules associate this with ${
          severitySuggestion === "critical"
            ? "potentially unauthorized sensitive operations (data purge/export) or off-hours activity"
            : severitySuggestion === "high"
              ? "a payment/webhook processing fault or sustained elevated error rates"
              : "an operational degradation requiring investigation"
        }.`
      : `No correlated anomaly alerts; heuristic triage based on incident description ("${incident.title}").`;

  // Runbook steps: first bullet/numbered lines of the retrieved excerpt,
  // padded with the generic SOC2 response flow.
  const excerptSteps = excerpt
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^([-*]|\d+[.)])\s+\S/.test(l))
    .map((l) => l.replace(/^([-*]|\d+[.)])\s+/, ""))
    .filter((l) => l.length > 12 && l.length < 200)
    .slice(0, 4);
  const generic = [
    "Acknowledge the incident and assign an owner (see INCIDENT_RUNBOOK.md).",
    "Verify audit-chain integrity around the incident window.",
    "Contain: revoke suspect sessions/tokens; freeze affected workflows.",
    "Notify stakeholders per the severity matrix and open the postmortem.",
  ];
  const runbookSteps = [...excerptSteps, ...generic].slice(0, 5);

  const postmortemDraft =
    `Postmortem draft (auto-generated, heuristic): Incident "${incident.title}" ` +
    `(opened ${incident.openedAt.toISOString?.() ?? String(incident.openedAt)}), suggested severity ${severitySuggestion}. ` +
    `Likely cause: ${likelyCause} Impact: under investigation. ` +
    `Corrective actions: complete the runbook steps, verify audit-chain integrity, and add detection coverage for the triggering signals (${topSignals.join(", ") || "none"}).`;

  return { severitySuggestion, likelyCause, runbookSteps, postmortemDraft };
}

// ─── Prompt construction (exported for redaction tests) ────────────────────
export function buildTriagePrompt(
  incident: Incident | null,
  alerts: AnomalyAlert[],
  excerpt: string,
): string {
  const incidentBlock = incident
    ? [
        `Title: ${incident.title}`,
        `Current severity: ${incident.severity}`,
        `Status: ${incident.status}`,
        `Description: ${incident.description ?? "(none)"}`,
        `Opened at: ${incident.openedAt.toISOString?.() ?? String(incident.openedAt)}`,
      ].join("\n")
    : "(incident not found)";
  const alertBlock =
    alerts.length === 0
      ? "(no related anomaly alerts)"
      : alerts
          .map(
            (a) =>
              `- signal=${a.signal} score=${a.score.toFixed(3)} status=${a.status} bucket=${a.windowBucket.toISOString?.() ?? String(a.windowBucket)}`,
          )
          .join("\n");
  return redactForPrompt(
    [
      "You are a SOC2 incident-triage copilot. Reply with STRICT JSON only:",
      '{"severitySuggestion":"low|medium|high|critical","likelyCause":"...","runbookSteps":["..."],"postmortemDraft":"..."}',
      "",
      "## Incident",
      incidentBlock,
      "",
      "## Related anomaly alerts (aggregate signals only)",
      alertBlock,
      "",
      "## SOC2 runbook excerpt",
      excerpt || "(no runbook excerpt retrieved)",
    ].join("\n"),
  );
}

/** Parse + validate the LLM triage reply; null on any shape mismatch. */
export function parseTriageResponse(content: string): TriageSuggestion | null {
  try {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const sev = String(parsed.severitySuggestion ?? "").toLowerCase();
    if (!["low", "medium", "high", "critical"].includes(sev)) return null;
    if (typeof parsed.likelyCause !== "string" || parsed.likelyCause.length < 5) return null;
    const steps = Array.isArray(parsed.runbookSteps)
      ? parsed.runbookSteps.filter((s: unknown) => typeof s === "string" && s.length > 3).slice(0, 8)
      : [];
    if (steps.length === 0) return null;
    if (typeof parsed.postmortemDraft !== "string" || parsed.postmortemDraft.length < 20) return null;
    return {
      severitySuggestion: sev as TriageSuggestion["severitySuggestion"],
      likelyCause: parsed.likelyCause.slice(0, 1000),
      runbookSteps: steps.map((s: string) => s.slice(0, 300)),
      postmortemDraft: parsed.postmortemDraft.slice(0, 4000),
    };
  } catch {
    return null;
  }
}

// ─── Merchant snapshot + ask ────────────────────────────────────────────────
/** Tenant-scoped aggregates ONLY — never row-level PII. Integer cents. */
export async function collectMerchantSnapshot(db: Db, tenantId: string): Promise<MerchantSnapshot> {
  const empty: MerchantSnapshot = {
    salesCentsToday: 0,
    ordersToday: 0,
    topProducts: [],
    creditOutstandingCents: 0,
    creditLimitCents: 0,
  };
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const windowStart = new Date(Date.now() - COPILOT_PARAMS.topProductsWindowDays * DAY_MS);

    const todayRows: Array<{ totalAmount: string | number }> = await db
      .select({ totalAmount: orders.totalAmount })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), gte(orders.createdAt, todayStart)));
    let salesCentsToday = 0;
    for (const r of todayRows) salesCentsToday += Math.round(Number(r.totalAmount ?? 0) * 100);

    const recentRows: Array<{ items: unknown }> = await db
      .select({ items: orders.items })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), gte(orders.createdAt, windowStart)));
    const counts = new Map<string, number>();
    for (const r of recentRows) {
      const items = Array.isArray(r.items) ? r.items : [];
      for (const it of items as any[]) {
        const name = String(it?.name ?? it?.product ?? it?.title ?? "").trim();
        if (!name) continue;
        const qty = Number(it?.quantity ?? it?.qty ?? 1) || 1;
        counts.set(name, (counts.get(name) ?? 0) + qty);
      }
    }
    const topProducts = Array.from(counts.entries())
      .map(([name, quantity]) => ({ name, quantity }))
      .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))
      .slice(0, COPILOT_PARAMS.topProductsN);

    const creditRows: Array<{ outstandingCents: number; limitCents: number }> = await db
      .select({ outstandingCents: creditAccounts.outstandingCents, limitCents: creditAccounts.limitCents })
      .from(creditAccounts)
      .where(eq(creditAccounts.buyerTenantId, tenantId));
    let creditOutstandingCents = 0;
    let creditLimitCents = 0;
    for (const r of creditRows) {
      creditOutstandingCents += Number(r.outstandingCents ?? 0);
      creditLimitCents += Number(r.limitCents ?? 0);
    }

    return { salesCentsToday, ordersToday: todayRows.length, topProducts, creditOutstandingCents, creditLimitCents };
  } catch {
    return empty;
  }
}

export function buildAskPrompt(snapshot: MerchantSnapshot, question: string): string {
  const top =
    snapshot.topProducts.length === 0
      ? "(no sales in window)"
      : snapshot.topProducts.map((p) => `- ${p.name}: ${p.quantity} units`).join("\n");
  return redactForPrompt(
    [
      "You are a merchant analytics copilot. Answer ONLY from the aggregate snapshot below.",
      "Never invent figures; never expose other tenants' data; keep the answer under 120 words.",
      "",
      "## Tenant aggregate snapshot (integer cents)",
      `Sales today (cents): ${snapshot.salesCentsToday}`,
      `Orders today: ${snapshot.ordersToday}`,
      `Top products (last ${COPILOT_PARAMS.topProductsWindowDays}d):\n${top}`,
      `Credit outstanding (cents): ${snapshot.creditOutstandingCents}`,
      `Credit limit (cents): ${snapshot.creditLimitCents}`,
      "",
      `## Merchant question\n${question}`,
    ].join("\n"),
  );
}

function formatMajor(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Deterministic template answer from aggregates (LLM-disabled fallback). */
export function fallbackAskAnswer(snapshot: MerchantSnapshot, question: string): string {
  const q = question.toLowerCase();
  const parts: string[] = [];
  if (/(sale|revenue|today|sell)/.test(q)) {
    parts.push(
      `Today you have ${snapshot.ordersToday} order${snapshot.ordersToday === 1 ? "" : "s"} totaling ${formatMajor(snapshot.salesCentsToday)} (in your order currency).`,
    );
  }
  if (/(top|best|product|selling)/.test(q)) {
    parts.push(
      snapshot.topProducts.length > 0
        ? `Top products in the last ${COPILOT_PARAMS.topProductsWindowDays} days: ${snapshot.topProducts
            .map((p) => `${p.name} (${p.quantity})`)
            .join(", ")}.`
        : `No product sales recorded in the last ${COPILOT_PARAMS.topProductsWindowDays} days.`,
    );
  }
  if (/(credit|balance|owe|debt|limit)/.test(q)) {
    parts.push(
      `Your trade-credit position: ${formatMajor(snapshot.creditOutstandingCents)} outstanding against a ${formatMajor(snapshot.creditLimitCents)} limit.`,
    );
  }
  if (parts.length === 0) {
    parts.push(
      `Snapshot: ${snapshot.ordersToday} orders today (${formatMajor(snapshot.salesCentsToday)} total); credit outstanding ${formatMajor(snapshot.creditOutstandingCents)} of ${formatMajor(snapshot.creditLimitCents)}.` +
        (snapshot.topProducts.length > 0
          ? ` Top product: ${snapshot.topProducts[0].name}.`
          : ""),
    );
  }
  return parts.join(" ");
}

/** Parse the LLM ask reply — plain text answer, sanity-bounded. */
export function parseAskResponse(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.length < 10 || trimmed.length > 2000) return null;
  return trimmed;
}

// ─── Audit logging (never throws) ──────────────────────────────────────────
async function logCopilotQuery(
  db: Db,
  row: { tenantId: string; kind: "triage" | "ask"; promptHash: string; fallbackUsed: boolean; latencyMs: number },
): Promise<void> {
  try {
    await db.insert(copilotQueries).values({
      tenantId: row.tenantId,
      kind: row.kind,
      promptHash: row.promptHash,
      fallbackUsed: row.fallbackUsed,
      latencyMs: row.latencyMs,
    });
  } catch (err) {
    console.warn(`[llmCopilot] copilot_queries insert failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Shared LLM invocation seam — returns message content or null. */
async function tryLlm(prompt: string, json: boolean): Promise<string | null> {
  if (!isCopilotLlmEnabled()) return null;
  try {
    const result = await invokeLLM({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 800,
      ...(json ? { responseFormat: { type: "json_object" } as const } : {}),
    });
    const content = result.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content.filter((p) => p.type === "text").map((p: any) => p.text).join("\n");
      return text || null;
    }
    return null;
  } catch {
    return null; // provider down/timeout → heuristic fallback
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────
/**
 * Triage an incident. NEVER throws: any failure lands on the deterministic
 * heuristic fallback with fallbackUsed=true. Logged to copilot_queries.
 */
export async function triageIncident(
  tenantId: string,
  incidentId: string,
  dbOverride?: Db,
): Promise<TriageResult> {
  const started = Date.now();
  let db: Db = dbOverride;
  let incident: Incident | null = null;
  let alerts: AnomalyAlert[] = [];
  try {
    db = db ?? (await getDb());
    if (db) {
      const rows = await db
        .select()
        .from(incidents)
        .where(and(eq(incidents.id, incidentId), eq(incidents.tenantId, tenantId)))
        .limit(1);
      incident = rows?.[0] ?? null;
      alerts =
        (await db
          .select()
          .from(anomalyAlerts)
          .where(eq(anomalyAlerts.tenantId, tenantId))
          .orderBy(desc(anomalyAlerts.createdAt))
          .limit(COPILOT_PARAMS.triageAlertLimit)) ?? [];
    }
  } catch {
    incident = null;
    alerts = [];
  }

  const excerpt = retrieveRunbookExcerpt(
    [incident?.title ?? "", incident?.description ?? "", ...alerts.map((a) => a.signal)].join(" "),
  );
  const prompt = buildTriagePrompt(incident, alerts, excerpt);
  const hash = promptHash(prompt);

  let suggestion: TriageSuggestion | null = null;
  const llmText = await tryLlm(prompt, true);
  if (llmText) suggestion = parseTriageResponse(llmText);
  const fallbackUsed = suggestion === null;
  if (!suggestion) suggestion = heuristicTriage(incident, alerts, excerpt);

  const latencyMs = Date.now() - started;
  if (db) await logCopilotQuery(db, { tenantId, kind: "triage", promptHash: hash, fallbackUsed, latencyMs });
  return { ...suggestion, fallbackUsed, latencyMs };
}

/**
 * Merchant Q&A over tenant-scoped aggregates. NEVER throws; LLM-disabled or
 * parse failure → template answer grounded on the aggregates.
 */
export async function merchantAsk(tenantId: string, question: string, dbOverride?: Db): Promise<AskResult> {
  const started = Date.now();
  let db: Db = dbOverride;
  let snapshot: MerchantSnapshot = {
    salesCentsToday: 0,
    ordersToday: 0,
    topProducts: [],
    creditOutstandingCents: 0,
    creditLimitCents: 0,
  };
  try {
    db = db ?? (await getDb());
    if (db) snapshot = await collectMerchantSnapshot(db, tenantId);
  } catch {
    // empty snapshot — template answer still works
  }

  const safeQuestion = redactForPrompt(String(question ?? "").slice(0, 500));
  const prompt = buildAskPrompt(snapshot, safeQuestion);
  const hash = promptHash(prompt);

  let answer: string | null = null;
  const llmText = await tryLlm(prompt, false);
  if (llmText) answer = parseAskResponse(llmText);
  const fallbackUsed = answer === null;
  if (!answer) answer = fallbackAskAnswer(snapshot, safeQuestion);

  const latencyMs = Date.now() - started;
  if (db) await logCopilotQuery(db, { tenantId, kind: "ask", promptHash: hash, fallbackUsed, latencyMs });
  return { answer, snapshot, fallbackUsed, latencyMs };
}
