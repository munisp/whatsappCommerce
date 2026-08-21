import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { router, protectedProcedure, publicProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { serviceCatalog, appointments, digitalProducts, digitalProductPurchases, subscriptions } from "../../drizzle/schema";
import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import { hasVerifiedPayment } from "../services/payments/verifyProviderStatus";

export const serviceCommerceRouter = router({
  // ── Service Catalog ──────────────────────────────────────────────────────
  listServices: publicProcedure
    .input(z.object({ tenantId: z.string(), serviceType: z.string().optional(), isActive: z.boolean().optional() }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds = [eq(serviceCatalog.tenantId, input.tenantId)];
      if (input.serviceType) conds.push(eq(serviceCatalog.serviceType, input.serviceType as "appointment" | "digital" | "subscription" | "physical"));
      if (input.isActive !== undefined) conds.push(eq(serviceCatalog.isActive, input.isActive));
      return db.select().from(serviceCatalog).where(and(...conds)).orderBy(serviceCatalog.name);
    }),

  createService: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      name: z.string().min(2),
      description: z.string().optional(),
      serviceType: z.enum(["appointment", "digital", "subscription", "physical"]),
      price: z.string(),
      currency: z.string().default("NGN"),
      duration: z.number().int().optional(),
      maxBookingsPerSlot: z.number().int().default(1),
      availableSlots: z.array(z.unknown()).optional(),
      downloadUrl: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const id = randomUUID();
      const now = new Date();
      await db.insert(serviceCatalog).values({ id, ...input, isActive: true, createdAt: now, updatedAt: now });
      return { id };
    }),

  // ── Appointments ─────────────────────────────────────────────────────────
  bookAppointment: publicProcedure
    .input(z.object({
      serviceId: z.string(),
      tenantId: z.string(),
      customerPhone: z.string(),
      customerName: z.string().optional(),
      scheduledAt: z.string(),
      durationMinutes: z.number().int().default(60),
      notes: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const id = randomUUID();
      const now = new Date();
      await db.insert(appointments).values({
        id, ...input, scheduledAt: new Date(input.scheduledAt),
        status: "scheduled", reminderSent: false, paymentStatus: "unpaid", createdAt: now, updatedAt: now,
      });
      return { id, status: "scheduled" };
    }),

  listAppointments: protectedProcedure
    .input(z.object({ tenantId: z.string(), status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const conds = [eq(appointments.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(appointments.status, input.status as "scheduled" | "confirmed" | "completed" | "cancelled" | "no_show"));
      return db.select().from(appointments).where(and(...conds)).orderBy(desc(appointments.scheduledAt)).limit(input.limit);
    }),

  updateAppointmentStatus: protectedProcedure
    .input(z.object({ id: z.string(), status: z.enum(["confirmed", "completed", "cancelled", "no_show"]) }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      const [appt] = await db.select().from(appointments).where(eq(appointments.id, input.id)).limit(1);
      if (!appt) throw new TRPCError({ code: "NOT_FOUND", message: "Appointment not found" });
      assertTenantAccess(ctx.user, appt.tenantId);
      await db.update(appointments).set({ status: input.status, updatedAt: new Date() }).where(eq(appointments.id, input.id));
      return { ok: true };
    }),

  // ── Digital Products ─────────────────────────────────────────────────────
  listDigitalProducts: publicProcedure
    .input(z.object({ tenantId: z.string(), isActive: z.boolean().optional() }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds = [eq(digitalProducts.tenantId, input.tenantId)];
      if (input.isActive !== undefined) conds.push(eq(digitalProducts.isActive, input.isActive));
      return db.select().from(digitalProducts).where(and(...conds));
    }),

  purchaseDigitalProduct: publicProcedure
    .input(z.object({
      productId: z.string(),
      tenantId: z.string(),
      customerPhone: z.string(),
      // Wave 26 audit F3: a download grant REQUIRES a verified payment —
      // either a locally confirmed payment record or a live provider
      // fetchStatus success, matching the product price in exact minor units.
      paymentReference: z.string().min(1),
      provider: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const [product] = await db.select().from(digitalProducts)
        .where(and(eq(digitalProducts.id, input.productId), eq(digitalProducts.tenantId, input.tenantId)))
        .limit(1);
      if (!product || !product.isActive) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Digital product not found" });
      }
      const priceCents = Math.round(parseFloat(product.price) * 100);
      if (priceCents > 0) {
        const pay = await hasVerifiedPayment(db, {
          tenantId: input.tenantId,
          reference: input.paymentReference,
          provider: input.provider,
          expectedAmountCents: priceCents,
        });
        if (!pay.verified) {
          console.warn(`[serviceCommerce] digital purchase REJECTED (unverified payment ${input.paymentReference}, ${pay.detail ?? "no detail"})`);
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Payment not verified — complete payment before downloading",
          });
        }
      }
      const id = randomUUID();
      const downloadToken = randomUUID().replace(/-/g, "");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await db.insert(digitalProductPurchases).values({
        id,
        productId: input.productId,
        tenantId: input.tenantId,
        customerPhone: input.customerPhone,
        downloadToken, downloadsUsed: 0, expiresAt, createdAt: new Date(),
      });
      return { id, downloadToken, expiresAt };
    }),

  // ── Subscriptions ────────────────────────────────────────────────────────
  createSubscription: publicProcedure
    .input(z.object({
      serviceId: z.string(),
      tenantId: z.string(),
      customerPhone: z.string(),
      customerName: z.string().optional(),
      billingCycle: z.enum(["monthly", "annual", "weekly"]).default("monthly"),
      amount: z.string(),
      currency: z.string().default("NGN"),
      // Wave 26 audit F3: activating a subscription REQUIRES a verified
      // first payment (confirmed record or live provider fetchStatus) whose
      // amount matches the subscription amount in exact minor units.
      paymentReference: z.string().min(1),
      provider: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const amountCents = Math.round(parseFloat(input.amount) * 100);
      if (Number.isFinite(amountCents) && amountCents > 0) {
        const pay = await hasVerifiedPayment(db, {
          tenantId: input.tenantId,
          reference: input.paymentReference,
          provider: input.provider,
          expectedAmountCents: amountCents,
        });
        if (!pay.verified) {
          console.warn(`[serviceCommerce] subscription REJECTED (unverified payment ${input.paymentReference}, ${pay.detail ?? "no detail"})`);
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Payment not verified — complete payment before activating a subscription",
          });
        }
      }
      const id = randomUUID();
      const now = new Date();
      const periodEnd = new Date(now);
      if (input.billingCycle === "monthly") periodEnd.setMonth(periodEnd.getMonth() + 1);
      else if (input.billingCycle === "annual") periodEnd.setFullYear(periodEnd.getFullYear() + 1);
      else periodEnd.setDate(periodEnd.getDate() + 7);
      await db.insert(subscriptions).values({
        id,
        serviceId: input.serviceId,
        tenantId: input.tenantId,
        customerPhone: input.customerPhone,
        customerName: input.customerName,
        billingCycle: input.billingCycle,
        amount: input.amount,
        currency: input.currency,
        status: "active", currentPeriodStart: now, currentPeriodEnd: periodEnd, createdAt: now, updatedAt: now,
      });
      return { id, status: "active", currentPeriodEnd: periodEnd };
    }),

  listSubscriptions: protectedProcedure
    .input(z.object({ tenantId: z.string(), status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const conds = [eq(subscriptions.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(subscriptions.status, input.status as "active" | "paused" | "cancelled" | "expired" | "trial"));
      return db.select().from(subscriptions).where(and(...conds)).orderBy(desc(subscriptions.createdAt)).limit(input.limit);
    }),

  cancelSubscription: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, input.id)).limit(1);
      if (!sub) throw new TRPCError({ code: "NOT_FOUND", message: "Subscription not found" });
      assertTenantAccess(ctx.user, sub.tenantId);
      await db.update(subscriptions).set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() }).where(eq(subscriptions.id, input.id));
      return { ok: true };
    }),
});
