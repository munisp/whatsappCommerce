/**
 * J54 — Invite-mint attack. A non-admin tenant user (even scoped to their
 * own tenant) cannot mint tenantInvite magic links → FORBIDDEN; the platform
 * admin can. The minted magic link validates into a portal session scoped to
 * the INVITED tenant only — decoding proves the tenant scope and a tampered
 * token (forged tenantId, wrong key) is rejected by validate.
 *
 * (tenantInvite.create validates tenantId as uuid, so this journey uses two
 * freshly provisioned uuid tenants rather than the seeded string ids.)
 */
import jwt from "jsonwebtoken";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { JWT_SECRET_VALUE } from "../world";
import { adminCaller, expectTrpcError, publicCaller, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J54",
  name: "invite-mint attack",
  feature: "tenantInvite admin gate + magic-link scope",
  async run(world) {
    const admin = await adminCaller();
    const tenantA = (await admin.onboarding.start({ name: "Invite Store A" })).tenantId;
    const tenantB = (await admin.onboarding.start({ name: "Invite Store B" })).tenantId;

    // ── Non-admin mint attempts: own tenant AND cross-tenant → 403 ────────
    const tenantAUser = await tenantCaller(tenantA);
    await expectTrpcError(
      tenantAUser.tenantInvite.create({ tenantId: tenantA }),
      "FORBIDDEN",
      "non-admin mint for own tenant",
    );
    await expectTrpcError(
      tenantAUser.tenantInvite.create({ tenantId: tenantB }),
      "FORBIDDEN",
      "non-admin mint cross-tenant",
    );
    await expectTrpcError(
      tenantAUser.tenantInvite.resend({ tenantId: tenantA }),
      "FORBIDDEN",
      "non-admin resend",
    );

    // ── Platform admin mints for tenant B ─────────────────────────────────
    // W30 merge: invite TTL is capped at 24h (V2#8 invite single-use+24h).
    const inviteB = await admin.tenantInvite.create({ tenantId: tenantB, expiryHours: 24 });
    assert(inviteB.token && inviteB.tenantId === tenantB, "admin minted tenant-B invite");
    assert(inviteB.portalUrl.includes(inviteB.token), "portal URL carries the token");
    const invitePayload = jwt.verify(inviteB.token, JWT_SECRET_VALUE) as any;
    assert(invitePayload.type === "portal_invite", "invite token type is portal_invite");
    assert(invitePayload.tenantId === tenantB, "invite scoped to tenant B");
    assert(invitePayload.exp - invitePayload.iat === 24 * 3600, "invite TTL = 24h (W30 cap)");

    // ── Magic link validates into a session for the invited tenant ONLY ────
    const pub = await publicCaller();
    const session = await pub.tenantInvite.validate({ token: inviteB.token });
    assert(session.valid === true, "magic link validates");
    const sessionPayload = jwt.verify(session.sessionToken!, JWT_SECRET_VALUE) as any;
    assert(sessionPayload.type === "portal_session", "session token type is portal_session");
    assert(sessionPayload.tenantId === tenantB, "session scoped to the INVITED tenant (B)");
    assert(sessionPayload.tenantId !== tenantA, "session is NOT usable for tenant A");
    assert(sessionPayload.exp - sessionPayload.iat === 8 * 3600, "portal session TTL = 8h");

    // An invite for tenant A yields an A-scoped session — never B.
    const inviteA = await admin.tenantInvite.create({ tenantId: tenantA, expiryHours: 24 });
    const sessionA = await pub.tenantInvite.validate({ token: inviteA.token });
    assert(sessionA.valid === true, "tenant-A invite validates");
    const payloadA = jwt.verify(sessionA.sessionToken!, JWT_SECRET_VALUE) as any;
    assert(payloadA.tenantId === tenantA, "tenant-A session scoped to A");
    assert(payloadA.tenantId !== tenantB, "tenant-A session NOT usable for tenant B");

    // ── Tampered invite: attacker forges a tenant-A session from B's link ──
    const forged = jwt.sign(
      { type: "portal_invite", tenantId: tenantA, tenantName: "Invite Store A", issuedBy: 999 },
      "wrong-secret",
      { expiresIn: "72h" },
    );
    const forgedResult = await pub.tenantInvite.validate({ token: forged });
    assert(forgedResult.valid === false, "forged invite (wrong signing key) rejected");

    // A valid invite whose type claim is flipped is rejected too.
    const typeFlipped = jwt.sign(
      { type: "portal_session", tenantId: tenantA },
      JWT_SECRET_VALUE,
      { expiresIn: "72h" },
    );
    const flippedResult = await pub.tenantInvite.validate({ token: typeFlipped });
    assert(flippedResult.valid === false, "non-invite token type rejected by validate");
  },
};
