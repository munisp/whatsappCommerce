/**
 * server/routers/temporal.ts — Temporal workflow management tRPC router
 *
 * Provides procedures to:
 *   - Start workflows (delegates to server/temporal.ts)
 *   - Record workflow runs in the DB
 *   - Query workflow status
 *   - List recent workflow runs
 *   - Update workflow status from callbacks
 */
import { z } from "zod";
import { router, adminProcedure, protectedProcedure, publicProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { temporalWorkflowRuns } from "../../drizzle/schema";
import {
  startTenantOnboardingWorkflow,
  startOrderFulfillmentWorkflow,
  startBroadcastCampaignWorkflow,
  startInventorySyncWorkflow,
} from "../temporal";
import { eq, desc, and, gte } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

// Re-export temporal functions for use in other routers
export {
  startTenantOnboardingWorkflow,
  startOrderFulfillmentWorkflow,
  startBroadcastCampaignWorkflow,
  startInventorySyncWorkflow,
};

export const temporalRouter = router({
  // ── Start a generic workflow ────────────────────────────────────────────────
  startWorkflow: adminProcedure
    .input(z.object({
      workflowType: z.string(),
      workflowId: z.string().optional(),
      input: z.record(z.string(), z.unknown()),
      tenantId: z.string().optional(),
      entityId: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const { startWorkflow } = await import("../temporal");
      return startWorkflow(input.workflowType, input.input as Record<string, unknown>, {
        workflowId: input.workflowId,
        tenantId: input.tenantId,
        entityId: input.entityId,
      });
    }),

  // ── Record a workflow run (called by Go services) ───────────────────────────
  recordRun: publicProcedure
    .input(z.object({
      workflowId: z.string(),
      runId: z.string(),
      workflowType: z.string(),
      tenantId: z.string().optional(),
      entityId: z.string().optional(),
      status: z.enum(["running", "completed", "failed", "cancelled", "timed_out", "terminated"]).default("running"),
      input: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await db.insert(temporalWorkflowRuns).values({
        workflowId: input.workflowId,
        runId: input.runId,
        workflowType: input.workflowType,
        taskQueue: "whatsapp-commerce",
        tenantId: input.tenantId,
        entityId: input.entityId,
        status: input.status,
        input: input.input,
        startedAt: new Date(),
      }).onConflictDoNothing();
      return { recorded: true, runId: input.runId };
    }),

  // ── Update workflow status ──────────────────────────────────────────────────
  updateStatus: publicProcedure
    .input(z.object({
      runId: z.string(),
      status: z.enum(["completed", "failed", "cancelled", "timed_out", "terminated"]),
      result: z.record(z.string(), z.unknown()).optional(),
      errorMessage: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const { updateWorkflowStatus } = await import("../temporal");
      await updateWorkflowStatus(input.runId, input.status, input.result, input.errorMessage);
      return { updated: true };
    }),

  // ── Query workflow status ───────────────────────────────────────────────────
  getStatus: protectedProcedure
    .input(z.object({ workflowId: z.string() }))
    .query(async ({ input }) => {
      const { queryWorkflowStatus } = await import("../temporal");
      return queryWorkflowStatus(input.workflowId);
    }),

  // ── List recent workflow runs ───────────────────────────────────────────────
  listRuns: adminProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      workflowType: z.string().optional(),
      status: z.enum(["running", "completed", "failed", "cancelled", "timed_out", "terminated"]).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      sinceHours: z.number().int().min(1).max(720).default(24),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { runs: [], total: 0 };
      const since = new Date(Date.now() - input.sinceHours * 3600 * 1000);
      const conditions = [gte(temporalWorkflowRuns.startedAt, since)];
      if (input.tenantId) conditions.push(eq(temporalWorkflowRuns.tenantId, input.tenantId));
      if (input.workflowType) conditions.push(eq(temporalWorkflowRuns.workflowType, input.workflowType));
      if (input.status) conditions.push(eq(temporalWorkflowRuns.status, input.status));
      const runs = await db
        .select()
        .from(temporalWorkflowRuns)
        .where(and(...conditions))
        .orderBy(desc(temporalWorkflowRuns.startedAt))
        .limit(input.limit);
      return { runs, total: runs.length };
    }),

  // ── Get a specific run ──────────────────────────────────────────────────────
  getRun: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [run] = await db
        .select()
        .from(temporalWorkflowRuns)
        .where(eq(temporalWorkflowRuns.runId, input.runId))
        .limit(1);
      if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "Workflow run not found" });
      return run;
    }),

  // ── Health check ────────────────────────────────────────────────────────────
  health: publicProcedure.query(async () => {
    const { temporalHealthCheck } = await import("../temporal");
    return temporalHealthCheck();
  }),

  // ── Start specific workflow types ───────────────────────────────────────────
  startOnboarding: adminProcedure
    .input(z.object({
      tenantId: z.string(),
      applicantEmail: z.string().email(),
      billingModel: z.enum(["profit_sharing", "subscription", "hybrid"]),
      kycApplicationId: z.string(),
    }))
    .mutation(async ({ input }) => {
      return startTenantOnboardingWorkflow(input);
    }),

  startOrderFulfillment: protectedProcedure
    .input(z.object({
      orderId: z.string(),
      tenantId: z.string(),
      customerId: z.string(),
      items: z.array(z.object({
        productId: z.string(),
        quantity: z.number().int().positive(),
        price: z.number().positive(),
      })),
      totalAmount: z.number().positive(),
      waPhoneNumber: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return startOrderFulfillmentWorkflow(input);
    }),

  startBroadcast: protectedProcedure
    .input(z.object({
      campaignId: z.string(),
      tenantId: z.string(),
      templateId: z.string(),
      recipientCount: z.number().int().positive(),
      batchSize: z.number().int().positive().default(50),
      scheduledAt: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return startBroadcastCampaignWorkflow(input);
    }),

  startInventorySync: protectedProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      odooUrl: z.string().url(),
      odooDb: z.string(),
    }))
    .mutation(async ({ input }) => {
      return startInventorySyncWorkflow(input);
    }),
});
