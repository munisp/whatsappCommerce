/**
 * WhatsApp Commerce — Temporal Workflow Definitions (TypeScript SDK)
 * 
 * These workflows run inside Temporal workers. Each workflow is:
 * - Durable: survives process restarts
 * - Retryable: activities auto-retry with configurable backoff
 * - Observable: full history in Temporal UI
 * 
 * Deploy: temporal worker start --task-queue whatsapp-commerce
 */

// ─── Workflow Versioning (W42 / PLT-10) ───────────────────────────────────────
// @temporalio/workflow is not a declared dependency in this repo (only the
// client is), so Temporal's `patch()` API is unavailable at typecheck time.
// These DETERMINISTIC version constants are the in-repo versioning story:
// every behavior-changing edit to a workflow MUST bump that workflow's
// version and add a `versionGate("<change-id>", <version>)` branch at the
// change point so replays of in-flight histories stay deterministic.
// When @temporalio/workflow is added, swap versionGate() call sites for
// `patched("<change-id>")` — the change ids below are chosen to carry over.

export const WORKFLOW_VERSIONS = {
  tenantOnboarding: 2,
  orderFulfillment: 2,
  inventorySync: 1,
  broadcastCampaign: 1,
} as const;

export type WorkflowName = keyof typeof WORKFLOW_VERSIONS;

/** Worker build id (Temporal worker versioning). Overridable per deploy. */
export const WORKER_BUILD_ID =
  process.env.TEMPORAL_WORKER_BUILD_ID ??
  `whatsapp-commerce@${Object.values(WORKFLOW_VERSIONS).join(".")}`;

/**
 * Deterministic version gate, `patched()`-compatible in shape: returns true
 * when the running code version for `workflow` is >= `minVersion`. Replay
 * safety comes from the rule that old code paths are never deleted below the
 * recorded version — exactly the discipline Temporal's patch() enforces.
 */
export function versionGate(
  workflow: WorkflowName,
  changeId: string,
  minVersion: number
): boolean {
  const current = WORKFLOW_VERSIONS[workflow];
  const isNew = current >= minVersion;
  if (!isNew) {
    console.log(
      `[workflow-version] ${workflow} replaying pre-${changeId} history (v${current} < v${minVersion})`
    );
  }
  return isNew;
}

// ─── Type Definitions ─────────────────────────────────────────────────────────
export interface TenantOnboardingInput {
  tenantId: string;
  applicantEmail: string;
  billingModel: "profit_sharing" | "subscription" | "hybrid";
  kycApplicationId: string;
}

export interface OrderFulfillmentInput {
  orderId: string;
  tenantId: string;
  customerId: string;
  items: Array<{ productId: string; quantity: number; price: number }>;
  totalAmount: number;
  waPhoneNumber: string;
}

export interface InventorySyncInput {
  tenantId?: string;  // undefined = sync all tenants
  odooUrl: string;
  odooDb: string;
}

export interface BroadcastCampaignInput {
  campaignId: string;
  tenantId: string;
  templateId: string;
  recipientCount: number;
  batchSize: number;
  scheduledAt: string;
}

// ─── Activity Handlers (W42 / PLT-10: auto-approve stubs REMOVED) ─────────────
// The previous revision of this file carried console.log stubs whose
// waitForKycApproval() returned the FIXED value "approved" and
// confirmPayment()/reserveInventory() returned fixed `true` — deploying the
// worker with those stubs would have auto-approved KYC and auto-confirmed
// payments. That is gone. Activities are now:
//   1. REAL handlers registered via registerActivityHandlers() — the worker
//      (worker.ts) wires its API-backed implementations at boot; OR
//   2. HONEST FAILURES: with no handler registered, every activity throws
//      `activity_not_wired`. Money/KYC paths NEVER fabricate success.

export type KycDecision = "approved" | "rejected" | "resubmit_required";

