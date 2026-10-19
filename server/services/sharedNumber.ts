/**
 * sharedNumber.ts — one platform WhatsApp number for every shop that has no number of its own.
 *
 * A buyer reaches a shop by sending its code — "SHOP ADIRE", normally from the shop's wa.me link with the text
 * prefilled — or by talking to the lobby (sharedLobby.ts): browsing the stores, searching for a product, or typing
 * a shop's name. Every later message goes to the shop they last reached, until they send another code or ask for
 * the stores again. Shops with their own number keep it; a code for one of those gets a link to that number.
 *
 * Inbound: the Meta webhook calls routeSharedInbound for every message on SHARED_WA_PHONE_NUMBER_ID, BEFORE the
 * normal per-tenant pipeline. It either answers the message itself (welcome, unknown code, stores list) or hands
 * back the tenant the message belongs to, and the pipeline then runs exactly as it does for a shop's own number.
 *
 * Outbound: a shop without its own number sends through the shared number's credentials (waSender's
 * resolveTenantWaCredentials returns source "shared"). Every such message names the shop, so the buyer always
 * knows who they're talking to (WhatsApp's Business Messaging Policy forbids misleading a customer about the
 * business they're dealing with), and every button id carries the shop's code, so a tap on an older message from
 * shop A still reaches shop A even after the buyer moved on to shop B.
 *
 * Off unless SHARED_WA_PHONE_NUMBER_ID and SHARED_WA_TOKEN are both set.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { sharedNumberVisits, tenants } from "../../drizzle/schema";
import {
  LOBBY_BROWSE, LOBBY_MINE, LOBBY_SEARCH, MORE_PREFIX, PICK_PREFIX,
  classifyWithModel, directoryPage, directoryPayload, isLeaveShopText, listedShopsById, parseLobbyText,
  searchPayload, searchPromptText, searchShops, shopNamed, welcomePayload, type LobbyIntent,
} from "./sharedLobby";

type Db = any;


// The dedupe key for a message on the shared number. processed_webhook_events.id is 64 characters and Meta's
// message ids (wamid.…) are already about 60, so the id is hashed: "shared:" + 56 hex = 63, unique per message.
export function sharedClaimId(messageId: string): string {
  return "shared:" + createHash("sha256").update(messageId).digest("hex").slice(0, 56);
}

export interface SharedNumberConfig {
  phoneNumberId: string;
  accessToken: string;
  /** Digits only, for wa.me links (SHARED_WA_DISPLAY_NUMBER). Empty → no links can be built. */
  displayNumber: string;
  /** How the platform introduces itself (SHARED_WA_PLATFORM_NAME). */
  platformName: string;
}

export function sharedNumberConfig(): SharedNumberConfig | null {
  const phoneNumberId = (process.env.SHARED_WA_PHONE_NUMBER_ID ?? "").trim();
  const accessToken = (process.env.SHARED_WA_TOKEN ?? "").trim();
  if (!phoneNumberId || !accessToken) return null;
  return {
    phoneNumberId,
    accessToken,
    displayNumber: (process.env.SHARED_WA_DISPLAY_NUMBER ?? "").replace(/\D/g, ""),
    platformName: (process.env.SHARED_WA_PLATFORM_NAME ?? "").trim() || "our marketplace",
  };
}

export function isSharedNumber(phoneNumberId: string | null | undefined): boolean {
  const cfg = sharedNumberConfig();
  return !!cfg && !!phoneNumberId && phoneNumberId === cfg.phoneNumberId;
}

// ── Shop codes ───────────────────────────────────────────────────────────────

export const SHOP_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,31}$/;

/** "SHOP ADIRE", "shop adire", "Store adire" → "adire". Anything else → null. */
export function parseShopCommand(text: string): string | null {
  const m = /^\s*(?:shop|store)\s+@?([A-Za-z0-9][A-Za-z0-9-]{1,31})\s*$/i.exec(text ?? "");
  return m ? m[1].toLowerCase() : null;
}

