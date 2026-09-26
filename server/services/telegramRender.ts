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
import { escapeTelegramHtml, TG_BUTTON_TITLE_LIMIT, TG_CALLBACK_DATA_BYTES, type TelegramInlineButton, type TelegramListRow } from "./telegramSender";

/** Characters that may sit directly BEFORE / AFTER a formatting mark. `<` `>` are only ever our own tags (user text is escaped first). */
const BEFORE = String.raw`(^|[\s(\[{>"'])`;
const AFTER = String.raw`(?=$|[\s.,:;!?)\]}<"'])`;

/** One WhatsApp inline mark → a Telegram tag. Marks must hug their text and sit on a word edge, as on WhatsApp. */
function span(text: string, mark: string, tag: string): string {
  const m = mark.replace(/[*_~]/g, "\\$&");
  const re = new RegExp(`${BEFORE}${m}(?=\\S)([^\\n${m}]*?\\S)${m}${AFTER}`, "gm");
  return text.replace(re, `$1<${tag}>$2</${tag}>`);
}

/**
 * WhatsApp text → Telegram HTML. Escapes first, then converts *bold*, _italic_, ~strike~, `code` and ```blocks```.
 * Code is set aside while the other marks are converted, so `snake_case` in code and ids like menu_more_8 stay literal.
 */
export function waMarkdownToTelegramHtml(text: string): string {
  const stash: string[] = [];
  const keep = (html: string) => `\u0000${stash.push(html) - 1}\u0000`;
  let out = escapeTelegramHtml(String(text ?? "").replace(/\u0000/g, ""));
  out = out
    .replace(/```([\s\S]*?)```/g, (_m, c: string) => keep(`<pre>${c.replace(/^\n/, "")}</pre>`))
    .replace(/`([^`\n]+)`/g, (_m, c: string) => keep(`<code>${c}</code>`));
  out = span(out, "*", "b");
  out = span(out, "_", "i");
  out = span(out, "~", "s");
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)] ?? "");
}

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
  const rows = input.action.sections
    .flatMap((s) => s.rows)
    .map((r): TelegramListRow => ({ id: r.id, title: title(r.title, r.id), description: r.description }));
  if (!rows.length || !rows.every((r) => carriable(r.id))) return null;
  return { kind: "list", text, rows };
}
