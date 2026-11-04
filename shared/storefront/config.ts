/**
 * The design of a store, as data. A template is a starting value of this; the Blank Store is an almost
 * empty one. Nothing here touches products, customers or orders, so switching designs can't harm them.
 *
 * Validated on every save because the public site renders it: links must be relative or https (no
 * javascript:), colours must be plain hex values, and lists are capped.
 */
import { z } from "zod";

const safeHref = z.string().max(500).refine(
  // A bare path like "products?sale=1" is relative to the store. No colon is allowed, so no javascript: links.
  (v) => v === "" || /^\/(?!\/)/.test(v) || /^https:\/\//i.test(v) || /^#[\w-]*$/.test(v) || /^(mailto|tel):/i.test(v) || /^[a-z][a-z0-9/_?=&.-]*$/i.test(v),
  "Links must be a store page, or start with /, https://, mailto: or tel:",
);
const safeImage = z.string().max(1000).refine(
  (v) => v === "" || /^\/(?!\/)/.test(v) || /^https:\/\//i.test(v),
  "Images must be uploaded or start with https://",
);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #1F3A2D");

export const STORE_FONTS = [
  "Cormorant Garamond", "Playfair Display", "Fraunces", "DM Serif Display", "Instrument Serif", "Bodoni Moda", "Lora",
  "Archivo", "Anton", "Bebas Neue", "Space Grotesk", "JetBrains Mono", "DM Sans", "Manrope", "Work Sans", "Poppins",
  "Karla", "Syne", "Outfit", "Nunito",
] as const;
export type StoreFont = (typeof STORE_FONTS)[number];

export const HEADER_VARIANTS = ["classic", "centered", "searchFirst", "minimal", "ticker", "split"] as const;
export const FOOTER_VARIANTS = ["columns", "centered", "wordmark", "bar"] as const;
export const CARD_VARIANTS = ["editorial", "overlay", "boxed", "compact", "tile", "row", "menu", "plain"] as const;
export const GRID_VARIANTS = ["grid", "rail", "lookbook", "list"] as const;
export const HERO_VARIANTS = ["fullBleed", "split", "type", "mosaic", "spotlight", "search", "cover", "stacked"] as const;
export const SECTION_TYPES = [
  "hero", "trust", "categories", "products", "banner", "collections", "about", "testimonials",
  "newsletter", "whatsapp", "text", "gallery",
] as const;
export const PRODUCT_SOURCES = ["all", "featured", "bestSellers", "newArrivals", "onSale", "category", "manual"] as const;

export type SectionType = (typeof SECTION_TYPES)[number];
export type ProductSource = (typeof PRODUCT_SOURCES)[number];

const sectionItem = z.object({
  title: z.string().max(120).default(""),
  text: z.string().max(400).default(""),
  imageUrl: safeImage.default(""),
  href: safeHref.default(""),
});

export const sectionSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(SECTION_TYPES),
  hidden: z.boolean().default(false),
  /** hero: HERO_VARIANTS; other sections: free layout hints read by that section. */
  variant: z.string().max(30).default(""),
  eyebrow: z.string().max(80).default(""),
  title: z.string().max(160).default(""),
  body: z.string().max(1200).default(""),
  imageUrl: safeImage.default(""),
  ctaLabel: z.string().max(40).default(""),
  ctaHref: safeHref.default(""),
  /** products sections */
  source: z.enum(PRODUCT_SOURCES).default("all"),
  category: z.string().max(100).default(""),
  productIds: z.array(z.string().max(36)).max(24).default([]),
  limit: z.number().int().min(1).max(24).default(8),
  columns: z.number().int().min(1).max(6).default(4),
  grid: z.enum(GRID_VARIANTS).default("grid"),
  /** Empty means the store's default card. */
  card: z.enum(CARD_VARIANTS).or(z.literal("")).default(""),
  /** "" follows the page, otherwise this section sits on the accent or a contrasting ground. */
  tone: z.enum(["", "accent", "inverse", "surface"]).default(""),
  align: z.enum(["left", "center", "right"]).default("left"),
  items: z.array(sectionItem).max(12).default([]),
});
export type StoreSection = z.infer<typeof sectionSchema>;

