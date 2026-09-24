// === W47 stakeholders ===
/**
 * riders.ts — ONB-S-10 driver/rider onboarding (mig 0167).
 *
 * Previously there was NO rider entity: "local-dispatch" deliveries were
 * flipped to delivered by any tenant member and the rider was whoever
 * showed up. This router adds the minimum honest rail:
 *
 *  - register: merchant captures the rider's phone (+ optional ID ref);
 *    the row starts 'pending'. One row per (tenant, phone).
 *  - approve/suspend: merchant-side lifecycle (claim-first status flips,
 *    audited). Only ACTIVE riders can be assigned.
 *  - assign: binds a delivery to an active rider (deliveries.rider_id).
 *  - riderUpdate: rider-side status update authenticated by a
 *    phone_identity proof (phoneAuth OTP) matching the ASSIGNED rider's
 *    phone — a random tenant member's say-so is no longer the only path.
 */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import jwt from "jsonwebtoken";
import { analystProcedure, operatorProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { deliveries, riders } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { writeAuditLog } from "./audit";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

const riderStatusEnum = z.enum(["picked_up", "in_transit", "delivered", "failed"]);

export const ridersRouter = router({
  /** Register a rider (starts pending — merchant must approve). */
  register: operatorProcedure
    .input(z.object({
      tenantId: z.string(),
      phone: z.string().min(7).max(30),
      name: z.string().min(1).max(160),
      idReference: z.string().max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const { normalisePhone } = await import("./phoneAuth");
      const phone = normalisePhone(input.phone);
      const [existing] = await db.select().from(riders)
        .where(and(eq(riders.tenantId, input.tenantId), eq(riders.phone, phone))).limit(1);
      if (existing) return { rider: existing, duplicate: true };
      const [rider] = await db.insert(riders).values({
        tenantId: input.tenantId,
        phone,
        name: input.name.trim(),
        idReference: input.idReference ?? null,
        createdBy: String(ctx.user!.id),
      }).returning();
      await writeAuditLog({
        actorId: String(ctx.user!.id), actorRole: ctx.user!.role,
        action: "rider.registered", entityType: "rider", entityId: rider.id,
        tenantId: input.tenantId,
        summary: `Rider "${rider.name}" (${phone}) registered on tenant ${input.tenantId} (pending approval)`,
        before: null, after: { riderId: rider.id, phone, status: "pending" },
      });
      return { rider, duplicate: false };
    }),

  /** Approve a pending rider (claim-first pending→active). */
  approve: operatorProcedure
    .input(z.object({ tenantId: z.string(), riderId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const flipped = await db.update(riders)
        .set({ status: "active", approvedBy: String(ctx.user!.id), updatedAt: new Date() })
        .where(and(eq(riders.id, input.riderId), eq(riders.tenantId, input.tenantId), eq(riders.status, "pending")))
        .returning();
      if (!flipped.length) {
        const [row] = await db.select().from(riders)
          .where(and(eq(riders.id, input.riderId), eq(riders.tenantId, input.tenantId))).limit(1);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Rider not found" });
        if (row.status === "active") return { rider: row, duplicate: true };
        throw new TRPCError({ code: "CONFLICT", message: `Cannot approve a rider in status "${row.status}"` });
      }
      await writeAuditLog({
        actorId: String(ctx.user!.id), actorRole: ctx.user!.role,
        action: "rider.approved", entityType: "rider", entityId: input.riderId,
        tenantId: input.tenantId,
        summary: `Rider ${input.riderId} approved on tenant ${input.tenantId}`,
        before: { status: "pending" }, after: { status: "active", approvedBy: String(ctx.user!.id) },
      });
      // ONB-S-16: the rider is told they are active (best-effort).
      try {
        const { sendCustomerText } = await import("../services/channelParity");
        await sendCustomerText(input.tenantId, flipped[0].phone, "staff_membership",
          "You are now an approved rider. Delivery updates you send must come from this phone number.",
          { notifType: "rider_approved" });
      } catch { /* best-effort */ }
      return { rider: flipped[0] };
    }),

  /** Suspend a rider (they can no longer be assigned or update). */
  suspend: operatorProcedure
    .input(z.object({ tenantId: z.string(), riderId: z.string().uuid(), reason: z.string().max(300).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const flipped = await db.update(riders)
        .set({ status: "suspended", updatedAt: new Date() })
        .where(and(eq(riders.id, input.riderId), eq(riders.tenantId, input.tenantId), eq(riders.status, "active")))
        .returning();
      if (!flipped.length) {
        const [row] = await db.select().from(riders)
          .where(and(eq(riders.id, input.riderId), eq(riders.tenantId, input.tenantId))).limit(1);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Rider not found" });
        throw new TRPCError({ code: "CONFLICT", message: `Cannot suspend a rider in status "${row.status}"` });
      }
      await writeAuditLog({
        actorId: String(ctx.user!.id), actorRole: ctx.user!.role,
        action: "rider.suspended", entityType: "rider", entityId: input.riderId,
        tenantId: input.tenantId,
        summary: `Rider ${input.riderId} suspended on tenant ${input.tenantId}${input.reason ? `: ${input.reason}` : ""}`,
        before: { status: "active" }, after: { status: "suspended", reason: input.reason ?? null },
      });
      return { rider: flipped[0] };
    }),

  /** List riders (read-only). */
  list: analystProcedure
    .input(z.object({ tenantId: z.string(), status: z.enum(["pending", "active", "suspended"]).optional() }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const conds = [eq(riders.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(riders.status, input.status));
      return db.select().from(riders).where(and(...conds)).orderBy(desc(riders.createdAt)).limit(200);
    }),

  /** Assign a delivery to an ACTIVE rider (per-delivery claim trail). */
  assign: operatorProcedure
    .input(z.object({ tenantId: z.string(), deliveryId: z.string().uuid(), riderId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const [rider] = await db.select().from(riders)
        .where(and(eq(riders.id, input.riderId), eq(riders.tenantId, input.tenantId))).limit(1);
      if (!rider) throw new TRPCError({ code: "NOT_FOUND", message: "Rider not found" });
      if (rider.status !== "active") {
        throw new TRPCError({ code: "CONFLICT", message: `Rider is ${rider.status} — only active riders can be assigned` });
      }
      const [delivery] = await db.select().from(deliveries)
        .where(and(eq(deliveries.id, input.deliveryId), eq(deliveries.tenantId, input.tenantId))).limit(1);
      if (!delivery) throw new TRPCError({ code: "NOT_FOUND", message: "Delivery not found" });
      if (["delivered", "cancelled", "failed"].includes(delivery.status)) {
        throw new TRPCError({ code: "CONFLICT", message: `Delivery is already ${delivery.status}` });
      }
      await db.update(deliveries).set({ riderId: rider.id, updatedAt: new Date() })
        .where(eq(deliveries.id, delivery.id));
      await writeAuditLog({
        actorId: String(ctx.user!.id), actorRole: ctx.user!.role,
        action: "rider.assigned", entityType: "delivery", entityId: delivery.id,
        tenantId: input.tenantId,
        summary: `Delivery ${delivery.id} (order ${delivery.orderId}) assigned to rider ${rider.name} (${rider.phone})`,
        before: { riderId: delivery.riderId ?? null }, after: { riderId: rider.id },
      });
      return { assigned: true, deliveryId: delivery.id, riderId: rider.id, riderPhone: rider.phone };
    }),

  /**
   * Rider-side status update: authenticated by a phone_identity proof
   * (phoneAuth OTP) whose phone matches the ASSIGNED rider's phone. The
   * delivery must have an assigned active rider.
   */
  riderUpdate: publicProcedure
    .input(z.object({
      deliveryId: z.string().uuid(),
      status: riderStatusEnum,
      identityProof: z.string().min(10),
    }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      const [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, input.deliveryId)).limit(1);
      if (!delivery) throw new TRPCError({ code: "NOT_FOUND", message: "Delivery not found" });
      if (!delivery.riderId) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No rider assigned to this delivery" });
      }
      const [rider] = await db.select().from(riders)
        .where(and(eq(riders.id, delivery.riderId), eq(riders.tenantId, delivery.tenantId))).limit(1);
      if (!rider || rider.status !== "active") {
        throw new TRPCError({ code: "CONFLICT", message: "Assigned rider is not active" });
      }
      let proof: any;
      try {
        proof = jwt.verify(input.identityProof, ENV.jwtSecret);
      } catch {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Identity proof is invalid or expired — re-verify your phone." });
      }
      const digits = (p: string) => p.replace(/\D/g, "");
      if (proof?.type !== "phone_identity" || typeof proof.phone !== "string" || digits(proof.phone) !== digits(rider.phone)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Identity proof does not match the assigned rider's phone" });
      }
      const { applyDeliveryStatus } = await import("../services/delivery/service");
      const result = await applyDeliveryStatus(db, delivery.id, { status: input.status });
      await writeAuditLog({
        actorId: `rider:${rider.id}`, actorRole: "user",
        action: "rider.statusUpdate", entityType: "delivery", entityId: delivery.id,
        tenantId: delivery.tenantId,
        summary: `Rider ${rider.name} marked delivery ${delivery.id} as ${input.status} (phone-proof authenticated)`,
        before: { status: delivery.status }, after: { status: input.status },
      });
      return result;
    }),
});
// === END W47 stakeholders ===
