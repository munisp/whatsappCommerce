/**
 * waMenu.ts — Channel-agnostic conversational menu engine (runtime).
 *
 * SINGLE SOURCE OF TRUTH: the menu contract types, DEFAULT_WA_MENU and the
 * pure renderer live in shared/waMenu.ts (consumed by the admin preview and
 * the dashboard menu builder). This module re-exports them and adds the
 * runtime-only pieces:
 *   - loadMenuConfig        lenient settings.waMenu merge/sanitize
 *   - buildMenuEntries      numbered selectable entries (id/kind aware)
 *   - resolveMenuSelection  numeric reply → entry
 *   - renderWhatsAppMenu / renderUssdMenu / ussdWrap  channel formatters
 *   - renderWhatsAppInteractive  button/list rendering for WhatsApp
 *   - isMenuKeyword         menu re-open keywords
 *
 * tenants.settings.waMenu conforms to WaMenuConfig:
 *
 *   waMenu = {
 *     greeting: string,                    // may contain {businessName}
 *     useCases: Array<{ id: "shop"|"track"|"support"|"booking"|"handoff",
 *                       label: string, enabled: boolean, order: number }>,
 *     customItems: Array<{ key: string, label: string, response: string }>,
 *     fallback: "nlp" | "menu"
 *   }
 */
import {
  DEFAULT_WA_MENU,
  WA_USE_CASE_IDS,
  renderWaMenu,
  type WaMenuConfig,
  type WaMenuCustomItem,
  type WaMenuUseCase,
  type WaUseCaseId,
} from "../../shared/waMenu";
import type { SendInteractiveInput } from "./waSender";

// ── Re-exported shared contract (single source of truth) ────────────────────
export type { WaMenuConfig, WaMenuCustomItem, WaMenuUseCase };
export type UseCaseId = WaUseCaseId;
export { DEFAULT_WA_MENU, renderWaMenu };
export const USE_CASE_IDS: readonly UseCaseId[] = WA_USE_CASE_IDS;

/** Default template used when a tenant has no settings.waMenu configured. */
export function defaultMenuConfig(): WaMenuConfig {
  return structuredClone(DEFAULT_WA_MENU);
}

/** Dynamic values interpolated into the greeting/labels at render time. */
export interface MenuDynamicCtx {
  businessName?: string;
  /** Count of the caller's open (not yet delivered/cancelled) orders. */
  openOrdersCount?: number | null;
}

/** A single selectable numbered row in the rendered menu. */
export interface MenuEntry {
  n: number;
  kind: "useCase" | "custom";
  /** useCase id or customItem key. */
  id: string;
  label: string;
}

function isUseCaseId(v: unknown): v is UseCaseId {
  return typeof v === "string" && (USE_CASE_IDS as readonly string[]).includes(v);
}

function sanitizeUseCase(raw: any, fallbackOrder: number): WaMenuUseCase | null {
  if (!raw || typeof raw !== "object" || !isUseCaseId(raw.id)) return null;
  return {
    id: raw.id,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label : raw.id,
    enabled: raw.enabled !== false,
    order: Number.isFinite(raw.order) ? Number(raw.order) : fallbackOrder,
  };
}

function sanitizeCustomItem(raw: any): WaMenuCustomItem | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.key !== "string" || !raw.key.trim()) return null;
  if (typeof raw.label !== "string" || !raw.label.trim()) return null;
  if (typeof raw.response !== "string") return null;
  return { key: raw.key, label: raw.label, response: raw.response };
}

/**
 * Load the menu configuration for a tenant. Accepts the tenant row (or any
 * object with a `settings` JSON blob). Returns the default template when
 * settings.waMenu is absent; otherwise merges the stored config over the
 * defaults, dropping malformed entries.
 */
export function loadMenuConfig(
  tenant: { settings?: unknown } | null | undefined,
): WaMenuConfig {
  const defaults = defaultMenuConfig();
  const settings = (tenant?.settings ?? null) as Record<string, unknown> | null;
  const raw = (settings?.waMenu ?? null) as Partial<WaMenuConfig> | null;
  if (!raw || typeof raw !== "object") return defaults;

  const useCases = Array.isArray(raw.useCases)
    ? raw.useCases.map((u, i) => sanitizeUseCase(u, i + 1)).filter((u): u is WaMenuUseCase => !!u)
    : defaults.useCases;
  const customItems = Array.isArray(raw.customItems)
    ? raw.customItems.map(sanitizeCustomItem).filter((c): c is WaMenuCustomItem => !!c)
    : defaults.customItems;

  return {
    greeting: typeof raw.greeting === "string" && raw.greeting.trim() ? raw.greeting : defaults.greeting,
    useCases: useCases.length > 0 ? useCases : defaults.useCases,
    customItems,
    fallback: raw.fallback === "menu" ? "menu" : "nlp",
  };
}

/** Interpolate legacy {businessName} / {openOrders} placeholders. */
function interpolate(template: string, ctx: MenuDynamicCtx): string {
  return template
    .replace(/\{businessName\}/g, ctx.businessName ?? "our store")
    .replace(/\{openOrders\}/g, ctx.openOrdersCount != null ? String(ctx.openOrdersCount) : "0");
}

