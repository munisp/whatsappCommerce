// === W37 telegram ===
/**
 * Channel Sender facade (SPEC_W37 Coder A §3) — the channel-agnostic send
 * entry point. Routes by channel to the existing senders WITHOUT touching
 * their internals:
 *
 *   whatsapp → waSender (sendWhatsAppText / sendWhatsAppInteractive /
 *              sendWhatsAppMedia / sendWhatsAppLocationRequest)
 *   telegram → telegramSender (inline keyboards carrying the existing id
 *              grammar; see telegramSender.ts)
 *
 * The capability matrix (CHANNEL_CAPABILITIES) lets callers degrade honestly
 * (e.g. no Meta templates on telegram → render as plain formatted text; no
 * 24h session window on telegram; ≤3 buttons on whatsapp vs paged inline
 * keyboards on telegram).
 *
 * Fail-open everywhere: unknown channels and sender errors surface as
 * { sent: false, ... } only where the underlying sender itself is
 * non-throwing; like waSender, API failures throw after logging so callers
 * keep the existing "catch and decide" contract.
 */

import type {
  SendInteractiveInput,
  SendMediaInput,
  SendTemplateResult,
} from "./waSender";
import type { SendTelegramResult, TelegramInlineButton, TelegramListRow } from "./telegramSender";

export type ChannelId = "whatsapp" | "telegram";

export interface ChannelCapabilities {
  /** Meta-approved template messages (24h-window escape hatch). */
  supportsTemplates: boolean;
  /** Interactive buttons (WA reply buttons / telegram inline keyboard). */
  supportsButtons: boolean;
  /** Max buttons in a single message (WA hard cap 3; telegram paged). */
  maxButtons: number;
  /** Max buttons per row in the channel's native rendering. */
  maxButtonsPerRow: number;
  /** Native option-list message (WA list / telegram chunked keyboard pages). */
  supportsLists: boolean;
  maxListRows: number;
  /** Channel enforces a 24h customer-service window (WA only). */
  requiresSessionWindow: boolean;
  /** Blue ticks / read receipts (telegram: sendChatAction only, no receipts). */
  supportsReadReceipts: boolean;
  /** Delivered/read webhooks for outbound messages (telegram: none — log rows stay 'sent'). */
  supportsDeliveryReceipts: boolean;
  /** Outbound media (image/photo + document; telegram adds voice). */
  supportsMedia: boolean;
  /** Native location-share request. */
  supportsLocationRequest: boolean;
  /** Native contact-share request (telegram request_contact; WA: none). */
  supportsContactRequest: boolean;
  /** Safe text chunk length. */
  textLimit: number;
}

/** The honest per-channel capability matrix. */
export const CHANNEL_CAPABILITIES: Record<ChannelId, ChannelCapabilities> = {
  whatsapp: {
    supportsTemplates: true,
    supportsButtons: true,
    maxButtons: 3,
    maxButtonsPerRow: 3,
    supportsLists: true,
    maxListRows: 10,
    requiresSessionWindow: true,
    supportsReadReceipts: true,
    supportsDeliveryReceipts: true,
    supportsMedia: true,
    supportsLocationRequest: true,
    supportsContactRequest: false,
    textLimit: 4000,
  },
  telegram: {
    supportsTemplates: false, // render templates as plain formatted text
    supportsButtons: true,
    maxButtons: 98, // Bot API inline-keyboard practical cap; lists page at 8
    maxButtonsPerRow: 8,
    supportsLists: true, // chunked inline keyboards + menu_more_<offset> pagination
    maxListRows: 8, // per page
    requiresSessionWindow: false, // no 24h window — cron nudges must not suppress
    supportsReadReceipts: false, // sendChatAction("typing") is the analogue
    supportsDeliveryReceipts: false, // bots get no delivered/read callbacks
    supportsMedia: true,
    supportsLocationRequest: true,
    supportsContactRequest: true,
    textLimit: 4000,
  },
};

export function capabilitiesFor(channel: string): ChannelCapabilities | null {
  return (CHANNEL_CAPABILITIES as Record<string, ChannelCapabilities>)[channel] ?? null;
}

