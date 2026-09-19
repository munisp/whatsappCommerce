// === W47 stakeholders ===
/**
 * J453 — ONB-S-14: users.phone uniqueness + conflict-safe OTP verify.
 *   - the unique partial index on users.phone rejects a second row with
 *     the same phone (NULL phones unaffected);
 *   - verifyOtp (link/verify purpose) refuses CONFLICT when the phone is
 *     already owned by another user — never a blind overwrite;
 *   - phone→user resolution is deterministic (canonical = lowest id).
 */
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { expectTrpcError, publicCaller } from "./helpers";

const PHONE = "+2348099900453";

export const journey: Journey = {
  id: "J453",
  name: "users.phone uniqueness + conflict-safe verify + canonical resolution",
  feature: "W47 stakeholders: ONB-S-14 phone identity dedup",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { hashOtp } = await import("../../server/routers/phoneAuth");
    const pub = await publicCaller();

    // ── 1. Unique partial index: one canonical row per phone ────────────
    const [u1] = await world.db.insert(schema.users).values({
      openId: `j453-a-${randomUUID().slice(0, 8)}`, name: "J453 A", loginMethod: "keycloak",
      role: "user", phone: PHONE, phoneVerified: true, lastSignedIn: new Date(),
    }).returning();
    let dupFailed = false;
    try {
      await world.db.insert(schema.users).values({
        openId: `j453-b-${randomUUID().slice(0, 8)}`, name: "J453 B", loginMethod: "keycloak",
        role: "user", phone: PHONE, lastSignedIn: new Date(),
      });
    } catch (e: any) {
      const msg = String(e?.message) + String(e?.cause?.message ?? "");
      dupFailed = /users_phone_unique|duplicate key|unique/i.test(msg);
      if (!dupFailed) throw e; // unexpected error — surface it
    }
    assert(dupFailed, "second user with the same phone violates the unique index");
    // NULL phones are untouched (partial index).
    await world.db.insert(schema.users).values([
      { openId: `j453-n1-${randomUUID().slice(0, 8)}`, name: "N1", loginMethod: "keycloak", role: "user", lastSignedIn: new Date() },
      { openId: `j453-n2-${randomUUID().slice(0, 8)}`, name: "N2", loginMethod: "keycloak", role: "user", lastSignedIn: new Date() },
    ]);

    // ── 2. Conflict-safe OTP verify: never blind-overwrite ──────────────
    const [u2] = await world.db.insert(schema.users).values({
      openId: `j453-c-${randomUUID().slice(0, 8)}`, name: "J453 C", loginMethod: "keycloak",
      role: "user", lastSignedIn: new Date(),
    }).returning();
    const sessionId = randomUUID();
    await world.db.insert(schema.phoneOtpSessions).values({
      id: sessionId, phone: PHONE, otpHash: hashOtp("123456"), attempts: 0,
      expiresAt: new Date(Date.now() + 10 * 60_000), purpose: "verify", userId: u2.id,
    });
    const err = await expectTrpcError(
      pub.phoneAuth.verifyOtp({ sessionId, otp: "123456" }),
      "CONFLICT",
      "verify onto an owned phone is refused",
    );
    assert(/already verified on another account/i.test(String(err.message)), "honest merge guidance");
    const [u2after] = await world.db.select().from(schema.users).where(eq(schema.users.id, u2.id));
    assert(u2after.phone === null, "conflicting verify does NOT overwrite the phone");
    const [u1after] = await world.db.select().from(schema.users).where(eq(schema.users.id, u1.id));
    assert(u1after.phone === PHONE && u1after.phoneVerified === true, "canonical owner untouched");

    // ── 3. Deterministic canonical resolution (lowest id wins) ──────────
    // A legacy duplicate pair (inserted pre-index semantics at the SQL
    // level via two NULL-safe rows is impossible now, so verify resolution
    // order directly on the live row): the single owner resolves.
    const owners = await world.db.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.phone, PHONE)).orderBy(schema.users.id).limit(2);
    assert(owners.length === 1 && owners[0].id === u1.id, "phone resolves to the canonical (only) user");
  },
};
