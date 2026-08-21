/**
 * server/services/catalogAI.ts — W27 catalog-ai
 * ─────────────────────────────────────────────────────────────────────────────
 * Merchant voice-note→listing and photo→listing pipeline.
 *
 * Flow (both sources):
 *   1. Merchant (tenant staff phone) sends a WhatsApp voice note describing a
 *      product, or a product photo.
 *   2. Voice: audio is transcribed via the pluggable STT adapter
 *      (OpenAI-whisper-compatible; wraps services/transcribe.ts). A structured
 *      listing {name, description, category, priceCents?} is extracted via LLM.
 *      Photo: the vision adapter (invokeLLM image_url, same seam as
 *      receiptVision.ts) returns {title, description, category, priceBand?}.
 *   3. A deterministic price suggestion (integer cents) is computed from
 *      in-tenant comparable products, falling back to platform-wide stats.
 *   4. A `catalog_ai_drafts` row (status pending_confirm) is created and the
 *      merchant gets interactive buttons: ✅ Publish / ✏️ Portal edit / ❌ Reject.
 *   5. Confirm publishes the product into the catalog; reject archives it.
 *
 * Tests/simulation use deterministic mocks: Whisper is scripted via metaMock
 * (world.openai.transcripts) and the LLM/vision calls via world.llm.when —
 * no live API calls.
 */

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  catalogAiDraftEvents,
  catalogAiDrafts,
  products,
  tenantMemberships,
  users,
  type CatalogAiDraft,
} from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

// ── Adapters ─────────────────────────────────────────────────────────────────

/** Provider-agnostic speech-to-text adapter. Never throws. */
export interface SttAdapter {
  transcribe(opts: {
    audio: Buffer;
    mimeType?: string | null;
    languageHint?: string | null;
  }): Promise<{ text: string | null; error?: string }>;
}

/** OpenAI-whisper-compatible STT adapter (delegates to services/transcribe.ts). */
export const whisperSttAdapter: SttAdapter = {
  async transcribe(opts) {
    const { transcribeAudio } = await import("./transcribe");
    return transcribeAudio(opts);
  },
};

/** Deterministic mock STT adapter for unit tests (no network). */
export function mockSttAdapter(script: Array<string | null>): SttAdapter {
  const queue = [...script];
  return {
    async transcribe() {
      const text = queue.length > 0 ? queue.shift()! : null;
      return text ? { text } : { text: null, error: "mock_empty" };
    },
  };
}

export interface PhotoAnalysis {
  title: string;
  description: string;
  category: string;
  /** Model's own price guess in integer cents, when it can make one. */
  priceCents?: number | null;
  confidence: number;
}

/** Provider-agnostic product-photo vision adapter. Throws on failure. */
export interface VisionAdapter {
  analyzeProductPhoto(opts: {
    imageBase64: string;
    mimeType: "image/jpeg" | "image/png" | "image/webp";
  }): Promise<PhotoAnalysis>;
}

/** Default vision adapter — invokeLLM with a strict JSON schema (same seam as
 *  receiptVision.ts, so the simulation LLM mock intercepts it). */
export const llmVisionAdapter: VisionAdapter = {
  async analyzeProductPhoto(opts) {
    const { invokeLLM } = await import("../_core/llm");
    const dataUrl = `data:${opts.mimeType};base64,${opts.imageBase64}`;
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You are a product catalog assistant for informal-retail merchants. " +
            "Given a product photo, write a concise sellable listing. Always respond with valid JSON only.",
        },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
            {
              type: "text",
              text: `Analyse this product photo and respond with JSON in this exact format:
{
  "title": "short product title (max 80 chars)",
  "description": "1-3 sentence sellable description",
  "category": "one of: groceries, beverages, snacks, household, personal_care, electronics, fashion, agro, pharmacy, other",
  "priceCents": integer price guess in cents (minor currency units) or null,
  "confidence": 0-100
}`,
            },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "product_photo_analysis",
          strict: true,
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              category: { type: "string" },
              priceCents: { type: ["integer", "null"] },
              confidence: { type: "integer" },
            },
            required: ["title", "description", "category", "priceCents", "confidence"],
            additionalProperties: false,
          },
        },
      } as any,
    });
    const raw = response.choices?.[0]?.message?.content;
    const text = typeof raw === "string" ? raw : "";
    const parsed = JSON.parse(text);
    return {
      title: String(parsed.title ?? "").slice(0, 255),
      description: String(parsed.description ?? ""),
      category: String(parsed.category ?? "other").slice(0, 100),
      priceCents: Number.isInteger(parsed.priceCents) ? parsed.priceCents : null,
      confidence: Number(parsed.confidence ?? 0),
    };
  },
};

