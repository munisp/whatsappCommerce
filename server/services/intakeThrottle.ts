// === W47 crosscutting ===
/**
 * intakeThrottle.ts — ONB-ABU-1: abuse guards for the UNAUTHENTICATED
 * platform onboarding intake number (ONBOARDING_PHONE_NUMBER_ID).
 *
 * Pre-W47 every inbound text/voice note on the intake number started/resumed
 * a copilot session and called runAgentTurn (LLM) with no per-phone throttle,
 * and ensureTenant minted a real tenant row per session — a zero-auth
 * LLM-spend + fake-tenant factory.
 *
 * Guards (all per-phone fixed-window counters, env-tunable, fail-CLOSED in
 * production when the shared counter store is unavailable — same policy as
 * phoneAuth's OTP caps; dev/test falls back to in-memory with a warning):
 *
 *   ONB_INTAKE_MAX_MSGS_PER_HOUR       inbound messages/phone/hour (def 60)
 *   ONB_INTAKE_MAX_SESSIONS_PER_DAY    NEW copilot sessions/phone/day (def 3)
 *   ONB_INTAKE_MAX_TENANTS_PER_DAY     tenant provisions/phone/day (def 2)
 *
 * Tests inject a shared store via __setIntakeCounterStoreForTest (mirrors
 * phoneAuth.__setOtpCounterStoreForTest).
 */
import { isProd } from "../_core/env";

export interface IntakeCounterStore {
  incr(key: string, ttlSeconds: number): Promise<number>;
}
let injectedStore: IntakeCounterStore | null = null;
/** Test/sim hook: share one store across module instances. */
export function __setIntakeCounterStoreForTest(store: IntakeCounterStore | null): void {
  injectedStore = store;
}
/** Test hook: clear the in-memory fallback counters between tests. */
export function __resetIntakeCountersForTest(): void {
  memory.clear();
}

const memory = new Map<string, { windowStart: number; count: number }>();
function bumpMemory(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const e = memory.get(key);
  if (!e || now - e.windowStart >= windowMs) {
    memory.set(key, { windowStart: now, count: 1 });
    return true;
  }
  e.count += 1;
  return e.count <= limit;
}

function envInt(name: string, def: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export const INTAKE_LIMITS = {
  get msgsPerHour() { return envInt("ONB_INTAKE_MAX_MSGS_PER_HOUR", 60); },
  get sessionsPerDay() { return envInt("ONB_INTAKE_MAX_SESSIONS_PER_DAY", 3); },
  get tenantsPerDay() { return envInt("ONB_INTAKE_MAX_TENANTS_PER_DAY", 2); },
};

export type IntakeThrottleKind = "msg" | "session" | "tenant";

/**
 * Bump the per-phone counter for `kind`. Returns true when UNDER the cap.
 * Throws (fail-closed) in production when no distributed counter is
 * available — a blind cap on an unauthenticated intake surface is no cap.
 */
export async function bumpIntakeCounter(kind: IntakeThrottleKind, phone: string): Promise<boolean> {
  const cfg = {
    msg: { limit: INTAKE_LIMITS.msgsPerHour, ttl: 3600, windowMs: 3_600_000 },
    session: { limit: INTAKE_LIMITS.sessionsPerDay, ttl: 86400, windowMs: 86_400_000 },
    tenant: { limit: INTAKE_LIMITS.tenantsPerDay, ttl: 86400, windowMs: 86_400_000 },
  }[kind];
  const key = `onb-intake:${kind}:${phone}`;
  if (injectedStore) {
    return (await injectedStore.incr(key, cfg.ttl)) <= cfg.limit;
  }
  try {
    const { redisIncrExStrict } = await import("../_core/rateLimit");
    return (await redisIncrExStrict(key, cfg.ttl)) <= cfg.limit;
  } catch (e: any) {
    if (isProd) {
      throw new Error(
        `[waOnboarding] intake throttle unavailable (${e?.message ?? e}) — refusing unauthenticated intake (fail closed)`,
      );
    }
    console.warn(`[waOnboarding] Redis counter unavailable (${e?.message ?? e}) — dev in-memory intake cap fallback`);
    return bumpMemory(key, cfg.limit, cfg.windowMs);
  }
}
// === END W47 crosscutting ===
