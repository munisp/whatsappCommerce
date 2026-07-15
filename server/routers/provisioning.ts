import { z } from "zod";
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import { getDb } from "../db";
import {
  tenantIntegrations, provisioningJobs, unifiedOnboardingSessions,
  tenants,
} from "../../drizzle/schema";
import { eq, and, desc } from "drizzle-orm";
import { inArray } from "drizzle-orm";
import { randomUUID } from "crypto";

function getTenantId(ctx: { user: { tenantId?: string | null } }): string {
  return ctx.user?.tenantId ?? "default";
}

// ── Integration health check helpers ─────────────────────────────────────────
async function checkMedusaHealth(baseUrl: string, adminKey: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, {
      headers: { "x-medusa-access-token": adminKey },
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, error: String(e) };
  }
}

async function checkTwentyHealth(baseUrl: string, apiKey: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/health`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, error: String(e) };
  }
}

async function checkOdooHealth(baseUrl: string, database: string, apiKey: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/web/dataset/call_kw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "call", id: 1,
        params: {
          model: "res.partner", method: "check_access_rights",
          args: ["read"], kwargs: { context: {} },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, error: String(e) };
  }
}

// ── Provisioning steps ────────────────────────────────────────────────────────
const ONBOARDING_STEPS = [
  "welcome",
  "business_profile",
  "whatsapp_setup",
  "crm_setup",       // Twenty CRM
  "erp_setup",       // Odoo ERP
  "ecommerce_setup", // Medusa
  "channels_setup",  // USSD, SMS, Telegram
  "payments_setup",  // Mobile money, Paystack, Stripe
  "billing_model",
  "review",
  "completed",
] as const;
type OnboardingStep = typeof ONBOARDING_STEPS[number];

export const provisioningRouter = router({
  // ── Session management ────────────────────────────────────────────────────
  getSession: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return null;
    const tenantId = getTenantId(ctx);
    const [session] = await db.select().from(unifiedOnboardingSessions)
      .where(eq(unifiedOnboardingSessions.tenantId, tenantId)).limit(1);
    return session ?? null;
  }),

  initSession: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const tenantId = getTenantId(ctx);
    const existing = await db.select({ id: unifiedOnboardingSessions.id })
      .from(unifiedOnboardingSessions)
      .where(eq(unifiedOnboardingSessions.tenantId, tenantId)).limit(1);
    if (existing[0]) return { id: existing[0].id, alreadyExists: true };
    const id = randomUUID();
    await db.insert(unifiedOnboardingSessions).values({ id, tenantId });
    return { id, alreadyExists: false };
  }),

  saveStep: protectedProcedure
    .input(z.object({
      step: z.enum(ONBOARDING_STEPS),
      data: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      const stepIdx = ONBOARDING_STEPS.indexOf(input.step);
      const nextStep = ONBOARDING_STEPS[Math.min(stepIdx + 1, ONBOARDING_STEPS.length - 1)];

      const columnMap: Record<string, string> = {
        business_profile: "businessProfile",
        whatsapp_setup: "whatsappConfig",
        crm_setup: "crmConfig",
        erp_setup: "erpConfig",
        ecommerce_setup: "ecommerceConfig",
        channels_setup: "channelsConfig",
        payments_setup: "paymentsConfig",
        billing_model: "billingConfig",
      };

      const [existing] = await db.select({ id: unifiedOnboardingSessions.id, completedSteps: unifiedOnboardingSessions.completedSteps })
        .from(unifiedOnboardingSessions)
        .where(eq(unifiedOnboardingSessions.tenantId, tenantId)).limit(1);

      const completedSteps = ((existing?.completedSteps as string[]) ?? []);
      if (!completedSteps.includes(input.step)) completedSteps.push(input.step);

      const updateData: Record<string, unknown> = {
        currentStep: nextStep,
        completedSteps,
        updatedAt: new Date(),
      };
      const col = columnMap[input.step];
      if (col) updateData[col] = input.data;
      if (input.step === "review") {
        updateData.isComplete = true;
        updateData.completedAt = new Date();
      }

      if (existing) {
        await db.update(unifiedOnboardingSessions).set(updateData)
          .where(eq(unifiedOnboardingSessions.tenantId, tenantId));
      } else {
        await db.insert(unifiedOnboardingSessions).values({
          id: randomUUID(), tenantId, currentStep: nextStep,
          completedSteps, ...updateData,
        });
      }
      return { nextStep };
    }),

  // ── Integration provisioning ──────────────────────────────────────────────
  provisionMedusa: protectedProcedure
    .input(z.object({
      baseUrl: z.string().url(),
      adminApiKey: z.string().min(1),
      publishableKey: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      const jobId = randomUUID();

      // Create provisioning job
      await db.insert(provisioningJobs).values({
        id: jobId, tenantId, integrationType: "medusa",
        stepName: "health_check", stepIndex: 0, totalSteps: 3,
        inputPayload: { baseUrl: input.baseUrl },
        startedAt: new Date(),
      });

      // Step 1: Health check
      const health = await checkMedusaHealth(input.baseUrl, input.adminApiKey);
      if (!health.ok) {
        await db.update(provisioningJobs).set({ status: "failed", errorMessage: health.error ?? "Medusa health check failed", completedAt: new Date() }).where(eq(provisioningJobs.id, jobId));
        return { success: false, error: health.error ?? "Cannot reach Medusa instance" };
      }

      // Step 2: Upsert integration record
      await db.update(provisioningJobs).set({ stepName: "save_credentials", stepIndex: 1, status: "in_progress" }).where(eq(provisioningJobs.id, jobId));

      const existing = await db.select({ id: tenantIntegrations.id }).from(tenantIntegrations)
        .where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.integrationType, "medusa"))).limit(1);

      if (existing[0]) {
        await db.update(tenantIntegrations).set({
          baseUrl: input.baseUrl, apiKey: input.adminApiKey, apiSecret: input.publishableKey,
          status: "active", lastHealthCheck: new Date(), lastHealthStatus: "ok",
          enabledAt: new Date(), updatedAt: new Date(),
        }).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.integrationType, "medusa")));
      } else {
        await db.insert(tenantIntegrations).values({
          id: randomUUID(), tenantId, integrationType: "medusa",
          displayName: "Medusa Commerce", baseUrl: input.baseUrl,
          apiKey: input.adminApiKey, apiSecret: input.publishableKey,
          status: "active", lastHealthCheck: new Date(), lastHealthStatus: "ok",
          enabledAt: new Date(),
        });
      }

      await db.update(provisioningJobs).set({ status: "completed", stepIndex: 2, stepName: "done", completedAt: new Date(), outputPayload: { latencyMs: health.latencyMs } }).where(eq(provisioningJobs.id, jobId));
      return { success: true, latencyMs: health.latencyMs };
    }),

  provisionTwentyCrm: protectedProcedure
    .input(z.object({
      baseUrl: z.string().url(),
      apiKey: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      const jobId = randomUUID();

      await db.insert(provisioningJobs).values({
        id: jobId, tenantId, integrationType: "twenty_crm",
        stepName: "health_check", stepIndex: 0, totalSteps: 2,
        inputPayload: { baseUrl: input.baseUrl }, startedAt: new Date(),
      });

      const health = await checkTwentyHealth(input.baseUrl, input.apiKey);
      if (!health.ok) {
        await db.update(provisioningJobs).set({ status: "failed", errorMessage: health.error ?? "Twenty CRM health check failed", completedAt: new Date() }).where(eq(provisioningJobs.id, jobId));
        return { success: false, error: health.error ?? "Cannot reach Twenty CRM instance" };
      }

      const existing = await db.select({ id: tenantIntegrations.id }).from(tenantIntegrations)
        .where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.integrationType, "twenty_crm"))).limit(1);

      if (existing[0]) {
        await db.update(tenantIntegrations).set({
          baseUrl: input.baseUrl, apiKey: input.apiKey,
          status: "active", lastHealthCheck: new Date(), lastHealthStatus: "ok",
          enabledAt: new Date(), updatedAt: new Date(),
        }).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.integrationType, "twenty_crm")));
      } else {
        await db.insert(tenantIntegrations).values({
          id: randomUUID(), tenantId, integrationType: "twenty_crm",
          displayName: "Twenty CRM", baseUrl: input.baseUrl, apiKey: input.apiKey,
          status: "active", lastHealthCheck: new Date(), lastHealthStatus: "ok",
          enabledAt: new Date(),
        });
      }

      await db.update(provisioningJobs).set({ status: "completed", stepIndex: 1, stepName: "done", completedAt: new Date() }).where(eq(provisioningJobs.id, jobId));
      return { success: true, latencyMs: health.latencyMs };
    }),

  provisionOdooErp: protectedProcedure
    .input(z.object({
      baseUrl: z.string().url(),
      database: z.string().min(1),
      username: z.string().min(1),
      apiKey: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      const jobId = randomUUID();

      await db.insert(provisioningJobs).values({
        id: jobId, tenantId, integrationType: "odoo_erp",
        stepName: "health_check", stepIndex: 0, totalSteps: 2,
        inputPayload: { baseUrl: input.baseUrl, database: input.database }, startedAt: new Date(),
      });

      const health = await checkOdooHealth(input.baseUrl, input.database, input.apiKey);
      if (!health.ok) {
        await db.update(provisioningJobs).set({ status: "failed", errorMessage: health.error ?? "Odoo health check failed", completedAt: new Date() }).where(eq(provisioningJobs.id, jobId));
        return { success: false, error: health.error ?? "Cannot reach Odoo instance" };
      }

      const existing = await db.select({ id: tenantIntegrations.id }).from(tenantIntegrations)
        .where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.integrationType, "odoo_erp"))).limit(1);

      if (existing[0]) {
        await db.update(tenantIntegrations).set({
          baseUrl: input.baseUrl, apiKey: input.apiKey,
          config: { database: input.database, username: input.username },
          status: "active", lastHealthCheck: new Date(), lastHealthStatus: "ok",
          enabledAt: new Date(), updatedAt: new Date(),
        }).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.integrationType, "odoo_erp")));
      } else {
        await db.insert(tenantIntegrations).values({
          id: randomUUID(), tenantId, integrationType: "odoo_erp",
          displayName: "Odoo ERP", baseUrl: input.baseUrl, apiKey: input.apiKey,
          config: { database: input.database, username: input.username },
          status: "active", lastHealthCheck: new Date(), lastHealthStatus: "ok",
          enabledAt: new Date(),
        });
      }

      await db.update(provisioningJobs).set({ status: "completed", stepIndex: 1, stepName: "done", completedAt: new Date() }).where(eq(provisioningJobs.id, jobId));
      return { success: true, latencyMs: health.latencyMs };
    }),

  provisionChannel: protectedProcedure
    .input(z.object({
      channel: z.enum(["africa_talking", "twilio_sms", "telegram", "instagram"]),
      config: z.record(z.string(), z.string()),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      const typeMap: Record<string, "africa_talking" | "custom"> = {
        africa_talking: "africa_talking",
        twilio_sms: "custom",
        telegram: "custom",
        instagram: "custom",
      };
      const intType = typeMap[input.channel] ?? "custom";
      const existing = await db.select({ id: tenantIntegrations.id }).from(tenantIntegrations)
        .where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.integrationType, intType))).limit(1);

      if (existing[0]) {
        await db.update(tenantIntegrations).set({
          config: input.config, status: "active", enabledAt: new Date(), updatedAt: new Date(),
        }).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.integrationType, intType)));
      } else {
        await db.insert(tenantIntegrations).values({
          id: randomUUID(), tenantId, integrationType: intType,
          displayName: input.channel.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
          config: input.config, status: "active", enabledAt: new Date(),
        });
      }
      return { success: true };
    }),

  provisionPayment: protectedProcedure
    .input(z.object({
      provider: z.enum(["paystack", "stripe", "mtn_momo", "mpesa", "airtel_money"]),
      config: z.record(z.string(), z.string()),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      const typeMap: Record<string, "paystack" | "stripe" | "mtn_momo" | "mpesa" | "custom"> = {
        paystack: "paystack", stripe: "stripe",
        mtn_momo: "mtn_momo", mpesa: "mpesa", airtel_money: "custom",
      };
      const intType = typeMap[input.provider] ?? "custom";
      const existing = await db.select({ id: tenantIntegrations.id }).from(tenantIntegrations)
        .where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.integrationType, intType))).limit(1);

      if (existing[0]) {
        await db.update(tenantIntegrations).set({
          config: input.config, status: "active", enabledAt: new Date(), updatedAt: new Date(),
        }).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.integrationType, intType)));
      } else {
        await db.insert(tenantIntegrations).values({
          id: randomUUID(), tenantId, integrationType: intType,
          displayName: input.provider.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
          config: input.config, status: "active", enabledAt: new Date(),
        });
      }
      return { success: true };
    }),

  // ── Integration health dashboard ──────────────────────────────────────────
  listIntegrations: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const tenantId = getTenantId(ctx);
    return db.select().from(tenantIntegrations)
      .where(eq(tenantIntegrations.tenantId, tenantId))
      .orderBy(tenantIntegrations.integrationType);
  }),

  pingIntegration: protectedProcedure
    .input(z.object({ integrationId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      const [integ] = await db.select().from(tenantIntegrations)
        .where(and(eq(tenantIntegrations.id, input.integrationId), eq(tenantIntegrations.tenantId, tenantId))).limit(1);
      if (!integ) throw new Error("Integration not found");

      let health: { ok: boolean; latencyMs: number; error?: string } = { ok: false, latencyMs: 0, error: "No health check for this type" };
      if (integ.integrationType === "medusa" && integ.baseUrl && integ.apiKey) {
        health = await checkMedusaHealth(integ.baseUrl, integ.apiKey);
      } else if (integ.integrationType === "twenty_crm" && integ.baseUrl && integ.apiKey) {
        health = await checkTwentyHealth(integ.baseUrl, integ.apiKey);
      } else if (integ.integrationType === "odoo_erp" && integ.baseUrl && integ.apiKey) {
        const cfg = (integ.config ?? {}) as Record<string, string>;
        health = await checkOdooHealth(integ.baseUrl, cfg.database ?? "", integ.apiKey);
      }

      await db.update(tenantIntegrations).set({
        lastHealthCheck: new Date(),
        lastHealthStatus: health.ok ? "ok" : "error",
        lastError: health.error ?? null,
        status: health.ok ? "active" : "error",
        updatedAt: new Date(),
      }).where(eq(tenantIntegrations.id, input.integrationId));

      return { ok: health.ok, latencyMs: health.latencyMs, error: health.error };
    }),

  listProvisioningJobs: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const tenantId = getTenantId(ctx);
    return db.select().from(provisioningJobs)
      .where(eq(provisioningJobs.tenantId, tenantId))
      .orderBy(desc(provisioningJobs.createdAt))
      .limit(50);
  }),

  // ── Admin: all tenants onboarding status ─────────────────────────────────
  adminListOnboardingStatus: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const sessions = await db.select().from(unifiedOnboardingSessions)
      .orderBy(desc(unifiedOnboardingSessions.createdAt)).limit(100);
    const allTenants = await db.select({ id: tenants.id, name: tenants.name, slug: tenants.slug }).from(tenants);
    const tenantMap = new Map(allTenants.map(t => [t.id, t]));
    return sessions.map(s => ({ ...s, tenant: tenantMap.get(s.tenantId) ?? null }));
  }),

  // ── Sync events: last Medusa catalog + Odoo inventory + Twenty CRM sync ──
  getSyncEvents: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { medusa: null, odoo: null, twenty: null, recentHistory: [] };
    const tenantId = getTenantId(ctx);
    const jobs = await db.select().from(provisioningJobs)
      .where(and(
        eq(provisioningJobs.tenantId, tenantId),
        inArray(provisioningJobs.stepName, ["medusa-catalog-sync", "odoo-inventory-sync", "twenty-crm-sync"])
      ))
      .orderBy(desc(provisioningJobs.createdAt))
      .limit(30);
    const medusaJobs = jobs.filter(j => j.stepName === "medusa-catalog-sync");
    const odooJobs = jobs.filter(j => j.stepName === "odoo-inventory-sync");
    const twentyJobs = jobs.filter(j => j.stepName === "twenty-crm-sync");
    return {
      medusa: medusaJobs[0] ?? null,
      odoo: odooJobs[0] ?? null,
      twenty: twentyJobs[0] ?? null,
      recentHistory: jobs.slice(0, 10),
    };
  }),
});
