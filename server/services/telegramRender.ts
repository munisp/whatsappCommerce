/**
 * telegramRender.ts — turn what the WhatsApp-shaped engines produce into what Telegram can show.
 *
 * The menu/session engine (useCases.ts) and the NLP assistant write WhatsApp formatting (*bold*, _italic_) and
 * describe buttons as a `SendInteractiveInput`. Telegram needs HTML (parse_mode) and inline keyboards. Pure functions
 * only, so the mapping is unit-tested without a database or a network.
 *
 * Escaping matters here, not just looks: Telegram rejects the WHOLE message ("can't parse entities") when the text has
 * a stray `<` or `&`, so a product called "R&D Kit" or a reply containing "under <5 minutes" would never arrive.
 */
import type { SendInteractiveInput } from "./waSender";
import { escapeTelegramHtml, waMarkdownToTelegramHtml, TG_BUTTON_TITLE_LIMIT, TG_CALLBACK_DATA_BYTES, type TelegramInlineButton, type TelegramListRow } from "./telegramSender";

// Merge fix 2026-09-27: waMarkdownToTelegramHtml used to live here, but this module's own renderer
// (renderInteractiveForTelegram, below) had been superseded as the live send path — telegramInbound.ts calls
// sendTelegramInteractive/sendTelegramKeyboard directly instead — which meant the ONE place that escaped and
// converted WA markdown correctly was dead code, and every REAL Telegram send skipped both. Moved the
// implementation to telegramSender.ts (the actual chokepoint every send funnels through) and re-exported here
// so this file's own tests/callers don't need to change.
export { waMarkdownToTelegramHtml };

export type TelegramRendered =
  | { kind: "keyboard"; text: string; buttons: TelegramInlineButton[] }
  | { kind: "list"; text: string; rows: TelegramListRow[] };

/**
 * A WhatsApp button/list message → the Telegram equivalent. Returns null when it cannot be shown faithfully (empty
 * body, no options, or an id Telegram's 64-byte callback_data cannot carry) so the caller sends the plain-text reply
 * instead of a keyboard whose buttons would not work.
 *
 * Reply buttons become an inline keyboard; a list becomes one list (its sections are flattened — Telegram has no
 * sections), which the sender pages with a "More →" button past TG_LIST_PAGE_SIZE rows.
 */
export function renderInteractiveForTelegram(input: SendInteractiveInput): TelegramRendered | null {
  if (!input?.bodyText?.trim()) return null;
  const parts: string[] = [];
  if (input.headerText?.trim()) parts.push(`<b>${escapeTelegramHtml(input.headerText.trim())}</b>`);
  parts.push(waMarkdownToTelegramHtml(input.bodyText.trim()));
  if (input.footerText?.trim()) parts.push(`<i>${escapeTelegramHtml(input.footerText.trim())}</i>`);
  const text = parts.join("\n\n");

  const carriable = (id: string) => !!id?.trim() && Buffer.byteLength(id, "utf8") <= TG_CALLBACK_DATA_BYTES;
  const title = (t: string, id: string) => (t ?? "").trim().slice(0, TG_BUTTON_TITLE_LIMIT) || id;

  if (input.action.type === "button") {
    const buttons = input.action.buttons.map((b): TelegramInlineButton => ({ id: b.id, title: title(b.title, b.id) }));
    if (!buttons.length || !buttons.every((b) => carriable(b.id))) return null;
    return { kind: "keyboard", text, buttons };
  }
  // W49 RICHMEDIA (RICH-7): a WA cta_url interactive (payment/tracking "Pay now" / "Track shipment" style
  // button) becomes a single Telegram URL button — carries a `url` instead of callback_data, so it isn't subject
  // to the 64-byte callback_data limit `carriable` checks below (mirrors telegramInbound.ts's own
  // sendTelegramInteractive, the render path actually wired into the live send path today).
  if (input.action.type === "cta_url") {
    if (!input.action.url?.trim()) return null;
    return { kind: "keyboard", text, buttons: [{ id: input.action.url, title: title(input.action.displayText, "Open"), url: input.action.url }] };
  }
  const rows = input.action.sections
    .flatMap((s) => s.rows)
    .map((r): TelegramListRow => ({ id: r.id, title: title(r.title, r.id), description: r.description }));
  if (!rows.length || !rows.every((r) => carriable(r.id))) return null;
  return { kind: "list", text, rows };
}