/**
 * Build the ordered, selectable menu entries: enabled useCases sorted by
 * `order`, followed by customItems, numbered sequentially from 1. The
 * numbering matches shared renderWaMenu exactly.
 */
export function buildMenuEntries(config: WaMenuConfig): MenuEntry[] {
  const enabled = config.useCases
    .filter((u) => u.enabled)
    .sort((a, b) => a.order - b.order);
  const entries: MenuEntry[] = enabled.map((u) => ({
    n: 0,
    kind: "useCase",
    id: u.id,
    label: u.label,
  }));
  for (const c of config.customItems) {
    entries.push({ n: 0, kind: "custom", id: c.key, label: c.label });
  }
  entries.forEach((e, i) => { e.n = i + 1; });
  return entries;
}

/**
 * Core renderer: greeting + numbered list. Delegates to the SHARED pure
 * renderer (shared/waMenu.ts renderWaMenu) so the runtime menu, the admin
 * preview and the dashboard draft preview can never drift apart.
 *
 * Legacy {businessName}/{openOrders} placeholders in greeting/labels are
 * interpolated first; when a config still uses the {openOrders} placeholder
 * the shared renderer's " (N open)" track annotation is suppressed so the
 * count is never rendered twice.
 */
export function renderMenu(config: WaMenuConfig, ctx: MenuDynamicCtx = {}): string {
  const businessName = ctx.businessName ?? "our store";
  const usesOpenOrdersPlaceholder = [
    config.greeting,
    ...config.useCases.map((u) => u.label),
    ...config.customItems.map((c) => c.label),
  ].some((s) => s.includes("{openOrders}"));
  const mapped: WaMenuConfig = {
    ...config,
    greeting: interpolate(config.greeting, ctx),
    useCases: config.useCases.map((u) => ({ ...u, label: interpolate(u.label, ctx) })),
    customItems: config.customItems.map((c) => ({ ...c, label: interpolate(c.label, ctx) })),
  };
  return renderWaMenu(mapped, {
    businessName,
    openOrderCount: usesOpenOrdersPlaceholder ? undefined : ctx.openOrdersCount ?? undefined,
  });
}

/** WhatsApp formatter — core text plus a reply hint. */
export function renderWhatsAppMenu(config: WaMenuConfig, ctx: MenuDynamicCtx = {}): string {
  return `${renderMenu(config, ctx)}\n\nReply with a number to choose an option.`;
}

/** Reply id used for an interactive menu entry (button/list row). */
export function menuEntryReplyId(entry: MenuEntry): string {
  return `menu_${entry.n}`;
}

/** Parse an interactive reply id back to its menu entry number (or null). */
export function parseMenuEntryReplyId(id: string): number | null {
  const m = /^menu_(\d{1,2})$/.exec(id.trim());
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Interactive WhatsApp rendering of the menu:
 *   ≤3 enabled entries → reply buttons
 *   ≤10                → a single-section list
 *   more               → null (caller falls back to the numbered text menu)
 *
 * Returns a SendInteractiveInput ready for sendWhatsAppInteractive; the
 * button/row ids are `menu_<n>` so interactive replies resolve through the
 * SAME resolveMenuSelection path as numeric text replies.
 */
export function renderWhatsAppInteractive(
  config: WaMenuConfig,
  ctx: MenuDynamicCtx = {},
): SendInteractiveInput | null {
  const entries = buildMenuEntries(config);
  if (entries.length === 0 || entries.length > 10) return null;
  const bodyText = interpolate(config.greeting, ctx);
  const footerText = "Tap an option, or reply with its number.";
  if (entries.length <= 3) {
    return {
      bodyText,
      footerText,
      action: {
        type: "button",
        buttons: entries.map((e) => ({ id: menuEntryReplyId(e), title: interpolate(e.label, ctx) })),
      },
    };
  }
  return {
    bodyText,
    footerText,
    action: {
      type: "list",
      buttonLabel: "View options",
      sections: [
        {
          title: ctx.businessName ?? "Menu",
          rows: entries.map((e) => ({ id: menuEntryReplyId(e), title: interpolate(e.label, ctx) })),
        },
      ],
    },
  };
}

/**
 * USSD formatter — Africa's Talking convention: responses that expect more
 * input are prefixed "CON ", terminal responses are prefixed "END ".
 */
export function renderUssdMenu(
  config: WaMenuConfig,
  ctx: MenuDynamicCtx = {},
  opts: { end?: boolean } = {},
): string {
  return `${opts.end ? "END" : "CON"} ${renderMenu(config, ctx)}`;
}

/** Wrap any reply text for USSD transport. */
export function ussdWrap(text: string, end: boolean): string {
  return `${end ? "END" : "CON"} ${text}`;
}

/**
 * Resolve a numeric reply against the rendered menu. Returns the selected
 * entry, or null when the input is not a valid menu number.
 */
export function resolveMenuSelection(config: WaMenuConfig, input: string): MenuEntry | null {
  const trimmed = input.trim();
  if (!/^\d{1,2}$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  return buildMenuEntries(config).find((e) => e.n === n) ?? null;
}

/** Keywords that always re-open the menu. */
const MENU_KEYWORDS = new Set(["menu", "hi", "hello", "start", "restart", "help", "catalog"]);

export function isMenuKeyword(text: string): boolean {
  return MENU_KEYWORDS.has(text.trim().toLowerCase());
}
