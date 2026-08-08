/**
 * Click-to-WhatsApp (CTWA) deep links, QR codes and campaign attribution.
 *
 * Campaigns live in tenants.settings.ctwa.campaigns =
 *   [{ id, keyword, label, action, reply? }] — a campaign's wa.me deep link
 *   pre-fills the keyword as the buyer's first message, so when that exact
 *   keyword arrives at the webhook we can attribute the customer
 *   (tag `campaign:<keyword>` on the customers row) and run the mapped
 *   action (show menu / start order tracking / promo context / support).
 *
 * QR codes: GET /api/ctwa/:tenantId/:campaignId.png?token=… renders the
 * campaign link as a PNG via the `qrcode` package. The endpoint is public
 * but token-guarded: the token is a stateless HMAC over tenantId:campaignId
 * (same capability-link pattern as buyer tracking tokens), so QR images can
 * be embedded in marketing material without exposing a management API.
 */

import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { customers, tenants } from "../../drizzle/schema";
import { normalizeWaPhone, sendWhatsAppText } from "./waSender";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type CtwaAction = "menu" | "track" | "support" | "promo" | "none";

export interface CtwaCampaign {
  id: string;
  keyword: string;
  label: string;
  action: CtwaAction;
  reply?: string;
}

/** Canned entry points offered even before the tenant configures campaigns. */
export const DEFAULT_CTWA_CAMPAIGNS: Array<Omit<CtwaCampaign, "id">> = [
  { keyword: "menu", label: "Browse the menu", action: "menu" },
  { keyword: "track", label: "Track my order", action: "track" },
  { keyword: "support", label: "Talk to support", action: "support" },
  { keyword: "promo", label: "Current promotions", action: "promo" },
];

// ── Links ────────────────────────────────────────────────────────────────────

/** Tenant's public WhatsApp number for wa.me links (digits-only) or null. */
export function tenantWaPhone(settings: unknown): string | null {
  const s = settings as any;
  const cand = s?.whatsapp?.displayPhone ?? s?.whatsapp?.phone ?? s?.business?.phone ?? s?.businessProfile?.phone;
  const digits = typeof cand === "string" ? normalizeWaPhone(cand) : "";
  return digits.length >= 7 ? digits : null;
}

/** Build a click-to-WhatsApp deep link: https://wa.me/<digits>?text=<kw>. */
export function buildCtwaLink(phoneDigits: string, text: string): string {
  return `https://wa.me/${normalizeWaPhone(phoneDigits)}?text=${encodeURIComponent(text)}`;
}

/** Parse configured campaigns out of tenant settings. */
export function parseCtwaCampaigns(settings: unknown): CtwaCampaign[] {
  const raw = (settings as any)?.ctwa?.campaigns;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c: any) => c && typeof c.id === "string" && typeof c.keyword === "string")
    .map((c: any) => ({
      id: String(c.id),
      keyword: String(c.keyword),
      label: typeof c.label === "string" ? c.label : String(c.keyword),
      action: (["menu", "track", "support", "promo", "none"] as const).includes(c.action) ? c.action : "none",
      ...(typeof c.reply === "string" && c.reply ? { reply: c.reply } : {}),
    }));
}

// ── QR token (stateless HMAC capability) ─────────────────────────────────────

function qrSecret(): string {
  return process.env.CTWA_QR_SECRET || process.env.TRACKING_SECRET || process.env.JWT_SECRET || "dev-only-insecure-ctwa-secret";
}

/** Token granting public access to one campaign's QR PNG. */
export function ctwaQrToken(tenantId: string, campaignId: string): string {
  return crypto
    .createHmac("sha256", qrSecret())
    .update(`ctwa:${tenantId}:${campaignId}`)
    .digest("base64url")
    .slice(0, 24);
}

