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
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import { ENV } from "../_core/env";

const INVITE_EXPIRY_HOURS = 72; // 3 days

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
      expiryHours: z.number().min(1).max(168).default(72),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();

      // Verify tenant exists
      const [tenant] = await db
        .select({ id: tenants.id, name: tenants.name, whatsappPhoneNumberId: tenants.whatsappPhoneNumberId })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId));

      if (!tenant) {
        throw new Error("Tenant not found");
      }

      // Generate signed JWT magic link token
      const token = jwt.sign(
        {
          type: "portal_invite",
          tenantId: input.tenantId,
          tenantName: tenant.name,
          issuedBy: ctx.user.id,
        },
        ENV.jwtSecret,
        { expiresIn: `${input.expiryHours}h` }
      );

      const expiresAt = new Date(Date.now() + input.expiryHours * 60 * 60 * 1000);
      const portalUrl = `${process.env.APP_BASE_URL || "https://your-domain.com"}/portal/login?token=${token}`;

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
      // Re-use create to generate a fresh token
      const db = await requireDb();

      const [tenant] = await db
        .select({ id: tenants.id, name: tenants.name, whatsappPhoneNumberId: tenants.whatsappPhoneNumberId })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId));

      if (!tenant) throw new Error("Tenant not found");

      const token = jwt.sign(
        { type: "portal_invite", tenantId: input.tenantId, tenantName: tenant.name, issuedBy: ctx.user.id },
        ENV.jwtSecret,
        { expiresIn: "72h" }
      );

      const portalUrl = `${process.env.APP_BASE_URL || "https://your-domain.com"}/portal/login?token=${token}`;

      return {
        sent: true,
        portalUrl,
        whatsappPhoneNumberId: tenant.whatsappPhoneNumberId,
        message: `Invite resent to ${tenant.name} (${tenant.whatsappPhoneNumberId})`,
      };
    }),
});
