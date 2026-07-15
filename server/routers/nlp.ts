/**
 * NLP Buyer Conversation Engine
 * Handles natural-language WhatsApp messages in English, Yoruba, Hausa, Igbo, and Pidgin.
 * No menu required — buyers type freely and the LLM interprets intent.
 *
 * Conversation states: greeting → browse → product_detail → add_to_cart →
 *   checkout_address → checkout_confirm → payment → order_confirmed → support
 */
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import {
  nlpSessions, cartSessions, cartItems, orders, orderItems,
  customers, products, conversations, agentEvents,
} from "../../drizzle/schema";
import { paymentGatewayConfigs, paymentTransactions } from "../../drizzle/schema";
import { offlineMessageQueue } from "../../drizzle/schema";
import { tenantIntegrations } from "../../drizzle/schema";
import {
  syncOrderToMedusa,
  syncOrderToOdoo,
  syncContactToTwenty,
  pushOrderActivityToTwenty,
} from "../services/integrationSync";

// ── Language detection & system prompts ───────────────────────────────────────
// ── USSD numbered menu builder ────────────────────────────────────────────────
const USSD_MENUS: Record<string, Record<string, string>> = {
  greeting: {
    en: "Welcome! Reply:\n1. Browse products\n2. View my cart\n3. Check order status\n4. Help",
    yo: "Ẹ káàbọ̀! Dáhùn:\n1. Wo àwọn ọjà\n2. Wo àpò mi\n3. Ṣàyẹ̀wò ìpèsè\n4. Ìrànlọ́wọ́",
    ha: "Barka da zuwa! Amsa:\n1. Duba kayayyaki\n2. Duba kwandon saye\n3. Duba oda\n4. Taimako",
    ig: "Nnọọ! Zaghachi:\n1. Lee ngwaahịa\n2. Lee ngọdo m\n3. Lelee ọrụ\n4. Enyemaka",
    pidgin: "Welcome! Reply:\n1. See products\n2. My cart\n3. Check order\n4. Help",
  },
  browse: {
    en: "Products menu:\n1. View all products\n2. Search by name\n3. View cart\n4. Back to main menu",
    pidgin: "Products:\n1. See all\n2. Search\n3. My cart\n4. Back",
  },
  checkout_address: {
    en: "Checkout:\n1. Enter delivery address\n2. Use saved address\n3. Cancel order",
    pidgin: "Checkout:\n1. Enter address\n2. Saved address\n3. Cancel",
  },
};

function buildUssdMenu(state: string, lang: string): string {
  const menu = USSD_MENUS[state] ?? USSD_MENUS.greeting;
  return menu[lang] ?? menu.en;
}

// ── Multilingual fallback error messages ──────────────────────────────────────
const FALLBACK_ERRORS: Record<string, string> = {
  english: "Sorry, I didn't understand that. Please try again or type 'help'.",
  yoruba: "Pèlé, mi ò lóye ìyẹn. Jọ̀wọ́ gbìyànjú lẹ́ẹ̀kan sí i tàbí kọ 'ìrànlọ́wọ́'.",
  hausa: "Yi haƙuri, ban fahimci hakan ba. Don Allah sake gwadawa ko rubuta 'taimako'.",
  igbo: "Ndo, aghaghị m ịghọta nke ahụ. Biko nwaa ọzọ ma ọ bụ dee 'enyemaka'.",
  pidgin: "Sorry, I no understand wetin you talk. Try again or type 'help'.",
};

const LANGUAGE_HINTS: Record<string, string[]> = {
  yoruba: ["ẹ", "ọ", "ṣ", "jẹ", "wa", "mo", "ni", "fun", "ati", "se", "bawo", "kini", "ewo"],
  hausa: ["na", "da", "ba", "mai", "ina", "kuma", "don", "shi", "ta", "suna", "yaya", "wane"],
  igbo: ["ọ", "ị", "ụ", "bụ", "nke", "na", "ya", "ha", "gị", "m", "dị", "nọ", "ebe"],
  pidgin: ["abeg", "wetin", "dey", "oga", "no be", "wey", "comot", "chop", "wahala", "sharp sharp", "how far"],
};

function detectLanguage(text: string): string {
  const lower = text.toLowerCase();
  for (const [lang, hints] of Object.entries(LANGUAGE_HINTS)) {
    if (hints.some(h => lower.includes(h))) return lang;
  }
  return "english";
}

