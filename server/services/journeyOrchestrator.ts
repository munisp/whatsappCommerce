/**
 * server/services/journeyOrchestrator.ts — W23 Temporal journey orchestrator.
 *
 * Runs a stakeholder journey as a durable sequence of activities, where each
 * activity calls EXISTING platform services (onboarding, orders, payments,
 * inventory, credit, audit) — the orchestrator never reimplements business
 * logic; it only sequences, checkpoints and resumes.
 *
 * Durable modes:
 *   - Temporal mode: TEMPORAL_ADDRESS is set and the client connects → the
 *     JourneyOrchestrationWorkflow is started on the "whatsapp-commerce"
 *     task queue and recorded in temporal_workflow_runs (the worker proxies
 *     the same registered activities).
 *   - Local fallback (tests/sim/dev — no Temporal): activities execute
 *     sequentially in-process through the SAME registry. Durable semantics
 *     are emulated: after each activity a checkpoint { name, key, output }
 *     is persisted into temporal_workflow_runs.result, so a re-run RESUMES
 *     after the last checkpoint instead of re-executing completed work.
 *     Every activity gets a deterministic idempotency key
 *     `${runId}:${activityName}`; a mid-run failure leaves the run in
 *     status 'running' so the cron tick (POST /api/scheduled/journey-
 *     orchestrate-tick) or an explicit resume picks it up.
 *
 * Schema: reuses temporal_workflow_runs as-is (workflowType carries the
 * journey id as `JourneyOrchestrationWorkflow`, input carries
 * { journeyId, params }, result carries { mode, checkpoints, ... }).
 */
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { temporalWorkflowRuns } from "../../drizzle/schema";
import { startWorkflow, updateWorkflowStatus } from "../temporal";

export const ORCHESTRATION_WORKFLOW_TYPE = "JourneyOrchestrationWorkflow";
export const ORCHESTRATION_TASK_QUEUE = "whatsapp-commerce";

export type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;

// ── Registry ─────────────────────────────────────────────────────────────────

export interface OrchestrationContext {
  workflowId: string;
  runId: string;
  journeyId: string;
  tenantId?: string;
  params: Record<string, unknown>;
  db: DbHandle;
  /** Outputs of previously completed activities, keyed by activity name. */
  outputs: Record<string, unknown>;
  /** Deterministic idempotency key for the activity currently running. */
  idempotencyKey: string;
}

export interface OrchestrationActivity {
  name: string;
  /** Calls ONE existing platform service; returns a JSON-serializable output. */
  run: (ctx: OrchestrationContext) => Promise<unknown>;
}

const registry = new Map<string, OrchestrationActivity[]>();

/** Lazily register built-in orchestrations (dynamic import — no cycle). */
async function ensureBuiltins(): Promise<void> {
  try {
    const mod = await import("./journeyOrchestrator.journeys");
    mod.ensureBuiltinOrchestrations();
  } catch { /* builtins module absent in stripped builds */ }
}

export function registerJourneyOrchestration(journeyId: string, activities: OrchestrationActivity[]): void {
  if (!journeyId || typeof journeyId !== "string") {
    throw new Error("journeyId must be a non-empty string");
  }
  if (!Array.isArray(activities) || activities.length === 0) {
    throw new Error(`orchestration ${journeyId} needs at least one activity`);
  }
  const seen = new Set<string>();
  for (const a of activities) {
    if (!a?.name || typeof a.run !== "function") {
      throw new Error(`orchestration ${journeyId}: every activity needs a name and run()`);
    }
    if (seen.has(a.name)) {
      throw new Error(`orchestration ${journeyId}: duplicate activity name "${a.name}"`);
    }
    seen.add(a.name);
  }
  registry.set(journeyId, activities);
}

export function getJourneyActivities(journeyId: string): OrchestrationActivity[] | null {
  return registry.get(journeyId) ?? null;
}

export function listRegisteredOrchestrations(): string[] {
  return Array.from(registry.keys()).sort();
}

/** Test-only: remove a registration. */
export function __unregisterJourneyOrchestration(journeyId: string): void {
  registry.delete(journeyId);
}

// ── Workflow definition (durable descriptor) ─────────────────────────────────

/**
 * JourneyOrchestrationWorkflow — the durable workflow definition. A Temporal
 * worker would proxy each entry as an activity; the local fallback executes
 * the identical sequence in-process. Either way the SEQUENCE and the service
 * calls come from the registry — never reimplemented.
 */
export const JourneyOrchestrationWorkflow = {
  workflowType: ORCHESTRATION_WORKFLOW_TYPE,
  taskQueue: ORCHESTRATION_TASK_QUEUE,
  /**
   * Pure sequencing: resolves the registry and returns the ordered activity
   * names for (re)execution planning. Side effects live in the activities.
   */
  plan(journeyId: string): string[] {
    const activities = registry.get(journeyId);
    if (!activities) throw new Error(`unknown orchestration journey: ${journeyId}`);
    return activities.map((a) => a.name);
  },
} as const;

