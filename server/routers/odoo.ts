import { z } from "zod";
import { nanoid } from "nanoid";
import { eq, desc } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  odooIntegrations,
  odooSyncedProducts,
  odooSyncedOrders,
  odooSyncedInvoices,
} from "../../drizzle/schema";

const DEMO_TENANT = "demo-tenant-001";
function getTenantId(ctx: { user: { tenantId?: string | null } }) {
  return ctx.user.tenantId ?? DEMO_TENANT;
}

// ── Simulated Odoo data (real impl: XML-RPC or JSON-RPC to Odoo) ──────────────
const DEMO_PRODUCTS = [
  { id: 1, name: "Premium Wireless Headphones", internalRef: "WH-001", price: 89.99, currency: "USD", category: "Electronics", stockQty: 142, active: true },
  { id: 2, name: "Organic Cotton T-Shirt", internalRef: "TS-042", price: 24.99, currency: "USD", category: "Apparel", stockQty: 380, active: true },
  { id: 3, name: "Stainless Steel Water Bottle", internalRef: "WB-015", price: 34.50, currency: "USD", category: "Accessories", stockQty: 67, active: true },
  { id: 4, name: "Bluetooth Speaker Pro", internalRef: "SP-007", price: 129.00, currency: "USD", category: "Electronics", stockQty: 28, active: true },
  { id: 5, name: "Leather Wallet", internalRef: "LW-033", price: 45.00, currency: "USD", category: "Accessories", stockQty: 95, active: true },
];
const DEMO_ORDERS = [
  { id: 101, name: "S00101", partnerName: "Amara Nwosu", partnerPhone: "+2348012345678", state: "sale", amountTotal: 269.97, currency: "USD", dateOrder: new Date("2026-07-10") },
  { id: 102, name: "S00102", partnerName: "Carlos Mendez", partnerPhone: "+5491123456789", state: "done", amountTotal: 89.99, currency: "USD", dateOrder: new Date("2026-07-11") },
  { id: 103, name: "S00103", partnerName: "Priya Sharma", partnerPhone: "+919876543210", state: "draft", amountTotal: 154.50, currency: "USD", dateOrder: new Date("2026-07-12") },
  { id: 104, name: "S00104", partnerName: "David Osei", partnerPhone: "+233244123456", state: "sale", amountTotal: 324.00, currency: "USD", dateOrder: new Date("2026-07-13") },
];
const DEMO_INVOICES = [
  { id: 201, name: "INV/2026/00201", partnerName: "Amara Nwosu", partnerPhone: "+2348012345678", state: "posted", amountTotal: 269.97, amountResidual: 0, currency: "USD", invoiceDate: new Date("2026-07-10"), dueDate: new Date("2026-08-10") },
  { id: 202, name: "INV/2026/00202", partnerName: "Carlos Mendez", partnerPhone: "+5491123456789", state: "posted", amountTotal: 89.99, amountResidual: 89.99, currency: "USD", invoiceDate: new Date("2026-07-11"), dueDate: new Date("2026-08-11") },
  { id: 203, name: "INV/2026/00203", partnerName: "Priya Sharma", partnerPhone: "+919876543210", state: "draft", amountTotal: 154.50, amountResidual: 154.50, currency: "USD", invoiceDate: new Date("2026-07-12"), dueDate: new Date("2026-08-12") },
];