/** "stores", "shops", "switch", "my shops" → true: show the buyer the shops they've visited. */
export function isStoresCommand(text: string): boolean {
  return /^\s*(?:stores|shops|switch|switch shop|my shops|my stores)\s*$/i.test(text ?? "");
}

/** The code a shop advertises: its shopCode, or its slug when it hasn't set one (the slug works either way). */
export function shopCodeOf(t: { shopCode?: string | null; slug: string }): string {
  return (t.shopCode || t.slug).toLowerCase();
}

/** wa.me link that opens the shared number with "SHOP <code>" already typed. Null when no display number is set. */
export function shopLink(code: string, cfg: SharedNumberConfig | null = sharedNumberConfig()): string | null {
  if (!cfg?.displayNumber) return null;
  return `https://wa.me/${cfg.displayNumber}?text=${encodeURIComponent(`SHOP ${code.toUpperCase()}`)}`;
}

// ── Button ids carry the shop that sent them ────────────────────────────────
// "s.<code>.<original id>". WhatsApp allows 256 characters for a button id and 200 for a list row id; the prefix
// is at most 35, and ids already near the limit are left untagged rather than truncated (a truncated id would be
// a different id). An untagged tap simply goes to the buyer's current shop, which is the pre-shared behaviour.
const TAG_RE = /^s\.([a-z0-9][a-z0-9-]{1,31})\.([\s\S]+)$/;

export function tagReplyId(code: string, id: string, limit: number): string {
  if (untagReplyId(id)) return id; // already tagged (a resend of a logged payload)
  const tagged = `s.${code.toLowerCase()}.${id}`;
  return tagged.length <= limit ? tagged : id;
}

export function untagReplyId(id: string): { code: string; id: string } | null {
  const m = TAG_RE.exec(id ?? "");
  return m ? { code: m[1], id: m[2] } : null;
}

// ── Tenant lookups ───────────────────────────────────────────────────────────

interface ShopRow {
  id: string;
  name: string;
  slug: string;
  shopCode: string | null;
  status: unknown;
  whatsappPhoneNumberId: string | null;
  settings: unknown;
}

const shopColumns = {
  id: tenants.id,
  name: tenants.name,
  slug: tenants.slug,
  shopCode: tenants.shopCode,
  status: tenants.status,
  whatsappPhoneNumberId: tenants.whatsappPhoneNumberId,
  settings: tenants.settings,
};

async function shopByCode(db: Db, code: string): Promise<ShopRow | null> {
  const c = code.toLowerCase();
  const [byCode] = await db.select(shopColumns).from(tenants).where(sql`lower(${tenants.shopCode}) = ${c}`).limit(1);
  if (byCode) return byCode;
  // A slug always reaches its shop, even after the shop sets a custom code, so links and QR codes printed
  // with the slug keep working (and no other shop can take it: setShopCode refuses another shop's slug).
  const [bySlug] = await db.select(shopColumns).from(tenants).where(sql`lower(${tenants.slug}) = ${c}`).limit(1);
  return bySlug ?? null;
}

async function shopById(db: Db, id: string): Promise<ShopRow | null> {
  const [t] = await db.select(shopColumns).from(tenants).where(eq(tenants.id, id)).limit(1);
  return t ?? null;
}

/** True when the shop sends from a WhatsApp number of its own (and so is NOT served on the shared number). */
export function hasOwnNumber(t: { whatsappPhoneNumberId?: string | null; settings?: unknown }): boolean {
  const token = ((t.settings as any)?.whatsapp?.accessToken ?? "") as string;
  return !!t.whatsappPhoneNumberId && !!token;
}

function reachable(t: ShopRow): boolean {
  const s = String(t.status ?? "");
  return s === "active" || s === "trial";
}

async function touchVisit(db: Db, buyerPhone: string, tenantId: string): Promise<void> {
  const now = new Date();
  await db.insert(sharedNumberVisits)
    .values({ buyerPhone, tenantId, firstVisitAt: now, lastActiveAt: now })
    .onConflictDoUpdate({ target: [sharedNumberVisits.buyerPhone, sharedNumberVisits.tenantId], set: { lastActiveAt: now } });
}

