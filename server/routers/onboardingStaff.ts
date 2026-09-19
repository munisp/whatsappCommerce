// === W47 merchant ===
/**
 * onboardingStaff.ts — ONB-M-12: self-service staff invites during/after
 * onboarding. Previously membership.add required the staffer's INTERNAL
 * user id (they had to self-register and read a UUID to the owner);
 * tenantInvite.create is admin-only and mints OWNER sessions. This router
 * lets a tenant owner invite staff by PHONE: a pending, phone-bound invite
 * row (merchant_staff_invites, mig 0163) that is claimed automatically on
 * the invitee's first OTP login (wired in phoneAuth.verifyOtp) or via
 * claimMyStaffInvites from a logged-in session. Invitees can only claim an
 * invite bound to THEIR verified phone number.
 */
import { z } from "zod";
import { randomBytes, randomUUID } from "crypto";
import { and, eq, gt } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { merchantStaffInvites, users } from "../../drizzle/schema";
import * as membership from "../services/membership";
import { writeAuditLog } from "./audit";

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const STAFF_ROLES = ["operator", "analyst", "finance", "catalog"] as const;

function normalizePhone(p: string): string {
  const digits = p.replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : `+${digits}`;
}

/**
 * Claim every pending, unexpired invite bound to `phone` for `userId`.
 * Called from phoneAuth.verifyOtp after a successful OTP and exposed as
 * claimMyStaffInvites. Claim-first guarded UPDATE per invite (pending →
 * claimed) so concurrent logins cannot double-claim.
 */
export async function claimStaffInvitesForPhone(
  userId: number,
  phone: string,
): Promise<{ claimed: { tenantId: string; role: string }[] }> {
  const db = await getDb();
  if (!db) return { claimed: [] };
  const normalized = normalizePhone(phone);
  const pending = await db
    .select()
    .from(merchantStaffInvites)
    .where(and(
      eq(merchantStaffInvites.phone, normalized),
      eq(merchantStaffInvites.status, "pending"),
      gt(merchantStaffInvites.expiresAt, new Date()),
    ))
    .catch(() => [] as any[]);
  const claimed: { tenantId: string; role: string }[] = [];
  for (const inv of pending) {
    const flipped = await db
      .update(merchantStaffInvites)
      .set({ status: "claimed", claimedByUserId: userId, claimedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(merchantStaffInvites.id, inv.id), eq(merchantStaffInvites.status, "pending")))
      .returning({ id: merchantStaffInvites.id })
      .catch(() => [] as any[]);
    if (!flipped.length) continue;
    await membership.addMember({ tenantId: inv.tenantId, userId, role: inv.role as any, invitedBy: inv.invitedBy });
    await writeAuditLog({
      actorId: String(userId),
      actorRole: "user",
      action: "onboarding.staff_invite_claimed",
      entityType: "merchant_staff_invite",
      entityId: inv.id,
      tenantId: inv.tenantId,
      summary: `Staff invite ${inv.id} claimed by user ${userId} (phone …${normalized.slice(-4)}) → role ${inv.role} in tenant ${inv.tenantId}`,
      before: { status: "pending" },
      after: { status: "claimed", role: inv.role },
    });
    claimed.push({ tenantId: inv.tenantId, role: inv.role });
  }
  return { claimed };
}

export const onboardingStaffRouter = router({
  /**
   * Invite a staff member by phone. Owner-only: the caller must hold the
   * owner role on this tenant (assertTenantAccess alone admits ANY member).
   * No arbitrary userId, no phantom memberships — membership is created
   * only when the invitee proves phone ownership via OTP login.
   */
  inviteStaff: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      phone: z.string().trim().min(7).max(30),
      role: z.enum(STAFF_ROLES).default("operator"),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const caller = await membership.getMembership(ctx.user.id, input.tenantId);
      if (ctx.user.role !== "admin" && caller?.role !== "owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the business owner can invite staff." });
      }
      const phone = normalizePhone(input.phone);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
      const token = randomBytes(24).toString("hex");
      const [existing] = await db
        .select()
        .from(merchantStaffInvites)
        .where(and(eq(merchantStaffInvites.tenantId, input.tenantId), eq(merchantStaffInvites.phone, phone)))
        .limit(1);
      let inviteId: string;
      if (existing && existing.status === "pending") {
        // Renew: fresh token + expiry (idempotent re-invite).
        inviteId = existing.id;
        await db.update(merchantStaffInvites)
          .set({ token, expiresAt, role: input.role, invitedBy: ctx.user.id, updatedAt: now })
          .where(eq(merchantStaffInvites.id, existing.id));
      } else {
        inviteId = randomUUID();
        await db.insert(merchantStaffInvites).values({
          id: inviteId,
          tenantId: input.tenantId,
          phone,
          role: input.role,
          invitedBy: ctx.user.id,
          status: "pending",
          token,
          expiresAt,
        });
      }
      // Best-effort WhatsApp nudge to the invitee (never blocks the invite).
      try {
        const { sendWhatsAppText } = await import("../services/waSender");
        await sendWhatsAppText(input.tenantId, phone,
          `👋 You've been invited to join a business on this platform as ${input.role}. Sign in with this phone number to accept.`,
          { notifType: "staff_invite" });
      } catch (e: any) {
        console.warn("[staff-invite] invitee nudge failed:", e?.message);
      }
      await writeAuditLog({
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        action: "onboarding.staff_invite_created",
        entityType: "merchant_staff_invite",
        entityId: inviteId,
        tenantId: input.tenantId,
        summary: `Staff invite for phone …${phone.slice(-4)} (role ${input.role}) created by user ${ctx.user.id} for tenant ${input.tenantId}`,
        before: existing ? { status: existing.status } : null,
        after: { status: "pending", role: input.role },
      });
      return { ok: true, inviteId, expiresAt };
    }),

  /** List invites for a tenant (owner/admin). */
  listStaffInvites: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      const rows = await db
        .select()
        .from(merchantStaffInvites)
        .where(eq(merchantStaffInvites.tenantId, input.tenantId));
      // Token is a bearer secret — never return it in lists.
      return rows.map(({ token: _t, ...r }) => r);
    }),

  /** Revoke a pending invite (guarded flip; audit row). */
  revokeStaffInvite: protectedProcedure
    .input(z.object({ tenantId: z.string(), inviteId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const caller = await membership.getMembership(ctx.user.id, input.tenantId);
      if (ctx.user.role !== "admin" && caller?.role !== "owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the business owner can revoke staff invites." });
      }
      const flipped = await db
        .update(merchantStaffInvites)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(and(
          eq(merchantStaffInvites.id, input.inviteId),
          eq(merchantStaffInvites.tenantId, input.tenantId),
          eq(merchantStaffInvites.status, "pending"),
        ))
        .returning({ id: merchantStaffInvites.id });
      if (!flipped.length) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Invite is not pending (already claimed or revoked)." });
      }
      await writeAuditLog({
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        action: "onboarding.staff_invite_revoked",
        entityType: "merchant_staff_invite",
        entityId: input.inviteId,
        tenantId: input.tenantId,
        summary: `Staff invite ${input.inviteId} revoked`,
        before: { status: "pending" },
        after: { status: "revoked" },
      });
      return { ok: true };
    }),

  /** Claim pending invites bound to the caller's verified phone. */
  claimMyStaffInvites: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const [me] = await db
      .select({ phone: users.phone, phoneVerified: users.phoneVerified })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);
    if (!me?.phone || !me.phoneVerified) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Verify your phone number first." });
    }
    return claimStaffInvitesForPhone(ctx.user.id, me.phone);
  }),
});
// === END W47 merchant ===
