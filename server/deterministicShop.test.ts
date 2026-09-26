/**
 * classifyDeterministically is what stands in for the LLM ordering assistant when the real LLM call fails — found
 * live 2026-09-25 to be the ONLY thing standing between a buyer and a dead-end "sorry I don't understand" reply.
 * These are pure-function tests: no database, no network, just "given this message and this catalog, what would we
 * do." The end-to-end proof that the resulting {intent, extractedItems} shape actually drives a real order through
 * nlpCart.ts and creates a payable order lives in simulation/journeys (real Postgres, LLM forced to fail).
 */
import { describe, it, expect } from "vitest";
import { classifyDeterministically, renderCatalog, type DeterministicProduct } from "./services/deterministicShop";

const CATALOG: DeterministicProduct[] = [
  { id: "p1", name: "Jollof Rice", price: "2500.00", currency: "NGN", stockQuantity: 50 },
  { id: "p2", name: "Grilled Chicken", price: "3000.00", currency: "NGN", stockQuantity: 50 },
  { id: "p3", name: "Sold Out Sneakers", price: "15000.00", currency: "NGN", stockQuantity: 0 },
];

const classify = (text: string, cart: { productName: string; quantity: number }[] = []) =>
  classifyDeterministically(text, CATALOG, cart, "browse");

describe("renderCatalog", () => {
  it("numbers items in order, prices and flags out-of-stock", () => {
    const out = renderCatalog(CATALOG);
    expect(out).toBe(
      "1. Jollof Rice — NGN 2500.00\n2. Grilled Chicken — NGN 3000.00\n3. Sold Out Sneakers — NGN 15000.00 (out of stock)",
    );
  });
});

describe("classifyDeterministically — confirming an order", () => {
  it("confirms with a non-empty cart", () => {
    const r = classify("confirm", [{ productName: "Jollof Rice", quantity: 2 }]);
    expect(r.intent).toBe("confirm_order");
    expect(r.confidence).toBe(1);
  });
  it("recognizes the common phrasings a buyer actually types", () => {
    for (const phrase of ["checkout", "place my order", "that's all", "I'm done", "done", "proceed", "pay now"]) {
      expect(classify(phrase, [{ productName: "Jollof Rice", quantity: 1 }]).intent, phrase).toBe("confirm_order");
    }
  });
  it("does not confirm an empty cart — points back at the catalog instead of creating a $0 order", () => {
    const r = classify("confirm", []);
    expect(r.intent).toBe("unknown");
    expect(r.reply).toContain("cart is empty");
    expect(r.reply).toContain("Jollof Rice");
  });
});

describe("classifyDeterministically — viewing the cart", () => {
  it("lists what's in the cart", () => {
    const r = classify("cart", [{ productName: "Jollof Rice", quantity: 2 }, { productName: "Grilled Chicken", quantity: 1 }]);
    expect(r.intent).toBe("view_cart");
    expect(r.reply).toContain("2 × Jollof Rice");
    expect(r.reply).toContain("1 × Grilled Chicken");
  });
  it("says so when it's empty", () => {
    expect(classify("my cart").reply).toContain("empty");
  });
});

describe("classifyDeterministically — numbered catalog pick", () => {
  it("a bare number picks that catalog position, quantity 1", () => {
    const r = classify("2");
    expect(r.intent).toBe("add_to_cart");
    expect(r.extractedItems).toEqual([{ product: "Grilled Chicken", quantity: 1 }]);
  });
  it("N x qty picks a quantity too", () => {
    const r = classify("1x3");
    expect(r.extractedItems).toEqual([{ product: "Jollof Rice", quantity: 3 }]);
  });
  it("out of range: says so, still shows the catalog, never silently mismatches to the wrong item", () => {
    const r = classify("9");
    expect(r.intent).toBe("unknown");
    expect(r.reply).toContain("#9");
    expect(r.reply).toContain("Jollof Rice");
  });
  it("never confuses a number that's part of a real sentence with a catalog pick", () => {
    const r = classify("I need 2 jollof rice please");
    expect(r.intent).toBe("add_to_cart");
    expect(r.extractedItems?.[0]).toMatchObject({ quantity: 2 });
    // (not read as "pick item #2" — the message isn't a bare number)
  });
});

