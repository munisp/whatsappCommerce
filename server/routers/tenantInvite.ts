/**
 * Tenant Invite Magic Link System
 * =================================
 * When a tenant completes onboarding, generate a signed magic link
 * that lets the merchant log into their self-service portal without
 * needing a Manus/Keycloak account first.
 *
 * Flow:
 *  1. Admin calls tenantInvite.create({ tenantId })
 *  2. Server generates a signed JWT token (24h expiry) and stores in DB
 *  3. Token is sent to tenant's WhatsApp number as a portal link
 *  4. Merchant clicks link → GET /portal/login#token=<jwt>
 *     (W47 ONB-TOK-2: fragment-carried so the token never hits access logs
 *     or Referer headers; legacy ?token= links still accepted by the page)
 *  5. Server validates token, creates a session, redirects to /portal/dashboard
 *
 * W47 (ONB-S-3 / ONB-S-4 / ONB-S-5 / ONB-TOK-1):
 *  - create AND resend share one minting helper that ALWAYS resolves and
 *    persists the boundPhone — a resent link can never silently degrade to
 *    an unbound bearer token.
 *  - Minting REFUSES when the tenant has no settings.adminPhone on file
 *    (no new unbound invites; pre-W46 legacy rows keep legacy redemption).
 *  - resend writes the same audit row as create (jti + boundPhone).
 *  - invites are revocable (revokedAt) and listable; validate() refuses
 *    revoked tokens.
 *  - the portal URL carries the token in the URL FRAGMENT (never the query
 *    string) so it stays out of access logs / browser history / Referer.
 */

import { z } from "zod";
import { eq, and, isNull, desc } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import { assertTenantAccess, protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { tenants, tenantInviteTokens } from "../../drizzle/schema";
import { ENV } from "../_core/env";

// W30 (V2#13): invite links are single-use and live at most 24h (was 72h
// default / 7d max, reusable by any bearer for the full lifetime).
const INVITE_EXPIRY_HOURS = 24;
const INVITE_MAX_EXPIRY_HOURS = 24;

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db;
}

// === W47 stakeholders ===
/** Resolve the phone the invite is bound to (tenant admin phone). */
function resolveBoundPhone(tenant: { settings?: unknown }): string | null {
  const settings = (tenant.settings ?? {}) as Record<string, unknown>;
  return typeof settings.adminPhone === "string" && settings.adminPhone
    ? settings.adminPhone
    : null;
}

/**
 * ONB-S-3/TOK-1: ONE minting helper for create + resend so the phone
 * binding can never diverge. Refuses (PRECONDITION_FAILED) when the tenant
 * has no admin phone on file — no new unbound bearer invites (ONB-S-4).
 */
async function mintBoundInvite(args: {
  db: any;
  tenant: { id: string; name: string; whatsappPhoneNumberId?: string | null; settings?: unknown };
  issuedBy: string | number;
  expiryHours: number;
  actorRole: string;
  action: "tenantInvite.create" | "tenantInvite.resend";
}) {
  const boundPhone = resolveBoundPhone(args.tenant);
  if (!boundPhone) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This tenant has no verified admin phone on file (settings.adminPhone) — a phone-bound invite cannot be minted. Register the admin phone first.",
    });
  }
  const jti = randomUUID();
  const token = jwt.sign(
    {
      type: "portal_invite",
      jti,
      tenantId: args.tenant.id,
      tenantName: args.tenant.name,
      issuedBy: args.issuedBy,
      // W46 TEN-19 + W47: the binding rides the signed payload on EVERY mint.
      boundPhone,
    },
    ENV.jwtSecret,
    { expiresIn: `${args.expiryHours}h` }
  );
  const expiresAt = new Date(Date.now() + args.expiryHours * 60 * 60 * 1000);
  await args.db.insert(tenantInviteTokens).values({
    jti,
    tenantId: args.tenant.id,
    issuedBy: String(args.issuedBy),
    expiresAt,
    boundPhone,
  });
  // W40 (TEN-4) + W47 ONB-TOK-1: resend is audited exactly like create,
  // with the jti and the bound phone attributable.
  const { writeAuditLog } = await import("./audit");
  await writeAuditLog({
    actorId: String(args.issuedBy),
    actorRole: args.actorRole,
    action: args.action,
    entityType: "tenant_invite",
    entityId: jti,
    tenantId: args.tenant.id,
    summary: `Portal invite ${args.action === "tenantInvite.resend" ? "resent" : "minted"} for tenant ${args.tenant.name} (${args.tenant.id}), bound to admin phone, expires ${expiresAt.toISOString()}`,
    before: null,
    after: { jti, tenantId: args.tenant.id, boundPhone, expiresAt: expiresAt.toISOString() },
  });
  // ONB-S-15: token in the URL FRAGMENT — never the query string.
  const portalUrl = `${ENV.appUrl}/portal/login#token=${token}`;
  return { jti, token, portalUrl, expiresAt, boundPhone };
}
// === END W47 stakeholders ===

