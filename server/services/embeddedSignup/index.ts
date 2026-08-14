/**
 * W16 Meta embedded signup (roadmap F9) — BSP-grade onboarding speed.
 *
 * Implements the server half of Meta's official Embedded Signup flow:
 *   1. The client runs the FB JS SDK signup popup and receives a `code`
 *      (plus optional session-info hints: waba_id / phone_number_id).
 *   2. We exchange the code for a Meta access token:
 *        GET {graph}/oauth/access_token?client_id&client_secret&code
 *   3. We resolve the tenant's WABA + phone-number assignment:
 *        - hints from the session info win when present;
 *        - otherwise debug_token granular_scopes → WABA ids, then
 *          GET /{wabaId}/phone_numbers for the assigned number.
 *   4. The result is persisted onto the tenant's existing WhatsApp
 *      credential storage (tenants.whatsappBusinessAccountId /
 *      tenants.whatsappPhoneNumberId columns + settings.whatsapp.*, the
 *      same keys waSender/waTemplates already read) plus a bookkeeping
 *      record under settings.embeddedSignup.
 *
 * Guarantees:
 *   - Injectable fetch + 8s timeout on every Meta call.
 *   - Secrets (app secret, access tokens) are never echoed in errors.
 *   - Idempotent: replaying the same code returns the recorded state
 *     without re-calling Meta or duplicating rows.
 *   - Structured failure taxonomy the client can render:
 *       expired_code | permission_denied | no_waba_selected | meta_api_error
 */

import { eq, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { tenants } from "../../../drizzle/schema";
import { ENV } from "../../_core/env";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type FetchFn = typeof fetch;

export const EMBEDDED_SIGNUP_ERROR_CODES = [
  "expired_code",
  "permission_denied",
  "no_waba_selected",
  "meta_api_error",
] as const;
export type EmbeddedSignupErrorCode = (typeof EMBEDDED_SIGNUP_ERROR_CODES)[number];

export class EmbeddedSignupError extends Error {
  readonly code: EmbeddedSignupErrorCode;
  readonly metaStatus?: number;
  constructor(code: EmbeddedSignupErrorCode, message: string, metaStatus?: number) {
    super(message);
    this.name = "EmbeddedSignupError";
    this.code = code;
    this.metaStatus = metaStatus;
  }
}

export type CoexistenceMode = "exclusive" | "coexistence";

export interface EmbeddedSignupRecord {
  status: "completed";
  code: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  /** Whether the tenant keeps their existing WhatsApp Business app on the
   *  same number (Meta "coexistence"). */
  coexistence: boolean;
  onboardingStatus: "completed";
  onboardedAt: string;
}

export interface CompleteSignupInput {
  tenantId: string;
  code: string;
  /** Session-info hints from the JS callback (optional). */
  wabaId?: string;
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  coexistence?: boolean;
}

export interface CompleteSignupResult {
  record: EmbeddedSignupRecord;
  /** True when the code had already been exchanged (replay, no Meta call). */
  replayed: boolean;
}

const GRAPH_BASE = () => ENV.metaGraphBaseUrl.replace(/\/+$/, "");
const TIMEOUT_MS = () => ENV.metaEmbeddedSignupTimeoutMs;

/** Strip any occurrence of a secret from text (defence for error messages). */
export function redactSecrets(text: string, ...secrets: Array<string | undefined | null>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  }
  return out;
}

async function fetchWithTimeout(url: string, init: RequestInit, fetchFn: FetchFn): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface MetaErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
}

/** Map a non-OK Meta Graph response onto the failure taxonomy. */
function classifyMetaError(status: number, body: MetaErrorBody, secret: string): EmbeddedSignupError {
  const rawMsg = String(body?.error?.message ?? `Meta API error (HTTP ${status})`);
  const msg = redactSecrets(rawMsg, secret).slice(0, 300);
  const code = Number(body?.error?.code ?? 0);
  const subcode = Number(body?.error?.error_subcode ?? 0);
  // OAuth code errors: 100 (invalid parameter) with OAuthException, 190
  // (access token expired/invalid). Treat "code has expired/used" as expired.
  if (
    code === 190 ||
    subcode === 36003 || // code expired
    /code.*(expired|invalid|already been used)/i.test(rawMsg)
  ) {
    return new EmbeddedSignupError("expired_code", msg, status);
  }
  if (
    code === 200 ||
    code === 10 ||
    status === 403 ||
    /permission/i.test(rawMsg)
  ) {
    return new EmbeddedSignupError("permission_denied", msg, status);
  }
  return new EmbeddedSignupError("meta_api_error", msg, status);
}

/** Exchange the embedded-signup `code` for a Meta access token. */
export async function exchangeCodeForToken(code: string, fetchFn: FetchFn = fetch): Promise<string> {
  const appId = ENV.metaAppId;
  const appSecret = ENV.metaAppSecret;
  if (!appId || !appSecret) {
    throw new EmbeddedSignupError(
      "meta_api_error",
      "Embedded signup is not configured (META_APP_ID / META_APP_SECRET unset)",
    );
  }
  const url =
    `${GRAPH_BASE()}/oauth/access_token` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&code=${encodeURIComponent(code)}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, { method: "GET" }, fetchFn);
  } catch (err: any) {
    const msg = err?.name === "AbortError" ? "Meta token exchange timed out" : "Meta token exchange failed";
    throw new EmbeddedSignupError("meta_api_error", msg);
  }
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !body?.access_token) {
    throw classifyMetaError(res.status, body as MetaErrorBody, appSecret);
  }
  return String(body.access_token);
}

interface DebugTokenBody {
  data?: {
    granular_scopes?: Array<{ scope?: string; target_ids?: string[] }>;
  };
}