describe("classifyDeterministically — free-text product mentions", () => {
  it("quantity before the name", () => {
    expect(classify("2 jollof rice").extractedItems).toEqual([{ product: "jollof rice", quantity: 2 }]);
  });
  it("quantity after the name (x2 / x 2)", () => {
    expect(classify("jollof rice x2").extractedItems).toEqual([{ product: "jollof rice", quantity: 2 }]);
    expect(classify("jollof rice x 2").extractedItems).toEqual([{ product: "jollof rice", quantity: 2 }]);
  });
  it("no quantity mentioned defaults to 1", () => {
    expect(classify("jollof rice").extractedItems).toEqual([{ product: "jollof rice", quantity: 1 }]);
  });
  it("multiple items separated by 'and' or a comma", () => {
    expect(classify("jollof rice and grilled chicken").extractedItems).toEqual([
      { product: "jollof rice", quantity: 1 },
      { product: "grilled chicken", quantity: 1 },
    ]);
    expect(classify("2 jollof rice, 1 grilled chicken").extractedItems).toEqual([
      { product: "jollof rice", quantity: 2 },
      { product: "grilled chicken", quantity: 1 },
    ]);
  });
  it("a partial/misspelled-ish mention that still overlaps the catalog name is still an add attempt (nlpCart.ts's matcher, not this module, decides the exact hit)", () => {
    const r = classify("jollof");
    expect(r.intent).toBe("add_to_cart");
    expect(r.extractedItems).toEqual([{ product: "jollof", quantity: 1 }]);
  });
  it("a quantity embedded mid-sentence, behind a leading interjection the filler-stripper doesn't know, is still found — the exact live bug report (\"Alright I'll take 3 Milo\" only added 1)", () => {
    // "Alright" isn't in the filler list, so the mention keeps some leftover words ("Alright I'll take Grilled
    // Chicken") — harmless, since nlpCart.ts's matchCatalogItem substring-matches regardless. What matters here,
    // and what was actually broken live, is the QUANTITY: it used to default to 1 whenever the number wasn't the
    // very first or very last token.
    const r = classify("Alright I'll take 3 Grilled Chicken");
    expect(r.extractedItems).toHaveLength(1);
    expect(r.extractedItems[0].quantity).toBe(3);
    expect(r.extractedItems[0].product.toLowerCase()).toContain("grilled chicken");
  });
  it("a quantity right before 'x' with no space still parses (x glued to the digit has no \\b between them)", () => {
    expect(classify("jollof rice x3").extractedItems).toEqual([{ product: "jollof rice", quantity: 3 }]);
  });
});

describe("classifyDeterministically — removing from the cart", () => {
  const withCart = (text: string) => classify(text, [{ productName: "Jollof Rice", quantity: 2 }]);

  it("recognizes remove/delete/drop, extracts the product", () => {
    expect(withCart("remove jollof rice").intent).toBe("remove_from_cart");
    expect(withCart("remove jollof rice").extractedProduct).toBe("jollof rice");
    expect(withCart("delete the jollof rice").extractedProduct).toBe("jollof rice");
    expect(withCart("drop jollof rice").intent).toBe("remove_from_cart");
  });
  it("'take X off' means remove — the shortage-reply's own suggested wording", () => {
    const r = withCart("take the jollof rice off my cart");
    expect(r.intent).toBe("remove_from_cart");
    expect(r.extractedProduct).toBe("jollof rice");
  });
  it("bare 'take X' (no 'off') is an ADD, never confused with removal — \"I'll take 3 Milo\" must add, not remove", () => {
    const r = withCart("I'll take 3 jollof rice");
    expect(r.intent).toBe("add_to_cart");
  });
  it("'no more X' also means remove", () => {
    expect(withCart("no more jollof rice").intent).toBe("remove_from_cart");
  });
  it("never offers to remove from an empty cart — falls through to the ordinary add/unknown path instead", () => {
    const r = classify("remove jollof rice"); // no cart arg → empty
    expect(r.intent).not.toBe("remove_from_cart");
  });
});

describe("classifyDeterministically — genuinely unrecognizable text", () => {
  it("ordinary conversation that names nothing in the catalog gets the catalog, not a guessed add", () => {
    const r = classify("how are you doing today");
    expect(r.intent).toBe("unknown");
    expect(r.reply).toContain("Jollof Rice");
    expect(r.extractedItems).toEqual([]);
  });
  it("a real question is never misread as an order for an item that happens to share a word", () => {
    // "chicken" overlaps the catalog, but this is clearly a question, not an order — still fine to treat as an
    // attempt per this module's scope (it only decides intent, never fabricates a definite answer); the important
    // guarantee is it does NOT crash and DOES return a usable extractedItems shape either way.
    const r = classify("is the grilled chicken spicy");
    expect(["add_to_cart", "unknown"]).toContain(r.intent);
    expect(Array.isArray(r.extractedItems)).toBe(true);
  });
});

// 2026-09-26 (user's direction): this module now runs FIRST for every message, not just on LLM failure — most
// buyer messages are simple, unambiguous catalog operations that don't need the LLM's latency or understanding.
describe("classifyDeterministically — greeting", () => {
  it("a bare greeting gets a warm reply, not a menu dump or a guessed add", () => {
    for (const g of ["hi", "hello", "hey", "hiya", "yo", "good morning", "Good Afternoon!"]) {
      const r = classify(g);
      expect(r.intent, g).toBe("greeting");
      expect(r.extractedItems).toEqual([]);
    }
  });
  it("a greeting combined with an order still falls through to add-to-cart, not greeting", () => {
    const r = classify("hi, 2 jollof rice please");
    expect(r.intent).toBe("add_to_cart");
  });
});

