import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { router, protectedProcedure, publicProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { channelMessages } from "../../drizzle/schema";
import { randomUUID } from "crypto";

// ── USSD session store (in-memory, keyed by sessionId) ───────────────────────
const ussdSessions = new Map<string, { phone: string; step: number; cart: Record<string, number>; tenantId: string }>();

function buildUssdMenu(step: number, cart: Record<string, number>): string {
  if (step === 0) {
    return "CON Welcome to WhatsApp Commerce\n1. Browse Products\n2. My Orders\n3. Track Shipment\n4. Contact Support";
  }
  if (step === 1) {
    return "CON Select Category:\n1. Electronics\n2. Fashion\n3. Food & Groceries\n4. Services\n0. Back";
  }
  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0);
  return `END Session ended. Cart: ${cartCount} item(s). Visit WhatsApp to complete order.`;
}

export const channelsRouter = router({
  // ── USSD Gateway Webhook ─────────────────────────────────────────────────
  // Handles Africa's Talking / Infobip USSD format
  processUssd: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      serviceCode: z.string().optional(),
      phoneNumber: z.string(),
      text: z.string().default(""),
      tenantId: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const { sessionId, phoneNumber, text, tenantId = "default" } = input;

      // Get or create session
      let session = ussdSessions.get(sessionId);
      if (!session) {
        session = { phone: phoneNumber, step: 0, cart: {}, tenantId };
        ussdSessions.set(sessionId, session);
      }

      // Parse user input
      const parts = text.split("*").filter(Boolean);
      const lastInput = parts[parts.length - 1] ?? "";

      // Log to channel_messages
      await db.insert(channelMessages).values({
        channel: "ussd",
        direction: "inbound",
        fromAddress: phoneNumber,
        toAddress: input.serviceCode ?? "*384#",
        body: text,
        tenantId,
        processed: false,
        metadata: { step: session.step, parts },
        createdAt: new Date(),
      });

      // Advance step
      if (lastInput === "1" && session.step === 0) session.step = 1;
      else if (lastInput === "0") session.step = Math.max(0, session.step - 1);
      else if (lastInput !== "") session.step = 99; // terminal step

      const response = buildUssdMenu(session.step, session.cart);
      if (response.startsWith("END")) ussdSessions.delete(sessionId);

      return { response };
    }),

  // ── SMS Inbound Webhook ──────────────────────────────────────────────────
  processSms: publicProcedure
    .input(z.object({
      from: z.string(),
      to: z.string(),
      body: z.string(),
      externalId: z.string().optional(),
      tenantId: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const id = randomUUID();
      await db.insert(channelMessages).values({
        channel: "sms",
        direction: "inbound",
        fromAddress: input.from,
        toAddress: input.to,
        body: input.body,
        tenantId: input.tenantId ?? "default",
        processed: false,
        metadata: { externalId: input.externalId ?? id },
        createdAt: new Date(),
      });
      // TODO: route to NLP processMessage for intent detection
      return { id, status: "queued" };
    }),

  // ── Telegram Inbound Webhook ─────────────────────────────────────────────
  processTelegram: publicProcedure
    .input(z.object({
      updateId: z.number(),
      chatId: z.number(),
      from: z.string(),
      text: z.string().optional(),
      tenantId: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const id = randomUUID();
      await db.insert(channelMessages).values({
        channel: "telegram",
        direction: "inbound",
        fromAddress: input.from,
        toAddress: String(input.chatId),
        body: input.text ?? "",
        tenantId: input.tenantId ?? "default",
        processed: false,
        metadata: { chatId: input.chatId, updateId: input.updateId },
        createdAt: new Date(),
      });
      return { id, status: "queued" };
    }),

  // ── Instagram DM Inbound ─────────────────────────────────────────────────
  processInstagram: publicProcedure
    .input(z.object({
      senderId: z.string(),
      recipientId: z.string(),
      text: z.string().optional(),
      attachments: z.array(z.object({ type: z.string(), url: z.string() })).optional(),
      tenantId: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const id = randomUUID();
      await db.insert(channelMessages).values({
        channel: "instagram",
        direction: "inbound",
        fromAddress: input.senderId,
        toAddress: input.recipientId,
        body: input.text ?? "",
        tenantId: input.tenantId ?? "default",
        processed: false,
        metadata: { attachments: input.attachments ?? [], externalId: id },
        createdAt: new Date(),
      });
      return { id, status: "queued" };
    }),

  // ── Channel Message History ──────────────────────────────────────────────
  listMessages: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      channel: z.enum(["whatsapp", "sms", "ussd", "telegram", "instagram", "email"]).optional(),
      limit: z.number().default(50),
    }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds = [eq(channelMessages.tenantId, input.tenantId)];
      if (input.channel) conds.push(eq(channelMessages.channel, input.channel));
      return db.select().from(channelMessages).where(and(...conds)).orderBy(desc(channelMessages.createdAt)).limit(input.limit);
    }),

  // ── Channel Stats ────────────────────────────────────────────────────────
  channelStats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const msgs = await db.select().from(channelMessages).where(eq(channelMessages.tenantId, input.tenantId));
      const byChannel: Record<string, number> = {};
      for (const m of msgs) {
        byChannel[m.channel] = (byChannel[m.channel] ?? 0) + 1;
      }
      return { total: msgs.length, byChannel };
    }),
});
