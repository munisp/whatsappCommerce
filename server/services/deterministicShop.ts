/**
 * deterministicShop.ts — the FAST, FIRST-PASS shop assistant. Originally built (2026-09-25) as a rule-based
 * stand-in used only when the real LLM call failed (network error, no LLM configured at all — `LLM_BASE_URL` was
 * unset, defaulting to an unreachable `localhost:11434`, so every "I want to place an order" dead-ended). A real
 * in-cluster LLM (Ollama) now runs — see `project_local_ollama_llm` — but it's still 15-60s per reply on this
 * environment's CPU-only inference, and even with schema-enforced output it can still misfire on plain, common
 * questions (found live 2026-09-26: "how many Milo do you have left" got silently added to the cart instead of
 * answered, because the free-text add-to-cart matcher below will substring-match almost anything that happens to
 * *mention* a catalog product name — the fix was recognizing "how many X" as its OWN pattern, checked BEFORE that
 * one, not tightening the substring match itself, which is still needed for genuine free-text orders).
 *
 * 2026-09-26 (user's direction): reordered to run FIRST for every message, not just on LLM failure — most buyer
 * messages are simple, unambiguous catalog operations (add/remove/confirm/view cart/greeting/product lookup) that
 * don't need an LLM's understanding at all and shouldn't pay its latency. `nlp.ts` only calls the LLM when this
 * module returns `intent: "unknown"` — genuinely open-ended stuff (natural conversation, "what ingredients do I
 * need for jollof rice", indirect phrasing) that a rule-based matcher can't responsibly guess at. Everything
 * downstream of a confident intent here (matching a mention to a catalog product, creating the order, collecting
 * fulfillment/delivery, building the payment link) is ALREADY non-LLM code (`nlpCart.ts`'s
 * `matchCatalogItem`/`addExtractedItemsToCart`, the "3b. Deterministic checkout steps" block in nlp.ts) — this
 * module only needs to produce the SAME shape the LLM's JSON reply would have, so existing code runs unchanged.
 */

import { matchCatalogItem, type CatalogProduct } from "./nlpCart";

export type DeterministicProduct = CatalogProduct;

export interface DeterministicCartLine {
  productName: string;
  quantity: number;
}

/** Same shape the LLM's parsed JSON produces — a drop-in replacement inside nlp.ts's llmResult. */
export interface DeterministicResult {
  reply: string;
  intent: "add_to_cart" | "remove_from_cart" | "confirm_order" | "view_cart" | "greeting" | "product_detail" | "browse" | "dispute" | "unknown";
  nextState: string;
  extractedItems: Array<{ product: string; quantity: number }>;
  extractedProduct: string | null;
  extractedQuantity: number | null;
  extractedAddress: string | null;
  confidence: number;
}

