import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import * as db from "../db";
import { getDb } from "../db";
import { channelMessages, conversations } from "../../drizzle/schema";
import { eq, desc } from "drizzle-orm";
import { ENV } from "../_core/env";

export const conversationRouter = router({
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input }) => {
      return db.getConversations(input.tenantId, input.status, input.limit, input.offset);
    }),

  stats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      return db.getConversationStats(input.tenantId);
    }),

  getMessages: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      customerPhone: z.string().optional(),
      limit: z.number().default(60),
    }))
    .query(async ({ input }) => {
      const dbConn = await getDb();
      if (!dbConn) return [];
      const rows = await dbConn
        .select()
        .from(channelMessages)
        .where(eq(channelMessages.tenantId, input.tenantId))
        .orderBy(desc(channelMessages.createdAt))
        .limit(input.limit);
      // Filter by phone if provided (match fromAddress or toAddress)
      if (input.customerPhone) {
        return rows.filter(r =>
          r.fromAddress === input.customerPhone || r.toAddress === input.customerPhone
        );
      }
      return rows;
    }),

  sendMessage: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      toPhone: z.string(),
      body: z.string().min(1).max(4096),
    }))
    .mutation(async ({ input }) => {
      if (!ENV.waToken || !ENV.waPhoneNumberId) {
        return { sent: false, error: "WhatsApp credentials not configured — set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in Secrets." };
      }
      const normalized = input.toPhone.startsWith("+") ? input.toPhone : `+${input.toPhone.replace(/\D/g, "")}`;
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
              text: { body: input.body },
            }),
          }
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as any;
          return { sent: false, error: err?.error?.message ?? `HTTP ${res.status}` };
        }
        // Store outbound message in channelMessages for timeline display
        const dbConn = await getDb();
        if (dbConn) {
          await dbConn.insert(channelMessages).values({
            channel: "whatsapp",
            direction: "outbound",
            fromAddress: ENV.waPhoneNumberId,
            toAddress: normalized,
            tenantId: input.tenantId,
            body: input.body,
            processed: true,
          });
        }
        return { sent: true };
      } catch (e: any) {
        return { sent: false, error: e.message };
      }
    }),

  updateStatus: protectedProcedure
    .input(z.object({
      conversationId: z.string(),
      status: z.enum(["open", "resolved", "pending", "snoozed", "bot_active", "human_active"]),
    }))
    .mutation(async ({ input }) => {
      const dbConn = await getDb();
      if (!dbConn) throw new Error("DB unavailable");
      await dbConn
        .update(conversations)
        .set({
          status: input.status as any,
          ...(input.status === "resolved" ? { resolvedAt: new Date() } : {}),
          ...(input.status === "human_active" ? { escalatedAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, input.conversationId));
      return { ok: true };
    }),
});
