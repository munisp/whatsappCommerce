import { z } from "zod";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import * as db from "../db";
import { getDb } from "../db";
import { channelMessages, conversations } from "../../drizzle/schema";
import { eq, desc, and } from "drizzle-orm";

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

  // Found live 2026-09-26: this only ever read `channelMessages` — the same legacy table
  // `db.getConversations`/`getConversationStats` were fixed off of (BUG-01/02, QA-056), but this SIBLING
  // procedure never got the matching fix. A WhatsApp/Telegram conversation's `messageCount` now correctly
  // comes from real `nlp_sessions` data, but the actual message BODIES still only existed in a table
  // nothing writes to for those channels — so the timeline showed "This conversation has 12 messages, but
  // they could not be loaded" for every real WA/Telegram thread, exactly the QA-056 pattern (fix the
  // count, forget the detail view it feeds). Merges real `channelMessages` rows (still genuine for
  // ussd/sms/instagram/email) with the session's own `messageHistory` for whatsapp/telegram.
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
        .where(eq(channelMessages.tenantId, input.tenantId))
        .orderBy(desc(channelMessages.createdAt))
        .limit(input.limit);
      const realRows = input.customerPhone
        ? rows.filter(r => r.fromAddress === input.customerPhone || r.toAddress === input.customerPhone)
        : rows;

      const { nlpSessions } = await import("../../drizzle/schema");
      const { or } = await import("drizzle-orm");
      const sessionConds = [eq(nlpSessions.tenantId, input.tenantId)];
      if (input.customerPhone) {
        // A session key is either the raw phone (whatsapp) or "telegram:<chat_id>" — match either form.
        sessionConds.push(or(
          eq(nlpSessions.waPhoneNumber, input.customerPhone),
          eq(nlpSessions.waPhoneNumber, `telegram:${input.customerPhone}`),
        )!);
      }
      const sessions = await dbConn.select().from(nlpSessions).where(and(...sessionConds))
        .orderBy(desc(nlpSessions.lastActivityAt)).limit(20);

      // messageHistory has no per-message timestamp (documented in channels.ts's own synthesis) — this
      // spaces synthesized rows one minute apart counting back from the session's real lastActivityAt, so
      // the timeline orders and displays sensibly. It's an honest approximation of WHEN, never fabricated
      // WHAT: role/content come straight from the real stored turn.
      const synthRows: (typeof channelMessages.$inferSelect)[] = [];
      for (const s of sessions) {
        const history = Array.isArray(s.messageHistory) ? s.messageHistory as Array<{ role?: string; content?: string }> : [];
        const channel = s.waPhoneNumber.startsWith("telegram:") ? "telegram" : "whatsapp";
        const rawAddress = s.waPhoneNumber.startsWith("telegram:") ? s.waPhoneNumber.slice("telegram:".length) : s.waPhoneNumber;
        const base = new Date(s.lastActivityAt).getTime();
        history.forEach((h, i) => {
          const direction = h.role === "assistant" ? "outbound" : "inbound";
          synthRows.push({
            id: `${s.id}:${i}`,
            channel: channel as any,
            direction: direction as any,
            fromAddress: direction === "outbound" ? input.tenantId : rawAddress,
            toAddress: direction === "outbound" ? rawAddress : input.tenantId,
            tenantId: s.tenantId,
            body: h.content ?? "",
            nlpResponse: null,
            processed: true,
            metadata: null,
            createdAt: new Date(base - (history.length - 1 - i) * 60_000),
          } as typeof channelMessages.$inferSelect);
        });
      }

      return [...realRows, ...synthRows]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, input.limit);
    }),

  // Found live 2026-09-26, aggressive dashboard QA sweep: this was hardcoded to a direct WhatsApp Graph API
  // call — a Telegram chat id passed as `toPhone` would just fail (Meta rejects it as an invalid recipient).
  // Also used the GLOBAL `ENV.waToken`/`ENV.waPhoneNumberId` env vars instead of this TENANT's own configured
  // credentials (every other WhatsApp sender in this codebase resolves per-tenant creds — this one didn't),
  // so a reply from any tenant other than whichever one happens to own those global env values would have
  // sent from the wrong WhatsApp number, or failed outright. Routed through the same channel-agnostic
  // `sendChannelMessage` facade the rest of the platform uses — fixes both issues at once.
  sendMessage: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      toPhone: z.string(),
      channel: z.enum(["whatsapp", "telegram"]).default("whatsapp"),
      body: z.string().min(1).max(4096),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      try {
        const { sendChannelMessage } = await import("../services/channelSender");
        const result = await sendChannelMessage(input.tenantId, input.channel, input.toPhone, { kind: "text", text: input.body });
        if (!result.sent && !result.simulated) {
          return { sent: false, error: "Message could not be delivered — check the channel's credentials are configured for this tenant." };
        }
        // Store outbound message in channelMessages for timeline display
        const dbConn = await getDb();
        if (dbConn) {
          await dbConn.insert(channelMessages).values({
            channel: input.channel,
            direction: "outbound",
            fromAddress: input.tenantId,
            toAddress: input.toPhone,
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
