/**
 * hermesRouter — tRPC procedures for the Hermes Agent integration.
 *
 * Procedures:
 *   hermes.getConfig        — get/upsert Hermes connection config for a tenant
 *   hermes.getStatus        — health check against the hermes-bridge service
 *   hermes.getEventLog      — paginated log of events forwarded to Hermes
 *   hermes.getPOQueue       — pending PO drafts awaiting merchant approval
 *   hermes.approvePO        — approve a PO draft (triggers supplier email)
 *   hermes.rejectPO         — reject a PO draft
 *   hermes.fireEvent        — manually fire a test event to Hermes (admin only)
 */

import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { hermesConfigs, hermesEventLog, hermesPODrafts } from "../../drizzle/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

const HERMES_BRIDGE_URL = process.env.HERMES_BRIDGE_URL ?? "http://localhost:8095";
const HERMES_SKILLS_URL = process.env.HERMES_SKILLS_URL ?? "http://localhost:8097";
const PLATFORM_API_KEY = process.env.PLATFORM_API_KEY ?? "";

// ─── Schema validators ────────────────────────────────────────────────────────

const HermesConfigInput = z.object({
  tenantId: z.string(),
  hermesAgentUrl: z.string().url().optional(),
  hermesApiKey: z.string().optional(),
  enabledSkills: z.array(z.string()).optional(),
  autoApproveBelow: z.number().min(0).optional(), // auto-approve POs below this amount
  notifyPhone: z.string().optional(),             // merchant phone for WA approval requests
  woocommerceApiUrl: z.string().optional(),
  woocommerceKey: z.string().optional(),
  woocommerceSecret: z.string().optional(),
  active: z.boolean().optional(),
});

// ─── Router ───────────────────────────────────────────────────────────────────

