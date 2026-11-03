/**
 * tgOnboarding.ts — Telegram chat onboarding: the same copilot and flow as the WhatsApp onboarding
 * number (waOnboarding.ts), on the platform's own bot.
 *
 * Sessions are keyed by phone, and the phone later owns the shop. So nothing starts until the person
 * shares their OWN contact with Telegram's request_contact button (contact.user_id === from.id, which
 * Telegram vouches for). A typed number is never accepted.
 */
import { handleInbound, type OnboardingSendContext, type OnboardingSendResult, type OnboardingTransport } from "./waOnboarding";
import { chunkWhatsAppText, normalizeWaPhone } from "./waSender";
import { normalizeUpdate } from "./telegramInbound";
import { TG_BUTTON_TITLE_LIMIT, waMarkdownToTelegramHtml } from "./telegramSender";
import { redactString } from "./logRedact";
import { t as copilotT } from "./onboardingCopilot/language";
import { clearTelegramOnboardingPhone, getTelegramOnboardingPhone, setTelegramOnboardingPhone } from "./platformNumber";

const TG_API_BASE = "https://api.telegram.org";
const TELEGRAM_LANGUAGES = new Set(["en", "fr", "ha", "yo", "ig", "pcm"]);

export interface TelegramOnboardingConfig {
  token: string;
  secret: string;
}

/** Null unless both settings are present, so an unconfigured deploy stays fully off. */
export function telegramOnboardingConfig(): TelegramOnboardingConfig | null {
  const token = (process.env.ONBOARDING_TELEGRAM_BOT_TOKEN ?? "").trim();
  const secret = (process.env.ONBOARDING_TELEGRAM_WEBHOOK_SECRET ?? "").trim();
  return token && secret ? { token, secret } : null;
}

async function callBot(token: string, method: string, body: Record<string, unknown>): Promise<OnboardingSendResult> {
  try {
    const res = await fetch(`${TG_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[tgOnboarding] ${method} failed (${res.status}): ${redactString(detail.slice(0, 300))}`);
      return { sent: false, simulated: false };
    }
    return { sent: true, simulated: false };
  } catch (e: any) {
    // A fetch error can quote the URL, and the URL holds the token.
    console.error(`[tgOnboarding] ${method} network error:`, redactString(String(e?.message ?? "").replaceAll(token, "***")));
    return { sent: false, simulated: false };
  }
}

export function telegramTransport(token: string, chatId: string): OnboardingTransport {
  const send = (body: string, reply_markup?: unknown) =>
    callBot(token, "sendMessage", { chat_id: chatId, text: waMarkdownToTelegramHtml(body), parse_mode: "HTML", ...(reply_markup ? { reply_markup } : {}) });
  return {
    async sendText(body) {
      let last: OnboardingSendResult = { sent: false, simulated: false };
      for (const chunk of chunkWhatsAppText(body)) last = await send(chunk);
      return last;
    },
    sendButtons(body, buttons) {
      return send(body, {
        inline_keyboard: buttons.map((button) => [{ text: button.title.slice(0, TG_BUTTON_TITLE_LIMIT), callback_data: button.id }]),
      });
    },
  };
}

function languageOf(update: any): string {
  const code = String(update?.message?.from?.language_code ?? update?.callback_query?.from?.language_code ?? "en").toLowerCase().split("-")[0];
  return TELEGRAM_LANGUAGES.has(code) ? code : "en";
}

function askForContact(cfg: TelegramOnboardingConfig, chatId: string, lang: string, key: "tgShareContact" | "tgOwnContactOnly") {
  return callBot(cfg.token, "sendMessage", {
    chat_id: chatId,
    text: copilotT(lang, key),
    reply_markup: {
      keyboard: [[{ text: copilotT(lang, "tgShareContactButton"), request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

/** Runs after the webhook has acked. Never throws. */
export async function handleTelegramOnboardingUpdate(update: any, cfg: TelegramOnboardingConfig): Promise<void> {
  try {
    const event = normalizeUpdate(update);
    if (!event) return;
    const lang = languageOf(update);
    const chatId = event.chatId;
    if (event.kind === "callback" && event.callbackQueryId) {
      await callBot(cfg.token, "answerCallbackQuery", { callback_query_id: event.callbackQueryId });
    }

    let phone = await getTelegramOnboardingPhone(chatId);
    const transport = telegramTransport(cfg.token, chatId);
    const ctx: OnboardingSendContext = { tenantId: null, transport, channel: "telegram" };

    if (event.kind === "command" && event.command === "stop") {
      await clearTelegramOnboardingPhone(chatId);
      await callBot(cfg.token, "sendMessage", { chat_id: chatId, text: copilotT(lang, "tgStopped"), reply_markup: { remove_keyboard: true } });
      return;
    }

    if (event.kind === "contact") {
      const shared = normalizeWaPhone(event.phoneNumber);
      if (!event.selfShared || !shared) {
        await askForContact(cfg, chatId, lang, "tgOwnContactOnly");
        return;
      }
      phone = shared;
      await setTelegramOnboardingPhone(chatId, phone);
      await handleInbound({ type: "text", text: { body: "hi" } }, phone, ctx);
      return;
    }

    if (!phone) {
      await askForContact(cfg, chatId, lang, "tgShareContact");
      return;
    }

    if (event.kind === "text") {
      await handleInbound({ type: "text", text: { body: event.text } }, phone, ctx);
    } else if (event.kind === "command") {
      await handleInbound({ type: "text", text: { body: "hi" } }, phone, ctx);
    } else if (event.kind === "callback") {
      await handleInbound({ type: "interactive", interactive: { button_reply: { id: event.interactive.id, title: event.interactive.title } } }, phone, ctx);
    } else {
      await handleInbound({ type: "unsupported" }, phone, ctx);
    }
  } catch (e: any) {
    console.error("[tgOnboarding] update failed:", redactString(String(e?.message ?? "").replaceAll(cfg.token, "***")));
  }
}