// ── Checkpoints ──────────────────────────────────────────────────────────────

export interface ActivityCheckpoint {
  name: string;
  key: string;
  output: unknown;
  at: string;
}

export interface OrchestrationResult {
  mode: "temporal" | "local-fallback";
  journeyId: string;
  checkpoints: ActivityCheckpoint[];
  lastError?: string;
}

function checkpointKey(runId: string, activityName: string): string {
  return `${runId}:${activityName}`;
}

async function loadResult(db: DbHandle, runId: string): Promise<OrchestrationResult | null> {
  const [row] = await db
    .select({ result: temporalWorkflowRuns.result })
    .from(temporalWorkflowRuns)
    .where(eq(temporalWorkflowRuns.runId, runId))
    .limit(1);
  return (row?.result as OrchestrationResult | null) ?? null;
}

async function persistCheckpoint(
  db: DbHandle,
  runId: string,
  journeyId: string,
  checkpoint: ActivityCheckpoint,
): Promise<void> {
  const existing = await loadResult(db, runId);
  const checkpoints = [...(existing?.checkpoints ?? []).filter((c) => c.name !== checkpoint.name), checkpoint];
  await db
    .update(temporalWorkflowRuns)
    .set({
      result: {
        mode: "local-fallback",
        journeyId,
        checkpoints,
      } satisfies Partial<OrchestrationResult> as unknown as Record<string, unknown>,
    })
    .where(eq(temporalWorkflowRuns.runId, runId));
}

// ── Local fallback executor (durable semantics emulated) ────────────────────

/**
 * Executes the not-yet-checkpointed activities of a run in-process. Resumes
 * after the last checkpoint; a throwing activity leaves the run 'running'
 * with the error recorded so a later resume continues WITHOUT re-executing
 * completed activities. Returns the final run status.
 */
export async function executeOrchestrationLocally(
  db: DbHandle,
  runId: string,
): Promise<{ status: "completed" | "running"; executed: string[]; error?: string }> {
  const [row] = await db
    .select()
    .from(temporalWorkflowRuns)
    .where(eq(temporalWorkflowRuns.runId, runId))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: `orchestration run ${runId} not found` });
  const journeyId = ((row.input as any)?.journeyId ?? "") as string;
  await ensureBuiltins();
  const params = ((row.input as any)?.params ?? {}) as Record<string, unknown>;
  const activities = registry.get(journeyId);
  if (!activities) {
    await updateWorkflowStatus(runId, "failed", undefined, `unknown orchestration journey: ${journeyId || "(missing)"}`);
    return { status: "running", executed: [], error: `unknown orchestration journey: ${journeyId}` };
  }

  const stored = await loadResult(db, runId);
  const done = new Map<string, ActivityCheckpoint>();
  for (const c of stored?.checkpoints ?? []) done.set(c.name, c);
  const outputs: Record<string, unknown> = {};
  for (const a of activities) {
    const cp = done.get(a.name);
    if (cp) outputs[a.name] = cp.output;
  }

  const executed: string[] = [];
  for (const activity of activities) {
    if (done.has(activity.name)) continue; // resume: skip checkpointed work
    const key = checkpointKey(runId, activity.name);
    const ctx: OrchestrationContext = {
      workflowId: row.workflowId,
      runId,
      journeyId,
      tenantId: row.tenantId ?? undefined,
      params,
      db,
      outputs,
      idempotencyKey: key,
    };
    try {
      const output = await activity.run(ctx);
      const checkpoint: ActivityCheckpoint = {
        name: activity.name,
        key,
        output: output ?? null,
        at: new Date().toISOString(),
      };
      await persistCheckpoint(db, runId, journeyId, checkpoint);
      done.set(activity.name, checkpoint);
      outputs[activity.name] = checkpoint.output;
      executed.push(activity.name);
    } catch (err: any) {
      // Crash/failure mid-run: stay 'running', record the error, let the
      // cron tick / explicit resume continue from the LAST checkpoint.
      const existing = await loadResult(db, runId);
      await db
        .update(temporalWorkflowRuns)
        .set({
          result: {
            mode: "local-fallback",
            journeyId,
            checkpoints: existing?.checkpoints ?? [],
            lastError: String(err?.message ?? err),
          } as unknown as Record<string, unknown>,
        })
        .where(eq(temporalWorkflowRuns.runId, runId));
      return { status: "running", executed, error: String(err?.message ?? err) };
    }
  }

  const finalResult: OrchestrationResult = {
    mode: "local-fallback",
    journeyId,
    checkpoints: activities.map((a) => done.get(a.name)!),
  };
  await updateWorkflowStatus(runId, "completed", finalResult as unknown as Record<string, unknown>);
  return { status: "completed", executed };
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface StartOrchestrationOptions {
  tenantId?: string;
  workflowId?: string;
  /**
   * When true, record the run but do NOT execute inline (local fallback) —
   * the cron tick resumes it. Temporal mode always defers to the worker.
   */
  deferExecution?: boolean;
  /** Escape hatch for tests to force local execution. */
  forceLocal?: boolean;
}

