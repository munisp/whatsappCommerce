/**
 * The real WhatsApp conversation, as the shop's Conversations page shows it:
 * every message the customer sent (as it arrived) and every message the shop
 * sent (as it went out), in channel_messages. Before this, the page rebuilt
 * chats from the assistant's own notes, which missed menu and consent turns,
 * showed internal hand-off text instead of what the customer typed, and
 * invented the times.
 *
 * Never throws: a failed write must not affect messaging.
 */
import { channelMessages } from "../../drizzle/schema";
import { getDb } from "../db";

const MAX = 4000;

/** What the customer sent, in words. Null for things that aren't messages (reactions). */
export function describeInbound(msg: any): string | null {
  switch (msg?.type) {
    case "text": return String(msg.text?.body ?? "");
    case "interactive": {
      const r = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
      return r?.title ? `[tapped] ${r.title}` : "[tapped a button]";
    }
    case "button": return `[tapped] ${msg.button?.text ?? ""}`.trim();
    case "location": return `📍 Shared a location${msg.location?.address ? `: ${msg.location.address}` : ""}`;
    case "image": return `[photo]${msg.image?.caption ? ` ${msg.image.caption}` : ""}`;
    case "video": return `[video]${msg.video?.caption ? ` ${msg.video.caption}` : ""}`;
    case "audio": return "[voice note]";
    case "document": return `[document] ${msg.document?.filename ?? ""}`.trim();
    case "sticker": return "[sticker]";
    case "order": return "[order from the WhatsApp catalog]";
    case "reaction": return null;
    default: return msg?.type ? `[${msg.type}]` : null;
  }
}

/** What the shop sent, in words, from the Graph payload. */
export function describeOutbound(payload: any, templateName?: string | null): string | null {
  if (!payload) return templateName ? `[template] ${templateName}` : null;
  switch (payload.type) {
    case "text": return String(payload.text?.body ?? "");
    case "interactive": {
      const i = payload.interactive ?? {};
      const body = String(i.body?.text ?? "");
      if (i.type === "cta_url") return `${body}\n[button] ${i.action?.parameters?.display_text ?? "Open"}`.trim();
      if (i.type === "location_request_message") return `${body}\n[button] Send location`.trim();
      const buttons = (i.action?.buttons ?? []).map((b: any) => b?.reply?.title).filter(Boolean);
      if (buttons.length) return `${body}\n${buttons.map((t: string) => `[${t}]`).join(" ")}`.trim();
      const rows = (i.action?.sections ?? []).flatMap((s: any) => s?.rows ?? []).map((r: any) => r?.title).filter(Boolean);
      if (rows.length) return `${body}\n${rows.map((t: string) => `• ${t}`).join("\n")}`.trim();
      return body || "[interactive message]";
    }
    case "image": return `[photo]${payload.image?.caption ? ` ${payload.image.caption}` : ""}`;
    case "document": return `[document]${payload.document?.caption ? ` ${payload.document.caption}` : ""}`;
    case "video": return `[video]${payload.video?.caption ? ` ${payload.video.caption}` : ""}`;
    case "audio": return "[voice note]";
    case "template": return `[template] ${templateName ?? payload.template?.name ?? ""}`.trim();
    default: return templateName ? `[template] ${templateName}` : null;
  }
}

export async function recordConversationMessage(opts: {
  tenantId: string | null | undefined;
  phone: string;
  direction: "inbound" | "outbound";
  body: string | null;
  channel?: "whatsapp" | "telegram";
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    if (!opts.tenantId || !opts.body?.trim()) return;
    const db = await getDb();
    if (!db) return;
    const phone = opts.phone.replace(/[^\d]/g, "") || opts.phone;
    await db.insert(channelMessages).values({
      channel: (opts.channel ?? "whatsapp") as any,
      direction: opts.direction,
      fromAddress: opts.direction === "inbound" ? phone : opts.tenantId,
      toAddress: opts.direction === "inbound" ? opts.tenantId : phone,
      tenantId: opts.tenantId,
      body: opts.body.length > MAX ? opts.body.slice(0, MAX - 1) + "…" : opts.body,
      metadata: opts.metadata ?? null,
      processed: true,
    });
  } catch (e: any) {
    console.warn("[conversationLog] write failed:", e?.message);
  }
}
