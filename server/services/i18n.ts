/**
 * i18n.ts — Multilingual chat chrome for the WhatsApp/USSD conversation engine.
 *
 * Locales: en (default), fr, ha (Hausa), yo (Yoruba), ig (Igbo).
 *
 *  - LOCALE_PACKS: translated strings for menu chrome (default greeting +
 *    built-in use-case labels) and system replies (consent prompt, cart
 *    recovery, shortage note, tracking line, voice-note fallback, dispute
 *    confirmation, reorder fallback).
 *  - detectLocale(text): heuristic guess from stopwords + diacritics.
 *  - Sticky per-customer locale: customers.language is the durable store
 *    (synced best-effort), mirrored to Redis key wa:locale:{tenant}:{phone}
 *    (30d TTL, in-memory fallback in dev/test) for fast reads.
 *  - Tenant default: settings.locale (any of the five codes).
 *
 * renderLocalizedMenu translates only the DEFAULT English chrome — tenant-
 * customized greetings/labels are left untouched.
 */

import { eq, and } from "drizzle-orm";
import { getRedis } from "../redis";
import { isProd } from "../_core/env";
import { customers } from "../../drizzle/schema";
import type { WaMenuConfig } from "./waMenu";

export type Locale = "en" | "fr" | "ha" | "yo" | "ig";
export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "fr", "ha", "yo", "ig"];
export const DEFAULT_LOCALE: Locale = "en";

// ── Locale packs ─────────────────────────────────────────────────────────────

export interface LocalePack {
  /** Default menu greeting (supports {businessName}). */
  greeting: string;
  menuLabels: { shop: string; track: string; support: string; booking: string; handoff: string; procurement: string };
  consentPrompt: string;
  consentGranted: string;
  consentDenied: string;
  cartRecovery: string;
  shortageNote: string;
  tracking: string;
  voiceNotEnabled: string;
  reorderNoPriorOrder: string;
  disputeConfirm: string;
  /** B2B enforcement: buyer's credit access is suspended ({reason}, {outstanding}). */
  orderingSuspended: string;
  /** B2B enforcement: transient credit-status lookup outage — neutral try-again copy (never dunning). */
  orderingUnavailable: string;
  /** B2B settlement notice: PO settled straight to the supplier via credit ({poNumber}, {dueDate}). */
  paidViaCredit: string;
}

/**
 * W14: credit-bureau reporting consent text (roadmap F3), shown to the buyer
 * before they accept trade-credit terms (tradeCredit.requestAccount /
 * approveAccount bureauConsent flag). NDPR-aligned: explicit, specific,
 * revocable via the dispute flow (compliance/bureau markDisputed).
 */
export const BUREAU_CONSENT_TEXT: Record<Locale, string> = {
  en:
    "Credit bureau reporting: by accepting, you agree that we may report your trade-credit " +
    "facility activity (draws, repayments, delinquencies and cures) to licensed Nigerian credit " +
    "bureaus (CRC Credit Bureau / CreditRegistry). You may dispute a report at any time.",
  fr:
    "Déclaration aux bureaux de crédit : en acceptant, vous autorisez la déclaration de " +
    "l'activité de votre facilité de crédit (tirages, remboursements, retards et régularisations) " +
    "aux bureaux de crédit nigérians agréés (CRC Credit Bureau / CreditRegistry). " +
    "Vous pouvez contester un rapport à tout moment.",
  ha:
    "Bayar da rahoto ga hukumar bashi: ta amincewa, kun yarda mu bayar da rahoton ayyukan " +
    "bashin kasuwanci (jayayya, biya, makara da gyara) ga hukumomin bashi da aka lasisata a " +
    "Najeriya (CRC Credit Bureau / CreditRegistry). Kuna iya ƙalubalantar rahoto a kowane lokaci.",
  yo:
    "Ijabọ si ile-iṣẹ gbese: nipa gbigba gba, o gba pe a le jabọ awọn iṣẹ awin rẹ " +
    "(awọn yiyọ, awọn sanwo, awọn idaduro ati awọn atunṣe) si awọn ile-iṣẹ gbese ti o gba " +
    "iwe-aṣẹ ni Naijiria (CRC Credit Bureau / CreditRegistry). O le tako ijabọ kankan nigbakugba.",
  ig:
    "Akụkọ ụlọ ọrụ ịgba alaghachi: site na ịnakwere, ị kwenyere na anyị nwere ike ịkpesa " +
    "ọrụ akwụmụgwọ gị (ịdọrọ, ịkwụghachi, ịgbaghara na ndozi) n'ụlọ ọrụ akwụmụgwọ " +
    "Naịjirịa (CRC Credit Bureau / CreditRegistry). Ị nwere ike ịrụju akụkọ ọ bụla oge ọ bụla.",
};

