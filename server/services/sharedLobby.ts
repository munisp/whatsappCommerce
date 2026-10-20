/**
 * sharedLobby.ts — the shared number's lobby: what a buyer talks to before they pick a shop, and whenever they ask
 * for the stores again.
 *
 * A buyer can talk to it like a person: "hi", "show me the shops", "who sells rice?", "I'm looking for sneakers",
 * "lagos fresh market". The text is read in three steps, cheapest first:
 *   1. plain rules for the common phrasings (parseLobbyText) — instant, and the same with or without the model;
 *   2. a shop's own name or code typed on its own goes to that shop, and short free text is tried as a search;
 *   3. anything still not understood is put to the language model (classifyWithModel) under a few-second budget,
 *      and if it does not answer the buyer gets the welcome with its buttons, never silence.
 *
 * The directory lists the shops the shared number serves that have something to sell: active or on trial, no
 * WhatsApp number of their own, at least one active product, and not hidden by the shop (settings.directory.listed
 * = false). A shop's categories are taken from its products, since shops carry no category of their own.
 *
 * Inside a shop every message still goes to that shop's own assistant; only the explicit "leave" phrasings
 * (isLeaveShopText) bring the buyer back here, so "find red shoes" in a shop searches that shop.
 */
import { sql } from "drizzle-orm";

type Db = any;

// ── Reading what the buyer typed ────────────────────────────────────────────

export type LobbyIntent =
  | { kind: "greet" }
  | { kind: "browse" }
  | { kind: "mine" }
  | { kind: "search"; query: string };

const clean = (t: string) => String(t ?? "").trim().replace(/\s+/g, " ").replace(/[\s.!?,]+$/g, "");

