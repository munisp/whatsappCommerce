/**
 * Multi-item NLP cart — unit tests
 * Covers normalizeExtractedItems (mock LLM results), matchCatalogItem
 * confidence/ambiguity, and addExtractedItemsToCart with a mocked db.
 */
import { describe, it, expect, vi } from "vitest";
import {
  normalizeExtractedItems,
  matchCatalogItem,
  addExtractedItemsToCart,
  type CatalogProduct,
} from "./services/nlpCart";

const CATALOG: CatalogProduct[] = [
  { id: "p1", name: "Spicy Chicken Wrap", price: "2500.00", currency: "NGN", stockQuantity: 10 },
  { id: "p2", name: "Sweet Chilli Wrap", price: "2300.00", currency: "NGN", stockQuantity: 5 },
  { id: "p3", name: "Chapman", price: "1500.00", currency: "NGN", stockQuantity: 0 },
  { id: "p4", name: "Spicy Chicken Pie", price: "1200.00", currency: "NGN", stockQuantity: 8 },
];

describe("normalizeExtractedItems", () => {
  it("normalizes a multi-item LLM result", () => {
    const items = normalizeExtractedItems({
      extractedItems: [
        { product: "spicy chicken wrap", quantity: 2 },
        { product: "sweet chilli wrap", quantity: 1 },
      ],
      extractedProduct: null,
      extractedQuantity: null,
    });
    expect(items).toEqual([
      { product: "spicy chicken wrap", quantity: 2 },
      { product: "sweet chilli wrap", quantity: 1 },
    ]);
  });

  it("falls back to legacy single-item fields", () => {
    const items = normalizeExtractedItems({
      extractedItems: [],
      extractedProduct: "Chapman",
      extractedQuantity: 3,
    });
    expect(items).toEqual([{ product: "Chapman", quantity: 3 }]);
  });

  it("defaults missing quantity to 1 and skips empty names", () => {
    const items = normalizeExtractedItems({
      extractedItems: [{ product: "wrap" }, { product: "  ", quantity: 5 }],
    });
    expect(items).toEqual([{ product: "wrap", quantity: 1 }]);
  });
});

describe("matchCatalogItem", () => {
  it("matches exactly with confidence 1", () => {
    const m = matchCatalogItem(CATALOG, "Spicy Chicken Wrap");
    expect(m.status).toBe("matched");
    if (m.status === "matched") expect(m.confidence).toBe(1);
  });

  it("matches a unique partial mention with confidence 0.8", () => {
    const m = matchCatalogItem(CATALOG, "chapman");
    expect(m.status).toBe("matched");
    if (m.status === "matched") expect(m.product.id).toBe("p3");
  });

  it("flags multiple partial matches as ambiguous", () => {
    const m = matchCatalogItem(CATALOG, "spicy chicken");
    expect(m.status).toBe("ambiguous");
    if (m.status === "ambiguous") {
      expect(m.candidates.map(c => c.id).sort()).toEqual(["p1", "p4"]);
    }
  });

  it("returns not_found for unknown products", () => {
    expect(matchCatalogItem(CATALOG, "sushi").status).toBe("not_found");
  });
});