export const LOCALE_PACKS: Record<Locale, LocalePack> = {
  en: {
    // Match keys for localizeMenuConfig — must mirror shared/waMenu.ts
    // DEFAULT_WA_MENU exactly (the single source of truth for menu chrome).
    greeting: "Welcome to {businessName}! How can we help you today?",
    menuLabels: {
      shop: "Shop products",
      track: "Track my order",
      support: "Get support",
      booking: "Book an appointment",
      handoff: "Talk to a human",
      procurement: "Restock / Buy supplies",
    },
    consentPrompt:
      "Before we continue: we'd like to send you order updates and offers on WhatsApp. " +
      "Under NDPR this needs your consent. Reply YES to receive order updates, or NO to opt out. " +
      "You can change this anytime by messaging us.",
    consentGranted: "Thank you! You've opted in to order updates on WhatsApp.",
    consentDenied:
      "Understood — you've opted out of proactive order updates. " +
      "You can still message us anytime, and reply YES later to opt back in.",
    cartRecovery: "You left items in your cart — reply CHECKOUT to complete your order. 🛒",
    shortageNote: "Some items are out of stock right now.",
    tracking: "Track your order",
    voiceNotEnabled: "Sorry, voice notes aren't enabled right now — please type your message instead. 🎤❌",
    reorderNoPriorOrder: "I couldn't find a previous paid order for this number — tell me what you'd like and I'll add it to your cart.",
    disputeConfirm: "Your complaint has been logged and our team has been notified. We'll get back to you shortly. 🙏",
    orderingSuspended: "Ordering is suspended with this supplier{reason}. Repay your outstanding balance{outstanding} to restore ordering.",
    orderingUnavailable: "We couldn't confirm your credit status just now — please try again shortly. Your cart is unchanged and no order was placed.",
    paidViaCredit: "Paid via credit — due {dueDate}. Repay by the due date to keep ordering.",
  },
  fr: {
    greeting: "Bonjour ! Bienvenue chez {businessName}. Comment pouvons-nous vous aider ?",
    menuLabels: {
      shop: "Acheter / passer une commande",
      track: "Suivre ma commande",
      support: "Service client",
      booking: "Prendre rendez-vous",
      handoff: "Parler à un agent",
      procurement: "Réappro / acheter des fournitures",
    },
    consentPrompt:
      "Avant de continuer : nous aimerions vous envoyer des mises à jour de commande et des offres sur WhatsApp. " +
      "Répondez OUI pour les recevoir, ou NON pour refuser. Vous pouvez changer d'avis à tout moment.",
    consentGranted: "Merci ! Vous recevrez désormais nos mises à jour sur WhatsApp.",
    consentDenied:
      "Compris — vous ne recevrez pas de messages proactifs. " +
      "Vous pouvez nous écrire à tout moment, et répondre OUI plus tard pour vous réinscrire.",
    cartRecovery: "Vous avez laissé des articles dans votre panier — répondez CHECKOUT pour finaliser votre commande. 🛒",
    shortageNote: "Certains articles sont en rupture de stock.",
    tracking: "Suivez votre commande",
    voiceNotEnabled: "Désolé, les notes vocales ne sont pas activées — veuillez taper votre message. 🎤❌",
    reorderNoPriorOrder: "Je n'ai trouvé aucune commande payée précédente pour ce numéro — dites-moi ce que vous voulez et je l'ajoute au panier.",
    disputeConfirm: "Votre réclamation a été enregistrée et notre équipe a été informée. Nous revenons vers vous rapidement. 🙏",
    orderingSuspended: "Les commandes sont suspendues auprès de ce fournisseur{reason}. Remboursez votre solde impayé{outstanding} pour rétablir les commandes.",
    orderingUnavailable: "Nous n'avons pas pu vérifier votre statut de crédit pour le moment — veuillez réessayer dans un instant. Votre panier est inchangé et aucune commande n'a été passée.",
    paidViaCredit: "Payé à crédit — échéance {dueDate}. Remboursez avant l'échéance pour continuer à commander.",
  },
  ha: {
    greeting: "Sannu da zuwa {businessName}! Yaya za mu iya taimaka maka yau?",
    menuLabels: {
      shop: "Sayayya / aika oda",
      track: "Bibiyar odana",
      support: "Taimakon abokin ciniki",
      booking: "Yi alƙawarin zuwa",
      handoff: "Yi magana da wakili",
      procurement: "Cika kaya / sayi kayan aiki",
    },
    consentPrompt:
      "Kafin mu ci gaba: muna son aika maka sabbin labarai game da odarka da tayi ta WhatsApp. " +
      "Amsa EH karɓa, ko A'A ka ƙi. Kana iya canza wannan a kowane lokaci.",
    consentGranted: "Na gode! Ka karɓi sabbin labarai ta WhatsApp.",
    consentDenied: "Madalla — ba za mu aika maka saƙonni ba. Kana iya aika mana saƙo a kowane lokaci, kuma amsa EH daga baya.",
    cartRecovery: "Ka bar wasu kayayyaki a kwandon saye — amsa CHECKOUT don kammala odarka. 🛒",
    shortageNote: "Wasu kayayyaki sun ƙare a wannan lokacin.",
    tracking: "Bibiyi odarka",
    voiceNotEnabled: "Yi haƙuri, ba a kunna saƙon murya ba yanzu — don Allah rubuta saƙonka. 🎤❌",
    reorderNoPriorOrder: "Ban sami tsohon oda da ka biya ba — faɗa min abin da kake so in saka maka a kwando.",
    disputeConfirm: "An rubuta kōƙarinka kuma an sanar da tawagarmu. Za mu dawo gare ka nan ba da jimawa ba. 🙏",
    orderingSuspended: "An dakatar da oda a wannan mai sayarwa{reason}. Biya bashin da ka ke dasu{outstanding} don a sake buɗe oda.",
    orderingUnavailable: "Ba mu iya tabbatar da matsayin bashin ku a yanzu ba — don Allah sake gwadawa da sannu. Kwandonku bai canja ba kuma ba a sanya oda ba.",
    paidViaCredit: "An biya ta bashi — ranar biya {dueDate}. Biya kafin ranar don ci gaba da oda.",
  },
  yo: {
    greeting: "Ẹ káàbọ̀ sí {businessName}! Báwo la ṣe lè ràn wọ́ lọ́wọ́ lónìí?",
    menuLabels: {
      shop: "Ra ọjà / fi àṣẹ ránṣẹ́",
      track: "Tọpa àṣẹ mi",
      support: "Ìrànlọ́wọ́ ónìbàárà",
      booking: "Pa àkókò ìpàdé ṣe",
      handoff: "Bá aṣojú sọ̀rọ̀",
      procurement: "Ṣe àtòpò ọjà / ra ohun èlò",
    },
    consentPrompt:
      "Ṣáájú tí a bá tẹ̀síwájú: a fẹ́ máa rán ọ lẹ́tà nípa àṣẹ rẹ àti àwọn ìdíyelé pàtàkì lórí WhatsApp. " +
      "Dáhùn BẸ́ẸNI láti gba wọ́n, tàbí RÁRÁ láti kọ̀. O lè yí padà nígbàkúgbà.",
    consentGranted: "Ẹ ṣeun! O ti gba àwọn ìròyìn àṣẹ lórí WhatsApp.",
    consentDenied: "Ó dáa — a kì yóò rá ọ lẹ́tà fúnra wa. O sì lè rá wa lẹ́tà nígbàkúgbà, kí o sì dáhùn BẸ́ẸNI nígbà míì.",
    cartRecovery: "O fi àwọn ọjà sìlẹ̀ nínú àpò rẹ — dáhùn CHECKOUT láti parí àṣẹ rẹ. 🛒",
    shortageNote: "Àwọn ọjà kan kò sí nílòó yìí.",
    tracking: "Tọpa àṣẹ rẹ",
    voiceNotEnabled: "Ẹ pèlẹ́, a kò tíì ṣí Ìfiranṣẹ́ ohùn ṣíṣe — jọ̀wọ́ kọ ìfiranṣẹ́ rẹ. 🎤❌",
    reorderNoPriorOrder: "N kò rí àṣẹ àtijọ́ tí o ti sanwó fún nọ́ńbà yìí — sọ ohun tí o fẹ́ kí n sì í sínú àpò.",
    disputeConfirm: "A ti kọ ẹ̀jọ́ rẹ sílẹ̀, a sì ti jẹ́ kí àwọn ọmọ ẹgbẹ́ wa mọ̀. A ó padà sọ́dọ̀ rẹ láìpẹ́. 🙏",
    orderingSuspended: "A ti dáwọ́ ìbéèrè lọ́dọ̀ olùtà yìí dúró{reason}. San gbèsè tó kù{outstanding} láti tún bẹ̀rẹ̀ ìbéèrè.",
    orderingUnavailable: "A kò lè jẹ́rìí sí ipo gbèsè yín ní ìsìn yìí — jọ̀wọ́ gbìyànjú lẹ́ẹ̀kansi. Àkópọ̀ yín kò yí padà, kò sì sí ìbéèrè tí a ṣe.",
    paidViaCredit: "A sanwó ní gbèsè — ojọ́ ìsanwó {dueDate}. San ṣáájú ojọ́ náà láti tẹ̀síwájú pẹ̀lú ìbéèrè.",
  },
  ig: {
    greeting: "Nnọọ na {businessName}! Kedu ka anyị ga-esi nyere gị aka taa?",
    menuLabels: {
      shop: "Zụta / zipu ihe ị chọrọ",
      track: "Lelee ihe m zụrụ",
      support: "Enyemaka ndị ahịa",
      booking: "Hazie oge njikọ",
      handoff: "Kwurịta onye nnọchi anya",
      procurement: "Mejupụta ahịa / zụta ihe ọrụ",
    },
    consentPrompt:
      "Tupu anyị gaa n'ihu: anyị chọrọ izitere gị ozi gbasara ihe ị zụrụ na ọhụrụ na WhatsApp. " +
      "Zaa EE ịnakwere, ma ọ bụ MBA ichọpụta. Ị nwere ike ịgbanwe nke a oge ọ bụla.",
    consentGranted: "Daalụ! Ị ga-enweta mmelite ozi na WhatsApp.",
    consentDenied: "Echefuro — anyị agaghị ezitere gị ozi. Ị nwere ike izitere anyị ozi oge ọ bụla, wee zaa EE mgbe e mesịrị.",
    cartRecovery: "Ị hapụrụ ihe ụfọdụ n'ime ngọdo gị — zaa CHECKOUT iji mezue ihe ị zụrụ. 🛒",
    shortageNote: "Ihe ụfọdụ adịghị ugbu a.",
    tracking: "Lelee ihe ị zụrụ",
    voiceNotEnabled: "Ndo, anọgideghị ozi olu ugbu a — biko dee ozi gị. 🎤❌",
    reorderNoPriorOrder: "Achọtaghị m ihe ọ bụla ị zụrụ ma kwụọ ụgwọ maka nọmba a — gwa m ihe ị chọrọ ka m tinye na ngọdo.",
    disputeConfirm: "Edebela mkpesa gị, ọzụzụkwa anyị amataala ya. Anyị ga-azaghachi gị n'oge na-adịghị anya. 🙏",
    orderingSuspended: "A kwụsịtụru ịtụ ihe ndazị na onye na-ere a{reason}. Kwụọ ụgwọ fọdụrụ{outstanding} ka e weghachi ike ịtụ ihe.",
    orderingUnavailable: "Anyị enwebeghị ike ịkwenye ọnọdụ kredit gị ugbu a — biko nwaa ọzọ n'oge na-adịghị anya. Ọ dịghị ihe gbanwere na ngọdo gị, e mebeghị ihe ndazị ọ bụla.",
    paidViaCredit: "A kwụrụ site na kredit — ụbọchị akwụ ụgwọ {dueDate}. Kwụọ tupu ụbọchị ahụ ka ị gaa n'ihu ịtụ ihe.",
  },
};

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

