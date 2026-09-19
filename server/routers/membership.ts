/**
 * W12 tenancy — tenant membership (staff) router.
 *
 * Staff onboarding (W47 ONB-S-2): the primary path is invite→accept —
 * `invite` binds a pending invite to the invitee's PHONE, `acceptInvite`
 * redeems it with a phone_identity proof (phoneAuth OTP) and creates the
 * membership row on acceptance. `add` remains as the direct admin path but
 * now REJECTS nonexistent userIds (no phantom membership rows) and routes
 * every role change on an existing row through the owner+step-up gate.
 *
 * W47 ONB-S-1 (P0): the owner+step-up guard fires on ANY owner-affecting
 * change — granting owner, downgrading an owner, removing an owner — not
 * just owner grants. The sole owner can be neither downgraded nor removed.
 *
 * All tenant-scoped procedures require a `tenantId` in the input and are
 * gated by operatorProcedure (platform admins bypass; members need
 * owner/operator).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { operatorProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import * as membership from "../services/membership";
import { writeAuditLog } from "./audit";
import { users, staffInvites } from "../../drizzle/schema";
import { ENV } from "../_core/env";

// === W46 kyc === TEN-9: scoped finance/catalog roles are grantable.
const roleEnum = z.enum(["owner", "operator", "analyst", "finance", "catalog"]);
const tenantInput = z.object({ tenantId: z.string().min(1) });

const FORBIDDEN = (message: string) => new TRPCError({ code: "FORBIDDEN", message });

/** === W47 stakeholders === Best-effort staff notification (never blocks). */
async function notifyStaffPhone(tenantId: string, phone: string | null | undefined, text: string, notifType: string) {
  if (!phone) return;
  try {
    const { sendCustomerText } = await import("../services/channelParity");
    await sendCustomerText(tenantId, phone, "staff_membership", text, { notifType });
  } catch (err) {
    console.warn(`[membership] staff notify (${notifType}) failed:`, (err as Error)?.message);
  }
}

/** Resolve a membership userId (users.id serial or openId) to a phone. */
async function resolveUserPhone(db: any, userId: string | number): Promise<string | null> {
  const key = String(userId);
  const numericId = Number(key);
  try {
    if (Number.isInteger(numericId)) {
      const [u] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, numericId)).limit(1);
      return u?.phone ?? null;
    }
    const [u] = await db.select({ phone: users.phone }).from(users).where(eq(users.openId, key)).limit(1);
    return u?.phone ?? null;
  } catch {
    return null;
  }
}

/** W47 ONB-S-2: a direct add must target a REAL user (no phantom rows). */
async function assertUserExists(db: any, userId: string | number): Promise<void> {
  const key = String(userId);
  const numericId = Number(key);
  const found = Number.isInteger(numericId)
    ? await db.select({ id: users.id }).from(users).where(eq(users.id, numericId)).limit(1)
    : await db.select({ id: users.id }).from(users).where(eq(users.openId, key)).limit(1);
  if (!found.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `User ${key} does not exist — use membership.invite (phone-bound invite→accept) to onboard staff who have no account yet.`,
    });
  }
}

/** W47 ONB-S-1: shared owner+step-up gate for every owner-affecting change. */
async function requireOwnerChangeGate(args: {
  ctx: any;
  tenantId: string;
  stepUpChallengeId?: string;
  stepUpOtp?: string;
  what: string;
}) {
  const callerRole = args.ctx.user!.role === "admin" ? "admin" : args.ctx.membership?.role;
  if (callerRole !== "admin" && callerRole !== "owner") {
    throw FORBIDDEN(`Only an existing owner (or platform admin) can ${args.what}`);
  }
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  const { requireStepUp } = await import("../services/stepUp");
  await requireStepUp(db, {
    required: true,
    tenantId: args.tenantId,
    userId: args.ctx.user!.id,
    purpose: "owner_grant",
    stepUpChallengeId: args.stepUpChallengeId,
    stepUpOtp: args.stepUpOtp,
  });
  return db;
}

const stepUpInput = {
  stepUpChallengeId: z.string().uuid().optional(),
  stepUpOtp: z.string().length(6).optional(),
};

