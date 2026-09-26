/**
 * J467 — Temporal worker ⇄ platform contract, against the REAL server and a REAL database.
 *
 * The worker's activities (services/temporal-workflows) are driven exactly as a Temporal worker
 * would drive them: the worker's own `createApiCall` → HTTP → the unmodified Express/tRPC server →
 * `temporalInternal.*` → real Postgres (PGlite). No fake DB anywhere; only Temporal itself is
 * absent (its sequencing is covered by the opt-in `npm run test:temporal`).
 *
 * Proves:
 *   - the internal endpoints are closed without the shared key (no key / wrong key → 401);
 *   - inventory sync: distinct tenants, real snapshot rows, unknown tenant → non-retryable 404 that
 *     leaves no orphan inventory_sync_log row;
 *   - journey orchestration: plan lookup, one-activity-at-a-time execution, checkpoints in
 *     temporal_workflow_runs, IDEMPOTENT replay (no second execution), a failing step is retryable
 *     under the SAME idempotency key with the failure recorded (run stays 'running'), tenant/params
 *     come from the recorded run, outputs never leave the server, finish is idempotent and a closed
 *     run refuses further steps (409, non-retryable);
 *   - failed / cancelled closure records the error; wrong-workflow-type and missing rows are 404
 *     (a worker can never poke an unrelated run); a worker that races ahead of the run-row insert
 *     waits for it instead of failing;
 *   - the cron tick leaves Temporal-owned runs alone.
 */
