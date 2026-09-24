import { z } from "zod";
import { router, protectedProcedure, adminProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { tenantOnboarding, tenants, tenantMemberships, users } from "../../drizzle/schema";
import type { TenantOnboarding } from "../../drizzle/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
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
import { requireApprovedKyb } from "../services/kycGate";
import { startTenantOnboardingWorkflow } from "../temporal";
// === W47 merchant ===
import {
  goLiveTenant,
  isPayoutConfigured,
  setInitialPayoutBank,
} from "../services/onboardingLifecycle";
import { findWhatsAppNumberConflict } from "../services/whatsappNumbers";
// === END W47 merchant ===

/** plan → billing model for the TenantOnboardingWorkflow input. */
const PLAN_BILLING_MODEL = {
  starter: "profit_sharing",
  growth: "subscription",
  enterprise: "hybrid",
} as const;

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
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return null;
      const [record] = await db
        .select()
        .from(tenantOnboarding)
        .where(eq(tenantOnboarding.tenantId, input.tenantId))
        .limit(1);
      // === W47 merchant === ONB-M-7: three divergent trackers meant
      // getProgress/getStatus/funnel each reported a different truth. The
      // canonical state is settings.onboarding (the one activate enforces);
      // legacy tenant_onboarding rows are still returned for back-compat
      // but the response now carries the canonical state so callers can
      // converge on it.
      const [tenant] = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);
      const canonical = getOnboardingState(tenant?.settings);
      return { ...(record ?? null as any), canonical };
      // === END W47 merchant ===
    }),

  saveStep: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      step: z.enum(["business_profile", "billing_model", "whatsapp_setup", "ai_config", "review"]),
      data: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const existing = await db
        .select({ id: tenantOnboarding.id })
        .from(tenantOnboarding)
        .where(eq(tenantOnboarding.tenantId, input.tenantId))
        .limit(1);

      const currentIdx = STEP_ORDER.indexOf(input.step as OnboardingStep);
      const nextStep: OnboardingStep = STEP_ORDER[Math.min(currentIdx + 1, STEP_ORDER.length - 1)];

      // === W47 merchant === ONB-M-17: whitelist the writable columns per
      // step. The previous `...(input.data)` spread allowed mass assignment
      // (a client could overwrite currentStep — even jump straight to
      // "completed" — or set arbitrary columns).
      const data = input.data as Record<string, unknown>;
      const allowedKeys = [
        "billingModel", "profitShareRate", "subscriptionFee", "subscriptionCycle",
        "minMonthlyFee", "maxProfitShareRate", "businessType", "businessDescription",
        "businessCountry", "businessCurrency", "estimatedMonthlyGmv",
        "estimatedMonthlyOrders", "whatsappVerified", "aiConfigured", "onboardingNotes",
      ] as const;
      const whitelisted: Record<string, unknown> = {};
      for (const k of allowedKeys) {
        if (k in data) whitelisted[k] = data[k];
      }
      // === END W47 merchant ===

      const updateData = {
        currentStep: nextStep,
        updatedAt: new Date(),
        ...(whitelisted as Partial<TenantOnboarding>),
      };

      if (existing.length > 0) {
        await db.update(tenantOnboarding).set(updateData).where(eq(tenantOnboarding.tenantId, input.tenantId));
      } else {
        await db.insert(tenantOnboarding).values({
          id: randomUUID(),
          tenantId: input.tenantId,
          currentStep: nextStep,
          ...(whitelisted as Partial<TenantOnboarding>),
        });
      }
      return { ok: true, nextStep };
    }),

  complete: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      // === W47 merchant === ONB-M-1: the legacy wizard previously flipped
      // tenants.status to 'active' with NO validation and NO KYB gate — a
      // live, callable go-live bypass. Route through the SAME goLiveTenant
      // gate (validation passed + approved KYB) the web activate and the
      // chat copilot use. The tenant_onboarding row is only marked
      // completed after the gate succeeds.
      await goLiveTenant(input.tenantId, {
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        source: "legacy-complete",
      });
      // === END W47 merchant ===
      await db.update(tenantOnboarding)
        .set({ currentStep: "completed", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(tenantOnboarding.tenantId, input.tenantId));
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
      // === W47 merchant === ONB-M-18: actually SEND the progress email
      // (previously console.log only) to the tenant owner's account email.
      // Best-effort: email delivery failure never fails the mutation.
      let emailed = false;
      try {
        const [owner] = await db
          .select({ email: users.email, name: users.name })
          .from(users)
          .where(eq(users.tenantId, input.tenantId))
          .limit(1);
        if (owner?.email) {
          const { sendEmail } = await import("../services/email/resend");
          emailed = await sendEmail({
            to: owner.email,
            subject: `Finish setting up ${tenant.name} — you're at step: ${step}`,
            html: `<p>Hi${owner.name ? ` ${owner.name}` : ""},</p><p>Your store <b>${tenant.name}</b> is not live yet — onboarding is at step <b>${step}</b>. Sign in to your portal to finish setup and start accepting orders.</p>`,
            text: `Your store ${tenant.name} is not live yet — onboarding is at step ${step}. Sign in to finish setup.`,
          });
        }
      } catch (e: any) {
        console.warn("[Onboarding] progress email send failed:", e?.message);
      }
      console.log(`[Onboarding] Progress email for tenant ${tenant.name} (${input.tenantId}), step: ${step}, emailed=${emailed}`);
      return { ok: true, tenantName: tenant.name, step, emailed };
      // === END W47 merchant ===
    }),

  // ─── Tenant provisioning pipeline ──────────────────────────────────────────
  // State machine: draft → configuring → validating → live | failed.
  // Provisioning (start) is self-service: any authenticated user may create a
  // tenant and becomes its super_admin. Platform admins may still provision a
  // tenant on a business's behalf; doing so does not enroll them as a member
  // or touch their (tenant-agnostic) users.tenantId. The remaining procedures
  // are tenant-scoped and guarded by assertTenantAccess.

  /**
   * Provision a new tenant end-to-end with the seeded settings skeleton.
   * A non-platform-admin creator becomes the tenant's super_admin
   * (tenant_memberships) and the new tenant becomes their active tenant
   * (users.tenantId) — a Super Admin may own multiple tenants; switch
   * between them via tenantMembers.switchTenant.
   */
  start: protectedProcedure
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
        // === W47 merchant === ONB-M-16: capture the merchant's verified
        // phone at provisioning so settings.adminPhone is stamped (tenant
        // invites bind to it; admin alerts resolve it).
        phone: z.string().trim().min(7).max(30).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Guard against re-entry: without this, calling start() again (double
      // submit, stale tab, browser back+resubmit) silently creates a SECOND
      // tenant and overwrites users.tenantId, stranding the caller's access
      // to their original tenant's self-service dashboard (tenantPortal.*
      // resolves the tenant from this single column, not tenant_memberships).
      if (ctx.user.role !== "admin" && ctx.user.tenantId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "You already have a business on this platform. Use the dashboard for your existing business, or contact support to set up an additional one.",
        });
      }
      // === W47 merchant (ONB-M-9) + crosscutting (ONB-SM-3): claim-first AND
      // single-transaction provisioning. Two concurrent start() calls both
      // passed the check above; claim the caller's tenantId slot FIRST with a
      // guarded UPDATE — exactly one concurrent caller wins; the loser gets an
      // honest CONFLICT. Tenant + owner membership + user link then commit in
      // ONE transaction so a crash cannot orphan a memberless tenant. ===
      let claimedTenantSlot = false;
      const db0 = await getDb();
      if (!db0) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      if (ctx.user.role !== "admin") {
        const claimed = await db0
          .update(users)
          .set({ tenantId: "__claiming__", updatedAt: new Date() })
          .where(and(eq(users.id, ctx.user.id), isNull(users.tenantId)))
          .returning({ id: users.id });
        if (!claimed.length) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "You already have a business on this platform. Use the dashboard for your existing business, or contact support to set up an additional one.",
          });
        }
        claimedTenantSlot = true;
      }
      let tenantId: string;
      let slug: string;
      let settings: Awaited<ReturnType<typeof createTenant>>["settings"];
      try {
        const provision = async (tx: any) => {
          const created = await createTenant(input, tx);
          // Self-service: the creating user becomes the tenant's owner (unless
          // they're a platform admin provisioning on a business's behalf, whose
          // tenant-agnostic identity/users.tenantId must stay untouched).
          if (ctx.user.role !== "admin") {
            await tx.insert(tenantMemberships).values({
              tenantId: created.tenantId,
              userId: String(ctx.user.id),
              role: "owner",
              invitedBy: String(ctx.user.id),
            });
            await tx.update(users).set({ tenantId: created.tenantId })
              .where(and(eq(users.id, ctx.user.id), eq(users.tenantId, "__claiming__")));
          }
          return created;
        };
        // Test doubles / drivers without transactions fall back to sequential
        // execution (real drivers always run the atomic path above).
        ({ tenantId, slug, settings } = typeof db0.transaction === "function"
          ? await db0.transaction(async (tx: any) => provision(tx))
          : await provision(db0));
        claimedTenantSlot = false;
        // === W47 merchant === ONB-M-16: stamp settings.adminPhone.
        const adminPhone = input.phone ?? (ctx.user.phoneVerified ? ctx.user.phone : null);
        if (adminPhone) {
          await updateTenantSettings(tenantId, (s) => {
            if (!s.adminPhone) (s as Record<string, unknown>).adminPhone = adminPhone;
          });
        }
        // === END W47 merchant ===
      } catch (err) {
        // Roll back the atomic slot claim so a failed provisioning does not
        // permanently block the user from retrying.
        if (claimedTenantSlot) {
          await db0.update(users).set({ tenantId: null })
            .where(and(eq(users.id, ctx.user.id), eq(users.tenantId, "__claiming__")))
            .catch(() => {});
        }
        throw err;
      }
      // === END W47 merchant (ONB-M-9) / crosscutting (ONB-SM-3) ===

      // Kick off the TenantOnboardingWorkflow when Temporal is configured
      // (env-gated; graceful skip otherwise — provisioning must succeed
      // regardless of Temporal availability).
      if (process.env.TEMPORAL_ADDRESS) {
        try {
          await startTenantOnboardingWorkflow({
            tenantId,
            applicantEmail: ctx.user?.email ?? "",
            billingModel: PLAN_BILLING_MODEL[input.plan ?? "starter"],
            // no KYB application exists at provisioning time
          });
        } catch (err: any) {
          console.warn("[onboarding.start] Temporal workflow start failed (continuing):", err?.message);
        }
      }

      // (W47 ONB-M-9 + ONB-SM-3: owner membership + users.tenantId assignment
      // moved BEFORE this block, inside the claim-first provisioning
      // transaction above. Platform admins provisioning on a business's
      // behalf keep their tenant-agnostic identity/users.tenantId untouched.)

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
        // === W47 merchant === ONB-M-14/M-7: readiness truth — payout
        // destination + canonical tracker marker so the dashboard/wizard
        // all read ONE state.
        payoutConfigured: await isPayoutConfigured(db, input.tenantId),
        canonicalProgress: true as const,
        // === END W47 merchant ===
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
        step: z.enum(["whatsapp", "useCases", "integrations", "branding", "payout"]),
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
            // === W47 merchant === ONB-M-6: accept wabaId/verifyToken like
            // the operator path (tenant.updateWhatsAppConfig) so the
            // self-serve wizard collects the same configuration.
            wabaId: z.string().trim().max(64).optional(),
            verifyToken: z.string().max(255).optional(),
          })
          .parse(input.data);
        // === W47 merchant === ONB-M-6: the same honest CONFLICT pre-check
        // as tenant.updateWhatsAppConfig — previously a duplicate
        // phone_number_id here surfaced as a raw 23505 (or silently
        // hijacked another tenant's inbound webhook traffic).
        const conflictId = await findWhatsAppNumberConflict(creds.phoneNumberId, input.tenantId);
        if (conflictId) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "That WhatsApp phone number is already connected to another business on this platform.",
          });
        }
        // === END W47 merchant ===
        // try/catch retained as a race-condition backstop: the pre-check
        // above and this update are not atomic, so a concurrent onboarding
        // request for the same phoneNumberId can still slip through the
        // check and hit the DB's unique constraint.
        try {
          await db
            .update(tenants)
            .set({ whatsappPhoneNumberId: creds.phoneNumberId, updatedAt: new Date() })
            .where(eq(tenants.id, input.tenantId));
        } catch (error: unknown) {
          const code = (error as { code?: string; cause?: { code?: string } })?.code
            ?? (error as { cause?: { code?: string } })?.cause?.code;
          if (code === "23505") {
            throw new TRPCError({
              code: "CONFLICT",
              message: "That WhatsApp phone number is already connected to another business on this platform.",
            });
          }
          throw error;
        }
        await updateTenantSettings(input.tenantId, (s) => {
          // Encrypt at rest (v1: envelope) — reads decrypt transparently.
          s.whatsapp = {
            ...(s.whatsapp ?? {}),
            accessToken: encryptSecret(creds.accessToken),
            ...(creds.wabaId ? { wabaId: creds.wabaId } : {}),
            ...(creds.verifyToken ? { verifyToken: encryptSecret(creds.verifyToken) } : {}),
          } as TenantSettings["whatsapp"];
        });
      } else if (input.step === "payout") {
        // === W47 merchant === ONB-M-14: initial payout-destination capture
        // during onboarding (first withdrawal previously failed late on a
        // null bank account). Only the FIRST capture is allowed here —
        // changes go through escrow.updatePayoutBankDetails (step-up OTP).
        const payout = z
          .object({
            bankAccountName: z.string().trim().min(1).max(255),
            bankAccountNumber: z.string().trim().min(6).max(20),
            bankCode: z.string().trim().min(1).max(10),
          })
          .parse(input.data);
        await setInitialPayoutBank(input.tenantId, payout);
        // === END W47 merchant ===
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
      // === W47 merchant === ONB-M-1/M-2: all go-live paths (web activate,
      // legacy complete, chat copilot) funnel through the single
      // goLiveTenant gate — validation-passed + approved KYB, audited.
      const next = await goLiveTenant(input.tenantId, {
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        source: "web-activate",
      });
      // === END W47 merchant ===
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
