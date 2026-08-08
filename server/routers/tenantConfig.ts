/**
 * server/routers/tenantConfig.ts — per-tenant customization APIs.
 *
 * Every procedure is tenant-scoped: protectedProcedure + assertTenantAccess
 * (tenant admins manage their own tenant; platform admins bypass). All config
 * lives under tenants.settings (JSONB) and is validated with zod before write.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import {
  brandingConfigSchema,
  commerceConfigSchema,
  crmCustomFieldSchema,
  inventoryConfigSchema,
  pipelineStageSchema,
  buildDefaultTenantSettings,
  type TenantSettings,
} from "../../shared/tenantConfig";
import {
  parseWaMenuConfig,
  waCustomItemSchema,
  WA_USE_CASE_IDS,
  type WaMenuConfig,
} from "../../shared/waMenu";
import { updateTenantSettings } from "../services/onboarding";
import { previewWaMenuForTenant } from "../services/waMenuPreview";

const tenantInput = z.object({ tenantId: z.string() });

async function loadSettings(tenantId: string): Promise<TenantSettings> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const [tenant] = await db
    .select({ name: tenants.name, settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
  const defaults = buildDefaultTenantSettings(tenant.name);
  // Shallow-merge over defaults so legacy tenants without the skeleton still work.
  const settings = { ...defaults, ...((tenant.settings ?? {}) as TenantSettings) };
  return settings;
}

function getMenu(settings: TenantSettings): WaMenuConfig {
  return parseWaMenuConfig(settings.waMenu);
}

export const tenantConfigRouter = router({
  // ─── CRM ───────────────────────────────────────────────────────────────────

  getCrmConfig: protectedProcedure.input(tenantInput).query(async ({ ctx, input }) => {
    assertTenantAccess(ctx.user, input.tenantId);
    const settings = await loadSettings(input.tenantId);
    return settings.crm;
  }),

  setPipelineStages: protectedProcedure
    .input(tenantInput.extend({ stages: z.array(pipelineStageSchema).min(2).max(20) }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      if (new Set(input.stages).size !== input.stages.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "duplicate pipeline stages" });
      }
      const settings = await updateTenantSettings(input.tenantId, (s) => {
        s.crm = { ...(s.crm ?? { customFields: [], pipelineStages: [] }), pipelineStages: input.stages };
      });
      return settings.crm;
    }),

  addCustomField: protectedProcedure
    .input(tenantInput.extend({ field: crmCustomFieldSchema }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const settings = await updateTenantSettings(input.tenantId, (s) => {
        const crm = s.crm ?? { customFields: [], pipelineStages: ["new", "qualified", "won", "lost"] };
        if (crm.customFields.some((f) => f.key === input.field.key)) {
          throw new TRPCError({ code: "CONFLICT", message: `custom field "${input.field.key}" already exists` });
        }
        if (input.field.type === "select" && (!input.field.options || input.field.options.length === 0)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "select fields require options" });
        }
        crm.customFields = [...crm.customFields, input.field];
        s.crm = crm;
      });
      return settings.crm;
    }),

  updateCustomField: protectedProcedure
    .input(
      tenantInput.extend({
        key: z.string().trim().min(1),
        patch: crmCustomFieldSchema.partial().omit({ key: true }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const settings = await updateTenantSettings(input.tenantId, (s) => {
        const crm = s.crm ?? { customFields: [], pipelineStages: ["new", "qualified", "won", "lost"] };
        const idx = crm.customFields.findIndex((f) => f.key === input.key);
        if (idx < 0) throw new TRPCError({ code: "NOT_FOUND", message: `custom field "${input.key}" not found` });
        const next = { ...crm.customFields[idx], ...input.patch, key: input.key };
        if (next.type === "select" && (!next.options || next.options.length === 0)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "select fields require options" });
        }
        crm.customFields = crm.customFields.map((f, i) => (i === idx ? next : f));
        s.crm = crm;
      });
      return settings.crm;
    }),

  removeCustomField: protectedProcedure
    .input(tenantInput.extend({ key: z.string().trim().min(1) }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const settings = await updateTenantSettings(input.tenantId, (s) => {
        const crm = s.crm ?? { customFields: [], pipelineStages: ["new", "qualified", "won", "lost"] };
        if (!crm.customFields.some((f) => f.key === input.key)) {
          throw new TRPCError({ code: "NOT_FOUND", message: `custom field "${input.key}" not found` });
        }
        crm.customFields = crm.customFields.filter((f) => f.key !== input.key);
        s.crm = crm;
      });
      return settings.crm;
    }),

  // ─── Inventory ─────────────────────────────────────────────────────────────

  getInventoryConfig: protectedProcedure.input(tenantInput).query(async ({ ctx, input }) => {
    assertTenantAccess(ctx.user, input.tenantId);
    const settings = await loadSettings(input.tenantId);
    return settings.inventory;
  }),

  setInventoryConfig: protectedProcedure
    .input(tenantInput.extend({ config: inventoryConfigSchema }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const settings = await updateTenantSettings(input.tenantId, (s) => {
        s.inventory = input.config;
      });
      return settings.inventory;
    }),

  // ─── Commerce ──────────────────────────────────────────────────────────────

  getCommerceConfig: protectedProcedure.input(tenantInput).query(async ({ ctx, input }) => {
    assertTenantAccess(ctx.user, input.tenantId);
    const settings = await loadSettings(input.tenantId);
    return settings.commerce;
  }),

  setCommerceConfig: protectedProcedure
    .input(tenantInput.extend({ config: commerceConfigSchema }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const settings = await updateTenantSettings(input.tenantId, (s) => {
        s.commerce = input.config;
      });
      return settings.commerce;
    }),

  // ─── Branding ──────────────────────────────────────────────────────────────

  getBrandingConfig: protectedProcedure.input(tenantInput).query(async ({ ctx, input }) => {
    assertTenantAccess(ctx.user, input.tenantId);
    const settings = await loadSettings(input.tenantId);
    return settings.branding;
  }),

  setBrandingConfig: protectedProcedure
    .input(tenantInput.extend({ config: brandingConfigSchema }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const settings = await updateTenantSettings(input.tenantId, (s) => {
        s.branding = input.config;
      });
      return settings.branding;
    }),

  // ─── WhatsApp menu ─────────────────────────────────────────────────────────

  getWaMenuConfig: protectedProcedure.input(tenantInput).query(async ({ ctx, input }) => {
    assertTenantAccess(ctx.user, input.tenantId);
    const settings = await loadSettings(input.tenantId);
    return getMenu(settings);
  }),

  /** Full replace — must satisfy the shared menu contract. */
  setWaMenuConfig: protectedProcedure
    .input(tenantInput.extend({ config: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const menu = parseWaMenuConfig(input.config); // zod: ids, labels, order collisions
      const settings = await updateTenantSettings(input.tenantId, (s) => {
        s.waMenu = menu;
      });
      return settings.waMenu;
    }),

  addWaMenuCustomItem: protectedProcedure
    .input(tenantInput.extend({ item: waCustomItemSchema }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const settings = await updateTenantSettings(input.tenantId, (s) => {
        const menu = getMenu(s);
        if (menu.customItems.some((i) => i.key === input.item.key)) {
          throw new TRPCError({ code: "CONFLICT", message: `custom item "${input.item.key}" already exists` });
        }
        menu.customItems = [...menu.customItems, input.item];
        s.waMenu = menu;
      });
      return settings.waMenu;
    }),

  /**
   * Item-level update. For a use case: pass useCaseId with label/enabled
   * patch. For a custom item: pass customKey with label/response patch.
   */
  updateWaMenuItem: protectedProcedure
    .input(
      tenantInput.extend({
        useCaseId: z.enum(WA_USE_CASE_IDS).optional(),
        customKey: z.string().trim().min(1).optional(),
        patch: z.object({
          label: z.string().trim().min(1).max(60).optional(),
          enabled: z.boolean().optional(),
          response: z.string().min(1).max(1000).optional(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      if (!input.useCaseId && !input.customKey) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "provide useCaseId or customKey" });
      }
      const settings = await updateTenantSettings(input.tenantId, (s) => {
        const menu = getMenu(s);
        if (input.useCaseId) {
          const idx = menu.useCases.findIndex((u) => u.id === input.useCaseId);
          if (idx < 0) throw new TRPCError({ code: "NOT_FOUND", message: `use case "${input.useCaseId}" not in menu` });
          menu.useCases = menu.useCases.map((u, i) =>
            i === idx
              ? {
                  ...u,
                  label: input.patch.label ?? u.label,
                  enabled: input.patch.enabled ?? u.enabled,
                }
              : u,
          );
        } else if (input.customKey) {
          const idx = menu.customItems.findIndex((i) => i.key === input.customKey);
          if (idx < 0) throw new TRPCError({ code: "NOT_FOUND", message: `custom item "${input.customKey}" not found` });
          menu.customItems = menu.customItems.map((it, i) =>
            i === idx
              ? {
                  ...it,
                  label: input.patch.label ?? it.label,
                  response: input.patch.response ?? it.response,
                }
              : it,
          );
        }
        s.waMenu = parseWaMenuConfig(menu);
      });
      return settings.waMenu;
    }),

  removeWaMenuCustomItem: protectedProcedure
    .input(tenantInput.extend({ key: z.string().trim().min(1) }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const settings = await updateTenantSettings(input.tenantId, (s) => {
        const menu = getMenu(s);
        if (!menu.customItems.some((i) => i.key === input.key)) {
          throw new TRPCError({ code: "NOT_FOUND", message: `custom item "${input.key}" not found` });
        }
        menu.customItems = menu.customItems.filter((i) => i.key !== input.key);
        s.waMenu = menu;
      });
      return settings.waMenu;
    }),

  /**
   * Reorder use cases: orderedIds lists every use-case id in the desired
   * order; order values are rewritten to 1..N.
   */
  reorderWaMenuUseCases: protectedProcedure
    .input(tenantInput.extend({ orderedIds: z.array(z.enum(WA_USE_CASE_IDS)).min(1) }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      if (new Set(input.orderedIds).size !== input.orderedIds.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "duplicate use-case ids in orderedIds" });
      }
      const settings = await updateTenantSettings(input.tenantId, (s) => {
        const menu = getMenu(s);
        const missing = menu.useCases.filter((u) => !input.orderedIds.includes(u.id));
        const unknown = input.orderedIds.filter((id) => !menu.useCases.some((u) => u.id === id));
        if (unknown.length > 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `unknown use-case ids: ${unknown.join(", ")}` });
        }
        if (missing.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `orderedIds must include every use case; missing: ${missing.map((u) => u.id).join(", ")}`,
          });
        }
        menu.useCases = input.orderedIds.map((id, i) => {
          const uc = menu.useCases.find((u) => u.id === id)!;
          return { ...uc, order: i + 1 };
        });
        s.waMenu = parseWaMenuConfig(menu);
      });
      return settings.waMenu;
    }),

  // ─── Menu preview (live config + live data) ────────────────────────────────

  previewWaMenu: protectedProcedure.input(tenantInput).query(async ({ ctx, input }) => {
    assertTenantAccess(ctx.user, input.tenantId);
    return previewWaMenuForTenant(input.tenantId);
  }),
});