const GREET_RE = /^(?:hi+|hello+|hey+|hiya|howdy|yo|hola|good (?:morning|afternoon|evening|day)|start|menu|help|get started|hi there|hello there)$/i;
const MINE_RE = /^(?:my (?:shops|stores)|recent(?: shops| stores)?|switch(?: shop| store)?|shops i(?:'ve| have) visited)$/i;
const BROWSE_RE = new RegExp(
  "^(?:(?:show|list|see|view|browse|open|give)(?: me)?(?: (?:all|the|your))*(?: of)?(?: the)? )?" +
    "(?:all )?(?:stores?|shops?|businesses|vendors|sellers|merchants|directory)(?: (?:list|available|near me|here))?$" +
    "|^(?:what|which) (?:stores|shops|businesses|vendors|sellers)(?: (?:do you have|are (?:there|available|here)|can i (?:buy from|shop (?:at|from|with))))?$" +
    "|^(?:browse|browse stores|browse shops|see all|explore|where can i shop)$",
  "i",
);
const SEARCH_RES = [
  /^(?:find|search|search for|look for|looking for|i(?:'m| am) looking for|i want(?: to buy)?|i(?:'d| would) like(?: to buy)?|i need|do you have|does anyone (?:sell|have)|anyone (?:selling|sell)|who sells|who has|where can i (?:buy|get|find)|where do i (?:buy|get)|buy|get me)\s+(.+)$/i,
  /^(?:shops?|stores?|vendors|sellers|businesses)\s+(?:that|which|who)?\s*(?:sell|sells|selling|have|has|with)\s+(.+)$/i,
  /^(?:which|what) (?:shops?|stores?|vendors|sellers|businesses) (?:sell|sells|have|has) (.+)$/i,
];
const FILLER_RE = /^(?:a|an|some|the|any|me|for)\s+/i;

/** The search words in a query: "some red sneakers" → "red sneakers". */
export function searchQueryOf(text: string): string {
  let q = clean(text);
  while (FILLER_RE.test(q)) q = q.replace(FILLER_RE, "");
  return q.slice(0, 60);
}

/** The plain phrasings, read without the model. Null when none fits. */
export function parseLobbyText(text: string): LobbyIntent | null {
  const t = clean(text);
  if (!t) return { kind: "greet" };
  if (GREET_RE.test(t)) return { kind: "greet" };
  if (MINE_RE.test(t)) return { kind: "mine" };
  if (BROWSE_RE.test(t)) return { kind: "browse" };
  for (const re of SEARCH_RES) {
    const m = re.exec(t);
    if (m) {
      const query = searchQueryOf(m[1]);
      if (query.length >= 2) return { kind: "search", query };
    }
  }
  return null;
}

/** Inside a shop: the phrasings that mean "take me back to the stores". Anything else stays with the shop. */
export function isLeaveShopText(text: string): boolean {
  return /^(?:stores|shops|all stores|all shops|other stores|other shops|more stores|more shops|browse stores|browse shops|see all stores|my shops|my stores|switch|switch shop|switch store|change shop|change store|leave|leave shop|leave store|exit|exit shop|exit store|back to stores|back to shops|lobby)$/i
    .test(clean(text));
}

/**
 * Inside a shop: is the buyer asking about OTHER shops? ("can you check stores around me that sell this?", "which
 * other shops have pepsi", "who else sells rice"). Then the platform answers with a search across the stores, and
 * the buyer stays with their shop until they pick another. Returns the search words ("" when there are none, e.g.
 * "show me other shops" — then the directory), or null when the message is for the shop itself ("find red shoes").
 */
const CROSS_SHOP_RE = new RegExp(
  "\\b(?:other|another|more|different)\\s+(?:stores?|shops?|sellers?|vendors?|businesses)\\b" +
    "|\\b(?:stores?|shops?|sellers?|vendors?)\\s+(?:around|near|close to|nearby)\\b" +
    "|\\b(?:stores?|shops?|sellers?|vendors?)\\s+(?:that|which|who)\\s+(?:sell|sells|selling|have|has|stock|stocks|carry|carries)\\b" +
    "|\\bwho\\s+else\\s+(?:sells?|has|have)\\b|\\bwhere\\s+else\\s+can\\s+i\\s+(?:buy|get|find)\\b" +
    "|\\b(?:any|which)\\s+(?:other\\s+)?(?:stores?|shops?|sellers?|vendors?)\\s+(?:sell|sells|have|has)\\b",
  "i",
);
const PRONOUN_RE = /^(?:this|that|it|them|these|those|one|any|some)$/i;

export function crossShopQuery(text: string): string | null {
  const t = clean(text);
  if (!CROSS_SHOP_RE.test(t)) return null;
  // 1. What follows "sell / have / stock": "...shops that sell ankara fabric" -> "ankara fabric".
  const after = /\b(?:sell|sells|selling|have|has|stock|stocks|carry|carries|buy|get|find)\s+(.+)$/i.exec(t);
  if (after) {
    const q = searchQueryOf(after[1].replace(/\b(?:around|near|close to)\s+me\b.*$/i, "").replace(/\b(?:please|pls|abeg)\b/gi, ""));
    if (q.length >= 2 && !PRONOUN_RE.test(q)) return q;
  }
  // 2. Otherwise what came before the question: "some pepsi can you check stores around me that sell this" -> "pepsi".
  const before = t.split(/\b(?:can|could|would|will)\s+you\b|\b(?:check|find|search|show|look)\b|\b(?:other|another|any|which)\s+(?:stores?|shops?)\b|\b(?:stores?|shops?)\b/i)[0] ?? "";
  const q = searchQueryOf(before.replace(/\b(?:i\s+(?:want|need)(?:\s+to\s+buy)?|please|pls|abeg|hi|hello)\b/gi, ""));
  return q.length >= 2 && !PRONOUN_RE.test(q) ? q : "";
}

// ── The directory ────────────────────────────────────────────────────────────

export interface DirectoryShop {
  id: string;
  name: string;
  code: string;
  products: number;
  categories: string[];
  /** Search results only: product names that matched. */
  matches?: string[];
}

const rowsOf = (res: any): any[] => (Array.isArray(res) ? res : (res?.rows ?? []));

// The shops the shared number serves (open, no number of their own) — a buyer can always go back to one they visited.
const SERVED = sql`
  t.status IN ('active', 'trial')
  AND (t."whatsappPhoneNumberId" IS NULL OR coalesce(t.settings->'whatsapp'->>'accessToken', '') = '')`;
// ...and of those, the ones the directory lists. Kept as one fragment so the directory and search agree.
const LISTED = sql`${SERVED}
  AND coalesce(t.settings->'directory'->>'listed', 'true') <> 'false'
  AND EXISTS (SELECT 1 FROM products p0 WHERE p0."tenantId" = t.id AND p0.status = 'active')`;

function toShop(r: any): DirectoryShop {
  return {
    id: String(r.id),
    name: String(r.name),
    code: String(r.shopCode || r.slug).toLowerCase(),
    products: Number(r.products ?? 0),
    categories: (Array.isArray(r.categories) ? r.categories : String(r.categories ?? "").split("|"))
      .map((c: string) => String(c ?? "").trim()).filter(Boolean).slice(0, 3),
    matches: r.matches ? String(r.matches).split("|").filter(Boolean).slice(0, 3) : undefined,
  };
}

const SHOP_FIELDS = sql`
  t.id, t.name, t.slug, t."shopCode",
  (SELECT count(*) FROM products p WHERE p."tenantId" = t.id AND p.status = 'active') AS products,
  (SELECT string_agg(c, '|') FROM (
     SELECT p.category AS c FROM products p
     WHERE p."tenantId" = t.id AND p.status = 'active' AND coalesce(p.category, '') <> ''
     GROUP BY p.category ORDER BY count(*) DESC, p.category LIMIT 3) cats) AS categories`;

/** One page of the directory, busiest shops first, and how many shops are listed in all. */
export async function directoryPage(db: Db, offset: number, limit: number): Promise<{ shops: DirectoryShop[]; total: number }> {
  const res = await db.execute(sql`
    SELECT ${SHOP_FIELDS}, count(*) OVER () AS total
    FROM tenants t WHERE ${LISTED}
    ORDER BY products DESC, lower(t.name)
    OFFSET ${Math.max(0, offset)} LIMIT ${Math.max(1, limit)}`);
  const rows = rowsOf(res);
  if (!rows.length && offset > 0) {
    const all = rowsOf(await db.execute(sql`SELECT count(*) AS n FROM tenants t WHERE ${LISTED}`));
    return { shops: [], total: Number(all[0]?.n ?? 0) };
  }
  return { shops: rows.map(toShop), total: Number(rows[0]?.total ?? 0) };
}

/** The buyer's recently visited shops by id, in the order given: every shop still served on the shared number, listed
 *  in the directory or not (a hidden or not-yet-stocked shop they reached by its own link is still theirs to go back to). */
export async function listedShopsById(db: Db, ids: string[]): Promise<DirectoryShop[]> {
  if (!ids.length) return [];
  const res = await db.execute(sql`
    SELECT ${SHOP_FIELDS} FROM tenants t
    WHERE ${SERVED} AND t.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  const byId = new Map(rowsOf(res).map((r) => [String(r.id), toShop(r)]));
  return ids.map((i) => byId.get(i)).filter((s): s is DirectoryShop => !!s);
}

// Words that say how someone asks, not what they want ("i need to have drink today" is a search for "drink").
const FILLER_WORDS = new Set(("a an and any are can could do does for from get give got have has i im i'm is it its just like " +
  "looking me my need of on or please pls abeg some something someone that the them this to today tomorrow now " +
  "want wanna would you your u us we there here where who which what with buy order cold hot nice good").split(" "));

/** The words a search looks for: filler dropped, a plural also matched as its singular ("chargers" → "charger"). */
export function searchWords(query: string): string[] {
  return searchQueryOf(query).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/)
    .filter((w) => w.length >= 2 && !FILLER_WORDS.has(w))
    .map((w) => (w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w))
    .slice(0, 5);
}

/**
 * Shops for a search. Every word must appear in the shop's name or code, or in one product's name, category or
 * description; when no shop has them all, shops matching the most of them come back instead.
 */
export async function searchShops(db: Db, query: string, limit = 10): Promise<DirectoryShop[]> {
  const words = searchWords(query);
  if (!words.length) return [];
  const all = await searchShopsBy(db, words, "all", limit);
  return all.length || words.length === 1 ? all : searchShopsBy(db, words, "any", limit);
}

async function searchShopsBy(db: Db, words: string[], mode: "all" | "any", limit: number): Promise<DirectoryShop[]> {
  const like = (w: string) => `%${w.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
  const joiner = mode === "all" ? sql` AND ` : sql` OR `;
  const productHit = sql.join(words.map((w) => sql`(
      lower(p.name) LIKE ${like(w)} OR lower(coalesce(p.category, '')) LIKE ${like(w)}
      OR lower(coalesce(p.description, '')) LIKE ${like(w)})`), joiner);
  const shopHit = sql.join(words.map((w) => sql`(lower(t.name) LIKE ${like(w)} OR lower(coalesce(t."shopCode", t.slug)) LIKE ${like(w)})`), joiner);
  const res = await db.execute(sql`
    SELECT * FROM (
      SELECT ${SHOP_FIELDS},
        (${shopHit}) AS name_hit,
        (SELECT count(*) FROM products p WHERE p."tenantId" = t.id AND p.status = 'active' AND ${productHit}) AS hits,
        (SELECT string_agg(n, '|') FROM (
           SELECT p.name AS n FROM products p WHERE p."tenantId" = t.id AND p.status = 'active' AND ${productHit}
           ORDER BY p.name LIMIT 3) m) AS matches
      FROM tenants t WHERE ${LISTED}) s
    WHERE name_hit OR hits > 0
    ORDER BY name_hit DESC, hits DESC, lower(name)
    LIMIT ${limit}`);
  return rowsOf(res).map(toShop);
}

/** A listed shop whose name or code is exactly what the buyer typed ("lagos fresh market", "adire"). */
export async function shopNamed(db: Db, text: string): Promise<DirectoryShop | null> {
  const t = clean(text).toLowerCase();
  if (t.length < 2 || t.length > 80) return null;
  const res = await db.execute(sql`
    SELECT ${SHOP_FIELDS} FROM tenants t
    WHERE ${LISTED} AND (lower(t.name) = ${t} OR lower(coalesce(t."shopCode", '')) = ${t} OR lower(t.slug) = ${t}
      OR lower(regexp_replace(t.name, '[^a-zA-Z0-9]+', '', 'g')) = ${t.replace(/[^a-z0-9]+/g, "")})
    LIMIT 1`);
  const r = rowsOf(res)[0];
  return r ? toShop(r) : null;
}

// ── Rendering (WhatsApp limits: list row title 24, description 72, button title 20, ≤10 rows) ──────────────

export const PICK_PREFIX = "shared_pick:";
export const MORE_PREFIX = "shared_more:";
export const LOBBY_BROWSE = "lobby:browse";
export const LOBBY_SEARCH = "lobby:search";
export const LOBBY_MINE = "lobby:mine";

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function shopRow(s: DirectoryShop): { id: string; title: string; description: string } {
  const what = s.matches?.length
    ? s.matches.join(", ")
    : s.categories.length ? s.categories.join(" · ") : `${s.products} product${s.products === 1 ? "" : "s"}`;
  return { id: `${PICK_PREFIX}${s.code}`, title: cut(s.name, 24), description: cut(what, 72) };
}

/** The welcome: a short hello and the three things the buyer can do. "My shops" only once they've visited one. */
export function welcomePayload(platformName: string, opts: { visited: boolean; again?: boolean }): Record<string, unknown> {
  const body = opts.again
    ? `Sorry, I didn't quite catch that. 🙂\n\nYou can *browse* the shops on ${platformName}, *search* for something ` +
      `you want (like "rice" or "sneakers"), or type a shop's name.`
    : `Hi! 👋 Welcome to *${platformName}*.\n\nI can help you find a shop and buy from it right here on WhatsApp. ` +
      `Browse the stores, search for something you want, or just tell me what you're looking for.`;
  const buttons = [
    { type: "reply", reply: { id: LOBBY_BROWSE, title: "🛍️ Browse stores" } },
    { type: "reply", reply: { id: LOBBY_SEARCH, title: "🔎 Search" } },
    ...(opts.visited ? [{ type: "reply", reply: { id: LOBBY_MINE, title: "⭐ My shops" } }] : []),
  ];
  return { type: "interactive", interactive: { type: "button", body: { text: body }, action: { buttons } } };
}

export function searchPromptText(): string {
  return `What are you looking for? 🔎\n\nType a product (for example *rice*, *sneakers* or *phone charger*) or the name of a shop.`;
}

/**
 * The directory page as a WhatsApp list: the buyer's recent shops first (on the first page), then the rest, with
 * "More stores…" as the last row when there are more. Null when nothing is listed.
 */
export function directoryPayload(
  platformName: string, page: DirectoryShop[], total: number, offset: number, recent: DirectoryShop[] = [],
): Record<string, unknown> | null {
  const recentRows = offset === 0 ? recent.slice(0, 3) : [];
  const recentIds = new Set(recentRows.map((s) => s.id));
  const hasMore = offset + page.length < total;
  const room = 10 - recentRows.length - (hasMore ? 1 : 0);
  const rest = page.filter((s) => !recentIds.has(s.id)).slice(0, room);
  if (!recentRows.length && !rest.length) return null;
  const sections: any[] = [];
  if (recentRows.length) sections.push({ title: "Recently visited", rows: recentRows.map(shopRow) });
  const allRows = rest.map(shopRow);
  if (hasMore) allRows.push({ id: `${MORE_PREFIX}${offset + page.length}`, title: "More stores…", description: `${total - offset - page.length} more on ${cut(platformName, 40)}` });
  if (allRows.length) sections.push({ title: offset ? "More stores" : "All stores", rows: allRows });
  const shown = offset + page.length;
  const body = offset
    ? `More shops on *${platformName}* (${offset + 1}–${shown} of ${total}). Pick one to start shopping.`
    : `Here are the shops on *${platformName}* 🛍️\n\nPick one to start shopping${total > shown ? ` (showing ${shown} of ${total})` : ""}. ` +
      `You can also just tell me what you're looking for.`;
  return {
    type: "interactive",
    interactive: { type: "list", body: { text: body }, action: { button: "View stores", sections } },
  };
}

export function searchPayload(query: string, shops: DirectoryShop[]): Record<string, unknown> {
  if (!shops.length) {
    return {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: `I couldn't find a shop with “${cut(query, 40)}” yet. 😕\n\nTry another word, or browse all the stores.` },
        action: { buttons: [
          { type: "reply", reply: { id: LOBBY_BROWSE, title: "🛍️ Browse stores" } },
          { type: "reply", reply: { id: LOBBY_SEARCH, title: "🔎 Search again" } },
        ] },
      },
    };
  }
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: `Here's what I found for “${cut(query, 40)}” 🔎\n\nPick a shop to see what they have.` },
      action: { button: "View shops", sections: [{ title: "Shops", rows: shops.slice(0, 10).map(shopRow) }] },
    },
  };
}

