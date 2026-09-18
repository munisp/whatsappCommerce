/**
 * === W46 platform-p2 (PLT-25) ===
 * server/services/logRedact.ts — central PII-redaction helper for logs.
 *
 * NDPR/data-minimisation: phone numbers, email addresses and free-text
 * message bodies must never hit stdout/logs raw (W45 residual PLT-25:
 * waLocation logged `toPhone` + a body slice; waOnboarding/banCircuitBreaker
 * logged Graph error bodies that can embed recipient phones).
 *
 * Contract:
 *   - redact(value) — deep, best-effort sanitiser for log arguments:
 *       * E.164-ish phone strings  → "+234…**67" (keep prefix + last 2)
 *       * emails                   → "a…@example.com" (first char + domain)
 *       * long digit runs (≥7)     → same phone treatment
 *       * objects/arrays           — recursed (cycle-safe, depth-capped)
 *       * keys named phone/toPhone/waPhone/from/to/email/body/text/message
 *         are redacted wholesale regardless of shape.
 *   - rlog.{info,warn,error}(tag, ...args) — console.* wrappers that redact
 *     every argument before printing. Error objects keep name+message only.
 *
 * LINT NOTE (W46 PLT-25): new logging in server/ MUST route through rlog or
 * pass arguments through redact() — raw `console.*` with request payloads,
 * phones, emails or message bodies is banned. Until an eslint rule lands,
 * reviewers enforce this at review time; grep sentinel:
 *   grep -rn "console\." server/services | grep -E "phone|body|text"
 * must return only redacted call sites.
 */

const SENSITIVE_KEY_RE = /^(phone|phones|toPhone|fromPhone|waPhone|waId|from|to|msisdn|email|body|text|message|caption|content)$/i;
const PHONE_RE = /\+?\d[\d\s().-]{5,}\d/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MAX_DEPTH = 4;
const MAX_STRING = 300;

function maskPhone(s: string): string {
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7) return "***";
  return `${s.startsWith("+") ? "+" : ""}${digits.slice(0, 3)}…**${digits.slice(-2)}`;
}

function maskEmail(s: string): string {
  const at = s.indexOf("@");
  if (at <= 0) return "***@***";
  return `${s[0]}…@${s.slice(at + 1)}`;
}

/** Redact a single string (phones, emails, over-long free text). */
export function redactString(input: string): string {
  let out = input.slice(0, MAX_STRING * 4);
  out = out.replace(EMAIL_RE, (m) => maskEmail(m));
  out = out.replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 7 ? maskPhone(m) : m));
  if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}…[truncated]`;
  return out;
}

/** Deep redaction for log arguments. Never throws. */
export function redact<T = unknown>(value: T, keyHint?: string, depth = 0, seen?: WeakSet<object>): T {
  try {
    if (value == null) return value;
    if (keyHint && SENSITIVE_KEY_RE.test(keyHint)) {
      return (typeof value === "string" ? redactString(value) : "[redacted]") as unknown as T;
    }
    if (typeof value === "string") return redactString(value) as unknown as T;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;
    if (value instanceof Error) {
      return `${value.name}: ${redactString(value.message ?? "")}` as unknown as T;
    }
    if (depth >= MAX_DEPTH) return "[truncated]" as unknown as T;
    const tracker = seen ?? new WeakSet<object>();
    if (typeof value === "object") {
      if (tracker.has(value as object)) return "[circular]" as unknown as T;
      tracker.add(value as object);
      if (Array.isArray(value)) {
        return value.map((v) => redact(v, undefined, depth + 1, tracker)) as unknown as T;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = redact(v, k, depth + 1, tracker);
      }
      return out as T;
    }
    return String(value) as unknown as T;
  } catch {
    return "[redact-error]" as unknown as T;
  }
}

/** Redacting console wrappers — the sanctioned way to log PII-adjacent data. */
export const rlog = {
  info(tag: string, ...args: unknown[]): void {
    console.info(tag, ...args.map((a) => redact(a)));
  },
  warn(tag: string, ...args: unknown[]): void {
    console.warn(tag, ...args.map((a) => redact(a)));
  },
  error(tag: string, ...args: unknown[]): void {
    console.error(tag, ...args.map((a) => redact(a)));
  },
};
// === END W46 platform-p2 (PLT-25) ===