export function verifyCtwaQrToken(tenantId: string, campaignId: string, token: unknown): boolean {
  if (typeof token !== "string" || !token) return false;
  const presented = Buffer.from(token, "utf8");
  const expected = Buffer.from(ctwaQrToken(tenantId, campaignId), "utf8");
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

/** Absolute QR PNG URL for a campaign (APP_URL-based, token included). */
export function ctwaQrUrl(tenantId: string, campaignId: string): string {
  const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/api/ctwa/${encodeURIComponent(tenantId)}/${encodeURIComponent(campaignId)}.png?token=${ctwaQrToken(tenantId, campaignId)}`;
}

// ── Campaign management ──────────────────────────────────────────────────────

/**
 * Create a campaign in settings.ctwa.campaigns. Returns the campaign plus its
 * deep link (null link when the tenant has no public display phone) and the
 * token-guarded QR URL.
 */
export async function createCtwaCampaign(
  db: Db,
  tenantId: string,
  input: { keyword: string; label: string; action?: CtwaAction; reply?: string },
): Promise<{ campaign: CtwaCampaign; link: string | null; qrUrl: string }> {
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);

  const keyword = input.keyword.trim().toLowerCase();
  const campaigns = parseCtwaCampaigns(tenant.settings);
  if (campaigns.some((c) => c.keyword === keyword)) {
    throw new Error(`A CTWA campaign already uses the keyword "${keyword}"`);
  }
  const campaign: CtwaCampaign = {
    id: crypto.randomUUID(),
    keyword,
    label: input.label.trim(),
    action: input.action ?? "none",
    ...(input.reply?.trim() ? { reply: input.reply.trim() } : {}),
  };
  campaigns.push(campaign);
  await db
    .update(tenants)
    .set({
      settings: sql`COALESCE(${tenants.settings}, '{}'::jsonb) || ${JSON.stringify({ ctwa: { campaigns } })}::jsonb`,
      updatedAt: new Date(),
    } as any)
    .where(eq(tenants.id, tenantId));

  const phone = tenantWaPhone(tenant.settings);
  return {
    campaign,
    link: phone ? buildCtwaLink(phone, campaign.keyword) : null,
    qrUrl: ctwaQrUrl(tenantId, campaign.id),
  };
}

// ── Inbound attribution + mapped action ──────────────────────────────────────

const ACTION_FALLBACK_REPLIES: Record<Exclude<CtwaAction, "none">, string> = {
  menu: "Here's our menu — reply with an item number to order.",
  track: "Sure — send me your order number and I'll fetch the latest status.",
  support: "You've reached support. Tell us what's wrong and we'll help right away.",
  promo: "Great timing! Our current promotions will be applied automatically to your next order.",
};

/**
 * Record the campaign attribution on the customer row: tag
 * `campaign:<keyword>` is appended when absent (tags is the customers-table
 * JSONB metadata slot — no schema change needed). Creates the row when the
 * buyer is new.
 */
export async function attributeCampaign(
  db: Db,
  tenantId: string,
  phone: string,
  keyword: string,
  name?: string,
): Promise<void> {
  const normalized = normalizeWaPhone(phone);
  if (!normalized) return;
  const tag = `campaign:${keyword}`;
  const [existing] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, normalized)))
    .limit(1)
    .catch(() => []);
  if (!existing) {
    await db
      .insert(customers)
      .values({
        id: crypto.randomUUID(),
        tenantId,
        whatsappPhone: normalized,
        name: name ?? null,
        language: "en",
        tags: [tag],
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: [customers.tenantId, customers.whatsappPhone] });
    return;
  }
  const tags: string[] = Array.isArray(existing.tags) ? (existing.tags as string[]).filter((t) => typeof t === "string") : [];
  if (!tags.includes(tag)) {
    tags.push(tag);
    await db
      .update(customers)
      .set({ tags: tags as unknown as Record<string, unknown>, updatedAt: new Date() } as any)
      .where(eq(customers.id, existing.id));
  }
}

/**
 * Check an inbound first-message text against the tenant's CTWA campaigns.
 * On a keyword match: attribute the customer and run the mapped action
 * (sending the action reply over WhatsApp). Returns true when the message
 * was claimed — the webhook should skip normal NLP processing.
 */
export async function handleCtwaInbound(opts: {
  db: Db;
  tenantId: string;
  phone: string;
  text: string;
  contactName?: string;
}): Promise<boolean> {
  const { db, tenantId, phone, text } = opts;
  const normalizedText = text.trim().toLowerCase();
  if (!normalizedText) return false;

  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => []);
  const campaigns = parseCtwaCampaigns(tenant?.settings);
  if (campaigns.length === 0) return false;
  const campaign = campaigns.find((c) => c.keyword === normalizedText);
  if (!campaign) return false;

  await attributeCampaign(db, tenantId, phone, campaign.keyword, opts.contactName);

  // Run the mapped action. Failures degrade to a static reply — the campaign
  // is still attributed.
  let reply = campaign.reply ?? null;
  if (!reply && campaign.action === "menu") {
    try {
      const { previewWaMenuForTenant } = await import("./waMenuPreview");
      reply = (await previewWaMenuForTenant(tenantId)).text;
    } catch (err: any) {
      console.warn("[ctwa] menu render failed, using fallback:", err?.message);
    }
  }
  if (!reply) {
    reply =
      campaign.action !== "none"
        ? ACTION_FALLBACK_REPLIES[campaign.action]
        : `Thanks for reaching out via our "${campaign.label}" link! How can we help?`;
  }
  await sendWhatsAppText(tenantId, phone, reply, { notifType: "ctwa_campaign" })
    .catch((e: any) => console.error("[ctwa] campaign reply send failed:", e?.message));
  return true;
}
