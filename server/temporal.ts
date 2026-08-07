/**
 * server/temporal.ts — Temporal workflow client integration
 *
 * Connects to the Temporal server to start and query workflows.
 * Falls back gracefully when TEMPORAL_ADDRESS is not configured.
 *
 * Workflows supported:
 *   - TenantOnboardingWorkflow
 *   - OrderFulfillmentWorkflow
 *   - InventorySyncWorkflow
 *   - BroadcastCampaignWorkflow
 */
import { ENV } from "./_core/env";
import { getDb } from "./db";
import { temporalWorkflowRuns } from "../drizzle/schema";
import { eq } from "drizzle-orm";

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";
const TASK_QUEUE = "whatsapp-commerce";

// Lazy-loaded Temporal client (only when TEMPORAL_ADDRESS is set)
let _client: unknown = null;
let _connectAttempted = false;

async function getTemporalClient(): Promise<unknown | null> {
  if (_client) return _client;
  if (_connectAttempted) return null;
  _connectAttempted = true;
  if (!process.env.TEMPORAL_ADDRESS) {
    console.info("[Temporal] TEMPORAL_ADDRESS not set — workflow features disabled");
    return null;
  }
  try {
    const { Client, Connection } = await import("@temporalio/client");
    const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
    _client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
    console.info("[Temporal] Connected to", TEMPORAL_ADDRESS);
    return _client;
  } catch (err: any) {
    console.warn("[Temporal] Failed to connect:", err.message);
    return null;
  }
}

export interface WorkflowStartResult {
  workflowId: string;
  runId: string;
  started: boolean;
  error?: string;
}

/**
 * Start a Temporal workflow and record it in the DB.
 * Falls back to a no-op with a local DB record if Temporal is unavailable.
 */
