// === W52 SHARE ===
/**
 * shareDeal.ts — share-this-deal: viral promo distribution within WhatsApp /
 * Telegram platform rules (no address-book API exists — the OS share-sheet
 * deep link IS the address-book path; sharing is always user-initiated).
 *
 * Pieces:
 *   - buildDealShareBundle(...): localized promo blurb + sharer's referral
 *     code + promo code, with the three channel links:
 *       WA share:  https://wa.me/?text=<encodeURIComponent(blurb + " " + ctwaLink)>
 *       TG share:  https://t.me/share/url?url=<ctwaLink>&text=<blurb>
 *       USSD/SMS:  plain text "Forward: {blurb} {ctwaLink}"
 *     where ctwaLink = buildCtwaLink(merchantWaPhone, "DEAL <PROMO> REF <CODE>")
 *     — the recipient's tap lands in the MERCHANT's chat with the prefilled
 *     grammar the NLP engine claims (routers/nlp.ts "DEAL <PROMO> REF <CODE>":
 *     promo awareness via session ctx.promoCode + attributeReferral).
 *   - buildForwardText(locale, promo, ctwaLink): the USSD/SMS forward line
 *     appended to the W51 promo one-liner.
 *   - recordShareTap / dealShareStats: share-tap analytics ride the EXISTING
 *     agent_events table (eventType 'promo_share_tap', intentType = promo
 *     code); attributed redemptions are counted from the existing
 *     referral_events rail (no new migration).
 *
 * Returns null from buildDealShareBundle when the tenant has no public
 * WhatsApp number (no ctwa link → nothing shareable) — callers then omit the
 * share affordance entirely.
 */
import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { agentEvents, referralCodes, referralEvents } from "../../drizzle/schema";
import { buildCtwaLink, tenantWaPhone } from "./ctwa";
import { t27, type Locale } from "./i18n";
import type { SpotlightPromo } from "./promoSpotlight";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const SHARE_TAP_EVENT = "promo_share_tap";
/** Button id prefix on the promo cards (WA reply button / TG callback_data). */
export const PROMO_SHARE_PREFIX = "promo_share:";

export interface DealShareBundle {
  /** Localized one-line blurb (title + discount + promo code + referral). */
  blurb: string;
  /** Sharer's referral code (null on merchant packs — no referee credit). */
  referralCode: string | null;
  /** Prefilled inbound grammar the recipient's tap delivers to the merchant. */
  inboundText: string;
  /** Click-to-WhatsApp deep link into the MERCHANT chat. */
  ctwaLink: string;
  /** OS share-sheet deep link for WhatsApp. */
  waShareUrl: string;
  /** Telegram share deep link. */
  tgShareUrl: string;
  /** Plain-text forward line (USSD/SMS). */
  forwardText: string;
  /** QR payload for shop posters (the portal renders it; we provide data). */
  qrPayload: string;
}

/**
 * Build the full share bundle for a promo. `referralCode` is the sharer's
 * code (customer share taps); merchant share packs pass null → the prefilled
 * grammar is "DEAL <PROMO>" with no REF segment.
 */
export function buildDealShareBundle(args: {
  settings: unknown;
  promo: SpotlightPromo;
  referralCode?: string | null;
  locale?: Locale | string;
}): DealShareBundle | null {
  const phone = tenantWaPhone(args.settings);
  const code = args.promo.code?.trim();
  if (!phone || !code) return null;
  const locale = args.locale ?? "en";
  const referralCode = args.referralCode?.trim() || null;
  const blurb = t27(locale, "shareDealBlurb", {
    title: args.promo.title,
    discount: args.promo.discountText,
    code,
    ref: referralCode ?? "",
  }).replace(/\s+Referral:\s*$/i, "").trim();
  const inboundText = referralCode ? `DEAL ${code} REF ${referralCode}` : `DEAL ${code}`;
  const ctwaLink = buildCtwaLink(phone, inboundText);
  const waShareUrl = `https://wa.me/?text=${encodeURIComponent(`${blurb} ${ctwaLink}`)}`;
  const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(ctwaLink)}&text=${encodeURIComponent(blurb)}`;
  return {
    blurb,
    referralCode,
    inboundText,
    ctwaLink,
    waShareUrl,
    tgShareUrl,
    forwardText: t27(locale, "shareDealForward", { blurb, link: ctwaLink }),
    qrPayload: ctwaLink,
  };
}

/** USSD/SMS forward line appended to the promo one-liner (no referral code —
 *  the forwarder pastes their code in chat if they want credit). */
export function buildForwardText(
  locale: Locale | string,
  promo: SpotlightPromo,
  settings: unknown,
): string | null {
  const bundle = buildDealShareBundle({ settings, promo, locale });
  return bundle?.forwardText ?? null;
}

/** Localized bundle message sent to the sharer on a share-button tap. */
export function renderShareBundleMessage(locale: Locale | string, bundle: DealShareBundle): string {
  return t27(locale, "shareDealBundleMessage", {
    blurb: bundle.blurb,
    waUrl: bundle.waShareUrl,
    tgUrl: bundle.tgShareUrl,
    forward: bundle.forwardText,
  });
}

/**
 * Count a share tap (analytics): ONE agent_events row, fail-open — a
 * telemetry outage never blocks the share reply.
 */
export async function recordShareTap(
  db: Db,
  args: { tenantId: string; promoCode: string; channel: string },
): Promise<void> {
  try {
    await db.insert(agentEvents).values({
      id: crypto.randomUUID(),
      tenantId: args.tenantId,
      // conversationId is NOT NULL on agent_events; share taps are
      // session-less, so key them by channel ("share:whatsapp" etc).
      conversationId: `share:${args.channel}`,
      eventType: SHARE_TAP_EVENT,
      intentType: args.promoCode,
      confidence: "1.000",
      escalated: false,
      model: args.channel,
      createdAt: new Date(),
    } as any);
  } catch (e: any) {
    console.warn("[shareDeal] share-tap analytics failed (fail-open):", e?.message);
  }
}

/**
 * Share analytics for the merchant share pack: share taps per promo code
 * (agent_events) + referral redemptions attributed via the shared rail
 * (referral_events joined to referral_codes, tenant-scoped).
 */
export async function dealShareStats(
  db: Db,
  tenantId: string,
  promoCode?: string,
): Promise<{ shareTaps: number; referralsAttributed: number; referralsRewarded: number }> {
  const tapRows = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(agentEvents)
    .where(and(
      eq(agentEvents.tenantId, tenantId),
      eq(agentEvents.eventType, SHARE_TAP_EVENT),
      ...(promoCode ? [eq(agentEvents.intentType, promoCode)] : []),
    ))
    .catch(() => [] as any[]);
  const refRows = await db
    .select({
      status: referralEvents.status,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(referralEvents)
    .innerJoin(referralCodes, eq(referralEvents.codeId, referralCodes.id))
    .where(eq(referralEvents.tenantId, tenantId))
    .groupBy(referralEvents.status)
    .catch(() => [] as any[]);
  return {
    shareTaps: Number(tapRows[0]?.n ?? 0),
    referralsAttributed: refRows.filter((r) => r.status === "attributed").reduce((s, r) => s + Number(r.n), 0),
    referralsRewarded: refRows.filter((r) => r.status === "rewarded").reduce((s, r) => s + Number(r.n), 0),
  };
}
