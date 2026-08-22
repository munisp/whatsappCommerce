/**
 * Shared helpers for the E2E suite.
 *
 * All connection settings come from env vars (exported by scripts/run-e2e.sh
 * after it resolves the ephemeral compose ports). Defaults assume the
 * well-known container ports published on localhost.
 *
 * Only repository-existing dependencies are used: postgres, superjson, jose.
 */
import postgres from "postgres";
import superjson from "superjson";
import { SignJWT } from "jose";

export const CFG = {
  platformUrl: process.env.PLATFORM_URL ?? "http://localhost:3000",
  gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:8080",
  commerceUrl: process.env.COMMERCE_URL ?? "http://localhost:8083",
  ledgerUrl: process.env.LEDGER_URL ?? "http://localhost:8095",
  reconUrl: process.env.RECON_URL ?? "http://localhost:8096",
  mlUrl: process.env.ML_URL ?? "http://localhost:8099",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://wc_user:wc_secret@localhost:5432/whatsapp_commerce",
  /** Must match JWT_SECRET in tests/e2e/docker-compose.test.yml. */
  jwtSecret: process.env.JWT_SECRET ?? "e2e-jwt-secret",
  /** Must match INTERNAL_API_KEY in the compose file. */
  internalApiKey: process.env.INTERNAL_API_KEY ?? "e2e-internal-key",
  /** Must match PAYSTACK_WEBHOOK_SECRET in the compose file. */
  paystackWebhookSecret:
    process.env.PAYSTACK_WEBHOOK_SECRET ?? "e2e-paystack-webhook-secret",
  /** Must match ESCROW_BANK_WEBHOOK_SECRET in the compose file. */
  escrowBankWebhookSecret:
    process.env.ESCROW_BANK_WEBHOOK_SECRET ?? "e2e-escrow-bank-webhook-secret",
} as const;

export const HTTP_TIMEOUT = 15_000;

export async function getJson(base: string, path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    headers,
    signal: AbortSignal.timeout(HTTP_TIMEOUT),
  });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function postJson(
  base: string,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    signal: AbortSignal.timeout(HTTP_TIMEOUT),
  });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function postRaw(
  base: string,
  path: string,
  raw: string,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: raw,
    signal: AbortSignal.timeout(HTTP_TIMEOUT),
  });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ─── tRPC HTTP client (matches the server's superjson transformer) ───────────

export type TrpcResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number;
      error: { message: string; code: number; trpcCode?: string; httpStatus?: number };
    };

function parseTrpcResponse(status: number, json: unknown): TrpcResult {
  const j = json as Record<string, unknown> | null;
  if (j && "error" in j && j.error) {
    // With the superjson transformer the error payload is wrapped:
    // { error: { json: { message, code, data: { code, httpStatus } } } }
    const raw = j.error as Record<string, unknown>;
    const err = (raw.json ?? raw) as {
      message?: string;
      code?: number;
      data?: { code?: string; httpStatus?: number };
    };
    return {
      ok: false,
      status,
      error: {
        message: err.message ?? "unknown tRPC error",
        code: err.code ?? -32603,
        trpcCode: err.data?.code,
        httpStatus: err.data?.httpStatus,
      },
    };
  }
  const data = (j as { result?: { data?: unknown } } | null)?.result?.data;
  // superjson transformer wraps payloads as { json: <value>, meta?: ... }
  const unwrapped =
    data && typeof data === "object" && "json" in (data as Record<string, unknown>)
      ? superjson.deserialize(data as never)
      : data;
  return { ok: true, status, data: unwrapped };
}

export async function trpcQuery<T = unknown>(
  procedure: string,
  input?: unknown,
  token?: string,
): Promise<TrpcResult<T>> {
  const url = new URL(`${CFG.platformUrl}/api/trpc/${procedure}`);
  if (input !== undefined) {
    url.searchParams.set("input", superjson.stringify(input));
  }
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(HTTP_TIMEOUT),
  });
  const json = await res.json().catch(() => null);
  return parseTrpcResponse(res.status, json) as TrpcResult<T>;
}

export async function trpcMutation<T = unknown>(
  procedure: string,
  input?: unknown,
  token?: string,
): Promise<TrpcResult<T>> {
  const res = await fetch(`${CFG.platformUrl}/api/trpc/${procedure}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: input === undefined ? superjson.stringify(null) : superjson.stringify(input),
    signal: AbortSignal.timeout(HTTP_TIMEOUT),
  });
  const json = await res.json().catch(() => null);
  return parseTrpcResponse(res.status, json) as TrpcResult<T>;
}

// ─── Auth helpers ────────────────────────────────────────────────────────────

/**
 * Mint a platform session token (HS256 JWT signed with JWT_SECRET), matching
 * server/_core/sdk.ts signSession(): { openId, appId: "wacommerce", name }.
 */
export async function mintPlatformSession(openId: string, name = "E2E User"): Promise<string> {
  return new SignJWT({ openId, appId: "wacommerce", name })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(CFG.jwtSecret));
}

/**
 * Mint a gateway JWT, matching services/gateway JWTClaims:
 * { sub, tenant_id, role } HS256 with JWT_SECRET.
 */
export async function mintGatewayJwt(claims: {
  sub: string;
  tenant_id?: string;
  role?: string;
}): Promise<string> {
  return new SignJWT({ tenant_id: claims.tenant_id ?? "", role: claims.role ?? "user" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.sub)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(CFG.jwtSecret));
}

// ─── Database helpers ────────────────────────────────────────────────────────

let _sql: ReturnType<typeof postgres> | null = null;

export function getSql() {
  if (!_sql) {
    _sql = postgres(CFG.databaseUrl, { max: 5, connect_timeout: 10 });
  }
  return _sql;
}

export async function closeSql() {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
  }
}

/**
 * Insert (or refresh) a users row so sdk.authenticateRequest finds the
 * session's openId in the DB. Returns the numeric user id.
 */
export async function seedUser(opts: {
  openId: string;
  name: string;
  role?: "user" | "admin" | "operator" | "analyst";
  tenantId?: string;
}): Promise<number> {
  const sql = getSql();
  const rows = await sql<{ id: number }[]>`
    INSERT INTO users ("openId", "name", "role", "tenantId", "lastSignedIn", "createdAt", "updatedAt")
    VALUES (${opts.openId}, ${opts.name}, ${opts.role ?? "user"}, ${opts.tenantId ?? null}, NOW(), NOW(), NOW())
    ON CONFLICT ("openId")
    DO UPDATE SET "role" = EXCLUDED."role", "lastSignedIn" = NOW(), "updatedAt" = NOW()
    RETURNING id`;
  return rows[0].id;
}

export function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Reachability / configuration gates (for conditional live tests) ─────────

/**
 * True when `base` answers a GET to `path` with any non-network-error status.
 * Used to gate live service-to-service assertions: when a service is absent
 * from the stack (e.g. `--no-ml`, or a local partial stack) the caller skips
 * instead of failing.
 */
export async function reachable(base: string, path = "/health", timeoutMs = 5_000): Promise<boolean> {
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 599;
  } catch {
    return false;
  }
}

/**
 * True when the given env var holds a non-empty value — i.e. the service was
 * configured for this run (scripts/run-e2e.sh only exports ML_URL when the
 * ml-inference profile is started, PLATFORM_URL/DATABASE_URL always, …).
 */
export function serviceConfigured(envVar: string): boolean {
  return !!process.env[envVar]?.trim();
}