export const membershipRouter = router({
  /** List all members of a tenant. */
  list: operatorProcedure
    .input(tenantInput)
    .query(({ input }) => membership.listMembers(input.tenantId)),

  /** My own membership in a tenant (role discovery for the UI). */
  myMembership: operatorProcedure
    .input(tenantInput)
    .query(({ ctx, input }) => membership.getMembership(ctx.user!.id, input.tenantId)),

  /**
   * Add a staff member to a tenant. The first member of a tenant is forced
   * to 'owner'. Re-adding an existing member updates their role.
   *
   * W30 (V2#12) + W47 (ONB-S-1): the owner-guard covers BOTH directions —
   * granting owner, downgrading an owner, and ANY role change on an
   * existing membership row require the caller to be an owner (or platform
   * admin) AND a fresh step-up OTP (purpose "owner_grant"). Downgrading
   * the sole owner is refused outright.
   */
  add: operatorProcedure
    .input(
      tenantInput.extend({
        userId: z.union([z.string().min(1), z.number()]),
        role: roleEnum.optional(),
        ...stepUpInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db0 = await getDb();
      if (!db0) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      // === W47 stakeholders === ONB-S-1: resolve the target row FIRST so
      // the guard fires on ANY change to an existing membership (not only
      // on owner grants).
      const target = await membership.getMembership(input.userId, input.tenantId);
      const requested = input.role;
      const ownerGrant = requested === "owner" && target?.role !== "owner";
      const ownerDowngrade = target?.role === "owner" && !!requested && requested !== "owner";
      const anyRoleChange = !!target && !!requested && requested !== target.role;
      if (ownerDowngrade) {
        // Sole-owner protection: a tenant must always retain an owner.
        const owners = (await membership.listMembers(input.tenantId)).filter((m) => m.role === "owner");
        if (owners.length <= 1) {
          throw FORBIDDEN("Cannot downgrade the last owner of a tenant");
        }
      }
      if (ownerGrant || ownerDowngrade || anyRoleChange) {
        await requireOwnerChangeGate({
          ctx, tenantId: input.tenantId,
          stepUpChallengeId: input.stepUpChallengeId, stepUpOtp: input.stepUpOtp,
          what: ownerGrant ? "grant the owner role" : ownerDowngrade ? "downgrade an owner" : "change an existing member's role",
        });
      }
      if (!target) {
        // ONB-S-2: no phantom membership rows — the user must exist.
        await assertUserExists(db0, input.userId);
      }
      // === END W47 stakeholders ===
      const result = await membership.addMember({
        tenantId: input.tenantId,
        userId: input.userId,
        role: input.role,
        invitedBy: ctx.user!.id,
      });
      // W40 (TEN-4): staff grants (incl. owner escalation) are audited.
      // W47: before.role is recorded on role changes.
      await writeAuditLog({
        actorId: String(ctx.user!.id),
        actorRole: ctx.user!.role,
        action: "membership.add",
        entityType: "tenant_membership",
        entityId: `${input.tenantId}:${input.userId}`,
        tenantId: input.tenantId,
        summary: `User ${input.userId} granted role ${input.role ?? "default"} on tenant ${input.tenantId} by ${ctx.user!.id}`,
        before: target ? { userId: String(input.userId), role: target.role } : null,
        after: { userId: String(input.userId), role: input.role ?? "default", effectiveRole: result.role ?? null },
      });
      // ONB-S-16: the added/updated user is told (best-effort).
      await notifyStaffPhone(
        input.tenantId,
        await resolveUserPhone(db0, input.userId),
        `You have been added to a merchant workspace${result.role ? ` as ${result.role}` : ""} on WhatsApp Commerce. If you did not expect this, contact support.`,
        "staff_membership_added",
      );
      return result;
    }),

  /**
   * Remove a staff member. The last owner of a tenant cannot be removed.
   * W47 ONB-S-1: removing ANY owner requires the caller to be an owner
   * (or platform admin) AND a fresh owner_grant step-up OTP.
   */
  remove: operatorProcedure
    .input(
      tenantInput.extend({
        userId: z.union([z.string().min(1), z.number()]),
        ...stepUpInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db0 = await getDb();
      if (!db0) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const target = await membership.getMembership(input.userId, input.tenantId);
      if (target?.role === "owner") {
        // Sole-owner refusal fires BEFORE the step-up demand (honest error).
        const owners = (await membership.listMembers(input.tenantId)).filter((m) => m.role === "owner");
        if (owners.length <= 1) {
          throw FORBIDDEN("Cannot remove the last owner of a tenant");
        }
        await requireOwnerChangeGate({
          ctx, tenantId: input.tenantId,
          stepUpChallengeId: input.stepUpChallengeId, stepUpOtp: input.stepUpOtp,
          what: "remove an owner",
        });
      }
      const result = await membership.removeMember(input.tenantId, input.userId);
      // W40 (TEN-4): staff removals are audited (before.role recorded W47).
      await writeAuditLog({
        actorId: String(ctx.user!.id),
        actorRole: ctx.user!.role,
        action: "membership.remove",
        entityType: "tenant_membership",
        entityId: `${input.tenantId}:${input.userId}`,
        tenantId: input.tenantId,
        summary: `User ${input.userId} removed from tenant ${input.tenantId} by ${ctx.user!.id}`,
        before: { userId: String(input.userId), role: target?.role ?? null },
        after: null,
      });
      // ONB-S-16: removed staff are told their access ended (best-effort).
      await notifyStaffPhone(
        input.tenantId,
        await resolveUserPhone(db0, input.userId),
        "Your staff access to a WhatsApp Commerce merchant workspace has been removed.",
        "staff_membership_removed",
      );
      return result;
    }),

  // === W47 stakeholders === ONB-S-2: invite→accept staff onboarding ─────
  /**
   * Invite a staff member BY PHONE. The invite is bound to the invitee's
   * number (same TEN-19 model as tenantInvite); the membership row is
   * created only when the invitee accepts with a phone-identity proof.
   * Inviting with role "owner" requires the owner+step-up gate.
   */
  invite: operatorProcedure
    .input(
      tenantInput.extend({
        phone: z.string().min(6).max(30),
        role: roleEnum.default("operator"),
        expiryHours: z.number().min(1).max(72).default(72),
        ...stepUpInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      if (input.role === "owner") {
        await requireOwnerChangeGate({
          ctx, tenantId: input.tenantId,
          stepUpChallengeId: input.stepUpChallengeId, stepUpOtp: input.stepUpOtp,
          what: "invite a new owner",
        });
      }
      const { normalisePhone } = await import("./phoneAuth");
      const phone = normalisePhone(input.phone);
      // One pending invite per (tenant, phone): revoke any stale pending row.
      await db.update(staffInvites)
        .set({ status: "revoked" })
        .where(and(eq(staffInvites.tenantId, input.tenantId), eq(staffInvites.phone, phone), eq(staffInvites.status, "pending")));
      const { randomUUID } = await import("crypto");
      const token = randomUUID();
      const expiresAt = new Date(Date.now() + input.expiryHours * 60 * 60 * 1000);
      const [row] = await db.insert(staffInvites).values({
        tenantId: input.tenantId,
        phone,
        role: input.role,
        token,
        invitedBy: String(ctx.user!.id),
        expiresAt,
      }).returning();
      await writeAuditLog({
        actorId: String(ctx.user!.id),
        actorRole: ctx.user!.role,
        action: "membership.invite",
        entityType: "staff_invite",
        entityId: row.id,
        tenantId: input.tenantId,
        summary: `Staff invite for ${phone} as ${input.role} on tenant ${input.tenantId} by ${ctx.user!.id}`,
        before: null,
        after: { inviteId: row.id, phone, role: input.role, expiresAt: expiresAt.toISOString() },
      });
      // ONB-S-16: the invitee is notified on BOTH channels (best-effort).
      await notifyStaffPhone(
        input.tenantId, phone,
        `You have been invited to join a WhatsApp Commerce merchant workspace as ${input.role}. Open the staff invite link and verify this phone number to accept. The invite expires in ${input.expiryHours}h.`,
        "staff_invite_sent",
      );
      return { inviteId: row.id, token, phone, role: input.role, expiresAt: expiresAt.toISOString() };
    }),

  /**
   * Accept a staff invite: requires a phone_identity proof (phoneAuth OTP)
   * for the invite's bound phone. The claim is a guarded UPDATE so a
   * revoked/expired/consumed invite can never mint a membership. The
   * invitee's user account is resolved deterministically (canonical =
   * lowest users.id for the phone; a phone-only account is created when
   * none exists — ONB-S-14 single canonical row per phone).
   */
  acceptInvite: publicProcedure
    .input(z.object({
      token: z.string().min(8),
      identityProof: z.string().min(10),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [invite] = await db.select().from(staffInvites).where(eq(staffInvites.token, input.token)).limit(1);
      if (!invite) throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
      // Verify the phone-identity proof BEFORE claiming.
      const jwt = (await import("jsonwebtoken")).default;
      let proof: any;
      try {
        proof = jwt.verify(input.identityProof, ENV.jwtSecret);
      } catch {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Identity proof is invalid or expired — re-verify your phone." });
      }
      if (proof?.type !== "phone_identity" || typeof proof.phone !== "string") {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Identity proof is not a phone-identity assertion." });
      }
      const digits = (p: string) => p.replace(/\D/g, "");
      if (digits(proof.phone) !== digits(invite.phone)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This invite is bound to a different phone number." });
      }
      // Claim-first: only a pending, unexpired invite can be consumed.
      const claimed = await db.update(staffInvites)
        .set({ status: "accepted", acceptedAt: new Date() })
        .where(and(
          eq(staffInvites.id, invite.id),
          eq(staffInvites.status, "pending"),
        ))
        .returning({ id: staffInvites.id });
      if (!claimed.length) {
        throw new TRPCError({ code: "CONFLICT", message: `Invite is no longer pending (status: ${invite.status})` });
      }
      if (invite.expiresAt.getTime() < Date.now()) {
        await db.update(staffInvites).set({ status: "expired" }).where(eq(staffInvites.id, invite.id));
        throw new TRPCError({ code: "CONFLICT", message: "Invite has expired — ask for a fresh one." });
      }
      // Resolve (or create) the canonical user row for this phone.
      const { normalisePhone } = await import("./phoneAuth");
      const phone = normalisePhone(invite.phone);
      const existing = await db.select().from(users).where(eq(users.phone, phone)).orderBy(users.id).limit(1);
      let userId: string;
      if (existing.length) {
        userId = String(existing[0].id);
      } else {
        const [created] = await db.insert(users).values({
          openId: `phone:${digits(phone)}`,
          phone,
          phoneVerified: true,
          loginMethod: "phone",
          role: "user",
          tenantId: invite.tenantId,
          lastSignedIn: new Date(),
        }).returning();
        userId = String(created.id);
      }
      await db.update(staffInvites).set({ acceptedUserId: userId }).where(eq(staffInvites.id, invite.id));
      const member = await membership.addMember({
        tenantId: invite.tenantId,
        userId,
        role: invite.role as membership.MembershipRole,
        invitedBy: invite.invitedBy,
      });
      await writeAuditLog({
        actorId: userId,
        actorRole: "user",
        action: "membership.inviteAccepted",
        entityType: "staff_invite",
        entityId: invite.id,
        tenantId: invite.tenantId,
        summary: `Staff invite ${invite.id} accepted by ${phone}; membership ${member.role} created on tenant ${invite.tenantId}`,
        before: { status: "pending" },
        after: { status: "accepted", userId, role: member.role },
      });
      return { accepted: true, tenantId: invite.tenantId, userId, role: member.role };
    }),

  /** Revoke a pending staff invite (ONB-S-5 parity for staff invites). */
  revokeInvite: operatorProcedure
    .input(tenantInput.extend({ inviteId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const flipped = await db.update(staffInvites)
        .set({ status: "revoked" })
        .where(and(
          eq(staffInvites.id, input.inviteId),
          eq(staffInvites.tenantId, input.tenantId),
          eq(staffInvites.status, "pending"),
        ))
        .returning({ id: staffInvites.id });
      if (!flipped.length) {
        const [row] = await db.select().from(staffInvites)
          .where(and(eq(staffInvites.id, input.inviteId), eq(staffInvites.tenantId, input.tenantId))).limit(1);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
        if (row.status === "revoked") return { revoked: true, duplicate: true };
        throw new TRPCError({ code: "CONFLICT", message: `Cannot revoke an invite in status "${row.status}"` });
      }
      await writeAuditLog({
        actorId: String(ctx.user!.id),
        actorRole: ctx.user!.role,
        action: "membership.inviteRevoked",
        entityType: "staff_invite",
        entityId: input.inviteId,
        tenantId: input.tenantId,
        summary: `Staff invite ${input.inviteId} revoked on tenant ${input.tenantId} by ${ctx.user!.id}`,
        before: { status: "pending" },
        after: { status: "revoked" },
      });
      return { revoked: true };
    }),

  /** List staff invites for a tenant (ONB-S-5 parity). */
  listInvites: operatorProcedure
    .input(tenantInput)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(staffInvites).where(eq(staffInvites.tenantId, input.tenantId));
    }),
  // === END W47 stakeholders ===
});

export type MembershipRouter = typeof membershipRouter;
