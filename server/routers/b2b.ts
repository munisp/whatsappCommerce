import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { router, protectedProcedure, publicProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { wholesalePriceTiers, b2bRfq, b2bPurchaseOrders } from "../../drizzle/schema";
import { randomUUID } from "crypto";

const ItemSchema = z.object({
  productId: z.string(),
  productName: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.string().optional(),
});

export const b2bRouter = router({
  // ── Wholesale Price Tiers ────────────────────────────────────────────────
  listPriceTiers: protectedProcedure
    .input(z.object({ tenantId: z.string(), productId: z.string().optional() }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds = [eq(wholesalePriceTiers.tenantId, input.tenantId)];
      if (input.productId) conds.push(eq(wholesalePriceTiers.productId, input.productId));
      return db.select().from(wholesalePriceTiers).where(and(...conds)).orderBy(wholesalePriceTiers.minQuantity);
    }),

  upsertPriceTier: protectedProcedure
    .input(z.object({
      id: z.string().optional(),
      tenantId: z.string(),
      productId: z.string(),
      buyerType: z.enum(["retail", "wholesale", "distributor", "government"]),
      minQuantity: z.number().int().positive(),
      maxQuantity: z.number().int().positive().optional(),
      unitPrice: z.string(),
      currency: z.string().default("NGN"),
      discountPercent: z.string().optional(),
      paymentTermsDays: z.number().int().default(0),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const id = input.id ?? randomUUID();
      const now = new Date();
      const { id: _id, ...rest } = input;
      await db.insert(wholesalePriceTiers).values({ ...rest, id, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: wholesalePriceTiers.id,
          set: { ...rest, updatedAt: now },
        });
      return { id };
    }),

  deletePriceTier: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      await db.delete(wholesalePriceTiers).where(eq(wholesalePriceTiers.id, input.id));
      return { ok: true };
    }),

  // ── RFQ (Request for Quotation) ──────────────────────────────────────────
  listRfqs: protectedProcedure
    .input(z.object({ tenantId: z.string(), status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds = [eq(b2bRfq.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(b2bRfq.status, input.status as "draft" | "submitted" | "quoted" | "accepted" | "rejected" | "expired"));
      return db.select().from(b2bRfq).where(and(...conds)).orderBy(desc(b2bRfq.createdAt)).limit(input.limit);
    }),

  submitRfq: publicProcedure
    .input(z.object({
      tenantId: z.string(),
      buyerPhone: z.string(),
      buyerName: z.string().optional(),
      buyerType: z.enum(["retail", "wholesale", "distributor", "government"]).default("wholesale"),
      items: z.array(ItemSchema),
      currency: z.string().default("NGN"),
      notes: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const id = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days
      await db.insert(b2bRfq).values({
        id, ...input, items: input.items as unknown as typeof b2bRfq.$inferInsert["items"],
        status: "submitted", expiresAt, createdAt: now, updatedAt: now,
      });
      return { id, expiresAt };
    }),

  quoteRfq: protectedProcedure
    .input(z.object({ id: z.string(), quotedPrice: z.string(), notes: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      await db.update(b2bRfq).set({ status: "quoted", quotedPrice: input.quotedPrice, quotedAt: new Date(), notes: input.notes, updatedAt: new Date() })
        .where(eq(b2bRfq.id, input.id));
      return { ok: true };
    }),

  updateRfqStatus: protectedProcedure
    .input(z.object({ id: z.string(), status: z.enum(["accepted", "rejected", "expired"]) }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      await db.update(b2bRfq).set({ status: input.status, updatedAt: new Date() }).where(eq(b2bRfq.id, input.id));
      return { ok: true };
    }),

  // ── Purchase Orders ──────────────────────────────────────────────────────
  listPurchaseOrders: protectedProcedure
    .input(z.object({ tenantId: z.string(), status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds = [eq(b2bPurchaseOrders.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(b2bPurchaseOrders.status, input.status as "draft" | "submitted" | "approved" | "rejected" | "fulfilled" | "cancelled"));
      return db.select().from(b2bPurchaseOrders).where(and(...conds)).orderBy(desc(b2bPurchaseOrders.createdAt)).limit(input.limit);
    }),

  createPurchaseOrder: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      rfqId: z.string().optional(),
      buyerPhone: z.string(),
      buyerName: z.string().optional(),
      buyerType: z.enum(["retail", "wholesale", "distributor", "government"]).default("wholesale"),
      items: z.array(ItemSchema),
      totalAmount: z.string(),
      currency: z.string().default("NGN"),
      paymentTermsDays: z.number().int().default(0),
      deliveryAddress: z.record(z.string(), z.unknown()).optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const id = randomUUID();
      const poNumber = `PO-${Date.now().toString(36).toUpperCase()}`;
      const now = new Date();
      const dueDate = new Date(now.getTime() + input.paymentTermsDays * 24 * 60 * 60 * 1000);
      await db.insert(b2bPurchaseOrders).values({
        id, poNumber, ...input,
        items: input.items as unknown as typeof b2bPurchaseOrders.$inferInsert["items"],
        status: "submitted", dueDate, createdAt: now, updatedAt: now,
      });
      return { id, poNumber };
    }),

  approvePurchaseOrder: protectedProcedure
    .input(z.object({ id: z.string(), approvedBy: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      await db.update(b2bPurchaseOrders).set({ status: "approved", approvedBy: input.approvedBy, approvedAt: new Date(), updatedAt: new Date() })
        .where(eq(b2bPurchaseOrders.id, input.id));
      return { ok: true };
    }),

  updatePoStatus: protectedProcedure
    .input(z.object({ id: z.string(), status: z.enum(["rejected", "fulfilled", "cancelled"]) }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      await db.update(b2bPurchaseOrders).set({ status: input.status, updatedAt: new Date() }).where(eq(b2bPurchaseOrders.id, input.id));
      return { ok: true };
    }),

  // ── Analytics ────────────────────────────────────────────────────────────
  b2bStats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const [rfqStats] = await db.select({
        total: sql<number>`count(*)`,
        pending: sql<number>`count(*) filter (where status = 'submitted')`,
        quoted: sql<number>`count(*) filter (where status = 'quoted')`,
        accepted: sql<number>`count(*) filter (where status = 'accepted')`,
      }).from(b2bRfq).where(eq(b2bRfq.tenantId, input.tenantId));
      const [poStats] = await db.select({
        total: sql<number>`count(*)`,
        pending: sql<number>`count(*) filter (where status = 'submitted')`,
        approved: sql<number>`count(*) filter (where status = 'approved')`,
        fulfilled: sql<number>`count(*) filter (where status = 'fulfilled')`,
      }).from(b2bPurchaseOrders).where(eq(b2bPurchaseOrders.tenantId, input.tenantId));
      return { rfq: rfqStats, purchaseOrders: poStats };
    }),
});