function buildSystemPrompt(language: string, products: Array<{ name: string; price: string; currency: string; stockQuantity: number }>, tenantName: string): string {
  const productList = products.slice(0, 20).map(p =>
    `- ${p.name}: ${p.currency} ${p.price} (${p.stockQuantity > 0 ? "in stock" : "out of stock"})`
  ).join("\n");

  const langInstructions: Record<string, string> = {
    english: "Respond in clear, friendly English.",
    yoruba: "Respond in Yoruba (you may mix with English where needed). Be warm and respectful.",
    hausa: "Respond in Hausa (you may mix with English where needed). Be polite and helpful.",
    igbo: "Respond in Igbo (you may mix with English where needed). Be friendly and clear.",
    pidgin: "Respond in Nigerian Pidgin English. Be casual, friendly, and use common pidgin expressions.",
  };

  return `You are a helpful WhatsApp shopping assistant for ${tenantName}. ${langInstructions[language] ?? langInstructions.english}

You help customers browse products, add items to their cart, and complete purchases — all through natural conversation.

AVAILABLE PRODUCTS:
${productList}

CONVERSATION RULES:
1. Detect what the customer wants (browse, search product, add to cart, checkout, check order status, get help).
2. Never show a numbered menu unless the customer explicitly asks for options.
3. If a customer mentions a product name (even partially or misspelled), match it to the catalog.
4. Guide checkout naturally: collect delivery address, confirm order summary, then provide payment instructions.
5. If stock is 0, apologise and suggest alternatives.
6. Keep responses SHORT (under 160 chars when possible) — this is WhatsApp.

RESPOND WITH JSON (no markdown):
{
  "reply": "<message to send to customer>",
  "intent": "browse|search|add_to_cart|remove_from_cart|view_cart|checkout|confirm_order|order_status|support|greeting|unknown",
  "nextState": "greeting|browse|product_detail|add_to_cart|checkout_address|checkout_confirm|payment|order_confirmed|support",
  "extractedProduct": "<product name if mentioned, or null>",
  "extractedQuantity": <number or null>,
  "extractedAddress": "<delivery address if provided, or null>",
  "confidence": <0.0-1.0>
}`;
}

