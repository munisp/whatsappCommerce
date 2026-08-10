import { z } from "zod";
import { router, protectedProcedure, adminProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { tenantOnboarding, tenants } from "../../drizzle/schema";
import type { TenantOnboarding } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  createTenant,
  getOnboardingState,
  runTenantValidation,
  setOnboardingStatus,
  updateTenantSettings,
  validationFailureReasons,
} from "../services/onboarding";
import {
  brandingConfigSchema,
  integrationCredsSchema,
  INTEGRATION_PROVIDERS,
  type TenantSettings,
} from "../../shared/tenantConfig";
import { parseWaMenuConfig, waCustomItemSchema, waUseCaseSchema } from "../../shared/waMenu";
import { encryptSecret } from "../services/crypto/secrets";

// Billing plan definitions
export const BILLING_PLANS = {
  profit_sharing: {
    name: "Profit Sharing",
    tagline: "Pay as you grow",
    description: "We take a percentage of your GMV. Zero upfront cost — you only pay when you earn.",
    defaultRate: 3.5,
    rateRange: { min: 2.0, max: 8.0 },
    minMonthlyFee: 0,
    bestFor: ["Early-stage businesses", "Seasonal sellers", "Low-volume merchants"],
    pros: ["No fixed costs", "Scales with revenue", "Risk-free to start"],
    cons: ["Higher cost at scale", "Revenue-dependent"],
    example: "On $10,000 GMV at 3.5% → $350/month",
  },
  subscription: {
    name: "Subscription",
    tagline: "Predictable monthly cost",
    description: "Fixed monthly or annual fee. Full platform access regardless of transaction volume.",
    tiers: [
      { name: "Starter", monthly: 49, annual: 470, limit: "Up to $5,000 GMV/month" },
      { name: "Growth", monthly: 149, annual: 1430, limit: "Up to $50,000 GMV/month" },
      { name: "Enterprise", monthly: 499, annual: 4790, limit: "Unlimited GMV" },
    ],
    bestFor: ["High-volume merchants", "Established businesses", "Predictable budgets"],
    pros: ["Predictable costs", "Better unit economics at scale", "Annual discount available"],
    cons: ["Fixed cost regardless of revenue", "Upfront commitment"],
    example: "Growth plan: $149/month → unlimited orders up to $50k GMV",
  },
  hybrid: {
    name: "Hybrid",
    tagline: "Best of both worlds",
    description: "Low base subscription fee plus a reduced profit-share rate. Ideal for growing merchants.",
    defaultRate: 1.5,
    baseMonthly: 29,
    bestFor: ["Mid-stage businesses", "Growing merchants", "Predictable + variable mix"],
    pros: ["Lower profit-share rate", "Reduced base fee", "Flexible scaling"],
    cons: ["Two cost components to track"],
    example: "On $10,000 GMV: $29 base + 1.5% ($150) = $179/month",
  },
};

export const BUSINESS_TYPES = [
  "Food & Beverage", "Fashion & Apparel", "Electronics", "Health & Beauty",
  "Home & Garden", "Sports & Outdoors", "Books & Education", "Services",
  "Agriculture", "Automotive", "Jewelry", "Toys & Games", "Other",
];

const STEP_ORDER = ["business_profile", "billing_model", "whatsapp_setup", "ai_config", "review", "completed"] as const;
type OnboardingStep = typeof STEP_ORDER[number];

