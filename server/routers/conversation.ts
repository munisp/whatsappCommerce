import { z } from "zod";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import * as db from "../db";
import { getDb } from "../db";
import { channelMessages, conversations } from "../../drizzle/schema";
import { eq, desc, and, or } from "drizzle-orm";
import { ENV } from "../_core/env";

export const conversationRouter = router({
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return db.getConversations(input.tenantId, input.status, input.limit, input.offset);
    }),

  stats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return db.getConversationStats(input.tenantId);
    }),

  getMessages: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      customerPhone: z.string().optional(),
      limit: z.number().default(60),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const dbConn = await getDb();
      if (!dbConn) return [];
      const rows = await dbConn
        .select()
        .from(channelMessages)
        // === W48 PERF-API-11 (api-db): phone predicate pushed INTO SQL —
        // previously fetched the tenant's latest 60 rows and filtered by
        // phone in JS (wrong page contents + wasted transfer). ===
        .where(input.customerPhone
          ? and(
              eq(channelMessages.tenantId, input.tenantId),
              or(
                eq(channelMessages.fromAddress, input.customerPhone),
                eq(channelMessages.toAddress, input.customerPhone),
              ))
          : eq(channelMessages.tenantId, input.tenantId))
        .orderBy(desc(channelMessages.createdAt))
        .limit(input.limit);
      return rows;
    }),

  sendMessage: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      toPhone: z.string(),
      body: z.string().min(1).max(4096),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      // === W48 integrations (PERF-INT-4) ===
      // Was: raw fetch to graph.facebook.com/v19.0 with no timeout, no retry,
      // no ban-circuit check, no suppression-list check, no usage metering —
      // and version drift vs the rest of the platform (v21.0). Now routed
      // through waSender.sendWhatsAppText: 12s AbortController timeout,
      // retriable classification, ban circuit breaker, per-tenant credential
      // resolution, metering + send log. The agent reply UX can no longer
      // hang indefinitely on a stalled Graph connection, and a banned sender
      // fails fast locally instead of hammering Graph.
      const normalized = input.toPhone.startsWith("+") ? input.toPhone : `+${input.toPhone.replace(/\D/g, "")}`;
      try {
        const { sendWhatsAppText } = await import("../services/waSender");
        const result = await sendWhatsAppText(input.tenantId, normalized, input.body, {
          notifType: "portal_agent_reply",
          userId: ctx.user?.id ?? null,
        });
        if (!result.sent && !result.simulated) {
          return { sent: false, error: "WhatsApp send failed — see send log" };
        }
        // Store outbound message in channelMessages for timeline display
        const dbConn = await getDb();
        if (dbConn) {
          await dbConn.insert(channelMessages).values({
            channel: "whatsapp",
            direction: "outbound",
            fromAddress: ENV.waPhoneNumberId ?? "tenant-sender",
            toAddress: normalized,
            tenantId: input.tenantId,
            body: input.body,
            processed: true,
          });
        }
        return { sent: true, simulated: result.simulated, wamids: result.wamids };
      } catch (e: any) {
        return { sent: false, error: e.message };
      }
    }),

  updateStatus: protectedProcedure
    .input(z.object({
      conversationId: z.string(),
      status: z.enum(["open", "resolved", "pending", "snoozed", "bot_active", "human_active"]),
    }))
    .mutation(async ({ input, ctx }) => {
      const dbConn = await getDb();
      if (!dbConn) throw new Error("DB unavailable");
      const [conv] = await dbConn
        .select({ tenantId: conversations.tenantId })
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .limit(1);
      if (!conv) throw new Error("Conversation not found");
      assertTenantAccess(ctx.user, conv.tenantId);
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