import { and, eq, inArray } from "drizzle-orm";
import { assert, PRODUCTS, SUPPLIER_TENANT_ID, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

const KEY = "j467-internal-key";
const PROBE = "j467-temporal-probe";

interface Seen {
  name: string;
  key: string;
  tenantId?: string;
  params: Record<string, unknown>;
  outputsSeen: string[];
}

export const journey: Journey = {
  id: "J467",
  name: "temporal worker ⇄ platform contract (real HTTP, real DB)",
  feature: "temporalInternal endpoints: auth, inventory sync, journey orchestration idempotency + closure",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const orch = await import("../../server/services/journeyOrchestrator");
    const { createApiCall, createActivities, FAILURE_PLATFORM_REJECTED, FAILURE_PLATFORM_UNAVAILABLE } = await import(
      "../../services/temporal-workflows/activities"
    );
    const { FULLSTACK_JOURNEY_ID } = await import("../../server/services/journeyOrchestrator.journeys");
    const db = world.db;
    const t = schema.temporalWorkflowRuns;

    const savedKey = process.env.INTERNAL_API_KEY;
    process.env.INTERNAL_API_KEY = KEY;

    const seen: Seen[] = [];
    let failProbeB = true;
    orch.registerJourneyOrchestration(PROBE, [
      {
        name: "probeA",
        run: async (ctx) => {
          seen.push({ name: "probeA", key: ctx.idempotencyKey, tenantId: ctx.tenantId, params: ctx.params, outputsSeen: Object.keys(ctx.outputs) });
          return { a: 1, note: "server-side only" };
        },
      },
      {
        name: "probeB",
        run: async (ctx) => {
          seen.push({ name: "probeB", key: ctx.idempotencyKey, tenantId: ctx.tenantId, params: ctx.params, outputsSeen: Object.keys(ctx.outputs) });
          if (failProbeB) throw new Error("probeB boom");
          return { sawA: ctx.outputs.probeA };
        },
      },
      {
        name: "probeC",
        run: async (ctx) => {
          seen.push({ name: "probeC", key: ctx.idempotencyKey, tenantId: ctx.tenantId, params: ctx.params, outputsSeen: Object.keys(ctx.outputs) });
          return { done: true };
        },
      },
    ]);

    const seededOdooIds: string[] = [];
    const insertedRunIds: string[] = [];
    const seededSnapshotTenants = [TENANT_ID, SUPPLIER_TENANT_ID];

    try {
      const acts = createActivities({ apiCall: createApiCall({ baseUrl: world.baseUrl, internalToken: KEY }) });
      const rawPost = (proc: string, body: unknown, headers: Record<string, string> = {}) =>
        fetch(`${world.baseUrl}/api/trpc/${proc}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ json: body }),
        });
      const expectFailure = async (fn: () => Promise<unknown>, type: string, label: string) => {
        let err: any = null;
        try {
          await fn();
        } catch (e: any) {
          err = e;
        }
        assert(err, `${label}: expected a failure, but the call succeeded`);
        assert(err.type === type, `${label}: expected failure type ${type}, got ${err.type} (${err.message})`);
        return err;
      };
      const runRow = async (runId: string) => (await db.select().from(t).where(eq(t.runId, runId)).limit(1))[0];

      // ── 1. Closed without the shared key ─────────────────────────────────
      const noKey = await rawPost("temporalInternal.listInventorySyncTenants", {});
      assert(noKey.status === 401, `no internal key must 401 (got ${noKey.status})`);
      const wrongKey = await rawPost("temporalInternal.journeyPlan", { journeyId: PROBE }, { "X-Internal-Token": "nope" });
      assert(wrongKey.status === 401, `wrong internal key must 401 (got ${wrongKey.status})`);
      const noKeyStep = await rawPost("temporalInternal.runJourneyActivity", { runId: "x", activityName: "probeA" });
      assert(noKeyStep.status === 401, `runJourneyActivity without the key must 401 (got ${noKeyStep.status})`);
      const noKeyFinish = await rawPost("temporalInternal.finishJourney", { runId: "x", status: "completed" });
      assert(noKeyFinish.status === 401, `finishJourney without the key must 401 (got ${noKeyFinish.status})`);

      // ── 2. Inventory sync over the real wire ─────────────────────────────
      const [supplierProduct] = await db
        .select({ id: schema.products.id })
        .from(schema.products)
        .where(eq(schema.products.tenantId, SUPPLIER_TENANT_ID))
        .limit(1);
      assert(supplierProduct, "sim world has a supplier product to sync against");
      const odooRows = [
        { id: "j467-odoo-1", tenantId: TENANT_ID, odooId: 467001, name: "J467 Jollof", localProductId: PRODUCTS.jollof.id, stockQty: "42.00" },
        { id: "j467-odoo-2", tenantId: SUPPLIER_TENANT_ID, odooId: 467002, name: "J467 Supplier item", localProductId: supplierProduct.id, stockQty: "7.00" },
        // A second row for the first tenant: the tenant list must still be DISTINCT.
        { id: "j467-odoo-3", tenantId: TENANT_ID, odooId: 467003, name: "J467 Chicken", localProductId: PRODUCTS.chicken.id, stockQty: "9.00" },
      ];
      await db.insert(schema.odooSyncedProducts).values(odooRows);
      seededOdooIds.push(...odooRows.map((r) => r.id));

      const tenantIds = await acts.listInventorySyncTenants();
      assert(
        tenantIds.filter((x) => x === TENANT_ID).length === 1 && tenantIds.includes(SUPPLIER_TENANT_ID),
        `tenant list is distinct and includes both seeded tenants (got ${JSON.stringify(tenantIds)})`,
      );

      const synced = await acts.syncTenantInventory(TENANT_ID);
      assert(synced.tenantId === TENANT_ID && synced.recordsSynced === 2, `sync reports 2 records (got ${JSON.stringify(synced)})`);
      const [snap] = await db
        .select()
        .from(schema.inventorySnapshots)
        .where(and(eq(schema.inventorySnapshots.tenantId, TENANT_ID), eq(schema.inventorySnapshots.productId, PRODUCTS.jollof.id)))
        .limit(1);
      assert(snap && Number(snap.stockQty) === 42 && Number(snap.reservedQty) === 0, `snapshot row written from Odoo data, no fabricated reservations (got ${JSON.stringify(snap)})`);
      const again = await acts.syncTenantInventory(TENANT_ID);
      assert(again.recordsSynced === 2, "re-running the sync is idempotent (still 2 records)");
      const snapRows = await db
        .select()
        .from(schema.inventorySnapshots)
        .where(and(eq(schema.inventorySnapshots.tenantId, TENANT_ID), eq(schema.inventorySnapshots.productId, PRODUCTS.jollof.id)));
      assert(snapRows.length === 1, `re-sync upserts, never duplicates (got ${snapRows.length} rows)`);

      const ghostErr = await expectFailure(() => acts.syncTenantInventory("ghost-467"), FAILURE_PLATFORM_REJECTED, "unknown tenant");
      assert(ghostErr.nonRetryable === true, "an unknown tenant is a permanent error — retrying cannot fix it");
      const ghostLogs = await db.select().from(schema.inventorySyncLog).where(eq(schema.inventorySyncLog.tenantId, "ghost-467"));
      assert(ghostLogs.length === 0, `an unknown tenant leaves no orphan inventory_sync_log row (got ${ghostLogs.length})`);

      // ── 3. Journey plan ──────────────────────────────────────────────────
      const plan = await acts.getJourneyPlan(PROBE);
      assert(JSON.stringify(plan) === JSON.stringify(["probeA", "probeB", "probeC"]), `plan follows the registry order (got ${JSON.stringify(plan)})`);
      const builtinPlan = await acts.getJourneyPlan(FULLSTACK_JOURNEY_ID);
      assert(
        JSON.stringify(builtinPlan) === JSON.stringify(orch.JourneyOrchestrationWorkflow.plan(FULLSTACK_JOURNEY_ID)) && builtinPlan.length > 1,
        `a built-in journey resolves through the same registry (got ${JSON.stringify(builtinPlan)})`,
      );
      const unknownPlan = await expectFailure(() => acts.getJourneyPlan("no-such-journey"), FAILURE_PLATFORM_REJECTED, "unknown journey");
      assert(unknownPlan.nonRetryable === true, "an unknown journey fails at the plan step, permanently");

      // ── 4. One run, driven the way the workflow drives it ────────────────
      const params = { orderRef: "ref-467", n: 2 };
      const started = await orch.startJourneyOrchestration(PROBE, params, {
        tenantId: TENANT_ID,
        workflowId: "j467-wf-main",
        deferExecution: true,
      });
      const runId = started.runId;
      insertedRunIds.push(runId);
      assert(started.mode === "local-fallback" && started.status === "running", "sim has no Temporal: the run row is recorded and deferred");
      assert(seen.length === 0, "deferred start executes nothing");

      // 4a. first execution
      const r1 = await acts.runJourneyActivity(runId, "probeA");
      assert(r1.cached === false, "first execution of probeA is not cached");
      assert(seen.length === 1 && seen[0].key === `${runId}:probeA`, `probeA ran once with the deterministic key (got ${JSON.stringify(seen[0])})`);
      assert(seen[0].tenantId === TENANT_ID, "tenant comes from the recorded run");
      // (jsonb does not preserve key order, so compare fields, not serialised text.)
      assert(
        (seen[0].params as any).orderRef === "ref-467" && (seen[0].params as any).n === 2 && Object.keys(seen[0].params).length === 2,
        `params come from the recorded run (got ${JSON.stringify(seen[0].params)})`,
      );
      let row = await runRow(runId);
      assert(row.status === "running", "run stays running between steps");
      const res1 = row.result as any;
      assert(res1?.mode === "temporal" && res1.checkpoints?.length === 1 && res1.checkpoints[0].key === `${runId}:probeA`, `checkpoint persisted in temporal_workflow_runs.result (got ${JSON.stringify(res1)})`);

      // 4b. replay — the "ran, but the response was lost" retry
      const r1b = await acts.runJourneyActivity(runId, "probeA");
      assert(r1b.cached === true, "a replay of a checkpointed step reports cached");
      assert(seen.length === 1, `a replay must NOT execute the step again (executions: ${seen.length})`);

      // 4c. a failing step: retryable, recorded, run stays open, prior checkpoints kept
      const bErr = await expectFailure(() => acts.runJourneyActivity(runId, "probeB"), FAILURE_PLATFORM_UNAVAILABLE, "failing step");
      assert(bErr.nonRetryable !== true, "a step failure is retryable (Temporal re-drives it)");
      row = await runRow(runId);
      const failed = row.result as any;
      assert(row.status === "running", "a failed step leaves the run 'running' — Temporal owns the retry");
      assert(String(failed?.lastError ?? "").includes("probeB boom"), `failure recorded as lastError (got ${JSON.stringify(failed)})`);
      assert(failed.checkpoints?.length === 1 && failed.checkpoints[0].name === "probeA", "the earlier checkpoint survives the failure");

      // 4d. retry after the fault clears: same key, sees the earlier output
      failProbeB = false;
      const r2 = await acts.runJourneyActivity(runId, "probeB");
      assert(r2.cached === false, "the retried step executes");
      const bCalls = seen.filter((s) => s.name === "probeB");
      assert(bCalls.length === 2 && bCalls[0].key === bCalls[1].key && bCalls[1].key === `${runId}:probeB`, `the retry reuses the SAME idempotency key (got ${JSON.stringify(bCalls.map((c) => c.key))})`);
      assert(bCalls[1].outputsSeen.includes("probeA") && !bCalls[1].outputsSeen.includes("probeC"), "a step sees earlier outputs only");
      row = await runRow(runId);
      const afterB = row.result as any;
      assert(afterB.lastError === undefined, "a successful step clears the recorded failure");
      assert(JSON.stringify(afterB.checkpoints.find((c: any) => c.name === "probeB")?.output) === JSON.stringify({ sawA: { a: 1, note: "server-side only" } }), "probeB's output was computed from probeA's checkpoint");

      // 4e. an activity the journey doesn't have
      const noAct = await expectFailure(() => acts.runJourneyActivity(runId, "probeZ"), FAILURE_PLATFORM_REJECTED, "unknown activity");
      assert(noAct.nonRetryable === true, "an activity outside the journey is permanent");

      // 4f. outputs never leave the server (they would enter Temporal history)
      const rawC = await rawPost("temporalInternal.runJourneyActivity", { runId, activityName: "probeC" }, { "X-Internal-Token": KEY });
      const rawCBody: any = await rawC.json();
      assert(rawC.status === 200 && JSON.stringify(rawCBody?.result?.data?.json) === JSON.stringify({ cached: false }), `the response carries only {cached} (got ${JSON.stringify(rawCBody)})`);

      // 4g. close it, idempotently
      const done = await orch.finishTemporalOrchestration(db, { runId, status: "completed" });
      assert(done.status === "completed" && done.alreadyClosed === false, "finish closes the run");
      row = await runRow(runId);
      const closed = row.result as any;
      assert(row.status === "completed" && row.closedAt && closed.checkpoints.length === 3, "row completed with all 3 checkpoints and a closedAt");
      await acts.finishJourney(runId, "completed"); // worker retry of finish must be harmless
      const clash = await orch.finishTemporalOrchestration(db, { runId, status: "failed", error: "late" });
      assert(clash.alreadyClosed === true && clash.status === "completed", "a late 'failed' cannot overwrite a completed run");
      row = await runRow(runId);
      assert(row.status === "completed" && !row.errorMessage, "the closed run is untouched by the late finish");

      // 4h. a closed run refuses further steps (409 → non-retryable)
      const closedStep = await expectFailure(() => acts.runJourneyActivity(runId, "probeA"), FAILURE_PLATFORM_REJECTED, "step on a closed run");
      assert(closedStep.nonRetryable === true && /409/.test(closedStep.message), `a closed run answers 409, not retried (got ${closedStep.message})`);

      // ── 5. Failed / cancelled closure ────────────────────────────────────
      for (const status of ["failed", "cancelled"] as const) {
        const s = await orch.startJourneyOrchestration(PROBE, {}, { tenantId: TENANT_ID, workflowId: `j467-wf-${status}`, deferExecution: true });
        insertedRunIds.push(s.runId);
        await acts.finishJourney(s.runId, status, `worker says ${status}`);
        const r = await runRow(s.runId);
        assert(r.status === status && r.closedAt, `run closed as ${status}`);
        assert(String((r.result as any)?.lastError ?? "").includes(`worker says ${status}`), `error recorded in the result for ${status}`);
        assert(String(r.errorMessage ?? "").includes(`worker says ${status}`), `error recorded on the row for ${status}`);
      }

      // ── 6. A worker can only touch orchestration runs that exist ─────────
      const nowhere = await orch
        .runOrchestrationActivityForTemporal(db, { runId: "j467-missing", activityName: "probeA" }, { waitMs: 0 })
        .catch((e) => e);
      assert(nowhere?.code === "NOT_FOUND", `unknown run → NOT_FOUND (got ${nowhere?.code ?? nowhere})`);
      const nowhereFinish = await orch.finishTemporalOrchestration(db, { runId: "j467-missing", status: "failed" }).catch((e) => e);
      assert(nowhereFinish?.code === "NOT_FOUND", "finishing an unknown run → NOT_FOUND");

      await db.insert(t).values({
        workflowId: "j467-wf-other",
        runId: "j467-other-type",
        workflowType: "InventorySyncWorkflow",
        tenantId: TENANT_ID,
        status: "running",
        input: { journeyId: PROBE, params: {} },
      });
      insertedRunIds.push("j467-other-type");
      const wrongType = await orch
        .runOrchestrationActivityForTemporal(db, { runId: "j467-other-type", activityName: "probeA" }, { waitMs: 0 })
        .catch((e) => e);
      assert(wrongType?.code === "NOT_FOUND", `a run of another workflow type is not reachable (got ${wrongType?.code ?? wrongType})`);
      const wrongTypeFinish = await orch.finishTemporalOrchestration(db, { runId: "j467-other-type", status: "cancelled" }).catch((e) => e);
      assert(wrongTypeFinish?.code === "NOT_FOUND", "…nor can it be closed through the journey endpoint");
      assert((await runRow("j467-other-type")).status === "running", "the unrelated run is untouched");

      // A row with a journey that no longer exists: permanent, not a retry loop.
      await db.insert(t).values({
        workflowId: "j467-wf-orphan",
        runId: "j467-orphan-journey",
        workflowType: orch.ORCHESTRATION_WORKFLOW_TYPE,
        tenantId: TENANT_ID,
        status: "running",
        input: { journeyId: "removed-journey", params: {} },
      });
      insertedRunIds.push("j467-orphan-journey");
      const orphan = await orch
        .runOrchestrationActivityForTemporal(db, { runId: "j467-orphan-journey", activityName: "probeA" }, { waitMs: 0 })
        .catch((e) => e);
      assert(orphan?.code === "BAD_REQUEST", `a run whose journey is gone → BAD_REQUEST (got ${orphan?.code ?? orphan})`);

      // ── 7. Worker races ahead of the run-row insert ──────────────────────
      const raceRunId = "j467-race-run";
      insertedRunIds.push(raceRunId);
      const t0 = Date.now();
      const pending = orch.runOrchestrationActivityForTemporal(db, { runId: raceRunId, activityName: "probeA" }, { waitMs: 8000 });
      await new Promise((r) => setTimeout(r, 500));
      await db.insert(t).values({
        workflowId: "j467-wf-race",
        runId: raceRunId,
        workflowType: orch.ORCHESTRATION_WORKFLOW_TYPE,
        tenantId: SUPPLIER_TENANT_ID,
        status: "running",
        input: { journeyId: PROBE, params: { late: true } },
      });
      const raced = await pending;
      assert(raced.cached === false, "the step ran once the row appeared");
      assert(Date.now() - t0 < 6000, "…and did not burn the whole wait budget");
      const racedSeen = seen[seen.length - 1];
      assert(racedSeen.tenantId === SUPPLIER_TENANT_ID && (racedSeen.params as any).late === true, "the raced step used the tenant/params of ITS row");

      // ── 8. The cron tick leaves Temporal-owned runs alone ────────────────
      await db.insert(t).values({
        workflowId: "j467-wf-owned",
        runId: "temporal-owned-467",
        workflowType: orch.ORCHESTRATION_WORKFLOW_TYPE,
        tenantId: TENANT_ID,
        status: "running",
        input: { journeyId: PROBE, params: {} },
      });
      insertedRunIds.push("temporal-owned-467");
      const before = seen.length;
      await orch.runOrchestrationTick(db);
      assert(!seen.slice(before).some((s) => s.key.startsWith("temporal-owned-467")), "the tick never executes a Temporal-owned run");
      const owned = await runRow("temporal-owned-467");
      assert(owned.status === "running" && !owned.result, "the Temporal-owned run is untouched by the tick");
    } finally {
      orch.__unregisterJourneyOrchestration(PROBE);
      if (seededOdooIds.length) await db.delete(schema.odooSyncedProducts).where(inArray(schema.odooSyncedProducts.id, seededOdooIds));
      await db
        .delete(schema.inventorySnapshots)
        .where(and(inArray(schema.inventorySnapshots.tenantId, seededSnapshotTenants), inArray(schema.inventorySnapshots.odooProductId, [467001, 467002, 467003])));
      if (insertedRunIds.length) await db.delete(t).where(inArray(t.runId, insertedRunIds));
      if (savedKey === undefined) delete process.env.INTERNAL_API_KEY;
      else process.env.INTERNAL_API_KEY = savedKey;
    }
  },
};