export const onboardingRouter = router({
  getBillingPlans: protectedProcedure.query(() => BILLING_PLANS),
  getBusinessTypes: protectedProcedure.query(() => BUSINESS_TYPES),

  getProgress: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const [record] = await db
        .select()
        .from(tenantOnboarding)
        .where(eq(tenantOnboarding.tenantId, input.tenantId))
        .limit(1);
      return record ?? null;
    }),

  saveStep: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      step: z.enum(["business_profile", "billing_model", "whatsapp_setup", "ai_config", "review"]),
      data: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const existing = await db
        .select({ id: tenantOnboarding.id })
        .from(tenantOnboarding)
        .where(eq(tenantOnboarding.tenantId, input.tenantId))
        .limit(1);

      const currentIdx = STEP_ORDER.indexOf(input.step as OnboardingStep);
      const nextStep: OnboardingStep = STEP_ORDER[Math.min(currentIdx + 1, STEP_ORDER.length - 1)];

      const updateData = {
        currentStep: nextStep,
        updatedAt: new Date(),
        ...(input.data as Partial<TenantOnboarding>),
      };

      if (existing.length > 0) {
        await db.update(tenantOnboarding).set(updateData).where(eq(tenantOnboarding.tenantId, input.tenantId));
      } else {
        await db.insert(tenantOnboarding).values({
          id: randomUUID(),
          tenantId: input.tenantId,
          currentStep: nextStep,
          ...(input.data as Partial<TenantOnboarding>),
        });
      }
      return { ok: true, nextStep };
    }),

  complete: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      await db.update(tenantOnboarding)
        .set({ currentStep: "completed", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(tenantOnboarding.tenantId, input.tenantId));
      await db.update(tenants)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(tenants.id, input.tenantId));
      return { ok: true };
    }),

  listWithStatus: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const allTenants = await db.select().from(tenants).orderBy(tenants.createdAt);
    const onboardings: TenantOnboarding[] = await db.select().from(tenantOnboarding);
    const onboardingMap = new Map(onboardings.map(o => [o.tenantId, o]));
    return allTenants.map(tenant => ({
      ...tenant,
      onboarding: onboardingMap.get(tenant.id) ?? null,
      onboardingComplete: onboardingMap.get(tenant.id)?.currentStep === "completed",
    }));
  }),
  sendProgressEmail: adminProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, input.tenantId));
      if (!tenant) throw new Error("Tenant not found");
      const [onboardingRow] = await db.select().from(tenantOnboarding)
        .where(eq(tenantOnboarding.tenantId, input.tenantId));
      const step = onboardingRow?.currentStep ?? "not_started";
      console.log(`[Onboarding] Progress email sent to tenant ${tenant.name} (${input.tenantId}), step: ${step}`);
      return { ok: true, tenantName: tenant.name, step };
    }),

  // ─── Tenant provisioning pipeline ──────────────────────────────────────────
  // State machine: draft → configuring → validating → live | failed.
  // Provisioning (start) is platform-admin only; the remaining procedures are
  // tenant-scoped and guarded by assertTenantAccess.

  /** Provision a new tenant end-to-end with the seeded settings skeleton. */
  start: adminProcedure
    .input(
      z.object({
        name: z.string().trim().min(1, "name must not be empty").max(255),
        slug: z
          .string()
          .trim()
          .max(100)
          .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase alphanumeric with dashes")
          .optional(),
        plan: z.enum(["starter", "growth", "enterprise"]).optional(),
        businessType: z.string().trim().max(100).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { tenantId, slug, settings } = await createTenant(input);
      return {
        tenantId,
        slug,
        onboardingStatus: "draft" as const,
        waMenu: settings.waMenu,
      };
    }),

  /** Current onboarding state for a tenant. */
  getStatus: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const [tenant] = await db
        .select({
          id: tenants.id,
          name: tenants.name,
          status: tenants.status,
          whatsappPhoneNumberId: tenants.whatsappPhoneNumberId,
          settings: tenants.settings,
        })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);
      if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
      const state = getOnboardingState(tenant.settings);
      const settings = (tenant.settings ?? {}) as TenantSettings;
      return {
        tenantId: tenant.id,
        tenantStatus: tenant.status,
        ...state,
        whatsappConfigured: Boolean(
          tenant.whatsappPhoneNumberId && settings.whatsapp?.accessToken,
        ),
      };
    }),

  /**
   * Update one onboarding step: whatsapp creds / use-case selection /
   * integrations / branding. Moves status draft|failed → configuring.
   */
  updateStep: protectedProcedure
    .input(
      z.object({
        tenantId: z.string(),
        step: z.enum(["whatsapp", "useCases", "integrations", "branding"]),
        data: z.record(z.string(), z.unknown()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const [tenant] = await db
        .select({ id: tenants.id, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);
      if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
      const state = getOnboardingState(tenant.settings);
      if (state.status === "live") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Tenant is live — use tenantConfig APIs to change configuration",
        });
      }

      if (input.step === "whatsapp") {
        const creds = z
          .object({
            phoneNumberId: z.string().trim().min(1).max(64),
            accessToken: z.string().min(1, "accessToken must not be empty"),
          })
          .parse(input.data);
        await db
          .update(tenants)
          .set({ whatsappPhoneNumberId: creds.phoneNumberId, updatedAt: new Date() })
          .where(eq(tenants.id, input.tenantId));
        await updateTenantSettings(input.tenantId, (s) => {
          // Encrypt at rest (v1: envelope) — reads decrypt transparently.
          s.whatsapp = { ...(s.whatsapp ?? {}), accessToken: encryptSecret(creds.accessToken) };
        });
      } else if (input.step === "useCases") {
        const patch = z
          .object({
            greeting: z.string().min(1).max(500).optional(),
            useCases: z.array(waUseCaseSchema).optional(),
            customItems: z.array(waCustomItemSchema).max(20).optional(),
            fallback: z.enum(["nlp", "menu"]).optional(),
          })
          .parse(input.data);
        await updateTenantSettings(input.tenantId, (s) => {
          const merged = {
            ...(s.waMenu ?? {}),
            ...patch,
          };
          s.waMenu = parseWaMenuConfig(merged);
        });
      } else if (input.step === "integrations") {
        const patch = z
          .object({
            provider: z.enum(INTEGRATION_PROVIDERS),
            creds: integrationCredsSchema,
          })
          .parse(input.data);
        await updateTenantSettings(input.tenantId, (s) => {
          // apiKey is a secret — encrypt at rest; reads decrypt transparently.
          const creds = {
            ...patch.creds,
            ...(patch.creds.apiKey ? { apiKey: encryptSecret(patch.creds.apiKey) } : {}),
          };
          s.integrations = { ...(s.integrations ?? {}), [patch.provider]: creds };
        });
      } else {
        // branding
        const branding = brandingConfigSchema.parse(input.data);
        await updateTenantSettings(input.tenantId, (s) => {
          s.branding = branding;
        });
      }

      const completedSteps = Array.from(new Set([...state.completedSteps, input.step]));
      const next = await setOnboardingStatus(input.tenantId, "configuring", {
        completedSteps,
        validationPassed: false,
      });
      return { ok: true, ...next };
    }),

  /**
   * Run live validation: WhatsApp Graph GET /{phoneNumberId} with token must
   * return 200, plus a test-connection call per enabled integration.
   * Passed → status stays 'validating' with validationPassed=true;
   * failed → status 'failed' with reasons.
   */
  validate: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const [tenant] = await db
        .select({
          id: tenants.id,
          whatsappPhoneNumberId: tenants.whatsappPhoneNumberId,
          whatsappBusinessAccountId: tenants.whatsappBusinessAccountId,
          settings: tenants.settings,
        })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);
      if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });

      await setOnboardingStatus(input.tenantId, "validating");
      const report = await runTenantValidation(tenant);

      if (report.passed) {
        const state = await setOnboardingStatus(input.tenantId, "validating", {
          validationPassed: true,
          validatedAt: new Date().toISOString(),
          reasons: [],
        });
        return { passed: true, checks: report.checks, ...state };
      }
      const state = await setOnboardingStatus(input.tenantId, "failed", {
        reasons: validationFailureReasons(report),
        validationPassed: false,
      });
      return { passed: false, checks: report.checks, ...state };
    }),

  /** Activate (go live) — only after validation has passed. */
  activate: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const [tenant] = await db
        .select({ id: tenants.id, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);
      if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
      const state = getOnboardingState(tenant.settings);
      if (state.status === "live") return { ok: true, ...state };
      if (state.status !== "validating" || !state.validationPassed) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Cannot activate: validation has not passed (status=${state.status}). Run onboarding.validate first.`,
        });
      }
      const next = await setOnboardingStatus(input.tenantId, "live");
      await db
        .update(tenants)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(tenants.id, input.tenantId));
      return { ok: true, ...next };
    }),

  /** Re-run validation after fixing failures (only from failed/validating). */
  retryValidation: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const [tenant] = await db
        .select({ id: tenants.id, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);
      if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
      const state = getOnboardingState(tenant.settings);
      if (state.status !== "failed" && state.status !== "validating") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `retryValidation only applies from failed/validating (current=${state.status})`,
        });
      }
      // Back to configuring so the operator's fixes flow through validate again.
      const next = await setOnboardingStatus(input.tenantId, "configuring", {
        validationPassed: false,
        reasons: [],
      });
      return { ok: true, ...next };
    }),
});
