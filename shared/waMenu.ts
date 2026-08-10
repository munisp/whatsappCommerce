/**
 * shared/waMenu.ts — SHARED WhatsApp menu contract.
 *
 * tenants.settings.waMenu conforms to WaMenuConfig below. The runtime menu
 * renderer and the admin preview (server/services/waMenuPreview.ts) both build
 * on this exact shape — do not deviate:
 *
 *   {
 *     greeting: string,                    // may contain {businessName}
 *     useCases: Array<{ id, label, enabled, order }>,
 *     customItems: Array<{ key, label, response }>,
 *     fallback: "nlp" | "menu"
 *   }
 *
 * Rendered menu = greeting + numbered list of enabled useCases by order
 * + customItems.
 */
import { z } from "zod";

export const WA_USE_CASE_IDS = ["shop", "track", "support", "booking", "handoff", "procurement"] as const;
export type WaUseCaseId = (typeof WA_USE_CASE_IDS)[number];

export interface WaMenuUseCase {
  id: WaUseCaseId;
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

/** Default menu seeded at provisioning: all 6 use cases, shop/track/handoff enabled. */
export const DEFAULT_WA_MENU: WaMenuConfig = {
  greeting: "Welcome to {businessName}! How can we help you today?",
  useCases: [
    { id: "shop", label: "Shop products", enabled: true, order: 1 },
    { id: "track", label: "Track my order", enabled: true, order: 2 },
    { id: "support", label: "Get support", enabled: false, order: 3 },
    { id: "booking", label: "Book an appointment", enabled: false, order: 4 },
    { id: "handoff", label: "Talk to a human", enabled: true, order: 5 },
    { id: "procurement", label: "Restock / Buy supplies", enabled: false, order: 6 },
  ],
  customItems: [],
  fallback: "nlp",
};

// ─── Zod schemas (validation hardening) ──────────────────────────────────────

export const waUseCaseSchema = z.object({
  id: z.enum(WA_USE_CASE_IDS),
  label: z.string().trim().min(1, "use-case label must not be empty").max(60),
  enabled: z.boolean(),
  order: z.number().int().min(1),
});

export const waCustomItemSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, "custom item key must not be empty")
    .max(40)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "key must be lowercase alphanumeric (with - or _)"),
  label: z.string().trim().min(1, "custom item label must not be empty").max(60),
  response: z.string().min(1, "custom item response must not be empty").max(1000),
});

export const waMenuConfigSchema = z
  .object({
    greeting: z.string().min(1, "greeting must not be empty").max(500),
    useCases: z.array(waUseCaseSchema),
    customItems: z.array(waCustomItemSchema).max(20),
    fallback: z.enum(["nlp", "menu"]),
  })
  .superRefine((menu, ctx) => {
    // Every known use case must appear at most once; unknown ids are already
    // rejected by the enum above.
    const seenIds = new Set<string>();
    for (const uc of menu.useCases) {
      if (seenIds.has(uc.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate use-case id "${uc.id}"` });
      }
      seenIds.add(uc.id);
    }
    // Order collisions across use cases are rejected.
    const seenOrders = new Map<number, string>();
    for (const uc of menu.useCases) {
      const existing = seenOrders.get(uc.order);
      if (existing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `order collision: "${existing}" and "${uc.id}" both have order ${uc.order}`,
        });
      }
      seenOrders.set(uc.order, uc.id);
    }
    // Custom item keys must be unique.
    const seenKeys = new Set<string>();
    for (const item of menu.customItems) {
      if (seenKeys.has(item.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate custom item key "${item.key}"` });
      }
      seenKeys.add(item.key);
    }
  });

/** Parse + normalize a waMenu config; throws ZodError on contract violations. */
export function parseWaMenuConfig(input: unknown): WaMenuConfig {
  return waMenuConfigSchema.parse(input) as WaMenuConfig;
}

// ─── Pure renderer (shared by server preview + admin draft preview) ─────────

export interface WaMenuLiveData {
  businessName: string;
  /** in-stock product count (drives "Shop (N items)") */
  shopItemCount?: number;
  /** up to 5 in-stock product names shown under the shop entry */
  topProducts?: string[];
  /** count of open (not delivered/cancelled) orders */
  openOrderCount?: number;
}

/**
 * Pure renderer — no I/O. Must stay in sync with the runtime menu renderer:
 * greeting + numbered list of enabled useCases (sorted by order) + numbered
 * customItems.
 */
export function renderWaMenu(menu: WaMenuConfig, data: WaMenuLiveData): string {
  const lines: string[] = [];
  lines.push(menu.greeting.replaceAll("{businessName}", data.businessName));
  lines.push("");

  let n = 0;
  const enabled = [...menu.useCases].filter((u) => u.enabled).sort((a, b) => a.order - b.order);
  for (const uc of enabled) {
    n += 1;
    let label = uc.label;
    if (uc.id === "shop" && typeof data.shopItemCount === "number") {
      label = `${label} (${data.shopItemCount} items)`;
    }
    if (uc.id === "track" && typeof data.openOrderCount === "number") {
      label = `${label} (${data.openOrderCount} open)`;
    }
    lines.push(`${n}. ${label}`);
    if (uc.id === "shop" && data.topProducts && data.topProducts.length > 0) {
      for (const name of data.topProducts.slice(0, 5)) {
        lines.push(`   • ${name}`);
      }
    }
  }
  for (const item of menu.customItems) {
    n += 1;
    lines.push(`${n}. ${item.label}`);
  }
  return lines.join("\n");
}

// ─── Draft editing helpers (pure; used by the admin menu builder) ───────────

/** Use cases sorted by order (stable for ties). */
export function sortUseCasesByOrder(useCases: WaMenuUseCase[]): WaMenuUseCase[] {
  return [...useCases].sort((a, b) => a.order - b.order);
}

/** Rewrite order values to 1..N following the current sort. */
export function renumberUseCases(useCases: WaMenuUseCase[]): WaMenuUseCase[] {
  return sortUseCasesByOrder(useCases).map((u, i) => ({ ...u, order: i + 1 }));
}

/** Move a use case one slot up/down in display order; renumbers 1..N. */
export function moveUseCase(
  useCases: WaMenuUseCase[],
  id: WaUseCaseId,
  direction: "up" | "down",
): WaMenuUseCase[] {
  const sorted = sortUseCasesByOrder(useCases);
  const idx = sorted.findIndex((u) => u.id === id);
  if (idx < 0) return sorted;
  const target = direction === "up" ? idx - 1 : idx + 1;
  if (target < 0 || target >= sorted.length) return sorted;
  [sorted[idx], sorted[target]] = [sorted[target], sorted[idx]];
  return sorted.map((u, i) => ({ ...u, order: i + 1 }));
}

/** Structural check without throwing. */
export function isWaMenuConfig(input: unknown): input is WaMenuConfig {
  return waMenuConfigSchema.safeParse(input).success;
}
