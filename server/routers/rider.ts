/**
 * Rider handover for shops using their OWN riders (no OAK driver account): the shop copies a per-order link
 * (linkFor) and sends it to the rider; the rider opens it on their phone (view) and confirms the delivery with the
 * customer's PIN and a photo (confirm). The signed link is the only credential and only works for that order.
 * The shop also chooses whether a photo is required (photoRequirement / setPhotoRequired).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { router, publicProcedure, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { orders, tenants } from "../../drizzle/schema";
import { riderUrlFor, verifyRiderToken } from "../services/riderToken";
import { confirmHandover, decodePhoto, handoverRequirements } from "../services/delivery/handover";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

async function orderForToken(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, token: string) {
  const orderId = verifyRiderToken(token);
  if (!orderId) throw new TRPCError({ code: "NOT_FOUND", message: "This delivery link isn't valid. Ask the shop for a new one." });
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "This delivery link isn't valid. Ask the shop for a new one." });
  return order;
}

export const riderRouter = router({
  /** What the rider sees: the order, where it goes, and what the handover needs. No customer phone, no prices. */
  view: publicProcedure.input(z.object({ token: z.string().min(10).max(200) })).query(async ({ input }) => {
    const db = await requireDb();
    const order = await orderForToken(db, input.token);
    const [shop] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, order.tenantId)).limit(1);
    const address = (order.shippingAddress as any)?.raw ?? null;
    const items = Array.isArray(order.items) ? (order.items as any[]) : [];
    const reqs = await handoverRequirements(db, order.tenantId, order.id);
    return {
      shop: shop?.name ?? "Shop",
      orderNumber: order.orderNumber,
      address,
      items: items.map((i) => ({ name: String(i?.productName ?? i?.name ?? "Item"), quantity: Number(i?.quantity ?? 1) })),
      delivered: order.status === "delivered",
      cancelled: ["cancelled", "refunded"].includes(order.status),
      ...reqs,
    };
  }),

  confirm: publicProcedure.input(z.object({
    token: z.string().min(10).max(200),
    pin: z.string().max(12).optional(),
    photoBase64: z.string().max(12_000_000).optional(),
    photoMimeType: z.string().max(40).optional(),
  })).mutation(async ({ input }) => {
    const db = await requireDb();
    const order = await orderForToken(db, input.token);
    return confirmHandover(db, {
      tenantId: order.tenantId, orderId: order.id, pin: input.pin ?? null,
      photo: decodePhoto(input.photoBase64, input.photoMimeType), via: "rider_link",
    });
  }),

  /** The shop's link for one delivery order, to send to its rider. */
  linkFor: protectedProcedure.input(z.object({ orderId: z.string() })).query(async ({ ctx, input }) => {
    const db = await requireDb();
    const [order] = await db.select({ id: orders.id, tenantId: orders.tenantId, metadata: orders.metadata }).from(orders)
      .where(eq(orders.id, input.orderId)).limit(1);
    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
    assertTenantAccess(ctx.user, order.tenantId);
    return { url: riderUrlFor(order.id) };
  }),

  photoRequirement: protectedProcedure.input(z.object({ tenantId: z.string() })).query(async ({ ctx, input }) => {
    assertTenantAccess(ctx.user, input.tenantId);
    const db = await requireDb();
    const [t] = await db.select({ requirePod: tenants.requirePod }).from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
    return { required: t?.requirePod === true };
  }),

  setPhotoRequired: protectedProcedure.input(z.object({ tenantId: z.string(), required: z.boolean() })).mutation(async ({ ctx, input }) => {
    assertTenantAccess(ctx.user, input.tenantId);
    const db = await requireDb();
    await db.update(tenants).set({ requirePod: input.required }).where(and(eq(tenants.id, input.tenantId)));
    return { required: input.required };
  }),
});
