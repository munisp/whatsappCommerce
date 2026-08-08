/**
 * NLP cart helpers — multi-item extraction and catalog matching.
 *
 * The LLM returns `extractedItems: [{product, quantity}]` for messages like
 * "2 spicy chicken wraps and 1 sweet chilli wrap". These helpers normalize
 * that result (with fallback to the legacy single extractedProduct /
 * extractedQuantity fields), match each item against the tenant catalog with
 * a per-item confidence, and add every unambiguous in-stock item to the
 * buyer's cart session. Ambiguous / unmatched / out-of-stock items produce
 * clarification lines the caller appends to the reply.
 */

import { eq } from "drizzle-orm";
import { cartItems, cartSessions, nlpSessions } from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof import("../db").getDb>>>;

export interface CatalogProduct {
  id: string;
  name: string;
  price: string;
  currency: string;
  stockQuantity: number;
}

export interface ExtractedItem {
  product: string;
  quantity: number;
}

/** Shape of the LLM JSON relevant to item extraction (both new + legacy fields). */
export interface LlmExtraction {
  extractedItems?: Array<{ product?: string | null; quantity?: number | null }> | null;
  extractedProduct?: string | null;
  extractedQuantity?: number | null;
}

/**
 * Normalize the LLM extraction into a concrete item list.
 * Prefers `extractedItems`; falls back to the legacy single-item fields.
 * Quantities are clamped to sane positive integers.
 */
export function normalizeExtractedItems(llm: LlmExtraction): ExtractedItem[] {
  const out: ExtractedItem[] = [];
  if (Array.isArray(llm.extractedItems)) {
    for (const raw of llm.extractedItems) {
      const name = (raw?.product ?? "").toString().trim();
      if (!name) continue;
      const qty = Math.max(1, Math.min(999, Math.floor(Number(raw?.quantity ?? 1)) || 1));
      out.push({ product: name, quantity: qty });
    }
  }
  if (out.length === 0 && llm.extractedProduct) {
    const name = llm.extractedProduct.toString().trim();
    if (name) {
      const qty = Math.max(1, Math.min(999, Math.floor(Number(llm.extractedQuantity ?? 1)) || 1));
      out.push({ product: name, quantity: qty });
    }
  }
  return out;
}

export type CatalogMatch =
  | { status: "matched"; product: CatalogProduct; confidence: number }
  | { status: "ambiguous"; candidates: CatalogProduct[]; confidence: number }
  | { status: "not_found"; confidence: 0 };

/**
 * Match a free-text product mention against the catalog.
 *  - exact (case-insensitive) name match → confidence 1.0
 *  - single substring match             → confidence 0.8
 *  - multiple substring matches         → ambiguous (confidence 0.5), caller
 *    asks the buyer which one they meant instead of guessing
 */
export function matchCatalogItem(products: CatalogProduct[], mention: string): CatalogMatch {
  const q = mention.toLowerCase().trim();
  if (!q) return { status: "not_found", confidence: 0 };

  const exact = products.filter(p => p.name.toLowerCase() === q);
  if (exact.length === 1) return { status: "matched", product: exact[0], confidence: 1 };

  const partial = products.filter(p =>
    p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()),
  );
  const candidates = (exact.length > 1 ? exact : partial);
  if (candidates.length === 1) return { status: "matched", product: candidates[0], confidence: 0.8 };
  if (candidates.length > 1) return { status: "ambiguous", candidates: candidates.slice(0, 5), confidence: 0.5 };
  return { status: "not_found", confidence: 0 };
}

export interface AddedCartItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: string;
  currency: string;
  confidence: number;
}

export interface AddItemsResult {
  cartSession: any;
  added: AddedCartItem[];
  /** Human-readable clarification lines for items that could not be added. */
  clarifications: string[];
}

/**
 * Add all extracted items to the buyer's cart (creating the cart session and
 * linking it to the NLP session when needed). Returns what was added plus a
 * clarification line per item that was ambiguous, unknown, or out of stock.
 */
export async function addExtractedItemsToCart(
  db: Db,
  opts: {
    tenantId: string;
    waPhoneNumber: string;
    session: { id: string; language: string };
    cartSession: any | null;
    products: CatalogProduct[];
    items: ExtractedItem[];
  },
): Promise<AddItemsResult> {
  const added: AddedCartItem[] = [];
  const clarifications: string[] = [];
  let cartSession = opts.cartSession;

  for (const item of opts.items) {
    const match = matchCatalogItem(opts.products, item.product);
    if (match.status === "ambiguous") {
      const names = match.candidates.map(c => c.name).join(", ");
      clarifications.push(`❓ "${item.product}" — did you mean: ${names}? Reply with the exact name.`);
      continue;
    }
    if (match.status === "not_found") {
      clarifications.push(`⚠️ Sorry, I couldn't find "${item.product}" on the menu.`);
      continue;
    }
    if (match.product.stockQuantity <= 0) {
      clarifications.push(`⚠️ "${match.product.name}" is currently out of stock.`);
      continue;
    }

    // Lazily create + link the cart session on the first addable item.
    if (!cartSession) {
      const [cs] = await db.insert(cartSessions).values({
        id: crypto.randomUUID(),
        tenantId: opts.tenantId,
        waPhoneNumber: opts.waPhoneNumber,
        sessionData: {},
        currentStep: "browse",
        language: opts.session.language,
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
        updatedAt: new Date(),
      }).returning();
      cartSession = cs;
      await db.update(nlpSessions).set({ cartSessionId: cs.id }).where(eq(nlpSessions.id, opts.session.id));
    }

    await db.insert(cartItems).values({
      id: crypto.randomUUID(),
      cartSessionId: cartSession.id,
      productId: match.product.id,
      productName: match.product.name,
      quantity: item.quantity,
      unitPrice: match.product.price,
      currency: match.product.currency,
      createdAt: new Date(),
    });
    added.push({
      productId: match.product.id,
      productName: match.product.name,
      quantity: item.quantity,
      unitPrice: match.product.price,
      currency: match.product.currency,
      confidence: match.confidence,
    });
  }

  return { cartSession, added, clarifications };
}
