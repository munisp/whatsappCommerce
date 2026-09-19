// === W47 stakeholders ===
/**
 * J448 — ONB-S-2: staff invite→accept flow.
 *   - membership.add REJECTS a nonexistent userId (no phantom rows);
 *   - membership.invite binds a pending invite to the invitee's phone;
 *   - acceptInvite requires a phone_identity proof for the BOUND phone and
 *     creates the membership only on acceptance (creating a phone-bound
 *     canonical user when none exists);
 *   - replayed/revoked invites cannot mint memberships;
 *   - invite revocation endpoint works (claim-first, audited).
 */
import jwt from "jsonwebtoken";
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { expectTrpcError, publicCaller, tenantCaller } from "./helpers";
// W47 MERGER: ENV must be imported LAZILY inside run() — a static import
// evaluates server/_core/env BEFORE the sim world's setEnv boot, freezing
// LLM_BASE_URL/PAYSTACK keys at their pre-boot defaults and breaking every
// payment/LLM journey in the shared module graph.

const TID = "j448-tenant";
const INVITEE = "+2348099900448";

export const journey: Journey = {
  id: "J448",
  name: "staff invite→accept; phantom adds rejected; invite revocation",
  feature: "W47 stakeholders: ONB-S-2/S-5 staff invite rail",
  async run(world: World) {
    const { ENV } = await import("../../server/_core/env");
    const schema = await import("../../drizzle/schema");
    await world.db.insert(schema.tenants).values({
      id: TID, name: "J448 Invites", slug: TID, status: "active",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: TID, userId: "4481", role: "owner",
    }).onConflictDoNothing();
    const owner = await tenantCaller(TID, { userId: 4481 });
    const pub = await publicCaller();
    const proofFor = (phone: string) =>
      jwt.sign({ type: "phone_identity", phone }, ENV.jwtSecret, { expiresIn: "15m" });

    // ── 1. Phantom add rejected ─────────────────────────────────────────
    const err = await expectTrpcError(
      owner.membership.add({ tenantId: TID, userId: 999448, role: "analyst" }),
      "BAD_REQUEST",
      "add of a nonexistent user rejected",
    );
    assert(String(err.message).includes("invite"), "error points at the invite flow");
    const phantom = await world.db.select().from(schema.tenantMemberships)
      .where(and(eq(schema.tenantMemberships.tenantId, TID), eq(schema.tenantMemberships.userId, "999448")));
    assert(phantom.length === 0, "no phantom membership row created");

    // ── 2. Invite → accept with a proof for the BOUND phone ─────────────
    const inv = await owner.membership.invite({ tenantId: TID, phone: INVITEE, role: "operator" });
    assert(inv.token && inv.role === "operator", "invite minted");

    await expectTrpcError(
      pub.membership.acceptInvite({ token: inv.token, identityProof: proofFor("+2348000000000") }),
      "FORBIDDEN",
      "wrong-phone proof refused",
    );
    let [row] = await world.db.select().from(schema.staffInvites).where(eq(schema.staffInvites.id, inv.inviteId));
    assert(row.status === "pending", "failed proof does not consume the invite");

    const accepted = await pub.membership.acceptInvite({ token: inv.token, identityProof: proofFor(INVITEE) });
    assert(accepted.accepted === true && accepted.role === "operator", "invite accepted");
    const member = await world.db.select().from(schema.tenantMemberships)
      .where(and(eq(schema.tenantMemberships.tenantId, TID), eq(schema.tenantMemberships.userId, accepted.userId)));
    assert(member.length === 1 && member[0].role === "operator", "membership created ON ACCEPTANCE");
    const [invUser] = await world.db.select().from(schema.users).where(eq(schema.users.id, Number(accepted.userId)));
    assert(invUser?.phone && invUser.phoneVerified === true, "canonical phone-bound user created+verified");

    // Replay → CONFLICT (single-use).
    await expectTrpcError(
      pub.membership.acceptInvite({ token: inv.token, identityProof: proofFor(INVITEE) }),
      "CONFLICT",
      "invite replay refused",
    );

    // ── 3. Revocation kills a pending invite ────────────────────────────
    const inv2 = await owner.membership.invite({ tenantId: TID, phone: "+2348099900449", role: "catalog" });
    const revoked = await owner.membership.revokeInvite({ tenantId: TID, inviteId: inv2.inviteId });
    assert(revoked.revoked === true, "invite revoked");
    await expectTrpcError(
      pub.membership.acceptInvite({ token: inv2.token, identityProof: proofFor("+2348099900449") }),
      "CONFLICT",
      "revoked invite cannot be accepted",
    );
    const list = await owner.membership.listInvites({ tenantId: TID });
    assert(list.some((i: any) => i.id === inv2.inviteId && i.status === "revoked"), "listInvites shows the revocation");
    const audit = await world.db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.action, "membership.inviteAccepted"), eq(schema.auditLogs.tenantId, TID)));
    assert(audit.length === 1, "invite acceptance audited");
  },
};
