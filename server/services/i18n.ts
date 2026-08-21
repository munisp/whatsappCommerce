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

export type Locale = "en" | "fr" | "ha" | "yo" | "ig" | "sw" | "am";
export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "fr", "ha", "yo", "ig", "sw", "am"];
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
  sw:
    "Ripoti kwa shirika la mikopo: kwa kukubali, unakubali kwamba tunaweza kuripoti shughuli " +
    "za mkopo wako wa biashara (ukopaji, malipo, kuchelewa na marekebisho) kwa mamlaka za " +
    "mikopo zilizoidhinishwa Nigeria (CRC Credit Bureau / CreditRegistry). Unaweza kupinga " +
    "ripoti wakati wowote.",
  am:
    "የብድር ቢሮ ሪፖርት ማድረጊያ፡ በመቀበልዎ፣ የንግድ ብድርዎን እንቅስቃሴዎችን (መወሰድ፣ ክፍያዎች፣ " +
    "መዘግየቶች እና ማስተካከያዎች) ለተፈቀዱ የናይጄሪያ የብድር ቢሮዎች (CRC Credit Bureau / " +
    "CreditRegistry) ማሳወቅ እንድንችል ተስማምተዋል። ማንኛውንም ሪፖርት በማንኛውም ጊዜ መቃወም ይችላሉ።",
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
  // W27: Swahili + Amharic packs (locales extended from 5 → 7).
  sw: {
    greeting: "Karibu {businessName}! Tunaweza kukusaidia vipi leo?",
    menuLabels: {
      shop: "Nunua bidhaa",
      track: "Fuatilia agizo langu",
      support: "Pata msaada",
      booking: "Weka miadi",
      handoff: "Ongea na mtu",
      procurement: "Jaza stoo / nunua vifaa",
    },
    consentPrompt:
      "Kabla ya kuendelea: tungependa kukutumia sasisho za agizo na ofa kupitia WhatsApp. " +
      "Jibu NDIYO kuzipokea, au HAPANA kukataa. Unaweza kubadilisha wakati wowote.",
    consentGranted: "Asante! Umejidhatiti kupokea sasisho za agizo kupitia WhatsApp.",
    consentDenied:
      "Imeeleweka — hautapokea sasisho za agizo. " +
      "Bado unaweza kututumia ujumbe wakati wowote, na kujibu NDIYO baadaye.",
    cartRecovery: "Uliacha bidhaa kwenye kikapu chako — jibu CHECKOUT kukamilisha agizo lako. 🛒",
    shortageNote: "Baadhi ya bidhaa hazipatikani kwa sasa.",
    tracking: "Fuatilia agizo lako",
    voiceNotEnabled: "Samahani, ujumbe wa sauti haujawashwa — tafadhali andika ujumbe wako. 🎤❌",
    reorderNoPriorOrder: "Sikupata agizo la awali lililolipwa kwa nambari hii — niambie unachotaka nikuingizie kwenye kikapu.",
    disputeConfirm: "Malalamiko yako yamerekodiwa na timu yetu imearifiwa. Tutakujibu hivi karibuni. 🙏",
    orderingSuspended: "Kuagiza kumesitishwa kwa muuzaji huyu{reason}. Lipa deni lako{outstanding} kurejesha kuagiza.",
    orderingUnavailable: "Hatukuweza kuthibitisha hali yako ya mkopo kwa sasa — tafadhali jaribu tena. Kikapu chako hakijabadilika na hakuna agizo lililowekwa.",
    paidViaCredit: "Imelipwa kwa mkopo — tarehe ya mwisho {dueDate}. Lipa kabla ya tarehe hiyo kuendelea kuagiza.",
  },
  am: {
    greeting: "እንኳን ወደ {businessName} በደህና መጡ! ዛሬ እንዴት ልንረዳዎት እንችላለን?",
    menuLabels: {
      shop: "ምርቶችን ይግዙ",
      track: "ትእዛዤን ይከታተሉ",
      support: "ድጋፍ ያግኙ",
      booking: "ቀጠሮ ይያዙ",
      handoff: "ከሰው ጋር ይነጋገሩ",
      procurement: "እቃዎችን ይሙሉ / አቅርቦቶችን ይግዙ",
    },
    consentPrompt:
      "ከመቀጠላችን በፊት፡ በWhatsApp ስለ ትእዛዝዎ ማዘመኛዎችን እና ቅናሾችን መላክ እንፈልጋለን። " +
      "ለመቀበል አዎ ብለው ይመልሱ፣ ለመካል አይ ብለው ይመልሱ። በማንኛውም ጊዜ መለወጥ ይችላሉ።",
    consentGranted: "አመሰግናለሁ! በWhatsApp የትእዛዝ ማዘመኛዎችን መቀበል መርጠዋል።",
    consentDenied:
      "ተረድቷል — የትእዛዝ ማዘመኛዎችን አይልክልዎም። " +
      "በማንኛውም ጊዜ መጻፍ ይችላሉ፤ እና በኋላ አዎ ብለው መመለስ ይችላሉ።",
    cartRecovery: "እቃዎችን በጋሪዎ ውስጥ ትተዋል — ትእዛዝዎን ለማጠናቀቅ CHECKOUT ብለው ይመልሱ። 🛒",
    shortageNote: "አንዳንድ እቃዎች በአሁኑ ጊዜ አልተገኙም።",
    tracking: "ትእዛዝዎን ይከታተሉ",
    voiceNotEnabled: "ይቅርታ፣ የድምጽ መልዕክቶች አልነቁም — እባክዎ መልዕክትዎን ይጻፉ። 🎤❌",
    reorderNoPriorOrder: "ለዚህ ቁጥር ቀደም ያለ የተከፈለ ትእዛዝ አላገኘሁም — የሚፈልጉትን ይንገሩኝ እና ወደ ጋሪዎ እጨምራለሁ።",
    disputeConfirm: "ቅሬታዎ ተመዝግቧል እና ቡድናችን ታውቋል። በቅርቡ እንመልሳለን። 🙏",
    orderingSuspended: "ከዚህ ሻጭ ማዘዝ ተቆምቷል{reason}። ማዘዝን ለመመለስ ያለብዎትን ዕዳ ይክፈሉ{outstanding}።",
    orderingUnavailable: "የብድር ሁኔታዎን አሁን ማረጋገጥ አልቻልንም — እባክዎ ትንሽ ቆይተው ይሞክሩ። ጋሪዎ አልተቀየረም እና ምንም ትእዛዝ አልተሰጠም።",
    paidViaCredit: "በብድር ተከፍሏል — የክፍያ ቀን {dueDate}። ማዘዝዎን ለመቀጠል እስከ ቀኑ ይክፈሉ።",
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
    case "swahili": case "kiswahili": case "sw": return "sw";
    case "amharic": case "am": return "am";
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
  sw: [
    "habari", "jambo", "asante", "bei", "pesa", "bidhaa", "agizo", "nunua",
    "tafadhali", "sasa", "wapi", "ngapi", "kodi", "malipo", "lipa", "ndiyo",
    "hapana", "karibu", "duka", "msaada", "nina", "nataka",
  ],
  am: [
    "ሰላም", "አመሰግናለሁ", "ዋጋ", "ገንዘብ", "ምርት", "ትእዛዝ", "ግዛ", "እባክዎ",
    "አሁን", "የት", "ስንት", "ክፍያ", "ይክፈሉ", "አዎ", "አይ", "እንኳን", "ሱቅ",
    "እርዳታ", "እፈልጋለሁ", "መክፈል", "ቅናሽ",
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
  const scores: Record<Locale, number> = { en: 0, fr: 0, ha: 0, yo: 0, ig: 0, sw: 0, am: 0 };
  for (const [lang, words] of Object.entries(STOPWORDS) as Array<[Exclude<Locale, "en">, string[]]>) {
    for (const w of words) {
      // W15.1 bugfix: apostrophe is NOT a word boundary — otherwise the Hausa
      // stopword "don" matches inside English "I don't …" (the apostrophe used
      // to terminate the token), misdetecting a customer's FIRST message as
      // Hausa and persisting the wrong locale for 30 days. Mirrors the copilot
      // detector (services/onboardingCopilot/language.ts).
      const re = new RegExp(`(^|[^a-zà-ỹ'])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-zà-ỹ']|$)`, "i");
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

// ══ W27: message catalog + locale-aware NLU + language selection ════════════
//
// Keyed templates per locale with fallback chain locale→en. Covers the
// main-menu chrome, catalog browse, order flow, discovery and payment
// prompts with real translations in all 7 supported locales. Templates use
// {var} interpolation (interpolate() below).

export type MessageKey =
  // language selection
  | "languageMenuPrompt" | "languageSetConfirm" | "languageMenuHint"
  // main menu / navigation
  | "mainMenuPrompt" | "backToMenu" | "invalidSelection"
  // catalog browse
  | "catalogHeader" | "catalogEmpty" | "catalogItemOutOfStock" | "catalogItemAdded"
  | "catalogMoreHint"
  // order flow
  | "cartSummaryHeader" | "cartEmpty" | "checkoutPrompt" | "orderConfirmPrompt"
  | "orderPlaced" | "orderCancelled" | "askDeliveryAddress"
  // discovery
  | "discoveryAskLocation" | "discoveryEmpty" | "discoveryHeader"
  // payment
  | "paymentPrompt" | "paymentLinkReady" | "paymentReceived" | "paymentFailed"
  | "paymentPending";

export type MessageCatalog = Record<MessageKey, string>;

const EN_CATALOG: MessageCatalog = {
  languageMenuPrompt: "🌐 Choose your language / Zaɓi harshenka:",
  languageSetConfirm: "Language set to {language}. You can change it anytime by typing LANGUAGE.",
  languageMenuHint: "Type LANGUAGE anytime to change your language.",
  mainMenuPrompt: "Reply with a number, or tell me what you're looking for.",
  backToMenu: "Back to main menu",
  invalidSelection: "Sorry, I didn't understand that — reply MENU to see the options again.",
  catalogHeader: "🛍️ Our products:",
  catalogEmpty: "No products available right now — please check back soon.",
  catalogItemOutOfStock: "(out of stock)",
  catalogItemAdded: "Added {product} ×{qty} to your cart. 🛒",
  catalogMoreHint: "Reply with a product name or number to add it to your cart.",
  cartSummaryHeader: "🛒 Your cart:",
  cartEmpty: "Your cart is empty.",
  checkoutPrompt: "Reply CHECKOUT to place your order, or keep shopping.",
  orderConfirmPrompt: "Confirm your order? Reply YES to confirm or NO to cancel.",
  orderPlaced: "✅ Order {orderNumber} placed! Total: {total} {currency}.",
  orderCancelled: "Your order has been cancelled — no charge was made.",
  askDeliveryAddress: "Please send your delivery address (street, area, city).",
  discoveryAskLocation: "📍 Share your location to see businesses near you.",
  discoveryEmpty: "No businesses found near you yet — try a different location.",
  discoveryHeader: "Businesses near you:",
  paymentPrompt: "💳 Total to pay: {total} {currency}.",
  paymentLinkReady: "Tap to pay securely: {url}",
  paymentReceived: "✅ Payment received — thank you! Your order is being prepared.",
  paymentFailed: "❌ Payment didn't go through — please try again or choose another method.",
  paymentPending: "Your payment is being confirmed — we'll update you shortly.",
};

/** Partial translations per locale — any missing key falls back to English. */
export const MESSAGE_CATALOG: Record<Locale, Partial<MessageCatalog>> = {
  en: EN_CATALOG,
  fr: {
    languageMenuPrompt: "🌐 Choisissez votre langue :",
    languageSetConfirm: "Langue définie : {language}. Tapez LANGUAGE pour la changer à tout moment.",
    languageMenuHint: "Tapez LANGUAGE à tout moment pour changer de langue.",
    mainMenuPrompt: "Répondez avec un numéro, ou dites-moi ce que vous cherchez.",
    backToMenu: "Retour au menu principal",
    invalidSelection: "Désolé, je n'ai pas compris — répondez MENU pour revoir les options.",
    catalogHeader: "🛍️ Nos produits :",
    catalogEmpty: "Aucun produit disponible pour le moment — revenez bientôt.",
    catalogItemOutOfStock: "(rupture de stock)",
    catalogItemAdded: "{product} ×{qty} ajouté à votre panier. 🛒",
    catalogMoreHint: "Répondez avec le nom ou le numéro d'un produit pour l'ajouter au panier.",
    cartSummaryHeader: "🛒 Votre panier :",
    cartEmpty: "Votre panier est vide.",
    checkoutPrompt: "Répondez CHECKOUT pour passer commande, ou continuez vos achats.",
    orderConfirmPrompt: "Confirmer votre commande ? Répondez OUI pour confirmer ou NON pour annuler.",
    orderPlaced: "✅ Commande {orderNumber} passée ! Total : {total} {currency}.",
    orderCancelled: "Votre commande a été annulée — aucun débit effectué.",
    askDeliveryAddress: "Veuillez envoyer votre adresse de livraison (rue, quartier, ville).",
    discoveryAskLocation: "📍 Partagez votre position pour voir les commerces à proximité.",
    discoveryEmpty: "Aucun commerce trouvé à proximité — essayez un autre emplacement.",
    discoveryHeader: "Commerces près de chez vous :",
    paymentPrompt: "💳 Total à payer : {total} {currency}.",
    paymentLinkReady: "Touchez pour payer en toute sécurité : {url}",
    paymentReceived: "✅ Paiement reçu — merci ! Votre commande est en préparation.",
    paymentFailed: "❌ Le paiement n'a pas abouti — réessayez ou choisissez un autre moyen.",
    paymentPending: "Votre paiement est en cours de confirmation — nous vous informerons bientôt.",
  },
  ha: {
    languageMenuPrompt: "🌐 Zaɓi harshenka:",
    languageSetConfirm: "An saita harshe zuwa {language}. Kana iya canza shi a kowane lokaci ta rubuta LANGUAGE.",
    languageMenuHint: "Rubuta LANGUAGE a kowane lokaci don canza harshe.",
    mainMenuPrompt: "Amsa da lamba, ko faɗa min abin da kake nema.",
    backToMenu: "Komawa babban menu",
    invalidSelection: "Yi haƙuri, ban fahimta ba — amsa MENU don ganin zaɓuɓɓuka kuma.",
    catalogHeader: "🛍️ Kayayyakinmu:",
    catalogEmpty: "Babu kayayyaki a yanzu — don Allah sake duba nan ba da jimawa ba.",
    catalogItemOutOfStock: "(an gama)",
    catalogItemAdded: "An saka {product} ×{qty} a kwandonka. 🛒",
    catalogMoreHint: "Amsa da sunan ko lambar kaya don saka shi a kwando.",
    cartSummaryHeader: "🛒 Kwandonka:",
    cartEmpty: "Kwandonka fanko ne.",
    checkoutPrompt: "Amsa CHECKOUT don sanya oda, ko ci gaba da sayayya.",
    orderConfirmPrompt: "Tabbatar da odarka? Amsa EH don tabbatarwa ko A'A don soke.",
    orderPlaced: "✅ An sanya oda {orderNumber}! Jimilla: {total} {currency}.",
    orderCancelled: "An soke odarka — ba a cire kuɗi ba.",
    askDeliveryAddress: "Don Allah aika adireshin isar da kaya (titi, unguwa, birni).",
    discoveryAskLocation: "📍 Aika wurin da ka ke don ganin shaguna kusa da kai.",
    discoveryEmpty: "Ba a sami shaguna kusa da kai ba tukuna — gwada wani wuri.",
    discoveryHeader: "Shaguna kusa da kai:",
    paymentPrompt: "💳 Jimillar biya: {total} {currency}.",
    paymentLinkReady: "Danna don biya cikin aminci: {url}",
    paymentReceived: "✅ An karɓi biya — na gode! Ana shirin odarka.",
    paymentFailed: "❌ Biya bai yi nasara ba — sake gwadawa ko zaɓi wani hanya.",
    paymentPending: "Ana tabbatar da biyarka — za mu sanar da kai nan ba da jimawa ba.",
  },
  yo: {
    languageMenuPrompt: "🌐 Yan èdè rẹ:",
    languageSetConfirm: "A ti yán èdè sí {language}. O lè yí í padà nígbàkúgbà nípa kíkọ LANGUAGE.",
    languageMenuHint: "Kọ LANGUAGE nígbàkúgbà láti yí èdè padà.",
    mainMenuPrompt: "Dáhùn pẹ̀lú nọ́ńbà, tàbí sọ ohun tí o ń wá.",
    backToMenu: "Padà sí àkópọ̀ àkọ́kọ́",
    invalidSelection: "Ẹ pèlẹ́, n kò gbọ́ — dáhùn MENU láti rí àwọn àṣàyàn lẹ́ẹ̀kansi.",
    catalogHeader: "🛍️ Àwọn ọjà wa:",
    catalogEmpty: "Kò sí ọjà kankan nílòó yìí — ṣàyẹ̀wò lẹ́ẹ̀kansi láìpẹ́.",
    catalogItemOutOfStock: "(kò sí nílòó)",
    catalogItemAdded: "A ti fi {product} ×{qty} kún àpò rẹ. 🛒",
    catalogMoreHint: "Dáhùn pẹ̀lú orúkọ tàbí nọ́ńbà ọjà láti fi í kún àpò.",
    cartSummaryHeader: "🛒 Àpò rẹ:",
    cartEmpty: "Àpò rẹ ṣófo.",
    checkoutPrompt: "Dáhùn CHECKOUT láti fi àṣẹ ránṣẹ́, tàbí tẹ̀síwájú pẹ̀lú rírà.",
    orderConfirmPrompt: "Jẹ́rìí sí àṣẹ rẹ? Dáhùn BẸ́ẸNI láti jẹ́rìí tàbí RÁRÁ láti fagi lé.",
    orderPlaced: "✅ A ti fi àṣẹ {orderNumber} ránṣẹ́! Àpapọ̀: {total} {currency}.",
    orderCancelled: "A ti fagi lé àṣẹ rẹ — kò sí owó tí a yọ.",
    askDeliveryAddress: "Jọ̀wọ́ fi àdírẹ́sì ìfiranṣẹ́ rẹ ránṣẹ́ (opopona, agboole, ilu).",
    discoveryAskLocation: "📍 Pín ipò rẹ láti rí àwọn ilé-iṣòwò tó sun mọ́ ọ́.",
    discoveryEmpty: "A kò rí ilé-iṣòwò kankan nítòsí rẹ — gbìyànjú ibòmíì.",
    discoveryHeader: "Àwọn ilé-iṣòwò nítòsí rẹ:",
    paymentPrompt: "💳 Àpapọ̀ owó tó yẹ kí o san: {total} {currency}.",
    paymentLinkReady: "Tẹ láti sanwó láìní ẹ̀wà: {url}",
    paymentReceived: "✅ A ti gba owó — ẹ ṣeun! A ń ṣe àṣẹ rẹ.",
    paymentFailed: "❌ Owó kò lọ — gbìyànjú lẹ́ẹ̀kansi tàbí yan ọ̀nà míì.",
    paymentPending: "A ń jẹ́rìí sí owó rẹ — a ó sọ fún ọ láìpẹ́.",
  },
  ig: {
    languageMenuPrompt: "🌐 Họrọ asụsụ gị:",
    languageSetConfirm: "E tinyela asụsụ na {language}. Ị nwere ike ịgbanwe ya oge ọ bụla site na ịpị LANGUAGE.",
    languageMenuHint: "Pị LANGUAGE oge ọ bụla iji gbanwee asụsụ.",
    mainMenuPrompt: "Zaa site na nọmba, ma ọ bụ gwa m ihe ị na-achọ.",
    backToMenu: "Laghachi na menu isi",
    invalidSelection: "Ndo, aghọtaghị m — zaa MENU iji hụ nhọrọ ọzọ.",
    catalogHeader: "🛍️ Ngwaahịa anyị:",
    catalogEmpty: "Enweghị ngwaahịa ugbu a — biko lelee ọzọ n'oge na-adịghị anya.",
    catalogItemOutOfStock: "(gwụrụ)",
    catalogItemAdded: "Etinyela {product} ×{qty} n'ime ngọdo gị. 🛒",
    catalogMoreHint: "Zaa aha ma ọ bụ nọmba ngwaahịa iji tinye ya na ngọdo.",
    cartSummaryHeader: "🛒 Ngọdo gị:",
    cartEmpty: "Ngọdo gị dị efu.",
    checkoutPrompt: "Zaa CHECKOUT iji zipu ihe ị chọrọ, ma ọ bụ gaa n'ihu ịzụta.",
    orderConfirmPrompt: "Kwado ihe ị zụrụ? Zaa EE iji kwado ma ọ bụ MBA iji kagbuo.",
    orderPlaced: "✅ Ezipula ihe ị chọrọ {orderNumber}! Ngụkọta: {total} {currency}.",
    orderCancelled: "Akagbuola ihe ị zụrụ — a naghị ewepụ ego ọ bụla.",
    askDeliveryAddress: "Biko zipu adreesị nnabata gị (okporo ụzọ, mpaghara, obodo).",
    discoveryAskLocation: "📍 Kesaa ebe ị nọ iji hụ ụlọ ahịa dị gị nso.",
    discoveryEmpty: "Ahụghị ụlọ ahịa ọ bụla dị gị nso — nwaa ebe ọzọ.",
    discoveryHeader: "Ụlọ ahịa dị gị nso:",
    paymentPrompt: "💳 Ngụkọta ị ga-akwụ: {total} {currency}.",
    paymentLinkReady: "Pịa iji kwụọ ụgwọ n'enweghị nsogbu: {url}",
    paymentReceived: "✅ Enwetala ụgwọ — daalụ! Ana m akọzi ihe ị zụrụ.",
    paymentFailed: "❌ Ịkwụ ụgwọ agaghị — nwaa ọzọ ma ọ bụ họrọ ụzọ ọzọ.",
    // paymentPending intentionally untranslated in Igbo — exercises the
    // locale→en fallback chain (see J137).
  },
  sw: {
    languageMenuPrompt: "🌐 Chagua lugha yako:",
    languageSetConfirm: "Lugha imewekwa kuwa {language}. Unaweza kuibadilisha wakati wowote kwa kuandika LANGUAGE.",
    languageMenuHint: "Andika LANGUAGE wakati wowote kubadilisha lugha.",
    mainMenuPrompt: "Jibu kwa nambari, au niambie unachotafuta.",
    backToMenu: "Rudi kwenye menyu kuu",
    invalidSelection: "Samahani, sikuelewa — jibu MENU kuona chaguo tena.",
    catalogHeader: "🛍️ Bidhaa zetu:",
    catalogEmpty: "Hakuna bidhaa kwa sasa — tafadhali rudi hivi karibuni.",
    catalogItemOutOfStock: "(imeisha)",
    catalogItemAdded: "{product} ×{qty} imewekwa kwenye kikapu chako. 🛒",
    catalogMoreHint: "Jibu kwa jina au nambari ya bidhaa kuiweka kwenye kikapu.",
    cartSummaryHeader: "🛒 Kikapu chako:",
    cartEmpty: "Kikapu chako ni tupu.",
    checkoutPrompt: "Jibu CHECKOUT kuweka agizo, au endelea kununua.",
    orderConfirmPrompt: "Thibitisha agizo lako? Jibu NDIYO kuthibitisha au HAPANA kughairi.",
    orderPlaced: "✅ Agizo {orderNumber} limewekwa! Jumla: {total} {currency}.",
    orderCancelled: "Agizo lako limeghairiwa — hakuna malipo yaliyofanywa.",
    askDeliveryAddress: "Tafadhali tuma anwani yako ya kufikishia (mtaa, eneo, jiji).",
    discoveryAskLocation: "📍 Shiriki eneo lako kuona biashara zilizo karibu nawe.",
    discoveryEmpty: "Hakuna biashara zilizopatikana karibu nawe — jaribu eneo lingine.",
    discoveryHeader: "Biashara zilizo karibu nawe:",
    paymentPrompt: "💳 Jumla ya kulipa: {total} {currency}.",
    paymentLinkReady: "Gusa kulipa kwa usalama: {url}",
    paymentReceived: "✅ Malipo yamepokea — asante! Agizo lako linaandaliwa.",
    paymentFailed: "❌ Malipo hayakufanikiwa — jaribu tena au chagua njia nyingine.",
    paymentPending: "Malipo yako yanathibitishwa — tutakujulisha hivi karibuni.",
  },
  am: {
    languageMenuPrompt: "🌐 ቋንቋዎን ይምረጡ:",
    languageSetConfirm: "ቋንቋ ወደ {language} ተቀምጧል። በማንኛውም ጊዜ LANGUAGE ብለው መለወጥ ይችላሉ።",
    languageMenuHint: "ቋንቋ ለመቀየር በማንኛውም ጊዜ LANGUAGE ይጻፉ።",
    mainMenuPrompt: "በቁጥር ይመልሱ፣ ወይም የሚፈልጉትን ይንገሩኝ።",
    backToMenu: "ወደ ዋናው ምናሌ ተመለስ",
    invalidSelection: "ይቅርታ፣ አልገባኝም — አማራጮቹን እንደገና ለማየት MENU ብለው ይመልሱ።",
    catalogHeader: "🛍️ የእኛ ምርቶች:",
    catalogEmpty: "በአሁኑ ጊዜ ምንም ምርቶች የሉም — እባክዎ ቆይተው ይመልከቱ።",
    catalogItemOutOfStock: "(አልቋል)",
    catalogItemAdded: "{product} ×{qty} ወደ ጋሪዎ ታክሏል። 🛒",
    catalogMoreHint: "ወደ ጋሪ ለመጨመር በምርት ስም ወይም ቁጥር ይመልሱ።",
    cartSummaryHeader: "🛒 ጋሪዎ:",
    cartEmpty: "ጋሪዎ ባዶ ነው።",
    checkoutPrompt: "ትእዛዝ ለመስጠት CHECKOUT ብለው ይመልሱ፣ ወይም መግዛትዎን ይቀጥሉ።",
    orderConfirmPrompt: "ትእዛዝዎን ያረጋግጡ? ለማረጋገጥ አዎ ወይም ለመሰረዝ አይ ብለው ይመልሱ።",
    orderPlaced: "✅ ትእዛዝ {orderNumber} ተሰጥቷል! ጠቅላላ: {total} {currency}።",
    orderCancelled: "ትእዛዝዎ ተሰርዟል — ምንም ክፍያ አልተፈጸመም።",
    askDeliveryAddress: "እባክዎ የመላኪያ አድራሻዎን ይላኩ (መንገድ፣ አካባቢ፣ ከተማ)።",
    discoveryAskLocation: "📍 በአቅራቢያዊ ያሉ ንግዶችን ለማየት አካባቢዎን ያጋሩ።",
    discoveryEmpty: "በአቅራቢያዊ ምንም ንግድ አልተገኘም — ሌላ ቦታ ይሞክሩ።",
    discoveryHeader: "በአቅራቢያዊ ያሉ ንግዶች:",
    paymentPrompt: "💳 የሚከፍሉት ጠቅላላ: {total} {currency}።",
    paymentLinkReady: "በደህና ለመክፈል ይንኩ: {url}",
    paymentReceived: "✅ ክፍያ ደርሷል — አመሰግናለሁ! ትእዛዝዎ እየተዘጋጀ ነው።",
    paymentFailed: "❌ ክፍያ አልተሳካም — እባክዎ እንደገና ይሞክሩ ወይም ሌላ መንገድ ይምረጡ።",
    // paymentPending intentionally untranslated in Amharic — exercises the
    // locale→en fallback chain (see J137).
  },
};

/** {var} interpolation for catalog templates. */
export function interpolate(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/**
 * W27 catalog lookup with fallback chain locale→en. Tenant overrides (from
 * tenant_i18n_overrides, when provided) win over the locale pack.
 */
export function t27(
  locale: string | null | undefined,
  key: MessageKey,
  vars: Record<string, string | number> = {},
  overrides?: Partial<Record<MessageKey, string>> | null,
): string {
  const template =
    overrides?.[key] ??
    (isLocale(locale) ? MESSAGE_CATALOG[locale][key] : undefined) ??
    EN_CATALOG[key];
  return interpolate(template, vars);
}

// ── Language selection flow ──────────────────────────────────────────────────

/** Human-readable language names shown in the picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  fr: "Français",
  ha: "Hausa",
  yo: "Yorùbá",
  ig: "Igbo",
  sw: "Kiswahili",
  am: "አማርኛ (Amharic)",
};

/** Numbered language-picker menu (rendered in the customer's current locale). */
export function buildLanguageMenu(locale: string | null | undefined): string {
  const lines = SUPPORTED_LOCALES.map((l, i) => `${i + 1}. ${LOCALE_NAMES[l]}`);
  return [t27(locale, "languageMenuPrompt"), ...lines].join("\n");
}

/**
 * Parse a reply to the language menu: 1-based index or a language name/code.
 * Returns the chosen locale or null when the reply doesn't resolve.
 */
export function parseLanguageChoice(reply: string): Locale | null {
  const t = (reply ?? "").trim().toLowerCase();
  if (!t) return null;
  const idx = Number(t);
  if (Number.isInteger(idx) && idx >= 1 && idx <= SUPPORTED_LOCALES.length) {
    return SUPPORTED_LOCALES[idx - 1];
  }
  for (const l of SUPPORTED_LOCALES) {
    if (t === l || t === LOCALE_NAMES[l].toLowerCase()) return l;
  }
  // Common aliases customers type.
  const realAliases: Record<string, Locale> = {
    english: "en", french: "fr", francais: "fr", "français": "fr",
    hausa: "ha", harshen: "ha", yoruba: "yo", "yorùbá": "yo", igbo: "ig",
    swahili: "sw", kiswahili: "sw", amharic: "am", "አማርኛ": "am",
  };
  return realAliases[t] ?? null;
}

/** True when the inbound text asks to (re)open the language picker. */
export function isLanguageMenuRequest(text: string): boolean {
  const t = (text ?? "").trim().toLowerCase();
  return (
    t === "language" || t === "languages" || t === "lang" ||
    t === "change language" || t === "harshe" || t === "èdè" || t === "asụsụ" ||
    t === "lugha" || t === "langue" || t === "ቋንቋ"
  );
}

// ── Locale-aware NLU ─────────────────────────────────────────────────────────
//
// Map localized keywords to existing intent ids so menu navigation and core
// intents work in every supported language. `matchLocalizedIntent` is the
// single seam the inbound pipeline consults before falling back to the LLM.

export type LocalizedIntent =
  | "menu" | "shop" | "track" | "support" | "handoff" | "booking"
  | "checkout" | "pay" | "discover" | "language" | "confirm" | "cancel";

export const LOCALIZED_INTENT_KEYWORDS: Record<LocalizedIntent, Partial<Record<Locale, string[]>>> = {
  menu: {
    en: ["menu", "start", "home"],
    fr: ["menu", "accueil"],
    ha: ["menu", "farko"],
    yo: ["àkópọ̀", "ibẹrẹ"],
    ig: ["menu", "mbido"],
    sw: ["menyu", "mwanzo"],
    am: ["ምናሌ", "መነሻ"],
  },
  shop: {
    en: ["shop", "buy", "products", "catalog", "browse"],
    fr: ["acheter", "produits", "catalogue", "boutique"],
    ha: ["sayayya", "saya", "kayayyaki", "shago", "shaguna"],
    yo: ["rà", "ọjà", "ra oja", "itaja"],
    ig: ["zụta", "ahịa", "ngwaahịa", "ịzụ"],
    sw: ["nunua", "bidhaa", "duka", "mnunuzi"],
    am: ["ግዛ", "ምርቶች", "ሱቅ", "ግብዣ"],
  },
  track: {
    en: ["track", "status", "where is my order"],
    fr: ["suivre", "statut", "suivi"],
    ha: ["bibiya", "bibiyi", "matsayi"],
    yo: ["tọpa", "ipò àṣẹ"],
    ig: ["lelee", "soro"],
    sw: ["fuatilia", "hali"],
    am: ["ከታተል", "ሁኔታ"],
  },
  support: {
    en: ["help", "support"],
    fr: ["aide", "assistance"],
    ha: ["taimako", "taimaka"],
    yo: ["ìrànlọ́wọ́", "ranlowo"],
    ig: ["enyemaka"],
    sw: ["msaada", "saidia"],
    am: ["እርዳታ", "ርዳታ"],
  },
  handoff: {
    en: ["human", "agent", "person"],
    fr: ["agent", "humain", "personne"],
    ha: ["wakili", "mutum"],
    yo: ["aṣojú", "ẹ̀nìyàn"],
    ig: ["nnọchi", "mmadụ"],
    sw: ["mtu", "wakala"],
    am: ["ሰው", "ወኪል"],
  },
  booking: {
    en: ["book", "appointment"],
    fr: ["rendez-vous", "réserver"],
    ha: ["alƙawari", "naya alƙawari"],
    yo: ["ìpàdé", "pa àkókò"],
    ig: ["oge njikọ", "hazie"],
    sw: ["miadi", "weka miadi"],
    am: ["ቀጠሮ"],
  },
  checkout: {
    en: ["checkout", "cart", "done"],
    fr: ["panier", "commander", "terminé"],
    ha: ["kwando", "gama", "kammala"],
    yo: ["àpò", "parí", "checkout"],
    ig: ["ngọdo", "mezue"],
    sw: ["kikapu", "maliza", "kamilisha"],
    am: ["ጋሪ", "ጨርስ", "አጠናቅቅ"],
  },
  pay: {
    en: ["pay", "payment", "pay now"],
    fr: ["payer", "paiement"],
    ha: ["biya", "biyan"],
    yo: ["sanwó", "sanwo"],
    ig: ["kwụọ", "ịkwụ ụgwọ"],
    sw: ["lipa", "malipo"],
    am: ["ክፈል", "ክፍያ", "መክፈል"],
  },
  discover: {
    en: ["near me", "nearby", "around me", "discover"],
    fr: ["près de moi", "à proximité", "proximité"],
    ha: ["kusa da ni", "a kusa", "kusa"],
    yo: ["nítòsí mi", "nítòsí", "sun mọ́ mi"],
    ig: ["dị m nso", "nso"],
    sw: ["karibu nami", "karibu", "jirani"],
    am: ["በአቅራቢያዬ", "አቅራቢያ", "ቅርብ"],
  },
  language: {
    en: ["language", "change language"],
    fr: ["langue", "changer de langue"],
    ha: ["harshe", "canza harshe"],
    yo: ["èdè", "yí èdè padà"],
    ig: ["asụsụ", "gbanwee asụsụ"],
    sw: ["lugha", "badilisha lugha"],
    am: ["ቋንቋ", "ቋንቋ ቀይር"],
  },
  confirm: {
    en: ["yes", "confirm", "ok"],
    fr: ["oui", "confirmer", "d'accord"],
    ha: ["eh", "ee", "tabbatar", "lafiya"],
    yo: ["bẹẹni", "been", "jẹ́rìí"],
    ig: ["ee", "kwado"],
    sw: ["ndiyo", "thibitisha", "sawa"],
    am: ["አዎ", "አረጋግጥ", "እሺ"],
  },
  cancel: {
    en: ["no", "cancel", "stop"],
    fr: ["non", "annuler", "arrêter"],
    ha: ["a'a", "soke", "daina"],
    yo: ["rara", "fagi lé", "dáwọ́"],
    ig: ["mba", "kagbuo", "kwụsị"],
    sw: ["hapana", "ghairi", "acha"],
    am: ["አይ", "ሰርዝ", "ተው"],
  },
};

/**
 * Map inbound text (in the customer's locale) to a core intent. Exact
 * whole-phrase match against the locale's keyword list (case-insensitive,
 * diacritic-insensitive), English list always included as the final fallback
 * so code-switched messages still navigate. Returns null when nothing maps —
 * callers fall through to the existing NLP pipeline.
 */
export function matchLocalizedIntent(
  text: string,
  locale: string | null | undefined,
): LocalizedIntent | null {
  const norm = (s: string) =>
    s.trim().toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");
  const t = norm(text ?? "");
  if (!t) return null;
  const loc: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const localesToTry: Locale[] = loc === "en" ? ["en"] : [loc, "en"];
  for (const [intent, perLocale] of Object.entries(LOCALIZED_INTENT_KEYWORDS) as Array<
    [LocalizedIntent, Partial<Record<Locale, string[]>>]
  >) {
    for (const l of localesToTry) {
      for (const kw of perLocale[l] ?? []) {
        if (norm(kw) === t) return intent;
      }
    }
  }
  return null;
}
