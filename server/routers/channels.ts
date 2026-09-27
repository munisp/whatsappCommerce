import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { router, protectedProcedure, internalProcedure, assertTenantAccess } from "../_core/trpc";
// === W34 otel-core === traceparent propagation to ml-stack.
import { injectTraceHeaders } from "../_core/telemetry";
import { getDb } from "../db";
import { channelMessages } from "../../drizzle/schema";
import { randomUUID } from "crypto";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

// === W50 SMS === inbound SMS reply-loop helpers (consent + NLP + reply).
const CONSENT_CHANNEL_SMS = "sms";

/** Locale-aware SMS consent copy (channel-generic packs say "WhatsApp" — swap). */
async function smsConsentText(
  tenantId: string,
  sessionKey: string,
  text: string,
  key: "prompt" | "granted" | "denied",
): Promise<string> {
  try {
    const { resolveLocale, tr } = await import("../services/i18n");
    const locale = await resolveLocale({ tenantId, phone: sessionKey, text });
    const wa = { prompt: "consentPrompt", granted: "consentGranted", denied: "consentDenied" } as const;
    return tr(locale, wa[key]).replace(/WhatsApp/g, "SMS");
  } catch {
    const { consentPromptFor, consentGrantedFor, consentDeniedFor } = await import("../services/consent");
    return key === "prompt" ? consentPromptFor(null) : key === "granted" ? consentGrantedFor(null) : consentDeniedFor(null);
  }
}

/**
 * SMS consent gate mirroring telegramInbound.consentGate: no consent row →
 * YES/NO is recorded, anything else gets the opt-in prompt; an existing row
 * lets the conversation proceed. Returns true when the message was fully
 * handled by the consent flow. Never throws (fail-open → conversation).
 */
async function smsConsentGate(db: Db, tenantId: string, phone: string, text: string): Promise<boolean> {
  try {
    const consent = await import("../services/consent");
    const { sessionKeyFor } = await import("../services/channelIdentity");
    const { sendSmsSafe } = await import("../services/smsSender");
    const sessionKey = sessionKeyFor(CONSENT_CHANNEL_SMS, phone);
    const existing = await consent.getChannelConsent(db, tenantId, sessionKey, CONSENT_CHANNEL_SMS);
    if (existing) return false; // decided already — conversation proceeds
    const decision = consent.parseConsentReply(text);
    if (decision === true) {
      await consent.recordChannelOptIn(db, { tenantId, sessionKey, channel: CONSENT_CHANNEL_SMS, source: "sms_inbound" });
      await sendSmsSafe(tenantId, phone, await smsConsentText(tenantId, sessionKey, text, "granted"));
      return true;
    }
    if (decision === false) {
      await consent.recordChannelDenial(db, { tenantId, sessionKey, channel: CONSENT_CHANNEL_SMS });
      await sendSmsSafe(tenantId, phone, await smsConsentText(tenantId, sessionKey, text, "denied"));
      return true;
    }
    await sendSmsSafe(tenantId, phone, await smsConsentText(tenantId, sessionKey, text, "prompt"));
    return true;
  } catch (e: any) {
    console.warn("[channels.sms] consent gate error — processing anyway:", e?.message);
    return false;
  }
}

/**
 * Feed an inbound SMS through the SAME nlp.processMessage entry the Telegram
 * inbound path uses and deliver the reply over SMS (segmented to 160 GSM-7 /
 * 70 UCS-2, max 3 parts; rich-channel chrome stripped). Fail-open: a reply
 * error never fails the webhook.
 */
async function dispatchSmsToNlp(db: Db, tenantId: string, phone: string, message: string): Promise<{ replied: boolean; intent?: string }> {
  try {
    const { sessionKeyFor } = await import("../services/channelIdentity");
    const { appRouter } = await import("../routers");
    const caller = appRouter.createCaller({ user: null } as any);
    const result: any = await caller.nlp.processMessage({
      tenantId,
      waPhoneNumber: sessionKeyFor(CONSENT_CHANNEL_SMS, phone),
      message,
      channel: CONSENT_CHANNEL_SMS,
    });
    const reply: string = typeof result?.reply === "string" ? result.reply : "";
    if (!reply) return { replied: false, intent: result?.intent };
    const { sendSmsSafe, stripSmsChrome } = await import("../services/smsSender");
    const plain = stripSmsChrome(reply);
    if (!plain) return { replied: false, intent: result?.intent };
    const sent = await sendSmsSafe(tenantId, phone, plain);
    return { replied: sent.sent || sent.simulated, intent: result?.intent };
  } catch (e: any) {
    console.warn("[channels.sms] nlp dispatch failed (fail-open):", e?.message);
    return { replied: false };
  }
}
// === END W50 SMS ===

export const channelsRouter = router({
  // === W50 SMS === the dead USSD toy (hardcoded Electronics/Fashion menu,
  // never wired to any endpoint) was removed; the REAL USSD gateway is the
  // /ussd HTTP endpoint in _core/index.ts → useCases.handleUssdRequest.

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
      const tenantId = input.tenantId ?? "default";
      const id = randomUUID();
      await db.insert(channelMessages).values({
        channel: "sms",
        direction: "inbound",
        fromAddress: input.from,
        toAddress: input.to,
        body: input.body,
        tenantId,
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

      // === W50 SMS === full reply loop: consent gate → nlp.processMessage →
      // segmented SMS reply (fail-open; the webhook always acks).
      let replied = false;
      let replyIntent: string | undefined;
      try {
        const handledByConsent = await smsConsentGate(db, tenantId, input.from, input.body);
        if (handledByConsent) {
          replied = true;
          replyIntent = "consent";
        } else {
          const r = await dispatchSmsToNlp(db, tenantId, input.from, input.body);
          replied = r.replied;
          replyIntent = r.intent;
        }
      } catch (e: any) {
        console.warn("[channels.sms] reply loop error (fail-open):", e?.message);
      }
      return { id, status: replied ? "replied" : "queued", intent: detectedIntent ?? replyIntent, confidence: intentConfidence, replied };
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
