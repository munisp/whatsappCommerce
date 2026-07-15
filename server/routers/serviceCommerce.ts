import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { router, protectedProcedure, publicProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { serviceCatalog, appointments, digitalProducts, digitalProductPurchases, subscriptions } from "../../drizzle/schema";
import { randomUUID } from "crypto";

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
    .mutation(async ({ input }) => {
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
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds = [eq(appointments.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(appointments.status, input.status as "scheduled" | "confirmed" | "completed" | "cancelled" | "no_show"));
      return db.select().from(appointments).where(and(...conds)).orderBy(desc(appointments.scheduledAt)).limit(input.limit);
    }),

  updateAppointmentStatus: protectedProcedure
    .input(z.object({ id: z.string(), status: z.enum(["confirmed", "completed", "cancelled", "no_show"]) }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
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
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const id = randomUUID();
      const downloadToken = randomUUID().replace(/-/g, "");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await db.insert(digitalProductPurchases).values({
        id, ...input, downloadToken, downloadsUsed: 0, expiresAt, createdAt: new Date(),
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
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const id = randomUUID();
      const now = new Date();
      const periodEnd = new Date(now);
      if (input.billingCycle === "monthly") periodEnd.setMonth(periodEnd.getMonth() + 1);
      else if (input.billingCycle === "annual") periodEnd.setFullYear(periodEnd.getFullYear() + 1);
      else periodEnd.setDate(periodEnd.getDate() + 7);
      await db.insert(subscriptions).values({
        id, ...input, status: "active", currentPeriodStart: now, currentPeriodEnd: periodEnd, createdAt: now, updatedAt: now,
      });
      return { id, status: "active", currentPeriodEnd: periodEnd };
    }),

  listSubscriptions: protectedProcedure
    .input(z.object({ tenantId: z.string(), status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds = [eq(subscriptions.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(subscriptions.status, input.status as "active" | "paused" | "cancelled" | "expired" | "trial"));
      return db.select().from(subscriptions).where(and(...conds)).orderBy(desc(subscriptions.createdAt)).limit(input.limit);
    }),

  cancelSubscription: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      await db.update(subscriptions).set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() }).where(eq(subscriptions.id, input.id));
      return { ok: true };
    }),
});
