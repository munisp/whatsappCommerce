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

import { and, eq } from "drizzle-orm";
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
 *
 * `replaceProductIds` — product ids to SET to the newly-mentioned quantity rather than add on top of what's
 * already there. Used for shortage recovery: after "you asked for 10, only 8 left", a buyer saying "I'll take 3"
 * means "change my order to 3", not "add 3 more to the stuck 10" (which would just reproduce the same shortage).
 * Anything not in this set merges into the existing cart row for that product (summed), never creating a second
 * row for the same product — a product mentioned twice used to insert two separate `cart_items` rows for it.
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
    replaceProductIds?: Set<string>;
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

    // Only the shortage-recovery replace case touches an existing row — an ordinary add ALWAYS inserts a fresh
    // row, unchanged from before. (An earlier version of this made every repeated mention of the same product
    // merge into one row, which sounded like a strict improvement — one line instead of two for "1 milo" then
    // "2 milo" — but broke `buildReorder`: it deliberately reuses the caller's cart session, which can still hold
    // a leftover row from an order that was already paid for [carts aren't cleared on checkout — a real, separate,
    // pre-existing gap, not this function's to fix], and a plain reorder then silently merged into that stale row
    // instead of rebuilding a clean quantity. Found via 12+ unrelated journeys failing in the full suite, none of
    // them anywhere near cart-merging on the surface — traced to this.)
    const replace = opts.replaceProductIds?.has(match.product.id) ?? false;
    let finalQuantity = item.quantity;
    if (replace) {
      const existing = await db.select().from(cartItems)
        .where(and(eq(cartItems.cartSessionId, cartSession.id), eq(cartItems.productId, match.product.id)))
        .limit(1);
      if (existing[0]) {
        await db.update(cartItems)
          .set({ quantity: finalQuantity, unitPrice: match.product.price, currency: match.product.currency })
          .where(eq(cartItems.id, existing[0].id));
        added.push({
          productId: match.product.id, productName: match.product.name, quantity: finalQuantity,
          unitPrice: match.product.price, currency: match.product.currency, confidence: match.confidence,
        });
        continue;
      }
    }
    await db.insert(cartItems).values({
      id: crypto.randomUUID(),
      cartSessionId: cartSession.id,
      productId: match.product.id,
      productName: match.product.name,
      quantity: finalQuantity,
      unitPrice: match.product.price,
      currency: match.product.currency,
      createdAt: new Date(),
    });
    added.push({
      productId: match.product.id,
      productName: match.product.name,
      quantity: finalQuantity,
      unitPrice: match.product.price,
      currency: match.product.currency,
      confidence: match.confidence,
    });
  }

  return { cartSession, added, clarifications };
}

export interface RemovedCartItem {
  productId: string;
  productName: string;
}

export interface RemoveItemsResult {
  removed: RemovedCartItem[];
  /** Human-readable clarification line per mention that was ambiguous or not actually in the cart. */
  clarifications: string[];
}

/**
 * Remove items from the buyer's cart by name (the same fuzzy match `addExtractedItemsToCart` uses). Declared as a
 * valid LLM intent (`remove_from_cart`) since this feature was designed, but never had a server-side handler at
 * all — found live 2026-09-25 when a buyer, told "remove the unavailable items" after a stock shortage, had no way
 * to actually do it (the message just wasn't acted on, LLM or no LLM).
 */
export async function removeItemsFromCart(
  db: Db,
  opts: { cartSessionId: string; products: CatalogProduct[]; mentions: string[] },
): Promise<RemoveItemsResult> {
  const removed: RemovedCartItem[] = [];
  const clarifications: string[] = [];
  const currentRows = await db.select().from(cartItems).where(eq(cartItems.cartSessionId, opts.cartSessionId));

  for (const mention of opts.mentions) {
    const match = matchCatalogItem(opts.products, mention);
    if (match.status === "ambiguous") {
      const names = match.candidates.map((c) => c.name).join(", ");
      clarifications.push(`❓ "${mention}" — did you mean: ${names}? Reply with the exact name to remove it.`);
      continue;
    }
    if (match.status === "not_found") {
      clarifications.push(`⚠️ Sorry, I couldn't match "${mention}" to anything on the menu.`);
      continue;
    }
    const row = currentRows.find((r) => r.productId === match.product.id);
    if (!row) {
      clarifications.push(`⚠️ "${match.product.name}" isn't in your cart.`);
      continue;
    }
    await db.delete(cartItems).where(eq(cartItems.id, row.id));
    removed.push({ productId: match.product.id, productName: match.product.name });
  }

  return { removed, clarifications };
}
