/**
 * brandStudio/index.ts — public API for the w9 brand studio.
 *
 *   generateBrandKit     — deterministic monogram + palette + tagline;
 *                          optional AI mark (env-gated, silent fallback);
 *                          best-effort persistence to media_assets + tenant
 *                          branding settings when tenantId is provided.
 *   pushWhatsappProfile  — see waProfile.ts (NEVER throws).
 */
import { generateMonogramLogo, tryGenerateAiLogo } from "./logo";

export * from "./logo";
export * from "./waProfile";
export { pushWhatsappProfile } from "./waProfile";

// ─── Taglines (deterministic templates — LLM polish is upstream's job) ───────

const TAGLINE_BY_INDUSTRY: Array<[RegExp, string]> = [
  [/fashion|cloth|apparel|adire|tailor|wear/i, "Style that fits your story"],
  [/food|restaurant|kitchen|baker|cater|snack|chop/i, "Fresh flavor, one message away"],
  [/grocer|market|provis|supermart/i, "Everyday essentials, delivered easy"],
  [/beaut|salon|hair|spa|cosmetic/i, "Look good, feel confident"],
  [/electronic|phone|gadget|tech|computer/i, "Tech you can trust, priced fair"],
  [/pharma|health|clinic|wellness/i, "Care that comes to you"],
  [/farm|agro|produce/i, "From our farm to your table"],
  [/jewel|accessor|bead/i, "Little pieces, big statements"],
  [/book|station|school|edu/i, "Everything for bright minds"],
  [/auto|car|spare|mechanic/i, "Keeping you on the road"],
  [/furniture|home|decor|interior/i, "Make your space feel like home"],
];

const TAGLINE_FALLBACKS = [
  "Quality you can count on",
  "Great goods, honest prices",
  "Serving you, one chat at a time",
];

/** Deterministic tagline: industry keyword match, else seeded fallback. */
export function buildTagline(industry: string | undefined, businessName: string): string {
  const ind = (industry ?? "").trim();
  if (ind) {
    for (const [re, tagline] of TAGLINE_BY_INDUSTRY) {
      if (re.test(ind)) return tagline;
    }
  }
  // No industry match: pick a fallback deterministically from the name so
  // the same business always gets the same tagline.
  let h = 0;
  for (const ch of (businessName || "shop").normalize("NFC")) {
    h = (Math.imul(h, 31) + (ch.codePointAt(0) ?? 0)) | 0;
  }
  return TAGLINE_FALLBACKS[Math.abs(h) % TAGLINE_FALLBACKS.length];
}

// ─── Brand kit ───────────────────────────────────────────────────────────────

export interface GenerateBrandKitArgs {
  tenantId?: string;
  businessName: string;
  industry?: string;
  vibe?: string;
}

export interface BrandKit {
  logoSvgDataUri: string;
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  tagline: string;
}

/**
 * Generate a complete brand kit. The monogram is always available; when an
 * AI image provider is configured (IMAGE_GEN_API_KEY / OPENAI_API_KEY) a real
 * mark is attempted and any failure falls back to the monogram silently.
 *
 * With tenantId: best-effort persistence — generated assets are stored in
 * media_assets and the tenant's branding settings gain secondaryColor /
 * tagline / logoGeneratedAt (and primaryColor/logoUrl only when not already
 * customized). Persistence failures never fail the kit.
 */
export async function generateBrandKit(args: GenerateBrandKitArgs): Promise<BrandKit> {
  const businessName = (args.businessName ?? "").trim() || "Shop";
  const monogram = generateMonogramLogo(businessName);

  // Opt-in AI mark — silent fallback on any failure.
  const ai = await tryGenerateAiLogo(businessName, args.vibe);
  const logoUrl = ai?.logoUrl ?? null;

  const kit: BrandKit = {
    logoSvgDataUri: monogram.dataUri,
    logoUrl,
    primaryColor: monogram.primaryColor,
    secondaryColor: monogram.secondaryColor,
    tagline: buildTagline(args.industry, businessName),
  };

  if (args.tenantId) {
    await persistBrandKit(args.tenantId, businessName, kit, ai?.bytes ?? null).catch((e: any) => {
      console.warn(`[brandStudio] persistence failed for tenant ${args.tenantId}:`, e?.message);
    });
  }
  return kit;
}

async function persistBrandKit(
  tenantId: string,
  businessName: string,
  kit: BrandKit,
  aiBytes: Buffer | null,
): Promise<void> {
  const { getDb } = await import("../db");
  const db = await getDb();
  if (!db) return;
  const { mediaAssets, tenants } = await import("../../drizzle/schema");
  const { eq } = await import("drizzle-orm");

  const generatedAt = new Date().toISOString();
  const meta = { businessName, primaryColor: kit.primaryColor, secondaryColor: kit.secondaryColor, tagline: kit.tagline };

  // Store the monogram SVG (always) and the AI mark (when bytes came back).
  await db.insert(mediaAssets).values({
    tenantId,
    kind: "logo",
    mime: "image/svg+xml",
    dataUri: kit.logoSvgDataUri,
    meta: { ...meta, source: "monogram" },
  });
  if (aiBytes) {
    await db.insert(mediaAssets).values({
      tenantId,
      kind: "logo",
      mime: "image/png",
      dataUri: `data:image/png;base64,${aiBytes.toString("base64")}`,
      meta: { ...meta, source: "ai" },
    });
  }

  // Merge into tenant branding settings — additive only, never clobber an
  // explicitly customized primaryColor/logoUrl.
  const [row] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) return;
  const settings = ((row.settings ?? {}) as Record<string, any>);
  const branding = ((settings.branding ?? {}) as Record<string, any>);
  const DEFAULT_PRIMARY = "#8A5A2B";
  const primaryCustomized =
    typeof branding.primaryColor === "string" && branding.primaryColor !== DEFAULT_PRIMARY;
  const next = {
    ...settings,
    branding: {
      ...branding, // explicit tenant values always win
      name: branding.name ?? businessName,
      logoUrl: branding.logoUrl ?? kit.logoUrl,
      primaryColor: primaryCustomized ? branding.primaryColor : kit.primaryColor,
      secondaryColor: branding.secondaryColor ?? kit.secondaryColor,
      tagline: branding.tagline ?? kit.tagline,
      logoGeneratedAt: generatedAt,
    },
  };
  await db.update(tenants).set({ settings: next }).where(eq(tenants.id, tenantId));
}
