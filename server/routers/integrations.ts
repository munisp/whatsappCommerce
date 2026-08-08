/**
 * server/routers/integrations.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Tenant-admin management API for the Medusa / Twenty CRM / Odoo integrations
 * backed by the transactional outbox (integration_events).
 *
 *   getConfig / setConfig   — per-system config in tenants.settings.integrations
 *                             (secrets are masked in every read path)
 *   testConnection          — live auth probe against the external system
 *   syncStatus              — integration_events counts by status
 *   resync                  — enqueue a full re-sync of products/customers/orders
 *   listEvents              — paginated outbox/audit event listing
 *
 * Every procedure is tenant-scoped and guarded by assertTenantAccess.
 */

import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { customers, integrationEvents, orders, products, tenants } from "../../drizzle/schema";
import {
  createIntegrationClient,
  IntegrationError,
  MedusaClient,
  OdooClient,
  TwentyClient,
  type IntegrationConfig,
  type IntegrationSystem,
} from "../services/integrations/clients";
import { countEventsByStatus, enqueueIntegrationEvent } from "../services/integrations/outbox";

const systemSchema = z.enum(["medusa", "twenty", "odoo"]);
const entitySchema = z.enum(["order", "customer", "product"]);

const MAX_RESYNC_ROWS = 500;

function maskSecret(secret: string | undefined | null): string | null {
  if (!secret) return null;
  if (secret.length <= 4) return "****";
  return `****${secret.slice(-4)}`;
}

interface MaskedConfig {
  url: string | null;
  enabled: boolean;
  apiKey: string | null; // masked
  webhookSecret: string | null; // masked
  extras: Record<string, unknown>;
}