// === W37 merger === compatibility alias: Coder C's parity journeys were
// written against the stub name `channelCapabilities`; the real lookup is
// capabilitiesFor (null for unknown channels, honestly).
export function channelCapabilities(channel: string): ChannelCapabilities | null {
  return capabilitiesFor(channel);
}
// === END W37 merger ===

/** True when the channel has no 24h-window suppression (cron nudge gating). */
export function requiresSessionWindow(channel: string): boolean {
  return capabilitiesFor(channel)?.requiresSessionWindow ?? true;
}

/** Channel-agnostic outbound payload. */
export type ChannelMessagePayload =
  | { kind: "text"; text: string }
  | { kind: "keyboard"; text: string; buttons: Array<{ id: string; title: string; url?: string }> }
  | { kind: "list"; text: string; rows: TelegramListRow[]; buttonLabel?: string; page?: number }
  | { kind: "media"; media: { type: "image" | "document" | "photo" | "voice"; link?: string; mediaId?: string; buffer?: Buffer; caption?: string; filename?: string } }
  | { kind: "location_request"; text: string }
  | { kind: "contact_request"; text: string }
  | { kind: "template"; templateName: string; languageCode: string; components?: unknown[]; /** Telegram fallback: pre-rendered plain text. */ fallbackText: string };

export interface ChannelSendResult {
  channel: ChannelId;
  sent: boolean;
  simulated: boolean;
  /** WA wamids or telegram message ids (as strings) of the send. */
  messageIds: string[];
  /** Set when the payload kind is unsupported and the facade degraded. */
  degraded?: string;
}

function waResult(channel: ChannelId, r: { sent: boolean; simulated: boolean; wamid?: string | null; wamids?: string[] }): ChannelSendResult {
  return {
    channel,
    sent: r.sent,
    simulated: r.simulated,
    messageIds: r.wamids ?? (r.wamid ? [r.wamid] : []),
  };
}

function tgResult(r: SendTelegramResult, degraded?: string): ChannelSendResult {
  return {
    channel: "telegram",
    sent: r.sent,
    simulated: r.simulated,
    messageIds: r.messageIds.map(String),
    ...(degraded ? { degraded } : {}),
  };
}

/**
 * Route one outbound message to the right channel sender.
 *
 * @param tenantId tenant whose channel credentials apply
 * @param channel  "whatsapp" | "telegram"
 * @param to       recipient: E.164 phone (whatsapp) or chat_id (telegram —
 *                 pass the bare chat_id, NOT the `telegram:<id>` session key;
 *                 use stripTelegramPrefix when in doubt)
 * @param payload  channel-agnostic message (see ChannelMessagePayload)
 */
