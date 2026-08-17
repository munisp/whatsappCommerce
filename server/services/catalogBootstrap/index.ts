/**
 * catalogBootstrap (W15, roadmap F5) — price-list-photo → catalog bootstrap.
 *
 * A merchant photographs a handwritten/printed price list during onboarding;
 * the extraction adapter turns it into draft catalog items; the merchant
 * reviews and confirms; confirmed items become real `products` rows.
 *
 * Frozen seam (C1/C3 integrate against these signatures):
 *   bootstrapCatalogFromImage(ctx) → { ok:true, draftId, items } | { ok:false, error }
 *   confirmCatalogDraft({tenantId, draftId, approveItemIds?, edits?})
 *   getCatalogDraft({tenantId, draftId})
 *
 * Draft persistence: tenants.settings.catalogDrafts jsonb (no migration).
 * Extraction is env-gated (disabled by default) — see extraction.ts.
 */

import { nanoid } from "nanoid";
import {
  getExtractionAdapter,
  extractionProvider,
  type ExtractionDeps,
  type RawExtractedItem,
} from "./extraction";
import {
  cleanName,
  normalizeNameKey,
  parsePriceText,
  scoreConfidence,
  DEFAULT_CURRENCY,
} from "./parse";
import {
  makeDefaultStore,
  applyExpiry,
  type CatalogDraftStore,
  type StoredCatalogDraft,
  type StoredCatalogItem,
} from "./store";

export * from "./extraction";
export * from "./parse";
export * from "./store";

// ── Frozen types ────────────────────────────────────────────────────────────

export interface DraftCatalogItem {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  sku?: string;
  unit?: string;
  confidence: number;
  rawText?: string;
}

export type BootstrapResult =
  | {
      ok: true;
      draftId: string;
      items: DraftCatalogItem[];
      /** W15.1: true when the extraction exceeded MAX_DRAFT_ITEMS and was capped. */
      truncated?: boolean;
    }
  | { ok: false; error: string };

export type ConfirmResult =
  | {
      ok: true;
      draftId: string;
      productIds: string[];
      alreadyConfirmed?: boolean;
      skippedDuplicates?: string[]; // item ids skipped (already in catalog)
    }
  | { ok: false; error: string };

export type GetDraftResult =
  | { ok: true; draft: StoredCatalogDraft }
  | { ok: false; error: string };

export interface CatalogBootstrapDeps extends ExtractionDeps {
  store?: CatalogDraftStore;
  now?: () => Date;
}

export const DRAFT_TTL_MS = 72 * 60 * 60 * 1000; // 72h review window

/** W15.1: hard cap on parsed extraction items per draft (abuse/size guard). */
export const MAX_DRAFT_ITEMS = 500;

/** W15.1: shared price bound (cents) — matches the extraction-time guard. */
export const MAX_PRICE_CENTS = 1_000_000_000;

// ── Normalization ───────────────────────────────────────────────────────────

function normalizeRawItems(
  raw: RawExtractedItem[],
  currencyDefault: string,
): DraftCatalogItem[] {
  const out: DraftCatalogItem[] = [];
  const seen = new Map<string, number>(); // nameKey → index in out
  for (const r of raw) {
    const name = cleanName(r?.name);
    if (!name) continue;
    // priceCents (trusted numeric) wins; otherwise parse the price text.
    let priceCents: number | null = null;
    let currency = currencyDefault;
    let unit: string | undefined;
    let fromRange = false;
    if (typeof r?.priceCents === "number" && Number.isFinite(r.priceCents) && r.priceCents >= 50 && r.priceCents <= MAX_PRICE_CENTS) {
      priceCents = Math.round(r.priceCents);
      if (typeof r.currency === "string" && /^[A-Z]{3}$/i.test(r.currency)) currency = r.currency.toUpperCase();
    } else {
      const parsed = parsePriceText(r?.price ?? r?.rawText, currencyDefault);
      if (!parsed) continue;
      priceCents = parsed.priceCents;
      currency = parsed.currency;
      unit = parsed.unit;
      fromRange = parsed.fromRange === true;
    }
    if (typeof r?.unit === "string" && r.unit.trim()) unit = r.unit.trim().toLowerCase();
    const sku = typeof r?.sku === "string" && r.sku.trim() ? r.sku.trim().slice(0, 100) : undefined;
    const rawText = typeof r?.rawText === "string" ? r.rawText.slice(0, 500) : undefined;
    const upstreamConfidence =
      typeof r?.confidence === "number" && Number.isFinite(r.confidence)
        ? Math.max(0, Math.min(1, r.confidence))
        : undefined;
    const confidence = scoreConfidence({ name, priceCents, currency, sku, unit, fromRange, upstreamConfidence });
    const item: DraftCatalogItem = { id: `ci_${nanoid(12)}`, name, priceCents, currency, confidence };
    if (sku) item.sku = sku;
    if (unit) item.unit = unit;
    if (rawText) item.rawText = rawText;

    // Within-extraction dedupe: same normalized name → keep higher confidence.
    const key = normalizeNameKey(name);
    const prevIdx = seen.get(key);
    if (prevIdx !== undefined) {
      if (out[prevIdx].confidence < item.confidence) out[prevIdx] = item;
      continue;
    }
    seen.set(key, out.length);
    out.push(item);
  }
  return out;
}