export const tenantInviteRouter = router({
  /**
   * Create a magic link invite for a tenant (admin only)
   */
  create: protectedProcedure
    .input(z.object({
      tenantId: z.string().uuid(),
      expiryHours: z.number().min(1).max(INVITE_MAX_EXPIRY_HOURS).default(INVITE_EXPIRY_HOURS),
    }))
    .mutation(async ({ input, ctx }) => {
      // Only admins may mint invite links. Platform admins (role "admin")
      // bypass the tenant check; tenant admins invite their own staff.
      assertTenantAccess(ctx.user, input.tenantId);
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins can create tenant invites" });
      }
      const db = await requireDb();

      // Verify tenant exists
      const [tenant] = await db
        .select({ id: tenants.id, name: tenants.name, whatsappPhoneNumberId: tenants.whatsappPhoneNumberId, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId));

      if (!tenant) {
        throw new Error("Tenant not found");
      }

      const minted = await mintBoundInvite({
        db, tenant, issuedBy: ctx.user.id,
        expiryHours: input.expiryHours, actorRole: ctx.user.role,
        action: "tenantInvite.create",
      });

      return {
        token: minted.token,
        portalUrl: minted.portalUrl,
        tenantId: input.tenantId,
        tenantName: tenant.name,
        expiresAt: minted.expiresAt.toISOString(),
        whatsappMessage: `Hello ${tenant.name}! Your WhatsApp Commerce merchant portal is ready. Click the link below to access your dashboard:\n\n${minted.portalUrl}\n\nThis link expires in ${input.expiryHours} hours.`,
        whatsappPhoneNumberId: tenant.whatsappPhoneNumberId,
      };
    }),

  /**
   * Validate a magic link token and return tenant session info
   * Called by the portal login page
   */
  validate: publicProcedure
    .input(z.object({
      token: z.string(),
      // === W46 privacy-consent (TEN-19): phone-identity proof minted by
      // phoneAuth.verifyOtp — required when the invite is phone-bound. ===
      identityProof: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      try {
        const payload = jwt.verify(input.token, ENV.jwtSecret) as any;

        if (payload.type !== "portal_invite") {
          throw new Error("Invalid token type");
        }

        const db = await requireDb();

        // W30 (V2#13): single-use — the jti must be registered, unexpired,
        // and unconsumed; the consume is a guarded UPDATE so two concurrent
        // validations of the same link can never both mint sessions.
        if (!payload.jti || typeof payload.jti !== "string") {
          throw new Error("Invite token is not registered (pre-registry links are no longer valid)");
        }

        // === W46 privacy-consent (TEN-19 residual): verified-identity
        // binding. When the invite row carries boundPhone, redemption
        // requires a valid phone_identity proof for THAT number (checked
        // BEFORE the single-use consume so a failed proof never burns the
        // link). Legacy unbound rows keep the pre-W46 behavior. ===
        const [inviteRow] = await db
          .select({ boundPhone: tenantInviteTokens.boundPhone, revokedAt: tenantInviteTokens.revokedAt })
          .from(tenantInviteTokens)
          .where(eq(tenantInviteTokens.jti, payload.jti))
          .limit(1);
        // === W47 stakeholders === ONB-S-5: revoked invites never redeem.
        if (inviteRow?.revokedAt) {
          throw new Error("This invite link has been revoked. Request a fresh invite.");
        }
        // === END W47 stakeholders ===
        const boundPhone = inviteRow?.boundPhone ?? payload.boundPhone ?? null;
        if (boundPhone) {
          if (!input.identityProof) {
            throw new Error("This invite is bound to the merchant's verified phone — complete phone verification first (identityProof required).");
          }
          let proof: any;
          try {
            proof = jwt.verify(input.identityProof, ENV.jwtSecret);
          } catch {
            throw new Error("Identity proof is invalid or expired — re-verify your phone.");
          }
          if (proof?.type !== "phone_identity" || typeof proof.phone !== "string") {
            throw new Error("Identity proof is not a phone-identity assertion.");
          }
          const digits = (p: string) => p.replace(/\D/g, "");
          if (digits(proof.phone) !== digits(boundPhone)) {
            throw new Error("This invite is bound to a different phone number.");
          }
        }
        // === END W46 privacy-consent ===

        const consumed = await db
          .update(tenantInviteTokens)
          .set({ consumedAt: new Date() })
          .where(and(
            eq(tenantInviteTokens.jti, payload.jti),
            eq(tenantInviteTokens.tenantId, payload.tenantId),
            isNull(tenantInviteTokens.consumedAt),
            isNull(tenantInviteTokens.revokedAt), // W47: revoked rows can't win the race either
          ))
          .returning({ jti: tenantInviteTokens.jti });
        if (consumed.length === 0) {
          throw new Error("Invite link has already been used (or is unknown). Request a fresh invite.");
        }

        const [tenant] = await db
          .select()
          .from(tenants)
          .where(eq(tenants.id, payload.tenantId));

        if (!tenant) throw new Error("Tenant not found");

        // Generate a short-lived portal session token (8h)
        const sessionToken = jwt.sign(
          {
            type: "portal_session",
            tenantId: tenant.id,
            tenantName: tenant.name,
            role: "tenant_owner",
          },
          ENV.jwtSecret,
          { expiresIn: "8h" }
        );

        return {
          valid: true,
          sessionToken,
          tenantId: tenant.id,
          tenantName: tenant.name,
          expiresIn: 8 * 60 * 60, // seconds
        };
      } catch (err: any) {
        return {
          valid: false,
          error: err.message || "Invalid or expired token",
        };
      }
    }),

  /**
   * Resend invite via WhatsApp (admin only). W47 ONB-S-3/TOK-1: the resent
   * token is minted by the SAME helper as create — the phone binding is
   * always preserved and the resend is audit-logged.
   */
  resend: protectedProcedure
    .input(z.object({ tenantId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      // Same authorization as create: admins only, tenant-scoped.
      assertTenantAccess(ctx.user, input.tenantId);
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins can resend tenant invites" });
      }
      const db = await requireDb();

      const [tenant] = await db
        .select({ id: tenants.id, name: tenants.name, whatsappPhoneNumberId: tenants.whatsappPhoneNumberId, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId));

      if (!tenant) throw new Error("Tenant not found");

      const minted = await mintBoundInvite({
        db, tenant, issuedBy: ctx.user.id,
        expiryHours: INVITE_EXPIRY_HOURS, actorRole: ctx.user.role,
        action: "tenantInvite.resend",
      });

      return {
        sent: true,
        portalUrl: minted.portalUrl,
        expiresAt: minted.expiresAt.toISOString(),
        whatsappPhoneNumberId: tenant.whatsappPhoneNumberId,
        message: `Invite resent to ${tenant.name} (${tenant.whatsappPhoneNumberId})`,
      };
    }),

  // === W47 stakeholders === ONB-S-5: revocation + visibility ────────────
  /**
   * Revoke an outstanding (un-consumed) invite. Admin only. Idempotent:
   * revoking an already-revoked invite returns duplicate:true.
   */
  revoke: protectedProcedure
    .input(z.object({ tenantId: z.string().uuid(), jti: z.string().min(8) }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins can revoke tenant invites" });
      }
      const db = await requireDb();
      const flipped = await db
        .update(tenantInviteTokens)
        .set({ revokedAt: new Date() })
        .where(and(
          eq(tenantInviteTokens.jti, input.jti),
          eq(tenantInviteTokens.tenantId, input.tenantId),
          isNull(tenantInviteTokens.revokedAt),
          isNull(tenantInviteTokens.consumedAt),
        ))
        .returning({ jti: tenantInviteTokens.jti });
      const { writeAuditLog } = await import("./audit");
      if (!flipped.length) {
        const [row] = await db
          .select({ jti: tenantInviteTokens.jti, revokedAt: tenantInviteTokens.revokedAt, consumedAt: tenantInviteTokens.consumedAt })
          .from(tenantInviteTokens)
          .where(and(eq(tenantInviteTokens.jti, input.jti), eq(tenantInviteTokens.tenantId, input.tenantId)))
          .limit(1);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
        if (row.revokedAt) return { revoked: true, duplicate: true };
        throw new TRPCError({ code: "CONFLICT", message: "Invite has already been consumed — nothing to revoke" });
      }
      await writeAuditLog({
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        action: "tenantInvite.revoke",
        entityType: "tenant_invite",
        entityId: input.jti,
        tenantId: input.tenantId,
        summary: `Portal invite ${input.jti} revoked for tenant ${input.tenantId} by ${ctx.user.id}`,
        before: { jti: input.jti, revokedAt: null },
        after: { jti: input.jti, revokedAt: new Date().toISOString() },
      });
      return { revoked: true };
    }),

  /** List a tenant's invite tokens (admin only; no token material). */
  list: protectedProcedure
    .input(z.object({ tenantId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins can list tenant invites" });
      }
      const db = await requireDb();
      return db
        .select({
          jti: tenantInviteTokens.jti,
          tenantId: tenantInviteTokens.tenantId,
          issuedBy: tenantInviteTokens.issuedBy,
          expiresAt: tenantInviteTokens.expiresAt,
          consumedAt: tenantInviteTokens.consumedAt,
          revokedAt: tenantInviteTokens.revokedAt,
          boundPhone: tenantInviteTokens.boundPhone,
          createdAt: tenantInviteTokens.createdAt,
        })
        .from(tenantInviteTokens)
        .where(eq(tenantInviteTokens.tenantId, input.tenantId))
        .orderBy(desc(tenantInviteTokens.createdAt))
        .limit(100);
    }),
  // === END W47 stakeholders ===
});
