import { z } from "zod";
import { nanoid } from "nanoid";
import { router, protectedProcedure, publicProcedure, operatorProcedure, assertTenantAccess } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { and, eq, ne } from "drizzle-orm";
import * as db from "../db";
import { tenants } from "../../drizzle/schema";
import { DEFAULT_TENANT_ID, getTenantByIdForTheme } from "../_core/tenantDomain";
import { decryptSecret, encryptSecret } from "../services/crypto/secrets";
import { writeAuditLog } from "./audit";
import { ENV } from "../_core/env";
import { telegramEnabled } from "../services/telegramSender";
import {
  buildTelegramWebhookUrl,
  getBotIdentity,
  loadStoredTelegramConfig,
  registerWebhook,
  storeWebhookSecret,
} from "../services/telegramSetup";
// === W47 merchant === ONB-M-6: shared ownership pre-check (also used by
// onboarding.updateStep). Local copy removed.
import { findWhatsAppNumberConflict } from "../services/whatsappNumbers";
// === END W47 merchant ===

/**
 * W40 tenancy (TEN-3): one WhatsApp phone number id maps to exactly one
 * tenant. The DB-level partial unique index (migration 0123) is the
 * backstop; the shared pre-check (services/whatsappNumbers) gives the
 * honest CONFLICT error instead of a raw 23505.
 */

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

  /**
   * Branding for the CALLER's own tenant (ctx.user.tenantId) — distinct from
   * tenantTheme, which resolves via the request Host header for public
   * storefronts. On the shared wa-app.newfire.app domain every signed-in
   * user's Host is the same, so tenantTheme always resolved to the platform
   * default tenant regardless of which business they'd actually created —
   * this is what the authenticated app shell (DashboardLayout's sidebar
   * header) should use instead so it shows the user's own business name.
   */
  myTenant: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.user.tenantId ?? null;
    const t = tenantId ? await getTenantByIdForTheme(tenantId).catch(() => null) : null;
    const settings = ((t?.settings ?? {}) as Record<string, unknown>);
    const branding = ((settings.branding ?? {}) as Record<string, unknown>);
    return {
      tenantId,
      name: (typeof branding.name === "string" && branding.name) || t?.name || null,
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
    .mutation(async ({ input, ctx }) => {
      const id = nanoid();
      await db.createTenant({ id, ...input, status: "trial" });
      // W40 (TEN-4): tenant lifecycle changes are admin-audited.
      await writeAuditLog({
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        action: "tenant.create",
        entityType: "tenant",
        entityId: id,
        tenantId: id,
        summary: `Tenant created: ${input.name} (slug ${input.slug}, plan ${input.plan})`,
        before: null,
        after: { id, ...input, status: "trial" },
      });
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
      // W40 (TEN-3): reject number hijack with an honest CONFLICT — the
      // 0123 partial unique index is the DB backstop for races.
      const conflictId = await findWhatsAppNumberConflict(input.phoneNumberId, input.tenantId);
      if (conflictId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `WhatsApp phone number id ${input.phoneNumberId} is already configured on another tenant`,
        });
      }
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
      // W40 (TEN-4): channel-config changes are security-relevant — audit.
      await writeAuditLog({
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        action: "tenant.updateWhatsAppConfig",
        entityType: "tenant",
        entityId: input.tenantId,
        tenantId: input.tenantId,
        summary: `WhatsApp config updated (phoneNumberId ${t.whatsappPhoneNumberId ?? "∅"} → ${input.phoneNumberId})`,
        before: { phoneNumberId: t.whatsappPhoneNumberId ?? null, wabaId: t.whatsappBusinessAccountId ?? null },
        after: { phoneNumberId: input.phoneNumberId, wabaId: input.wabaId },
      });
      return { success: true };
    }),

  // === W37 telegram (Coder B): per-tenant Telegram Bot config ===
  // Mirrors getWhatsAppConfig/updateWhatsAppConfig: the bot token + webhook
  // secret live in settings.telegram encrypted at rest (v1: envelope, same
  // helpers as whatsapp.accessToken) and are only ever returned masked.
  getTelegramConfig: operatorProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const t = await db.getTenantById(input.tenantId);
      if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
      const settings = (t.settings ?? {}) as Record<string, unknown>;
      const tg = (settings.telegram ?? {}) as Record<string, unknown>;
      const rawToken = typeof tg.botToken === "string" ? tg.botToken : "";
      const botToken = rawToken ? decryptSecret(rawToken) : "";
      return {
        tenantId: t.id,
        enabled: tg.enabled === true,
        botUsername: typeof tg.botUsername === "string" ? tg.botUsername : "",
        botToken: botToken ? "••••••••" + botToken.slice(-4) : "",
        webhookSecretSet: Boolean(typeof tg.webhookSecret === "string" && tg.webhookSecret),
        configured: Boolean(tg.enabled === true && botToken),
        // For the settings card: is the feature switched on for this server at all, and where must Telegram
        // deliver this business's updates (null when the app's public address is not https).
        serverEnabled: telegramEnabled(),
        webhookUrl: buildTelegramWebhookUrl(process.env.APP_URL ?? ENV.appUrl, t.id),
      };
    }),

  updateTelegramConfig: operatorProcedure
    .input(z.object({
      tenantId: z.string(),
      // Bot API token format: <bot_id>:<35-char secret>.
      // Optional once a token is stored, so the toggle / username can be changed without re-typing it.
      botToken: z.string().regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, "Invalid Telegram bot token format").optional(),
      botUsername: z.string().min(3).max(64).regex(/^@?[A-Za-z0-9_]{3,}$/, "Invalid Telegram bot username"),
      enabled: z.boolean().default(false),
      // Optional: rotating the webhook secret. Unset/empty → a fresh random
      // secret is generated (returned once so the operator can setWebhook).
      webhookSecret: z.string().max(128).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const t = await db.getTenantById(input.tenantId);
      if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
      const botUsername = input.botUsername.replace(/^@/, "");
      // Honest uniqueness guard: one bot username maps to exactly one tenant
      // (a shared bot would misroute tenant-scoped webhooks — TEN-3 class).
      // settings is a JSON blob, so scan tenant settings directly.
      const all = await db.getTenants(1000, 0);
      const conflict = all.find((other: any) => {
        if (other.id === input.tenantId) return false;
        const tg = (((other.settings ?? {}) as Record<string, unknown>).telegram ?? {}) as Record<string, unknown>;
        return typeof tg.botUsername === "string" && tg.botUsername.toLowerCase() === botUsername.toLowerCase();
      });
      if (conflict) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Telegram bot @${botUsername} is already configured on another tenant`,
        });
      }
      const settings = { ...((t.settings ?? {}) as Record<string, unknown>) };
      const prev = (settings.telegram ?? {}) as Record<string, unknown>;
      const storedToken = typeof prev.botToken === "string" && prev.botToken ? prev.botToken : null;
      if (!input.botToken && !storedToken) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A bot token is required the first time you set up Telegram." });
      }
      const generatedSecret = !input.webhookSecret && !prev.webhookSecret;
      const webhookSecret = input.webhookSecret
        ? input.webhookSecret
        : typeof prev.webhookSecret === "string" && prev.webhookSecret
          ? decryptSecret(prev.webhookSecret as string)
          : nanoid(32);
      settings.telegram = {
        ...prev,
        enabled: input.enabled,
        botUsername,
        botToken: input.botToken ? encryptSecret(input.botToken) : storedToken!,
        webhookSecret: encryptSecret(webhookSecret),
      };
      await db.updateTenant(input.tenantId, { settings });
      // W40 (TEN-4): channel-config changes are security-relevant — audit.
      await writeAuditLog({
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        action: "tenant.updateTelegramConfig",
        entityType: "tenant",
        entityId: input.tenantId,
        tenantId: input.tenantId,
        summary: `Telegram config updated (bot @${botUsername}, enabled=${input.enabled})`,
        before: { botUsername: typeof prev.botUsername === "string" ? prev.botUsername : null, enabled: prev.enabled === true },
        after: { botUsername, enabled: input.enabled },
      });
      // The webhook secret is returned ONCE when freshly generated so the
      // operator can pass it to setWebhook; afterwards it is only masked.
      return { success: true, ...(generatedSecret ? { webhookSecret } : {}) };
    }),

  /**
   * Ask Telegram which bot the STORED token belongs to (getMe). The token is read and used on the server only;
   * nothing secret is returned. `matchesSaved` is false when the token belongs to a different bot than the
   * username saved for this business.
   */
  testTelegramConnection: operatorProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const cfg = await loadStoredTelegramConfig(input.tenantId);
      if (!cfg) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
      if (!cfg.botToken) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Save a bot token first." });
      const r = await getBotIdentity(cfg.botToken);
      if (!r.ok) return { ok: false, error: r.message, botUsername: null as string | null, matchesSaved: false };
      const saved = cfg.botUsername.replace(/^@/, "").toLowerCase();
      return {
        ok: true,
        error: null as string | null,
        botUsername: r.result.username as string | null,
        matchesSaved: saved !== "" && saved === r.result.username.toLowerCase(),
      };
    }),

  /**
   * Tell Telegram where to deliver this business's updates (setWebhook) and read back what it recorded. The
   * address is built HERE from the app's own public URL and the tenant id, and the secret is the stored one,
   * so the operator never handles either. Refuses (without calling Telegram) when the server switch is off,
   * the business has no token or is not enabled, or the app's address is not https.
   */
  registerTelegramWebhook: operatorProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      if (!telegramEnabled()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Telegram is switched off on this server. Ask an engineer to enable it (TELEGRAM_ENABLED), then try again.",
        });
      }
      const cfg = await loadStoredTelegramConfig(input.tenantId);
      if (!cfg) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
      if (!cfg.botToken || !cfg.enabled) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Save the bot token and turn Telegram on for this business first." });
      }
      const url = buildTelegramWebhookUrl(process.env.APP_URL ?? ENV.appUrl, input.tenantId);
      if (!url) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This app's public address is not https, which Telegram requires for webhooks." });
      }
      let secret = cfg.webhookSecret;
      if (!secret) {
        secret = nanoid(32);
        await storeWebhookSecret(input.tenantId, secret);
      }
      const r = await registerWebhook({ token: cfg.botToken, url, secret });
      await writeAuditLog({
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        action: "tenant.registerTelegramWebhook",
        entityType: "tenant",
        entityId: input.tenantId,
        tenantId: input.tenantId,
        summary: r.ok
          ? `Telegram webhook registered for bot @${cfg.botUsername}`
          : `Telegram webhook registration failed for bot @${cfg.botUsername}: ${r.message}`,
        before: null,
        after: { url, ok: r.ok },
      });
      if (!r.ok) return { ok: false, error: r.message, webhookUrl: url, pendingUpdateCount: 0, lastErrorMessage: null as string | null };
      return {
        ok: true,
        error: null as string | null,
        webhookUrl: r.result.url || url,
        pendingUpdateCount: r.result.pendingUpdateCount,
        lastErrorMessage: r.result.lastErrorMessage,
      };
    }),
  // === END W37 telegram ===

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
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      // W40 (TEN-3): the admin update path can also move a WhatsApp number
      // — same honest CONFLICT pre-check as updateWhatsAppConfig.
      if (data.whatsappPhoneNumberId) {
        const conflictId = await findWhatsAppNumberConflict(data.whatsappPhoneNumberId, id);
        if (conflictId) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `WhatsApp phone number id ${data.whatsappPhoneNumberId} is already configured on another tenant`,
          });
        }
      }
      // W40 (TEN-4): capture the before-state for the audit row (lifecycle
      // changes like suspension MUST be attributable).
      const beforeTenant = await db.getTenantById(id).catch(() => null);
      await db.updateTenant(id, data);
      await writeAuditLog({
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        action: "tenant.update",
        entityType: "tenant",
        entityId: id,
        tenantId: id,
        summary: `Tenant ${id} updated: ${Object.keys(data).join(", ")}${data.status ? ` (status ${beforeTenant?.status ?? "?"} → ${data.status})` : ""}`,
        before: beforeTenant
          ? { name: beforeTenant.name, plan: beforeTenant.plan, status: beforeTenant.status, whatsappPhoneNumberId: beforeTenant.whatsappPhoneNumberId ?? null }
          : null,
        after: data,
      });
      return { success: true };
    }),
});
