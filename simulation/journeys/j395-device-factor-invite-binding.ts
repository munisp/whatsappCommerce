// === W46 privacy-consent (Coder B) ===
/**
 * J395 — TEN-20 new-device second factor + TEN-19 invite identity binding:
 *   TEN-20:
 *   - A login OTP verify from an UNKNOWN device on an account with an email
 *     is HELD: verified:false + deviceFactorRequired; an INDEPENDENT email
 *     challenge (purpose device_email — separate session row, separate code)
 *     is issued and the device is NOT remembered yet.
 *   - verifyDeviceFactor with the email OTP remembers the device; a second
 *     login from the same device passes without a new factor.
 *   - resetKnownDevices clears remembered devices (admin recovery
 *     primitive); the tRPC adminResetDevices endpoint is step-up gated +
 *     audited (source contract).
 *   TEN-19:
 *   - A phone-bound invite REJECTS redemption without/with a wrong-phone
 *     identity proof (and the single-use token is NOT burned by the failed
 *     attempt), and redeems with the matching verified-phone proof.
 */
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { publicCaller } from "./helpers";

export const journey: Journey = {
  id: "J395",
  name: "new-device email factor + bound invite redemption",
  feature: "TEN-20 device 2FA + TEN-19 invite binding",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const deviceAuth = await import("../../server/services/deviceAuth");
    const phoneAuth = await import("../../server/routers/phoneAuth");
    const { ENV } = await import("../../server/_core/env");

    // ── TEN-20: unknown-device login held for the independent email OTP ──
    const phone = "+2348017000395";
    const [user] = await world.db.insert(schema.users).values({
      openId: "sim-j395-user",
      name: "J395 User",
      email: "j395@sim.local",
      phone,
      phoneVerified: true,
    }).returning({ id: schema.users.id });

    const deviceHash = deviceAuth.hashDeviceFingerprint("j395-laptop");
    assert(!(await deviceAuth.isKnownDevice(world.db, user.id, deviceHash)), "fresh device unknown");

    // Real login OTP session → verify with deviceHash → HELD.
    const otp = "424242";
    const loginSessionId = crypto.randomUUID();
    await world.db.insert(schema.phoneOtpSessions).values({
      id: loginSessionId,
      phone,
      otpHash: phoneAuth.hashOtp(otp),
      attempts: 0,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      purpose: "login",
    });
    const caller = await publicCaller();
    const held = await caller.phoneAuth.verifyOtp({ sessionId: loginSessionId, otp, deviceHash });
    assert(held.verified === false && (held as any).deviceFactorRequired === true, "unknown-device login HELD");
    const deviceSessionId = (held as any).deviceSessionId;
    assert(typeof deviceSessionId === "string", "device challenge issued");
    const [challenge] = await world.db.select().from(schema.phoneOtpSessions)
      .where(eq(schema.phoneOtpSessions.id, deviceSessionId));
    assert(challenge?.purpose === "device_email", "independent email-factor challenge (separate purpose)");
    assert(!(await deviceAuth.isKnownDevice(world.db, user.id, deviceHash)), "device NOT remembered before factor passes");

    // Wrong email OTP → invalid; correct one → device remembered.
    const wrong = await deviceAuth.verifyDeviceChallenge(world.db, { sessionId: deviceSessionId, otp: "000000", deviceHash });
    assert(wrong.ok === false && wrong.reason === "invalid", "wrong email OTP rejected");
    await world.db.update(schema.phoneOtpSessions)
      .set({ otpHash: phoneAuth.hashOtp("555555") })
      .where(eq(schema.phoneOtpSessions.id, deviceSessionId));
    const okFactor = await deviceAuth.verifyDeviceChallenge(world.db, { sessionId: deviceSessionId, otp: "555555", deviceHash });
    assert(okFactor.ok === true, "email OTP completes the device factor");
    assert(await deviceAuth.isKnownDevice(world.db, user.id, deviceHash), "device remembered after factor");

    // Second login from the SAME (now known) device → straight through.
    const loginSession2 = crypto.randomUUID();
    await world.db.insert(schema.phoneOtpSessions).values({
      id: loginSession2,
      phone,
      otpHash: phoneAuth.hashOtp(otp),
      attempts: 0,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      purpose: "login",
    });
    const second = await caller.phoneAuth.verifyOtp({ sessionId: loginSession2, otp, deviceHash });
    assert(second.verified === true && !(second as any).deviceFactorRequired, "known device needs no second factor");

    // Admin recovery primitive: reset clears all known devices.
    const cleared = await deviceAuth.resetKnownDevices(world.db, user.id);
    assert(cleared === 1 && !(await deviceAuth.isKnownDevice(world.db, user.id, deviceHash)), "admin reset clears devices");

    // Admin recovery endpoint is step-up gated + audited (source contract).
    const { readFile } = await import("node:fs/promises");
    const phoneAuthSrc = await readFile(new URL("../../server/routers/phoneAuth.ts", import.meta.url), "utf8");
    assert(phoneAuthSrc.includes('purpose: "account_recovery"'), "admin recovery consumes an account_recovery step-up");
    assert(phoneAuthSrc.includes("phoneAuth.adminResetDevices"), "admin recovery writes an audit row");

    // ── TEN-19: bound invite redemption ──────────────────────────────────
    const boundPhone = "+2348099900000";
    const jti = crypto.randomUUID();
    await world.db.insert(schema.tenantInviteTokens).values({
      jti,
      tenantId: TENANT_ID,
      issuedBy: "sim-admin",
      expiresAt: new Date(Date.now() + 3600_000),
      boundPhone,
    });
    const inviteToken = jwt.sign(
      { type: "portal_invite", jti, tenantId: TENANT_ID, tenantName: "Sim Store", boundPhone },
      ENV.jwtSecret,
      { expiresIn: "1h" },
    );

    // No proof → refused, token NOT consumed.
    const noProof = await caller.tenantInvite.validate({ token: inviteToken });
    assert(noProof.valid === false, "bound invite refuses redemption without identity proof");
    let [tok] = await world.db.select().from(schema.tenantInviteTokens).where(eq(schema.tenantInviteTokens.jti, jti));
    assert(!tok.consumedAt, "failed proof does not burn the single-use link");

    // Wrong-phone proof → refused, still not consumed.
    const wrongProof = jwt.sign({ type: "phone_identity", phone: "+2348000000001" }, ENV.jwtSecret, { expiresIn: "15m" });
    const wrongPhone = await caller.tenantInvite.validate({ token: inviteToken, identityProof: wrongProof });
    assert(wrongPhone.valid === false, "wrong-phone proof refused");
    [tok] = await world.db.select().from(schema.tenantInviteTokens).where(eq(schema.tenantInviteTokens.jti, jti));
    assert(!tok.consumedAt, "wrong-phone proof does not burn the link");

    // Matching verified-phone proof → redeems (single-use consume now fires).
    const goodProof = jwt.sign({ type: "phone_identity", phone: boundPhone }, ENV.jwtSecret, { expiresIn: "15m" });
    const redeemed = await caller.tenantInvite.validate({ token: inviteToken, identityProof: goodProof });
    assert(redeemed.valid === true && !!(redeemed as any).sessionToken, "verified bound phone redeems the invite");
    [tok] = await world.db.select().from(schema.tenantInviteTokens).where(eq(schema.tenantInviteTokens.jti, jti));
    assert(!!tok?.consumedAt, "redemption consumed the single-use token");
  },
};
