/**
 * server/services/platformInbound.ts — W50 inbound routing for the shared
 * platform number.
 *
 * Two entry points, matching the webhook's claim-first ordering:
 *   platformActiveShop()      PRE-claim, read-only: is the customer already
 *                             inside a shop? If so, return that shop's row so
 *                             the webhook processes the message AS that shop
 *                             (normal commerce dispatch; replies go out via the
 *                             platform number's creds — see waSender's fallback).
 *   handlePlatformDirectory() POST-claim (so Meta retries dedupe before any
 *                             reply): "home" leaves the current shop; a shop
 *                             name/slug enters that shop; anything else gets the
 *                             directory prompt. (Product → nearest-shops geo
 *                             discovery is Phase 3.)
 *
 * Directory replies are sent from the platform number's own creds. NEVER
 * throws — the webhook ack has already been sent.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { chunkWhatsAppText, normalizeWaPhone } from "./waSender";
import { redactString } from "./logRedact";
import {
  clearActiveShop,
  clearPendingQuery,
  getActiveShop,
  getCustomerLocation,
  getPendingQuery,
  isGreeting,
  isHomeCommand,
  type LatLng,
  resolvePlatformWaCredentialsFull,
  resolveShopRef,
  setActiveShop,
  setCustomerLocation,
  setPendingQuery,
} from "./platformNumber";
import { discoverNearbyPure, loadDiscoveryData } from "./geoDiscovery";
import { formatDiscoveryMenu } from "./discoveryMenu";
import { getDb } from "../db";
import { tenants } from "../../drizzle/schema";

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

/** Send a text from the platform number (chunked). No-op when unconfigured. */
export async function sendPlatformText(toPhone: string, body: string): Promise<void> {
  const to = normalizeWaPhone(toPhone);
  const creds = await resolvePlatformWaCredentialsFull();
  if (!creds) {
    console.info(`[platformInbound] send skipped (WHATSAPP_PLATFORM_* unset) → *${to.slice(-4)}`);
    return;
  }
  for (const chunk of chunkWhatsAppText(body)) {
    try {
      const res = await fetch(`${GRAPH_API_BASE}/${creds.phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { preview_url: false, body: chunk },
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        const b = await res.text().catch(() => "");
        console.error(`[platformInbound] send failed (${res.status}): ${redactString(b.slice(0, 200))}`);
      }
    } catch (e: any) {
      console.error("[platformInbound] send error:", redactString(e?.message ?? ""));
    }
  }
}

function directoryPrompt(name?: string): string {
  return (
    `👋 Welcome${name ? ` ${name}` : ""}! To start shopping, reply with a *shop's name*.\n\n` +
    `Or tell me what you're looking for (e.g. "toothpaste") and share your 📎 location to find shops near you.`
  );
}

/** Load a shop row only if it is still reachable on the platform number. */
async function loadReachableShop(tenantId: string): Promise<any | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1).catch(() => [] as any[]);
  if (!row) return null;
  if (row.status !== "active") return null; // suspended/draft — no longer open
  if (row.whatsappPhoneNumberId) return null; // moved to its own number (BYO) — not served here
  return row;
}

/**
 * PRE-claim, read-only. Returns the shop row to process this message as when
 * the customer is already inside a reachable shop; null otherwise (→ the
 * directory handles it post-claim). "home" words always drop to the directory.
 */
export async function platformActiveShop(opts: {
  customerPhone: string;
  text: string;
}): Promise<{ shopRow: any } | null> {
  if (isHomeCommand(opts.text)) return null;
  const activeId = await getActiveShop(opts.customerPhone);
  if (!activeId) return null;
  const shopRow = await loadReachableShop(activeId);
  if (!shopRow) {
    await clearActiveShop(opts.customerPhone);
    return null;
  }
  return { shopRow };
}

/**
 * Search shops near `loc` that stock `query` and reply with them. Only SHARED
 * shops (active + no own number) are listed — they're the ones reachable by
 * name on the platform number. Sends via the platform number.
 */
