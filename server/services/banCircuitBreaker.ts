// === W45 messaging-services (Coder A2) ===
/**
 * banCircuitBreaker.ts — per-phone_number_id ban/restriction circuit breaker
 * (MSG-25).
 *
 * When a WABA phone number gets banned or restricted, every send through it
 * fails — but the failure is discovered per-message, the retry sweep keeps
 * hammering the banned number, and (worst) the dead-letter admin alert is
 * sent over the SAME banned number, so nobody ever learns about it.
 *
 * This breaker:
 *  - `recordWaSendErrorSignal(tenantId, phoneNumberId, httpStatus, errorBody)`
 *    inspects a failed Graph response; HTTP 401/403 (token revoked / account
 *    restricted) or a ban-class error code trips the circuit for that
 *    phone_number_id.
 *  - `isBanCircuitOpen(phoneNumberId)` is consulted by every waSender send
 *    path BEFORE hitting Graph — an open circuit fails the send locally
 *    (permanent class, no retry storm).
 *  - Tripping alerts OFF-CHANNEL: an audit_logs row (dashboard-visible) plus
 *    an email to the tenant admin when settings carry an admin email. It
 *    NEVER alerts over the banned WhatsApp number itself.
 *
 * State: Redis key `wa:ban:{phoneNumberId}` (TTL BAN_CIRCUIT_TTL_SECONDS,
 * refreshed on repeated signals) + in-memory fallback in dev/test. A tripped
 * circuit auto-resets when the TTL lapses; ops can clear it explicitly with
 * `clearBanCircuit` after the WABA restriction is lifted.
 */

