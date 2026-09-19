// === W46 privacy-consent (TEN-20) ===
/**
 * deviceAuth.ts — new-device login second factor (SIM-swap defense).
 *
 * Phone-OTP login proves possession of the PHONE NUMBER only. After a SIM
 * swap that proof is attacker-controlled, so a login from an UNKNOWN device
 * requires an INDEPENDENT second factor: a fresh OTP sent to the account's
 * email address (a different code, different channel, different session row
 * with purpose "device_email" — NOT a mirror of the WhatsApp OTP).
 *
 * Flow (routers/phoneAuth.ts W46 block):
 *   1. verifyOtp({..., deviceHash}) — when the phone maps to a user with an
 *      email and the device is unknown, the login is HELD: no session is
 *      minted; a device challenge (email OTP) is issued and the OWNER is
 *      notified of the anomalous new-device login.
 *   2. verifyDeviceFactor({ sessionId, otp, deviceHash }) — validates the
 *      email OTP and remembers the device (auth_known_devices).
 *   3. Admin recovery: adminDeviceReset clears a user's known devices behind
 *      a step-up challenge + audit row, so a user who lost BOTH factors has
 *      a governed path back.
 *
 * Devices are keyed by a CLIENT-SUPPLIED fingerprint hash (never raw
 * identifiers).
 *
 * === W47 crosscutting (ONB-ID-1) — mandatory second-factor policy ======
 * Pre-W47 gaps: (a) accounts with NO email got zero second factor (the common
 * WhatsApp-first SMB case — SIM-swap = full takeover), and (b) clients that
 * omit deviceHash silently kept legacy behavior even for email accounts.
 *
 * Policy is env-driven (see env.example.txt):
 *   DEVICE_FACTOR_POLICY=required (DEFAULT, fail-closed)
 *     - login without deviceHash for a KNOWN account → rejected (client must
 *       send a fingerprint);
 *     - unknown device + email on file → held behind the email OTP (W46);
 *     - unknown device + NO email → held behind a COOLING-OFF challenge
 *       (purpose "device_cooloff"): the login completes only after
 *       DEVICE_COOLOFF_MINUTES (default 1440 = 24h) have elapsed, the owner
 *       is notified on the existing channel, and the hold is audit-logged.
 *       Platform-admin step-up (adminResetDevices) remains the governed
 *       recovery for a user who lost both factors.
 *   DEVICE_FACTOR_POLICY=legacy
 *     - exact pre-W47 behavior (email+deviceHash opt-in only). Intended as a
 *       short-lived rollout escape hatch, not a steady state.
 * === END W47 crosscutting ===
 */
import { and, eq } from "drizzle-orm";
import { createHash, randomUUID } from "crypto";
import { authKnownDevices, phoneOtpSessions, users } from "../../drizzle/schema";

export const DEVICE_OTP_PURPOSE = "device_email";
// === W47 crosscutting (ONB-ID-1): cooling-off second factor for accounts
// with no email on file (phone-only WhatsApp-first accounts). ===
export const DEVICE_COOLOFF_PURPOSE = "device_cooloff";
const DEVICE_CHALLENGE_TTL_MS = 10 * 60 * 1000;

export type DeviceFactorPolicy = "required" | "legacy";

/**
 * Second-factor policy (env DEVICE_FACTOR_POLICY). DEFAULT IS "required"
 * (fail-closed): the legacy bypass must be opted INTO explicitly.
 */
export function deviceFactorPolicy(env: NodeJS.ProcessEnv = process.env): DeviceFactorPolicy {
  return (env.DEVICE_FACTOR_POLICY ?? "").trim().toLowerCase() === "legacy" ? "legacy" : "required";
}

/** Cooling-off window for no-email accounts (minutes; default 24h). */
export function deviceCooloffMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const v = parseInt(env.DEVICE_COOLOFF_MINUTES ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : 24 * 60;
}

/**
 * Issue a COOLING-OFF challenge for a phone-only account logging in from an
 * unknown device: the held login matures after DEVICE_COOLOFF_MINUTES, giving
 * the real owner a window to react to the anomaly notification. Returns the
 * challenge sessionId and the earliest completion time.
 */
