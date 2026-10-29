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
import { eq } from "drizzle-orm";
import { chunkWhatsAppText, normalizeWaPhone } from "./waSender";
import { redactString } from "./logRedact";
import {
  clearActiveShop,
  getActiveShop,
  isHomeCommand,
  resolvePlatformWaCredentials,
  resolveShopRef,
  setActiveShop,
} from "./platformNumber";
import { getDb } from "../db";
import { tenants } from "../../drizzle/schema";

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

/** Send a text from the platform number (chunked). No-op when unconfigured. */
export async function sendPlatformText(toPhone: string, body: string): Promise<void> {
  const to = normalizeWaPhone(toPhone);
  const creds = resolvePlatformWaCredentials();
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
 * POST-claim directory handler: leave a shop ("home"), enter a shop by
 * name/slug, or prompt. Sends its reply via the platform number.
 */
export async function handlePlatformDirectory(opts: {
  customerPhone: string;
  msg: any;
  contactName?: string;
}): Promise<void> {
  const { customerPhone, msg, contactName } = opts;
  const text = typeof msg?.text?.body === "string" ? msg.text.body : "";

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

  // Unrecognized text / non-text first contact → directory prompt.
  // (Typing a product to get the nearest shops that stock it is Phase 3.)
  await sendPlatformText(customerPhone, directoryPrompt(contactName));
}
