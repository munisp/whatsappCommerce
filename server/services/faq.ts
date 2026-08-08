/**
 * faq.ts — Per-tenant FAQ knowledge base, answered before the NLP/handoff
 * fallback burns an LLM call or an agent's time.
 *
 * Storage: tenants.settings.faq = [{ q, a }] (managed via the tenantConfig
 * router — see getFaq/setFaq there). Runtime matching is normalized-substring
 * first, then a token-overlap fuzzy score (same spirit as nlpCart catalog
 * matching): exact containment wins; otherwise ≥60% of the question's content
 * tokens must appear in the inbound text (min 2 shared tokens).
 */

export interface FaqEntry {
  q: string;
  a: string;
}

export interface FaqMatch {
  entry: FaqEntry;
  /** 1 = substring hit, <1 = fuzzy token-overlap hit. */
  score: number;
}

/** Parse settings.faq defensively — drop malformed entries. */
export function parseFaqSettings(settings: Record<string, unknown> | null | undefined): FaqEntry[] {
  const raw = (settings as any)?.faq;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e): e is FaqEntry =>
        !!e && typeof e === "object" &&
        typeof (e as any).q === "string" && (e as any).q.trim().length > 0 &&
        typeof (e as any).a === "string" && (e as any).a.trim().length > 0,
    )
    .map((e) => ({ q: (e as any).q.trim(), a: (e as any).a.trim() }));
}

/** Lowercase, strip diacritics + punctuation, collapse whitespace. */
export function normalizeFaqText(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokens that carry no question meaning — excluded from fuzzy scoring. */
const FAQ_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "do", "does", "i", "you", "your", "my",
  "me", "we", "to", "of", "in", "on", "for", "and", "or", "can", "how",
  "what", "when", "where", "please", "it", "this", "that", "with",
]);

function contentTokens(normalized: string): string[] {
  return normalized.split(" ").filter((t) => t.length > 1 && !FAQ_STOPWORDS.has(t));
}

/**
 * Match an inbound buyer message against the tenant FAQ list.
 * Returns the best entry (highest score) or null on a miss.
 */
export function matchFaq(faqs: FaqEntry[], text: string): FaqMatch | null {
  const nq = normalizeFaqText(text);
  if (!nq) return null;
  const textTokens = new Set(contentTokens(nq));

  let best: FaqMatch | null = null;
  for (const entry of faqs) {
    const ne = normalizeFaqText(entry.q);
    if (!ne) continue;

    // Substring containment either way (short inbound questions like
    // "delivery fee?" should hit "What is your delivery fee?").
    if (ne.includes(nq) || (nq.length >= 4 && nq.includes(ne))) {
      const score = 1;
      if (!best || score > best.score) best = { entry, score };
      continue;
    }

    // Fuzzy: fraction of the FAQ question's content tokens present in the text.
    const qTokens = contentTokens(ne);
    if (qTokens.length === 0) continue;
    const shared = qTokens.filter((t) => textTokens.has(t));
    const coverage = shared.length / qTokens.length;
    if (shared.length >= 2 && coverage >= 0.6) {
      const score = 0.5 + coverage / 2; // 0.8–1.0 range, below exact substring
      if (!best || score > best.score) best = { entry, score };
    }
  }
  return best;
}
