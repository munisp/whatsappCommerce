/**
 * shared/tenantConfig.ts — per-tenant customization config contracts.
 *
 * All config lives under tenants.settings (JSONB):
 *   settings.commerce    — currency, fee overrides, pickup, delivery zones
 *   settings.branding    — admin/storefront branding
 *   settings.crm         — custom fields + pipeline stages
 *   settings.inventory   — stock source + thresholds
 *   settings.integrations— { medusa|twenty|odoo }. { url, apiKey, enabled }
 *   settings.whatsapp    — { accessToken } (phoneNumberId is a tenants column)
 *   settings.waMenu      — see shared/waMenu.ts
 *   settings.onboarding  — provisioning state machine (see server/services/onboarding.ts)
 */
import { z } from "zod";
import { DEFAULT_WA_MENU, type WaMenuConfig } from "./waMenu";

// ─── CRM ─────────────────────────────────────────────────────────────────────

export const crmCustomFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9_]*$/, "field key must be lowercase snake_case"),
  label: z.string().trim().min(1, "field label must not be empty").max(80),
  type: z.enum(["text", "number", "date", "select", "boolean"]),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1)).max(50).optional(),
});

export type CrmCustomField = z.infer<typeof crmCustomFieldSchema>;

export const pipelineStageSchema = z
  .string()
  .trim()
  .min(1, "pipeline stage must not be empty")
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "stage must be lowercase alphanumeric (with - or _)");

export const crmConfigSchema = z.object({
  customFields: z.array(crmCustomFieldSchema).max(50),
  pipelineStages: z.array(pipelineStageSchema).min(2, "pipeline needs at least 2 stages").max(20),
});

export type CrmConfig = z.infer<typeof crmConfigSchema>;

// ─── Inventory ───────────────────────────────────────────────────────────────

export const inventoryConfigSchema = z.object({
  source: z.enum(["local", "medusa", "odoo"]),
  lowStockThreshold: z.number().int().min(0).max(100000),
});

export type InventoryConfig = z.infer<typeof inventoryConfigSchema>;

// ─── Commerce ────────────────────────────────────────────────────────────────

export const deliveryZoneSchema = z.object({
  name: z.string().trim().min(1, "zone name must not be empty").max(80),
  fee: z.number().min(0),
  currency: z.string().length(3).optional(),
  estimatedDays: z.number().int().min(0).max(60).optional(),
  // Optional base ETA (minutes) for this zone — consumed by the ETA engine
  // (server/services/eta.ts). Defaults: 45 same-city / 180 intercity.
  etaMinutes: z.number().int().min(1).max(10080).optional(),
});

export const commerceConfigSchema = z.object({
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO code"),
  pickupEnabled: z.boolean(),
  deliveryZones: z.array(deliveryZoneSchema).max(50),
  feeOverrides: z
    .object({
      platformFeeRate: z.number().min(0).max(0.5).optional(),
      deliveryFeeFlat: z.number().min(0).optional(),
    })
    .partial()
    .optional(),
});

export type CommerceConfig = z.infer<typeof commerceConfigSchema>;
export type DeliveryZone = z.infer<typeof deliveryZoneSchema>;

// ─── Branding ────────────────────────────────────────────────────────────────

export const brandingConfigSchema = z.object({
  name: z.string().trim().min(1, "brand name must not be empty").max(120),
  logoUrl: z.string().url().nullable(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "primaryColor must be a hex color like #8A5A2B"),
});

export type BrandingConfig = z.infer<typeof brandingConfigSchema>;

// ─── Domains ─────────────────────────────────────────────────────────────────
// settings.domains: string[] of hosts the tenant's storefront answers on
// (see server/_core/tenantDomain.ts resolution).

export const tenantDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "domain must be a valid hostname like shop.example.com",
  );

export const tenantDomainsSchema = z
  .array(tenantDomainSchema)
  .max(20)
  .refine((list) => new Set(list).size === list.length, { message: "duplicate domains" });

// ─── Integrations ────────────────────────────────────────────────────────────

export const integrationCredsSchema = z.object({
  url: z.string().url(),
  apiKey: z.string().min(1, "apiKey must not be empty"),
  enabled: z.boolean().default(false),
});

export type IntegrationCreds = z.infer<typeof integrationCredsSchema>;

export const INTEGRATION_PROVIDERS = ["medusa", "twenty", "odoo"] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const integrationsConfigSchema = z.object({
  medusa: integrationCredsSchema.optional(),
  twenty: integrationCredsSchema.optional(),
  odoo: integrationCredsSchema.optional(),
});

export type IntegrationsConfig = z.infer<typeof integrationsConfigSchema>;

// ─── Aggregate settings skeleton ─────────────────────────────────────────────

export interface TenantSettings {
  commerce: CommerceConfig;
  branding: BrandingConfig;
  crm: CrmConfig;
  inventory: InventoryConfig;
  integrations: IntegrationsConfig;
  whatsapp?: { accessToken?: string };
  waMenu: WaMenuConfig;
  onboarding?: {
    status: "draft" | "configuring" | "validating" | "live" | "failed";
    reasons?: string[];
    completedSteps?: string[];
    validationPassed?: boolean;
    validatedAt?: string | null;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Default settings skeleton seeded at provisioning time. */
export function buildDefaultTenantSettings(businessName: string): TenantSettings {
  return {
    commerce: { currency: "NGN", pickupEnabled: true, deliveryZones: [] },
    branding: { name: businessName, logoUrl: null, primaryColor: "#8A5A2B" },
    crm: { customFields: [], pipelineStages: ["new", "qualified", "won", "lost"] },
    inventory: { source: "local", lowStockThreshold: 5 },
    integrations: {},
    whatsapp: {},
    waMenu: JSON.parse(JSON.stringify(DEFAULT_WA_MENU)) as WaMenuConfig,
    onboarding: {
      status: "draft",
      reasons: [],
      completedSteps: [],
      validationPassed: false,
      validatedAt: null,
    },
  };
}
