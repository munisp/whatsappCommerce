/**
 * journeys.ts — tenant-facing broadcast journey CRUD + enrollment (W17 F8).
 *
 * Definitions are validated on save (see validateJourneySteps). Execution is
 * performed by runDueJourneySteps (server/services/journeyBuilder.ts) via the
 * /api/scheduled/journey-tick cron wiring.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { broadcastJourneyRuns, broadcastJourneys } from "../../drizzle/schema";
import {
  MAX_JOURNEY_STEPS,
  MAX_WAIT_MINUTES,
  validateJourneySteps,
  type JourneyStep,
} from "../services/journeyBuilder";
import { nextAllowedSendAtForTenant } from "../services/frequencyCap";
import { normalizeWaPhone } from "../services/waSender";
import { customers } from "../../drizzle/schema";

const conditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("has_tag"), tag: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("last_order_within_days"), days: z.number().int().min(1).max(3650) }),
]);

const stepSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1).max(64),
    type: z.literal("send_template"),
    templateName: z.string().min(1).max(128),
    languageCode: z.string().max(16).optional(),
  }),
  z.object({
    id: z.string().min(1).max(64),
    type: z.literal("wait"),
    durationMinutes: z.number().int().min(1).max(MAX_WAIT_MINUTES),
  }),
  z.object({
    id: z.string().min(1).max(64),
    type: z.literal("wait_for_reply"),
    timeoutMinutes: z.number().int().min(1).max(MAX_WAIT_MINUTES),
    onReplyStepId: z.string().min(1).max(64),
    onTimeoutStepId: z.string().min(1).max(64),
  }),
  z.object({
    id: z.string().min(1).max(64),
    type: z.literal("condition"),
    condition: conditionSchema,
    onTrueStepId: z.string().min(1).max(64),
    onFalseStepId: z.string().min(1).max(64),
  }),
  z.object({ id: z.string().min(1).max(64), type: z.literal("exit") }),
]);

const stepsInput = z.array(stepSchema).min(1).max(MAX_JOURNEY_STEPS);

const entryAudienceSchema = z.object({
  tags: z.array(z.string().min(1).max(64)).max(50).optional(),
  lastOrderWithinDays: z.number().int().min(1).max(3650).optional(),
}).optional();

function assertValidSteps(steps: unknown): asserts steps is JourneyStep[] {
  const errors = validateJourneySteps(steps);
  if (errors.length > 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid journey steps: ${errors.join("; ")}` });
  }
}

export const journeysRouter = router({
  // ── List journeys for a tenant ────────────────────────────────────────────
  list: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      return db.select().from(broadcastJourneys)
        .where(eq(broadcastJourneys.tenantId, input.tenantId))
        .orderBy(desc(broadcastJourneys.createdAt));
    }),

  // ── Get one journey (+ its runs summary) ──────────────────────────────────
  get: protectedProcedure
    .input(z.object({ journeyId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return null;
      const [journey] = await db.select().from(broadcastJourneys)
        .where(eq(broadcastJourneys.id, input.journeyId)).limit(1);
      if (!journey) return null;
      // Journey rows are tenant-confidential — scope to the owning tenant.
      assertTenantAccess(ctx.user, journey.tenantId);
      const runs = await db.select().from(broadcastJourneyRuns)
        .where(eq(broadcastJourneyRuns.journeyId, journey.id))
        .orderBy(desc(broadcastJourneyRuns.createdAt))
        .limit(200);
      return { ...journey, runs };
    }),

  // ── Create (validates the step graph) ─────────────────────────────────────
  create: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      name: z.string().min(1).max(255),
      steps: stepsInput,
      entryAudience: entryAudienceSchema,
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      assertValidSteps(input.steps);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const id = randomUUID();
      await db.insert(broadcastJourneys).values({
        id,
        tenantId: input.tenantId,
        name: input.name,
        status: "draft",
        steps: input.steps as any,
        entryAudience: (input.entryAudience ?? null) as any,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return { id };
    }),

  // ── Update name/steps/audience (drafts + paused only) ─────────────────────
  update: protectedProcedure
    .input(z.object({
      journeyId: z.string(),
      name: z.string().min(1).max(255).optional(),
      steps: stepsInput.optional(),
      entryAudience: entryAudienceSchema,
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [journey] = await db.select().from(broadcastJourneys)
        .where(eq(broadcastJourneys.id, input.journeyId)).limit(1);
      if (!journey) throw new TRPCError({ code: "NOT_FOUND", message: "journey not found" });
      assertTenantAccess(ctx.user, journey.tenantId);
      if (journey.status === "active") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "pause the journey before editing it" });
      }
      if (input.steps) assertValidSteps(input.steps);
      await db.update(broadcastJourneys).set({
        ...(input.name ? { name: input.name } : {}),
        ...(input.steps ? { steps: input.steps as any } : {}),
        ...(input.entryAudience !== undefined ? { entryAudience: input.entryAudience as any } : {}),
        updatedAt: new Date(),
      }).where(eq(broadcastJourneys.id, journey.id));
      return { ok: true };
    }),

  // ── Status transitions (draft→active→paused→archived) ─────────────────────
  setStatus: protectedProcedure
    .input(z.object({
      journeyId: z.string(),
      status: z.enum(["draft", "active", "paused", "archived"]),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [journey] = await db.select().from(broadcastJourneys)
        .where(eq(broadcastJourneys.id, input.journeyId)).limit(1);
      if (!journey) throw new TRPCError({ code: "NOT_FOUND", message: "journey not found" });
      assertTenantAccess(ctx.user, journey.tenantId);
      if (input.status === "active") assertValidSteps(journey.steps);
      await db.update(broadcastJourneys)
        .set({ status: input.status, updatedAt: new Date() })
        .where(eq(broadcastJourneys.id, journey.id));
      return { ok: true };
    }),

  // ── Runs for a journey (tenant-scoped via the journey row) ────────────────
  listRuns: protectedProcedure
    .input(z.object({ journeyId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return [];
      const [journey] = await db.select().from(broadcastJourneys)
        .where(eq(broadcastJourneys.id, input.journeyId)).limit(1);
      if (!journey) throw new TRPCError({ code: "NOT_FOUND", message: "journey not found" });
      assertTenantAccess(ctx.user, journey.tenantId);
      return db.select().from(broadcastJourneyRuns)
        .where(eq(broadcastJourneyRuns.journeyId, journey.id))
        .orderBy(desc(broadcastJourneyRuns.createdAt))
        .limit(500);
    }),

  // ── Enroll customers into an active journey ───────────────────────────────
  // Runs start at step 0; nextRunAt is the frequency-cap/quiet-hours-aware
  // earliest allowed send for each customer.
  enroll: protectedProcedure
    .input(z.object({
      journeyId: z.string(),
      customerIds: z.array(z.string().min(1)).min(1).max(500),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [journey] = await db.select().from(broadcastJourneys)
        .where(eq(broadcastJourneys.id, input.journeyId)).limit(1);
      if (!journey) throw new TRPCError({ code: "NOT_FOUND", message: "journey not found" });
      assertTenantAccess(ctx.user, journey.tenantId);
      if (journey.status !== "active") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "journey must be active to enroll customers" });
      }
      const now = new Date();
      let enrolled = 0;
      for (const customerId of input.customerIds) {
        const [cust] = await db.select().from(customers)
          .where(and(eq(customers.id, customerId), eq(customers.tenantId, journey.tenantId)))
          .limit(1);
        if (!cust?.whatsappPhone) continue;
        const phone = normalizeWaPhone(cust.whatsappPhone);
        const nextRunAt = await nextAllowedSendAtForTenant(db, journey.tenantId, phone, now);
        await db.insert(broadcastJourneyRuns).values({
          id: randomUUID(),
          journeyId: journey.id,
          tenantId: journey.tenantId,
          customerId,
          currentStep: 0,
          state: "waiting",
          context: {},
          nextRunAt,
          createdAt: now,
          updatedAt: now,
        });
        enrolled++;
      }
      return { enrolled };
    }),
});
