// === W47 stakeholders ===
/**
 * J447 — ONB-S-1 (P0): the owner-change guard fires on ANY owner-affecting
 * change, not just owner grants:
 *   - an OPERATOR cannot downgrade an owner (FORBIDDEN);
 *   - an owner downgrade/removal by an owner needs a fresh owner_grant
 *     step-up OTP (PRECONDITION_FAILED without one);
 *   - the SOLE owner can be neither downgraded nor removed;
 *   - the audit row records before.role on the change.
 */
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { expectTrpcError, tenantCaller } from "./helpers";

const TID = "j447-tenant";

async function seedChallenge(world: World, userId: string, otp: string): Promise<string> {
  const schema = await import("../../drizzle/schema");
  const { hashOtp } = await import("../../server/routers/phoneAuth");
  const id = randomUUID();
  await world.db.insert(schema.stepUpChallenges).values({
    id, tenantId: TID, userId, purpose: "owner_grant",
    otpHash: hashOtp(otp), phone: "+2348000000447", attempts: 0,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  return id;
}

export const journey: Journey = {
  id: "J447",
  name: "owner downgrade/removal guarded by owner+step-up; sole owner protected",
  feature: "W47 stakeholders: ONB-S-1 tenant-takeover guard",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    await world.db.insert(schema.tenants).values({
      id: TID, name: "J447 Guard", slug: TID, status: "active",
    }).onConflictDoNothing();
    // Real user rows (ONB-S-2 existence check) for every member id.
    for (const uid of [4471, 4472, 4473]) {
      await world.db.insert(schema.users).values({
        id: uid, openId: `j447-u${uid}`, name: `J447 U${uid}`, loginMethod: "keycloak",
        role: "user", lastSignedIn: new Date(),
      }).onConflictDoNothing();
    }
    await world.db.insert(schema.tenantMemberships).values([
      { tenantId: TID, userId: "4471", role: "owner" },
      { tenantId: TID, userId: "4473", role: "operator" },
    ]).onConflictDoNothing();
    const owner = await tenantCaller(TID, { userId: 4471 });
    const operator = await tenantCaller(TID, { userId: 4473 });

    // ── 1. Operator CANNOT downgrade the owner (the W46 hole) ───────────
    await expectTrpcError(
      operator.membership.add({ tenantId: TID, userId: 4471, role: "analyst" }),
      "FORBIDDEN",
      "operator downgrade of an owner is refused",
    );
    let [m] = await world.db.select().from(schema.tenantMemberships)
      .where(and(eq(schema.tenantMemberships.tenantId, TID), eq(schema.tenantMemberships.userId, "4471")));
    assert(m.role === "owner", "owner role untouched after operator attempt");

    // ── 2. Sole-owner downgrade is refused even for an owner+step-up ────
    const soleChallenge = await seedChallenge(world, "4471", "111111");
    await expectTrpcError(
      owner.membership.add({ tenantId: TID, userId: 4471, role: "operator", stepUpChallengeId: soleChallenge, stepUpOtp: "111111" }),
      "FORBIDDEN",
      "sole-owner downgrade refused",
    );

    // ── 3. Grant a second owner (owner grant needs step-up — W30 path) ──
    const grant = await seedChallenge(world, "4471", "222222");
    await owner.membership.add({ tenantId: TID, userId: 4472, role: "owner", stepUpChallengeId: grant, stepUpOtp: "222222" });

    // ── 4. Owner downgrade of the OTHER owner requires step-up ──────────
    await expectTrpcError(
      owner.membership.add({ tenantId: TID, userId: 4472, role: "analyst" }),
      "PRECONDITION_FAILED",
      "owner downgrade without step-up refused",
    );
    const dg = await seedChallenge(world, "4471", "333333");
    await owner.membership.add({ tenantId: TID, userId: 4472, role: "analyst", stepUpChallengeId: dg, stepUpOtp: "333333" });
    [m] = await world.db.select().from(schema.tenantMemberships)
      .where(and(eq(schema.tenantMemberships.tenantId, TID), eq(schema.tenantMemberships.userId, "4472")));
    assert(m.role === "analyst", "owner downgraded to analyst with step-up");
    const audit = await world.db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.action, "membership.add"), eq(schema.auditLogs.tenantId, TID)));
    const dgRow = audit.find((r: any) => (r.after as any)?.userId === "4472" && (r.before as any)?.role === "owner");
    assert(dgRow, "audit row records before.role=owner on the downgrade");

    // ── 5. Owner REMOVAL: operator refused; owner needs step-up ─────────
    // Re-grant 4472 owner first (two owners again).
    const grant2 = await seedChallenge(world, "4471", "444444");
    await owner.membership.add({ tenantId: TID, userId: 4472, role: "owner", stepUpChallengeId: grant2, stepUpOtp: "444444" });
    await expectTrpcError(
      operator.membership.remove({ tenantId: TID, userId: 4472 }),
      "FORBIDDEN",
      "operator cannot remove an owner",
    );
    await expectTrpcError(
      owner.membership.remove({ tenantId: TID, userId: 4472 }),
      "PRECONDITION_FAILED",
      "owner removal without step-up refused",
    );
    const rm = await seedChallenge(world, "4471", "555555");
    const removed = await owner.membership.remove({ tenantId: TID, userId: 4472, stepUpChallengeId: rm, stepUpOtp: "555555" });
    assert(removed.removed === true, "owner removed with step-up when another owner remains");

    // ── 6. Sole-owner removal still blocked (even with step-up) ─────────
    const rm2 = await seedChallenge(world, "4471", "666666");
    const err = await expectTrpcError(
      owner.membership.remove({ tenantId: TID, userId: 4471, stepUpChallengeId: rm2, stepUpOtp: "666666" }),
      "FORBIDDEN",
      "sole-owner removal refused",
    );
    assert(String(err.message).includes("last owner"), "refusal names the last-owner guard");
  },
};
