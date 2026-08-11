import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, and, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  odooIntegrations,
  odooSyncedProducts,
  odooSyncedOrders,
  odooSyncedInvoices,
  products,
} from "../../drizzle/schema";
import {
  getOdooIntegrationConfig,
  odooAuthenticate,
  odooExecuteKw,
  sendWhatsAppTextMessage,
  syncTenantIntegrationPointer,
  type OdooIntegrationConfig,
} from "../services/integrationSync";
import { decryptSecret, encryptSecret } from "../services/crypto/secrets";

const DEMO_TENANT = "demo-tenant-001";
function getTenantId(ctx: { user: { role?: string; tenantId?: string | null } }) {
  if (ctx.user.tenantId) return ctx.user.tenantId;
  // Platform admins may still operate on the demo tenant; any other
  // authenticated user without a tenant must NOT be silently mapped onto
  // the shared demo tenant's data — fail closed.
  if (ctx.user.role === "admin") return DEMO_TENANT;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Your account is not associated with a tenant",
  });
}

/**
 * Cross-tenant credential hijack guard: a requested tenantId must match the
 * caller's own tenant unless the caller is a platform admin.
 */
function assertTenantAccess(ctx: { user: { role: string; tenantId?: string | null } }, requestedTenant: string) {
  if (ctx.user.role === "admin") return;
  if (requestedTenant !== getTenantId(ctx)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Cannot manage Odoo integration for another tenant",
    });
  }
}

// ── Real Odoo JSON-RPC helpers (router-local wrappers) ────────────────────────

/** Authenticate then run a single search_read. Throws honest errors. */
async function odooSearchRead(
  cfg: OdooIntegrationConfig,
  model: string,
  domain: unknown[],
  fields: string[],
  limit: number,
  order?: string,
): Promise<any[]> {
  const uid = await odooAuthenticate(cfg);
  const kwargs: Record<string, unknown> = { fields, limit };
  if (order) kwargs.order = order;
  const result = await odooExecuteKw(cfg, uid, model, "search_read", [domain], kwargs);
  return Array.isArray(result) ? result : [];
}

/** Map a raw Odoo many2one value ([id, name] | false) to a display string. */
function m2oName(v: any): string {
  return Array.isArray(v) && v.length > 1 ? String(v[1]) : "";
}
function m2oId(v: any): number | null {
  return Array.isArray(v) && typeof v[0] === "number" ? v[0] : null;
}
/** Odoo returns false for empty date/char fields. */
function odooDate(v: any): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** Fetch partner phone/mobile numbers for a set of res.partner ids. */
async function fetchPartnerPhones(
  cfg: OdooIntegrationConfig,
  partnerIds: number[],
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (partnerIds.length === 0) return map;
  const uid = await odooAuthenticate(cfg);
  const rows = await odooExecuteKw(
    cfg,
    uid,
    "res.partner",
    "search_read",
    [[["id", "in", partnerIds]]],
    { fields: ["phone", "mobile"], limit: partnerIds.length },
  );
  for (const r of Array.isArray(rows) ? rows : []) {
    map.set(r.id, r.phone || r.mobile || "");
  }
  return map;
}

