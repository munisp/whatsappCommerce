/**
 * Production observability — captureException (w10).
 *
 * A single, dependency-free error capture sink wired at the catch/failure
 * points of the money path and integration pipelines. Guarantees:
 *
 *   - NEVER throws, NEVER blocks the caller (all sinks are fail-safe).
 *   - Emits one structured JSON line per error to stdout — machine-parseable
 *     by log aggregators (Loki/ELK/CloudWatch insights).
 *   - When env ERROR_WEBHOOK_URL is set, fires a fire-and-forget POST of a
 *     Slack-compatible { text } payload (5s timeout; failures swallowed).
 *   - Keeps an in-memory ring buffer of the last RING_BUFFER_CAPACITY errors,
 *     exposed to admins via the `infra.systemRecentErrors` tRPC procedure.
 *
 * Severity convention:
 *   - 'critical'  money-path failures: paymentConfirm hook errors, credit
 *                 draw/repayment exceptions, outbox DLQ transitions.
 *   - 'error'     an operation failed but no money moved wrongly.
 *   - 'warn'      degraded but handled (reminder send failure, LLM fallback,
 *                 rejected inbound signature).
 *
 * Redaction: keys named token/secret/password/authorization (case-insensitive,
 * also matched as suffixes like "accessToken") are stripped from `extra`
 * before anything is stored or sent.
 */

export type ErrorSeverity = "warn" | "error" | "critical";

export interface CaptureContext {
  /** Originating service/module, e.g. "integrations/outbox". */
  service: string;
  /** Operation being performed, e.g. "dispatch", "reminderSend". */
  operation: string;
  tenantId?: string;
  /** Defaults to 'error'. 'critical' is reserved for money-path failures. */
  severity?: ErrorSeverity;
  /** Arbitrary context; sensitive keys are redacted before storage/egress. */
  extra?: Record<string, unknown>;
}

export interface CapturedError {
  timestamp: string; // ISO-8601
  service: string;
  operation: string;
  tenantId?: string;
  severity: ErrorSeverity;
  message: string;
  stack?: string;
  extra?: Record<string, unknown>;
}

const RING_BUFFER_CAPACITY = 200;
const WEBHOOK_TIMEOUT_MS = 5000;
const REDACTED = "[redacted]";

/** Key names (and *Token/*Secret/... suffixes) that must never leave the process. */
const SENSITIVE_KEY_RE = /(token|secret|password|authorization)$/i;

function redactValue(value: unknown, depth: number): unknown {
  if (value == null || typeof value !== "object") return value;
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : redactValue(v, depth + 1);
  }
  return out;
}

/** Strip sensitive keys from an extra payload (recursive, non-mutating). */
export function redactExtra(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  return redactValue(extra, 0) as Record<string, unknown>;
}

// ── In-memory ring buffer (last N captures) ─────────────────────────────────

const ring: CapturedError[] = [];

/** Most recent captures, newest first. */
export function getRecentErrors(limit = 50): CapturedError[] {
  const n = Math.max(0, Math.min(limit, ring.length));
  const out: CapturedError[] = [];
  for (let i = ring.length - 1; i >= 0 && out.length < n; i--) out.push(ring[i]);
  return out;
}

/** Test hook: clear the ring buffer. */
export function _resetRecentErrors(): void {
  ring.length = 0;
}

// ── Sinks ───────────────────────────────────────────────────────────────────

function stdoutSink(record: CapturedError): void {
  try {
    process.stdout.write(JSON.stringify({ level: record.severity, ...record }) + "\n");
  } catch {
    /* stdout itself must never bring the process down */
  }
}

function webhookSink(record: CapturedError): void {
  const url = process.env.ERROR_WEBHOOK_URL;
  if (!url) return;
  const text =
    `[${record.severity.toUpperCase()}] ${record.service}/${record.operation}` +
    (record.tenantId ? ` tenant=${record.tenantId}` : "") +
    `: ${record.message}` +
    (record.extra ? `\n\`\`\`${JSON.stringify(record.extra).slice(0, 1500)}\`\`\`` : "");
  // Fire-and-forget: never awaited by the caller, every failure swallowed.
  void fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  }).catch(() => {
    /* webhook delivery is best-effort by design */
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Capture an error. Never throws, never blocks — safe to call from any catch
 * block, including the money path.
 */
export function captureException(error: unknown, context: CaptureContext): void {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const record: CapturedError = {
      timestamp: new Date().toISOString(),
      service: context.service,
      operation: context.operation,
      severity: context.severity ?? "error",
      message: String(err.message ?? error).slice(0, 2000),
      stack: err.stack?.slice(0, 4000),
      extra: redactExtra(context.extra),
    };
    if (context.tenantId) record.tenantId = context.tenantId;

    ring.push(record);
    if (ring.length > RING_BUFFER_CAPACITY) ring.splice(0, ring.length - RING_BUFFER_CAPACITY);

    stdoutSink(record);
    webhookSink(record);
  } catch {
    /* capture must never throw */
  }
}