export interface ActivityHandlers {
  submitKycForReview(applicationId: string): Promise<void>;
  waitForKycApproval(applicationId: string): Promise<KycDecision>;
  setupBillingPlan(tenantId: string, model: string): Promise<void>;
  validateWhatsAppCredentials(tenantId: string): Promise<boolean>;
  activateTenant(tenantId: string): Promise<void>;
  sendWelcomeMessage(tenantId: string, email: string): Promise<void>;
  confirmPayment(orderId: string): Promise<boolean>;
  reserveInventory(items: OrderFulfillmentInput["items"]): Promise<boolean>;
  syncOrderToOdoo(orderId: string): Promise<void>;
  sendOrderConfirmationWhatsApp(orderId: string, phone: string): Promise<void>;
  pullOdooStock(odooUrl: string, odooDb: string): Promise<Record<string, number>>;
  updateInventorySnapshots(stockData: Record<string, number>): Promise<number>;
  sendLowStockAlerts(lowStockItems: string[]): Promise<void>;
  buildAudience(campaignId: string): Promise<string[]>;
  sendBroadcastBatch(campaignId: string, recipients: string[], templateId: string): Promise<number>;
}

let _handlers: ActivityHandlers | null = null;

/** Wire real activity implementations (worker.ts calls this at boot). */
export function registerActivityHandlers(handlers: ActivityHandlers): void {
  _handlers = handlers;
}

/** Test/diagnostics: true when real handlers are wired. */
export function hasActivityHandlers(): boolean {
  return _handlers !== null;
}

function notWired(name: keyof ActivityHandlers): never {
  throw new Error(
    `[temporal] activity_not_wired: "${String(name)}" has no registered handler. ` +
      `Refusing to fabricate a result (the W36 auto-approve stub was removed in W42). ` +
      `Register real handlers via registerActivityHandlers() — worker.ts does this at boot.`
  );
}

function wired<K extends keyof ActivityHandlers>(name: K): ActivityHandlers[K] {
  return (_handlers?.[name] ?? (() => notWired(name))) as ActivityHandlers[K];
}

export const activities: ActivityHandlers = {
  async submitKycForReview(applicationId) {
    return wired("submitKycForReview")(applicationId);
  },

  async waitForKycApproval(applicationId) {
    // NEVER returns a fixed "approved" — a real handler polls
    // kyc.getApplication and throws while the decision is still pending.
    return wired("waitForKycApproval")(applicationId);
  },

  async setupBillingPlan(tenantId, model) {
    return wired("setupBillingPlan")(tenantId, model);
  },

  async validateWhatsAppCredentials(tenantId) {
    return wired("validateWhatsAppCredentials")(tenantId);
  },

  async activateTenant(tenantId) {
    return wired("activateTenant")(tenantId);
  },

  async sendWelcomeMessage(tenantId, email) {
    return wired("sendWelcomeMessage")(tenantId, email);
  },

  // Order Activities — money path: NEVER auto-true without a wired handler.
  async confirmPayment(orderId) {
    return wired("confirmPayment")(orderId);
  },

  async reserveInventory(items) {
    return wired("reserveInventory")(items);
  },

  async syncOrderToOdoo(orderId) {
    return wired("syncOrderToOdoo")(orderId);
  },

  async sendOrderConfirmationWhatsApp(orderId, phone) {
    return wired("sendOrderConfirmationWhatsApp")(orderId, phone);
  },

  async pullOdooStock(odooUrl, odooDb) {
    return wired("pullOdooStock")(odooUrl, odooDb);
  },

  async updateInventorySnapshots(stockData) {
    return wired("updateInventorySnapshots")(stockData);
  },

  async sendLowStockAlerts(lowStockItems) {
    return wired("sendLowStockAlerts")(lowStockItems);
  },

  async buildAudience(campaignId) {
    return wired("buildAudience")(campaignId);
  },

  async sendBroadcastBatch(campaignId, recipients, templateId) {
    return wired("sendBroadcastBatch")(campaignId, recipients, templateId);
  },
};

// ─── Workflow Definitions ─────────────────────────────────────────────────────
// Note: In production, use @temporalio/workflow with proxyActivities()
// These are pseudocode-style definitions showing the workflow logic.

/**
 * TenantOnboardingWorkflow
 * Orchestrates the full tenant onboarding: KYC → billing → WhatsApp → activate
 * Timeout: 7 days (KYC review can take time)
 */