/** Map the NLP session's language names ("english", "yoruba", …) to a locale code. */
export function localeFromSessionLanguage(language: string | null | undefined): Locale {
  switch ((language ?? "").toLowerCase()) {
    case "french": case "fr": return "fr";
    case "hausa": case "ha": return "ha";
    case "yoruba": case "yo": return "yo";
    case "igbo": case "ig": return "ig";
    default: return DEFAULT_LOCALE; // english, pidgin, unknown
  }
}

export function packFor(locale: string | null | undefined): LocalePack {
  return LOCALE_PACKS[isLocale(locale) ? locale : DEFAULT_LOCALE];
}

/** Translate one pack key; falls back to English when the locale misses it. */
export function tr(locale: string | null | undefined, key: keyof LocalePack): string {
  const pack = packFor(locale);
  const v = pack[key];
  return typeof v === "string" ? v : (LOCALE_PACKS.en[key] as string);
}

// ── Detection heuristic ──────────────────────────────────────────────────────

const STOPWORDS: Record<Exclude<Locale, "en">, string[]> = {
  fr: [
    "bonjour", "merci", "commande", "livraison", "combien", "voulez", "s'il",
    "svp", "panier", "prix", "acheter", "bonsoir", "monsieur", "madame",
    "beaucoup", "maintenant", "adresse", "payer", "oui", "non",
  ],
  ha: [
    "sannu", "barka", "nawa", "kudin", "kada", "don", "yaya", "zaka", "nake",
    "madalla", "kwando", "oda", "sayayya", "taimako", "ina son", "don allah",
    "muna", "za mu", "gode", "eh", "a'a", "yanzu",
  ],
  yo: [
    "bawo", "jowo", "pupo", "kini", "ese", "nko", "wọle", "ẹ", "ṣe", "ra",
    "fun", "owo", "ọjà", "káàbọ̀", "e kaabo", "mo fe", "mo fẹ́", "elo", "se o",
    "tọpa", "àṣẹ", "bẹẹni", "rara",
  ],
  ig: [
    "kedu", "biko", "ndewo", "ego", "ole", "chukwu", "anyi", "ahia", "ngọdo",
    "ihe", "nke", "daalụ", "nnọọ", "gị", "zụta", "zipu", "mba",
  ],
};