async function currentShop(db: Db, buyerPhone: string): Promise<ShopRow | null> {
  const [v] = await db.select({ tenantId: sharedNumberVisits.tenantId }).from(sharedNumberVisits)
    .where(eq(sharedNumberVisits.buyerPhone, buyerPhone))
    .orderBy(desc(sharedNumberVisits.lastActiveAt)).limit(1);
  return v ? shopById(db, v.tenantId) : null;
}

async function recentShops(db: Db, buyerPhone: string, limit = 10): Promise<ShopRow[]> {
  const rows = await db.select({ tenantId: sharedNumberVisits.tenantId }).from(sharedNumberVisits)
    .where(eq(sharedNumberVisits.buyerPhone, buyerPhone))
    .orderBy(desc(sharedNumberVisits.lastActiveAt)).limit(limit);
  const shops: ShopRow[] = [];
  for (const r of rows) {
    const t = await shopById(db, r.tenantId);
    if (t && reachable(t) && !hasOwnNumber(t)) shops.push(t);
  }
  return shops;
}

// ── Platform's own replies (sent as the platform, not as any shop) ──────────

async function postShared(cfg: SharedNumberConfig, to: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...payload }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`shared-number send ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

async function replyText(cfg: SharedNumberConfig, to: string, body: string): Promise<void> {
  await postShared(cfg, to, { type: "text", text: { preview_url: true, body } })
    .catch((e: any) => console.error("[shared-number] reply failed:", e?.message));
}

function welcomeText(cfg: SharedNumberConfig): string {
  return `Welcome to ${cfg.platformName}! 🛍️\n\n` +
    `Send *STORES* to see every shop, tell me what you're looking for (like "rice" or "sneakers"), ` +
    `or send *SHOP* followed by a shop's code (for example: SHOP ADIRE).`;
}

async function replyStores(cfg: SharedNumberConfig, to: string, shops: ShopRow[]): Promise<void> {
  if (shops.length === 0) {
    await replyText(cfg, to, `You haven't visited any shops here yet.\n\n${welcomeText(cfg)}`);
    return;
  }
  const rows = shops.slice(0, 10).map((t) => ({
    id: `${PICK_PREFIX}${shopCodeOf(t)}`,
    title: t.name.length > 24 ? `${t.name.slice(0, 23)}…` : t.name,
    description: `SHOP ${shopCodeOf(t).toUpperCase()}`.slice(0, 72),
  }));
  await postShared(cfg, to, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "Pick a shop to continue with:" },
      action: { button: "Your shops", sections: [{ title: "Recently visited", rows }] },
    },
  }).catch((e: any) => console.error("[shared-number] stores list failed:", e?.message));
}

// ── Inbound routing ──────────────────────────────────────────────────────────

export type SharedRoute =
  | { kind: "handled" }
  | { kind: "tenant"; tenant: ShopRow; msg: any };

/** Text shown to the shop's engine as if the buyer had typed it: arriving at a shop opens its menu. */
const ARRIVAL_TEXT = "menu";

function asText(msg: any, text: string): any {
  return { ...msg, type: "text", text: { body: text }, interactive: undefined, button: undefined };
}

function replyIdOf(msg: any): { id: string; set: (id: string) => any } | null {
  const br = msg?.interactive?.button_reply;
  if (br?.id) return { id: br.id, set: (id) => ({ ...msg, interactive: { ...msg.interactive, button_reply: { ...br, id } } }) };
  const lr = msg?.interactive?.list_reply;
  if (lr?.id) return { id: lr.id, set: (id) => ({ ...msg, interactive: { ...msg.interactive, list_reply: { ...lr, id } } }) };
  const b = msg?.button;
  if (b?.payload) return { id: b.payload, set: (id) => ({ ...msg, button: { ...b, payload: id } }) };
  return null;
}

/**
 * Decide what a message on the shared number is for. Never throws: a lookup failure is answered with the
 * welcome text rather than dropping the message silently.
 */
