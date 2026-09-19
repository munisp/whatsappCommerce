// === W47 crosscutting ===
/**
 * J458 — ONB-ID-1: mandatory login second-factor policy.
 *
 * DEVICE_FACTOR_POLICY=required (DEFAULT, fail-closed):
 *   1. login verify for a KNOWN account WITHOUT deviceHash → PRECONDITION_FAILED;
 *   2. unknown device on a NO-EMAIL account → cooling-off hold
 *      (verified:false, deviceFactor:"cooloff"), verifyDeviceChallenge refuses
 *      until the window matures (DEVICE_COOLOFF_MINUTES=0 in sim → immediate),
 *      then remembers the device;
 *   3. legacy flag restores the pre-W47 opt-in bypass;
 *   4. email accounts keep the W46 independent email factor.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { publicCaller } from "./helpers";

export const journey: Journey = {
  id: "J458",
  name: "device second-factor fail-closed policy + cooling-off",
  feature: "ONB-ID-1 DEVICE_FACTOR_POLICY",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const deviceAuth = await import("../../server/services/deviceAuth");
    const phoneAuth = await import("../../server/routers/phoneAuth");
    const caller = await publicCaller();

    const mkLoginSession = async (phone: string, otp: string) => {
      const sessionId = crypto.randomUUID();
      await world.db.insert(schema.phoneOtpSessions).values({
        id: sessionId, phone, otpHash: phoneAuth.hashOtp(otp), attempts: 0,
        expiresAt: new Date(Date.now() + 10 * 60_000), purpose: "login",
      });
      return sessionId;
    };

    // Policy reader defaults to required.
    assert(deviceAuth.deviceFactorPolicy({} as any) === "required", "default policy is required (fail-closed)");
    assert(deviceAuth.deviceFactorPolicy({ DEVICE_FACTOR_POLICY: "legacy" } as any) === "legacy", "legacy opt-in honored");

    // ── 1. No deviceHash on a known account → refused ─────────────────────
    const phone1 = "+2348017000458";
    await world.db.insert(schema.users).values({
      openId: "sim-j458-a", name: "J458 A", email: "j458@sim.local", phone: phone1, phoneVerified: true,
    });
    const s1 = await mkLoginSession(phone1, "111111");
    let refused: any = null;
    try {
      await caller.phoneAuth.verifyOtp({ sessionId: s1, otp: "111111" });
    } catch (e: any) {
      refused = e;
    }
    assert(refused, "login without deviceHash refused");
    assert(refused.code === "PRECONDITION_FAILED", `PRECONDITION_FAILED (got ${refused.code})`);

    // ── 2. No-email account + unknown device → cooling-off hold ──────────
    process.env.DEVICE_COOLOFF_MINUTES = "0"; // sim: window matures immediately
    try {
      const phone2 = "+2348017000459";
      const [u2] = await world.db.insert(schema.users).values({
        openId: "sim-j458-b", name: "J458 B", phone: phone2, phoneVerified: true,
      }).returning({ id: schema.users.id });
      const deviceHash = deviceAuth.hashDeviceFingerprint("j458-new-phone");
      const s2 = await mkLoginSession(phone2, "222222");
      const held = await caller.phoneAuth.verifyOtp({ sessionId: s2, otp: "222222", deviceHash });
      assert(held.verified === false, "no-email unknown-device login held");
      assert((held as any).deviceFactorRequired === true, "deviceFactorRequired");
      assert((held as any).deviceFactor === "cooloff", `cooloff factor (got ${(held as any).deviceFactor})`);
      const coolId = (held as any).deviceSessionId;
      const [challenge] = await world.db.select().from(schema.phoneOtpSessions)
        .where(eq(schema.phoneOtpSessions.id, coolId));
      assert(challenge?.purpose === "device_cooloff", "cooling-off challenge row issued");
      assert(!(await deviceAuth.isKnownDevice(world.db, u2.id, deviceHash)), "device not remembered during hold");

      // Still cooling → refuse; matured → completes + remembers the device.
      // (DEVICE_COOLOFF_MINUTES=0 → already matured.)
      const done = await deviceAuth.verifyDeviceChallenge(world.db, { sessionId: coolId, otp: "", deviceHash });
      assert(done.ok === true, "matured cooling-off challenge completes the login");
      assert(await deviceAuth.isKnownDevice(world.db, u2.id, deviceHash), "device remembered after cooling-off");

      // Not-yet-matured challenge reports cooling_off honestly.
      const { sessionId: cool2 } = await deviceAuth.issueCooloffChallenge(world.db, { userId: u2.id, phone: phone2 });
      await world.db.update(schema.phoneOtpSessions)
        .set({ expiresAt: new Date(Date.now() + 60_000) })
        .where(eq(schema.phoneOtpSessions.id, cool2));
      const early = await deviceAuth.verifyDeviceChallenge(world.db, { sessionId: cool2, otp: "", deviceHash });
      assert(early.ok === false && early.reason === "cooling_off", "immature hold refuses with cooling_off");
    } finally {
      delete process.env.DEVICE_COOLOFF_MINUTES;
    }

    // ── 3. Legacy flag restores the pre-W47 bypass ────────────────────────
    process.env.DEVICE_FACTOR_POLICY = "legacy";
    try {
      const s3 = await mkLoginSession(phone1, "333333");
      const legacy = await caller.phoneAuth.verifyOtp({ sessionId: s3, otp: "333333" });
      assert(legacy.verified === true, "legacy policy: login without deviceHash passes");
    } finally {
      delete process.env.DEVICE_FACTOR_POLICY;
    }

    // ── 4. Email account + unknown device still gets the email factor ─────
    const deviceHash4 = deviceAuth.hashDeviceFingerprint("j458-laptop");
    const s4 = await mkLoginSession(phone1, "444444");
    const heldEmail = await caller.phoneAuth.verifyOtp({ sessionId: s4, otp: "444444", deviceHash: deviceHash4 });
    assert((heldEmail as any).deviceFactor === "email", `email account keeps email factor (got ${(heldEmail as any).deviceFactor})`);
  },
};