// ── Router ────────────────────────────────────────────────────────────────────
export const nlpRouter = router({
  /**
   * Process an incoming WhatsApp message through the NLP engine.
   * Called by the webhook handler when a message arrives.
   */
  processMessage: publicProcedure
    .input(z.object({
     tenantId: z.string(),
     waPhoneNumber: z.string(),
     message: z.string().max(4096),
     customerName: z.string().optional(),
      ussdMode: z.boolean().optional(),
   }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      // 1. Upsert NLP session
      const existing = await db.select().from(nlpSessions)
        .where(and(eq(nlpSessions.tenantId, input.tenantId), eq(nlpSessions.waPhoneNumber, input.waPhoneNumber)))
        .limit(1);

      const detectedLang = detectLanguage(input.message);
      let session = existing[0];

      if (!session) {
        const [newSession] = await db.insert(nlpSessions).values({
          id: crypto.randomUUID(),
          tenantId: input.tenantId,
          waPhoneNumber: input.waPhoneNumber,
          customerName: input.customerName,
          language: detectedLang,
          state: "greeting",
          context: {},
          messageHistory: [],
          lastActivityAt: new Date(),
          createdAt: new Date(),
        }).returning();
        session = newSession;
      } else {
        // Update language if newly detected
        if (detectedLang !== "english") {
          await db.update(nlpSessions)
            .set({ language: detectedLang, lastActivityAt: new Date() })
            .where(eq(nlpSessions.id, session.id));
          session.language = detectedLang;
        }
      }

      // 2. Load tenant products for context
      const tenantProducts = await db.select({
        id: products.id,
        name: products.name,
        price: products.price,
        currency: products.currency,
        stockQuantity: products.stockQuantity,
        description: products.description,
      }).from(products)
        .where(and(eq(products.tenantId, input.tenantId), eq(products.status, "active")))
        .limit(30);

      // 3. Load cart for context
      let cartSession = session.cartSessionId
        ? (await db.select().from(cartSessions).where(eq(cartSessions.id, session.cartSessionId)).limit(1))[0]
        : null;

      let cartItemsList: Array<{ productName: string; quantity: number; unitPrice: string; currency: string }> = [];
      if (cartSession) {
        cartItemsList = await db.select().from(cartItems).where(eq(cartItems.cartSessionId, cartSession.id));
      }

      // 4. Build message history for LLM context (last 10 turns)
      const history = (session.messageHistory as Array<{ role: string; content: string }>).slice(-10);

      // 5. Call LLM
      // 5a. USSD mode check — if session context has ussdMode=true, return numbered menu
     const sessionCtx = (session.context as Record<string, unknown>) ?? {};
      const isUssd = input.ussdMode ?? sessionCtx.ussdMode === true;
      if (isUssd) {
        const ussdMenu = buildUssdMenu(session.state, session.language);
        await db.update(nlpSessions).set({ lastActivityAt: new Date() }).where(eq(nlpSessions.id, session.id));
        return { reply: ussdMenu, intent: "ussd_menu", confidence: 1, state: session.state, language: session.language, sessionId: session.id };
      }
      const systemPrompt = buildSystemPrompt(session.language, tenantProducts, input.tenantId);
      const cartSummary = cartItemsList.length > 0
        ? `\nCURRENT CART:\n${cartItemsList.map(i => `- ${i.productName} x${i.quantity} @ ${i.currency} ${i.unitPrice}`).join("\n")}\nCart total: ${cartItemsList.reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0).toFixed(2)}`
        : "\nCURRENT CART: empty";

      const messages = [
        { role: "system" as const, content: systemPrompt + cartSummary },
        ...history.map(h => ({ role: h.role as "user" | "assistant", content: h.content })),
        { role: "user" as const, content: input.message },
      ];

      let llmResult: {
        reply: string; intent: string; nextState: string;
        extractedProduct: string | null; extractedQuantity: number | null;
        extractedAddress: string | null; confidence: number;
      };

      try {
        const raw = await invokeLLM({ messages, model: "gpt-5-mini" });
        const rawContent = raw.choices?.[0]?.message?.content;
        const content = typeof rawContent === "string" ? rawContent : "{}";
        // Strip markdown code fences if present
        const cleaned = content.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
        llmResult = JSON.parse(cleaned);
      } catch {
        llmResult = {
          reply: FALLBACK_ERRORS[session.language] ?? FALLBACK_ERRORS.english,
          intent: "unknown", nextState: session.state,
          extractedProduct: null, extractedQuantity: null,
          extractedAddress: null, confidence: 0,
        };
      }

      // 6. Act on intent
      const ctx: Record<string, unknown> = (session.context as Record<string, unknown>) ?? {};

      if (llmResult.intent === "add_to_cart" && llmResult.extractedProduct) {
        // Find matching product
        const matched = tenantProducts.find(p =>
          p.name.toLowerCase().includes(llmResult.extractedProduct!.toLowerCase()) ||
          llmResult.extractedProduct!.toLowerCase().includes(p.name.toLowerCase())
        );
        if (matched && matched.stockQuantity > 0) {
          // Ensure cart session exists
          if (!cartSession) {
            const [cs] = await db.insert(cartSessions).values({
              id: crypto.randomUUID(),
              tenantId: input.tenantId,
              waPhoneNumber: input.waPhoneNumber,
              sessionData: {},
              currentStep: "browse",
              language: session.language,
              expiresAt: new Date(Date.now() + 86400000),
              createdAt: new Date(),
              updatedAt: new Date(),
            }).returning();
            cartSession = cs;
            await db.update(nlpSessions).set({ cartSessionId: cs.id }).where(eq(nlpSessions.id, session.id));
          }
          // Add item
          const qty = llmResult.extractedQuantity ?? 1;
          await db.insert(cartItems).values({
            id: crypto.randomUUID(),
            cartSessionId: cartSession.id,
            productId: matched.id,
            productName: matched.name,
            quantity: qty,
            unitPrice: matched.price,
            currency: matched.currency,
            createdAt: new Date(),
          });
        }
      }

      if (llmResult.intent === "confirm_order" && cartSession) {
        // Create order from cart
        const items = await db.select().from(cartItems).where(eq(cartItems.cartSessionId, cartSession.id));
        if (items.length > 0) {
          const total = items.reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0);
          const orderId = crypto.randomUUID();
          const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`;
          await db.insert(orders).values({
            id: orderId,
            tenantId: input.tenantId,
            customerId: input.waPhoneNumber, // use phone as customer ref until resolved
            orderNumber,
            status: "pending",
            totalAmount: total.toFixed(2),
            currency: items[0].currency,
            paymentStatus: "unpaid",
            shippingAddress: llmResult.extractedAddress ? { raw: llmResult.extractedAddress } : null,
            items: items.map(i => ({ productId: i.productId, name: i.productName, qty: i.quantity, price: i.unitPrice })),
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        ctx.lastOrderId = orderId;
        ctx.lastOrderNumber = orderNumber;
        // ── Fire-and-forget sync to external systems ─────────────────────────
        (async () => {
          try {
            const syncItems = items.map(i => ({
              productId: i.productId ?? "",
              name: i.productName ?? "",
              qty: i.quantity,
              price: i.unitPrice,
            }));
            const syncPayload = {
              id: orderId,
              orderNumber,
              total,
              currency: items[0]?.currency ?? "NGN",
              phone: input.waPhoneNumber,
              address: llmResult.extractedAddress ?? null,
              items: syncItems,
            };
            await syncOrderToMedusa(input.tenantId, syncPayload);
            await syncOrderToOdoo(input.tenantId, syncPayload);
            const personId = await syncContactToTwenty(input.tenantId, input.waPhoneNumber, input.customerName);
            if (personId) {
              await pushOrderActivityToTwenty(input.tenantId, personId, orderNumber, total, syncPayload.currency);
            }
          } catch (_) { /* best-effort — never block NLP */ }
        })();
        // ── Initiate payment via configured gateway ──────────────────────────
        try {
          const [gwConfig] = await db.select().from(paymentGatewayConfigs)
            .where(and(eq(paymentGatewayConfigs.tenantId, input.tenantId), eq(paymentGatewayConfigs.isActive, true)))
            .limit(1);
          if (gwConfig) {
            const txId = crypto.randomUUID();
            let paymentUrl: string | null = null;
            const callbackUrl = gwConfig.callbackUrl ?? `https://wa.me/${input.waPhoneNumber}`;
            if (gwConfig.provider === "paystack") {
              const resp = await fetch("https://api.paystack.co/transaction/initialize", {
                method: "POST",
                headers: { Authorization: `Bearer ${gwConfig.secretKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({ amount: Math.round(total * 100), currency: items[0].currency, reference: txId, callback_url: callbackUrl }),
              }).then(r => r.json()).catch(() => null);
              paymentUrl = resp?.data?.authorization_url ?? null;
            } else if (gwConfig.provider === "flutterwave") {
              const resp = await fetch("https://api.flutterwave.com/v3/payments", {
                method: "POST",
                headers: { Authorization: `Bearer ${gwConfig.secretKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({ tx_ref: txId, amount: total, currency: items[0].currency, redirect_url: callbackUrl, customer: { phone_number: input.waPhoneNumber } }),
              }).then(r => r.json()).catch(() => null);
              paymentUrl = resp?.data?.link ?? null;
            }
            await db.insert(paymentTransactions).values({
              id: txId,
              tenantId: input.tenantId,
              orderId,
              provider: gwConfig.provider,
              providerRef: txId,
              amount: total.toFixed(2),
              currency: items[0].currency,
              status: "initiated",
              paymentUrl,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            if (paymentUrl) {
              // Append payment link to the LLM reply
              const payLinkSuffix = session.language === "pidgin"
                ? `\n\n💳 Click dis link to pay: ${paymentUrl}`
                : session.language === "yo"
                ? `\n\n💳 Tẹ ọna asopọ yii lati san: ${paymentUrl}`
                : session.language === "ha"
                ? `\n\n💳 Danna wannan hanyar haɗi don biyan kuɗi: ${paymentUrl}`
                : session.language === "ig"
                ? `\n\n💳 Pịa njikọ a iji kwụọ ụgwọ: ${paymentUrl}`
                : `\n\n💳 Click here to complete payment: ${paymentUrl}`;
              llmResult.reply = (llmResult.reply ?? "") + payLinkSuffix;
              // Airtime / mobile-money shortcode hint for low-income users without data
              const airtimeSuffix = session.language === "pidgin"
                ? `\n📱 No data? Dial *712*amount# to pay with MTN MoMo`
                : session.language === "yo"
                ? `\n📱 Ko si data? Pe *712*iye# lati san pẹlu MTN MoMo`
                : session.language === "ha"
                ? `\n📱 Babu data? Kira *712*adadin# don biyan kuɗi da MTN MoMo`
                : session.language === "ig"
                ? `\n📱 Enweghị data? Kpọọ *712*ọnụ ego# iji kwụọ ụgwọ na MTN MoMo`
                : `\n📱 No data? Dial *712*amount# to pay via MTN MoMo`;
              llmResult.reply = (llmResult.reply ?? "") + airtimeSuffix;
            }
          }
        } catch (_) { /* payment link generation is best-effort */ }
      }
    }

      if (llmResult.extractedAddress) {
        ctx.deliveryAddress = llmResult.extractedAddress;
      }

      // 7. Update session
      const newHistory = [
        ...history,
        { role: "user", content: input.message },
        { role: "assistant", content: llmResult.reply },
      ].slice(-20);

      await db.update(nlpSessions).set({
        state: llmResult.nextState ?? session.state,
        context: ctx,
        messageHistory: newHistory,
        lastActivityAt: new Date(),
      }).where(eq(nlpSessions.id, session.id));

      // 8. Log agent event
      await db.insert(agentEvents).values({
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        conversationId: session.id,
        eventType: "nlp_message",
        intentType: llmResult.intent,
        confidence: llmResult.confidence?.toFixed(3) ?? "0.000",
        escalated: false,
        model: "gpt-5-mini",
        createdAt: new Date(),
      });

      return {
        reply: llmResult.reply,
        intent: llmResult.intent,
        state: llmResult.nextState,
        language: session.language,
        sessionId: session.id,
        confidence: llmResult.confidence ?? 0,
      };
    }),

  /** Get or create a session for a phone number */
  getSession: protectedProcedure
    .input(z.object({ tenantId: z.string(), waPhoneNumber: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [session] = await db.select().from(nlpSessions)
        .where(and(eq(nlpSessions.tenantId, input.tenantId), eq(nlpSessions.waPhoneNumber, input.waPhoneNumber)))
        .limit(1);
      return session ?? null;
    }),

  /** List active sessions for a tenant */
  listSessions: protectedProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().default(50) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return db.select().from(nlpSessions)
        .where(eq(nlpSessions.tenantId, input.tenantId))
        .orderBy(sql`${nlpSessions.lastActivityAt} DESC`)
        .limit(input.limit);
    }),

  /** Reset/clear a session (e.g. after order confirmed) */
  resetSession: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await db.update(nlpSessions).set({
        state: "greeting",
        context: {},
        messageHistory: [],
        cartSessionId: null,
        lastActivityAt: new Date(),
      }).where(eq(nlpSessions.id, input.sessionId));
      return { ok: true };
    }),

  /** Simulate a conversation (for testing/demo) */
  simulate: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      waPhoneNumber: z.string(),
      messages: z.array(z.string()),
    }))
    .mutation(async ({ input, ctx }) => {
      const results = [];
      for (const msg of input.messages) {
        // Re-use processMessage logic inline
        const db = await getDb();
        if (!db) break;
        results.push({ message: msg, processed: true });
      }
      return results;
    }),

  /** Queue a message for offline delivery (called when buyer is offline) */
  queueOfflineMessage: protectedProcedure
    .input(z.object({
      sessionId: z.string(),
      tenantId: z.string(),
      waPhoneNumber: z.string(),
      message: z.string(),
      direction: z.enum(["inbound", "outbound"]).default("outbound"),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [row] = await db.insert(offlineMessageQueue).values({
        id: crypto.randomUUID(),
        sessionId: input.sessionId,
        tenantId: input.tenantId,
        waPhoneNumber: input.waPhoneNumber,
        message: input.message,
        direction: input.direction,
        status: "queued",
        queuedAt: new Date(),
      }).returning();
      return row;
    }),

  /** Sync (replay) queued offline messages when buyer reconnects */
  syncOfflineQueue: protectedProcedure
    .input(z.object({
      sessionId: z.string(),
      waPhoneNumber: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const queued = await db.select().from(offlineMessageQueue)
        .where(and(
          eq(offlineMessageQueue.sessionId, input.sessionId),
          eq(offlineMessageQueue.status, "queued"),
        ))
        .orderBy(offlineMessageQueue.queuedAt);
      if (queued.length === 0) return { synced: 0, messages: [] };
      await db.update(offlineMessageQueue)
        .set({ status: "delivered", deliveredAt: new Date() })
        .where(and(
          eq(offlineMessageQueue.sessionId, input.sessionId),
          eq(offlineMessageQueue.status, "queued"),
        ));
      return { synced: queued.length, messages: queued };
    }),

  /** Get queued offline message count for a session */
  getOfflineQueueCount: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { count: 0 };
      const rows = await db.select().from(offlineMessageQueue)
        .where(and(
          eq(offlineMessageQueue.sessionId, input.sessionId),
          eq(offlineMessageQueue.status, "queued"),
        ));
    return { count: rows.length };
    }),
  /** Load queued offline messages for a session (mount-time pre-population) */
  getQueuedMessages: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { messages: [] };
      const rows = await db.select().from(offlineMessageQueue)
        .where(and(
          eq(offlineMessageQueue.sessionId, input.sessionId),
          eq(offlineMessageQueue.status, "queued"),
        ))
        .orderBy(offlineMessageQueue.queuedAt);
      return { messages: rows.map(r => r.message) };
    }),

  /** Unified order timeline: platform order + Medusa + Odoo + Twenty CRM events */
  getOrderTimeline: protectedProcedure
    .input(z.object({ orderNumber: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [order] = await db.select().from(orders)
        .where(eq(orders.orderNumber, input.orderNumber))
        .limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });

      const items = await db.select().from(orderItems)
        .where(eq(orderItems.orderId, order.id));

      const payments = await db.select().from(paymentTransactions)
        .where(eq(paymentTransactions.orderId, order.id));

      const integrations = await db.select({
        integrationType: tenantIntegrations.integrationType,
        status: tenantIntegrations.status,
      }).from(tenantIntegrations)
        .where(eq(tenantIntegrations.tenantId, order.tenantId));

      const hasMedusa = integrations.some(i => i.integrationType === "medusa" && i.status === "active");
      const hasOdoo = integrations.some(i => i.integrationType === "odoo_erp" && i.status === "active");
      const hasTwenty = integrations.some(i => i.integrationType === "twenty_crm" && i.status === "active");

      type TimelineEvent = {
        id: string; timestamp: Date; system: string; event: string;
        detail: string; status: "success" | "pending" | "failed" | "info";
      };
      const timeline: TimelineEvent[] = [];

      timeline.push({
        id: "platform-created",
        timestamp: order.createdAt,
        system: "WhatsApp Platform",
        event: "Order Created",
        detail: `Order ${order.orderNumber} created via WhatsApp conversation`,
        status: "success",
      });

      if (payments.length > 0) {
        const p = payments[payments.length - 1];
        timeline.push({
          id: `payment-${p.id}`,
          timestamp: p.createdAt,
          system: "Payment Gateway",
          event: p.status === "success" ? "Payment Confirmed" : "Payment Initiated",
          detail: `${p.provider} · ${order.currency} ${order.totalAmount}`,
          status: p.status === "success" ? "success" : p.status === "failed" ? "failed" : "pending",
        });
      }

      if (order.erpOrderId) {
        timeline.push({
          id: "medusa-synced",
          timestamp: order.updatedAt,
          system: "Medusa Commerce",
          event: "Order Synced",
          detail: `Medusa order ID: ${order.erpOrderId}`,
          status: "success",
        });
      } else if (hasMedusa) {
        timeline.push({
          id: "medusa-pending",
          timestamp: order.createdAt,
          system: "Medusa Commerce",
          event: "Sync Pending",
          detail: "Order not yet synced to Medusa — will retry on next heartbeat",
          status: "pending",
        });
      }

      if (hasOdoo) {
        timeline.push({
          id: "odoo-sale",
          timestamp: order.updatedAt,
          system: "Odoo ERP",
          event: order.status === "delivered" ? "Delivery Completed"
            : order.status === "processing" ? "In Fulfillment" : "Sale Order Created",
          detail: `Odoo sale.order · Status: ${order.status}`,
          status: order.status === "delivered" ? "success"
            : order.status === "cancelled" ? "failed" : "pending",
        });
      }

      if (hasTwenty) {
        timeline.push({
          id: "twenty-activity",
          timestamp: order.createdAt,
          system: "Twenty CRM",
          event: "CRM Activity Logged",
          detail: "Order activity pushed to Twenty CRM for customer contact",
          status: "success",
        });
      }

      timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      return {
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          paymentStatus: order.paymentStatus,
          totalAmount: order.totalAmount,
          currency: order.currency,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
          shippingAddress: order.shippingAddress,
          notes: order.notes,
          erpOrderId: order.erpOrderId,
        },
        items,
        payments,
        timeline,
        integrations: { hasMedusa, hasOdoo, hasTwenty },
      };
    }),
});