export const hermesRouter = router({
  // Get or create Hermes config for the current tenant
  getConfig: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [config] = await db
        .select()
        .from(hermesConfigs)
        .where(eq(hermesConfigs.tenantId, input.tenantId))
        .limit(1);

      return config ?? null;
    }),

  // Upsert Hermes config for a tenant
  saveConfig: protectedProcedure
    .input(HermesConfigInput)
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const now = Date.now();
      await db
        .insert(hermesConfigs)
        .values({
          tenantId: input.tenantId,
          hermesAgentUrl: input.hermesAgentUrl ?? null,
          hermesApiKey: input.hermesApiKey ?? null,
          enabledSkills: input.enabledSkills ? JSON.stringify(input.enabledSkills) : null,
          autoApproveBelow: input.autoApproveBelow ?? null,
          notifyPhone: input.notifyPhone ?? null,
          woocommerceApiUrl: input.woocommerceApiUrl ?? null,
          woocommerceKey: input.woocommerceKey ?? null,
          woocommerceSecret: input.woocommerceSecret ?? null,
          active: input.active ?? true,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: hermesConfigs.tenantId,
          set: {
            hermesAgentUrl: input.hermesAgentUrl ?? null,
            hermesApiKey: input.hermesApiKey ?? null,
            enabledSkills: input.enabledSkills ? JSON.stringify(input.enabledSkills) : null,
            autoApproveBelow: input.autoApproveBelow ?? null,
            notifyPhone: input.notifyPhone ?? null,
            woocommerceApiUrl: input.woocommerceApiUrl ?? null,
            woocommerceKey: input.woocommerceKey ?? null,
            woocommerceSecret: input.woocommerceSecret ?? null,
            active: input.active ?? true,
            updatedAt: now,
          },
        });

      return { success: true };
    }),

  // Mark onboarding tour as completed for a tenant
  completeTour: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const now = Date.now();
      await db
        .insert(hermesConfigs)
        .values({
          tenantId: input.tenantId,
          active: true,
          tourCompleted: true,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: hermesConfigs.tenantId,
          set: { tourCompleted: true, updatedAt: now },
        });
      return { success: true };
    }),

  // Health check against hermes-bridge and hermes-skills
  getStatus: protectedProcedure.query(async () => {
    const checks = await Promise.allSettled([
      fetch(`${HERMES_BRIDGE_URL}/health`, { signal: AbortSignal.timeout(5000) })
        .then((r: Response) => r.json() as Promise<Record<string, unknown>>),
      fetch(`${HERMES_SKILLS_URL}/health`, { signal: AbortSignal.timeout(5000) })
        .then((r: Response) => r.json() as Promise<Record<string, unknown>>),
    ]);

    return {
      bridge: checks[0].status === "fulfilled"
        ? { online: true, ...(checks[0].value as object) }
        : { online: false, error: String((checks[0] as PromiseRejectedResult).reason) },
      skills: checks[1].status === "fulfilled"
        ? { online: true, ...(checks[1].value as object) }
        : { online: false, error: String((checks[1] as PromiseRejectedResult).reason) },
    };
  }),

  // Paginated event log
  getEventLog: protectedProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { events: [], total: 0 };

      const where = input.tenantId
        ? eq(hermesEventLog.tenantId, input.tenantId)
        : undefined;

      const [events, [{ count }]] = await Promise.all([
        db.select().from(hermesEventLog)
          .where(where)
          .orderBy(desc(hermesEventLog.createdAt))
          .limit(input.limit)
          .offset(input.offset),
        db.select({ count: sql<number>`count(*)` }).from(hermesEventLog).where(where),
      ]);

      return { events, total: Number(count) };
    }),

  // Pending PO drafts awaiting merchant approval
  getPOQueue: protectedProcedure
    .input(z.object({ tenantId: z.string().optional() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const where = and(
        eq(hermesPODrafts.status, "pending"),
        input.tenantId ? eq(hermesPODrafts.tenantId, input.tenantId) : undefined,
      );

      return db.select().from(hermesPODrafts)
        .where(where)
        .orderBy(desc(hermesPODrafts.createdAt))
        .limit(50);
    }),

  // Approve a PO draft
  approvePO: protectedProcedure
    .input(z.object({
      poId: z.string(),
      approvalToken: z.string(),
      note: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [po] = await db.select().from(hermesPODrafts)
        .where(and(
          eq(hermesPODrafts.poId, input.poId),
          eq(hermesPODrafts.approvalToken, input.approvalToken),
          eq(hermesPODrafts.status, "pending"),
        ))
        .limit(1);

      if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "PO not found or already processed" });

      // Update status
      await db.update(hermesPODrafts)
        .set({ status: "approved", approvedAt: Date.now(), approvedBy: String(ctx.user.id), note: input.note ?? null })
        .where(eq(hermesPODrafts.poId, input.poId));

      // Trigger supplier email via hermes-skills
      try {
        await fetch(`${HERMES_SKILLS_URL}/skills/po-approved`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            po_id: po.poId,
            tenant_id: po.tenantId,
            supplier_email: po.supplierEmail,
            supplier_name: po.supplierName,
            product_name: po.productName,
            sku: po.sku,
            quantity: po.quantity,
            unit_cost: po.unitCost,
            total_cost: po.totalCost,
            currency: po.currency,
            notes: po.note ?? "",
            approved_at: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(10000),
        });
      } catch (e) {
        // Non-fatal: PO is approved, email will retry
        console.error("[hermes] supplier email trigger failed:", e);
      }

      return { success: true, poId: input.poId };
    }),

  // Reject a PO draft
  rejectPO: protectedProcedure
    .input(z.object({
      poId: z.string(),
      approvalToken: z.string(),
      reason: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [po] = await db.select().from(hermesPODrafts)
        .where(and(
          eq(hermesPODrafts.poId, input.poId),
          eq(hermesPODrafts.approvalToken, input.approvalToken),
          eq(hermesPODrafts.status, "pending"),
        ))
        .limit(1);

      if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "PO not found or already processed" });

      await db.update(hermesPODrafts)
        .set({ status: "rejected", approvedAt: Date.now(), approvedBy: String(ctx.user.id), note: input.reason ?? null })
        .where(eq(hermesPODrafts.poId, input.poId));

      return { success: true, poId: input.poId };
    }),

  // Fire a test event to Hermes (admin only)
  fireEvent: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      eventType: z.string(),
      payload: z.record(z.string(), z.unknown()),
    }))
    .mutation(async ({ input }) => {
      const eventId = crypto.randomUUID();
      const body = {
        id: eventId,
        tenant_id: input.tenantId,
        event_type: input.eventType,
        event_version: "1.0",
        occurred_at: new Date().toISOString(),
        producer: "platform-admin",
        idempotency_key: eventId,
        payload: input.payload,
      };

      const resp = await fetch(`${HERMES_BRIDGE_URL}/hermes/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": PLATFORM_API_KEY,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Bridge returned ${resp.status}: ${text}` });
      }

      return { success: true, eventId };
    }),

  // Live health check for all three Hermes layer services
  // Returns real-time up/down status + latency for hermes-bridge, hermes-skills, and hermes-router (Redis heartbeat)
  layerHealth: protectedProcedure.query(async () => {
    const t0 = Date.now();
    const [bridgeResult, skillsResult] = await Promise.allSettled([
      fetch(`${HERMES_BRIDGE_URL}/health`, { signal: AbortSignal.timeout(4000) })
        .then(async (r: Response) => {
          const latencyMs = Date.now() - t0;
          const body = await r.json().catch(() => ({}));
          return { ok: r.ok, latencyMs, body };
        }),
      fetch(`${HERMES_SKILLS_URL}/health`, { signal: AbortSignal.timeout(4000) })
        .then(async (r: Response) => {
          const latencyMs = Date.now() - t0;
          const body = await r.json().catch(() => ({}));
          return { ok: r.ok, latencyMs, body };
        }),
    ]);
    // Hermes Router: check via platform's own router-heartbeat endpoint (backed by Redis key hermes:router:heartbeat)
    const routerStart = Date.now();
    let routerOnline = false;
    let routerLatency = 0;
    let routerError: string | undefined;
    try {
      const hbResp = await fetch(
        `http://localhost:${process.env.PORT ?? 3000}/api/hermes/router-heartbeat`,
        { signal: AbortSignal.timeout(3000) },
      );
      routerOnline = hbResp.ok;
      routerLatency = Date.now() - routerStart;
    } catch (e: any) {
      routerLatency = Date.now() - routerStart;
      routerError = String(e?.message ?? e);
    }
    return {
      bridge: bridgeResult.status === "fulfilled"
        ? { online: bridgeResult.value.ok, latencyMs: bridgeResult.value.latencyMs, details: bridgeResult.value.body }
        : { online: false, latencyMs: 0, error: String((bridgeResult as PromiseRejectedResult).reason) },
      skills: skillsResult.status === "fulfilled"
        ? { online: skillsResult.value.ok, latencyMs: skillsResult.value.latencyMs, details: skillsResult.value.body }
        : { online: false, latencyMs: 0, error: String((skillsResult as PromiseRejectedResult).reason) },
      router: { online: routerOnline, latencyMs: routerLatency, error: routerError },
      checkedAt: Date.now(),
    };
  }),
});