// ── Seam: bootstrap ─────────────────────────────────────────────────────────

export async function bootstrapCatalogFromImage(
  ctx: { tenantId: string; imageUrl?: string; imageBase64?: string; mimeType?: string; currency?: string },
  deps: CatalogBootstrapDeps = {},
): Promise<BootstrapResult> {
  if (!ctx?.tenantId) return { ok: false, error: "tenant_required" };
  if (!ctx.imageUrl && !ctx.imageBase64) return { ok: false, error: "image_required" };
  if (extractionProvider(deps.env) === "disabled") return { ok: false, error: "extraction_disabled" };

  const adapter = getExtractionAdapter(deps);
  const currencyDefault = (ctx.currency ?? DEFAULT_CURRENCY).toUpperCase();
  let extracted;
  try {
    extracted = await adapter.extract({
      tenantId: ctx.tenantId,
      imageUrl: ctx.imageUrl,
      imageBase64: ctx.imageBase64,
      mimeType: ctx.mimeType,
      hints: { currency: currencyDefault },
    });
  } catch (e) {
    const msg = (e as Error)?.message ?? "extraction_failed";
    return { ok: false, error: msg === "extraction_disabled" ? msg : "extraction_failed" };
  }

  const store = deps.store ?? makeDefaultStore();
  const normalized = normalizeRawItems(extracted.items ?? [], currencyDefault);
  if (normalized.length === 0) return { ok: false, error: "no_items_extracted" };
  // W15.1: cap runaway extractions; the flag lets callers surface truncation.
  const truncated = normalized.length > MAX_DRAFT_ITEMS;
  const items = truncated ? normalized.slice(0, MAX_DRAFT_ITEMS) : normalized;

  // Dedupe against the existing catalog (normalized-name match).
  const existing = await store.listCatalogNames(ctx.tenantId);
  const existingByKey = new Map(existing.map((p) => [normalizeNameKey(p.name), p.id]));
  const duplicates: StoredCatalogDraft["duplicates"] = [];
  for (const it of items) {
    const dupId = existingByKey.get(normalizeNameKey(it.name));
    if (dupId) duplicates.push({ itemId: it.id, existingProductId: dupId, name: it.name });
  }

  const now = (deps.now ?? (() => new Date()))();
  const draft: StoredCatalogDraft = {
    id: `cd_${nanoid(16)}`,
    tenantId: ctx.tenantId,
    status: "pending",
    currency: currencyDefault,
    items,
    duplicates,
    upstreamRef: extracted.upstreamRef,
    imageRef: ctx.imageUrl,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DRAFT_TTL_MS).toISOString(),
  };
  await store.saveDraft(draft);
  return { ok: true, draftId: draft.id, items, ...(truncated ? { truncated: true } : {}) };
}

// ── Seam: read ──────────────────────────────────────────────────────────────