export async function startWorkflow(
  workflowType: string,
  input: Record<string, unknown>,
  options: {
    workflowId?: string;
    tenantId?: string;
    entityId?: string;
    executionTimeout?: string;
  } = {}
): Promise<WorkflowStartResult> {
  const workflowId = options.workflowId ?? `${workflowType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const db = await getDb();

  try {
    const client = await getTemporalClient();
    if (client) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handle = await (client as any).workflow.start(workflowType, {
        taskQueue: TASK_QUEUE,
        workflowId,
        args: [input],
        workflowExecutionTimeout: options.executionTimeout ?? "7 days",
      });
      const runId: string = handle.firstExecutionRunId;
      // Persist to DB
      if (db) {
        await db.insert(temporalWorkflowRuns).values({
          workflowId,
          runId,
          workflowType,
          taskQueue: TASK_QUEUE,
          tenantId: options.tenantId,
          entityId: options.entityId,
          status: "running",
          input,
          startedAt: new Date(),
        }).onConflictDoNothing();
      }
      console.info(`[Temporal] Started ${workflowType} workflowId=${workflowId} runId=${runId}`);
      return { workflowId, runId, started: true };
    }
  } catch (err: any) {
    console.warn(`[Temporal] Failed to start ${workflowType}:`, err.message);
  }

  // Fallback: record as a local workflow run with a synthetic runId
  const syntheticRunId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (db) {
    try {
      await db.insert(temporalWorkflowRuns).values({
        workflowId,
        runId: syntheticRunId,
        workflowType,
        taskQueue: TASK_QUEUE,
        tenantId: options.tenantId,
        entityId: options.entityId,
        status: "running",
        input,
        startedAt: new Date(),
      }).onConflictDoNothing();
    } catch { /* ignore */ }
  }
  return { workflowId, runId: syntheticRunId, started: false, error: "temporal_unavailable" };
}

/**
 * Mark a workflow run as completed/failed in the DB.
 * Called from webhook callbacks or polling.
 */
export async function updateWorkflowStatus(
  runId: string,
  status: "completed" | "failed" | "cancelled" | "timed_out" | "terminated",
  result?: Record<string, unknown>,
  errorMessage?: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const closedAt = new Date();
  try {
    const [existing] = await db
      .select({ startedAt: temporalWorkflowRuns.startedAt })
      .from(temporalWorkflowRuns)
      .where(eq(temporalWorkflowRuns.runId, runId))
      .limit(1);
    const durationMs = existing
      ? closedAt.getTime() - new Date(existing.startedAt).getTime()
      : undefined;
    await db
      .update(temporalWorkflowRuns)
      .set({ status, result, errorMessage, closedAt, durationMs })
      .where(eq(temporalWorkflowRuns.runId, runId));
  } catch (err: any) {
    console.warn("[Temporal] updateWorkflowStatus failed:", err.message);
  }
}

/**
 * Query the status of a running workflow from Temporal.
 */
export async function queryWorkflowStatus(workflowId: string): Promise<{
  status: string;
  runId?: string;
  result?: unknown;
  error?: string;
}> {
  try {
    const client = await getTemporalClient();
    if (client) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handle = (client as any).workflow.getHandle(workflowId);
      const desc = await handle.describe();
      return {
        status: desc.status.name.toLowerCase(),
        runId: desc.runId,
      };
    }
  } catch (err: any) {
    // Fall through to DB lookup
  }
  // DB fallback
  const db = await getDb();
  if (db) {
    const [row] = await db
      .select()
      .from(temporalWorkflowRuns)
      .where(eq(temporalWorkflowRuns.workflowId, workflowId))
      .limit(1);
    if (row) return { status: row.status, runId: row.runId, result: row.result ?? undefined };
  }
  return { status: "unknown", error: "not_found" };
}

/** Health check — pings the Temporal frontend service */
export async function temporalHealthCheck(): Promise<{ online: boolean; latencyMs?: number; error?: string }> {
  if (!process.env.TEMPORAL_ADDRESS) return { online: false, error: "not_configured" };
  try {
    const t0 = Date.now();
    const client = await getTemporalClient();
    if (client) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (client as any).connection.workflowService.getSystemInfo({});
      return { online: true, latencyMs: Date.now() - t0 };
    }
    return { online: false, error: "client_unavailable" };
  } catch (err: any) {
    return { online: false, error: err.message };
  }
}

// ── Convenience wrappers for each workflow type ────────────────────────────────

export async function startTenantOnboardingWorkflow(input: {
  tenantId: string;
  applicantEmail: string;
  billingModel: "profit_sharing" | "subscription" | "hybrid";
  kycApplicationId: string;
}): Promise<WorkflowStartResult> {
  return startWorkflow("TenantOnboardingWorkflow", input, {
    workflowId: `tenant-onboarding-${input.tenantId}`,
    tenantId: input.tenantId,
    entityId: input.tenantId,
    executionTimeout: "7 days",
  });
}

export async function startOrderFulfillmentWorkflow(input: {
  orderId: string;
  tenantId: string;
  customerId: string;
  items: Array<{ productId: string; quantity: number; price: number }>;
  totalAmount: number;
  waPhoneNumber: string;
}): Promise<WorkflowStartResult> {
  return startWorkflow("OrderFulfillmentWorkflow", input, {
    workflowId: `order-fulfillment-${input.orderId}`,
    tenantId: input.tenantId,
    entityId: input.orderId,
    executionTimeout: "1 hour",
  });
}

export async function startInventorySyncWorkflow(input: {
  tenantId?: string;
  odooUrl: string;
  odooDb: string;
}): Promise<WorkflowStartResult> {
  const id = input.tenantId ?? "all";
  return startWorkflow("InventorySyncWorkflow", input, {
    workflowId: `inventory-sync-${id}-${Date.now()}`,
    tenantId: input.tenantId,
    entityId: id,
    executionTimeout: "30 minutes",
  });
}

export async function startBroadcastCampaignWorkflow(input: {
  campaignId: string;
  tenantId: string;
  templateId: string;
  recipientCount: number;
  batchSize: number;
  scheduledAt: string;
}): Promise<WorkflowStartResult> {
  return startWorkflow("BroadcastCampaignWorkflow", input, {
    workflowId: `broadcast-${input.campaignId}`,
    tenantId: input.tenantId,
    entityId: input.campaignId,
    executionTimeout: "24 hours",
  });
}
