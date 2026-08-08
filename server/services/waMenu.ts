/**
 * waMenu.ts — Channel-agnostic conversational menu engine.
 *
 * The menu configuration lives in tenants.settings.waMenu (shared contract
 * with the dashboard CRUD side):
 *
 *   waMenu = {
 *     greeting: string,                    // may contain {businessName}
 *     useCases: Array<{ id: "shop"|"track"|"support"|"booking"|"handoff",
 *                       label: string, enabled: boolean, order: number }>,
 *     customItems: Array<{ key: string, label: string, response: string }>,
 *     fallback: "nlp" | "menu"
 *   }
 *
 * Rendering: greeting + numbered list of enabled useCases sorted by `order`,
 * then customItems. A numeric reply selects an entry; unknown input falls back
 * per `fallback` ("nlp" = existing LLM pipeline, "menu" = re-show the menu).
 *
 * The core renderer is plain text; thin formatters adapt it for WhatsApp
 * (free text) and USSD (CON/END prefixes) so both channels share one engine.
 */

export type UseCaseId = "shop" | "track" | "support" | "booking" | "handoff";

export interface WaMenuUseCase {
  id: UseCaseId;
  label: string;
  enabled: boolean;
  order: number;
}

export interface WaMenuCustomItem {
  key: string;
  label: string;
  response: string;
}

export interface WaMenuConfig {
  greeting: string;
  useCases: WaMenuUseCase[];
  customItems: WaMenuCustomItem[];
  fallback: "nlp" | "menu";
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

export const USE_CASE_IDS: readonly UseCaseId[] = ["shop", "track", "support", "booking", "handoff"];

/** Default template used when a tenant has no settings.waMenu configured. */
export function defaultMenuConfig(): WaMenuConfig {
  return {
    greeting: "Hello! Welcome to {businessName}. How can we help you today?",
    useCases: [
      { id: "shop", label: "Shop / place an order", enabled: true, order: 1 },
      { id: "track", label: "Track my order", enabled: true, order: 2 },
      { id: "support", label: "Customer support", enabled: true, order: 3 },
      { id: "booking", label: "Book an appointment", enabled: true, order: 4 },
      { id: "handoff", label: "Talk to a human agent", enabled: true, order: 5 },
    ],
    customItems: [],
    fallback: "nlp",
  };
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

/** Interpolate {businessName} / {openOrders} placeholders. */
function interpolate(template: string, ctx: MenuDynamicCtx): string {
  return template
    .replace(/\{businessName\}/g, ctx.businessName ?? "our store")
    .replace(/\{openOrders\}/g, ctx.openOrdersCount != null ? String(ctx.openOrdersCount) : "0");
}

/**
 * Build the ordered, selectable menu entries: enabled useCases sorted by
 * `order`, followed by customItems, numbered sequentially from 1.
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

/** Core renderer: greeting + numbered list. Channel-agnostic plain text. */
export function renderMenu(config: WaMenuConfig, ctx: MenuDynamicCtx = {}): string {
  const lines: string[] = [interpolate(config.greeting, ctx), ""];
  for (const e of buildMenuEntries(config)) {
    lines.push(`${e.n}. ${interpolate(e.label, ctx)}`);
  }
  return lines.join("\n").trimEnd();
}

/** WhatsApp formatter — core text plus a reply hint. */
export function renderWhatsAppMenu(config: WaMenuConfig, ctx: MenuDynamicCtx = {}): string {
  return `${renderMenu(config, ctx)}\n\nReply with a number to choose an option.`;
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
const MENU_KEYWORDS = new Set(["menu", "hi", "hello", "start", "restart", "help"]);

export function isMenuKeyword(text: string): boolean {
  return MENU_KEYWORDS.has(text.trim().toLowerCase());
}