function maskConfig(cfg: IntegrationConfig | null | undefined): MaskedConfig {
  const { url, apiKey, webhookSecret, enabled, ...extras } = (cfg ?? {}) as IntegrationConfig;
  return {
    url: url ?? null,
    enabled: enabled === true,
    apiKey: maskSecret(apiKey),
    webhookSecret: maskSecret(webhookSecret),
    extras,
  };
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

async function readTenantSettings(db: any, tenantId: string): Promise<Record<string, any>> {
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
  return ((tenant.settings ?? {}) as Record<string, any>);
}

export const integrationsRouter = router({
  /** Read one system's config with secrets masked. */
  getConfig: protectedProcedure
    .input(z.object({ tenantId: z.string(), system: systemSchema }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const settings = await readTenantSettings(db, input.tenantId);
      return {
        system: input.system,
        config: maskConfig(settings?.integrations?.[input.system] as IntegrationConfig | undefined),
      };
    }),

  /** Create/update one system's config. Secrets are write-only (never echoed back). */
  setConfig: protectedProcedure
    .input(
      z.object({
        tenantId: z.string(),
        system: systemSchema,
        url: z.string().url().optional(),
        apiKey: z.string().min(1).optional(),
        webhookSecret: z.string().min(8).optional(),
        enabled: z.boolean().optional(),
        /** Odoo: { database, username }; other per-system extras allowed. */
        extras: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const settings = await readTenantSettings(db, input.tenantId);
      const integrations = { ...(settings.integrations ?? {}) };
      const current = (integrations[input.system] ?? {}) as IntegrationConfig;
      const next: IntegrationConfig = {
        ...current,
        ...(input.extras ?? {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
        ...(input.webhookSecret !== undefined ? { webhookSecret: input.webhookSecret } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      };
      if (next.enabled && !next.url) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "url is required to enable an integration" });
      }
      integrations[input.system] = next;
      await db
        .update(tenants)
        .set({ settings: { ...settings, integrations }, updatedAt: new Date() })
        .where(eq(tenants.id, input.tenantId));
      return { system: input.system, config: maskConfig(next) };
    }),

  /** Live connectivity/auth probe against the external system. */
  testConnection: protectedProcedure
    .input(z.object({ tenantId: z.string(), system: systemSchema }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const settings = await readTenantSettings(db, input.tenantId);
      const cfg = settings?.integrations?.[input.system] as IntegrationConfig | undefined;
      if (!cfg?.url) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${input.system} is not configured` });
      }
      const client = createIntegrationClient(input.system, { ...cfg, url: cfg.url.replace(/\/+$/, "") });
      try {
        const detail =
          client instanceof MedusaClient || client instanceof TwentyClient
            ? await client.testConnection()
            : await (client as OdooClient).testConnection();
        return { ok: true as const, system: input.system, detail };
      } catch (err: any) {
        if (err instanceof IntegrationError) {
          return { ok: false as const, system: input.system, error: err.message, status: err.status };
        }
        throw err;
      }
    }),

  /** Counts of integration_events by status for this tenant (optionally per system). */
  syncStatus: protectedProcedure
    .input(z.object({ tenantId: z.string(), system: systemSchema.optional() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const counts = await countEventsByStatus(db, input.tenantId, input.system);
      return { tenantId: input.tenantId, system: input.system ?? null, counts };
    }),

  /**
   * Enqueue a full re-sync. Reads the tenant's local rows and enqueues one
   * outbox event per row (action='resync', upsert semantics on delivery).
   */
  resync: protectedProcedure
    .input(z.object({ tenantId: z.string(), system: systemSchema, entity: entitySchema.optional() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const entities = input.entity ? [input.entity] : (["product", "customer", "order"] as const);
      let enqueued = 0;
      const skipped: string[] = [];

      for (const entity of entities) {
        // Skip entity/system pairs the outbox does not deliver.
        if (input.system === "twenty" && entity !== "customer") {
          skipped.push(entity);
          continue;
        }
        if (entity === "product") {
          const rows = await db
            .select()
            .from(products)
            .where(eq(products.tenantId, input.tenantId))
            .limit(MAX_RESYNC_ROWS);
          for (const p of rows) {
            const id = await enqueueIntegrationEvent(db, {
              tenantId: input.tenantId,
              system: input.system as IntegrationSystem,
              entity: "product",
              entityId: p.id,
              action: "resync",
              data: {
                name: p.name,
                sku: p.sku,
                price: Number(p.price),
                currency: p.currency,
                description: p.description,
                stockQuantity: p.stockQuantity,
                externalId: (p.metadata as any)?.medusaId ?? null,
              },
            });
            if (id) enqueued++;
          }
        } else if (entity === "customer") {
          const rows = await db
            .select()
            .from(customers)
            .where(eq(customers.tenantId, input.tenantId))
            .limit(MAX_RESYNC_ROWS);
          for (const c of rows) {
            const id = await enqueueIntegrationEvent(db, {
              tenantId: input.tenantId,
              system: input.system as IntegrationSystem,
              entity: "customer",
              entityId: c.id,
              action: "resync",
              data: { name: c.name, email: c.email, whatsappPhone: c.whatsappPhone },
            });
            if (id) enqueued++;
          }
        } else {
          const rows = await db
            .select()
            .from(orders)
            .where(eq(orders.tenantId, input.tenantId))
            .orderBy(desc(orders.createdAt))
            .limit(MAX_RESYNC_ROWS);
          for (const o of rows) {
            const id = await enqueueIntegrationEvent(db, {
              tenantId: input.tenantId,
              system: input.system as IntegrationSystem,
              entity: "order",
              entityId: o.id,
              action: "resync",
              data: {
                orderNumber: o.orderNumber,
                customerId: o.customerId,
                currency: o.currency,
                totalAmount: Number(o.totalAmount),
                items: o.items ?? [],
                status: o.status,
              },
            });
            if (id) enqueued++;
          }
        }
      }
      return { enqueued, skipped, system: input.system };
    }),

  /** Paginated event listing (newest first). */
  listEvents: protectedProcedure
    .input(
      z.object({
        tenantId: z.string(),
        system: systemSchema.optional(),
        status: z.enum(["pending", "delivered", "failed", "dead"]).optional(),
        direction: z.enum(["out", "in"]).optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const conds = [eq(integrationEvents.tenantId, input.tenantId)];
      if (input.system) conds.push(eq(integrationEvents.system, input.system));
      if (input.status) conds.push(eq(integrationEvents.status, input.status));
      if (input.direction) conds.push(eq(integrationEvents.direction, input.direction));
      const rows = await db
        .select()
        .from(integrationEvents)
        .where(and(...conds))
        .orderBy(desc(integrationEvents.createdAt))
        .limit(input.limit)
        .offset(input.offset);
      return { events: rows, limit: input.limit, offset: input.offset };
    }),
});