export async function issueCooloffChallenge(
  db: any,
  opts: { userId: number; phone: string },
): Promise<{ sessionId: string; maturesAt: Date }> {
  const sessionId = randomUUID();
  const now = new Date();
  const maturesAt = new Date(now.getTime() + deviceCooloffMinutes() * 60_000);
  // ONB-ID-4: atomic upsert on the (phone,purpose) unique backstop.
  await db.insert(phoneOtpSessions).values({
    id: sessionId,
    phone: opts.phone,
    // No code to guess — the challenge is time-gated. A random unguessable
    // hash keeps the not-null otp_hash column satisfied without semantics.
    otpHash: `cooloff:${randomUUID()}`,
    attempts: 0,
    expiresAt: maturesAt, // reused as the MATURITY timestamp for this purpose
    createdAt: now,
    purpose: DEVICE_COOLOFF_PURPOSE,
    userId: opts.userId,
  }).onConflictDoUpdate({
    target: [phoneOtpSessions.phone, phoneOtpSessions.purpose],
    set: {
      id: sessionId,
      otpHash: `cooloff:${randomUUID()}`,
      attempts: 0,
      expiresAt: maturesAt,
      createdAt: now,
      userId: opts.userId,
    },
  });
  return { sessionId, maturesAt };
}

/** Stable hash of a client device fingerprint (SHA-256, hex). */
export function hashDeviceFingerprint(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** True when (userId, deviceHash) is a remembered device. Fail-closed false. */
export async function isKnownDevice(db: any, userId: number | string, deviceHash: string): Promise<boolean> {
  const [row] = await db
    .select({ id: authKnownDevices.id })
    .from(authKnownDevices)
    .where(and(eq(authKnownDevices.userId, String(userId)), eq(authKnownDevices.deviceHash, deviceHash)))
    .limit(1)
    .catch(() => []);
  return !!row;
}

/** Remember a device (idempotent upsert; concurrent logins safe). */
export async function rememberDevice(
  db: any,
  opts: { userId: number | string; deviceHash: string; label?: string | null },
): Promise<void> {
  const now = new Date();
  const [existing] = await db
    .select({ id: authKnownDevices.id })
    .from(authKnownDevices)
    .where(and(eq(authKnownDevices.userId, String(opts.userId)), eq(authKnownDevices.deviceHash, opts.deviceHash)))
    .limit(1);
  if (existing) {
    await db.update(authKnownDevices)
      .set({ lastSeenAt: now, ...(opts.label ? { label: opts.label } : {}) })
      .where(eq(authKnownDevices.id, existing.id));
    return;
  }
  await db.insert(authKnownDevices).values({
    userId: String(opts.userId),
    deviceHash: opts.deviceHash,
    label: opts.label ?? null,
    firstSeenAt: now,
    lastSeenAt: now,
  }).catch((e: any) => {
    // Unique-violation race with a concurrent remember → benign.
    if (!/duplicate|unique/i.test(e?.message ?? "")) throw e;
  });
}

/**
 * Issue the INDEPENDENT email second factor for a new-device login. The OTP
 * is a fresh random code, stored under purpose "device_email" keyed by the
 * user's phone, emailed to the user's email address. Returns the challenge
 * sessionId; null when the user has no email (the caller then refuses the
 * new-device login — fail closed).
 */
export async function issueDeviceChallenge(
  db: any,
  opts: { userId: number; phone: string; email: string },
): Promise<string | null> {
  const { generateOtp, hashOtp } = await import("../routers/phoneAuth");
  const { sendOtpEmail } = await import("./email/resend");
  const otp = generateOtp();
  const otpHash = hashOtp(otp);
  const sessionId = randomUUID();
  const now = new Date();
  // W47 crosscutting (ONB-ID-4): atomic upsert on the (phone,purpose) unique
  // backstop instead of delete+insert.
  await db.insert(phoneOtpSessions).values({
    id: sessionId,
    phone: opts.phone,
    otpHash,
    attempts: 0,
    expiresAt: new Date(now.getTime() + DEVICE_CHALLENGE_TTL_MS),
    createdAt: now,
    purpose: DEVICE_OTP_PURPOSE,
    userId: opts.userId,
  }).onConflictDoUpdate({
    target: [phoneOtpSessions.phone, phoneOtpSessions.purpose],
    set: {
      id: sessionId,
      otpHash,
      attempts: 0,
      expiresAt: new Date(now.getTime() + DEVICE_CHALLENGE_TTL_MS),
      createdAt: now,
      userId: opts.userId,
    },
  });
  await sendOtpEmail(opts.email, otp, "login");
  return sessionId;
}

/** Anomaly notification to the account owner (best-effort, never throws). */
export async function notifyOwnerNewDevice(
  db: any,
  opts: { userId: number; deviceHash: string },
): Promise<void> {
  try {
    const [user] = await db.select({ email: users.email, name: users.name })
      .from(users).where(eq(users.id, opts.userId)).limit(1);
    if (!user?.email) return;
    const { sendEmail } = await import("./email/resend");
    await sendEmail({
      to: user.email,
      subject: "New device sign-in to your account",
      html:
        `<p>Hello${user.name ? ` ${user.name}` : ""},</p>` +
        `<p>A sign-in to your account was attempted from a device we don't recognize ` +
        `(device <code>${opts.deviceHash.slice(0, 12)}…</code>). An email verification code is required to ` +
        `complete the sign-in. If this wasn't you, contact support immediately and reset your devices.</p>`,
      text:
        `Hello${user.name ? ` ${user.name}` : ""},\n\n` +
        `A sign-in to your account was attempted from a device we don't recognize ` +
        `(device ${opts.deviceHash.slice(0, 12)}…). An email verification code is required to ` +
        `complete the sign-in. If this wasn't you, contact support immediately and reset your devices.`,
    });
  } catch (e: any) {
    console.warn("[deviceAuth] owner anomaly notify failed:", e?.message);
  }
}

export interface VerifyDeviceChallengeResult {
  ok: boolean;
  reason?: "not_found" | "expired" | "too_many_attempts" | "invalid" | "cooling_off"; // W47 ONB-ID-1
  attemptsRemaining?: number;
  /** Cooling-off challenges: earliest completion time. */
  maturesAt?: Date;
}

/**
 * Verify the email OTP for a device challenge. On success the challenge row
 * is consumed (single-use) and the device is remembered. Per-session attempt
 * cap (3) mirrors the login OTP policy.
 */
export async function verifyDeviceChallenge(
  db: any,
  opts: { sessionId: string; otp: string; deviceHash: string; label?: string | null },
): Promise<VerifyDeviceChallengeResult> {
  const { verifyOtpHash } = await import("../routers/phoneAuth");
  const [session] = await db.select().from(phoneOtpSessions)
    .where(eq(phoneOtpSessions.id, opts.sessionId)).limit(1);
  if (!session || (session.purpose !== DEVICE_OTP_PURPOSE && session.purpose !== DEVICE_COOLOFF_PURPOSE)) {
    return { ok: false, reason: "not_found" };
  }
  const now = new Date();
  // === W47 crosscutting (ONB-ID-1): cooling-off challenge (no-email
  // accounts) — the held login MATURES at expiresAt; before that it refuses.
  // There is no OTP to verify: the otp input is ignored for this purpose. ===
  if (session.purpose === DEVICE_COOLOFF_PURPOSE) {
    if (session.expiresAt > now) {
      return { ok: false, reason: "cooling_off", maturesAt: session.expiresAt };
    }
    await db.delete(phoneOtpSessions).where(eq(phoneOtpSessions.id, session.id));
    if (session.userId != null) {
      await rememberDevice(db, { userId: session.userId, deviceHash: opts.deviceHash, label: opts.label });
    }
    return { ok: true };
  }
  // === END W47 crosscutting ===
  if (session.expiresAt < now) {
    await db.delete(phoneOtpSessions).where(eq(phoneOtpSessions.id, session.id));
    return { ok: false, reason: "expired" };
  }
  if (session.attempts >= 3) {
    await db.delete(phoneOtpSessions).where(eq(phoneOtpSessions.id, session.id));
    return { ok: false, reason: "too_many_attempts" };
  }
  if (!verifyOtpHash(session.otpHash, opts.otp)) {
    await db.update(phoneOtpSessions)
      .set({ attempts: session.attempts + 1 })
      .where(eq(phoneOtpSessions.id, session.id));
    return { ok: false, reason: "invalid", attemptsRemaining: 2 - session.attempts };
  }
  await db.delete(phoneOtpSessions).where(eq(phoneOtpSessions.id, session.id));
  if (session.userId != null) {
    await rememberDevice(db, { userId: session.userId, deviceHash: opts.deviceHash, label: opts.label });
  }
  return { ok: true };
}

/** List a user's remembered devices (self-service surface). */
export async function listKnownDevices(db: any, userId: number | string) {
  return db.select().from(authKnownDevices)
    .where(eq(authKnownDevices.userId, String(userId)));
}

/**
 * Admin recovery: clear ALL remembered devices for a user so the next login
 * (from any device) requires the email second factor again. The caller
 * (routers/phoneAuth.ts) gates this behind a consumed step-up challenge and
 * writes the audit row — this function performs only the reset.
 */
export async function resetKnownDevices(db: any, userId: number | string): Promise<number> {
  const existing = await listKnownDevices(db, userId);
  await db.delete(authKnownDevices).where(eq(authKnownDevices.userId, String(userId)));
  return existing.length;
}