export async function routeSharedInbound(db: Db, msg: any, buyerPhone: string): Promise<SharedRoute> {
  const cfg = sharedNumberConfig();
  if (!cfg) return { kind: "handled" };
  try {
    // Already answered (a Meta retry)? The pipeline's own claim covers routed messages; this covers the ones
    // the platform answers itself, which never reach that claim.
    const claimOnce = async (): Promise<boolean> => {
      if (!msg?.id) return true;
      const { claimWebhookEvent } = await import("./webhookDedupe");
      return (await claimWebhookEvent(db, { id: sharedClaimId(msg.id), tenantId: "shared", type: msg.type ?? "unknown" })) === "claimed";
    };

    const go = async (t: ShopRow, routedMsg: any): Promise<SharedRoute> => {
      await touchVisit(db, buyerPhone, t.id);
      return { kind: "tenant", tenant: t, msg: routedMsg };
    };

    const arrive = async (code: string): Promise<SharedRoute> => {
      const t = await shopByCode(db, code);
      if (!t || !reachable(t)) {
        if (await claimOnce()) {
          await replyText(cfg, buyerPhone, `We couldn't find a shop with the code *${code.toUpperCase()}*. ` +
            `Check the code with the business, or send *STORES* to see shops you've visited.`);
        }
        return { kind: "handled" };
      }
      if (hasOwnNumber(t)) {
        if (await claimOnce()) {
          const own = ((t.settings as any)?.whatsapp?.displayPhoneNumber ?? "") as string;
          const digits = own.replace(/\D/g, "");
          await replyText(cfg, buyerPhone, digits
            ? `*${t.name}* has its own WhatsApp number. Chat with them here: https://wa.me/${digits}`
            : `*${t.name}* uses its own WhatsApp number — please message them there.`);
        }
        return { kind: "handled" };
      }
      return go(t, asText(msg, ARRIVAL_TEXT));
    };

    // The lobby's replies are the platform's own (not any shop's); each is sent once per message.
    const recentIds = async () => (await recentShops(db, buyerPhone)).map((t) => t.id);
    const send = async (payload: Record<string, unknown> | null, fallbackText?: string) => {
      if (!(await claimOnce())) return;
      if (payload) {
        await postShared(cfg, buyerPhone, payload).catch((e: any) => console.error("[shared-number] lobby reply failed:", e?.message));
      } else if (fallbackText) {
        await replyText(cfg, buyerPhone, fallbackText);
      }
    };
    const lobby = async (intent: LobbyIntent | { kind: "browse"; offset: number } | { kind: "prompt" } | { kind: "again" }): Promise<SharedRoute> => {
      switch (intent.kind) {
        case "greet":
        case "again":
          await send(welcomePayload(cfg.platformName, { visited: (await recentIds()).length > 0, again: intent.kind === "again" }));
          break;
        case "prompt":
          await send(null, searchPromptText());
          break;
        case "mine": {
          const shops = await recentShops(db, buyerPhone);
          if (shops.length) { if (await claimOnce()) await replyStores(cfg, buyerPhone, shops); }
          else await send(welcomePayload(cfg.platformName, { visited: false }));
          break;
        }
        case "browse": {
          const offset = "offset" in intent ? intent.offset : 0;
          const recent = offset === 0 ? await listedShopsById(db, (await recentIds()).slice(0, 3)) : [];
          const { shops, total } = await directoryPage(db, offset, 9 - recent.length);
          await send(directoryPayload(cfg.platformName, shops, total, offset, recent),
            `No shops are listed on ${cfg.platformName} yet. If a business gave you its shop code, send *SHOP* and the code.`);
          break;
        }
        case "search":
          await send(searchPayload(intent.query, await searchShops(db, intent.query)));
          break;
      }
      return { kind: "handled" };
    };

    // 1. Taps. A shop's own button belongs to THAT shop, whichever shop is current; the lobby's buttons and list
    //    rows (pick a shop, more stores, browse, search, my shops) are the platform's.
    const reply = replyIdOf(msg);
    if (reply) {
      if (reply.id.startsWith(PICK_PREFIX)) return arrive(reply.id.slice(PICK_PREFIX.length));
      if (reply.id.startsWith(MORE_PREFIX)) return lobby({ kind: "browse", offset: Number(reply.id.slice(MORE_PREFIX.length)) || 0 });
      if (reply.id === LOBBY_BROWSE) return lobby({ kind: "browse" });
      if (reply.id === LOBBY_SEARCH) return lobby({ kind: "prompt" });
      if (reply.id === LOBBY_MINE) return lobby({ kind: "mine" });
      const tag = untagReplyId(reply.id);
      if (tag) {
        const t = await shopByCode(db, tag.code);
        if (t && reachable(t) && !hasOwnNumber(t)) return go(t, reply.set(tag.id));
      }
    }

    const body = msg?.type === "text" ? String(msg.text?.body ?? "") : "";

    // 2. "SHOP <code>" always goes to that shop.
    const code = body ? parseShopCommand(body) : null;
    if (code) return arrive(code);

    // 3. With a shop: everything goes to the shop's own assistant, except asking for the stores again.
    const current = await currentShop(db, buyerPhone);
    if (current && reachable(current) && !hasOwnNumber(current)) {
      if (body && (isLeaveShopText(body) || isStoresCommand(body))) {
        const intent = parseLobbyText(body);
        return lobby(intent?.kind === "mine" ? intent : { kind: "browse" });
      }
      return go(current, msg);
    }

    // 4. The lobby: read what the buyer said — the plain phrasings, then a shop's name, then a quick search, then
    //    the model — and answer like a person would, never with silence.
    if (!body) return lobby({ kind: "greet" });
    const intent = parseLobbyText(body);
    if (intent) return lobby(intent);
    const named = await shopNamed(db, body);
    if (named) return arrive(named.code);
    if (body.trim().split(/\s+/).length <= 6) {
      const hits = await searchShops(db, body);
      if (hits.length) {
        await send(searchPayload(body.trim(), hits));
        return { kind: "handled" };
      }
    }
    const understood = await classifyWithModel(body);
    return lobby(understood ?? { kind: "again" });
  } catch (e: any) {
    console.error("[shared-number] routing failed:", e?.message);
    await replyText(cfg, buyerPhone, welcomeText(cfg));
    return { kind: "handled" };
  }
}