const CONFIRM_RE = /^(?:confirm(?:\s+(?:my\s+)?order)?|checkout|check\s*out|place\s+(?:my\s+)?order|that'?s\s+(?:all|it)|i'?m\s+done|done|finish(?:ed)?|complete\s+(?:my\s+)?order|pay\s*now|proceed)\.?!?$/i;
const CART_RE = /^(?:cart|view\s*cart|my\s*cart|show\s*cart|what'?s\s+in\s+my\s+cart)\??$/i;

// "remove_from_cart" was a declared LLM intent (see nlp.ts's system prompt) with no handler at all, LLM or no LLM
// — found live 2026-09-25 when a buyer told "remove the unavailable items" after a stock shortage had no way to
// actually do it. Deliberately does NOT match bare "take X" (that's an add — "I'll take 3 Milo" — handled below);
// only "take X off/out" signals removal.
const REMOVE_PATTERNS: RegExp[] = [
  /^(?:remove|delete|drop)\s+(?:the\s+)?(.+)$/i,
  /^take\s+(?:the\s+)?(.+?)\s+(?:off|out)(?:\s+(?:my|the)\s+cart)?$/i,
  /^(?:no\s+more|i\s+don'?t\s+want\s+(?:the\s+)?)\s*(.+)$/i,
];
function matchRemoveMention(text: string): string | null {
  for (const re of REMOVE_PATTERNS) {
    const m = re.exec(text.trim());
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
}

// Strip common ordering filler ("I need", "can I get", "please") so the quantity/mention regexes below see just
// "2 jollof rice" from "I need 2 jollof rice please" — real buyers ask this way far more often than a bare mention.
// Only stripped from the very start/end — the quantity search below handles a leading interjection like "Alright"
// on its own (found live 2026-09-25: "Alright I'll take 3 Milo" only added 1, because the "3" sits in the middle
// of the sentence and the old version only ever looked at the very first or very last token for a number).
const LEADING_FILLER_RE = /^(?:i\s+(?:need|want|would\s+like|will\s+have|'ll\s+have)|can\s+i\s+(?:get|have)|could\s+i\s+(?:get|have)|give\s+me|let\s+me\s+(?:get|have)|i'?ll\s+(?:take|get|have)|add)\s+/i;
const TRAILING_FILLER_RE = /\s+(?:please|pls|thanks|thank\s+you)\.?$/i;

/**
 * "2 jollof rice", "jollof rice x2", "I need 2 jollof rice please", "Alright I'll take 3 Milo", or a bare mention
 * (quantity defaults to 1). The quantity can sit ANYWHERE in the sentence — this finds the first standalone number,
 * not just one at the very start or end, then treats everything else as the product mention (nlpCart.ts's
 * `matchCatalogItem` substring-matches the real product name out of that remainder, so a few stray words around it
 * — "alright", "i'll take" — are harmless).
 */
function parseQuantityAndMention(part: string): { mention: string; quantity: number } | null {
  const trimmed = part.trim().replace(LEADING_FILLER_RE, "").replace(TRAILING_FILLER_RE, "").trim();
  if (!trimmed) return null;
  // Lookaround, not \b: "jollof rice x2" has no \w/\W boundary between "x" and "2" (both are word characters), so
  // a plain \b(\d+)\b misses it entirely. This explicitly allows "x"/"×" to sit against the number on either side
  // as well as whitespace/string edges, so "x2", "2 jollof", and "take 3 Milo" all find their number.
  const m = /(?:^|[\sx×])(\d{1,3})(?=[\sx×]|$)/i.exec(trimmed);
  if (!m) return { quantity: 1, mention: trimmed };
  const quantity = Math.max(1, parseInt(m[1], 10));
  const numStart = m.index + (m[0].length - m[1].length); // skip the matched leading separator, if any
  const mention = (trimmed.slice(0, numStart) + " " + trimmed.slice(numStart + m[1].length)).replace(/[x×]/gi, " ").replace(/\s+/g, " ").trim();
  return { quantity, mention: mention || trimmed };
}

/** A numbered catalog listing — the reference point for every reply this module writes when nothing else applies. */
export function renderCatalog(products: DeterministicProduct[]): string {
  const lines = products.slice(0, 20).map((p, i) => {
    const stock = p.stockQuantity > 0 ? "" : " (out of stock)";
    return `${i + 1}. ${p.name} — ${p.currency} ${p.price}${stock}`;
  });
  return lines.join("\n");
}

function renderCart(cart: DeterministicCartLine[]): string {
  if (cart.length === 0) return "Your cart is empty.";
  return cart.map((c) => `• ${c.quantity} × ${c.productName}`).join("\n");
}

/** Catalog sorted cheapest-first, for "cheaper options"/"what's the budget option" — distinct ordering from the
 *  default numbered listing (whatever order the caller's query returned products in). */
function renderCatalogByPrice(products: DeterministicProduct[]): string {
  const sorted = [...products].sort((a, b) => Number(a.price) - Number(b.price));
  return renderCatalog(sorted);
}

const emptyItems = { extractedItems: [], extractedProduct: null, extractedQuantity: null, extractedAddress: null };

// A bare greeting — this module now runs FIRST for every message (2026-09-26), so it needs to sound like it's
// actually talking to someone, not immediately dump a menu at "hi". Deliberately only bare/near-bare greetings —
// "hi, I want 2 milo" should still fall through to the add-to-cart matching below, not get swallowed here.
// NOTE: "hi"/"hello" (unlike "hey"/"yo"/"good morning"/etc.) are in waMenu.ts's own MENU_KEYWORDS — the menu
// engine intercepts those BEFORE this module ever runs, on every channel, at every point in a conversation (not
// just a fresh session — confirmed while adding this: J483 tried "hi" first and it never reached here at all).
// This still matters for the wider set of ordinary greetings that aren't in that fixed list.
const GREETING_RE = /^(?:hi+|hiya|hello+|hey+|yo+|sup|howdy)\s*(?:there)?[.,!]*$|^good\s*(?:morning|afternoon|evening)[.,!]*$/i;

// "How many Milo do you have left" / "is milo in stock" / "do you have peak milk available" — found live
// 2026-09-26: WITHOUT this as its own pattern, checked before the free-text add-to-cart matcher, a stock question
// naming a catalog product got silently treated as an order for it ("how many milo..." substring-contains "milo",
// which the free-text matcher below accepts as a plausible mention) — the customer got "✅ 1 × milo" added to
// their cart instead of an answer.
const STOCK_QUERY_PATTERNS: RegExp[] = [
  /^how\s+many\s+(.+?)\s+(?:do\s+you\s+have|(?:are\s+)?(?:left|remaining)|in\s+stock|available)\S*$/i,
  /^(?:is|are)\s+(?:the\s+)?(.+?)\s+(?:in\s+stock|available)\??$/i,
  /^(?:do\s+you\s+have|got|have\s+you\s+got)\s+(?:any\s+)?(.+?)\s+(?:in\s+stock|left|available)\??$/i,
];

// "show me the milo" / "details on jollof rice" / "tell me more about peak milk" / "picture of milo" / "what does
// the milo look like" — a genuine product-detail lookup, not an order. Also checked before the free-text
// add-to-cart matcher for the same substring-collision reason as stock queries above. Triggers `productImage`
// attachment in nlp.ts (its trigger condition accepts `intent === "product_detail"`).
const DETAIL_PATTERNS: RegExp[] = [
  /^(?:can\s+i\s+|could\s+i\s+|please\s+)*(?:show\s+me|show|see|view)\s+(?:the\s+)?(.+)$/i,
  /^(?:details?|more\s+details?)\s+(?:on|about|for)\s+(?:the\s+)?(.+)$/i,
  /^tell\s+me\s+(?:more\s+)?about\s+(?:the\s+)?(.+)$/i,
  /^(?:got|any|do\s+you\s+have|(?:send|share)\s+(?:me\s+)?(?:a\s+)?)?\s*(?:a\s+)?(?:picture|photo|pic|image)s?\s+of\s+(?:the\s+)?(.+)$/i,
  /^what\s+does\s+(?:the\s+)?(.+?)\s+look\s+like\??$/i,
];

// The same request, but with NO product named — "Can I see the image", "got a pic?", "any photos?" — referring
// to whatever was just discussed, not naming it again. Found live 2026-09-26: a buyer added Peak milk to their
// cart, then asked "Can I see the image" — no DETAIL_PATTERNS regex above has anything to capture from that,
// since there's no product name in the sentence at all. Resolved against the most recently added cart item
// (the natural referent) rather than left to fall through and have the LLM invent an answer ("I can describe
// it" — it can't, and didn't even try) instead of actually sending a photo.
const DETAIL_NO_SUBJECT_RE =
  /^(?:can\s+i\s+see\s+(?:it|that|this|the\s+image|the\s+picture|the\s+photo|an?\s+(?:pic|picture|photo))|(?:got|have\s+you\s+got|do\s+you\s+have)\s+an?\s+(?:pic|picture|photo|image)|(?:send|share)\s+(?:me\s+)?an?\s+(?:pic|picture|photo|image)|any\s+(?:pics?|photos?|pictures?|images?))\.?!?\??$/i;

function firstMention(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(text.trim());
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
}

const CHEAPER_RE =
  /^(?:cheaper\s*(?:options?|ones?)?|anything\s+cheaper|what'?s\s+cheaper|any\s+(?:cheaper|budget)\s*(?:options?)?|budget\s*(?:options?|friendly)?|less\s+expensive|lower[\s-]?priced?\s*(?:options?)?|(?:show\s+me\s+)?(?:the\s+)?cheapest)\.?!?\??$/i;

// Found live 2026-09-26: tapping the menu's "Shop products" button sends the literal fallback text
// `useCases.ts`'s `shopHandler` falls back to when there's nothing else to say — "I want to place an order" —
// as the FIRST message into this module. It doesn't plausibly match any catalog item, so (correctly) it used to
// fall through to "unknown" and escalate to the LLM... which meant the single most common way a buyer starts
// shopping now paid the LLM's full 15-60s latency, reading to the user as "nothing happens." This is the actual
// entry point, not free chat — answer it instantly with the catalog, the same reply the LLM would eventually
// give anyway, minus the wait.
const SHOP_ENTRY_RE =
  /^(?:i\s+want\s+to\s+(?:place\s+an?\s+order|shop|buy\s+something|order\s+something)|i'?d\s+like\s+to\s+(?:order|shop)|let'?s\s+shop|start\s+shopping|shop|browse|what\s+do\s+you\s+(?:have|sell)|what'?s\s+(?:on\s+the\s+menu|available))\.?!?\??$/i;

// Found live 2026-09-26: dispute-raising ("my order never arrived", "you sent the wrong item") was ONLY
// ever reachable through the LLM's `intent: "dispute"` output — it was never added to this classifier
// when the deterministic-first reorder happened, so the single most consequential thing a buyer can say
// (something went wrong with their order) paid the LLM's full latency and, worse, depended on the LLM
// reliably producing that exact intent string under real multi-turn load — the least reliable link in the
// whole pipeline per this same session's own findings. Reuses the SAME reason-keyword phrasing
// server/services/chatDispute.ts's classifyDisputeReason already matches (so a dispute recognized here
// gets the same reason categorization once raiseChatDispute runs), plus an explicit "I want to dispute"
// trigger for when the buyer doesn't describe a specific reason.
const DISPUTE_RE =
  /\b(?:dispute|file a complaint|raise a complaint)\b|not received|never arrived|didn'?t (?:get|receive)|no delivery|haven'?t received|wrong item|wrong order|not what i ordered|different item|damaged|broken|spoilt|bad condition|(?:item|order)s? expired|partial delivery|incomplete order|missing item|some items missing|not happy with my order/i;

/**
 * Classify one message deterministically. `state`/`cart` give just enough context to answer sensibly without an
 * LLM: a bare number (e.g. "2") is read as picking that position from the catalog just shown, not as a quantity
 * with no product.
 */
export function classifyDeterministically(
  text: string,
  products: DeterministicProduct[],
  cart: DeterministicCartLine[],
  state: string,
): DeterministicResult {
  const trimmed = (text ?? "").trim();

  if (GREETING_RE.test(trimmed)) {
    return {
      reply: "Hi there! 👋 What would you like today?",
      intent: "greeting", nextState: "browse", confidence: 1, ...emptyItems,
    };
  }

  if (SHOP_ENTRY_RE.test(trimmed)) {
    return {
      reply: `Sure! Here's what we have:\n\n${renderCatalog(products)}\n\nReply with a number or an item's name to add it.`,
      intent: "browse", nextState: "browse", confidence: 1, ...emptyItems,
    };
  }

  // Checked before CONFIRM_RE/CART_RE and the add-to-cart matcher: a complaint like "you sent the wrong
  // item" must never be read as an attempt to order a "wrong item" product. The `reply` here is a
  // placeholder — nlp.ts's dispute handler overwrites it with buildDisputeReply() once raiseChatDispute
  // actually logs the dispute; it's only ever seen if that call throws.
  if (DISPUTE_RE.test(trimmed)) {
    return {
      reply: "I'm sorry to hear that — let me get this logged for our team to look into.",
      intent: "dispute", nextState: state, confidence: 0.9, ...emptyItems,
    };
  }

  if (CONFIRM_RE.test(trimmed)) {
    if (cart.length === 0) {
      return {
        reply: `Your cart is empty, so there's nothing to confirm yet. Here's what we have:\n\n${renderCatalog(products)}\n\nReply with a number or an item's name to add it.`,
        intent: "unknown", nextState: state, confidence: 1, ...emptyItems,
      };
    }
    return { reply: "", intent: "confirm_order", nextState: "checkout_confirm", confidence: 1, ...emptyItems };
  }

  if (CART_RE.test(trimmed)) {
    return {
      reply: `${renderCart(cart)}\n\nType 'confirm' to check out, or tell me what else to add.`,
      intent: "view_cart", nextState: state, confidence: 1, ...emptyItems,
    };
  }

  const removeMention = cart.length > 0 ? matchRemoveMention(trimmed) : null;
  if (removeMention) {
    return {
      reply: "", intent: "remove_from_cart", nextState: state, confidence: 0.85,
      extractedItems: [{ product: removeMention, quantity: 1 }],
      extractedProduct: removeMention, extractedQuantity: 1, extractedAddress: null,
    };
  }

  // A bare "N" (or "N x qty") picks that position from the catalog just shown, the same way the numbered menu
  // engine treats a digit — never guessed against free text that happens to contain a number elsewhere.
  const bareNumber = /^(\d{1,2})(?:\s*[x×]\s*(\d{1,3}))?$/.exec(trimmed);
  if (bareNumber) {
    const idx = parseInt(bareNumber[1], 10) - 1;
    const product = products[idx];
    if (product) {
      const quantity = bareNumber[2] ? Math.max(1, parseInt(bareNumber[2], 10)) : 1;
      return {
        reply: "", intent: "add_to_cart", nextState: "add_to_cart", confidence: 0.9,
        extractedItems: [{ product: product.name, quantity }],
        extractedProduct: product.name, extractedQuantity: quantity, extractedAddress: null,
      };
    }
    // Out of range — say so rather than silently falling through to a generic miss.
    return {
      reply: `We don't have a #${bareNumber[1]} on the list. Here's what we have:\n\n${renderCatalog(products)}`,
      intent: "unknown", nextState: state, confidence: 0.9, ...emptyItems,
    };
  }

  if (CHEAPER_RE.test(trimmed)) {
    return {
      reply: `Here's what's easiest on the budget:\n\n${renderCatalogByPrice(products)}`,
      intent: "browse", nextState: state, confidence: 0.9, ...emptyItems,
    };
  }

  // Stock questions and product-detail lookups are checked BEFORE the free-text add-to-cart matcher below —
  // both patterns below often literally contain a catalog product's name, which that matcher's own "does this
  // plausibly mention something in the catalog" check would otherwise happily accept as an order for it.
  const stockQuery = firstMention(trimmed, STOCK_QUERY_PATTERNS);
  if (stockQuery) {
    const match = matchCatalogItem(products, stockQuery);
    if (match.status === "matched") {
      const reply = match.product.stockQuantity > 0
        ? `✅ We have ${match.product.stockQuantity} × ${match.product.name} left.`
        : `😔 ${match.product.name} is currently out of stock.`;
      return {
        reply, intent: "product_detail", nextState: state, confidence: 0.9,
        extractedItems: [], extractedProduct: match.product.name, extractedQuantity: null, extractedAddress: null,
      };
    }
    if (match.status === "ambiguous") {
      return {
        reply: `❓ Did you mean: ${match.candidates.map((c) => c.name).join(", ")}?`,
        intent: "unknown", nextState: state, confidence: 0.5, ...emptyItems,
      };
    }
    // not_found — fall through; the catch-all catalog listing at the end is more useful than a dead end here.
  }

  const detailQuery = firstMention(trimmed, DETAIL_PATTERNS);
  if (detailQuery) {
    const match = matchCatalogItem(products, detailQuery);
    if (match.status === "matched") {
      const stock = match.product.stockQuantity > 0 ? "in stock" : "out of stock";
      return {
        reply: `${match.product.name} — ${match.product.currency} ${match.product.price} (${stock})`,
        intent: "product_detail", nextState: state, confidence: 0.9,
        extractedItems: [], extractedProduct: match.product.name, extractedQuantity: null, extractedAddress: null,
      };
    }
    if (match.status === "ambiguous") {
      return {
        reply: `❓ Did you mean: ${match.candidates.map((c) => c.name).join(", ")}?`,
        intent: "unknown", nextState: state, confidence: 0.5, ...emptyItems,
      };
    }
    // not_found — fall through (e.g. "show me the manager" isn't a product lookup at all).
  }

  if (cart.length > 0 && DETAIL_NO_SUBJECT_RE.test(trimmed)) {
    const lastMentioned = cart[cart.length - 1];
    const match = matchCatalogItem(products, lastMentioned.productName);
    if (match.status === "matched") {
      const stock = match.product.stockQuantity > 0 ? "in stock" : "out of stock";
      return {
        reply: `${match.product.name} — ${match.product.currency} ${match.product.price} (${stock})`,
        intent: "product_detail", nextState: state, confidence: 0.8,
        extractedItems: [], extractedProduct: match.product.name, extractedQuantity: null, extractedAddress: null,
      };
    }
    // Cart line doesn't resolve to a current catalog product (renamed/removed since) — fall through rather than
    // guess.
  }

  // Free-text mention(s): "2 jollof rice", "jollof rice and a coke", "chicken x2, rice x1".
  const parts = trimmed.split(/\s*,\s*|\s+and\s+|\s*\+\s*/i).map(parseQuantityAndMention).filter((p): p is { mention: string; quantity: number } => !!p && p.mention.length > 1);
  if (parts.length > 0) {
    // EVERY part must plausibly name something in the catalog (substring either way), not just one — otherwise
    // this is ordinary conversation ("how are you", "is the shop open") that deserves the catalog, not a guessed
    // add. Was `.some()` until 2026-09-26: with this module now running FIRST for every message (not just on LLM
    // failure), a single confidently-matched item was enough to commit the WHOLE message here even when another
    // part was garbled beyond this module's substring matching — a multi-item voice-transcription mention like
    // "2 jollof rice and 1 chicken [trailing noise]" confidently added the rice and gave a confusing "couldn't
    // find" for the second item, instead of deferring the ambiguous case to the LLM's actual understanding, the
    // way it always could when this only ran as the fallback. `.every()` only changes behavior for a MIXED
    // valid/invalid multi-item message; a genuine multi-item order (all parts real) is unaffected either way.
    const catalogNames = products.map((p) => p.name.toLowerCase());
    const plausible = parts.every((p) => {
      const q = p.mention.toLowerCase();
      return catalogNames.some((n) => n.includes(q) || q.includes(n));
    });
    if (plausible) {
      return {
        reply: "", intent: "add_to_cart", nextState: "add_to_cart", confidence: 0.7,
        extractedItems: parts.map((p) => ({ product: p.mention, quantity: p.quantity })),
        extractedProduct: parts[0].mention, extractedQuantity: parts[0].quantity, extractedAddress: null,
      };
    }
  }

  return {
    reply: `I can't quite process free chat right now, but I can still take your order. Here's what we have:\n\n${renderCatalog(products)}\n\nReply with a number or an item's name, or type 'cart'/'confirm' when you're ready.`,
    intent: "unknown", nextState: state, confidence: 0.3, ...emptyItems,
  };
}
