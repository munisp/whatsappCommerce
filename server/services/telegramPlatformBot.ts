/**
 * telegramPlatformBot.ts — the platform's own Telegram bot, where a business opens its shop by chat.
 *
 * It runs the same onboarding assistant as WhatsApp (waOnboarding + onboardingCopilot): the same questions, proposal
 * cards (as inline buttons), go-live and location step. Shop bots stay per tenant (telegramInbound.ts); this one bot
 * belongs to the platform.
 *
 * A shop is owned by a verified phone (bootstrapTenantOwner: the portal login is a link plus a code to that phone).
 * So before anything else the bot asks the person to share their OWN contact. Telegram attaches the sharer's user id
 * to a contact, and only a contact whose user id is the sender's own is accepted — that is Telegram's verified number
 * for the account. The chat → phone link is kept in telegram_platform_chats; the setup itself is keyed by the phone,
 * so it can be finished on WhatsApp too (SELL on the shared number).
 *
 * Webhook: POST /api/webhooks/telegram-platform, header X-Telegram-Bot-Api-Secret-Token must equal
 * TELEGRAM_PLATFORM_WEBHOOK_SECRET. Off unless TELEGRAM_PLATFORM_BOT_TOKEN and TELEGRAM_PLATFORM_WEBHOOK_SECRET
 * are both set.
 */
import { eq } from "drizzle-orm";
import { telegramPlatformChats } from "../../drizzle/schema";
import { normalizeUpdate, validateTelegramSecret } from "./telegramInbound";
import { waMarkdownToTelegramHtml } from "./telegramSender";
import { t as copilotT, type CopilotLanguage } from "./onboardingCopilot/language";

type Db = any;

export interface PlatformBotConfig {
  token: string;
  secret: string;
}

export function platformBotConfig(): PlatformBotConfig | null {
  const token = (process.env.TELEGRAM_PLATFORM_BOT_TOKEN ?? "").trim();
  const secret = (process.env.TELEGRAM_PLATFORM_WEBHOOK_SECRET ?? "").trim();
  return token && secret ? { token, secret } : null;
}

export function platformBotSecretValid(presented: string): boolean {
  const cfg = platformBotConfig();
  return !!cfg && validateTelegramSecret(presented, cfg.secret);
}

// ── Bot API ──────────────────────────────────────────────────────────────────