/** Deterministic mock vision adapter for unit tests. */
export function mockVisionAdapter(result: PhotoAnalysis): VisionAdapter {
  return { async analyzeProductPhoto() { return result; } };
}

// ── Listing extraction (voice transcript → structured listing) ───────────────

export interface ExtractedListing {
  name: string;
  description: string;
  category: string;
  /** Merchant-stated price in integer cents, when mentioned. */
  priceCents: number | null;
}

/** Parse/normalize an LLM extraction payload (exported for unit tests). */
export function normalizeExtraction(parsed: any): ExtractedListing {
  return {
    name: String(parsed?.name ?? "").trim().slice(0, 255),
    description: String(parsed?.description ?? "").trim(),
    category: String(parsed?.category ?? "other").trim().slice(0, 100) || "other",
    priceCents: Number.isInteger(parsed?.priceCents) && parsed.priceCents >= 0 ? parsed.priceCents : null,
  };
}

/** Extract a structured listing from a transcript via LLM. Throws on failure. */
export async function extractListingFromTranscript(transcript: string): Promise<ExtractedListing> {
  const { invokeLLM } = await import("../_core/llm");
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content:
          "You convert a merchant's voice-note transcript into a structured product listing. " +
          "Prices must be integer cents (minor currency units, e.g. ₦25.00 → 2500). " +
          "If no price is mentioned, use null. Always respond with valid JSON only.",
      },
      {
        role: "user",
        content: `Transcript: """${transcript}"""
Respond with JSON in this exact format:
{
  "name": "short product name",
  "description": "1-3 sentence description",
  "category": "one of: groceries, beverages, snacks, household, personal_care, electronics, fashion, agro, pharmacy, other",
  "priceCents": integer cents or null
}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "catalog_listing_extraction",
        strict: true,
        schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            category: { type: "string" },
            priceCents: { type: ["integer", "null"] },
          },
          required: ["name", "description", "category", "priceCents"],
          additionalProperties: false,
        },
      },
    } as any,
  });
  const raw = response.choices?.[0]?.message?.content;
  return normalizeExtraction(JSON.parse(typeof raw === "string" ? raw : ""));
}

// ── Deterministic price suggestion (integer cents) ───────────────────────────

/** Median of integer cents values; null when empty. Deterministic. */
export function medianCents(values: number[]): number | null {
  const clean = values.filter((v) => Number.isInteger(v) && v >= 0).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  if (clean.length % 2 === 1) return clean[mid];
  // Even count: integer average of the two middle values (rounded down).
  return Math.floor((clean[mid - 1] + clean[mid]) / 2);
}

export interface PriceSuggestion {
  suggestedPriceCents: number | null;
  bandLowCents: number | null;
  bandHighCents: number | null;
  basis: "tenant_category" | "tenant_all" | "platform_category" | "none";
  sampleSize: number;
}

/** Compute a price band [p25, p75] around a median (integer cents). */
export function priceBand(values: number[]): { low: number; high: number } | null {
  const clean = values.filter((v) => Number.isInteger(v) && v >= 0).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const q = (p: number) => clean[Math.min(clean.length - 1, Math.floor(p * clean.length))];
  return { low: q(0.25), high: q(0.75) };
}

async function productPricesCents(
  db: Db,
  where: ReturnType<typeof and>,
): Promise<number[]> {
  const rows = await db
    .select({ price: products.price })
    .from(products)
    .where(where)
    .limit(500)
    .catch(() => [] as Array<{ price: string }>);
  return rows
    .map((r) => Math.round(parseFloat(String(r.price)) * 100))
    .filter((v) => Number.isInteger(v) && v > 0);
}

/**
 * Deterministic heuristic price suggestion:
 *   1. median of the tenant's own active products in the same category;
 *   2. median of all the tenant's active products;
 *   3. platform-wide median for the category.
 * All integer cents. No randomness.
 */
export async function suggestPriceCents(
  db: Db,
  tenantId: string,
  category: string | null | undefined,
): Promise<PriceSuggestion> {
  const cat = (category ?? "").trim();
  if (cat) {
    const vals = await productPricesCents(db, and(
      eq(products.tenantId, tenantId),
      eq(products.category, cat),
      eq(products.status, "active"),
    ));
    const med = medianCents(vals);
    if (med != null) {
      const band = priceBand(vals)!;
      return { suggestedPriceCents: med, bandLowCents: band.low, bandHighCents: band.high, basis: "tenant_category", sampleSize: vals.length };
    }
  }
  {
    const vals = await productPricesCents(db, and(
      eq(products.tenantId, tenantId),
      eq(products.status, "active"),
    ));
    const med = medianCents(vals);
    if (med != null) {
      const band = priceBand(vals)!;
      return { suggestedPriceCents: med, bandLowCents: band.low, bandHighCents: band.high, basis: "tenant_all", sampleSize: vals.length };
    }
  }
  if (cat) {
    const vals = await productPricesCents(db, and(
      eq(products.category, cat),
      eq(products.status, "active"),
    ));
    const med = medianCents(vals);
    if (med != null) {
      const band = priceBand(vals)!;
      return { suggestedPriceCents: med, bandLowCents: band.low, bandHighCents: band.high, basis: "platform_category", sampleSize: vals.length };
    }
  }
  return { suggestedPriceCents: null, bandLowCents: null, bandHighCents: null, basis: "none", sampleSize: 0 };
}

// ── Merchant detection ───────────────────────────────────────────────────────

/** True when the WhatsApp sender is a staff member (owner/operator) of the tenant. */
export async function isTenantStaffPhone(db: Db, tenantId: string, phone: string): Promise<boolean> {
  const byHome = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.phone, phone), eq(users.tenantId, tenantId)))
    .limit(1)
    .catch(() => []);
  if (byHome.length > 0) return true;
  const rows = await db
    .select({ id: tenantMemberships.id })
    .from(tenantMemberships)
    .innerJoin(users, sql`${users.id}::text = ${tenantMemberships.userId}`)
    .where(and(eq(tenantMemberships.tenantId, tenantId), eq(users.phone, phone)))
    .limit(1)
    .catch(() => []);
  return rows.length > 0;
}

// ── Draft lifecycle ──────────────────────────────────────────────────────────

async function recordEvent(
  db: Db,
  draftId: string,
  tenantId: string,
  event: string,
  actor?: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.insert(catalogAiDraftEvents).values({
    draftId, tenantId, event, actor: actor ?? null, detail: detail ?? null,
  }).catch((e: any) => console.warn("[catalogAI] event insert failed:", e?.message));
}

export async function createDraft(
  db: Db,
  input: {
    tenantId: string;
    source: "voice" | "photo";
    merchantPhone: string;
    transcript?: string | null;
    mediaId?: string | null;
    listing: { name: string; description: string; category: string; priceCents?: number | null };
    currency?: string;
    rawExtraction?: Record<string, unknown>;
  },
): Promise<CatalogAiDraft> {
  const suggestion = await suggestPriceCents(db, input.tenantId, input.listing.category);
  const priceCents = input.listing.priceCents ?? suggestion.suggestedPriceCents;
  const [tenant] = await db
    .select({ defaultCurrency: (await import("../../drizzle/schema")).tenants.defaultCurrency })
    .from((await import("../../drizzle/schema")).tenants)
    .where(eq((await import("../../drizzle/schema")).tenants.id, input.tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  const [draft] = await db.insert(catalogAiDrafts).values({
    tenantId: input.tenantId,
    source: input.source,
    merchantPhone: input.merchantPhone,
    transcript: input.transcript ?? null,
    mediaId: input.mediaId ?? null,
    name: input.listing.name,
    description: input.listing.description,
    category: input.listing.category,
    suggestedPriceCents: priceCents,
    priceBandLowCents: suggestion.bandLowCents,
    priceBandHighCents: suggestion.bandHighCents,
    currency: input.currency ?? (tenant as any)?.defaultCurrency ?? "NGN",
    rawExtraction: input.rawExtraction ?? null,
  }).returning();
  await recordEvent(db, draft.id, input.tenantId, "created", input.merchantPhone, {
    source: input.source,
    priceBasis: suggestion.basis,
  });
  return draft;
}

export function centsToDecimal(priceCents: number): string {
  return (priceCents / 100).toFixed(2);
}

/** Publish a draft into the products catalog. Idempotent per draft. */
export async function publishDraft(
  db: Db,
  draftId: string,
  actor: string,
  overrides?: { name?: string; description?: string; category?: string; priceCents?: number },
): Promise<{ ok: boolean; productId?: string; error?: string }> {
  const [draft] = await db.select().from(catalogAiDrafts).where(eq(catalogAiDrafts.id, draftId)).limit(1);
  if (!draft) return { ok: false, error: "not_found" };
  if (draft.status === "published" && draft.productId) return { ok: true, productId: draft.productId };
  if (draft.status === "rejected" || draft.status === "expired") return { ok: false, error: `status_${draft.status}` };

  const name = (overrides?.name ?? draft.name ?? "").trim();
  if (!name) return { ok: false, error: "missing_name" };
  const priceCents = overrides?.priceCents ?? draft.suggestedPriceCents;
  if (priceCents == null || !Number.isInteger(priceCents) || priceCents < 0) {
    return { ok: false, error: "missing_price" };
  }
  const description = overrides?.description ?? draft.description ?? null;
  const category = overrides?.category ?? draft.category ?? null;

  const productId = `ai-${draft.id.slice(0, 8)}`;
  await db.insert(products).values({
    id: productId,
    tenantId: draft.tenantId,
    sku: `AI-${draft.id.slice(0, 13).toUpperCase()}`,
    name,
    description,
    category,
    price: centsToDecimal(priceCents),
    currency: draft.currency,
    status: "active",
    stockQuantity: 0,
    metadata: { source: "catalog_ai", draftId: draft.id, aiSource: draft.source },
  }).onConflictDoNothing();

  await db.update(catalogAiDrafts).set({
    status: "published",
    productId,
    name,
    description,
    category,
    suggestedPriceCents: priceCents,
    confirmedAt: draft.confirmedAt ?? new Date(),
    publishedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(catalogAiDrafts.id, draftId));
  await recordEvent(db, draftId, draft.tenantId, "published", actor, { productId, priceCents });
  return { ok: true, productId };
}

export async function rejectDraft(db: Db, draftId: string, actor: string): Promise<{ ok: boolean; error?: string }> {
  const [draft] = await db.select().from(catalogAiDrafts).where(eq(catalogAiDrafts.id, draftId)).limit(1);
  if (!draft) return { ok: false, error: "not_found" };
  if (draft.status === "published") return { ok: false, error: "already_published" };
  if (draft.status !== "rejected") {
    await db.update(catalogAiDrafts).set({ status: "rejected", updatedAt: new Date() })
      .where(eq(catalogAiDrafts.id, draftId));
    await recordEvent(db, draftId, draft.tenantId, "rejected", actor);
  }
  return { ok: true };
}

export async function editDraft(
  db: Db,
  draftId: string,
  actor: string,
  patch: { name?: string; description?: string; category?: string; priceCents?: number | null },
): Promise<{ ok: boolean; error?: string }> {
  const [draft] = await db.select().from(catalogAiDrafts).where(eq(catalogAiDrafts.id, draftId)).limit(1);
  if (!draft) return { ok: false, error: "not_found" };
  if (draft.status === "published" || draft.status === "rejected") return { ok: false, error: `status_${draft.status}` };
  await db.update(catalogAiDrafts).set({
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.category !== undefined ? { category: patch.category } : {}),
    ...(patch.priceCents !== undefined ? { suggestedPriceCents: patch.priceCents } : {}),
    updatedAt: new Date(),
  }).where(eq(catalogAiDrafts.id, draftId));
  await recordEvent(db, draftId, draft.tenantId, "edited", actor, patch as Record<string, unknown>);
  return { ok: true };
}

// ── WhatsApp interactive button ids ──────────────────────────────────────────

export const CATALOG_AI_BUTTON_PREFIX = "catalog_ai:";

export function buildDraftButtonId(action: "publish" | "reject", draftId: string): string {
  return `${CATALOG_AI_BUTTON_PREFIX}${action}:${draftId}`;
}

export function parseDraftButtonId(id: string): { action: "publish" | "reject"; draftId: string } | null {
  if (!id.startsWith(CATALOG_AI_BUTTON_PREFIX)) return null;
  const rest = id.slice(CATALOG_AI_BUTTON_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const action = rest.slice(0, sep);
  const draftId = rest.slice(sep + 1);
  if ((action !== "publish" && action !== "reject") || !draftId) return null;
  return { action, draftId };
}

function formatMoney(cents: number | null, currency: string): string {
  if (cents == null) return "—";
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

/** Draft summary + confirm/reject buttons payload for the merchant. */
export function buildDraftInteractive(draft: CatalogAiDraft) {
  const lines = [
    `🤖 *AI draft listing* (${draft.source === "voice" ? "voice note" : "photo"})`,
    ``,
    `*${draft.name ?? "Untitled"}*`,
    draft.description ?? "",
    `Category: ${draft.category ?? "other"}`,
    `Suggested price: ${formatMoney(draft.suggestedPriceCents, draft.currency)}`,
  ];
  if (draft.priceBandLowCents != null && draft.priceBandHighCents != null) {
    lines.push(`Typical range: ${formatMoney(draft.priceBandLowCents, draft.currency)} – ${formatMoney(draft.priceBandHighCents, draft.currency)}`);
  }
  lines.push(``, `Tap ✅ to publish to your catalog, or ❌ to discard. You can edit it in the tenant portal.`);
  return {
    bodyText: lines.join("\n"),
    action: {
      type: "button" as const,
      buttons: [
        { id: buildDraftButtonId("publish", draft.id), title: "✅ Publish" },
        { id: buildDraftButtonId("reject", draft.id), title: "❌ Reject" },
      ],
    },
  };
}

// ── Media download (Graph API, per-tenant credentials) ───────────────────────

async function downloadWaMedia(
  tenantId: string,
  mediaId: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const { resolveTenantWaCredentials } = await import("./waSender");
  const creds = await resolveTenantWaCredentials(tenantId);
  if (!creds) return null;
  const meta = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(12000),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const url = meta?.url;
  if (!url) return null;
  const bin = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(30000),
  }).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  if (!bin) return null;
  return {
    buffer: Buffer.from(bin),
    mimeType: typeof meta?.mime_type === "string" ? meta.mime_type : "application/octet-stream",
  };
}

// ── Inbound orchestration ────────────────────────────────────────────────────

export interface CatalogAiOutcome {
  handled: boolean;
  outcome:
    | "not_merchant"
    | "disabled"
    | "no_credentials"
    | "download_failed"
    | "transcribe_failed"
    | "extract_failed"
    | "vision_failed"
    | "draft_created";
  draftId?: string;
}

async function sendDraftToMerchant(tenantId: string, phone: string, draft: CatalogAiDraft): Promise<void> {
  const { sendWhatsAppInteractive, sendWhatsAppText } = await import("./waSender");
  try {
    await sendWhatsAppInteractive(tenantId, phone, buildDraftInteractive(draft));
  } catch {
    await sendWhatsAppText(tenantId, phone,
      `🤖 AI draft: *${draft.name}* — ${formatMoney(draft.suggestedPriceCents, draft.currency)}. ` +
      `Reply "PUBLISH ${draft.id.slice(0, 8)}" to publish or "REJECT ${draft.id.slice(0, 8)}" to discard.`,
    ).catch(() => undefined);
  }
}

/**
 * Merchant voice note → draft listing. Returns not_merchant so the caller can
 * fall through to the buyer voice pipeline. Never throws.
 */
export async function handleInboundCatalogVoiceNote(opts: {
  tenantId: string;
  waPhoneNumber: string;
  mediaId: string;
  mimeType?: string | null;
  languageHint?: string | null;
  stt?: SttAdapter;
}): Promise<CatalogAiOutcome> {
  const { tenantId, waPhoneNumber } = opts;
  try {
    const db = await getDb();
    if (!db) return { handled: false, outcome: "not_merchant" };
    if (process.env.CATALOG_AI_ENABLED === "false") return { handled: false, outcome: "disabled" };
    if (!(await isTenantStaffPhone(db, tenantId, waPhoneNumber))) {
      return { handled: false, outcome: "not_merchant" };
    }
    const downloaded = await downloadWaMedia(tenantId, opts.mediaId);
    if (!downloaded) return { handled: true, outcome: "download_failed" };
    const stt = opts.stt ?? whisperSttAdapter;
    const t = await stt.transcribe({
      audio: downloaded.buffer,
      mimeType: opts.mimeType ?? downloaded.mimeType,
      languageHint: opts.languageHint ?? null,
    });
    if (!t.text) return { handled: true, outcome: "transcribe_failed" };
    let listing: ExtractedListing;
    try {
      listing = await extractListingFromTranscript(t.text);
    } catch (e: any) {
      console.warn("[catalogAI] extraction failed:", e?.message);
      return { handled: true, outcome: "extract_failed" };
    }
    if (!listing.name) return { handled: true, outcome: "extract_failed" };
    const draft = await createDraft(db, {
      tenantId,
      source: "voice",
      merchantPhone: waPhoneNumber,
      transcript: t.text,
      mediaId: opts.mediaId,
      listing,
      rawExtraction: { ...listing },
    });
    await sendDraftToMerchant(tenantId, waPhoneNumber, draft);
    return { handled: true, outcome: "draft_created", draftId: draft.id };
  } catch (e: any) {
    console.error("[catalogAI] voice note error:", e?.message);
    return { handled: false, outcome: "not_merchant" };
  }
}

/** Merchant product photo → draft listing. Same contract as the voice variant. */
export async function handleInboundCatalogProductPhoto(opts: {
  tenantId: string;
  waPhoneNumber: string;
  mediaId: string;
  vision?: VisionAdapter;
}): Promise<CatalogAiOutcome> {
  const { tenantId, waPhoneNumber } = opts;
  try {
    const db = await getDb();
    if (!db) return { handled: false, outcome: "not_merchant" };
    if (process.env.CATALOG_AI_ENABLED === "false") return { handled: false, outcome: "disabled" };
    if (!(await isTenantStaffPhone(db, tenantId, waPhoneNumber))) {
      return { handled: false, outcome: "not_merchant" };
    }
    const downloaded = await downloadWaMedia(tenantId, opts.mediaId);
    if (!downloaded) return { handled: true, outcome: "download_failed" };
    const mime = (["image/jpeg", "image/png", "image/webp"].includes(downloaded.mimeType)
      ? downloaded.mimeType
      : "image/jpeg") as "image/jpeg" | "image/png" | "image/webp";
    const vision = opts.vision ?? llmVisionAdapter;
    let analysis: PhotoAnalysis;
    try {
      analysis = await vision.analyzeProductPhoto({ imageBase64: downloaded.buffer.toString("base64"), mimeType: mime });
    } catch (e: any) {
      console.warn("[catalogAI] vision failed:", e?.message);
      return { handled: true, outcome: "vision_failed" };
    }
    if (!analysis.title) return { handled: true, outcome: "vision_failed" };
    const draft = await createDraft(db, {
      tenantId,
      source: "photo",
      merchantPhone: waPhoneNumber,
      mediaId: opts.mediaId,
      listing: {
        name: analysis.title,
        description: analysis.description,
        category: analysis.category,
        priceCents: analysis.priceCents ?? null,
      },
      rawExtraction: { ...analysis },
    });
    await sendDraftToMerchant(tenantId, waPhoneNumber, draft);
    return { handled: true, outcome: "draft_created", draftId: draft.id };
  } catch (e: any) {
    console.error("[catalogAI] product photo error:", e?.message);
    return { handled: false, outcome: "not_merchant" };
  }
}

/**
 * Handle a catalog-draft interactive button reply (catalog_ai:publish:<id> /
 * catalog_ai:reject:<id>). Tenant ownership is enforced by matching the
 * draft's tenantId to the channel tenant. Returns null when the id is not a
 * catalog-draft button (caller falls through to other dispatch).
 */
export async function handleCatalogDraftButton(opts: {
  tenantId: string;
  phone: string;
  replyId: string;
}): Promise<{ reply: string } | null> {
  const parsed = parseDraftButtonId(opts.replyId ?? "");
  if (!parsed) return null;
  const db = await getDb();
  if (!db) return { reply: "Service unavailable — please try again shortly." };
  const [draft] = await db.select().from(catalogAiDrafts).where(eq(catalogAiDrafts.id, parsed.draftId)).limit(1);
  if (!draft || draft.tenantId !== opts.tenantId) return { reply: "That listing draft was not found." };
  if (parsed.action === "reject") {
    const res = await rejectDraft(db, draft.id, opts.phone);
    return { reply: res.ok ? `🗑️ Draft "${draft.name ?? "listing"}" discarded.` : `Could not discard that draft (${res.error}).` };
  }
  const res = await publishDraft(db, draft.id, opts.phone);
  if (!res.ok) {
    return {
      reply: res.error === "missing_price"
        ? `This draft has no price yet — edit it in the tenant portal before publishing.`
        : `Could not publish that draft (${res.error}).`,
    };
  }
  return {
    reply: `✅ "${draft.name ?? "Listing"}" is now live in your catalog at ${formatMoney(draft.suggestedPriceCents, draft.currency)}.`,
  };
}

/** Text fallback: "PUBLISH abc12345" / "REJECT abc12345" (id prefix). */
export async function handleCatalogDraftTextCommand(opts: {
  tenantId: string;
  phone: string;
  text: string;
}): Promise<{ handled: boolean; reply?: string }> {
  const m = /^\s*(publish|reject)\s+([0-9a-f]{8})\s*$/i.exec(opts.text ?? "");
  if (!m) return { handled: false };
  const db = await getDb();
  if (!db) return { handled: false };
  const rows = await db.select().from(catalogAiDrafts)
    .where(and(eq(catalogAiDrafts.tenantId, opts.tenantId), eq(catalogAiDrafts.merchantPhone, opts.phone)))
    .orderBy(desc(catalogAiDrafts.createdAt)).limit(20).catch(() => [] as CatalogAiDraft[]);
  const draft = rows.find((d) => d.id.startsWith(m[2].toLowerCase()));
  if (!draft) return { handled: true, reply: "No matching listing draft found." };
  return handleCatalogDraftButton({
    tenantId: opts.tenantId,
    phone: opts.phone,
    replyId: buildDraftButtonId(m[1].toLowerCase() as "publish" | "reject", draft.id),
  }).then((r) => ({ handled: true, reply: r?.reply }));
}
