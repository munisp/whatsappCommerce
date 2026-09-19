// === W47 crosscutting ===
/**
 * J459 — ONB-ABU-1: unauthenticated intake-number abuse caps.
 *
 *   - per-phone NEW session cap (ONB_INTAKE_MAX_SESSIONS_PER_DAY) — a flood
 *     of restarts/first-contacts from one number stops minting sessions;
 *   - per-phone message cap path exists and trips (service-level, low cap);
 *   - per-phone TENANT-creation cap (ONB_INTAKE_MAX_TENANTS_PER_DAY) trips in
 *     ensureTenant (fake-merchant factory throttle);
 *   - counters fail-closed in production (source contract in intakeThrottle).
 */
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { onboardingSessionByPhone } from "./helpers";

export const journey: Journey = {
  id: "J459",
  name: "intake number per-phone abuse caps",
  feature: "ONB-ABU-1 intake metering + quota + tenant throttle",
  async run(world: World) {
    const throttle = await import("../../server/services/intakeThrottle");

    // ── Service-level: all three caps trip at their configured limits ──────
    process.env.ONB_INTAKE_MAX_SESSIONS_PER_DAY = "2";
    process.env.ONB_INTAKE_MAX_TENANTS_PER_DAY = "1";
    process.env.ONB_INTAKE_MAX_MSGS_PER_HOUR = "3";
    const phoneA = world.newPhone("abu459");
    try {
      assert(await throttle.bumpIntakeCounter("tenant", phoneA) === true, "first tenant under cap");
      assert(await throttle.bumpIntakeCounter("tenant", phoneA) === false, "second tenant tripped the daily cap");
      assert(await throttle.bumpIntakeCounter("msg", phoneA) === true, "msg 1 ok");
      assert(await throttle.bumpIntakeCounter("msg", phoneA) === true, "msg 2 ok");
      assert(await throttle.bumpIntakeCounter("msg", phoneA) === true, "msg 3 ok");
      assert(await throttle.bumpIntakeCounter("msg", phoneA) === false, "msg 4 over hourly cap");
      // A DIFFERENT phone is unaffected (per-phone metering).
      assert(await throttle.bumpIntakeCounter("tenant", world.newPhone("abu459b")) === true, "caps are per-phone");
    } finally {
      delete process.env.ONB_INTAKE_MAX_SESSIONS_PER_DAY;
      delete process.env.ONB_INTAKE_MAX_TENANTS_PER_DAY;
      delete process.env.ONB_INTAKE_MAX_MSGS_PER_HOUR;
    }

    // ── Wire-level: restart flood stops minting sessions ──────────────────
    process.env.ONB_INTAKE_MAX_SESSIONS_PER_DAY = "1";
    process.env.ONB_INTAKE_MAX_MSGS_PER_HOUR = "1000";
    const phone = world.newPhone("onb459");
    try {
      await world.onboardingText(phone, "hello", { profileName: "Flood" });
      const s1 = await onboardingSessionByPhone(phone);
      assert(s1, "first contact mints a session (under cap)");
      // "restart" = abandon + fresh session — now over the daily cap of 1.
      await world.onboardingText(phone, "restart");
      const throttled = bodyText(world.outbound.lastOfType("text", phone));
      assertIncludes(throttled, "wait a little", "localized throttle reply delivered");
      const s2 = await onboardingSessionByPhone(phone);
      // No NEW active session was minted; the old one is untouched (still
      // active — the throttle fires BEFORE any supersede/create work).
      assert(s2?.id === s1?.id, "no new session minted over the cap");
      assert(s2?.state !== "abandoned", "existing session not churned by throttled restart");
    } finally {
      delete process.env.ONB_INTAKE_MAX_SESSIONS_PER_DAY;
      delete process.env.ONB_INTAKE_MAX_MSGS_PER_HOUR;
    }

    // ── Fail-closed contract in production ────────────────────────────────
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../server/services/intakeThrottle.ts", import.meta.url), "utf8");
    assertIncludes(src, "fail closed", "production fail-closed when the counter store is down");
    assertIncludes(src, "ONB_INTAKE_MAX_TENANTS_PER_DAY", "env-tunable tenant cap documented");
  },
};
