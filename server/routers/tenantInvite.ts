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
 *  4. Merchant clicks link → GET /portal/login?token=<jwt>
 *  5. Server validates token, creates a session, redirects to /portal/dashboard
 */

import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
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
        .select({ id: tenants.id, name: tenants.name, whatsappPhoneNumberId: tenants.whatsappPhoneNumberId })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId));

      if (!tenant) {
        throw new Error("Tenant not found");
      }

      // Generate signed JWT magic link token with a registered jti — the
      // registry row is what makes the link single-use at validate time.
      const jti = randomUUID();
      const token = jwt.sign(
        {
          type: "portal_invite",
          jti,
          tenantId: input.tenantId,
          tenantName: tenant.name,
          issuedBy: ctx.user.id,
        },
        ENV.jwtSecret,
        { expiresIn: `${input.expiryHours}h` }
      );

      const expiresAt = new Date(Date.now() + input.expiryHours * 60 * 60 * 1000);
      await db.insert(tenantInviteTokens).values({
        jti,
        tenantId: input.tenantId,
        issuedBy: String(ctx.user.id),
        expiresAt,
      });
      const portalUrl = `${ENV.appUrl}/portal/login?token=${token}`;

      return {
        token,
        portalUrl,
        tenantId: input.tenantId,
        tenantName: tenant.name,
        expiresAt: expiresAt.toISOString(),
        whatsappMessage: `Hello ${tenant.name}! Your WhatsApp Commerce merchant portal is ready. Click the link below to access your dashboard:\n\n${portalUrl}\n\nThis link expires in ${input.expiryHours} hours.`,
        whatsappPhoneNumberId: tenant.whatsappPhoneNumberId,
      };
    }),

  /**
   * Validate a magic link token and return tenant session info
   * Called by the portal login page
   */
  validate: publicProcedure
    .input(z.object({ token: z.string() }))
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
        const consumed = await db
          .update(tenantInviteTokens)
          .set({ consumedAt: new Date() })
          .where(and(
            eq(tenantInviteTokens.jti, payload.jti),
            eq(tenantInviteTokens.tenantId, payload.tenantId),
            isNull(tenantInviteTokens.consumedAt),
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
   * Resend invite via WhatsApp (admin only)
   */
  resend: protectedProcedure
    .input(z.object({ tenantId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      // Same authorization as create: admins only, tenant-scoped.
      assertTenantAccess(ctx.user, input.tenantId);
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins can resend tenant invites" });
      }
      // Re-use create to generate a fresh token
      const db = await requireDb();

      const [tenant] = await db
        .select({ id: tenants.id, name: tenants.name, whatsappPhoneNumberId: tenants.whatsappPhoneNumberId })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId));

      if (!tenant) throw new Error("Tenant not found");

      // W30 hotfix2: resend previously minted an UNREGISTERED 72h token that
      // validate() always rejected ("Invite token is not registered") — a
      // dead link. Resent invites now get a registered jti with the SAME
      // single-use ≤24h semantics as create().
      const jti = randomUUID();
      const token = jwt.sign(
        {
          type: "portal_invite",
          jti,
          tenantId: input.tenantId,
          tenantName: tenant.name,
          issuedBy: ctx.user.id,
        },
        ENV.jwtSecret,
        { expiresIn: `${INVITE_EXPIRY_HOURS}h` }
      );

      const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);
      await db.insert(tenantInviteTokens).values({
        jti,
        tenantId: input.tenantId,
        issuedBy: String(ctx.user.id),
        expiresAt,
      });

      const portalUrl = `${ENV.appUrl}/portal/login?token=${token}`;

      return {
        sent: true,
        portalUrl,
        expiresAt: expiresAt.toISOString(),
        whatsappPhoneNumberId: tenant.whatsappPhoneNumberId,
        message: `Invite resent to ${tenant.name} (${tenant.whatsappPhoneNumberId})`,
      };
    }),
});