/** Discover WABA ids the token grants whatsapp_business_management on. */
async function discoverWabaIds(appId: string, appSecret: string, token: string, fetchFn: FetchFn): Promise<string[]> {
  const url =
    `${GRAPH_BASE()}/debug_token?input_token=${encodeURIComponent(token)}` +
    `&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`;
  const res = await fetchWithTimeout(url, { method: "GET" }, fetchFn);
  const body = (await res.json().catch(() => ({}))) as DebugTokenBody & MetaErrorBody;
  if (!res.ok) throw classifyMetaError(res.status, body, appSecret);
  const scopes = Array.isArray(body?.data?.granular_scopes) ? body.data!.granular_scopes! : [];
  const ids = scopes
    .filter((s) => s?.scope === "whatsapp_business_management" && Array.isArray(s.target_ids))
    .flatMap((s) => s.target_ids as string[]);
  return Array.from(new Set(ids.map(String)));
}

interface PhoneNumbersBody {
  data?: Array<{ id?: string; display_phone_number?: string; verified_name?: string }>;
}

/** Fetch phone numbers assigned to a WABA for this token. */
async function fetchPhoneNumbers(
  wabaId: string,
  token: string,
  fetchFn: FetchFn,
): Promise<Array<{ id: string; displayPhoneNumber: string }>> {
  const url =
    `${GRAPH_BASE()}/${encodeURIComponent(wabaId)}/phone_numbers` +
    `?fields=id,display_phone_number,verified_name&limit=100`;
  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  }, fetchFn);
  const body = (await res.json().catch(() => ({}))) as PhoneNumbersBody & MetaErrorBody;
  if (!res.ok) throw classifyMetaError(res.status, body, token);
  const rows = Array.isArray(body?.data) ? body.data! : [];
  return rows
    .filter((r) => r?.id)
    .map((r) => ({ id: String(r.id), displayPhoneNumber: String(r.display_phone_number ?? "") }));
}

/** Read the persisted embedded-signup record (null when never onboarded). */
export function parseEmbeddedSignupRecord(settings: unknown): EmbeddedSignupRecord | null {
  const raw = (settings as any)?.embeddedSignup;
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.code !== "string" || typeof raw.wabaId !== "string") return null;
  return {
    status: "completed",
    code: raw.code,
    wabaId: raw.wabaId,
    phoneNumberId: String(raw.phoneNumberId ?? ""),
    displayPhoneNumber: String(raw.displayPhoneNumber ?? ""),
    coexistence: raw.coexistence === true,
    onboardingStatus: "completed",
    onboardedAt: typeof raw.onboardedAt === "string" ? raw.onboardedAt : "",
  };
}

/**
 * Exchange + persist. Idempotent per (tenant, code): a replayed code returns
 * the stored record with `replayed: true` and performs no Meta calls.
 */
export async function completeEmbeddedSignup(
  db: Db,
  input: CompleteSignupInput,
  fetchFn: FetchFn = fetch,
): Promise<CompleteSignupResult> {
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, input.tenantId))
    .limit(1)
    .catch(() => []);
  if (!tenant) {
    throw new EmbeddedSignupError("meta_api_error", "Tenant not found");
  }
  const existing = parseEmbeddedSignupRecord(tenant.settings);
  if (existing && existing.code === input.code) {
    return { record: existing, replayed: true };
  }

  const token = await exchangeCodeForToken(input.code, fetchFn);

  // Resolve WABA id: client session-info hint wins; otherwise discover.
  let wabaId = (input.wabaId ?? "").trim();
  if (!wabaId) {
    const ids = await discoverWabaIds(ENV.metaAppId, ENV.metaAppSecret, token, fetchFn);
    if (ids.length === 0) {
      throw new EmbeddedSignupError(
        "no_waba_selected",
        "No WhatsApp Business Account was selected during signup",
      );
    }
    wabaId = ids[0];
  }

  // Resolve the phone-number assignment.
  let phoneNumberId = (input.phoneNumberId ?? "").trim();
  let displayPhoneNumber = (input.displayPhoneNumber ?? "").trim();
  if (!phoneNumberId) {
    const numbers = await fetchPhoneNumbers(wabaId, token, fetchFn);
    if (numbers.length === 0) {
      throw new EmbeddedSignupError(
        "no_waba_selected",
        "No phone number is assigned to the selected WhatsApp Business Account",
      );
    }
    phoneNumberId = numbers[0].id;
    displayPhoneNumber = displayPhoneNumber || numbers[0].displayPhoneNumber;
  }

  const record: EmbeddedSignupRecord = {
    status: "completed",
    code: input.code,
    wabaId,
    phoneNumberId,
    displayPhoneNumber,
    coexistence: input.coexistence === true,
    onboardingStatus: "completed",
    onboardedAt: new Date().toISOString(),
  };

  // Persist onto the existing WhatsApp credential storage:
  //   settings.whatsapp.{wabaId,phoneNumberId,accessToken,displayPhoneNumber}
  // are the keys waSender / waTemplates already resolve from. The
  // embeddedSignup block is bookkeeping (idempotency + coexistence state).
  const patch = {
    whatsapp: {
      ...((((tenant.settings as any)?.whatsapp) ?? {}) as Record<string, unknown>),
      wabaId,
      phoneNumberId,
      accessToken: token,
      displayPhoneNumber,
      coexistence: record.coexistence,
      onboardingStatus: "completed",
    },
    embeddedSignup: record,
  };
  await db
    .update(tenants)
    .set({
      whatsappBusinessAccountId: wabaId,
      whatsappPhoneNumberId: phoneNumberId,
      settings: sql`COALESCE(${tenants.settings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    } as any)
    .where(eq(tenants.id, input.tenantId));

  return { record, replayed: false };
}
