/**
 * Workflow versioning constants + task queue name.
 *
 * Imported by BOTH the workflow bundle (Temporal's deterministic sandbox — so this file
 * must stay pure: no Node built-ins, no process.env) and the worker process. The worker
 * build id lives in worker.ts because it reads the environment.
 *
 * Bump a workflow's version whenever a change would alter the command sequence of an
 * in-flight execution, and guard the changed branch with `patched("<change-id>")` from
 * @temporalio/workflow so replays of older histories stay deterministic.
 */
export const TASK_QUEUE = "whatsapp-commerce";

export const WORKFLOW_VERSIONS = {
  tenantOnboarding: 3,
  orderFulfillment: 3,
  inventorySync: 2,
  broadcastCampaign: 2,
  journeyOrchestration: 1,
} as const;

export type WorkflowName = keyof typeof WORKFLOW_VERSIONS;

/** Deterministic build-id fragment: the version tuple, e.g. "3.3.2.2.1". */
export const VERSION_TUPLE = Object.values(WORKFLOW_VERSIONS).join(".");

/** Worker build id — the version tuple unless a deploy overrides it (TEMPORAL_WORKER_BUILD_ID). */
export function workerBuildId(override?: string): string {
  return override?.trim() || `whatsapp-commerce@${VERSION_TUPLE}`;
}