describe("addExtractedItemsToCart (mock db)", () => {
  function makeDb() {
    const insertedCartItems: any[] = [];
    const returning = vi.fn().mockResolvedValue([{ id: "cart-session-1" }]);
    const values = vi.fn().mockImplementation((row: any) => {
      if (row?.productId !== undefined) insertedCartItems.push(row);
      return { returning };
    });
    const insert = vi.fn(() => ({ values }));
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    return { db: { insert, update } as any, insertedCartItems, values };
  }

  it("adds all matched items from a multi-item message and clarifies the rest", async () => {
    const { db, insertedCartItems } = makeDb();
    const result = await addExtractedItemsToCart(db, {
      tenantId: "t1",
      waPhoneNumber: "2348012345678",
      session: { id: "sess-1", language: "english" },
      cartSession: null,
      products: CATALOG,
      items: [
        { product: "spicy chicken wrap", quantity: 2 },
        { product: "sweet chilli wrap", quantity: 1 },
        { product: "chapman", quantity: 1 },       // out of stock
        { product: "spicy chicken", quantity: 1 }, // ambiguous
        { product: "sushi", quantity: 1 },         // unknown
      ],
    });

    expect(result.cartSession?.id).toBe("cart-session-1");
    expect(result.added.map(a => [a.productName, a.quantity])).toEqual([
      ["Spicy Chicken Wrap", 2],
      ["Sweet Chilli Wrap", 1],
    ]);
    // out-of-stock + ambiguous + unknown each produce a clarification line
    expect(result.clarifications).toHaveLength(3);
    expect(result.clarifications.join("\n")).toMatch(/out of stock/);
    expect(result.clarifications.join("\n")).toMatch(/did you mean/);
    expect(result.clarifications.join("\n")).toMatch(/couldn't find/);

    // two cart item rows inserted, both linked to the new cart session
    expect(insertedCartItems).toHaveLength(2);
    expect(insertedCartItems[0]).toMatchObject({
      cartSessionId: "cart-session-1",
      productId: "p1",
      quantity: 2,
      unitPrice: "2500.00",
    });
    expect(insertedCartItems[1]).toMatchObject({ productId: "p2", quantity: 1 });
  });

  it("reuses an existing cart session instead of creating one", async () => {
    const { db } = makeDb();
    const existing = { id: "existing-cart" };
    const result = await addExtractedItemsToCart(db, {
      tenantId: "t1",
      waPhoneNumber: "2348012345678",
      session: { id: "sess-1", language: "english" },
      cartSession: existing,
      products: CATALOG,
      items: [{ product: "sweet chilli wrap", quantity: 4 }],
    });
    expect(result.cartSession).toBe(existing);
    expect(result.added).toHaveLength(1);
    // no cartSessions insert (only the cartItems insert happened)
    expect((db.insert as any).mock.results).toHaveLength(1);
  });

  // Freaks fashion hub (2026-11-10): two products differing only by a trailing space; the in-stock one was listed
  // as #2, but picking it matched the out-of-stock one by name and the buyer was told it was out of stock.
  const NEAR_TWINS: CatalogProduct[] = [
    { id: "jean-old", name: "Hand painted jean", price: "45000.00", currency: "NGN", stockQuantity: 0 },
    { id: "jean-new", name: "Hand painted jean ", price: "45000.00", currency: "NGN", stockQuantity: 3 },
  ];

  it("adds the exact product a numbered pick names, even when another product shares its name", async () => {
    const { db, insertedCartItems } = makeDb();
    const result = await addExtractedItemsToCart(db, {
      tenantId: "t1",
      waPhoneNumber: "2348012345678",
      session: { id: "sess-1", language: "english" },
      cartSession: null,
      products: NEAR_TWINS,
      items: normalizeExtractedItems({ extractedItems: [{ product: "Hand painted jean ", quantity: 1, productId: "jean-new" }] }),
    });
    expect(result.clarifications).toEqual([]);
    expect(insertedCartItems).toHaveLength(1);
    expect(insertedCartItems[0]).toMatchObject({ productId: "jean-new", quantity: 1 });
  });

  it("still refuses a numbered pick of an out-of-stock product", async () => {
    const { db, insertedCartItems } = makeDb();
    const result = await addExtractedItemsToCart(db, {
      tenantId: "t1",
      waPhoneNumber: "2348012345678",
      session: { id: "sess-1", language: "english" },
      cartSession: null,
      products: NEAR_TWINS,
      items: [{ product: "Hand painted jean", quantity: 1, productId: "jean-old" }],
    });
    expect(insertedCartItems).toHaveLength(0);
    expect(result.clarifications.join("\n")).toMatch(/out of stock/);
  });
});

describe("matchCatalogItem whitespace", () => {
  it("treats names that differ only by whitespace as the same name, so the buyer is asked which one", () => {
    const match = matchCatalogItem([
      { id: "a", name: "Hand painted jean", price: "1", currency: "NGN", stockQuantity: 0 },
      { id: "b", name: "Hand  painted jean ", price: "1", currency: "NGN", stockQuantity: 3 },
    ], "hand painted jean");
    expect(match.status).toBe("ambiguous");
  });

  it("matches a catalog name with stray spaces exactly", () => {
    const match = matchCatalogItem([{ id: "b", name: " Ankara  Top ", price: "1", currency: "NGN", stockQuantity: 3 }], "ankara top");
    expect(match).toMatchObject({ status: "matched", confidence: 1 });
  });
});
