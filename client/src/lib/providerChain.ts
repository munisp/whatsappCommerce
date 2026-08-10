/**
 * client/src/lib/providerChain.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave-11 provider-settings UI logic (pure, unit-tested):
 *  - fallback-chain ordering + preview labels
 *  - secret masking
 *  - custom-gateway JSON config validation
 */

export interface TenantProviderView {
  provider: string;
  displayName: string;
  enabled: boolean;
  priority: number;
  secretKey?: string | null;
  webhookSecret?: string | null;
  instructions?: string | null;
  customConfig?: Record<string, unknown> | null;
}

export const MASKED_SECRET = "••••••••";

/** Deterministic chain order: enabled first, ascending priority, name tiebreak. */
export function orderFallbackChain(providers: TenantProviderView[]): TenantProviderView[] {
  return [...providers]
    .filter((p) => p.enabled)
    .sort((a, b) => a.priority - b.priority || a.displayName.localeCompare(b.displayName));
}

/**
 * Preview lines for the fallback chain:
 *   ["1. Paystack (primary)", "2. Flutterwave (fallback)", …]
 */
export function fallbackChainPreview(providers: TenantProviderView[]): string[] {
  return orderFallbackChain(providers).map(
    (p, i) => `${i + 1}. ${p.displayName}${i === 0 ? " (primary)" : " (fallback)"}`,
  );
}

/** Never render a real secret; masked sentinel or em-dash. */
export function maskSecret(value: string | null | undefined): string {
  return value ? MASKED_SECRET : "—";
}

/** True when the form field still holds the masked sentinel (keep-on-write). */
export function isMaskedSentinel(value: string): boolean {
  return value.trim() === MASKED_SECRET;
}

export interface CustomConfigValidation {
  ok: boolean;
  errors: string[];
  parsed?: Record<string, unknown>;
}

/**
 * Validate a custom-gateway JSON config typed by the tenant. Shape hints:
 *  - must be a JSON object
 *  - "instructions" (string) recommended — what buyers receive
 *  - "baseUrl", when present, must be an http(s) URL
 */
export function validateCustomConfig(raw: string): CustomConfigValidation {
  const errors: string[] = [];
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, errors: ["Config is empty — provide a JSON object, e.g. { \"instructions\": \"…\" }"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e: any) {
    return { ok: false, errors: [`Invalid JSON: ${String(e?.message ?? e).slice(0, 120)}`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, errors: ["Config must be a JSON object ({ … }), not an array or scalar"] };
  }
  const obj = parsed as Record<string, unknown>;
  if ("instructions" in obj && typeof obj.instructions !== "string") {
    errors.push('"instructions" must be a string (the settlement text buyers receive)');
  }
  if ("baseUrl" in obj) {
    const u = obj.baseUrl;
    if (typeof u !== "string" || !/^https?:\/\//i.test(u)) {
      errors.push('"baseUrl" must be an http(s) URL, e.g. "https://api.my-gateway.example"');
    }
  }
  if (!("instructions" in obj) && !("baseUrl" in obj)) {
    errors.push('Hint: add "instructions" (buyer-facing settlement text) — without it a generic message is sent');
  }
  return { ok: errors.length === 0, errors, parsed: obj };
}
