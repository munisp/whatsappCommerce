/**
 * erpProvision/index.ts — ERP-aware agentic configuration (roadmap F5).
 *
 * Frozen seam consumed by the onboarding copilot and the erpProvision router:
 *
 *   provisionErpTenantObjects(ctx: { tenantId }, opts?)
 *     Reads the tenant's profile (branding name + commerce/crm settings) and
 *     connected ERP configs, then idempotently provisions the standard
 *     objects each connector supports. Partial failure isolation: one ERP
 *     failing never blocks the others. Results are persisted to
 *     tenants.settings.erpProvision (jsonb — no migration needed) and
 *     audit-logged. Default is SAFE: pass { dryRun: true } for a preview.
 *
 *   applyCopilotConfig({ tenantId, intent, params, confirm, actorId? })
 *     Ongoing copilot-driven configuration intents beyond initial onboarding.
 *     Every intent is zod-validated, tenant-scoped, idempotent (no-op when
 *     the desired state already holds) and audit-logged. confirm: true is
 *     REQUIRED to apply — without it the call returns a dry-run preview.
 *
 * Registration: this module exposes its own router
 * (server/routers/erpProvision.ts); the onboarding copilot's intent handling
 * calls these functions directly — no edits to copilot core were needed.
 */
import { z } from "zod";
import { getDb } from "../../db";
import { tenants } from "../../../drizzle/schema";
import { eq } from "drizzle-orm";
import { writeAuditLog } from "../../routers/audit";
import { updateTenantSettings } from "../onboarding";
import {
  commerceConfigSchema,
  deliveryZoneSchema,
  pipelineStageSchema,
  buildDefaultTenantSettings,
  INTEGRATION_PROVIDERS,
  type TenantSettings,
} from "../../../shared/tenantConfig";
import {
  ERP_CONNECTORS,
  type ErpKind,
  type ProvisionObjectResult,
} from "./connectors";

export type { ErpKind, ProvisionObjectResult } from "./connectors";

// ─── Persisted provisioning state (tenants.settings.erpProvision jsonb) ─────

export interface ErpProvisionState {
  /** Adopted/created external objects, keyed "<erp>:<object>". */
  objects: Record<string, { externalId?: string | null; provisionedAt: string }>;
  lastRunAt: string | null;
  lastResults: ProvisionObjectResult[];
  /** Last 10 runs (newest last) for operator visibility. */
  runs: Array<{ at: string; dryRun: boolean; results: ProvisionObjectResult[] }>;
}

function readProvisionState(settings: TenantSettings): ErpProvisionState {
  const raw = (settings as Record<string, unknown>).erpProvision as
    | Partial<ErpProvisionState>
    | undefined;
  return {
    objects: raw?.objects && typeof raw.objects === "object" ? { ...raw.objects } : {},
    lastRunAt: typeof raw?.lastRunAt === "string" ? raw.lastRunAt : null,
    lastResults: Array.isArray(raw?.lastResults) ? (raw!.lastResults as ProvisionObjectResult[]) : [],
    runs: Array.isArray(raw?.runs) ? [...(raw!.runs as ErpProvisionState["runs"])] : [],
  };
}