import { eq, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import { getRedis } from "../redis";
import { isProd } from "../_core/env";
import { redactString } from "./logRedact"; // W46 platform-p2 (PLT-25)

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** How long a tripped circuit stays open (refreshed on repeated signals). */
export const BAN_CIRCUIT_TTL_SECONDS = 6 * 3600;

/**
 * Meta error codes indicating the SENDER (phone_number_id / WABA) is banned
 * or restricted — as opposed to recipient-level codes (suppression list).
 *  - 131031 business account locked/restricted
 *  - 131032 / 131033 user-level restrictions surfaced on the sender
 *  - 368 temporarily blocked for policy violations
 *  - 133004 server-side sender registration issues
 * HTTP 401 (token revoked) and 403 (permission withdrawn — the common shape
 * of a banned/restricted number) always trip the circuit regardless of code.
 */
export const WA_BAN_ERROR_CODES: ReadonlySet<number> = new Set([131031, 131032, 131033, 368, 133004]);

function circuitKey(phoneNumberId: string): string {
  return `wa:ban:${phoneNumberId}`;
}

// ── Circuit state (Redis + in-memory fallback) ──────────────────────────────

const memoryCircuits = new Map<string, number>(); // phoneNumberId → expiresAt ms

/** Test helper: wipe the in-memory fallback. */
export function __clearBanCircuitMemory(): void {
  memoryCircuits.clear();
}

function memoryIsOpen(phoneNumberId: string): boolean {
  const exp = memoryCircuits.get(phoneNumberId);
  if (exp == null) return false;
  if (exp <= Date.now()) {
    memoryCircuits.delete(phoneNumberId);
    return false;
  }
  return true;
}

/** True when sends through this phone_number_id are circuit-broken. */
export async function isBanCircuitOpen(phoneNumberId: string | null | undefined): Promise<boolean> {
  if (!phoneNumberId) return false;
  try {
    const redis = await getRedis();
    if (redis) {
      const v = await redis.get(circuitKey(phoneNumberId));
      return v != null;
    }
  } catch { /* fall through */ }
  if (isProd) return false; // fail-open in prod on Redis outage — sends error naturally
  return memoryIsOpen(phoneNumberId);
}

/** Clear the circuit after the WABA restriction is lifted. */
export async function clearBanCircuit(phoneNumberId: string): Promise<void> {
  try {
    const redis = await getRedis();
    if (redis) {
      await redis.del(circuitKey(phoneNumberId));
      return;
    }
  } catch { /* fall through */ }
  if (!isProd) memoryCircuits.delete(phoneNumberId);
}

// ── Off-channel alert ───────────────────────────────────────────────────────

/** Resolve an admin email from tenant settings (adminEmail / notifications.email). */
export async function resolveAdminEmail(db: Db, tenantId: string): Promise<string | null> {
  const [t] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  const s = (t?.settings ?? {}) as Record<string, any>;
  const cand = s?.adminEmail ?? s?.email ?? s?.notifications?.email ?? s?.whatsapp?.adminEmail;
  return typeof cand === "string" && cand.includes("@") ? cand.trim() : null;
}

/**
 * Alert ops + the tenant admin that a phone number is circuit-broken.
 * OFF-CHANNEL ONLY: audit_logs (dashboard) + admin email. Never WhatsApp —
 * the banned number cannot deliver its own ban alert.
 */
export async function alertBanCircuitTripped(
  db: Db,
  tenantId: string,
  phoneNumberId: string,
  detail: string,
): Promise<void> {
  const summary = `WhatsApp sender ${phoneNumberId} circuit-broken for tenant ${tenantId}: ${detail.slice(0, 300)}`;
  console.error(`[banCircuit] ${summary}`);
  try {
    await db.execute(sql`
      INSERT INTO audit_logs (id, tenant_id, actor_id, actor_role, action, entity_type, entity_id, summary, created_at)
      VALUES (gen_random_uuid(), ${tenantId}, 'ban-circuit-breaker', 'system', 'wa.ban_circuit_tripped', 'wa_phone_number_id', ${phoneNumberId}, ${JSON.stringify({ detail: detail.slice(0, 1000), trippedAt: new Date().toISOString() })}, NOW())
    `);
  } catch (e: any) {
    console.warn("[banCircuit] audit log insert failed:", e?.message);
  }
  try {
    const email = await resolveAdminEmail(db, tenantId);
    if (email) {
      const { sendEmail } = await import("./email/resend");
      await sendEmail({
        to: email,
        subject: "[WAC] WhatsApp number restricted — sends paused",
        text:
          `Your WhatsApp sender (phone_number_id ${phoneNumberId}) is returning ban/restriction errors and outbound ` +
          `messaging through it has been paused automatically.\n\nDetail: ${detail.slice(0, 500)}\n\n` +
          `Check Meta Business Manager for the restriction, resolve it, then contact support to re-enable sending.`,
        html:
          `<p>Your WhatsApp sender (<code>${phoneNumberId}</code>) is returning ban/restriction errors and outbound ` +
          `messaging through it has been <b>paused automatically</b>.</p>` +
          `<p><b>Detail:</b> ${detail.slice(0, 500)}</p>` +
          `<p>Check Meta Business Manager for the restriction, resolve it, then contact support to re-enable sending.</p>`,
      });
    } else {
      console.warn(`[banCircuit] tenant=${tenantId} has no admin email configured — dashboard audit row only`);
    }
  } catch (e: any) {
    console.warn("[banCircuit] email alert failed:", e?.message);
  }
}

// ── Signal detection ────────────────────────────────────────────────────────

/** Extract Meta error codes from a Graph error body (text/JSON). */
export function extractGraphErrorCodes(errorBody: string | null | undefined): number[] {
  if (!errorBody) return [];
  try {
    const parsed = JSON.parse(errorBody);
    const out: number[] = [];
    const walk = (node: any) => {
      if (!node || typeof node !== "object") return;
      if (node.code != null && Number.isFinite(Number(node.code))) out.push(Number(node.code));
      for (const v of Object.values(node)) {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") walk(v);
      }
    };
    walk(parsed?.error ?? parsed);
    return Array.from(new Set(out));
  } catch {
    return [];
  }
}

/** True when this failure is a sender ban/restriction signal. */
export function isBanSignal(httpStatus: number | null, errorBody: string | null | undefined): boolean {
  if (httpStatus === 401 || httpStatus === 403) return true;
  return extractGraphErrorCodes(errorBody).some((c) => WA_BAN_ERROR_CODES.has(c));
}

/**
 * Trip the circuit for a phone_number_id. Idempotent within the TTL — the
 * off-channel alert fires ONCE per trip (guarded by whether the key already
 * existed). Never throws.
 */
export async function tripBanCircuit(
  db: Db | null,
  tenantId: string,
  phoneNumberId: string,
  detail: string,
): Promise<void> {
  if (!phoneNumberId) return;
  let alreadyOpen = false;
  try {
    const redis = await getRedis();
    if (redis) {
      // Only alert on the first trip within a TTL window.
      const existing = await redis.get(circuitKey(phoneNumberId));
      alreadyOpen = existing != null;
      await redis.set(circuitKey(phoneNumberId), JSON.stringify({ tenantId, at: new Date().toISOString() }), "EX", BAN_CIRCUIT_TTL_SECONDS);
    } else if (!isProd) {
      alreadyOpen = memoryIsOpen(phoneNumberId);
      memoryCircuits.set(phoneNumberId, Date.now() + BAN_CIRCUIT_TTL_SECONDS * 1000);
    }
  } catch (e: any) {
    console.warn("[banCircuit] trip store failed:", e?.message);
  }
  if (alreadyOpen) return;
  if (db) await alertBanCircuitTripped(db, tenantId, phoneNumberId, detail);
  else console.error(`[banCircuit] circuit tripped (no DB for alert) tenant=${tenantId} sender=${redactString(phoneNumberId)}: ${redactString(detail.slice(0, 200))}`); // W46 platform-p2 (PLT-25)
}

/**
 * Inspect a failed Graph send and trip the circuit when it is a ban signal.
 * Call from every waSender failure path with the HTTP status + raw error
 * body. Returns true when this failure tripped (or kept) the circuit open.
 * Never throws.
 */
export async function recordWaSendErrorSignal(
  db: Db | null,
  tenantId: string,
  phoneNumberId: string | null | undefined,
  httpStatus: number | null,
  errorBody: string | null | undefined,
): Promise<boolean> {
  try {
    if (!phoneNumberId || !isBanSignal(httpStatus, errorBody)) return false;
    await tripBanCircuit(db, tenantId, phoneNumberId, `Graph ${httpStatus ?? "?"}: ${String(errorBody ?? "").slice(0, 300)}`);
    return true;
  } catch (e: any) {
    console.warn("[banCircuit] signal handling failed:", e?.message);
    return false;
  }
}