export async function TenantOnboardingWorkflow(input: TenantOnboardingInput): Promise<void> {
  console.log(`[workflow] TenantOnboarding started for ${input.tenantId} (v${WORKFLOW_VERSIONS.tenantOnboarding})`);

  // W42 change marker "no-auto-approve-kyc": v2 requires a wired KYC handler;
  // v1 replay histories (stub era) are retired — see WORKFLOW_VERSIONS notes.
  versionGate("tenantOnboarding", "no-auto-approve-kyc", 2);

  // Step 1: Submit KYC for review
  await activities.submitKycForReview(input.kycApplicationId);

  // Step 2: Wait for KYC decision (up to 7 days)
  const kycDecision = await activities.waitForKycApproval(input.kycApplicationId);
  if (kycDecision === "rejected") {
    await activities.sendWelcomeMessage(input.tenantId, input.applicantEmail);
    throw new Error(`KYC rejected for tenant ${input.tenantId}`);
  }
  if (kycDecision === "resubmit_required") {
    // Signal tenant to resubmit — workflow waits for signal
    console.log(`[workflow] Waiting for KYC resubmission from ${input.tenantId}`);
    return; // In production: use Temporal signals
  }

  // Step 3: Setup billing
  await activities.setupBillingPlan(input.tenantId, input.billingModel);

  // Step 4: Validate WhatsApp
  const waValid = await activities.validateWhatsAppCredentials(input.tenantId);
  if (!waValid) {
    console.warn(`[workflow] WhatsApp credentials invalid for ${input.tenantId} — activating anyway`);
  }

  // Step 5: Activate tenant
  await activities.activateTenant(input.tenantId);
  await activities.sendWelcomeMessage(input.tenantId, input.applicantEmail);

  console.log(`[workflow] TenantOnboarding complete for ${input.tenantId}`);
}

/**
 * OrderFulfillmentWorkflow
 * Handles order lifecycle: payment → inventory → ERP sync → WhatsApp notify
 * Timeout: 1 hour
 */
export async function OrderFulfillmentWorkflow(input: OrderFulfillmentInput): Promise<void> {
  console.log(`[workflow] OrderFulfillment started for order ${input.orderId} (v${WORKFLOW_VERSIONS.orderFulfillment})`);

  // W42 change marker "no-auto-confirm-payment": payment confirmation must
  // come from a wired handler reading the real payment status.
  versionGate("orderFulfillment", "no-auto-confirm-payment", 2);

  const paymentOk = await activities.confirmPayment(input.orderId);
  if (!paymentOk) throw new Error(`Payment failed for order ${input.orderId}`);

  const inventoryOk = await activities.reserveInventory(input.items);
  if (!inventoryOk) throw new Error(`Inventory reservation failed for order ${input.orderId}`);

  await activities.syncOrderToOdoo(input.orderId);
  await activities.sendOrderConfirmationWhatsApp(input.orderId, input.waPhoneNumber);

  console.log(`[workflow] OrderFulfillment complete for ${input.orderId}`);
}

/**
 * InventorySyncWorkflow
 * Pulls stock from Odoo, updates snapshots, sends low-stock alerts.
 * Triggered by heartbeat every 5 minutes.
 */
export async function InventorySyncWorkflow(input: InventorySyncInput): Promise<void> {
  const stockData = await activities.pullOdooStock(input.odooUrl, input.odooDb);
  const updatedCount = await activities.updateInventorySnapshots(stockData);

  const lowStockItems = Object.entries(stockData)
    .filter(([, qty]) => qty < 10)
    .map(([id]) => id);

  await activities.sendLowStockAlerts(lowStockItems);
  console.log(`[workflow] InventorySync complete: ${updatedCount} products updated, ${lowStockItems.length} low-stock alerts`);
}

/**
 * BroadcastCampaignWorkflow
 * Builds audience, sends in batches, tracks delivery.
 * Timeout: 24 hours
 */
export async function BroadcastCampaignWorkflow(input: BroadcastCampaignInput): Promise<void> {
  const audience = await activities.buildAudience(input.campaignId);
  let sent = 0;

  for (let i = 0; i < audience.length; i += input.batchSize) {
    const batch = audience.slice(i, i + input.batchSize);
    sent += await activities.sendBroadcastBatch(input.campaignId, batch, input.templateId);
    // Rate limiting: 1 batch per second
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`[workflow] BroadcastCampaign complete: ${sent}/${audience.length} messages sent`);
}