export async function sendChannelMessage(
  tenantId: string,
  channel: ChannelId,
  to: string,
  payload: ChannelMessagePayload,
  opts?: { notifType?: string; orderId?: string | null; userId?: number | null },
): Promise<ChannelSendResult> {
  if (channel === "whatsapp") {
    const wa = await import("./waSender");
    switch (payload.kind) {
      case "text":
        return waResult("whatsapp", await wa.sendWhatsAppText(tenantId, to, payload.text, opts));
      case "keyboard": {
        const input: SendInteractiveInput = {
          bodyText: payload.text,
          action: { type: "button", buttons: payload.buttons.slice(0, CHANNEL_CAPABILITIES.whatsapp.maxButtons).map((b) => ({ id: b.id, title: b.title })) },
        };
        return waResult("whatsapp", await wa.sendWhatsAppInteractive(tenantId, to, input, opts));
      }
      case "list": {
        const input: SendInteractiveInput = {
          bodyText: payload.text,
          action: {
            type: "list",
            buttonLabel: payload.buttonLabel,
            sections: [{ rows: payload.rows.slice(0, CHANNEL_CAPABILITIES.whatsapp.maxListRows).map((r) => ({ id: r.id, title: r.title, description: r.description })) }],
          },
        };
        return waResult("whatsapp", await wa.sendWhatsAppInteractive(tenantId, to, input, opts));
      }
      case "media": {
        const m = payload.media;
        const input: SendMediaInput = {
          type: m.type === "photo" ? "image" : m.type === "voice" ? "document" : m.type,
          link: m.link,
          mediaId: m.mediaId,
          caption: m.caption,
          filename: m.filename ?? (m.type === "voice" ? "voice.ogg" : undefined),
        };
        return waResult("whatsapp", await wa.sendWhatsAppMedia(tenantId, to, input, opts));
      }
      case "location_request":
        return waResult("whatsapp", await wa.sendWhatsAppLocationRequest(tenantId, to, payload.text, opts));
      case "contact_request": {
        // WA has no native contact request — degrade honestly to plain text.
        const r = await wa.sendWhatsAppText(tenantId, to, payload.text, opts);
        return { ...waResult("whatsapp", r), degraded: "contact_request→text" };
      }
      case "template":
        return waResult("whatsapp", await wa.sendWhatsAppTemplate(tenantId, to, payload.templateName, payload.languageCode, payload.components, opts));
    }
  }

  if (channel === "telegram") {
    const tg = await import("./telegramSender");
    const chatId = stripTelegramPrefix(to);
    switch (payload.kind) {
      case "text":
        return tgResult(await tg.sendTelegramText(tenantId, chatId, payload.text, { notifType: opts?.notifType }));
      case "keyboard":
        return tgResult(await tg.sendTelegramKeyboard(
          tenantId,
          chatId,
          payload.text,
          payload.buttons.map((b): TelegramInlineButton => ({ id: b.id, title: b.title, url: b.url })),
          { notifType: opts?.notifType },
        ));
      case "list":
        return tgResult(await tg.sendTelegramList(tenantId, chatId, payload.text, payload.rows, { notifType: opts?.notifType, page: payload.page }));
      case "media": {
        const m = payload.media;
        return tgResult(await tg.sendTelegramMedia(tenantId, chatId, {
          type: m.type === "image" ? "photo" : m.type,
          url: m.link,
          fileId: m.mediaId,
          buffer: m.buffer,
          caption: m.caption,
          filename: m.filename,
        }, { notifType: opts?.notifType }));
      }
      case "location_request":
        return tgResult(await tg.sendTelegramLocationRequest(tenantId, chatId, payload.text, { notifType: opts?.notifType }));
      case "contact_request":
        return tgResult(await tg.sendTelegramContactRequest(tenantId, chatId, payload.text, { notifType: opts?.notifType }));
      case "template":
        // Telegram has no template approval flow — render as plain formatted
        // text (fallbackText is required; template name is kept in notifType
        // for analytics parity).
        return tgResult(
          await tg.sendTelegramText(tenantId, chatId, payload.fallbackText, { notifType: opts?.notifType ?? `template_render:${payload.templateName}` }),
          "template→text",
        );
    }
  }

  throw new Error(`sendChannelMessage: unsupported channel "${channel as string}"`);
}

/** Normalize a telegram recipient: strip the `telegram:` session-key prefix. */
export function stripTelegramPrefix(to: string): string {
  return to.startsWith("telegram:") ? to.slice("telegram:".length) : to;
}

/**
 * Honest per-channel status report for /health/ready + infra probes.
 * Never throws, never hits the network.
 */
export async function getChannelSenderStatus(tenantId?: string): Promise<{
  whatsapp: { channel: "whatsapp"; configured: boolean; mode: "simulation" | "live" };
  telegram: { channel: "telegram"; globallyEnabled: boolean; configured: boolean; mode: "disabled" | "simulation" | "live" };
}> {
  let waConfigured = false;
  try {
    const wa = await import("./waSender");
    waConfigured = (await wa.resolveTenantWaCredentials(tenantId)) !== null;
  } catch {
    waConfigured = false;
  }
  let telegram: Awaited<ReturnType<typeof import("./telegramSender").getTelegramSenderStatus>>;
  try {
    const tg = await import("./telegramSender");
    telegram = await tg.getTelegramSenderStatus(tenantId);
  } catch {
    telegram = { channel: "telegram", globallyEnabled: false, configured: false, mode: "disabled" };
  }
  return {
    whatsapp: { channel: "whatsapp", configured: waConfigured, mode: waConfigured ? "live" : "simulation" },
    telegram,
  };
}
// === W37 telegram END ===