/** Diacritic bonuses: [regex, locale, points]. */
const CHAR_HINTS: Array<[RegExp, Locale, number]> = [
  [/ṣ/i, "yo", 3], // ṣ is near-unique to Yoruba orthography
  [/[ịụñ]/i, "ig", 3],
  [/[ẹọ]/i, "yo", 1.5],
  [/[ẹọ]/i, "ig", 1],
  [/[éèêçà]/i, "fr", 1],
];

/**
 * Heuristic locale detection from free text. Scores each supported language
 * on stopword hits (word-boundary) plus diacritic hints. Returns "en" when
 * nothing scores (English is the platform default and Nigerian English shares
 * vocabulary with all four languages, so a non-match defaults there).
 */
export function detectLocale(text: string): Locale {
  const lower = (text ?? "").toLowerCase();
  if (!lower.trim()) return DEFAULT_LOCALE;
  const scores: Record<Locale, number> = { en: 0, fr: 0, ha: 0, yo: 0, ig: 0 };
  for (const [lang, words] of Object.entries(STOPWORDS) as Array<[Exclude<Locale, "en">, string[]]>) {
    for (const w of words) {
      const re = new RegExp(`(^|[^a-zà-ỹ])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-zà-ỹ]|$)`, "i");
      if (re.test(lower)) scores[lang] += w.includes(" ") ? 2 : 1.5;
    }
  }
  for (const [re, lang, pts] of CHAR_HINTS) {
    if (re.test(lower)) scores[lang] += pts;
  }
  let best: Locale = DEFAULT_LOCALE;
  let bestScore = 0;
  for (const lang of SUPPORTED_LOCALES) {
    if (scores[lang] > bestScore) {
      bestScore = scores[lang];
      best = lang;
    }
  }
  return bestScore > 0 ? best : DEFAULT_LOCALE;
}