async function botApi(cfg: PlatformBotConfig, method: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) console.error(`[tg-platform] ${method} failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return res.ok;
  } catch (e: any) {
    console.error(`[tg-platform] ${method} error:`, e?.message);
    return false;
  }
}

const sendHtml = (cfg: PlatformBotConfig, chatId: string, text: string, replyMarkup?: Record<string, unknown>) =>
  botApi(cfg, "sendMessage", {
    chat_id: chatId, text: waMarkdownToTelegramHtml(text).slice(0, 4000), parse_mode: "HTML",
    disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });

/**
 * One onboarding reply (WhatsApp Cloud API shape) as a Telegram message: text as is; reply buttons and list rows as
 * inline buttons (their ids are the callback data, ≤ 64 bytes); WhatsApp's Send location as Telegram's.
 */
export function telegramMessageFor(payload: Record<string, any>): { text: string; replyMarkup?: Record<string, unknown> } | null {
  if (payload.type === "text") return { text: String(payload.text?.body ?? "") };
  if (payload.type !== "interactive") return null;
  const it = payload.interactive ?? {};
  const text = String(it.body?.text ?? "");
  if (it.type === "location_request_message") {
    return { text, replyMarkup: { keyboard: [[{ text: "📍 Send location", request_location: true }]], resize_keyboard: true, one_time_keyboard: true } };
  }
  const buttons: Array<{ id: string; title: string }> = it.type === "list"
    ? (it.action?.sections ?? []).flatMap((s: any) => (s.rows ?? []).map((r: any) => ({ id: String(r.id), title: String(r.title) })))
    : (it.action?.buttons ?? []).map((b: any) => ({ id: String(b.reply?.id ?? ""), title: String(b.reply?.title ?? "") }));
  const usable = buttons.filter((b) => b.id && Buffer.byteLength(b.id, "utf8") <= 64);
  if (!usable.length) return { text };
  return { text, replyMarkup: { inline_keyboard: usable.map((b) => [{ text: (b.title || b.id).slice(0, 64), callback_data: b.id }]) } };
}

function transportFor(cfg: PlatformBotConfig, chatId: string) {
  return {
    channel: "telegram" as const,
    send: async (_to: string, payload: Record<string, unknown>) => {
      const m = telegramMessageFor(payload as Record<string, any>);
      if (!m?.text.trim()) return { sent: false, simulated: false };
      return { sent: await sendHtml(cfg, chatId, m.text, m.replyMarkup), simulated: false };
    },
  };
}

// ── The chat's verified phone ────────────────────────────────────────────────

async function phoneOfChat(db: Db, chatId: string): Promise<string | null> {
  const [row] = await db.select({ phone: telegramPlatformChats.phone }).from(telegramPlatformChats)
    .where(eq(telegramPlatformChats.chatId, chatId)).limit(1);
  return row?.phone ?? null;
}

async function bindChat(db: Db, chatId: string, phone: string, username: string | null): Promise<void> {
  const now = new Date();
  await db.insert(telegramPlatformChats)
    .values({ chatId, phone, username: username?.slice(0, 64) ?? null, verifiedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: telegramPlatformChats.chatId, set: { phone, username: username?.slice(0, 64) ?? null, verifiedAt: now, updatedAt: now } });
}

/** Telegram's interface language → an onboarding language (English otherwise). */
function langOf(update: any): CopilotLanguage {
  const code = String(update?.message?.from?.language_code ?? update?.callback_query?.from?.language_code ?? "").slice(0, 2).toLowerCase();
  return (["fr", "ha", "yo", "ig"].includes(code) ? code : "en") as CopilotLanguage;
}

// ── Updates ──────────────────────────────────────────────────────────────────

/** Handle one webhook update (after the 200 ack). Never throws. */
export async function processPlatformBotUpdate(db: Db, update: any): Promise<void> {
  const cfg = platformBotConfig();
  if (!cfg) return;
  try {
    const ev = normalizeUpdate(update);
    if (!ev) return;
    const { claimWebhookEvent } = await import("./webhookDedupe");
    if ((await claimWebhookEvent(db, { id: `tgp:${ev.updateId}`, tenantId: "platform", type: "telegram_platform_update" })) !== "claimed") return;

    const lang = langOf(update);
    const askPhone = () => sendHtml(cfg, ev.chatId, copilotT(lang, "tgSharePhone"), {
      keyboard: [[{ text: copilotT(lang, "tgShareButton"), request_contact: true }]], resize_keyboard: true, one_time_keyboard: true,
    });
    const { withOnboardingTransport, handleInbound, startOrResumeOnboarding } = await import("./waOnboarding");
    const run = (fn: () => Promise<unknown>) => withOnboardingTransport(transportFor(cfg, ev.chatId), fn as () => Promise<any>);

    if (ev.kind === "contact") {
      if (!ev.selfShared || !ev.phoneNumber) { await askPhone(); return; }
      const { normalizeWaPhone } = await import("./waSender");
      const phone = normalizeWaPhone(ev.phoneNumber);
      await bindChat(db, ev.chatId, phone, ev.username);
      await botApi(cfg, "sendMessage", { chat_id: ev.chatId, text: "✅", reply_markup: { remove_keyboard: true } });
      await run(() => startOrResumeOnboarding(phone));
      return;
    }

    const phone = await phoneOfChat(db, ev.chatId);
    if (!phone) { await askPhone(); return; }

    if (ev.kind === "command") {
      if (ev.command === "stop") return; // the bot only ever answers what it's sent; nothing to switch off
      await run(() => startOrResumeOnboarding(phone));
      return;
    }
    if (ev.kind === "callback") {
      await botApi(cfg, "answerCallbackQuery", { callback_query_id: ev.callbackQueryId });
      if (ev.messageId) await botApi(cfg, "editMessageReplyMarkup", { chat_id: ev.chatId, message_id: ev.messageId, reply_markup: { inline_keyboard: [] } });
      await run(() => handleInbound({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: ev.interactive.id, title: ev.interactive.title } } }, phone));
      return;
    }
    if (ev.kind === "location") {
      await run(() => handleInbound({ type: "location", location: { latitude: ev.latitude, longitude: ev.longitude } }, phone));
      return;
    }
    if (ev.kind === "text") {
      await run(() => handleInbound({ type: "text", text: { body: ev.text } }, phone));
      return;
    }
    // Voice notes, photos, files: the assistant reads text (its "unsupported" reply says so).
    await run(() => handleInbound({ type: ev.mediaType === "photo" ? "image" : "document" }, phone));
  } catch (e: any) {
    console.error("[tg-platform] update failed:", e?.message);
  }
}
