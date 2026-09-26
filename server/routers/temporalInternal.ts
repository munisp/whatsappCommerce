/**
 * Internal endpoints for the Temporal worker's activities (services/temporal-workflows).
 *
 * Every procedure here is an `internalProcedure`: a real HTTP request must present the shared
 * INTERNAL_API_KEY (X-Internal-Token) or it is rejected — an ordinary user session is NOT
 * enough, and a valid internal key is the only thing that opens these. Keep this surface as
 * small as the activities need: each endpoint wraps ONE existing service function, validates
 * its input, and never accepts arbitrary SQL, URLs or tenant-wide "do everything" switches.
 *
 * Mutations (not queries) on purpose: the worker POSTs, which also exempts the call from the
 * browser CSRF check (internal-auth headers cannot be attached cross-site).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { internalProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { odooSyncedProducts, tenants } from "../../drizzle/schema";
import { syncTenantInventoryFromOdoo } from "../services/inventorySync";
import {
  finishTemporalOrchestration,
  getJourneyPlan,
  runOrchestrationActivityForTemporal,
} from "../services/journeyOrchestrator";

export const temporalInternalRouter = router({
  /** Tenants that have Odoo-synced products — the same set the cron heartbeat iterates. */
  listInventorySyncTenants: internalProcedure
    .input(z.object({}).default({}))
    .mutation(async () => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rows = await db.selectDistinct({ tenantId: odooSyncedProducts.tenantId }).from(odooSyncedProducts);
      return { tenantIds: Array.from(new Set(rows.map((r) => r.tenantId))) };
    }),

  /** Idempotent: refreshes inventory_snapshots for one tenant from odoo_synced_products. */
  syncTenantInventory: internalProcedure
    .input(z.object({ tenantId: z.string().min(1).max(64) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      // An unknown id would otherwise still write an inventory_sync_log row for a tenant that
      // does not exist — reject it as a 404 so a bad workflow input fails fast (non-retryable).
      const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
      if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: `Tenant ${input.tenantId} not found` });
      const result = await syncTenantInventoryFromOdoo(db, input.tenantId);
      return { tenantId: result.tenantId, recordsSynced: result.recordsSynced };
    }),

  // ── Journey orchestration (JourneyOrchestrationWorkflow) ────────────────────
  // The workflow only sequences; each step runs ONE registered activity server-side, with the
  // tenant and params read from the recorded run (never from this request).

  /** Ordered activity names of a registered journey. Unknown journey → 400 (not retried). */
  journeyPlan: internalProcedure
    .input(z.object({ journeyId: z.string().min(1).max(128) }))
    .mutation(async ({ input }) => ({ activities: await getJourneyPlan(input.journeyId) })),

  /** Run one activity of a Temporal-owned run. Idempotent — a checkpointed activity is not re-run. */
  runJourneyActivity: internalProcedure
    .input(z.object({ runId: z.string().min(1).max(128), activityName: z.string().min(1).max(128) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return runOrchestrationActivityForTemporal(db, input);
    }),

  /** Close the run's temporal_workflow_runs row. Idempotent. */
  finishJourney: internalProcedure
    .input(
      z.object({
        runId: z.string().min(1).max(128),
        status: z.enum(["completed", "failed", "cancelled"]),
        error: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return finishTemporalOrchestration(db, input);
    }),
});