export const odooRouter = router({
  getConfig: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return null;
    const rows = await db.select().from(odooIntegrations).where(eq(odooIntegrations.tenantId, getTenantId(ctx))).limit(1);
    if (!rows[0]) return null;
    // Mask API key (decrypt the v1: envelope first so the last-4 hint is
    // meaningful; decryptSecret passes legacy plaintext through unchanged).
    const plainKey = rows[0].apiKey ? decryptSecret(rows[0].apiKey) : "";
    return { ...rows[0], apiKey: plainKey ? "••••••••" + plainKey.slice(-4) : "" };
  }),

  saveConfig: protectedProcedure
    .input(z.object({
      baseUrl: z.string().url(),
      database: z.string().min(1),
      username: z.string().min(1),
      apiKey: z.string().min(1),
      syncProducts: z.boolean().default(true),
      syncOrders: z.boolean().default(true),
      syncInvoices: z.boolean().default(true),
      whatsappEnabled: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      const existing = await db.select({ id: odooIntegrations.id }).from(odooIntegrations).where(eq(odooIntegrations.tenantId, tenantId)).limit(1);
      let id: string;
      // API key is a secret — encrypt at rest (v1: envelope); reads decrypt
      // transparently via decryptSecret (legacy plaintext passthrough).
      const stored = { ...input, apiKey: encryptSecret(input.apiKey) };
      if (existing[0]) {
        await db.update(odooIntegrations).set({ ...stored, status: "disconnected" }).where(eq(odooIntegrations.tenantId, tenantId));
        id = existing[0].id;
      } else {
        id = nanoid();
        await db.insert(odooIntegrations).values({ id, tenantId, ...stored, status: "disconnected" });
      }
      // Keep the tenant_integrations pointer row in step so the real sync
      // paths (cron heartbeats, integrationSync) see this tenant.
      await syncTenantIntegrationPointer(tenantId, "odoo_erp", input.baseUrl, "pending");
      return { id };
    }),

  // Validate and persist connection settings for a tenant. Used by the admin
  // portal, which passes an explicit tenantId; falls back to the caller's
  // tenant when omitted.
  configure: protectedProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      baseUrl: z.string().url(),
      database: z.string().min(1),
      username: z.string().min(1),
      apiKey: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const { tenantId: requestedTenant, ...rawConfig } = input;
      const tenantId = requestedTenant ?? getTenantId(ctx);
      // Encrypt at rest (v1: envelope) — integrationSync decrypts on read.
      const config = { ...rawConfig, apiKey: encryptSecret(rawConfig.apiKey) };
      assertTenantAccess(ctx, tenantId);
      const existing = await db
        .select({ id: odooIntegrations.id })
        .from(odooIntegrations)
        .where(eq(odooIntegrations.tenantId, tenantId))
        .limit(1);
      if (existing[0]) {
        await db
          .update(odooIntegrations)
          .set({ ...config, status: "disconnected" })
          .where(eq(odooIntegrations.tenantId, tenantId));
        await syncTenantIntegrationPointer(tenantId, "odoo_erp", config.baseUrl, "pending");
        return { id: existing[0].id, success: true };
      }
      const id = nanoid();
      await db.insert(odooIntegrations).values({ id, tenantId, ...config, status: "disconnected" });
      await syncTenantIntegrationPointer(tenantId, "odoo_erp", config.baseUrl, "pending");
      return { id, success: true };
    }),

  /**
   * Real connection test: performs an Odoo common/authenticate JSON-RPC call
   * with the provided database / username / API key.  Returns the real error
   * when the server is unreachable or rejects the credentials.
   */
  testConnection: protectedProcedure
    .input(z.object({ baseUrl: z.string(), database: z.string(), username: z.string(), apiKey: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      const baseUrl = input.baseUrl.replace(/\/+$/, "");
      let status: "connected" | "error" = "error";
      let error: string | null = null;
      try {
        await odooAuthenticate({
          baseUrl,
          database: input.database,
          username: input.username,
          apiKey: input.apiKey,
        });
        status = "connected";
      } catch (err: any) {
        error = err?.message ?? String(err);
      }
      await db.update(odooIntegrations).set({ status }).where(eq(odooIntegrations.tenantId, tenantId));
      await syncTenantIntegrationPointer(
        tenantId,
        "odoo_erp",
        baseUrl,
        status === "connected" ? "active" : "error",
        error,
      );
      return { success: status === "connected", status, error };
    }),

  /**
   * Real pull from Odoo: products (+ stock), sale orders and customer invoices
   * via JSON-RPC search_read.  Upserts into the odoo_synced_* cache tables and
   * propagates product stock into the platform products table (matched by
   * metadata->>'odooId'), mirroring the cron heartbeat behaviour.
   */
  syncAll: protectedProcedure
    .input(z.object({ tenantId: z.string().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const tenantId = input?.tenantId ?? getTenantId(ctx);
    assertTenantAccess(ctx, tenantId);
    const cfgRow = await db.select().from(odooIntegrations).where(eq(odooIntegrations.tenantId, tenantId)).limit(1);
    if (!cfgRow[0]) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "NOT_CONFIGURED: Odoo is not configured for this tenant",
      });
    }
    const cfg = await getOdooIntegrationConfig(tenantId);
    if (!cfg) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "NOT_CONFIGURED: Odoo integration is missing baseUrl/database/username/apiKey",
      });
    }

    let productsSynced = 0, ordersSynced = 0, invoicesSynced = 0;
    const errors: string[] = [];

    // ── Products + on-hand stock ──────────────────────────────────────────
    if (cfgRow[0].syncProducts) {
      try {
        const rows = await odooSearchRead(
          cfg,
          "product.product",
          [["sale_ok", "=", true]],
          ["name", "default_code", "list_price", "categ_id", "qty_available", "active", "currency_id"],
          500,
          "name asc",
        );
        for (const p of rows) {
          const currency = m2oName(p.currency_id) || "USD";
          const values = {
            tenantId,
            odooId: p.id as number,
            name: String(p.name ?? ""),
            internalRef: p.default_code || null,
            price: String(Number(p.list_price ?? 0).toFixed(2)),
            currency,
            category: m2oName(p.categ_id) || null,
            stockQty: String(Number(p.qty_available ?? 0)),
            active: p.active !== false,
            rawData: p,
            syncedAt: new Date(),
          };
          await db.insert(odooSyncedProducts).values({ id: nanoid(), ...values })
            .onConflictDoUpdate({
              target: [odooSyncedProducts.tenantId, odooSyncedProducts.odooId],
              set: {
                name: values.name,
                internalRef: values.internalRef,
                price: values.price,
                currency: values.currency,
                category: values.category,
                stockQty: values.stockQty,
                active: values.active,
                rawData: p,
                syncedAt: new Date(),
              },
            });
          // Propagate stock into the platform products table (same mapping the
          // /api/scheduled/odoo-inventory-sync heartbeat uses).
          await db.update(products)
            .set({ stockQuantity: Math.max(0, Math.round(Number(p.qty_available ?? 0))), updatedAt: new Date() })
            .where(and(
              eq(products.tenantId, tenantId),
              sql`${products.metadata}->>'odooId' = ${String(p.id)}`,
            ));
          productsSynced++;
        }
      } catch (err: any) {
        errors.push(`products: ${err?.message ?? String(err)}`);
      }
    }

    // ── Sale orders ───────────────────────────────────────────────────────
    if (cfgRow[0].syncOrders) {
      try {
        const rows = await odooSearchRead(
          cfg,
          "sale.order",
          [],
          ["name", "partner_id", "state", "amount_total", "currency_id", "date_order"],
          200,
          "date_order desc",
        );
        const partnerIds = Array.from(new Set(rows.map((o) => m2oId(o.partner_id)).filter((x): x is number => x !== null)));
        const phones = await fetchPartnerPhones(cfg, partnerIds);
        for (const o of rows) {
          const pid = m2oId(o.partner_id);
          const values = {
            tenantId,
            odooId: o.id as number,
            name: String(o.name ?? ""),
            partnerName: m2oName(o.partner_id) || null,
            partnerPhone: (pid !== null ? phones.get(pid) : "") || null,
            state: o.state ?? null,
            amountTotal: String(Number(o.amount_total ?? 0).toFixed(2)),
            currency: m2oName(o.currency_id) || "USD",
            dateOrder: odooDate(o.date_order),
            rawData: o,
            syncedAt: new Date(),
          };
          await db.insert(odooSyncedOrders).values({ id: nanoid(), ...values })
            .onConflictDoUpdate({
              target: [odooSyncedOrders.tenantId, odooSyncedOrders.odooId],
              set: {
                name: values.name,
                partnerName: values.partnerName,
                partnerPhone: values.partnerPhone,
                state: values.state,
                amountTotal: values.amountTotal,
                currency: values.currency,
                dateOrder: values.dateOrder,
                rawData: o,
                syncedAt: new Date(),
              },
            });
          ordersSynced++;
        }
      } catch (err: any) {
        errors.push(`orders: ${err?.message ?? String(err)}`);
      }
    }

    // ── Customer invoices ─────────────────────────────────────────────────
    if (cfgRow[0].syncInvoices) {
      try {
        const rows = await odooSearchRead(
          cfg,
          "account.move",
          [["move_type", "=", "out_invoice"]],
          ["name", "partner_id", "state", "amount_total", "amount_residual", "currency_id", "invoice_date", "invoice_date_due"],
          200,
          "invoice_date desc",
        );
        const partnerIds = Array.from(new Set(rows.map((v) => m2oId(v.partner_id)).filter((x): x is number => x !== null)));
        const phones = await fetchPartnerPhones(cfg, partnerIds);
        for (const inv of rows) {
          const pid = m2oId(inv.partner_id);
          const values = {
            tenantId,
            odooId: inv.id as number,
            name: String(inv.name ?? ""),
            partnerName: m2oName(inv.partner_id) || null,
            partnerPhone: (pid !== null ? phones.get(pid) : "") || null,
            state: inv.state ?? null,
            amountTotal: String(Number(inv.amount_total ?? 0).toFixed(2)),
            amountResidual: String(Number(inv.amount_residual ?? 0).toFixed(2)),
            currency: m2oName(inv.currency_id) || "USD",
            invoiceDate: odooDate(inv.invoice_date),
            dueDate: odooDate(inv.invoice_date_due),
            rawData: inv,
            syncedAt: new Date(),
          };
          await db.insert(odooSyncedInvoices).values({ id: nanoid(), ...values })
            .onConflictDoUpdate({
              target: [odooSyncedInvoices.tenantId, odooSyncedInvoices.odooId],
              set: {
                name: values.name,
                partnerName: values.partnerName,
                partnerPhone: values.partnerPhone,
                state: values.state,
                amountTotal: values.amountTotal,
                amountResidual: values.amountResidual,
                currency: values.currency,
                invoiceDate: values.invoiceDate,
                dueDate: values.dueDate,
                rawData: inv,
                syncedAt: new Date(),
              },
            });
          invoicesSynced++;
        }
      } catch (err: any) {
        errors.push(`invoices: ${err?.message ?? String(err)}`);
      }
    }

    const allFailed =
      errors.length > 0 &&
      productsSynced + ordersSynced + invoicesSynced === 0 &&
      (cfgRow[0].syncProducts || cfgRow[0].syncOrders || cfgRow[0].syncInvoices);

    await db.update(odooIntegrations)
      .set({ lastSyncAt: new Date(), status: allFailed ? "error" : "connected" })
      .where(eq(odooIntegrations.tenantId, tenantId));
    await syncTenantIntegrationPointer(
      tenantId,
      "odoo_erp",
      cfg.baseUrl,
      allFailed ? "error" : "active",
      allFailed ? errors.join(" | ") : null,
    );

    return { productsSynced, ordersSynced, invoicesSynced, errors };
  }),

  /**
   * Live product list from Odoo (product.product search_read).
   * Returns an honest empty array (+ configured:false) when not configured.
   */
  listProducts: protectedProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ ctx, input }) => {
      const tenantId = getTenantId(ctx);
      const cfg = await getOdooIntegrationConfig(tenantId);
      if (!cfg) return { products: [] as any[], configured: false };
      try {
        const rows = await odooSearchRead(
          cfg,
          "product.product",
          [["sale_ok", "=", true]],
          ["name", "default_code", "list_price", "categ_id", "qty_available", "active", "currency_id"],
          input.limit + input.offset,
          "name asc",
        );
        const products = rows.slice(input.offset).map((p) => ({
          id: String(p.id),
          odooId: p.id as number,
          name: String(p.name ?? ""),
          internalRef: p.default_code || null,
          price: Number(p.list_price ?? 0).toFixed(2),
          currency: m2oName(p.currency_id) || "USD",
          category: m2oName(p.categ_id) || null,
          stockQty: String(Number(p.qty_available ?? 0)),
          active: p.active !== false,
        }));
        return { products, configured: true };
      } catch (err: any) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Odoo product fetch failed: ${err?.message ?? String(err)}`,
        });
      }
    }),

  /** Live sale order list from Odoo. */
  listOrders: protectedProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ ctx, input }) => {
      const tenantId = getTenantId(ctx);
      const cfg = await getOdooIntegrationConfig(tenantId);
      if (!cfg) return { orders: [] as any[], configured: false };
      try {
        const rows = await odooSearchRead(
          cfg,
          "sale.order",
          [],
          ["name", "partner_id", "state", "amount_total", "currency_id", "date_order"],
          input.limit + input.offset,
          "date_order desc",
        );
        const orders = rows.slice(input.offset).map((o) => ({
          id: String(o.id),
          odooId: o.id as number,
          name: String(o.name ?? ""),
          partnerName: m2oName(o.partner_id) || null,
          state: o.state ?? null,
          amountTotal: Number(o.amount_total ?? 0).toFixed(2),
          currency: m2oName(o.currency_id) || "USD",
          dateOrder: odooDate(o.date_order),
        }));
        return { orders, configured: true };
      } catch (err: any) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Odoo order fetch failed: ${err?.message ?? String(err)}`,
        });
      }
    }),

  /** Live customer invoice list from Odoo. */
  listInvoices: protectedProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ ctx, input }) => {
      const tenantId = getTenantId(ctx);
      const cfg = await getOdooIntegrationConfig(tenantId);
      if (!cfg) return { invoices: [] as any[], configured: false };
      try {
        const rows = await odooSearchRead(
          cfg,
          "account.move",
          [["move_type", "=", "out_invoice"]],
          ["name", "partner_id", "state", "amount_total", "amount_residual", "currency_id", "invoice_date", "invoice_date_due"],
          input.limit + input.offset,
          "invoice_date desc",
        );
        const invoices = rows.slice(input.offset).map((inv) => ({
          id: String(inv.id),
          odooId: inv.id as number,
          name: String(inv.name ?? ""),
          partnerName: m2oName(inv.partner_id) || null,
          state: inv.state ?? null,
          amountTotal: Number(inv.amount_total ?? 0).toFixed(2),
          amountResidual: Number(inv.amount_residual ?? 0).toFixed(2),
          currency: m2oName(inv.currency_id) || "USD",
          invoiceDate: odooDate(inv.invoice_date),
          dueDate: odooDate(inv.invoice_date_due),
        }));
        return { invoices, configured: true };
      } catch (err: any) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Odoo invoice fetch failed: ${err?.message ?? String(err)}`,
        });
      }
    }),

  /**
   * Send a real WhatsApp text message (Meta Cloud API) about a synced Odoo
   * order or invoice.  The local whatsappSent flag is only set after the
   * Cloud API accepts the message; when WhatsApp credentials are missing an
   * honest NOT_CONFIGURED error is thrown — nothing is faked.
   */
  sendWhatsApp: protectedProcedure
    .input(z.object({ type: z.enum(["order", "invoice"]), recordId: z.string(), message: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      const table = input.type === "order" ? odooSyncedOrders : odooSyncedInvoices;

      // Resolve the record (accepts the local row id or the Odoo numeric id).
      const byId = await db.select().from(table)
        .where(and(eq(table.id, input.recordId), eq(table.tenantId, tenantId)))
        .limit(1);
      let record = byId[0];
      if (!record && /^\d+$/.test(input.recordId)) {
        const byOdooId = await db.select().from(table)
          .where(and(eq(table.odooId, Number(input.recordId)), eq(table.tenantId, tenantId)))
          .limit(1);
        record = byOdooId[0];
      }

      let phone = record?.partnerPhone ?? null;

      // Fall back to a live Odoo lookup of the partner's phone when the local
      // cache has no number (recordId may be an Odoo id from a live list).
      if (!phone) {
        const cfg = await getOdooIntegrationConfig(tenantId);
        if (!cfg) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "NOT_CONFIGURED: Odoo is not configured for this tenant",
          });
        }
        const odooId = record?.odooId ?? (/^\d+$/.test(input.recordId) ? Number(input.recordId) : null);
        if (odooId === null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Odoo record not found" });
        }
        try {
          const model = input.type === "order" ? "sale.order" : "account.move";
          const rows = await odooSearchRead(cfg, model, [["id", "=", odooId]], ["partner_id"], 1);
          const pid = m2oId(rows[0]?.partner_id);
          if (pid !== null) {
            const phones = await fetchPartnerPhones(cfg, [pid]);
            phone = phones.get(pid) ?? null;
          }
        } catch (err: any) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Failed to resolve recipient from Odoo: ${err?.message ?? String(err)}`,
          });
        }
      }

      if (!phone) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No phone number on the Odoo partner for this record",
        });
      }

      const result = await sendWhatsAppTextMessage(phone, input.message);
      if (!result.sent) {
        throw new TRPCError({
          code: result.notConfigured ? "PRECONDITION_FAILED" : "INTERNAL_SERVER_ERROR",
          message: result.error,
        });
      }

      if (record) {
        await db.update(table).set({ whatsappSent: true }).where(eq(table.id, record.id));
      }
      return { success: true, sentAt: new Date(), wamid: result.wamid };
    }),
});