async function discoverAndReply(phone: string, query: string, loc: LatLng): Promise<void> {
  const db = await getDb();
  if (!db) {
    await sendPlatformText(phone, "Search is unavailable right now — please try again shortly.");
    return;
  }
  const data = await loadDiscoveryData(db).catch(() => ({ merchants: [], sponsored: [] }));
  const result = discoverNearbyPure({ lat: loc.lat, lng: loc.lng, query, sortBy: "distance" }, data);

  // Keep only shops reachable here (shared: active + no own WhatsApp number).
  let items = result.items;
  const ids = items.map((i) => i.tenantId);
  if (ids.length) {
    const shared = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(inArray(tenants.id, ids), eq(tenants.status, "active"), isNull(tenants.whatsappPhoneNumberId)))
      .catch(() => [] as any[]);
    const sharedIds = new Set(shared.map((r) => r.id));
    items = items.filter((i) => sharedIds.has(i.tenantId));
  }

  if (items.length === 0) {
    await sendPlatformText(
      phone,
      `I couldn't find a shop near you with "${query}" yet. Try another item, or reply with a shop's name if you know one.`,
    );
    return;
  }
  const menu = formatDiscoveryMenu(items, result.radiusKm);
  await sendPlatformText(phone, `${menu}\n\n🛍️ Reply with a shop's name to start shopping there.`);
}

/** A product search: discover now if we know the customer's location, else ask for it. */
async function runPlatformDiscovery(phone: string, query: string): Promise<void> {
  const loc = await getCustomerLocation(phone);
  if (loc) {
    await discoverAndReply(phone, query, loc);
    return;
  }
  await setPendingQuery(phone, query);
  await sendPlatformText(
    phone,
    `To find shops near you with "${query}", please share your 📎 *location* (tap the clip → Location).`,
  );
}

/**
 * POST-claim directory handler: a shared-location message runs any pending
 * product search; "home" leaves the current shop; a shop name/slug enters that
 * shop; any other text is a product search (→ nearest shops); empty/other
 * first contact gets the directory prompt. Sends via the platform number.
 */
export async function handlePlatformDirectory(opts: {
  customerPhone: string;
  msg: any;
  contactName?: string;
}): Promise<void> {
  const { customerPhone, msg, contactName } = opts;

  // Location share → remember it, then run any pending product search.
  if (msg?.type === "location" && typeof msg?.location?.latitude === "number" && typeof msg?.location?.longitude === "number") {
    const loc: LatLng = { lat: msg.location.latitude, lng: msg.location.longitude };
    await setCustomerLocation(customerPhone, loc);
    const pending = await getPendingQuery(customerPhone);
    if (pending) {
      await clearPendingQuery(customerPhone);
      await discoverAndReply(customerPhone, pending, loc);
      return;
    }
    await sendPlatformText(customerPhone, '📍 Got your location! Now tell me what you\'re looking for (e.g. "toothpaste"), or reply with a shop\'s name.');
    return;
  }

  const text = typeof msg?.text?.body === "string" ? msg.text.body.trim() : "";

  if (isHomeCommand(text)) {
    await clearActiveShop(customerPhone);
    await sendPlatformText(customerPhone, directoryPrompt(contactName));
    return;
  }

  const shop = await resolveShopRef(text);
  if (shop) {
    await setActiveShop(customerPhone, shop.tenantId);
    await sendPlatformText(
      customerPhone,
      `🛍️ You're now shopping at *${shop.name}*. Send "hi" to see the menu — or type *home* anytime to browse other shops.`,
    );
    return;
  }

  // Greeting / empty / unsupported first contact → directory prompt.
  if (!text || isGreeting(text)) {
    await sendPlatformText(customerPhone, directoryPrompt(contactName));
    return;
  }

  // Any other non-empty text is a product search → nearest shops that stock it.
  await runPlatformDiscovery(customerPhone, text);
}
