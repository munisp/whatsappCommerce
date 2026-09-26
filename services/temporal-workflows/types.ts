/**
 * Workflow input/result types. Type-only — safe to import from workflows.ts, activities.ts
 * and (structurally) from server/temporal.ts, which starts these workflows by name.
 */
export interface TenantOnboardingInput {
  tenantId: string;
  applicantEmail: string;
  billingModel: "profit_sharing" | "subscription" | "hybrid";
  /** Optional at provisioning time — no KYB application may exist yet. */
  kycApplicationId?: string;
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
  /** Undefined = every tenant that has Odoo-synced products. */
  tenantId?: string;
  /** Accepted for compatibility with existing callers; the sync reads the local odoo_synced_products table. */
  odooUrl?: string;
  odooDb?: string;
}

export interface InventorySyncResult {
  tenants: number;
  succeeded: number;
  failed: string[];
  recordsSynced: number;
}

export interface BroadcastCampaignInput {
  campaignId: string;
  tenantId: string;
  templateId: string;
  recipientCount: number;
  batchSize: number;
  scheduledAt: string;
}

export type KycDecision = "approved" | "rejected" | "resubmit_required" | "pending";

export interface JourneyOrchestrationInput {
  journeyId: string;
  params: Record<string, unknown>;
}

/** Outputs stay server-side in the run's checkpoints — they never enter Temporal's history. */
export interface JourneyOrchestrationResult {
  journeyId: string;
  executed: string[];
}
