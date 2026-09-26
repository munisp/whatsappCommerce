/**
 * telegramSetup.ts — what the "Telegram" settings card needs from Telegram itself.
 *
 * The bot token is read from the tenant's ENCRYPTED settings here, on the server, and is only ever sent to
 * api.telegram.org. It is never returned to a browser and never written to a log or an error message
 * (every message that could echo it is scrubbed). The webhook address is built by the server from the app's
 * own public URL and the tenant id — an operator can never point Telegram at a URL of their choosing.
 *
 * Kept out of the router so it can be unit-tested and reused (Test connection, Register webhook).
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import { decryptSecret, encryptSecret } from "./crypto/secrets";

const TG_API_BASE = "https://api.telegram.org";
const TG_TIMEOUT_MS = 10_000;

/** Path the webhook route is mounted on (server/_core/index.ts): POST /api/webhooks/telegram/:tenantId. */
export const TELEGRAM_WEBHOOK_PATH = "/api/webhooks/telegram";

/** Telegram accepts secret_token of 1–256 chars from this alphabet only. */
export const TELEGRAM_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * The address Telegram must deliver this tenant's updates to. Telegram only delivers to https, so a
 * non-https (or missing) app URL yields null rather than an address that can never work.
 */
export function buildTelegramWebhookUrl(appUrl: string | null | undefined, tenantId: string): string | null {
  const base = String(appUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+/i.test(base)) return null;
  if (!tenantId) return null;
  return `${base}${TELEGRAM_WEBHOOK_PATH}/${encodeURIComponent(tenantId)}`;
}

export interface StoredTelegramConfig {
  enabled: boolean;
  botUsername: string;
  /** Decrypted. Server-side only — never put this in a response, a log line or an error message. */
  botToken: string;
  /** Decrypted. Server-side only. Empty when none has been generated yet. */
  webhookSecret: string;
}

/** The tenant's Telegram settings with the secrets decrypted, or null when the tenant does not exist. */
export async function loadStoredTelegramConfig(tenantId: string): Promise<StoredTelegramConfig | null> {
  const db = await getDb();
  if (!db) return null;
  const [t] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!t) return null;
  const tg = (((t.settings ?? {}) as Record<string, unknown>).telegram ?? {}) as Record<string, unknown>;
  const rawToken = typeof tg.botToken === "string" ? tg.botToken : "";
  const rawSecret = typeof tg.webhookSecret === "string" ? tg.webhookSecret : "";
  return {
    enabled: tg.enabled === true,
    botUsername: typeof tg.botUsername === "string" ? tg.botUsername : "",
    botToken: rawToken ? decryptSecret(rawToken).trim() : "",
    webhookSecret: rawSecret ? decryptSecret(rawSecret) : "",
  };
}

/** Persist a freshly generated webhook secret (encrypted) without touching anything else in settings. */
export async function storeWebhookSecret(tenantId: string, secret: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const [t] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!t) throw new Error("Tenant not found");
  const settings = { ...((t.settings ?? {}) as Record<string, unknown>) };
  settings.telegram = { ...((settings.telegram ?? {}) as Record<string, unknown>), webhookSecret: encryptSecret(secret) };
  await db.update(tenants).set({ settings }).where(eq(tenants.id, tenantId));
}

export type BotApiFailure = {
  ok: false;
  /** invalid_token: Telegram does not know this token · rejected: Telegram refused the call · unreachable: no answer. */
  kind: "invalid_token" | "rejected" | "unreachable";
  message: string;
};
export type BotApiResult<T> = { ok: true; result: T } | BotApiFailure;

/** Remove the token from anything that might echo it back (defence in depth; Telegram does not normally). */
function scrub(text: string, token: string): string {
  return token ? text.split(token).join("[token]") : text;
}

async function callBotApi<T>(token: string, method: string, body?: Record<string, unknown>): Promise<BotApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${TG_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(TG_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, kind: "unreachable", message: "Could not reach Telegram. Try again in a moment." };
  }
  const json: any = await res.json().catch(() => null);
  // Telegram answers 401 for a token it does not know and 404 for one that is malformed.
  if (res.status === 401 || res.status === 404) {
    return { ok: false, kind: "invalid_token", message: "Telegram does not accept this bot token." };
  }
  if (!json?.ok) {
    const description = scrub(String(json?.description ?? `Telegram answered HTTP ${res.status}`), token).slice(0, 200);
    return { ok: false, kind: "rejected", message: description };
  }
  return { ok: true, result: json.result as T };
}

export interface BotIdentity {
  id: number;
  username: string;
  name: string;
}

/** Ask Telegram which bot a token belongs to (getMe). */
export async function getBotIdentity(token: string): Promise<BotApiResult<BotIdentity>> {
  const r = await callBotApi<{ id: number; username?: string; first_name?: string }>(token, "getMe");
  if (!r.ok) return r;
  return { ok: true, result: { id: r.result.id, username: r.result.username ?? "", name: r.result.first_name ?? "" } };
}

export interface WebhookState {
  url: string;
  pendingUpdateCount: number;
  lastErrorMessage: string | null;
}

/** Tell Telegram where to deliver updates (setWebhook), then read back what it recorded (getWebhookInfo). */
export async function registerWebhook(opts: { token: string; url: string; secret: string }): Promise<BotApiResult<WebhookState>> {
  if (!TELEGRAM_SECRET_PATTERN.test(opts.secret)) {
    return {
      ok: false,
      kind: "rejected",
      message: "The stored webhook secret contains characters Telegram does not allow. Save the bot again to generate a new one.",
    };
  }
  const set = await callBotApi<true>(opts.token, "setWebhook", { url: opts.url, secret_token: opts.secret });
  if (!set.ok) return set;
  const info = await callBotApi<{ url?: string; pending_update_count?: number; last_error_message?: string }>(opts.token, "getWebhookInfo");
  if (!info.ok) return info;
  return {
    ok: true,
    result: {
      url: info.result.url ?? "",
      pendingUpdateCount: info.result.pending_update_count ?? 0,
      lastErrorMessage: info.result.last_error_message ? scrub(info.result.last_error_message, opts.token).slice(0, 300) : null,
    },
  };
}
