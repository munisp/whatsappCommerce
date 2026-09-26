/**
 * WhatsApp Commerce — Temporal workflow definitions (real @temporalio/workflow SDK).
 *
 * Workflow code runs in Temporal's deterministic sandbox: no fetch, no process.env, no
 * Node built-ins, no non-deterministic APIs. Every side effect goes through an activity
 * (activities.ts) via proxyActivities; timers use sleep()/condition(); logging uses `log`.
 * Only pure modules (versions, types, failureTypes) and TYPE-only imports of activities
 * are allowed here — importing activities.ts at runtime would drag @temporalio/activity
 * into the bundle.
 *
 * Status (see activities.ts): InventorySyncWorkflow is fully backed and live-tested. The
 * onboarding / order / broadcast workflows are real SDK code but their activities still
 * fail honestly with ActivityNotImplemented until internal endpoints exist for them.
 * Deploy: services/temporal-workflows/worker.ts on task queue "whatsapp-commerce".
 */
import {
  ApplicationFailure,
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
  log,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import type { Activities } from "./activities";
import { FAILURE_NOT_IMPLEMENTED, FAILURE_PLATFORM_REJECTED } from "./failureTypes";
import type {
  BroadcastCampaignInput,
  InventorySyncInput,
  InventorySyncResult,
  JourneyOrchestrationInput,
  JourneyOrchestrationResult,
  OrderFulfillmentInput,
  TenantOnboardingInput,
} from "./types";
import { WORKFLOW_VERSIONS } from "./versions";

// Standard activity policy: transient platform errors are retried with backoff; a rejection
// (4xx) or a not-implemented step is not — retrying those only delays an inevitable failure.
const NON_RETRYABLE = [FAILURE_PLATFORM_REJECTED, FAILURE_NOT_IMPLEMENTED];

const act = proxyActivities<Activities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 5,
    nonRetryableErrorTypes: NON_RETRYABLE,
  },
});

// A tenant sync can touch thousands of product rows — give it a longer leash than the default.
const slowAct = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "2 minutes",
    maximumAttempts: 3,
    nonRetryableErrorTypes: NON_RETRYABLE,
  },
});

// Journey steps call real services (orders, credit, audit) through the server, so each gets a
// longer leash. Retrying is safe: every step carries the deterministic idempotency key
// `${runId}:${activityName}` and a checkpointed step is never re-executed.
const journeyAct = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 5,
    nonRetryableErrorTypes: NON_RETRYABLE,
  },
});

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── JourneyOrchestrationWorkflow ──────────────────────────────────────────────
/** The innermost message of a failure chain (WorkflowFailed → ActivityFailure → ApplicationFailure). */
function rootMessage(err: unknown): string {
  let cur: any = err;
  while (cur?.cause) cur = cur.cause;
  return String(cur?.message ?? err).slice(0, 1000);
}

/**
 * Runs a registered journey as a durable sequence. This workflow only SEQUENCES: the plan and
 * every step live in the server's journey registry (journeyOrchestrator.ts) and run through the
 * internal endpoints — business logic is never reimplemented here. Step outputs stay in the run's
 * checkpoints server-side, so no order/PII data enters Temporal history.
 *
 * The run's temporal_workflow_runs row is ALWAYS closed — completed, failed or cancelled — so a
 * dead journey never sits "running" (the cron tick deliberately ignores Temporal-owned runs).
 */