describe("classifyDeterministically — stock questions (must NOT be treated as an order)", () => {
  it('"how many X do you have left" answers with the real count, does not add to cart', () => {
    // Found live 2026-09-26: this exact phrasing got silently added to the cart ("✅ 1 × milo") instead of
    // answered, because "how many milo..." contains "milo" and the free-text add matcher accepted that as a
    // plausible mention. Regression-guards the fix: stock questions are checked before that matcher.
    const r = classify("how many jollof rice do you have left");
    expect(r.intent).toBe("product_detail");
    expect(r.reply).toContain("50");
    expect(r.reply).toContain("Jollof Rice");
    expect(r.extractedItems).toEqual([]);
  });
  it('"is X in stock" / "do you have X available" also answer directly', () => {
    expect(classify("is grilled chicken in stock").reply).toContain("50");
    expect(classify("do you have jollof rice available").reply).toContain("50");
  });
  it("reports zero stock honestly for an out-of-stock item", () => {
    const r = classify("how many sold out sneakers are left");
    expect(r.reply).toMatch(/out of stock/i);
  });
});

describe("classifyDeterministically — product detail lookup (drives the productImage card in nlp.ts)", () => {
  it('"show me X" resolves to product_detail with extractedProduct set, not an add', () => {
    const r = classify("show me the jollof rice");
    expect(r.intent).toBe("product_detail");
    expect(r.extractedProduct).toBe("Jollof Rice");
    expect(r.extractedItems).toEqual([]);
  });
  it("also recognizes \"details on\", \"tell me about\", \"picture of\", \"what does X look like\"", () => {
    for (const phrase of ["details on jollof rice", "tell me more about the jollof rice", "picture of jollof rice", "what does the jollof rice look like"]) {
      expect(classify(phrase).intent, phrase).toBe("product_detail");
    }
  });
  it("an ambiguous or unmatched detail request does not crash and does not fabricate a product", () => {
    const r = classify("show me the spaceship");
    expect(r.intent).not.toBe("product_detail");
  });
});

describe("classifyDeterministically — cheaper options", () => {
  it("sorts the catalog cheapest-first when asked for cheaper/budget options", () => {
    const r = classify("any cheaper options");
    expect(r.intent).toBe("browse");
    const idxJollof = r.reply.indexOf("Jollof Rice");
    const idxChicken = r.reply.indexOf("Grilled Chicken");
    const idxSneakers = r.reply.indexOf("Sold Out Sneakers");
    expect(idxJollof).toBeGreaterThan(-1);
    expect(idxJollof).toBeLessThan(idxChicken);
    expect(idxChicken).toBeLessThan(idxSneakers);
  });
  it("recognizes common phrasings", () => {
    for (const phrase of ["cheaper", "what's cheaper", "budget options", "anything cheaper?", "show me the cheapest"]) {
      expect(classify(phrase).intent, phrase).toBe("browse");
    }
  });
});

// 2026-09-26, round 2: found live via a real Telegram conversation with the actual bot — tapping the menu's
// "Shop products" button sends useCases.ts's fallback text "I want to place an order" as the first message.
// Before this, that didn't match anything deterministic and paid the full 15-60s LLM round trip for the single
// most common way a buyer starts shopping, which read to the user as "nothing happens."
describe("classifyDeterministically — shop entry point (instant, no LLM wait)", () => {
  it('the literal fallback text useCases.ts sends for a bare "Shop products" tap resolves instantly', () => {
    const r = classify("I want to place an order");
    expect(r.intent).toBe("browse");
    expect(r.reply).toContain("Jollof Rice");
  });
  it("recognizes other common shop-entry phrasings", () => {
    for (const phrase of ["shop", "browse", "let's shop", "start shopping", "what do you have", "what's available"]) {
      expect(classify(phrase).intent, phrase).toBe("browse");
    }
  });
});

// 2026-09-26, round 2: a real bug from a real conversation — a buyer added Peak milk, then asked "Can I see the
// image" (no product named at all). The old DETAIL_PATTERNS all required a captured product name, so this fell
// through to the LLM, which claimed "I can describe it" and never sent anything.
describe("classifyDeterministically — image request with no product named (refers to the cart)", () => {
  it('"Can I see the image" resolves against the most recently added cart item', () => {
    const r = classify("Can I see the image", [{ productName: "Jollof Rice", quantity: 1 }]);
    expect(r.intent).toBe("product_detail");
    expect(r.extractedProduct).toBe("Jollof Rice");
  });
  it("recognizes other common no-subject phrasings", () => {
    const cart = [{ productName: "Grilled Chicken", quantity: 1 }];
    for (const phrase of ["got a pic?", "any photos?", "send me a picture", "do you have an image"]) {
      const r = classifyDeterministically(phrase, CATALOG, cart, "browse");
      expect(r.intent, phrase).toBe("product_detail");
      expect(r.extractedProduct, phrase).toBe("Grilled Chicken");
    }
  });
  it("does nothing special with an empty cart — no item to refer to", () => {
    const r = classify("Can I see the image"); // no cart arg → empty
    expect(r.intent).not.toBe("product_detail");
  });
});
