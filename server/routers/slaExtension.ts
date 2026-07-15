import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { escrowSlaExtensions, escrowTransactions } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import crypto from "crypto";
import { emitNotification } from "./notifications";

export const slaExtensionRouter = router({
  // Merchant requests an SLA extension for a specific escrow
  requestExtension: protectedProcedure
    .input(z.object({
      escrowId: z.string().uuid(),
      extensionHours: z.number().int().min(1).max(168).default(24),
      reason: z.string().max(500).optional(),
      buyerPhone: z.string().max(30).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) throw new TRPCError({ code: "FORBIDDEN", message: "No tenant associated" });

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      // Verify escrow belongs to this tenant
      const [escrow] = await db
        .select()
        .from(escrowTransactions)
        .where(and(
          eq(escrowTransactions.id, input.escrowId),
          eq(escrowTransactions.tenantId, tenantId),
        ))
        .limit(1);

      if (!escrow) throw new TRPCError({ code: "NOT_FOUND", message: "Escrow transaction not found" });

      if (["settled", "refunded", "expired"].includes(escrow.state)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot request extension for a completed escrow" });
      }

      // Check for existing pending extension
      const [existing] = await db
        .select({ id: escrowSlaExtensions.id, status: escrowSlaExtensions.status })
        .from(escrowSlaExtensions)
        .where(and(
          eq(escrowSlaExtensions.escrowId, input.escrowId),
          eq(escrowSlaExtensions.status, "pending"),
        ))
        .limit(1);

      if (existing) {
        throw new TRPCError({ code: "CONFLICT", message: "A pending extension request already exists for this escrow" });
      }

      const buyerToken = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h for buyer to respond

      const id = crypto.randomUUID();
      await db.insert(escrowSlaExtensions).values({
        id,
        escrowId: input.escrowId,
        requestedByTenantId: tenantId,
        extensionHours: input.extensionHours,
        reason: input.reason,
        status: "pending",
        buyerToken,
        buyerPhone: input.buyerPhone,
        requestedAt: new Date(),
        expiresAt,
      });

      // Notify merchant that request was sent
      await emitNotification({
        tenantId,
        type: "system",
        title: "SLA Extension Requested",
        body: `You requested a ${input.extensionHours}-hour delivery extension for order ${escrow.orderId.slice(0, 8)}. Awaiting buyer response.`,
        metadata: { escrowId: input.escrowId, extensionId: id },
      }).catch(() => {});

      const buyerUrl = `/sla-extension/${buyerToken}`;
      // Send WhatsApp notification to buyer if phone provided
      let whatsappSent = false;
      const buyerPhone = input.buyerPhone ?? null;
      if (buyerPhone) {
        const { ENV } = await import("../_core/env");
        const appUrl = ENV.appUrl ?? "http://localhost:3000";
        const fullUrl = `${appUrl}/sla-extension/${buyerToken}`;
        const waMsg = `Hello! The merchant has requested a ${input.extensionHours}-hour delivery extension for your order${escrow.orderId ? ` (${escrow.orderId.slice(0, 8)})` : ""}.\n\nReason: ${input.reason ?? "Not specified"}\n\nPlease click the link below to approve or reject:\n${fullUrl}\n\nThis link expires in 48 hours.`;
        const result = await sendWhatsAppSLA(buyerPhone, waMsg);
        whatsappSent = result.sent;
      }
      return {
        success: true,
        extensionId: id,
        buyerToken,
        buyerUrl,
        expiresAt,
        whatsappSent,
        message: `Extension request created. Share this link with the buyer: ${buyerUrl}`,
      };
    }),

  // List extension requests for a tenant's escrows
  listExtensions: protectedProcedure
    .input(z.object({
      escrowId: z.string().uuid().optional(),
      status: z.enum(["pending", "approved", "rejected", "expired"]).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) throw new TRPCError({ code: "FORBIDDEN", message: "No tenant associated" });

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const conditions = [eq(escrowSlaExtensions.requestedByTenantId, tenantId)];
      if (input.escrowId) conditions.push(eq(escrowSlaExtensions.escrowId, input.escrowId));
      if (input.status) conditions.push(eq(escrowSlaExtensions.status, input.status));

      const rows = await db
        .select()
        .from(escrowSlaExtensions)
        .where(and(...conditions))
        .orderBy(escrowSlaExtensions.requestedAt);

      return rows;
    }),

  // Public: get extension request details by buyer token (no auth)
  getByToken: publicProcedure
    .input(z.object({ token: z.string().length(64) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [ext] = await db
        .select()
        .from(escrowSlaExtensions)
        .where(eq(escrowSlaExtensions.buyerToken, input.token))
        .limit(1);

      if (!ext) throw new TRPCError({ code: "NOT_FOUND", message: "Extension request not found or expired" });

      // Check if expired
      if (ext.status === "pending" && new Date() > ext.expiresAt) {
        const db2 = await getDb();
        if (db2) {
          await db2.update(escrowSlaExtensions)
            .set({ status: "expired" })
            .where(eq(escrowSlaExtensions.id, ext.id));
        }
        throw new TRPCError({ code: "NOT_FOUND", message: "This extension request has expired" });
      }

      // Get escrow details for context
      const [escrow] = await db
        .select({
          orderId: escrowTransactions.orderId,
          amount: escrowTransactions.amount,
          state: escrowTransactions.state,
          buyerConfirmDeadline: escrowTransactions.buyerConfirmDeadline,
        })
        .from(escrowTransactions)
        .where(eq(escrowTransactions.id, ext.escrowId))
        .limit(1);

      return {
        id: ext.id,
        status: ext.status,
        extensionHours: ext.extensionHours,
        reason: ext.reason,
        requestedAt: ext.requestedAt,
        expiresAt: ext.expiresAt,
        newDeadline: ext.newDeadline,
        orderId: escrow?.orderId,
        orderAmount: escrow?.amount,
        currentDeadline: escrow?.buyerConfirmDeadline,
      };
    }),

  // Public: buyer responds to extension request
  respondToExtension: publicProcedure
    .input(z.object({
      token: z.string().length(64),
      decision: z.enum(["approved", "rejected"]),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [ext] = await db
        .select()
        .from(escrowSlaExtensions)
        .where(eq(escrowSlaExtensions.buyerToken, input.token))
        .limit(1);

      if (!ext) throw new TRPCError({ code: "NOT_FOUND", message: "Extension request not found" });
      if (ext.status !== "pending") throw new TRPCError({ code: "BAD_REQUEST", message: `Request already ${ext.status}` });
      if (new Date() > ext.expiresAt) throw new TRPCError({ code: "BAD_REQUEST", message: "This request has expired" });

      const now = new Date();
      let newDeadline: Date | null = null;

      if (input.decision === "approved") {
        // Extend the escrow's buyerConfirmDeadline
        const [escrow] = await db
          .select({ buyerConfirmDeadline: escrowTransactions.buyerConfirmDeadline })
          .from(escrowTransactions)
          .where(eq(escrowTransactions.id, ext.escrowId))
          .limit(1);

        const currentDeadline = escrow?.buyerConfirmDeadline ?? now;
        newDeadline = new Date(currentDeadline.getTime() + ext.extensionHours * 60 * 60 * 1000);

        await db.update(escrowTransactions)
          .set({ buyerConfirmDeadline: newDeadline, updatedAt: now })
          .where(eq(escrowTransactions.id, ext.escrowId));
      }

      await db.update(escrowSlaExtensions)
        .set({
          status: input.decision,
          respondedAt: now,
          newDeadline,
        })
        .where(eq(escrowSlaExtensions.id, ext.id));

      // Notify merchant of buyer's decision
      await emitNotification({
        tenantId: ext.requestedByTenantId,
        type: "system",
        title: input.decision === "approved" ? "SLA Extension Approved" : "SLA Extension Rejected",
        body: input.decision === "approved"
          ? `Buyer approved your ${ext.extensionHours}-hour extension. New deadline: ${newDeadline?.toLocaleString()}`
          : "Buyer rejected your SLA extension request. Original deadline still applies.",
        metadata: { escrowId: ext.escrowId, extensionId: ext.id },
      }).catch(() => {});

      return {
        success: true,
        decision: input.decision,
        newDeadline,
        message: input.decision === "approved"
          ? `Extension approved. Delivery deadline extended by ${ext.extensionHours} hours.`
          : "Extension rejected. The original delivery deadline remains.",
      };
    }),
});

// ── WhatsApp helper ───────────────────────────────────────────────────────────
async function sendWhatsAppSLA(phone: string, message: string): Promise<{ sent: boolean; error?: string }> {
  const { ENV } = await import("../_core/env");
  if (!ENV.waToken || !ENV.waPhoneNumberId) {
    return { sent: false, error: "WhatsApp credentials not configured" };
  }
  const normalized = phone.startsWith("+") ? phone : `+234${phone.replace(/^0/, "")}`;
  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${ENV.waPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ENV.waToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: normalized,
          type: "text",
          text: { body: message },
        }),
      }
    );
    return res.ok ? { sent: true } : { sent: false, error: `HTTP ${res.status}` };
  } catch (e: any) {
    return { sent: false, error: e.message };
  }
}