export async function JourneyOrchestrationWorkflow(input: JourneyOrchestrationInput): Promise<JourneyOrchestrationResult> {
  // The server keys the run row by the FIRST execution's run id (see startWorkflow).
  const runId = workflowInfo().firstExecutionRunId;
  log.info("JourneyOrchestration started", { version: WORKFLOW_VERSIONS.journeyOrchestration, journeyId: input.journeyId, runId });

  const executed: string[] = [];
  try {
    const plan = await act.getJourneyPlan(input.journeyId);
    for (const name of plan) {
      await journeyAct.runJourneyActivity(runId, name);
      executed.push(name);
    }
  } catch (err) {
    const status = isCancellation(err) ? "cancelled" : "failed";
    // Must run even when the workflow itself is being cancelled.
    await CancellationScope.nonCancellable(async () => {
      try {
        await act.finishJourney(runId, status, rootMessage(err));
      } catch (finishErr) {
        // Never mask the original failure with a bookkeeping failure.
        log.warn("could not close the journey run row", { runId, error: rootMessage(finishErr) });
      }
    });
    throw err;
  }

  await act.finishJourney(runId, "completed");
  log.info("JourneyOrchestration complete", { journeyId: input.journeyId, runId, steps: executed.length });
  return { journeyId: input.journeyId, executed };
}

// ─── InventorySyncWorkflow ─────────────────────────────────────────────────────
/**
 * Syncs Odoo-synced stock into inventory_snapshots, per tenant. One tenant failing never
 * aborts the others — it is recorded in `failed` and the run still completes, matching the
 * heartbeat's behavior (runInventorySyncHeartbeat). Idempotent: safe to run repeatedly.
 */
export async function InventorySyncWorkflow(input: InventorySyncInput = {}): Promise<InventorySyncResult> {
  log.info("InventorySync started", { version: WORKFLOW_VERSIONS.inventorySync, tenantId: input.tenantId ?? "all" });

  const tenantIds = input.tenantId ? [input.tenantId] : await act.listInventorySyncTenants();

  const failed: string[] = [];
  let recordsSynced = 0;
  for (const tenantId of tenantIds) {
    try {
      const res = await slowAct.syncTenantInventory(tenantId);
      recordsSynced += res.recordsSynced;
    } catch (err) {
      log.warn("tenant inventory sync failed", { tenantId, error: (err as Error).message });
      failed.push(tenantId);
    }
  }

  const result: InventorySyncResult = {
    tenants: tenantIds.length,
    succeeded: tenantIds.length - failed.length,
    failed,
    recordsSynced,
  };
  log.info("InventorySync complete", { ...result });
  return result;
}

// ─── TenantOnboardingWorkflow ──────────────────────────────────────────────────
/** Deliver a (new or replacement) KYB application id while the workflow is waiting. */
export const kycSubmittedSignal = defineSignal<[{ kycApplicationId: string }]>("kycSubmitted");

/**
 * KYC → billing → WhatsApp check → activation. Waits up to 7 days for a KYC decision,
 * polling durably with backoff (a sleep between polls, not an activity that throws until approved).
 * A rejection fails the workflow — it deliberately does NOT send the "welcome" message the
 * old pseudocode sent to rejected applicants.
 */
