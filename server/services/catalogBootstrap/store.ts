/**
 * Persistence for catalog-bootstrap drafts (W15, roadmap F5).
 *
 * NO new migrations: drafts live in the existing tenants.settings jsonb under
 * `settings.catalogDrafts[draftId]`; confirmed items are inserted into the
 * existing `products` table. The store is an injectable interface so unit
 * tests run fully in-memory; the default impl uses getDb().
 *
 * Claim-first idempotency: claimDraftForConfirm() flips status
 * pending → confirming and returns false when the draft was already claimed
 * or confirmed, so a double-confirm short-circuits BEFORE any product rows
 * are created (no dupes). Finalize marks the draft 'confirmed' with the
 * created product ids.
 */

import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "../../db";
import { products, tenants } from "../../../drizzle/schema";
import { updateTenantSettings } from "../onboarding";

export type CatalogDraftStatus = "pending" | "confirming" | "confirmed" | "rejected" | "expired";

export interface StoredCatalogItem {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  sku?: string;
  unit?: string;
  confidence: number;
  rawText?: string;
}

export interface StoredCatalogDraft {
  id: string;
  tenantId: string;
  status: CatalogDraftStatus;
  currency: string;
  items: StoredCatalogItem[];
  /** Items whose normalized name already exists in the live catalog. */
  duplicates: Array<{ itemId: string; existingProductId: string; name: string }>;
  upstreamRef?: string;
  imageRef?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  confirmedAt?: string;
  confirmedProductIds?: string[];
  rejectedAt?: string;
  rejectedReason?: string;
}

export interface CreatedProductInput {
  tenantId: string;
  sku: string;
  name: string;
  price: string; // decimal major units
  currency: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface CatalogDraftStore {
  /** Persist a new pending draft. */
  saveDraft(draft: StoredCatalogDraft): Promise<void>;
  /** Load a draft scoped to a tenant; null when absent (or cross-tenant). */
  loadDraft(tenantId: string, draftId: string): Promise<StoredCatalogDraft | null>;
  /** Persist a full draft replacement (status/items fields). */
  updateDraft(draft: StoredCatalogDraft): Promise<void>;
  /**
   * Atomically claim a pending draft for confirmation. Returns the claimed
   * draft, 'already' when not pending (confirmed/confirming/rejected/expired),
   * or null when the draft does not exist for this tenant.
   */
  claimDraftForConfirm(tenantId: string, draftId: string): Promise<StoredCatalogDraft | "already" | null>;
  /** Existing catalog rows for dedupe (id + name). */
  listCatalogNames(tenantId: string): Promise<Array<{ id: string; name: string }>>;
  /** Insert one product row; returns the new id. */
  createProduct(input: CreatedProductInput): Promise<string>;
  /**
   * W15.1: look up existing product rows by (tenantId, sku) — used to
   * self-heal a wedged draft after a SKU-unique collision (a concurrent
   * confirm already created the rows). Rows carry the confirm-time metadata
   * provenance ({ source, draftId, itemId }), so callers can tell "this
   * draft's own products" apart from genuinely foreign SKU clashes.
   */
  findProductsBySkus?(
    tenantId: string,
    skus: string[],
  ): Promise<Array<{ id: string; sku: string; price: string; metadata?: Record<string, unknown> | null }>>;
}

const DRAFTS_KEY = "catalogDrafts";

type SettingsWithDrafts = Record<string, unknown> & {
  [DRAFTS_KEY]?: Record<string, StoredCatalogDraft>;
};

/** Lazily expire a stale pending draft (pure — caller persists if changed). */
export function applyExpiry(draft: StoredCatalogDraft, now = new Date()): boolean {
  if ((draft.status === "pending" || draft.status === "confirming") && draft.expiresAt <= now.toISOString()) {
    draft.status = "expired";
    draft.updatedAt = now.toISOString();
    return true;
  }
  return false;
}

// ── Default store (tenants.settings jsonb + products table) ────────────────

export function makeDefaultStore(): CatalogDraftStore {
  return {
    async saveDraft(draft) {
      await updateTenantSettings(draft.tenantId, (s) => {
        const sw = s as SettingsWithDrafts;
        sw[DRAFTS_KEY] = { ...(sw[DRAFTS_KEY] ?? {}), [draft.id]: draft };
      });
    },

    async loadDraft(tenantId, draftId) {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const [tenant] = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const drafts = ((tenant?.settings as SettingsWithDrafts | null)?.[DRAFTS_KEY]) ?? {};
      const draft = drafts[draftId];
      return draft && draft.tenantId === tenantId ? { ...draft } : null;
    },

    async updateDraft(draft) {
      await updateTenantSettings(draft.tenantId, (s) => {
        const sw = s as SettingsWithDrafts;
        const drafts = { ...(sw[DRAFTS_KEY] ?? {}) };
        if (drafts[draft.id]) drafts[draft.id] = draft;
        sw[DRAFTS_KEY] = drafts;
      });
    },

    async claimDraftForConfirm(tenantId, draftId) {
      let claimed: StoredCatalogDraft | null = null;
      let blocked = false;
      await updateTenantSettings(tenantId, (s) => {
        const sw = s as SettingsWithDrafts;
        const drafts = { ...(sw[DRAFTS_KEY] ?? {}) };
        const draft = drafts[draftId];
        if (!draft || draft.tenantId !== tenantId) return;
        if (draft.status !== "pending") {
          blocked = true;
          return;
        }
        const next: StoredCatalogDraft = {
          ...draft,
          status: "confirming",
          updatedAt: new Date().toISOString(),
        };
        drafts[draftId] = next;
        sw[DRAFTS_KEY] = drafts;
        claimed = next;
      });
      if (claimed) return claimed;
      return blocked ? "already" : null;
    },

    async listCatalogNames(tenantId) {
      const db = await getDb();
      if (!db) return [];
      return db
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(and(eq(products.tenantId, tenantId)));
    },

    async createProduct(input) {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const id = nanoid();
      await db.insert(products).values({
        id,
        tenantId: input.tenantId,
        sku: input.sku,
        name: input.name,
        price: input.price,
        currency: input.currency,
        description: input.description ?? null,
        status: "active",
        stockQuantity: 0,
        metadata: input.metadata ?? null,
      });
      return id;
    },

    async findProductsBySkus(tenantId, skus) {
      const db = await getDb();
      if (!db || skus.length === 0) return [];
      const rows = await db
        .select({
          id: products.id,
          sku: products.sku,
          price: products.price,
          metadata: products.metadata,
        })
        .from(products)
        .where(and(eq(products.tenantId, tenantId), inArray(products.sku, skus)));
      return rows.map((r) => ({
        ...r,
        metadata: (r.metadata ?? null) as Record<string, unknown> | null,
      }));
    },
  };
}