export async function getCatalogDraft(
  ctx: { tenantId: string; draftId: string },
  deps: CatalogBootstrapDeps = {},
): Promise<GetDraftResult> {
  const store = deps.store ?? makeDefaultStore();
  const draft = await store.loadDraft(ctx.tenantId, ctx.draftId);
  if (!draft) return { ok: false, error: "draft_not_found" };
  if (applyExpiry(draft, (deps.now ?? (() => new Date()))())) await store.updateDraft(draft);
  return { ok: true, draft };
}

// ── Seam: confirm ───────────────────────────────────────────────────────────

export interface ConfirmInput {
  tenantId: string;
  draftId: string;
  /** Whitelist of item ids to publish; absent = all non-duplicate items. */
  approveItemIds?: string[];
  /** Per-item edits applied before publishing. */
  edits?: Record<string, { name?: string; priceCents?: number; sku?: string; unit?: string }>;
}

/**
 * W15.1: after a product-insert failure, check whether the planned SKUs
 * already exist as products created by THIS draft (concurrent confirm won the
 * race). Returns the existing product ids in plan order, or null when the
 * collision is foreign (genuinely different products own those SKUs).
 */
async function tryHealSkuCollision(
  store: CatalogDraftStore,
  draft: StoredCatalogDraft,
  planned: Array<{ item: StoredCatalogItem; sku: string; price: string }>,
  now: Date,
): Promise<string[] | null> {
  if (!store.findProductsBySkus || planned.length === 0) return null;
  let rows: Array<{ id: string; sku: string; price: string; metadata?: Record<string, unknown> | null }>;
  try {
    rows = await store.findProductsBySkus(draft.tenantId, planned.map((p) => p.sku));
  } catch {
    return null;
  }
  const bySku = new Map(rows.map((r) => [r.sku, r]));
  const ids: string[] = [];
  for (const p of planned) {
    const row = bySku.get(p.sku);
    if (!row) return null; // not all rows exist → not a clean re-run collision
    const meta = row.metadata as { source?: unknown; draftId?: unknown; itemId?: unknown } | null | undefined;
    const provenanceMatch =
      meta?.source === "catalogBootstrap" && meta?.draftId === draft.id && meta?.itemId === p.item.id;
    // Fallback for rows that lack provenance: same tenant+sku (the lookup is
    // already tenant-scoped) and an identical price.
    const priceMatch = String(row.price) === p.price;
    if (!provenanceMatch && !priceMatch) return null;
    ids.push(row.id);
  }
  await store.updateDraft({
    ...draft,
    status: "confirmed",
    confirmedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    confirmedProductIds: ids,
  });
  return ids;
}

