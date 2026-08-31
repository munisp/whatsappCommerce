import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { router, protectedProcedure, internalProcedure, assertTenantAccess } from "../_core/trpc";
// === W34 otel-core === traceparent propagation to ml-stack.
import { injectTraceHeaders } from "../_core/telemetry";
import { getDb } from "../db";
import { channelMessages, ussdSessions as ussdSessionsTable } from "../../drizzle/schema";
import { randomUUID } from "crypto";

// ── USSD session store ───────────────────────────────────────────────────────
// Sessions are persisted to the ussd_sessions table (source of truth, survives
// restarts). The in-memory Map is only a read-through cache; every mutation is
// written through to the DB.
type UssdSessionState = { phone: string; step: number; cart: Record<string, number>; tenantId: string };
const ussdSessionCache = new Map<string, UssdSessionState>();

function menuForStep(step: number): string {
  if (step === 0) return "greeting";
  if (step === 1) return "category";
  if (step >= 99) return "end";
  return `step_${step}`;
}

function stepForMenu(menu: string | null): number {
  if (!menu || menu === "greeting") return 0;
  if (menu === "category") return 1;
  if (menu === "end") return 99;
  const m = /^step_(\d+)$/.exec(menu);
  return m ? parseInt(m[1], 10) : 0;
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function loadUssdSession(
  db: Db,
  sessionId: string,
  phoneNumber: string,
  serviceCode: string | undefined,
  tenantId: string,
): Promise<UssdSessionState> {
  const cached = ussdSessionCache.get(sessionId);
  if (cached) return cached;

  const [row] = await db.select().from(ussdSessionsTable)
    .where(eq(ussdSessionsTable.sessionId, sessionId))
    .limit(1);

  let state: UssdSessionState;
  if (row && row.isActive) {
    const hist = (row.menuHistory as { cart?: Record<string, number> } | null) ?? {};
    state = {
      phone: row.phoneNumber,
      step: stepForMenu(row.currentMenu),
      cart: hist.cart ?? {},
      tenantId: row.tenantId ?? tenantId,
    };
  } else {
    state = { phone: phoneNumber, step: 0, cart: {}, tenantId };
    await db.insert(ussdSessionsTable).values({
      sessionId,
      phoneNumber,
      serviceCode: serviceCode ?? null,
      tenantId,
      currentMenu: "greeting",
      menuHistory: { cart: {}, history: [] },
      isActive: true,
      lastInput: null,
      lastResponse: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }
  ussdSessionCache.set(sessionId, state);
  return state;
}

async function persistUssdSession(
  db: Db,
  sessionId: string,
  state: UssdSessionState,
  lastInput: string,
  lastResponse: string,
  isActive: boolean,
): Promise<void> {
  const [row] = await db.select({ menuHistory: ussdSessionsTable.menuHistory })
    .from(ussdSessionsTable)
    .where(eq(ussdSessionsTable.sessionId, sessionId))
    .limit(1);
  const prev = (row?.menuHistory as { cart?: Record<string, number>; history?: string[] } | null) ?? {};
  await db.update(ussdSessionsTable)
    .set({
      phoneNumber: state.phone,
      tenantId: state.tenantId,
      currentMenu: menuForStep(state.step),
      menuHistory: { cart: state.cart, history: [...(prev.history ?? []), menuForStep(state.step)] },
      lastInput,
      lastResponse,
      isActive,
      updatedAt: new Date(),
    })
    .where(eq(ussdSessionsTable.sessionId, sessionId));
  if (isActive) ussdSessionCache.set(sessionId, state);
  else ussdSessionCache.delete(sessionId);
}

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
  processUssd: internalProcedure
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

      // Get or create session (persisted in ussd_sessions, cached in memory)
      const session = await loadUssdSession(db, sessionId, phoneNumber, input.serviceCode, tenantId);

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
      const isActive = !response.startsWith("END");
      await persistUssdSession(db, sessionId, session, lastInput, response, isActive);

      return { response };
    }),

  // ── SMS Inbound Webhook ──────────────────────────────────────────────────
  processSms: internalProcedure
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
      // Route to ML inference server for NLP intent detection
      const mlStackUrl = process.env.ML_STACK_URL ?? "http://localhost:8099";
      let detectedIntent: string | undefined;
      let intentConfidence: number | undefined;
      try {
        const nlpRes = await fetch(`${mlStackUrl}/nlp/intent`, {
          method: "POST",
          // === W34 otel-core === traceparent propagation to ml-stack.
          headers: injectTraceHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ text: input.body, tenant_id: input.tenantId }),
          signal: AbortSignal.timeout(3000),
        });
        if (nlpRes.ok) {
          const nlpData = await nlpRes.json() as { intent?: string; confidence?: number };
          detectedIntent = nlpData.intent;
          intentConfidence = nlpData.confidence;
          if (detectedIntent) {
            await db.update(channelMessages)
              .set({ metadata: { externalId: input.externalId ?? id, intent: detectedIntent, confidence: intentConfidence }, processed: true })
              .where(eq(channelMessages.id, id));
          }
        }
      } catch { /* NLP routing is best-effort — never block SMS processing */ }
      return { id, status: "queued", intent: detectedIntent, confidence: intentConfidence };
    }),

  // ── Telegram Inbound Webhook ─────────────────────────────────────────────
  processTelegram: internalProcedure
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
  processInstagram: internalProcedure
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
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const conds = [eq(channelMessages.tenantId, input.tenantId)];
      if (input.channel) conds.push(eq(channelMessages.channel, input.channel));
      return db.select().from(channelMessages).where(and(...conds)).orderBy(desc(channelMessages.createdAt)).limit(input.limit);
    }),

  // ── Channel Stats ────────────────────────────────────────────────────────
  channelStats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const msgs = await db.select().from(channelMessages).where(eq(channelMessages.tenantId, input.tenantId));
      const byChannel: Record<string, number> = {};
      for (const m of msgs) {
        byChannel[m.channel] = (byChannel[m.channel] ?? 0) + 1;
      }
      return { total: msgs.length, byChannel };
    }),
});