export const odooRouter = router({
  getConfig: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return null;
    const rows = await db.select().from(odooIntegrations).where(eq(odooIntegrations.tenantId, getTenantId(ctx))).limit(1);
    if (!rows[0]) return null;
    return { ...rows[0], apiKey: rows[0].apiKey ? "••••••••" + rows[0].apiKey.slice(-4) : "" };
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
      if (existing[0]) {
        await db.update(odooIntegrations).set({ ...input, status: "disconnected" }).where(eq(odooIntegrations.tenantId, tenantId));
        return { id: existing[0].id };
      }
      const id = nanoid();
      await db.insert(odooIntegrations).values({ id, tenantId, ...input, status: "disconnected" });
      return { id };
    }),

  testConnection: protectedProcedure
    .input(z.object({ baseUrl: z.string(), database: z.string(), username: z.string(), apiKey: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      const ok = input.baseUrl.startsWith("http") && input.apiKey.length > 4 && input.database.length > 0;
      await db.update(odooIntegrations).set({ status: ok ? "connected" : "error" }).where(eq(odooIntegrations.tenantId, tenantId));
      return { success: ok, status: ok ? "connected" : "error" };
    }),

  syncAll: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const tenantId = getTenantId(ctx);
    const cfg = await db.select().from(odooIntegrations).where(eq(odooIntegrations.tenantId, tenantId)).limit(1);
    if (!cfg[0]) throw new Error("Odoo not configured");

    let productsSynced = 0, ordersSynced = 0, invoicesSynced = 0;

    if (cfg[0].syncProducts) {
      for (const p of DEMO_PRODUCTS) {
        await db.insert(odooSyncedProducts).values({ id: nanoid(), tenantId, odooId: p.id, name: p.name, internalRef: p.internalRef, price: String(p.price), currency: p.currency, category: p.category, stockQty: String(p.stockQty), active: p.active, syncedAt: new Date() })
          .onDuplicateKeyUpdate({ set: { name: p.name, price: String(p.price), stockQty: String(p.stockQty), syncedAt: new Date() } });
        productsSynced++;
      }
    }
    if (cfg[0].syncOrders) {
      for (const o of DEMO_ORDERS) {
        await db.insert(odooSyncedOrders).values({ id: nanoid(), tenantId, odooId: o.id, name: o.name, partnerName: o.partnerName, partnerPhone: o.partnerPhone, state: o.state, amountTotal: String(o.amountTotal), currency: o.currency, dateOrder: o.dateOrder, syncedAt: new Date() })
          .onDuplicateKeyUpdate({ set: { state: o.state, amountTotal: String(o.amountTotal), syncedAt: new Date() } });
        ordersSynced++;
      }
    }
    if (cfg[0].syncInvoices) {
      for (const inv of DEMO_INVOICES) {
        await db.insert(odooSyncedInvoices).values({ id: nanoid(), tenantId, odooId: inv.id, name: inv.name, partnerName: inv.partnerName, partnerPhone: inv.partnerPhone, state: inv.state, amountTotal: String(inv.amountTotal), amountResidual: String(inv.amountResidual), currency: inv.currency, invoiceDate: inv.invoiceDate, dueDate: inv.dueDate, syncedAt: new Date() })
          .onDuplicateKeyUpdate({ set: { state: inv.state, amountResidual: String(inv.amountResidual), syncedAt: new Date() } });
        invoicesSynced++;
      }
    }

    await db.update(odooIntegrations).set({ lastSyncAt: new Date(), status: "connected" }).where(eq(odooIntegrations.tenantId, tenantId));
    return { productsSynced, ordersSynced, invoicesSynced };
  }),

  listProducts: protectedProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { products: [] };
      return { products: await db.select().from(odooSyncedProducts).where(eq(odooSyncedProducts.tenantId, getTenantId(ctx))).orderBy(desc(odooSyncedProducts.syncedAt)).limit(input.limit).offset(input.offset) };
    }),

  listOrders: protectedProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { orders: [] };
      return { orders: await db.select().from(odooSyncedOrders).where(eq(odooSyncedOrders.tenantId, getTenantId(ctx))).orderBy(desc(odooSyncedOrders.syncedAt)).limit(input.limit).offset(input.offset) };
    }),

  listInvoices: protectedProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { invoices: [] };
      return { invoices: await db.select().from(odooSyncedInvoices).where(eq(odooSyncedInvoices.tenantId, getTenantId(ctx))).orderBy(desc(odooSyncedInvoices.syncedAt)).limit(input.limit).offset(input.offset) };
    }),

  sendWhatsApp: protectedProcedure
    .input(z.object({ type: z.enum(["order", "invoice"]), recordId: z.string(), message: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getTenantId(ctx);
      if (input.type === "order") {
        await db.update(odooSyncedOrders).set({ whatsappSent: true }).where(eq(odooSyncedOrders.id, input.recordId));
      } else {
        await db.update(odooSyncedInvoices).set({ whatsappSent: true }).where(eq(odooSyncedInvoices.id, input.recordId));
      }
      return { success: true, sentAt: new Date() };
    }),
});
