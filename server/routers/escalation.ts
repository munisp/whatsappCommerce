/**
 * server/routers/escalation.ts — W23 (additive): minimal human-escalation
 * router for the support inbox, reusing the EXISTING conversations /
 * channelMessages / customers tables (no migration).
 *
 * The WhatsApp "Talk to a human" handoff (services/useCases.ts) flags an
 * open conversation (status=pending, aiHandled=false, escalatedAt). This
 * router owns the agent-side lifecycle around that flag:
 *
 *   openConversation → find-or-create the customer's conversation row
 *                      (status bot_active — the bot is handling the thread);
 *   escalate         → bot_active/open/pending → human_active, assigns the
 *                      calling agent, stamps escalatedAt (id-keyed tenant
 *                      check BEFORE mutation);
 *   resolve          → any non-resolved state → resolved, stamps resolvedAt;
 *   get              → read one conversation (tenant-checked by lookup).
 *
 * Every procedure is tenant-guarded (assertTenantAccess) — authz ratchet
 * compliant.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, ne } from "drizzle-orm";
import { randomUUID } from "crypto";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { channelMessages, conversations, customers } from "../../drizzle/schema";

async function loadConversation(conversationId: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv) throw new TRPCError({ code: "NOT_FOUND", message: "Conversation not found" });
  return { db, conv };
}

export const escalationRouter = router({
  /** Find-or-create the open conversation for a customer phone (bot_active). */
  openConversation: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      customerPhone: z.string().min(5),
      customerName: z.string().max(160).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const phone = input.customerPhone.trim();
      const now = new Date();

      // Resolve/create the customer (unique per tenant+phone).
      let [customer] = await db
        .select()
        .from(customers)
        .where(and(eq(customers.tenantId, input.tenantId), eq(customers.whatsappPhone, phone)))
        .limit(1);
      if (!customer) {
        const id = randomUUID();
        await db.insert(customers).values({
          id,
          tenantId: input.tenantId,
          whatsappPhone: phone,
          name: input.customerName?.trim() || null,
          createdAt: now,
          updatedAt: now,
        });
        customer = { id } as any;
      }

      // Reuse the latest non-resolved conversation for this customer.
      const [existing] = await db
        .select()
        .from(conversations)
        .where(and(
          eq(conversations.tenantId, input.tenantId),
          eq(conversations.customerId, customer.id),
          ne(conversations.status, "resolved"),
        ))
        .orderBy(desc(conversations.updatedAt))
        .limit(1);
      if (existing) return { conversation: existing, created: false };

      const id = randomUUID();
      await db.insert(conversations).values({
        id,
        tenantId: input.tenantId,
        customerId: customer.id,
        // "open" + aiHandled=true: the bot owns the thread. (The WhatsApp
        // handoff handler flags conversations in status "open".)
        status: "open",
        channel: "whatsapp",
        messageCount: 0,
        aiHandled: true,
        createdAt: now,
        updatedAt: now,
      });
      const [conversation] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
      return { conversation, created: true };
    }),

  /** Escalate a conversation to a human agent (assigns the caller). */
  escalate: protectedProcedure
    .input(z.object({
      conversationId: z.string().min(1),
      note: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { db, conv } = await loadConversation(input.conversationId);
      // Tenant isolation: id-keyed lookups verify ownership BEFORE mutation.
      assertTenantAccess(ctx.user, conv.tenantId);
      if (conv.status === "resolved") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot escalate a resolved conversation" });
      }
      const now = new Date();
      const prevMeta = (conv.metadata as Record<string, unknown> | null) ?? {};
      await db
        .update(conversations)
        .set({
          status: "human_active",
          aiHandled: false,
          assignedAgentId: String(ctx.user.id),
          escalatedAt: conv.escalatedAt ?? now,
          metadata: { ...prevMeta, ...(input.note ? { escalationNote: input.note } : {}) },
          updatedAt: now,
        })
        .where(eq(conversations.id, conv.id));
      const [updated] = await db.select().from(conversations).where(eq(conversations.id, conv.id)).limit(1);
      return updated;
    }),

  /** Resolve a conversation (stamps resolvedAt). Idempotent. */
  resolve: protectedProcedure
    .input(z.object({ conversationId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { db, conv } = await loadConversation(input.conversationId);
      assertTenantAccess(ctx.user, conv.tenantId);
      if (conv.status !== "resolved") {
        await db
          .update(conversations)
          .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
          .where(eq(conversations.id, conv.id));
      }
      const [updated] = await db.select().from(conversations).where(eq(conversations.id, conv.id)).limit(1);
      return updated;
    }),

  /**
   * Agent reply in-thread. Unlike conversation.sendMessage (global ENV
   * creds), this sends through the TENANT's WhatsApp channel credentials
   * (services/waSender) — the path every other tenant notification uses —
   * and persists the outbound message to channel_messages.
   */
  reply: protectedProcedure
    .input(z.object({
      conversationId: z.string().min(1),
      body: z.string().min(1).max(4096),
    }))
    .mutation(async ({ input, ctx }) => {
      const { db, conv } = await loadConversation(input.conversationId);
      assertTenantAccess(ctx.user, conv.tenantId);
      if (conv.status === "resolved") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot reply on a resolved conversation" });
      }
      const [customer] = await db
        .select()
        .from(customers)
        .where(eq(customers.id, conv.customerId))
        .limit(1);
      const phone = (customer as any)?.whatsappPhone as string | undefined;
      if (!phone) throw new TRPCError({ code: "NOT_FOUND", message: "Conversation customer has no phone" });

      const { sendWhatsAppText } = await import("../services/waSender");
      const sent = await sendWhatsAppText(conv.tenantId, phone, input.body, {
        notifType: "conversation_reply",
        userId: ctx.user?.id ?? null,
      });
      await db.insert(channelMessages).values({
        channel: "whatsapp",
        direction: "outbound",
        fromAddress: conv.tenantId,
        toAddress: phone,
        tenantId: conv.tenantId,
        body: input.body,
        processed: true,
        metadata: { conversationId: conv.id, agentId: String(ctx.user.id) },
      });
      await db
        .update(conversations)
        .set({ messageCount: (conv.messageCount ?? 0) + 1, updatedAt: new Date() })
        .where(eq(conversations.id, conv.id));
      return { sent: sent.sent === true || (sent as any).simulated === true, simulated: (sent as any).simulated === true };
    }),

  /** Read one conversation (tenant-checked by lookup). */
  get: protectedProcedure
    .input(z.object({ conversationId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const { conv } = await loadConversation(input.conversationId);
      assertTenantAccess(ctx.user, conv.tenantId);
      return conv;
    }),
});
