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
 * identifiers). Logins without a deviceHash keep the legacy behavior
 * (documented gap: old clients).
 */
import { and, eq } from "drizzle-orm";
import { createHash, randomUUID } from "crypto";
import { authKnownDevices, phoneOtpSessions, users } from "../../drizzle/schema";

export const DEVICE_OTP_PURPOSE = "device_email";
const DEVICE_CHALLENGE_TTL_MS = 10 * 60 * 1000;

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
  const sessionId = randomUUID();
  const now = new Date();
  await db.delete(phoneOtpSessions)
    .where(and(eq(phoneOtpSessions.phone, opts.phone), eq(phoneOtpSessions.purpose, DEVICE_OTP_PURPOSE)));
  await db.insert(phoneOtpSessions).values({
    id: sessionId,
    phone: opts.phone,
    otpHash: hashOtp(otp),
    attempts: 0,
    expiresAt: new Date(now.getTime() + DEVICE_CHALLENGE_TTL_MS),
    createdAt: now,
    purpose: DEVICE_OTP_PURPOSE,
    userId: opts.userId,
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
  reason?: "not_found" | "expired" | "too_many_attempts" | "invalid";
  attemptsRemaining?: number;
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
  if (!session || session.purpose !== DEVICE_OTP_PURPOSE) return { ok: false, reason: "not_found" };
  const now = new Date();
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
