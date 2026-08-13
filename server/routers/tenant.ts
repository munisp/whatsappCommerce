import { z } from "zod";
import { nanoid } from "nanoid";
import { router, protectedProcedure, publicProcedure, operatorProcedure, assertTenantAccess } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { DEFAULT_TENANT_ID, getTenantByIdForTheme } from "../_core/tenantDomain";
import { decryptSecret, encryptSecret } from "../services/crypto/secrets";

const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  return next({ ctx });
});

export const tenantRouter = router({
  /**
   * Public branding for the tenant resolved from the request Host header
   * (multi-domain storefronts). Returns settings.branding values with
   * safe defaults when the tenant or branding config is absent.
   */
  tenantTheme: publicProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.resolvedTenantId ?? DEFAULT_TENANT_ID;
    const t = await getTenantByIdForTheme(tenantId).catch(() => null);
    const settings = ((t?.settings ?? {}) as Record<string, unknown>);
    const branding = ((settings.branding ?? {}) as Record<string, unknown>);
    return {
      tenantId,
      name:
        (typeof branding.name === "string" && branding.name) ||
        t?.name ||
        "WhatsApp Commerce",
      logoUrl: typeof branding.logoUrl === "string" && branding.logoUrl ? branding.logoUrl : null,
      primaryColor:
        typeof branding.primaryColor === "string" && branding.primaryColor
          ? branding.primaryColor
          : "#25D366",
      currency: t?.defaultCurrency ?? "USD",
    };
  }),

  list: adminProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }).optional())
    .query(async ({ input }) => {
      return db.getTenants(input?.limit, input?.offset);
    }),

  stats: adminProcedure.query(async () => {
    return db.getTenantStats();
  }),

  get: adminProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const t = await db.getTenantById(input.id);
      if (!t) throw new TRPCError({ code: "NOT_FOUND" });
      return t;
    }),

  create: adminProcedure
    .input(z.object({
      name: z.string().min(2).max(255),
      slug: z.string().min(2).max(100).regex(/^[a-z0-9-]+$/),
      plan: z.enum(["starter", "growth", "enterprise"]).default("starter"),
      defaultCurrency: z.string().length(3).default("USD"),
      defaultLanguage: z.string().default("en"),
      aiEnabled: z.boolean().default(true),
    }))
    .mutation(async ({ input }) => {
      const id = nanoid();
      await db.createTenant({ id, ...input, status: "trial" });
      return { id, ...input };
    }),

  // WhatsApp Business API credentials for a tenant. The phone number ID,
  // business account ID, and webhook verify token live in dedicated columns on
  // the tenants table; the permanent access token is stored inside the tenant's
  // `settings` JSON blob (never returned in full — only a masked hint).
  getWhatsAppConfig: operatorProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const t = await db.getTenantById(input.tenantId);
      if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
      const settings = (t.settings ?? {}) as Record<string, unknown>;
      const wa = (settings.whatsapp ?? {}) as Record<string, unknown>;
      const rawToken = typeof wa.accessToken === "string" ? wa.accessToken : "";
      // Stored encrypted (v1:) since w10 — decrypt for masking; legacy
      // plaintext passes through unchanged.
      const accessToken = rawToken ? decryptSecret(rawToken) : "";
      return {
        tenantId: t.id,
        phoneNumberId: t.whatsappPhoneNumberId ?? "",
        wabaId: t.whatsappBusinessAccountId ?? "",
        verifyToken: t.webhookVerifyToken ?? "",
        accessToken: accessToken ? "••••••••" + accessToken.slice(-4) : "",
        configured: Boolean(t.whatsappPhoneNumberId && accessToken),
      };
    }),

  updateWhatsAppConfig: operatorProcedure
    .input(z.object({
      tenantId: z.string(),
      phoneNumberId: z.string().min(1),
      wabaId: z.string().min(1),
      accessToken: z.string().min(1),
      verifyToken: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const t = await db.getTenantById(input.tenantId);
      if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
      const settings = { ...((t.settings ?? {}) as Record<string, unknown>) };
      settings.whatsapp = {
        ...((settings.whatsapp ?? {}) as Record<string, unknown>),
        // Encrypt at rest (v1: envelope) — reads decrypt transparently.
        accessToken: encryptSecret(input.accessToken),
      };
      await db.updateTenant(input.tenantId, {
        whatsappPhoneNumberId: input.phoneNumberId,
        whatsappBusinessAccountId: input.wabaId,
        webhookVerifyToken: input.verifyToken,
        settings,
      });
      return { success: true };
    }),

  update: adminProcedure
    .input(z.object({
      id: z.string(),
      name: z.string().min(2).max(255).optional(),
      plan: z.enum(["starter", "growth", "enterprise"]).optional(),
      status: z.enum(["active", "suspended", "trial", "churned"]).optional(),
      aiEnabled: z.boolean().optional(),
      aiModel: z.string().optional(),
      whatsappPhoneNumberId: z.string().optional(),
      whatsappBusinessAccountId: z.string().optional(),
      chatwootAccountId: z.string().optional(),
      chatwootApiToken: z.string().optional(),
      cogsRate: z.number().min(0).max(0.99).optional(),
      smsFailoverEnabled: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      await db.updateTenant(id, data);
      return { success: true };
    }),
});