// ── Outbound: name the shop, tag its buttons ────────────────────────────────

export interface SharedSender {
  name: string;
  code: string;
}

/** The shop line every shared-number message starts with. */
export function shopLine(shop: SharedSender): string {
  return `🛍️ *${shop.name}*`;
}

export function withShopLine(shop: SharedSender, text: string): string {
  return text.startsWith(shopLine(shop)) ? text : `${shopLine(shop)}\n${text}`;
}

/**
 * Rewrite one outgoing Cloud API payload (the part after messaging_product/to) for the shared number: the shop's
 * name on the visible text and the shop's code on every reply id. Templates are left alone — their text is fixed
 * at approval time, so a shared-number template must carry the shop name as a parameter itself.
 */
export function applySharedEnvelope(shop: SharedSender, payload: Record<string, any>): Record<string, any> {
  const p: Record<string, any> = JSON.parse(JSON.stringify(payload));
  if (p.type === "text" && p.text?.body) p.text.body = withShopLine(shop, p.text.body);
  for (const kind of ["image", "video", "document"]) {
    if (p.type === kind && p[kind]) p[kind].caption = withShopLine(shop, p[kind].caption ?? "");
  }
  if (p.type === "interactive" && p.interactive) {
    const it = p.interactive;
    if (it.body?.text) it.body.text = withShopLine(shop, it.body.text);
    for (const b of it.action?.buttons ?? []) {
      if (b?.reply?.id) b.reply.id = tagReplyId(shop.code, b.reply.id, 256);
    }
    for (const s of it.action?.sections ?? []) {
      for (const r of s?.rows ?? []) {
        if (r?.id) r.id = tagReplyId(shop.code, r.id, 200);
      }
    }
  }
  return p;
}