// ── Sticky per-customer locale (Redis + in-memory dev/test fallback) ────────

const LOCALE_TTL_SECONDS = 30 * 24 * 3600; // 30 days
const memoryLocales = new Map<string, { value: string; expiresAt: number }>();

export function localeKey(tenantId: string, phone: string): string {
  return `wa:locale:${tenantId}:${phone}`;
}

/** Test helper: wipe the in-memory locale fallback. */
export function __clearMemoryLocales(): void {
  memoryLocales.clear();
}

/** Best-effort sync to customers.language (durable store). Never throws. */
async function syncCustomerLanguage(
  tenantId: string,
  phone: string,
  locale: Locale,
): Promise<void> {
  try {
    const { getDb } = await import("../db");
    const db = await getDb();
    if (!db) return;
    await db
      .update(customers)
      .set({ language: locale, updatedAt: new Date() })
      .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, phone)))
      .catch(() => {});
  } catch { /* best-effort */ }
}

/** Persist the caller's sticky locale (Redis → memory fallback + customers row). */
export async function setStickyLocale(tenantId: string, phone: string, locale: Locale): Promise<void> {
  const key = localeKey(tenantId, phone);
  try {
    const redis = await getRedis();
    if (redis) {
      await redis.setex(key, LOCALE_TTL_SECONDS, locale);
      void syncCustomerLanguage(tenantId, phone, locale);
      return;
    }
  } catch { /* fall through to memory */ }
  if (!isProd) {
    memoryLocales.set(key, { value: locale, expiresAt: Date.now() + LOCALE_TTL_SECONDS * 1000 });
  }
  void syncCustomerLanguage(tenantId, phone, locale);
}

