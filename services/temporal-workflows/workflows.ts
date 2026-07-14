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

// ─── Activity Stubs ───────────────────────────────────────────────────────────
// In production, these call your tRPC/REST endpoints or database directly.

export const activities = {
  // KYC Activities
  async submitKycForReview(applicationId: string): Promise<void> {
    console.log(`[temporal] Submitting KYC application ${applicationId} for review`);
    // POST /api/trpc/kyc.submit
  },

  async waitForKycApproval(applicationId: string): Promise<"approved" | "rejected" | "resubmit_required"> {
    console.log(`[temporal] Polling KYC status for ${applicationId}`);
    // Poll /api/trpc/kyc.getApplication every 30s until status changes
    return "approved"; // stub
  },

  // Billing Activities
  async setupBillingPlan(tenantId: string, model: string): Promise<void> {
    console.log(`[temporal] Setting up ${model} billing for tenant ${tenantId}`);
  },

  // WhatsApp Activities
  async validateWhatsAppCredentials(tenantId: string): Promise<boolean> {
    console.log(`[temporal] Validating WhatsApp credentials for ${tenantId}`);
    return true;
  },

  async activateTenant(tenantId: string): Promise<void> {
    console.log(`[temporal] Activating tenant ${tenantId}`);
    // PATCH /api/trpc/tenant.update { status: "active" }
  },

  async sendWelcomeMessage(tenantId: string, email: string): Promise<void> {
    console.log(`[temporal] Sending welcome email to ${email}`);
  },

  // Order Activities
  async confirmPayment(orderId: string): Promise<boolean> {
    console.log(`[temporal] Confirming payment for order ${orderId}`);
    return true;
  },

  async reserveInventory(items: OrderFulfillmentInput["items"]): Promise<boolean> {
    console.log(`[temporal] Reserving inventory for ${items.length} items`);
    // Uses atomic SQL oversell guard
    return true;
  },

  async syncOrderToOdoo(orderId: string): Promise<void> {
    console.log(`[temporal] Syncing order ${orderId} to Odoo ERP`);
  },

  async sendOrderConfirmationWhatsApp(orderId: string, phone: string): Promise<void> {
    console.log(`[temporal] Sending order confirmation to ${phone}`);
  },

  // Inventory Activities
  async pullOdooStock(odooUrl: string, odooDb: string): Promise<Record<string, number>> {
    console.log(`[temporal] Pulling stock from Odoo at ${odooUrl}`);
    return {}; // stub: returns { productId: quantity }
  },

  async updateInventorySnapshots(stockData: Record<string, number>): Promise<number> {
    console.log(`[temporal] Updating ${Object.keys(stockData).length} inventory snapshots`);
    return Object.keys(stockData).length;
  },

  async sendLowStockAlerts(lowStockItems: string[]): Promise<void> {
    if (lowStockItems.length > 0) {
      console.log(`[temporal] Sending low-stock alerts for ${lowStockItems.length} items`);
    }
  },

  // Broadcast Activities
  async buildAudience(campaignId: string): Promise<string[]> {
    console.log(`[temporal] Building audience for campaign ${campaignId}`);
    return []; // stub: returns list of phone numbers
  },

  async sendBroadcastBatch(campaignId: string, recipients: string[], templateId: string): Promise<number> {
    console.log(`[temporal] Sending batch of ${recipients.length} messages for campaign ${campaignId}`);
    return recipients.length;
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
  console.log(`[workflow] TenantOnboarding started for ${input.tenantId}`);

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
  console.log(`[workflow] OrderFulfillment started for order ${input.orderId}`);

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

