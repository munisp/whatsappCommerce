import { z } from "zod";
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { tenantOnboarding, tenants } from "../../drizzle/schema";
import type { TenantOnboarding } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

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
});
