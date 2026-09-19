// === W47 merchant ===
/**
 * J434 — ONB-M-12 (invite staff by phone; pending phone-bound invite claimed
 * on OTP login) + ONB-M-16 (settings.adminPhone stamped at provisioning).
 */
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J434",
  name: "staff invite-by-phone + adminPhone capture (ONB-M-12/M-16)",
  feature: "W47 merchant: self-service staff onboarding, phone-bound invites",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();

    // ── M-16: phone captured at provisioning stamps settings.adminPhone ──
    const started = await admin.onboarding.start({ name: "J434 Phone Store", phone: "+2348011111434" });
    const tenantId = started.tenantId;
    const [row] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    assert((row.settings as any).adminPhone === "+2348011111434", "settings.adminPhone stamped at start");

    // ── M-12: owner invites staff by phone ───────────────────────────────
    const ownerId = 4340;
    await world.db.insert(schema.users).values({
      id: ownerId, openId: "sim-owner-434", name: "Owner", loginMethod: "keycloak", role: "user", tenantId,
    }).onConflictDoNothing();
    const { addMember } = await import("../../server/services/membership");
    await addMember({ tenantId, userId: ownerId, role: "owner", invitedBy: ownerId });
    const ownerCaller = await tenantCaller(tenantId, { userId: ownerId, memberships: [tenantId] });

    const invite = await ownerCaller.onboardingStaff.inviteStaff({
      tenantId, phone: "+234802222434", role: "operator",
    });
    assert(invite.ok && invite.inviteId, "invite created");

    // Non-owner cannot invite.
    const staffId = 4341;
    await world.db.insert(schema.users).values({
      id: staffId, openId: "sim-staff-434", name: "Staff", loginMethod: "keycloak", role: "user",
    }).onConflictDoNothing();
    await addMember({ tenantId, userId: staffId, role: "operator", invitedBy: ownerId });
    const staffCaller = await tenantCaller(tenantId, { userId: staffId, memberships: [tenantId] });
    await expectTrpcError(
      staffCaller.onboardingStaff.inviteStaff({ tenantId, phone: "+234803333434" }),
      "FORBIDDEN",
      "non-owner invite blocked",
    );

    // No phantom membership yet — membership materializes only on claim.
    let members = await world.db.select().from(schema.tenantMemberships)
      .where(eq(schema.tenantMemberships.tenantId, tenantId));
    assert(!members.some((m: any) => m.userId === 4342), "no phantom membership before claim");

    // Claim on first OTP login (service path used by phoneAuth.verifyOtp).
    const claimUserId = 4342;
    await world.db.insert(schema.users).values({
      id: claimUserId, openId: "sim-claim-434", name: "Invitee", loginMethod: "keycloak", role: "user",
      phone: "+234802222434", phoneVerified: true,
    }).onConflictDoNothing();
    const { claimStaffInvitesForPhone } = await import("../../server/routers/onboardingStaff");
    const first = await claimStaffInvitesForPhone(claimUserId, "+234802222434");
    assert(first.claimed.length === 1 && first.claimed[0].tenantId === tenantId, "invite claimed on login");
    members = await world.db.select().from(schema.tenantMemberships)
      .where(eq(schema.tenantMemberships.tenantId, tenantId));
    const m = members.find((x: any) => String(x.userId) === String(claimUserId));
    assert(m?.role === "operator", "membership created with invited role");
    const second = await claimStaffInvitesForPhone(claimUserId, "+234802222434");
    assert(second.claimed.length === 0, "double-claim is a no-op (guarded flip)");

    // A different phone cannot claim the invite.
    const stranger = await claimStaffInvitesForPhone(4399, "+234809999999");
    assert(stranger.claimed.length === 0, "invite is phone-bound");

    // Revoke blocks a later claim.
    const inv2 = await ownerCaller.onboardingStaff.inviteStaff({ tenantId, phone: "+234804444434" });
    await ownerCaller.onboardingStaff.revokeStaffInvite({ tenantId, inviteId: inv2.inviteId });
    const blocked = await claimStaffInvitesForPhone(4343, "+234804444434");
    assert(blocked.claimed.length === 0, "revoked invite cannot be claimed");

    // Token is never exposed in lists.
    const list = await ownerCaller.onboardingStaff.listStaffInvites({ tenantId });
    assert(list.length >= 2 && list.every((i: any) => !("token" in i)), "list redacts tokens");

    // Audit rows exist for the security-relevant transitions.
    const audit = await world.db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.tenantId, tenantId)));
    assert(audit.some((a: any) => a.action === "onboarding.staff_invite_created"), "invite creation audited");
    assert(audit.some((a: any) => a.action === "onboarding.staff_invite_claimed"), "claim audited");
    assert(audit.some((a: any) => a.action === "onboarding.staff_invite_revoked"), "revocation audited");
  },
};