export async function confirmCatalogDraft(
  input: ConfirmInput,
  deps: CatalogBootstrapDeps = {},
): Promise<ConfirmResult> {
  const store = deps.store ?? makeDefaultStore();
  const now = (deps.now ?? (() => new Date()))();

  // Claim-first: flip pending → confirming before any product insert, so a
  // concurrent/double confirm short-circuits with no duplicate rows.
  const claimed = await store.claimDraftForConfirm(input.tenantId, input.draftId);
  if (claimed === null) return { ok: false, error: "draft_not_found" };
  if (claimed === "already") {
    const existing = await store.loadDraft(input.tenantId, input.draftId);
    if (existing && applyExpiry(existing, now)) {
      await store.updateDraft(existing);
      return { ok: false, error: "draft_expired" };
    }
    // W15.1: distinguish a finished confirm from an in-flight one. Returning
    // alreadyConfirmed:true with empty productIds for a 'confirming' draft
    // made callers believe the publish succeeded with zero products.
    if (existing?.status === "confirming") {
      return { ok: false, error: "confirm_in_progress" };
    }
    if (existing?.status === "confirmed") {
      return {
        ok: true,
        draftId: input.draftId,
        productIds: existing.confirmedProductIds ?? [],
        alreadyConfirmed: true,
      };
    }
    return { ok: false, error: `draft_not_confirmable:${existing?.status ?? "unknown"}` };
  }
  if (applyExpiry(claimed, now)) {
    await store.updateDraft(claimed);
    return { ok: false, error: "draft_expired" };
  }

  const dupItemIds = new Set(claimed.duplicates.map((d) => d.itemId));
  const approved = new Set(input.approveItemIds ?? claimed.items.map((i) => i.id));
  const skippedDuplicates: string[] = [];
  const toCreate: StoredCatalogItem[] = [];
  for (const item of claimed.items) {
    if (!approved.has(item.id)) continue;
    if (dupItemIds.has(item.id)) {
      skippedDuplicates.push(item.id);
      continue;
    }
    const edit = input.edits?.[item.id];
    const merged: StoredCatalogItem = { ...item };
    if (edit?.name) {
      const cleaned = cleanName(edit.name);
      if (cleaned) merged.name = cleaned;
    }
    // W15.1: same upper bound as extraction (MAX_PRICE_CENTS) — an over-bound
    // edit is ignored (the drafted price stands), matching the min-bound path.
    if (
      typeof edit?.priceCents === "number" &&
      Number.isFinite(edit.priceCents) &&
      edit.priceCents >= 50 &&
      edit.priceCents <= MAX_PRICE_CENTS
    ) {
      merged.priceCents = Math.round(edit.priceCents);
    }
    if (edit?.sku) merged.sku = edit.sku.slice(0, 100);
    if (edit?.unit) merged.unit = edit.unit;
    toCreate.push(merged);
  }

  // Pre-compute the SKU for every item so a collision self-heal can find the
  // rows a concurrent confirm already created.
  const planned = toCreate.map((item, i) => ({
    item,
    sku: item.sku ?? `CB-${claimed.id.slice(3, 9).toUpperCase()}-${String(i + 1).padStart(3, "0")}`,
    price: (item.priceCents / 100).toFixed(2),
  }));

  const productIds: string[] = [];
  try {
    for (const { item, sku, price } of planned) {
      const id = await store.createProduct({
        tenantId: input.tenantId,
        sku,
        name: item.name,
        price,
        currency: item.currency || claimed.currency,
        description: item.unit ? `Sold per ${item.unit}` : undefined,
        metadata: { source: "catalogBootstrap", draftId: claimed.id, itemId: item.id, confidence: item.confidence },
      });
      productIds.push(id);
    }
  } catch (e) {
    // W15.1 self-heal: the claim flip is a read-modify-write on a jsonb blob,
    // so a true concurrent confirm can slip through and hit the
    // products_tenant_sku_idx unique backstop. When that happens the products
    // already exist and every later confirm would fail the same way, wedging
    // the draft forever. If the colliding rows were created by THIS draft
    // (metadata provenance draftId+itemId, or — for rows without provenance —
    // an exact tenantId+sku+price match), adopt them and finish the confirm.
    const healed = await tryHealSkuCollision(store, claimed, planned, now);
    if (healed) {
      return { ok: true, draftId: claimed.id, productIds: healed, alreadyConfirmed: true };
    }
    // Roll the claim back to pending so the merchant can retry.
    await store.updateDraft({ ...claimed, status: "pending", updatedAt: new Date().toISOString() });
    return { ok: false, error: "product_create_failed" };
  }

  await store.updateDraft({
    ...claimed,
    status: "confirmed",
    confirmedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    confirmedProductIds: productIds,
  });
  return { ok: true, draftId: claimed.id, productIds, skippedDuplicates };
}

// ── Reject path ─────────────────────────────────────────────────────────────

export async function rejectCatalogDraft(
  input: { tenantId: string; draftId: string; reason?: string },
  deps: CatalogBootstrapDeps = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = deps.store ?? makeDefaultStore();
  const draft = await store.loadDraft(input.tenantId, input.draftId);
  if (!draft) return { ok: false, error: "draft_not_found" };
  if (applyExpiry(draft, (deps.now ?? (() => new Date()))())) {
    await store.updateDraft(draft);
    return { ok: false, error: "draft_expired" };
  }
  if (draft.status !== "pending") return { ok: false, error: `draft_not_rejectable:${draft.status}` };
  await store.updateDraft({
    ...draft,
    status: "rejected",
    rejectedAt: new Date().toISOString(),
    rejectedReason: input.reason?.slice(0, 200),
    updatedAt: new Date().toISOString(),
  });
  return { ok: true };
}
