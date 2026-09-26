/**
 * J468 — TEMPORAL_ENABLED_WORKFLOWS gate, recorded against a REAL database.
 *
 * Setting TEMPORAL_ADDRESS must not, by itself, push a flow onto Temporal. The gate's contract:
 *   - configured but NOT opted in → behaves exactly as if Temporal were down: a local run row is
 *     recorded (real temporal_workflow_runs), started:false with the distinct
 *     `temporal_not_enabled_for_workflow` signal;
 *   - and a journey orchestration then still EXECUTES locally, inline (the regression that
 *     motivated the allowlist: with an address set and no worker, orchestration used to be
 *     handed to Temporal and never run);
 *   - opted in but Temporal unreachable → still a local row and started:false, with the OTHER
 *     signal (`temporal_unavailable`) so the two causes stay distinguishable;
 *   - no address at all → `temporal_unavailable`, local row.
 * (The happy path — actually starting on Temporal — is exercised against a real Temporal test
 * server by the opt-in `npm run test:temporal`.)
 */
import { eq, inArray } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

const PROBE = "j468-gate-probe";

export const journey: Journey = {
  id: "J468",
  name: "temporal enable-list gate (real DB)",
  feature: "TEMPORAL_ENABLED_WORKFLOWS: local record + honest signal; orchestration still runs locally",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { startWorkflow } = await import("../../server/temporal");
    const orch = await import("../../server/services/journeyOrchestrator");
    const db = world.db;
    const t = schema.temporalWorkflowRuns;

    const saved = { addr: process.env.TEMPORAL_ADDRESS, list: process.env.TEMPORAL_ENABLED_WORKFLOWS };
    const wfIds: string[] = [];
    let executions = 0;
    orch.registerJourneyOrchestration(PROBE, [
      { name: "gateA", run: async () => (executions++, { ok: 1 }) },
      { name: "gateB", run: async () => (executions++, { ok: 2 }) },
    ]);

    const rowFor = async (runId: string) => (await db.select().from(t).where(eq(t.runId, runId)).limit(1))[0];

    try {
      // ── 1. Address set, nothing opted in ─────────────────────────────────
      // Unroutable on purpose: if the gate leaked, the start would TRY Temporal and the error
      // would read `temporal_unavailable` instead.
      process.env.TEMPORAL_ADDRESS = "192.0.2.1:7233";
      delete process.env.TEMPORAL_ENABLED_WORKFLOWS;

      wfIds.push("j468-wf-off");
      const off = await startWorkflow("OrderFulfillmentWorkflow", { orderId: "o-468" }, { workflowId: "j468-wf-off", tenantId: TENANT_ID, entityId: "o-468" });
      assert(off.started === false && off.error === "temporal_not_enabled_for_workflow", `not opted in → the gate's own signal (got ${JSON.stringify(off)})`);
      assert(off.runId.startsWith("local-"), `a local run id (got ${off.runId})`);
      const offRow = await rowFor(off.runId);
      assert(offRow && offRow.workflowType === "OrderFulfillmentWorkflow" && offRow.status === "running", "the run is recorded in temporal_workflow_runs, still running");
      assert(offRow.tenantId === TENANT_ID && offRow.entityId === "o-468" && offRow.workflowId === "j468-wf-off", "tenant/entity/workflow id recorded");
      assert((offRow.input as any)?.orderId === "o-468", "the input is recorded");

      // Whitespace-only is still 'nothing'.
      process.env.TEMPORAL_ENABLED_WORKFLOWS = "   ";
      wfIds.push("j468-wf-blank");
      const blank = await startWorkflow("InventorySyncWorkflow", {}, { workflowId: "j468-wf-blank" });
      assert(blank.error === "temporal_not_enabled_for_workflow", `blank list == nothing enabled (got ${blank.error})`);

      // ── 2. …and orchestration still executes locally, inline ─────────────
      delete process.env.TEMPORAL_ENABLED_WORKFLOWS;
      const orchRun = await orch.startJourneyOrchestration(PROBE, { case: "gate" }, { tenantId: TENANT_ID, workflowId: "j468-wf-orch" });
      wfIds.push("j468-wf-orch");
      assert(orchRun.mode === "local-fallback", `orchestration stays local when it is not opted in (got ${orchRun.mode})`);
      assert(orchRun.status === "completed" && orchRun.executed.join(",") === "gateA,gateB", `it actually ran, inline (got ${JSON.stringify(orchRun)})`);
      assert(executions === 2, `each activity executed exactly once (got ${executions})`);
      const orchRow = await rowFor(orchRun.runId);
      assert(orchRow.status === "completed" && (orchRow.result as any)?.checkpoints?.length === 2, "the run row is completed with both checkpoints");

      // ── 3. Opted in, but Temporal unreachable → still recorded, other signal ──
      process.env.TEMPORAL_ENABLED_WORKFLOWS = "InventorySyncWorkflow";
      wfIds.push("j468-wf-down");
      const down = await startWorkflow("InventorySyncWorkflow", { tenantId: TENANT_ID }, { workflowId: "j468-wf-down", tenantId: TENANT_ID });
      assert(down.started === false && down.error === "temporal_unavailable", `opted in but unreachable → temporal_unavailable (got ${JSON.stringify(down)})`);
      assert(down.runId.startsWith("local-") && (await rowFor(down.runId))?.workflowType === "InventorySyncWorkflow", "…and the run is still recorded locally, not lost");

      // ── 4. Only the listed type is affected ──────────────────────────────
      wfIds.push("j468-wf-other");
      const other = await startWorkflow("TenantOnboardingWorkflow", {}, { workflowId: "j468-wf-other" });
      assert(other.error === "temporal_not_enabled_for_workflow", `an unlisted type stays gated while another is enabled (got ${other.error})`);

      // ── 5. No address at all ─────────────────────────────────────────────
      delete process.env.TEMPORAL_ADDRESS;
      wfIds.push("j468-wf-none");
      const none = await startWorkflow("InventorySyncWorkflow", {}, { workflowId: "j468-wf-none" });
      assert(none.started === false && none.error === "temporal_unavailable" && none.runId.startsWith("local-"), `no address → temporal_unavailable + local row (got ${JSON.stringify(none)})`);
    } finally {
      orch.__unregisterJourneyOrchestration(PROBE);
      if (wfIds.length) await db.delete(t).where(inArray(t.workflowId, wfIds));
      for (const [k, v] of [["TEMPORAL_ADDRESS", saved.addr], ["TEMPORAL_ENABLED_WORKFLOWS", saved.list]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  },
};