export const storeConfigSchema = z.object({
  version: z.literal(1).default(1),
  templateId: z.string().max(40),
  theme: z.object({
    background: hex,
    surface: hex,
    text: hex,
    muted: hex,
    line: hex,
    accent: hex,
    accentText: hex,
    inverse: hex,
    inverseText: hex,
    sale: hex,
    headingFont: z.enum(STORE_FONTS),
    bodyFont: z.enum(STORE_FONTS),
    headingCase: z.enum(["none", "upper"]).default("none"),
    headingWeight: z.number().int().min(300).max(900).default(600),
    headingTracking: z.number().min(-0.06).max(0.3).default(-0.01),
    /** Corner radius in px for buttons, fields and images. */
    radius: z.number().int().min(0).max(40).default(0),
    /** Page content width in px. */
    width: z.number().int().min(960).max(1800).default(1320),
    /** Vertical space between sections, in px. */
    spacing: z.number().int().min(0).max(160).default(72),
    imageRatio: z.enum(["1/1", "4/5", "3/4", "16/10", "free"]).default("4/5"),
  }),
  logoUrl: safeImage.default(""),
  /** Shown instead of the business name when set, for stores with a shorter trading name. */
  storeName: z.string().max(80).default(""),
  header: z.object({
    variant: z.enum(HEADER_VARIANTS),
    announcement: z.string().max(160).default(""),
    links: z.array(z.object({ label: z.string().max(40), href: safeHref })).max(10).default([]),
    /** Adds the shop's categories to the navigation automatically. */
    showCategories: z.boolean().default(true),
  }),
  footer: z.object({
    variant: z.enum(FOOTER_VARIANTS),
    about: z.string().max(400).default(""),
    columns: z.array(z.object({
      title: z.string().max(40),
      links: z.array(z.object({ label: z.string().max(40), href: safeHref })).max(8),
    })).max(4).default([]),
    legal: z.string().max(200).default(""),
  }),
  product: z.object({
    card: z.enum(CARD_VARIANTS),
    listColumns: z.number().int().min(1).max(6).default(4),
    /** Listing layout: filter bar above the grid, or a sidebar beside it. */
    filters: z.enum(["bar", "sidebar"]).default("bar"),
  }),
  contact: z.object({
    /** Digits with country code, e.g. 2348012345678. Falls back to the shop's connected number. */
    whatsapp: z.string().max(20).regex(/^\d*$/, "Digits only, with the country code").default(""),
    phone: z.string().max(30).default(""),
    email: z.union([z.literal(""), z.string().email().max(320)]).default(""),
    address: z.string().max(300).default(""),
    hours: z.string().max(200).default(""),
    instagram: safeHref.default(""),
    facebook: safeHref.default(""),
    tiktok: safeHref.default(""),
    x: safeHref.default(""),
  }),
  policies: z.object({
    delivery: z.string().max(4000).default(""),
    returns: z.string().max(4000).default(""),
    privacy: z.string().max(4000).default(""),
    terms: z.string().max(4000).default(""),
  }).default({ delivery: "", returns: "", privacy: "", terms: "" }),
  sections: z.array(sectionSchema).max(40),
});
export type StoreConfig = z.infer<typeof storeConfigSchema>;

/** Fills a section's defaults so templates only state what makes them different. */
export function section(type: SectionType, id: string, values: Partial<StoreSection> = {}): StoreSection {
  return sectionSchema.parse({ type, id, ...values });
}

/** Moves one section. Out-of-range moves return the list unchanged. */
export function moveSection<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

/**
 * Applying a template replaces the design only. What the merchant told us about their business
 * (logo, trading name, contact details, policies) carries over.
 */
export function applyTemplate(template: StoreConfig, current: StoreConfig | null | undefined): StoreConfig {
  if (!current) return template;
  return {
    ...template,
    logoUrl: current.logoUrl || template.logoUrl,
    storeName: current.storeName || template.storeName,
    contact: { ...template.contact, ...nonEmpty(current.contact) },
    policies: { ...template.policies, ...nonEmpty(current.policies) },
  };
}

function nonEmpty<T extends Record<string, string>>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v)) as Partial<T>;
}