export interface StartOrchestrationResult {
  workflowId: string;
  runId: string;
  mode: "temporal" | "local-fallback";
  status: "running" | "completed";
  executed: string[];
  error?: string;
}

export async function startJourneyOrchestration(
  journeyId: string,
  params: Record<string, unknown>,
  opts: StartOrchestrationOptions = {},
): Promise<StartOrchestrationResult> {
  await ensureBuiltins();
  const activities = registry.get(journeyId);
  if (!activities) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `unknown orchestration journey: ${journeyId}` });
  }
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

  const workflowId =
    opts.workflowId ?? `journey-orch-${journeyId}-${opts.tenantId ?? "global"}`;
  const started = await startWorkflow(
    ORCHESTRATION_WORKFLOW_TYPE,
    { journeyId, params },
    { workflowId, tenantId: opts.tenantId, entityId: journeyId, executionTimeout: "7 days" },
  );

  if (started.started && !opts.forceLocal) {
    // Real Temporal run — the worker proxies the registered activities.
    return { workflowId: started.workflowId, runId: started.runId, mode: "temporal", status: "running", executed: [] };
  }

  // Local fallback: durable emulation via checkpoints.
  if (opts.deferExecution) {
    return { workflowId: started.workflowId, runId: started.runId, mode: "local-fallback", status: "running", executed: [] };
  }
  const exec = await executeOrchestrationLocally(db, started.runId);
  return {
    workflowId: started.workflowId,
    runId: started.runId,
    mode: "local-fallback",
    status: exec.status,
    executed: exec.executed,
    error: exec.error,
  };
}

/** Resume a recorded run from its last checkpoint (local fallback only). */
export async function resumeJourneyOrchestration(
  runId: string,
): Promise<{ status: "completed" | "running"; executed: string[]; error?: string }> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return executeOrchestrationLocally(db, runId);
}

/**
 * Cron tick: resume every local-fallback orchestration still 'running'.
 * Temporal-owned runs (runId not prefixed "local-") are left to the worker.
 * Never throws — mirrors the other scheduled tick services.
 */
export async function runOrchestrationTick(
  db: DbHandle,
): Promise<{ resumed: number; completed: number; stillRunning: number; errors: number }> {
  const summary = { resumed: 0, completed: 0, stillRunning: 0, errors: 0 };
  try {
    const rows = await db
      .select({ runId: temporalWorkflowRuns.runId })
      .from(temporalWorkflowRuns)
      .where(
        and(
          eq(temporalWorkflowRuns.workflowType, ORCHESTRATION_WORKFLOW_TYPE),
          eq(temporalWorkflowRuns.status, "running"),
        ),
      );
    for (const row of rows) {
      if (!row.runId.startsWith("local-")) continue; // Temporal worker owns it
      summary.resumed++;
      try {
        const res = await executeOrchestrationLocally(db, row.runId);
        if (res.status === "completed") summary.completed++;
        else {
          summary.stillRunning++;
          if (res.error) summary.errors++;
        }
      } catch {
        summary.errors++;
      }
    }
  } catch (err: any) {
    console.warn("[journey-orchestrate-tick] scan failed:", err?.message);
  }
  return summary;
}

// ── Status / history ─────────────────────────────────────────────────────────

export async function getOrchestrationStatus(runId: string): Promise<{
  runId: string;
  workflowId: string;
  journeyId: string | null;
  tenantId: string | null;
  status: string;
  checkpointCount: number;
  lastError?: string;
}> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  const [row] = await db
    .select()
    .from(temporalWorkflowRuns)
    .where(eq(temporalWorkflowRuns.runId, runId))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "orchestration run not found" });
  const result = (row.result as OrchestrationResult | null) ?? null;
  return {
    runId: row.runId,
    workflowId: row.workflowId,
    journeyId: ((row.input as any)?.journeyId ?? null) as string | null,
    tenantId: row.tenantId ?? null,
    status: row.status,
    checkpointCount: result?.checkpoints?.length ?? 0,
    lastError: result?.lastError,
  };
}

export async function getOrchestrationHistory(runId: string): Promise<{
  runId: string;
  workflowId: string;
  tenantId: string | null;
  status: string;
  startedAt: Date;
  closedAt: Date | null;
  checkpoints: ActivityCheckpoint[];
}> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  const [row] = await db
    .select()
    .from(temporalWorkflowRuns)
    .where(eq(temporalWorkflowRuns.runId, runId))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "orchestration run not found" });
  const result = (row.result as OrchestrationResult | null) ?? null;
  return {
    runId: row.runId,
    workflowId: row.workflowId,
    tenantId: row.tenantId ?? null,
    status: row.status,
    startedAt: row.startedAt,
    closedAt: row.closedAt ?? null,
    checkpoints: result?.checkpoints ?? [],
  };
}