// ── The model, for what the rules don't catch ────────────────────────────────

/**
 * Ask the language model what a lobby message wants. Null when it can't say in time (or isn't configured), so the
 * caller falls back to the welcome. The model only picks between the same few things the buttons offer.
 */
export async function classifyWithModel(text: string, timeoutMs = 6000): Promise<LobbyIntent | null> {
  try {
    const { invokeLLM } = await import("../_core/llm");
    const ask = invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You route messages for a WhatsApp marketplace where buyers pick a shop to buy from. " +
            "Decide what the buyer wants. intent is one of: greet (hello, small talk, asking what this is), " +
            "browse (wants to see the list of shops), mine (wants the shops they used before), " +
            "search (names a product, product type or shop they want — put just those words in query), " +
            "other (anything else). Respond with JSON only.",
        },
        { role: "user", content: clean(text).slice(0, 300) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "lobby_intent",
          strict: true,
          schema: {
            type: "object",
            properties: { intent: { type: "string", enum: ["greet", "browse", "mine", "search", "other"] }, query: { type: "string" } },
            required: ["intent", "query"],
            additionalProperties: false,
          },
        },
      },
    } as any);
    const res: any = await Promise.race([ask, new Promise((r) => setTimeout(() => r(null), timeoutMs))]);
    const raw = res?.choices?.[0]?.message?.content;
    if (!raw) return null;
    const out = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
    if (out.intent === "search") {
      const query = searchQueryOf(String(out.query ?? ""));
      return query.length >= 2 ? { kind: "search", query } : null;
    }
    if (out.intent === "greet" || out.intent === "browse" || out.intent === "mine") return { kind: out.intent };
    return null;
  } catch (e: any) {
    console.error("[shared-lobby] model unavailable:", e?.message);
    return null;
  }
}