/** Read the sticky locale: Redis → memory fallback → (optional) customers row. */
export async function getStickyLocale(
  tenantId: string,
  phone: string,
  opts?: { customerLanguage?: string | null; lookupCustomer?: boolean },
): Promise<Locale | null> {
  const key = localeKey(tenantId, phone);
  try {
    const redis = await getRedis();
    if (redis) {
      const raw = await redis.get(key);
      if (isLocale(raw)) return raw;
    }
  } catch { /* fall through */ }
  if (!isProd) {
    const row = memoryLocales.get(key);
    if (row && row.expiresAt > Date.now() && isLocale(row.value)) return row.value;
    if (row && row.expiresAt <= Date.now()) memoryLocales.delete(key);
  }
  // Durable fallback: customers.language column. Pass the value directly when
  // the caller already loaded the customer row; opt into an extra lookup with
  // lookupCustomer (skipped by default so hot paths stay query-lean).
  if (opts?.customerLanguage !== undefined) {
    return isLocale(opts.customerLanguage) ? opts.customerLanguage : null;
  }
  if (!opts?.lookupCustomer) return null;
  try {
    const { getDb } = await import("../db");
    const db = await getDb();
    if (!db) return null;
    const [cust] = await db
      .select({ language: customers.language })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, phone)))
      .limit(1)
      .catch(() => [] as any[]);
    return isLocale(cust?.language) ? (cust!.language as Locale) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective locale for an inbound text:
 *   sticky per-customer → detected from text (and made sticky) → tenant default.
 */
export async function resolveLocale(opts: {
  tenantId: string;
  phone: string;
  text?: string;
  tenantSettings?: Record<string, unknown> | null;
  customerLanguage?: string | null;
}): Promise<Locale> {
  const sticky = await getStickyLocale(opts.tenantId, opts.phone, {
    customerLanguage: opts.customerLanguage ?? undefined,
  });
  if (sticky) return sticky;
  const detected = opts.text ? detectLocale(opts.text) : DEFAULT_LOCALE;
  if (detected !== DEFAULT_LOCALE) {
    await setStickyLocale(opts.tenantId, opts.phone, detected);
    return detected;
  }
  const tenantDefault = (opts.tenantSettings as any)?.locale;
  return isLocale(tenantDefault) ? tenantDefault : DEFAULT_LOCALE;
}

// ── Menu chrome localization ─────────────────────────────────────────────────

const EN = LOCALE_PACKS.en;

/**
 * Return a locale-adjusted copy of the menu config. Only the DEFAULT English
 * chrome (greeting + built-in labels) is translated — any tenant-customized
 * text is preserved verbatim. Returns the config unchanged for English.
 */
export function localizeMenuConfig(config: WaMenuConfig, locale: Locale): WaMenuConfig {
  if (locale === DEFAULT_LOCALE) return config;
  const pack = packFor(locale);
  const greeting = config.greeting === EN.greeting ? pack.greeting : config.greeting;
  const useCases = config.useCases.map((u) => {
    const defaultLabel = EN.menuLabels[u.id];
    return u.label === defaultLabel ? { ...u, label: pack.menuLabels[u.id] } : u;
  });
  return { ...config, greeting, useCases };
}