export async function TenantOnboardingWorkflow(input: TenantOnboardingInput): Promise<void> {
  log.info("TenantOnboarding started", { version: WORKFLOW_VERSIONS.tenantOnboarding, tenantId: input.tenantId });

  const deadline = Date.now() + 7 * DAY_MS;
  const remaining = () => Math.max(0, deadline - Date.now());

  // Signals can arrive before/while we wait; keep only the latest application id.
  let pendingApplicationId: string | undefined;
  setHandler(kycSubmittedSignal, ({ kycApplicationId }) => {
    pendingApplicationId = kycApplicationId;
  });

  // Provisioning may start the workflow before any KYB application exists.
  let applicationId = input.kycApplicationId;
  if (!applicationId) {
    const arrived = await condition(() => pendingApplicationId !== undefined, remaining());
    if (!arrived) throw ApplicationFailure.nonRetryable("no KYB application submitted within 7 days", "KycTimeout");
    applicationId = pendingApplicationId;
    pendingApplicationId = undefined;
  }

  await act.submitKycForReview(applicationId!);

  // Poll with exponential backoff (1 min → 1 h cap): a fixed short interval over 7 days would
  // add ~2,000 iterations to the workflow history, which Temporal caps at 51,200 events.
  let pollMs = 60_000;
  for (;;) {
    const decision = await act.getKycDecision(applicationId!);
    if (decision === "approved") break;
    if (decision === "rejected") {
      throw ApplicationFailure.nonRetryable(`KYC rejected for tenant ${input.tenantId}`, "KycRejected");
    }
    if (remaining() === 0) {
      throw ApplicationFailure.nonRetryable(`no KYC decision for tenant ${input.tenantId} within 7 days`, "KycTimeout");
    }
    if (decision === "resubmit_required") {
      const resubmitted = await condition(() => pendingApplicationId !== undefined, remaining());
      if (!resubmitted) throw ApplicationFailure.nonRetryable("KYC resubmission not received within 7 days", "KycTimeout");
      applicationId = pendingApplicationId;
      pendingApplicationId = undefined;
      await act.submitKycForReview(applicationId!);
    } else {
      await sleep(Math.min(pollMs, remaining())); // "pending"
      pollMs = Math.min(pollMs * 2, 60 * 60 * 1000);
    }
  }

  await act.setupBillingPlan(input.tenantId, input.billingModel);

  const waValid = await act.validateWhatsAppCredentials(input.tenantId);
  if (!waValid) log.warn("WhatsApp credentials not valid yet — continuing to activation", { tenantId: input.tenantId });

  await act.activateTenant(input.tenantId);
  await act.sendWelcomeMessage(input.tenantId, input.applicantEmail);
  log.info("TenantOnboarding complete", { tenantId: input.tenantId });
}

// ─── OrderFulfillmentWorkflow ──────────────────────────────────────────────────
/**
 * Payment → ERP sync → customer confirmation.
 *
 * Differences from the old pseudocode, on purpose:
 *  - Orders are created BEFORE they are paid, so payment is awaited (polled durably for up
 *    to 45 minutes) instead of failing the workflow on the first unpaid check.
 *  - There is no reserveInventory step: stock is already reserved atomically when the order
 *    is created (orderCrud.create → reserveStock); reserving again would double-count.
 */
export async function OrderFulfillmentWorkflow(input: OrderFulfillmentInput): Promise<void> {
  log.info("OrderFulfillment started", { version: WORKFLOW_VERSIONS.orderFulfillment, orderId: input.orderId });

  const paymentDeadline = Date.now() + 45 * 60 * 1000;
  let paid = await act.confirmPayment(input.orderId);
  while (!paid && Date.now() < paymentDeadline) {
    await sleep("30 seconds");
    paid = await act.confirmPayment(input.orderId);
  }
  if (!paid) {
    throw ApplicationFailure.nonRetryable(`payment not confirmed for order ${input.orderId} within 45 minutes`, "PaymentNotConfirmed");
  }

  await act.syncOrderToOdoo(input.orderId);
  await act.sendOrderConfirmationWhatsApp(input.orderId, input.waPhoneNumber);
  log.info("OrderFulfillment complete", { orderId: input.orderId });
}

// ─── BroadcastCampaignWorkflow ─────────────────────────────────────────────────
/** Builds the audience, then sends in batches at most one batch per second. */
export async function BroadcastCampaignWorkflow(input: BroadcastCampaignInput): Promise<{ sent: number; audience: number }> {
  log.info("BroadcastCampaign started", { version: WORKFLOW_VERSIONS.broadcastCampaign, campaignId: input.campaignId });

  const audience = await act.buildAudience(input.campaignId);
  let sent = 0;
  for (let i = 0; i < audience.length; i += input.batchSize) {
    sent += await act.sendBroadcastBatch(input.campaignId, audience.slice(i, i + input.batchSize), input.templateId);
    await sleep("1 second");
  }
  log.info("BroadcastCampaign complete", { campaignId: input.campaignId, sent, audience: audience.length });
  return { sent, audience: audience.length };
}
