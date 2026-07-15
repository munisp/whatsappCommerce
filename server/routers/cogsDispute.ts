import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { cogsDisputeRequests, tenants } from "../../drizzle/schema";
import { eq, desc, and } from "drizzle-orm";
import { notifyOwner } from "../_core/notification";

export const cogsDisputeRouter = router({
  // Submit a COGS rate review request
  submit: protectedProcedure
    .input(z.object({
      tenantId: z.string().uuid(),
      requestedCogsRate: z.number().min(0.01).max(0.95),
      justification: z.string().min(10).max(1000),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      // Get current COGS rate
      const [tenant] = await db.select({ cogsRate: tenants.cogsRate, name: tenants.name })
        .from(tenants).where(eq(tenants.id, input.tenantId));
      if (!tenant) throw new Error("Tenant not found");

      const [dispute] = await db.insert(cogsDisputeRequests).values({
        tenantId: input.tenantId,
        currentCogsRate: String(tenant.cogsRate ?? 0.40),
        requestedCogsRate: String(input.requestedCogsRate),
        justification: input.justification,
        status: "pending",
      }).returning();

      // Notify platform owner
      try {
        await notifyOwner({
          title: "COGS Rate Review Request",
          content: `Tenant "${tenant.name}" has requested a COGS rate change from ${((tenant.cogsRate ?? 0.40) * 100).toFixed(0)}% → ${(input.requestedCogsRate * 100).toFixed(0)}%.\n\nJustification: ${input.justification}\n\nReview at /cogs-disputes in the admin portal.`,
        });
      } catch (_) { /* notification failure is non-blocking */ }

      return dispute;
    }),

  // List all disputes (admin)
  list: protectedProcedure
    .input(z.object({ status: z.enum(["pending", "approved", "rejected", "all"]).default("all") }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const rows = await db
        .select({
          id: cogsDisputeRequests.id,
          tenantId: cogsDisputeRequests.tenantId,
          tenantName: tenants.name,
          currentCogsRate: cogsDisputeRequests.currentCogsRate,
          requestedCogsRate: cogsDisputeRequests.requestedCogsRate,
          justification: cogsDisputeRequests.justification,
          status: cogsDisputeRequests.status,
          reviewedBy: cogsDisputeRequests.reviewedBy,
          reviewNote: cogsDisputeRequests.reviewNote,
          reviewedAt: cogsDisputeRequests.reviewedAt,
          createdAt: cogsDisputeRequests.createdAt,
        })
        .from(cogsDisputeRequests)
        .leftJoin(tenants, eq(cogsDisputeRequests.tenantId, tenants.id))
        .where(input.status !== "all" ? eq(cogsDisputeRequests.status, input.status) : undefined)
        .orderBy(desc(cogsDisputeRequests.createdAt));
      return rows;
    }),

  // Approve or reject a dispute (admin)
  review: protectedProcedure
    .input(z.object({
      disputeId: z.string().uuid(),
      action: z.enum(["approved", "rejected"]),
      reviewNote: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      const [dispute] = await db.select().from(cogsDisputeRequests)
        .where(eq(cogsDisputeRequests.id, input.disputeId));
      if (!dispute) throw new Error("Dispute not found");

      await db.update(cogsDisputeRequests)
        .set({
          status: input.action,
          reviewedBy: ctx.user?.name ?? "admin",
          reviewNote: input.reviewNote,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(cogsDisputeRequests.id, input.disputeId));

      // If approved, update the tenant's COGS rate
      if (input.action === "approved") {
        await db.update(tenants)
          .set({ cogsRate: parseFloat(dispute.requestedCogsRate), updatedAt: new Date() })
          .where(eq(tenants.id, dispute.tenantId));
      }

      return { success: true };
    }),

  // Get disputes for a specific tenant
  getForTenant: protectedProcedure
    .input(z.object({ tenantId: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(cogsDisputeRequests)
        .where(eq(cogsDisputeRequests.tenantId, input.tenantId))
        .orderBy(desc(cogsDisputeRequests.createdAt));
    }),
});