async function loadTenant(tenantId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [tenant] = await db
    .select({ name: tenants.name, settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  const settings = {
    ...buildDefaultTenantSettings(tenant.name),
    ...((tenant.settings ?? {}) as TenantSettings),
  };
  return { tenant, settings };
}

// ─── provisionErpTenantObjects ───────────────────────────────────────────────

export interface ProvisionReport {
  ok: boolean;
  dryRun: boolean;
  results: ProvisionObjectResult[];
}

/**
 * Idempotently provision standard tenant objects in every connected ERP.
 * Second run returns 'exists' and never duplicates. `dryRun` (default false)
 * previews without any network call or state mutation.
 */
export async function provisionErpTenantObjects(
  ctx: { tenantId: string },
  opts: { dryRun?: boolean } = {},
): Promise<ProvisionReport> {
  const dryRun = opts.dryRun === true;
  const { tenant, settings } = await loadTenant(ctx.tenantId);
  const state = readProvisionState(settings);

  const businessName = settings.branding?.name?.trim() || tenant.name;
  const currency = settings.commerce?.currency ?? "NGN";
  const pipelineStages = settings.crm?.pipelineStages ?? [];
  const existing = state.objects;

  const results: ProvisionObjectResult[] = [];

  // Partial failure isolation: each connector is independent.
  for (const connector of ERP_CONNECTORS) {
    const configured = await connector.isConfigured(ctx.tenantId).catch(() => false);
    if (!configured) {
      results.push(
        ...connector.objects.map((object) => ({
          erp: connector.kind,
          object,
          status: "skipped" as const,
          error: `${connector.kind} not configured`,
        })),
      );
      continue;
    }
    if (!dryRun) {
      // Safety gate: provisioning requires a live/tested connection.
      const connErr = await connector.testConnection(ctx.tenantId);
      if (connErr) {
        results.push(
          ...connector.objects.map((object) => ({
            erp: connector.kind,
            object,
            status: "failed" as const,
            error: connErr,
          })),
        );
        continue;
      }
    }
    try {
      const connectorResults = await connector.provision({
        tenantId: ctx.tenantId,
        businessName,
        currency,
        pipelineStages,
        existing,
        dryRun,
      });
      results.push(...connectorResults);
    } catch (err: any) {
      // Whole-connector failure (e.g. odoo auth) — other ERPs unaffected.
      const message = err?.message ?? String(err);
      const covered = new Set(results.map((r) => `${r.erp}:${r.object}`));
      results.push(
        ...connector.objects
          .filter((object) => !covered.has(`${connector.kind}:${object}`))
          .map((object) => ({ erp: connector.kind, object, status: "failed" as const, error: message })),
      );
    }
  }

  const ok = results.every((r) => r.status !== "failed");

  if (!dryRun) {
    const now = new Date();
    const iso = now.toISOString();
    const applied = results.filter((r) => r.status === "created" || r.status === "exists");
    await updateTenantSettings(ctx.tenantId, (s) => {
      const prev = readProvisionState(s);
      const objects = { ...prev.objects };
      for (const r of applied) {
        const key = `${r.erp}:${r.object}`;
        if (!objects[key]) {
          objects[key] = { externalId: r.externalId ?? null, provisionedAt: iso };
        }
      }
      const runs = [...prev.runs, { at: iso, dryRun, results }].slice(-10);
      (s as Record<string, unknown>).erpProvision = {
        objects,
        lastRunAt: iso,
        lastResults: results,
        runs,
      } satisfies ErpProvisionState;
    });
    await writeAuditLog({
      actorId: "erp-provision",
      actorRole: "system",
      action: "erp_provision.run",
      entityType: "tenant",
      entityId: ctx.tenantId,
      tenantId: ctx.tenantId,
      summary: `ERP provisioning run: ${results.filter((r) => r.status === "created").length} created, ` +
        `${results.filter((r) => r.status === "exists").length} existing, ` +
        `${results.filter((r) => r.status === "failed").length} failed`,
      after: { ok, results },
    });
  }

  return { ok, dryRun, results };
}

// ─── applyCopilotConfig — ongoing configuration intents ─────────────────────

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a hex color like #8A5A2B");

export const CONFIG_INTENTS = [
  "set_delivery_zones",
  "set_pickup_enabled",
  "set_pipeline_stages",
  "set_low_stock_threshold",
  "toggle_catalog_sync",
  "update_branding",
] as const;
export type ConfigIntent = (typeof CONFIG_INTENTS)[number];

const setDeliveryZonesParams = z.object({
  zones: z.array(deliveryZoneSchema).min(1).max(50),
  mode: z.enum(["upsert", "replace"]).default("upsert"),
});
const setPickupEnabledParams = z.object({ enabled: z.boolean() });
const setPipelineStagesParams = z
  .object({ stages: z.array(pipelineStageSchema).min(2).max(20) })
  .refine((v) => new Set(v.stages).size === v.stages.length, {
    message: "duplicate pipeline stages",
  });
const setLowStockThresholdParams = z.object({ threshold: z.number().int().min(0).max(100000) });
const toggleCatalogSyncParams = z.object({
  provider: z.enum(INTEGRATION_PROVIDERS),
  enabled: z.boolean(),
});
const updateBrandingParams = z
  .object({
    tagline: z.string().max(120).optional(),
    waProfileAbout: z.string().max(139).optional(),
    secondaryColor: hexColor.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one branding field required" });

/** Intent parameter schemas — every copilot-supplied payload is validated. */
export const CONFIG_INTENT_PARAMS = {
  set_delivery_zones: setDeliveryZonesParams,
  set_pickup_enabled: setPickupEnabledParams,
  set_pipeline_stages: setPipelineStagesParams,
  set_low_stock_threshold: setLowStockThresholdParams,
  toggle_catalog_sync: toggleCatalogSyncParams,
  update_branding: updateBrandingParams,
} satisfies Record<ConfigIntent, z.ZodTypeAny>;

/** Human-readable intent catalog surfaced to the copilot. */
export const CONFIG_INTENT_CATALOG: Array<{
  intent: ConfigIntent;
  description: string;
  mutates: string;
}> = [
  { intent: "set_delivery_zones", description: "Add/update (upsert) or replace delivery zones", mutates: "settings.commerce.deliveryZones" },
  { intent: "set_pickup_enabled", description: "Enable/disable customer pickup", mutates: "settings.commerce.pickupEnabled" },
  { intent: "set_pipeline_stages", description: "Replace CRM pipeline stages", mutates: "settings.crm.pipelineStages" },
  { intent: "set_low_stock_threshold", description: "Set the low-stock alert threshold", mutates: "settings.inventory.lowStockThreshold" },
  { intent: "toggle_catalog_sync", description: "Enable/disable catalog sync per ERP integration", mutates: "settings.integrations.<provider>.enabled" },
  { intent: "update_branding", description: "Update brand tagline / WhatsApp About line / secondary color", mutates: "settings.branding" },
];

export interface ApplyConfigResult {
  ok: boolean;
  intent: ConfigIntent;
  dryRun: boolean;
  /** false when desired state already held (idempotent no-op). */
  changed: boolean;
  before: unknown;
  after: unknown;
}

interface IntentApply {
  before: unknown;
  after: unknown;
  changed: boolean;
  mutate: (s: TenantSettings) => void;
}

/** Raw tenant.settings rows may predate the settings skeleton — ensure the
 *  sub-object exists before an intent mutates it. */
function ensureSkeleton(s: TenantSettings): TenantSettings {
  const d = buildDefaultTenantSettings("");
  s.commerce = { ...d.commerce, ...(s.commerce ?? {}) };
  s.branding = { ...d.branding, ...(s.branding ?? {}) };
  s.crm = { ...d.crm, ...(s.crm ?? {}) };
  s.inventory = { ...d.inventory, ...(s.inventory ?? {}) };
  s.integrations = { ...(s.integrations ?? {}) };
  return s;
}

function planIntent(intent: ConfigIntent, params: any, settings: TenantSettings): IntentApply {
  switch (intent) {
    case "set_delivery_zones": {
      const p = params as z.infer<typeof CONFIG_INTENT_PARAMS.set_delivery_zones>;
      const before = settings.commerce.deliveryZones ?? [];
      const after =
        p.mode === "replace"
          ? p.zones
          : [
              ...before.filter((z0) => !p.zones.some((z1) => z1.name === z0.name)),
              ...p.zones,
            ];
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      // Validate the merged result against the commerce schema contract.
      commerceConfigSchema.shape.deliveryZones.parse(after);
      return { before, after, changed, mutate: (s) => void (s.commerce.deliveryZones = after) };
    }
    case "set_pickup_enabled": {
      const p = params as z.infer<typeof CONFIG_INTENT_PARAMS.set_pickup_enabled>;
      const before = settings.commerce.pickupEnabled ?? false;
      const changed = before !== p.enabled;
      return { before, after: p.enabled, changed, mutate: (s) => void (s.commerce.pickupEnabled = p.enabled) };
    }
    case "set_pipeline_stages": {
      const p = params as z.infer<typeof CONFIG_INTENT_PARAMS.set_pipeline_stages>;
      const before = settings.crm.pipelineStages ?? [];
      const changed = JSON.stringify(before) !== JSON.stringify(p.stages);
      return { before, after: p.stages, changed, mutate: (s) => void (s.crm.pipelineStages = [...p.stages]) };
    }
    case "set_low_stock_threshold": {
      const p = params as z.infer<typeof CONFIG_INTENT_PARAMS.set_low_stock_threshold>;
      const before = settings.inventory.lowStockThreshold ?? 5;
      const changed = before !== p.threshold;
      return { before, after: p.threshold, changed, mutate: (s) => void (s.inventory.lowStockThreshold = p.threshold) };
    }
    case "toggle_catalog_sync": {
      const p = params as z.infer<typeof CONFIG_INTENT_PARAMS.toggle_catalog_sync>;
      const creds = settings.integrations?.[p.provider];
      if (!creds || !creds.url || !creds.apiKey) {
        throw new Error(`integration "${p.provider}" is not configured for this tenant`);
      }
      const before = creds.enabled === true;
      const changed = before !== p.enabled;
      return {
        before,
        after: p.enabled,
        changed,
        mutate: (s) => {
          const entry = s.integrations?.[p.provider];
          if (entry) entry.enabled = p.enabled;
        },
      };
    }
    case "update_branding": {
      const p = params as z.infer<typeof CONFIG_INTENT_PARAMS.update_branding>;
      const before = {
        tagline: settings.branding.tagline,
        waProfileAbout: settings.branding.waProfileAbout,
        secondaryColor: settings.branding.secondaryColor,
      };
      const after = {
        tagline: p.tagline !== undefined ? p.tagline : before.tagline,
        waProfileAbout: p.waProfileAbout !== undefined ? p.waProfileAbout : before.waProfileAbout,
        secondaryColor: p.secondaryColor !== undefined ? p.secondaryColor : before.secondaryColor,
      };
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      return {
        before,
        after,
        changed,
        mutate: (s) => {
          if (p.tagline !== undefined) s.branding.tagline = p.tagline;
          if (p.waProfileAbout !== undefined) s.branding.waProfileAbout = p.waProfileAbout;
          if (p.secondaryColor !== undefined) s.branding.secondaryColor = p.secondaryColor;
        },
      };
    }
  }
}

/**
 * Apply (or preview) an ongoing copilot configuration intent.
 * Without confirm: true this is a pure dry-run — nothing is persisted or
 * audited as applied. With confirm: true the mutation is applied and
 * audit-logged. Idempotent: re-applying the same params is a no-op
 * (changed: false) and still produces an audit entry for traceability.
 */
export async function applyCopilotConfig(args: {
  tenantId: string;
  intent: ConfigIntent;
  params: unknown;
  confirm?: boolean;
  actorId?: string;
}): Promise<ApplyConfigResult> {
  const schema = CONFIG_INTENT_PARAMS[args.intent];
  if (!schema) throw new Error(`Unknown config intent "${String(args.intent)}"`);
  const params = schema.parse(args.params ?? {}); // throws ZodError on invalid

  const { settings } = await loadTenant(args.tenantId);
  const plan = planIntent(args.intent, params, settings);

  if (args.confirm !== true) {
    return { ok: true, intent: args.intent, dryRun: true, changed: plan.changed, before: plan.before, after: plan.after };
  }

  await updateTenantSettings(args.tenantId, (s) => plan.mutate(ensureSkeleton(s)));
  await writeAuditLog({
    actorId: args.actorId ? `user:${args.actorId}` : "copilot-config",
    actorRole: args.actorId ? "user" : "system",
    action: `erp_provision.config.${args.intent}`,
    entityType: "tenant",
    entityId: args.tenantId,
    tenantId: args.tenantId,
    summary: plan.changed
      ? `copilot config ${args.intent} applied`
      : `copilot config ${args.intent} applied (no-op — already in desired state)`,
    after: { intent: args.intent, params, before: plan.before, after: plan.after, changed: plan.changed },
  });
  return { ok: true, intent: args.intent, dryRun: false, changed: plan.changed, before: plan.before, after: plan.after };
}
