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

// === W49 I18N-PCM === Nigerian Pidgin (pcm) promoted to first-class locale.
export type Locale = "en" | "fr" | "ha" | "yo" | "ig" | "sw" | "am" | "pcm";
export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "fr", "ha", "yo", "ig", "sw", "am", "pcm"];
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
  /** W45 MSG-24: fail-soft reply when a non-receipt photo pipeline errors. */
  imageProcessingFailed: string;
  /** === W47 crosscutting (ONB-I18N-1): age-gate attestation prompt
   *  ({age} = required age, {items} = optional parenthesised product list). === */
  ageGatePrompt: string;
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
  // === W49 I18N-PCM ===
  pcm:
    "Credit bureau mata: as you accept, you agree say we fit report your trade-credit " +
    "waka (draws, how you dey pay back, any delay and how you settle am) give the licensed " +
    "Naija credit bureaus (CRC Credit Bureau / CreditRegistry). You fit complain about any " +
    "report any time.",
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
    imageProcessingFailed: "Sorry — I couldn't process that photo. Try sending it again, or type what you're looking for. 📷",
    ageGatePrompt: "🔞 One or more items in your cart{items} are age-restricted. Please confirm you are {age} years or older by replying \"YES {age}+\" to complete your order.",
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
    imageProcessingFailed: "Désolé — je n'ai pas pu traiter cette photo. Renvoyez-la ou tapez ce que vous cherchez. 📷",
    ageGatePrompt: "🔞 Un ou plusieurs articles de votre panier{items} sont réservés aux adultes. Confirmez que vous avez {age} ans ou plus en répondant \"OUI {age}+\" pour terminer votre commande.",
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
    imageProcessingFailed: "Yi hakuri — ban iya sarrafa wannan hoton ba. Aika shi kuma, ko rubuta abin da kake nema. 📷",
    ageGatePrompt: "🔞 Akwai abubuwa a cikin kwandonka{items} da ke buƙatar shekara. Tabbitar da cewa kana da shekara {age} ko fiye ta amsa \"EE {age}+\" don kammala odar ka.",
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
    imageProcessingFailed: "Ma binu — mi o le ṣe àtúnṣe fọ́tò yìí. Tún rán ǹṣe, tàbí kílò ohun tí o ń wá. 📷",
    ageGatePrompt: "🔞 Ohun kan tàbí síwájú nínú àpò rẹ{items} ní ìdíwọ́ ọjọ́-ori. Jẹ́rìíṣí pé o ti pé dí {age} nípa fìdáhùn \"BẸẸNI {age}+\" láti parí àṣẹ rẹ.",
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
    imageProcessingFailed: "Ndo — enweghị m ike ịhazi foto ahụ. Zipu ya ọzọ, ma ọ bụ dee ihe ị na-achọ. 📷",
    ageGatePrompt: "🔞 Otu ihe ma ọ bụ karịa n'ụgbọ ahịa gị{items} nwere oke afọ. Gosi na ị ruru afọ {age} ma ọ bụ karịa site na ịza \"EẸ {age}+\" iji mezue ọrụ gị.",
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
    imageProcessingFailed: "Samahani — sikuweza kuchakata picha hiyo. Tuma tena, au andika unachotafuta. 📷",
    ageGatePrompt: "🔞 Bidhaa moja au zaidi kwenye mkoba wako{items} zina kikomo cha umri. Thibitisha kuwa una miaka {age} au zaidi kwa kujibu \"NDIYO {age}+\" ili kukamilisha agizo lako.",
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
    imageProcessingFailed: "ይቅርታ — ያንን ፎቶ ማስራት አልቻልኩም። እንደገና ይላኩት፣ ወይም የሚፈልጉትን ይጻፉ። 📷",
    ageGatePrompt: "🔞 በጋሪዎ ውስጥ ያሉ አንድ ወይም ተጨማሪ ዕቃዎች{items} የዕድሜ ገደብ አላቸው። ትእዛዝዎን ለማጠናቀቅ {age} ዓመት ወይም ከዚያ በላይ መሆንዎን \"አዎ {age}+\" ብለው ይምለሱ።",
  },
  // === W49 I18N-PCM === Nigerian Pidgin pack. Tone follows the onboarding
  // copilot pcm pack (onboardingCopilot/language.ts). consentPrompt MUST keep
  // the literal word "WhatsApp" — telegramInbound does a WhatsApp→Telegram
  // string swap on it (I18N-8).
  pcm: {
    greeting: "How far! Welcome to {businessName}! Wetin you need today?",
    menuLabels: {
      shop: "Buy tins / see products",
      track: "Track my order",
      support: "Get help",
      booking: "Book appointment",
      handoff: "Talk to person",
      procurement: "Restock / buy supplies",
    },
    consentPrompt:
      "Before we continue: we wan dey send you order updates and offers for WhatsApp. " +
      "Under NDPR we need your consent. Reply YES to dey receive order updates, or NO to opt out. " +
      "You fit change am any time — just message us.",
    consentGranted: "Thank you! You don opt in for order updates for WhatsApp.",
    consentDenied:
      "No wahala — you don opt out of proactive order updates. " +
      "You fit still message us any time, and reply YES later to opt back in.",
    cartRecovery: "You leave items for your cart — reply CHECKOUT make you complete your order. 🛒",
    shortageNote: "Some items no dey stock right now.",
    tracking: "Track your order",
    voiceNotEnabled: "Sorry o, voice note no dey work now — abeg type your message instead. 🎤❌",
    reorderNoPriorOrder: "I no fit find any order wey you don pay before for this number — tell me wetin you want make I add am to your cart.",
    disputeConfirm: "We don log your complaint and our team don hear am. We go get back to you sharp sharp. 🙏",
    orderingSuspended: "Ordering don suspend with this supplier{reason}. Pay your outstanding balance{outstanding} make ordering open again.",
    orderingUnavailable: "We no fit confirm your credit status just now — abeg try again small time. Your cart still dey as e be and we no place any order.",
    paidViaCredit: "Paid via credit — e due {dueDate}. Pay before the due date make you fit dey order.",
    imageProcessingFailed: "Sorry — I no fit process dat photo. Send am again, or type wetin you dey find. 📷",
    ageGatePrompt: "🔞 Some items for your cart{items} na for adults only. Confirm say you don reach {age} years by replying \"YES {age}+\" make you complete your order.",
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
    // === W49 I18N-PCM === bridge nlp session language names to pcm locale.
    case "pidgin": case "pcm": case "naija": case "naija pidgin":
    case "nigerian pidgin": case "broken": case "broken english": return "pcm";
    default: return DEFAULT_LOCALE; // english, unknown
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
  // === W49 I18N-PCM === ported from onboardingCopilot/language.ts pcm list.
  // High-precision markers (abeg/wetin/how far/wahala) carry detection;
  // multi-word phrases ("i don", "no wahala", …) score 2pts each. The
  // apostrophe-non-boundary regex below keeps "i don" out of "I don't".
  pcm: [
    "abeg", "how far", "dey", "wetin", "wahala", "oga", "sabi", "comot",
    "waka", "chop", "una", "make i", "no dey", "e dey", "na me",
    "i don", "e don", "we don", "dem don", "you don",
    "no wahala", "sha", "wey", "wan", "fit", "dey sell", "na so", "yarn",
    "padi", "sef", "tori",
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
// === W46 platform-p2 (MSG-23) === scoring shared by detectLocale and the
// confidence-aware detectLocaleDetailed.
function scoreLocales(lower: string): Record<Locale, number> {
  const scores: Record<Locale, number> = { en: 0, fr: 0, ha: 0, yo: 0, ig: 0, sw: 0, am: 0, pcm: 0 };
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
  return scores;
}

function bestLocaleFromScores(scores: Record<Locale, number>): { best: Locale; bestScore: number } {
  let best: Locale = DEFAULT_LOCALE;
  let bestScore = 0;
  for (const lang of SUPPORTED_LOCALES) {
    if (scores[lang] > bestScore) {
      bestScore = scores[lang];
      best = lang;
    }
  }
  return { best, bestScore };
}

export function detectLocale(text: string): Locale {
  const lower = (text ?? "").toLowerCase();
  if (!lower.trim()) return DEFAULT_LOCALE;
  const { best, bestScore } = bestLocaleFromScores(scoreLocales(lower));
  return bestScore > 0 ? best : DEFAULT_LOCALE;
}

// === W46 platform-p2 (MSG-23) === confidence-aware detection. Pre-W46 an
// unsupported/ambiguous locale silently degraded to STICKY English — the
// customer could be stuck in the wrong language for 30 days. Now detection
// reports a confidence; LOW-confidence text routes to the language picker
// (handled in useCases.handleConversationalInbound + telegramInbound) and is
// never made sticky.
/** A single stopword is 1.5pts, a phrase 2pts — confidence needs ≥3. */
export const LOCALE_CONFIDENT_THRESHOLD = 3;

export interface LocaleDetection {
  locale: Locale;
  score: number;
  lowConfidence: boolean;
}

/** Common English function words — presence means "not an unknown locale". */
export const ENGLISH_SIGNAL_WORDS: readonly string[] = [
  "hello", "hi", "hey", "yes", "no", "ok", "okay", "thanks", "thank", "please",
  "menu", "shop", "buy", "order", "track", "price", "how", "what", "where",
  "when", "want", "need", "i", "my", "me", "you", "the", "is", "are", "do",
  "can", "help", "good", "morning", "afternoon", "evening", "pay", "cart",
  "checkout", "delivery", "status", "language", "start", "stop", "human",
  "agent", "book", "booking", "support", "catalog", "products",
];

/**
 * True when the text carries clear English signal — OR is not language-
 * bearing at all (menu digits, punctuation, ≤2 chars). Such texts must NEVER
 * trigger the low-confidence picker.
 */
export function looksLikeEnglish(text: string): boolean {
  const lower = (text ?? "").trim().toLowerCase();
  if (!lower) return true;
  if (!/[a-zà-ỹ]/i.test(lower)) return true; // digits/punct only (menu picks)
  if (lower.length <= 2) return true;
  // Digit guard: commerce text with quantities ("2 jollof", "3kg rice") is an
  // ORDER, not language signal — the picker must never hijack it.
  if (/\d/.test(lower)) return true;
  // Vowel guard: text without a single vowel ("asdfgh", "pls", "kg") is not
  // pronounceable language in ANY supported locale — it is keyboard mash or
  // an abbreviation, never a reason to show the language picker.
  if (!/[aeiou]/.test(lower)) return true;
  const tokens = lower.split(/[^a-zà-ỹ']+/i).filter(Boolean);
  if (tokens.length === 0) return true;
  // Single-token text carries no reliable language signal — one unknown word
  // ("asdfgh" keyboard mash, a name, an abbreviation) must NEVER open the
  // picker. Multi-word zero-signal text (e.g. unsupported Portuguese) still
  // can. (Weak single-token signal in a SUPPORTED locale is handled by the
  // score > 0 branch of detectLocaleDetailed, not here.)
  if (tokens.length === 1) return true;
  return tokens.some((t) => (ENGLISH_SIGNAL_WORDS as readonly string[]).includes(t));
}

/**
 * True when any token of `text` also appears in a tenant catalog product
 * name ("jollof rice" matches "2 jollof please"). Commerce text that names
 * a sellable product is an order attempt — the low-confidence picker must
 * not hijack it even when the words are otherwise unknown to the detector.
 */
export function sharesTokenWithCatalog(text: string, productNames: readonly string[]): boolean {
  const tokens = new Set(
    (text ?? "").toLowerCase().split(/[^a-zà-ỹ0-9']+/i).filter((t) => t.length > 2),
  );
  if (tokens.size === 0) return false;
  for (const name of productNames) {
    for (const t of (name ?? "").toLowerCase().split(/[^a-zà-ỹ0-9']+/i)) {
      if (t.length > 2 && tokens.has(t)) return true;
    }
  }
  return false;
}

export function detectLocaleDetailed(text: string): LocaleDetection {
  const lower = (text ?? "").toLowerCase();
  if (!lower.trim()) return { locale: DEFAULT_LOCALE, score: 0, lowConfidence: false };
  const { best, bestScore } = bestLocaleFromScores(scoreLocales(lower));
  if (bestScore >= LOCALE_CONFIDENT_THRESHOLD) {
    return { locale: best, score: bestScore, lowConfidence: false };
  }
  if (bestScore > 0) {
    // Weak signal of a supported non-English locale — offer the picker
    // (rendered in the weakly-detected locale) instead of sticking it.
    return { locale: best, score: bestScore, lowConfidence: true };
  }
  // Zero signal: English-looking text is fine; anything else (unsupported
  // locale, e.g. Portuguese/Pidgin) is low-confidence → picker.
  return { locale: DEFAULT_LOCALE, score: 0, lowConfidence: !looksLikeEnglish(lower) };
}
// === END W46 platform-p2 (MSG-23) ===

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

// === W46 platform-p2 (MSG-23) === confidence-aware resolution.
export interface ResolvedLocale {
  locale: Locale;
  source: "sticky" | "detected" | "tenant-default" | "default";
  /** True when detection was weak/unsupported — caller offers the picker. */
  lowConfidence: boolean;
  /**
   * Detection score behind a lowConfidence flag: > 0 means a SUPPORTED
   * locale has weak evidence (picker rendered in that locale); 0 means zero
   * signal — ordinary commerce/chat text the picker must NOT hijack.
   */
  score?: number;
}

/**
 * Resolve the effective locale for an inbound text:
 *   sticky per-customer → detected from text (sticky ONLY when confident,
 *   W46 MSG-23) → tenant default → English.
 */
export async function resolveLocaleDetailed(opts: {
  tenantId: string;
  phone: string;
  text?: string;
  tenantSettings?: Record<string, unknown> | null;
  customerLanguage?: string | null;
}): Promise<ResolvedLocale> {
  const sticky = await getStickyLocale(opts.tenantId, opts.phone, {
    customerLanguage: opts.customerLanguage ?? undefined,
  });
  if (sticky) return { locale: sticky, source: "sticky", lowConfidence: false };
  const tenantDefaultRaw = (opts.tenantSettings as any)?.locale;
  const tenantDefault: Locale = isLocale(tenantDefaultRaw) ? tenantDefaultRaw : DEFAULT_LOCALE;
  if (opts.text) {
    const det = detectLocaleDetailed(opts.text);
    if (det.lowConfidence) {
      // W46 MSG-23: weak/unsupported detection is NOT made sticky — the
      // caller shows the language picker instead (rendered in the weakly
      // detected locale when there is one).
      const locale = det.locale !== DEFAULT_LOCALE ? det.locale : tenantDefault;
      return { locale, source: locale === tenantDefault ? "tenant-default" : "default", lowConfidence: true, score: det.score };
    }
    if (det.locale !== DEFAULT_LOCALE) {
      await setStickyLocale(opts.tenantId, opts.phone, det.locale);
      return { locale: det.locale, source: "detected", lowConfidence: false };
    }
  }
  return { locale: tenantDefault, source: tenantDefault !== DEFAULT_LOCALE ? "tenant-default" : "default", lowConfidence: false };
}

/** Back-compat wrapper: effective locale only (see resolveLocaleDetailed). */
export async function resolveLocale(opts: {
  tenantId: string;
  phone: string;
  text?: string;
  tenantSettings?: Record<string, unknown> | null;
  customerLanguage?: string | null;
}): Promise<Locale> {
  return (await resolveLocaleDetailed(opts)).locale;
}
// === END W46 platform-p2 (MSG-23) ===

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
  // === W50 CHANNELS === discovery channel prompts + radius widening
  | "discoveryAskLocationTelegram" | "discoveryAskLocationTyped"
  | "discoveryConfirmStaleLocation" | "discoveryRadiusExpanded" | "discoveryMapsHint"
  // payment
  | "paymentPrompt" | "paymentLinkReady" | "paymentReceived" | "paymentFailed"
  | "paymentPending"
  // === W51 PROMOS === promo spotlight card + most-ordered chrome
  | "promoSpotlightBody" | "promoShopNow" | "promoViewDeal" | "promoLine"
  | "popularBadge" | "popularHeader" | "popularEmpty" | "popularMenuLabel"
  // === W52 SHARE === share-this-deal bundle + DEAL/REF inbound grammar
  | "shareDealBlurb" | "shareDealForward" | "shareDealBundleMessage"
  | "shareButtonLabel" | "shareDealRedeemed" | "shareDealSelfReferral"
  | "shareDealBadPromo"
  // === W53 EVENTS === events/ticketing chat + USSD flow
  | "eventsHeader" | "eventsEmpty" | "eventsPickHint" | "eventsPickInvalid"
  | "eventTicketTypesHeader" | "eventTicketTypesEmpty" | "eventTicketsLeft"
  | "eventBuyHint" | "eventTicketPurchaseReady" | "eventTicketLinkPending"
  | "eventTicketPurchaseFailed" | "eventTicketSoldOut"
  | "eventMyTicketsHeader" | "eventMyTicketsEmpty"
  | "eventCheckinNotStaff" | "eventCheckinOk" | "eventCheckinNotFound"
  | "eventCheckinAlready" | "eventCheckinEventCancelled" | "eventCheckinVoid"
  | "eventUssdPickEvent" | "eventUssdPickQty"
  // === W54 disputes === buyer dispute-resolution + merchant-response notices
  | "disputeResolvedBuyer" | "disputeOutcomeFullRefund" | "disputeOutcomePartialRefund"
  | "disputeOutcomeRelease" | "disputeOutcomeNoAction" | "disputeOutcomeReplacement"
  | "disputeMerchantResponded"
  // === W54 capabilities === CAP-1 membership tiers chat + CAP-2 USSD depth
  | "membershipPlansHeader" | "membershipPlansEmpty" | "membershipPlanLine"
  | "membershipJoinHint" | "membershipJoinActive" | "membershipJoinPayment"
  | "membershipJoinLinkPending" | "membershipJoinAlready" | "membershipJoinFailed"
  | "membershipPickInvalid" | "membershipBenefitsBoth" | "membershipBenefitsDiscount"
  | "membershipBenefitsPoints" | "membershipPriceFree"
  | "membershipStatusActive" | "membershipStatusUntil" | "membershipStatusCancelling"
  | "membershipStatusNone" | "membershipCancelPeriodEnd" | "membershipCancelImmediate"
  | "membershipCancelNone"
  | "ussdSavingsHeader" | "ussdSavingsNone" | "ussdSavingsLine"
  | "ussdLoyaltyBalance" | "ussdLoyaltyDisabled"
  // === W55 parity (PARITY-8) === customer wallet balance self-serve
  // (WA+TG+SMS keyword + USSD read-only balance query)
  | "walletBalanceLine" | "walletBalanceNone" | "walletLedgerHeader"
  | "walletLedgerEntry";

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
  // === W50 MERGER === English WA copy keeps the pre-W50 wording verbatim
  // ("share your current location" — asserted by J123); the new TG/USSD/SMS
  // variants live in discoveryAskLocationTelegram / discoveryAskLocationTyped.
  discoveryAskLocation: "To see businesses near you, tap 📎 → Location and share your current location.",
  discoveryEmpty: "No businesses found near you yet — try a different location.",
  discoveryHeader: "Businesses near you:",
  // === W50 CHANNELS ===
  discoveryAskLocationTelegram: "📍 Tap the button below to share your location and see businesses near you.",
  discoveryAskLocationTyped: "📍 Reply with your area or nearest landmark (e.g. \"Wuse 2\") to find businesses near you.",
  discoveryConfirmStaleLocation: "📍 I have your saved delivery location on file. Reply USE SAVED to search around it, or share your current location.",
  discoveryRadiusExpanded: "🔍 Nothing within {fromKm} km — I widened the search to {radiusKm} km.",
  discoveryMapsHint: "💡 Share a different location anytime to search around another area.",
  paymentPrompt: "💳 Total to pay: {total} {currency}.",
  paymentLinkReady: "Tap to pay securely: {url}",
  paymentReceived: "✅ Payment received — thank you! Your order is being prepared.",
  paymentFailed: "❌ Payment didn't go through — please try again or choose another method.",
  paymentPending: "Your payment is being confirmed — we'll update you shortly.",
  // === W51 PROMOS ===
  promoSpotlightBody: "🔥 {title} — {discount} with code {code}",
  promoShopNow: "🛍️ Shop now",
  promoViewDeal: "View deal",
  promoLine: "DEAL: {title} — {discount}. Use code {code}",
  popularBadge: "⭐ Most ordered",
  popularHeader: "⭐ Most ordered items:",
  popularEmpty: "No popular items yet — check back soon.",
  popularMenuLabel: "⭐ Popular items",
  // === W52 SHARE ===
  shareDealBlurb: "🔥 {title} — {discount} at our store! Use code {code}. Referral: {ref}",
  shareDealForward: "Forward: {blurb} {link}",
  shareDealBundleMessage: "📤 Share this deal with friends!\n{blurb}\n\nWhatsApp: {waUrl}\nTelegram: {tgUrl}\n\n{forward}",
  shareButtonLabel: "📤 Share",
  shareDealRedeemed: "✅ Deal {code} locked in — it applies automatically at checkout. Happy shopping!",
  shareDealSelfReferral: "Sorry — you can't use your own referral code. Share it with a friend instead!",
  shareDealBadPromo: "I couldn't find that deal ({code}) — it may have expired. Reply MENU to browse the store.",
  // === W53 EVENTS ===
  eventsHeader: "🎟️ Upcoming events:",
  eventsEmpty: "No upcoming events right now — please check back soon.",
  eventsPickHint: "Reply TICKET <number> to see ticket types (e.g. TICKET 1).",
  eventsPickInvalid: "Please reply EVENTS first, then TICKET <number> from the list.",
  eventTicketTypesHeader: "Ticket types:",
  eventTicketTypesEmpty: "No ticket types are on sale for that event yet.",
  eventTicketsLeft: "{count} left",
  eventBuyHint: "Reply BUY <number> [qty] to get a payment link (e.g. BUY 1 2).",
  eventTicketPurchaseReady: "🎟️ {qty} × {type} for {event} — total {currency} {total} (order {orderNumber}).",
  eventTicketLinkPending: "Your payment link is being prepared — the store will follow up shortly.",
  eventTicketPurchaseFailed: "Sorry, I couldn't start that ticket purchase just now — please try again.",
  eventTicketSoldOut: "Sorry — that ticket type is sold out.",
  eventMyTicketsHeader: "Your tickets:",
  eventMyTicketsEmpty: "You don't have any tickets yet — reply EVENTS to see what's on.",
  eventCheckinNotStaff: "Sorry, only store staff can check tickets in.",
  eventCheckinOk: "✅ Checked in: {code} ({event}). Welcome!",
  eventCheckinNotFound: "I couldn't find a ticket with code {code} for this store.",
  eventCheckinAlready: "⚠️ Ticket {code} was already checked in at {when}.",
  eventCheckinEventCancelled: "Ticket {code} belongs to a cancelled event — not valid for entry.",
  eventCheckinVoid: "Ticket {code} is {status} — not valid for entry.",
  eventUssdPickEvent: "Reply with the event number.",
  eventUssdPickQty: "How many tickets? Reply with a number.",
  // === W54 disputes ===
  disputeResolvedBuyer: "📋 The dispute on order {orderNumber} has been resolved. Outcome: {outcome}.{notes}",
  disputeOutcomeFullRefund: "a full refund of {amount} has been issued",
  disputeOutcomePartialRefund: "a partial refund of {amount} has been issued",
  disputeOutcomeRelease: "the payment was released to the merchant (no refund)",
  disputeOutcomeNoAction: "no further action was taken",
  disputeOutcomeReplacement: "a replacement/return request was opened (ref {rmaRef})",
  disputeMerchantResponded: "📋 The merchant responded to your dispute on order {orderNumber}. Our team is reviewing it now.",
  membershipPlansHeader: "💎 Membership plans:",
  membershipPlansEmpty: "No membership plans are available right now — please check back soon.",
  membershipPlanLine: "{n}. {name} — {price} ({benefits})",
  membershipJoinHint: "Reply JOIN MEMBERSHIP <number> to join, or MY MEMBERSHIP to check your status.",
  membershipJoinActive: "🎉 Welcome to {plan}! Your membership is ACTIVE — {benefits}. It applies automatically at checkout.",
  membershipJoinPayment: "💎 {plan} membership — total {currency} {total} (order {orderNumber}).",
  membershipJoinLinkPending: "Your payment link is being prepared — the store will follow up shortly.",
  membershipJoinAlready: "You already have an active {plan} membership — reply MY MEMBERSHIP to see it.",
  membershipJoinFailed: "Sorry, I couldn't start that membership just now — please try again.",
  membershipPickInvalid: "Please reply MEMBERSHIP first, then JOIN MEMBERSHIP <number> from the list.",
  membershipBenefitsBoth: "{discount}% off orders + {mult}x loyalty points",
  membershipBenefitsDiscount: "{discount}% off orders",
  membershipBenefitsPoints: "{mult}x loyalty points",
  membershipPriceFree: "FREE",
  membershipStatusActive: "💎 Your membership: {plan} — {benefits}.",
  membershipStatusUntil: " Active until {date}.",
  membershipStatusCancelling: " It will end on {date} (cancellation scheduled).",
  membershipStatusNone: "You don't have an active membership — reply MEMBERSHIP to see the plans.",
  membershipCancelPeriodEnd: "✅ Your {plan} membership will end on {date} — your benefits stay active until then.",
  membershipCancelImmediate: "✅ Your {plan} membership is cancelled — thank you for being a member!",
  membershipCancelNone: "You don't have an active membership to cancel.",
  ussdSavingsHeader: "Your savings circles:",
  ussdSavingsNone: "You are not in any savings circle yet.",
  ussdSavingsLine: "{name}: {amount}/{freq}, cycle {cycle}. Next payout: {next}.",
  ussdLoyaltyBalance: "Loyalty points balance: {points} pts.",
  ussdLoyaltyDisabled: "Loyalty rewards are not active at this store.",
  // === W55 parity (PARITY-8) ===
  walletBalanceLine: "👛 Wallet balance: {balance}.",
  walletBalanceNone: "👛 You don't have a wallet with this store yet — refunds and store credit land here.",
  walletLedgerHeader: "Recent wallet activity:",
  walletLedgerEntry: "{sign}{amount} — {reason} ({date})",
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
    // === W50 CHANNELS ===
    discoveryAskLocationTelegram: "📍 Touchez le bouton ci-dessous pour partager votre position et voir les commerces à proximité.",
    discoveryAskLocationTyped: "📍 Répondez avec votre quartier ou un repère (ex. « Wuse 2 ») pour trouver les commerces proches.",
    discoveryConfirmStaleLocation: "📍 J'ai votre adresse de livraison enregistrée. Répondez USE SAVED pour chercher autour d'elle, ou partagez votre position actuelle.",
    discoveryRadiusExpanded: "🔍 Rien à moins de {fromKm} km — recherche élargie à {radiusKm} km.",
    discoveryMapsHint: "💡 Partagez une autre position à tout moment pour chercher ailleurs.",
    paymentPrompt: "💳 Total à payer : {total} {currency}.",
    paymentLinkReady: "Touchez pour payer en toute sécurité : {url}",
    paymentReceived: "✅ Paiement reçu — merci ! Votre commande est en préparation.",
    paymentFailed: "❌ Le paiement n'a pas abouti — réessayez ou choisissez un autre moyen.",
    paymentPending: "Votre paiement est en cours de confirmation — nous vous informerons bientôt.",
    // === W51 PROMOS ===
    promoSpotlightBody: "🔥 {title} — {discount} avec le code {code}",
    promoShopNow: "🛍️ Acheter",
    promoViewDeal: "Voir l'offre",
    promoLine: "PROMO : {title} — {discount}. Code : {code}",
    popularBadge: "⭐ Le plus commandé",
    popularHeader: "⭐ Articles les plus commandés :",
    popularEmpty: "Pas encore d'articles populaires — revenez bientôt.",
    popularMenuLabel: "⭐ Populaires",
    // === W52 SHARE ===
    shareDealBlurb: "🔥 {title} — {discount} dans notre boutique ! Code : {code}. Parrainage : {ref}",
    shareDealForward: "Transférer : {blurb} {link}",
    shareDealBundleMessage: "📤 Partagez cette offre avec vos amis !\n{blurb}\n\nWhatsApp : {waUrl}\nTelegram : {tgUrl}\n\n{forward}",
    shareButtonLabel: "📤 Partager",
    shareDealRedeemed: "✅ Offre {code} activée — elle s'applique automatiquement au paiement. Bon shopping !",
    shareDealSelfReferral: "Désolé — vous ne pouvez pas utiliser votre propre code de parrainage. Partagez-le avec un ami !",
    shareDealBadPromo: "Je n'ai pas trouvé cette offre ({code}) — elle a peut-être expiré. Répondez MENU pour parcourir la boutique.",
    // === W53 EVENTS ===
    eventsHeader: "🎟️ Événements à venir :",
    eventsEmpty: "Aucun événement à venir pour le moment — revenez bientôt.",
    eventsPickHint: "Répondez TICKET <numéro> pour voir les billets (ex. TICKET 1).",
    eventsPickInvalid: "Répondez d'abord EVENTS, puis TICKET <numéro> de la liste.",
    eventTicketTypesHeader: "Types de billets :",
    eventTicketTypesEmpty: "Aucun billet n'est encore en vente pour cet événement.",
    eventTicketsLeft: "{count} restants",
    eventBuyHint: "Répondez BUY <numéro> [qté] pour recevoir un lien de paiement (ex. BUY 1 2).",
    eventTicketPurchaseReady: "🎟️ {qty} × {type} pour {event} — total {currency} {total} (commande {orderNumber}).",
    eventTicketLinkPending: "Votre lien de paiement est en préparation — la boutique vous contactera.",
    eventTicketPurchaseFailed: "Désolé, impossible de démarrer cet achat de billet — réessayez.",
    eventTicketSoldOut: "Désolé — ce type de billet est épuisé.",
    eventMyTicketsHeader: "Vos billets :",
    eventMyTicketsEmpty: "Vous n'avez pas encore de billets — répondez EVENTS pour voir les événements.",
    eventCheckinNotStaff: "Désolé, seul le personnel de la boutique peut valider les billets.",
    eventCheckinOk: "✅ Entrée validée : {code} ({event}). Bienvenue !",
    eventCheckinNotFound: "Aucun billet avec le code {code} pour cette boutique.",
    eventCheckinAlready: "⚠️ Le billet {code} a déjà été validé à {when}.",
    eventCheckinEventCancelled: "Le billet {code} appartient à un événement annulé — entrée refusée.",
    eventCheckinVoid: "Le billet {code} est {status} — entrée refusée.",
    eventUssdPickEvent: "Répondez avec le numéro de l'événement.",
    eventUssdPickQty: "Combien de billets ? Répondez avec un nombre.",
    // === W54 disputes ===
    disputeResolvedBuyer: "📋 Le litige sur la commande {orderNumber} a été résolu. Résultat : {outcome}.{notes}",
    disputeOutcomeFullRefund: "un remboursement intégral de {amount} a été émis",
    disputeOutcomePartialRefund: "un remboursement partiel de {amount} a été émis",
    disputeOutcomeRelease: "le paiement a été reversé au commerçant (pas de remboursement)",
    disputeOutcomeNoAction: "aucune autre action n'a été prise",
    disputeOutcomeReplacement: "une demande de remplacement/retour a été ouverte (réf {rmaRef})",
    disputeMerchantResponded: "📋 Le commerçant a répondu à votre litige sur la commande {orderNumber}. Notre équipe l'examine.",
    membershipPlansHeader: "💎 Formules d'adhésion :",
    membershipPlansEmpty: "Aucune formule d'adhésion disponible pour le moment — revenez bientôt.",
    membershipPlanLine: "{n}. {name} — {price} ({benefits})",
    membershipJoinHint: "Répondez JOIN MEMBERSHIP <numéro> pour adhérer, ou MY MEMBERSHIP pour voir votre statut.",
    membershipJoinActive: "🎉 Bienvenue dans {plan} ! Votre adhésion est ACTIVE — {benefits}. Elle s'applique automatiquement au paiement.",
    membershipJoinPayment: "💎 Adhésion {plan} — total {currency} {total} (commande {orderNumber}).",
    membershipJoinLinkPending: "Votre lien de paiement est en préparation — la boutique vous contactera bientôt.",
    membershipJoinAlready: "Vous avez déjà une adhésion {plan} active — répondez MY MEMBERSHIP pour la voir.",
    membershipJoinFailed: "Désolé, impossible de démarrer cette adhésion pour le moment — réessayez.",
    membershipPickInvalid: "Répondez d'abord MEMBERSHIP, puis JOIN MEMBERSHIP <numéro> dans la liste.",
    membershipBenefitsBoth: "{discount}% de remise + points fidélité x{mult}",
    membershipBenefitsDiscount: "{discount}% de remise sur les commandes",
    membershipBenefitsPoints: "points fidélité x{mult}",
    membershipPriceFree: "GRATUIT",
    membershipStatusActive: "💎 Votre adhésion : {plan} — {benefits}.",
    membershipStatusUntil: " Active jusqu'au {date}.",
    membershipStatusCancelling: " Elle prendra fin le {date} (annulation programmée).",
    membershipStatusNone: "Vous n'avez pas d'adhésion active — répondez MEMBERSHIP pour voir les formules.",
    membershipCancelPeriodEnd: "✅ Votre adhésion {plan} prendra fin le {date} — vos avantages restent actifs jusque-là.",
    membershipCancelImmediate: "✅ Votre adhésion {plan} est annulée — merci d'avoir été membre !",
    membershipCancelNone: "Vous n'avez pas d'adhésion active à annuler.",
    ussdSavingsHeader: "Vos cercles d'épargne :",
    ussdSavingsNone: "Vous n'êtes dans aucun cercle d'épargne pour le moment.",
    ussdSavingsLine: "{name} : {amount}/{freq}, cycle {cycle}. Prochain versement : {next}.",
    ussdLoyaltyBalance: "Solde de points fidélité : {points} pts.",
    ussdLoyaltyDisabled: "Les récompenses fidélité ne sont pas actives dans cette boutique.",
    // === W55 parity (PARITY-8) ===
    walletBalanceLine: "👛 Solde du portefeuille : {balance}.",
    walletBalanceNone: "👛 Vous n'avez pas encore de portefeuille dans cette boutique — les remboursements et avoirs arrivent ici.",
    walletLedgerHeader: "Activité récente du portefeuille :",
    walletLedgerEntry: "{sign}{amount} — {reason} ({date})",
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
    // === W50 CHANNELS ===
    discoveryAskLocationTelegram: "📍 Danna maɓallin da ke ƙasa don aika wurin da ka ke kuma ga shaguna kusa da kai.",
    discoveryAskLocationTyped: "📍 Amsa da unguwarka ko wurin da aka sani (misali \"Wuse 2\") don neman shaguna kusa da kai.",
    discoveryConfirmStaleLocation: "📍 Ina da adireshin isar da kaya da ka ajiye. Amsa USE SAVED don bincika kewaye da shi, ko aika wurin da ka ke yanzu.",
    discoveryRadiusExpanded: "🔍 Babu komai a cikin {fromKm} km — na faɗaɗa bincike zuwa {radiusKm} km.",
    discoveryMapsHint: "💡 Aika wani wuri a kowane lokaci don bincike a wani gari.",
    paymentPrompt: "💳 Jimillar biya: {total} {currency}.",
    paymentLinkReady: "Danna don biya cikin aminci: {url}",
    paymentReceived: "✅ An karɓi biya — na gode! Ana shirin odarka.",
    paymentFailed: "❌ Biya bai yi nasara ba — sake gwadawa ko zaɓi wani hanya.",
    paymentPending: "Ana tabbatar da biyarka — za mu sanar da kai nan ba da jimawa ba.",
    // === W51 PROMOS ===
    promoSpotlightBody: "🔥 {title} — {discount} da lambar {code}",
    promoShopNow: "🛍️ Yi sayayya",
    promoViewDeal: "Duba tayin",
    promoLine: "TAYI: {title} — {discount}. Yi amfani da lambar {code}",
    popularBadge: "⭐ Wanda aka fi oda",
    popularHeader: "⭐ Kayayyakin da aka fi oda:",
    popularEmpty: "Babu sanannun kayayyaki tukuna — sake duba nan gaba.",
    popularMenuLabel: "⭐ Sanannu",
    // === W52 SHARE ===
    shareDealBlurb: "🔥 {title} — {discount} a shagonmu! Yi amfani da lambar {code}. Referral: {ref}",
    shareDealForward: "Tura wa aboki: {blurb} {link}",
    shareDealBundleMessage: "📤 Tura wannan tayi ga abokanka!\n{blurb}\n\nWhatsApp: {waUrl}\nTelegram: {tgUrl}\n\n{forward}",
    shareButtonLabel: "📤 Tura",
    shareDealRedeemed: "✅ An kunna tayin {code} — zai shiga kai tsaye a lokacin biya. Muna maka fatan alheri!",
    shareDealSelfReferral: "Yi haƙuri — ba za ka iya amfani da lambar referral ɗinka da kanka ba. Tura wa aboki!",
    shareDealBadPromo: "Ban sami wannan tayin ({code}) ba — wata ƙila ya ƙare. Amsa MENU don duba shagon.",
    // === W53 EVENTS ===
    eventsHeader: "🎟️ Abubuwan da za su faru:",
    eventsEmpty: "Babu wasu abubuwa a yanzu — don Allah sake duba nan gaba.",
    eventsPickHint: "Amsa TICKET <lamba> don ganin nau'ikan tikiti (misali TICKET 1).",
    eventsPickInvalid: "Da farko amsa EVENTS, sannan TICKET <lamba> daga jerin.",
    eventTicketTypesHeader: "Nau'ikan tikiti:",
    eventTicketTypesEmpty: "Ba a sanya tikitin wannan taron a sayarwa tukuna ba.",
    eventTicketsLeft: "{count} suka rage",
    eventBuyHint: "Amsa BUY <lamba> [adadi] don samun hanyar biya (misali BUY 1 2).",
    eventTicketPurchaseReady: "🎟️ {qty} × {type} na {event} — jimla {currency} {total} (oda {orderNumber}).",
    eventTicketLinkPending: "Ana shirya hanyar biyanka — shagon zai tuntube ka.",
    eventTicketPurchaseFailed: "Yi haƙuri, ban iya fara sayen tikitin ba yanzu — sake gwadawa.",
    eventTicketSoldOut: "Yi haƙuri — an gama sayar da wannan nau'in tikiti.",
    eventMyTicketsHeader: "Tikitin ka:",
    eventMyTicketsEmpty: "Ba ka da tikiti tukuna — amsa EVENTS don ganin abin da ke gaba.",
    eventCheckinNotStaff: "Yi haƙuri, ma'aikatan shago ne kawai za su iya shigar da tikiti.",
    eventCheckinOk: "✅ An shigar: {code} ({event}). Barka da zuwa!",
    eventCheckinNotFound: "Ban sami tikiti da lambar {code} a wannan shagon ba.",
    eventCheckinAlready: "⚠️ An riga an shigar da tikiti {code} da {when}.",
    eventCheckinEventCancelled: "Tikiti {code} na taron da aka soke ne — ba a shiga da shi.",
    eventCheckinVoid: "Tikiti {code} {status} ne — ba a shiga da shi.",
    eventUssdPickEvent: "Amsa da lambar taron.",
    eventUssdPickQty: "Tikiti nawa? Amsa da lamba.",
    // === W54 disputes ===
    disputeResolvedBuyer: "📋 An warware rigimar kan oda {orderNumber}. Sakamako: {outcome}.{notes}",
    disputeOutcomeFullRefund: "an mayar da dukkan kuɗin {amount}",
    disputeOutcomePartialRefund: "an mayar da wani ɓangare na kuɗin {amount}",
    disputeOutcomeRelease: "an saki kuɗin zuwa ga mai sayarwa (babu mayar da kuɗi)",
    disputeOutcomeNoAction: "ba a ɗauki wani mataki ba",
    disputeOutcomeReplacement: "an buɗe buƙatar musanya/mayarwa (ref {rmaRef})",
    disputeMerchantResponded: "📋 Mai sayarwa ya amsa rigimarka kan oda {orderNumber}. Tawagarmu na nazarin shi.",
    membershipPlansHeader: "💎 Shirye-shiryen zama memba:",
    membershipPlansEmpty: "Babu shirin zama memba a yanzu — don Allah sake duba nan gaba.",
    membershipPlanLine: "{n}. {name} — {price} ({benefits})",
    membershipJoinHint: "Amsa JOIN MEMBERSHIP <lamba> don shiga, ko MY MEMBERSHIP don duba matsayinka.",
    membershipJoinActive: "🎉 Barka da zuwa {plan}! Membarki ta yi aiki — {benefits}. Ana amfani da ita kai tsaye yayin biya.",
    membershipJoinPayment: "💎 Membarki {plan} — jimla {currency} {total} (oda {orderNumber}).",
    membershipJoinLinkPending: "Ana shirya hanyar biyanka — shagon zai tuntube ka nan ba da jimawa ba.",
    membershipJoinAlready: "Kana da membarki {plan} mai aiki — amsa MY MEMBERSHIP don ganinta.",
    membershipJoinFailed: "Yi haƙuri, ban iya fara wannan membarki yanzu — sake gwadawa.",
    membershipPickInvalid: "Da farko amsa MEMBERSHIP, sannan JOIN MEMBERSHIP <lamba> daga jerin.",
    membershipBenefitsBoth: "rangwame {discount}% + maki x{mult}",
    membershipBenefitsDiscount: "rangwamen {discount}% akan odoci",
    membershipBenefitsPoints: "maki x{mult}",
    membershipPriceFree: "KYAUTA",
    membershipStatusActive: "💎 Membarki: {plan} — {benefits}.",
    membershipStatusUntil: " Tana aiki har {date}.",
    membershipStatusCancelling: " Za ta ƙare ran {date} (an shirya soke).",
    membershipStatusNone: "Ba ka da membarki mai aiki — amsa MEMBERSHIP don ganin shirye-shirye.",
    membershipCancelPeriodEnd: "✅ Membarki {plan} za ta ƙare ran {date} — amfaninka yana aiki har sai.",
    membershipCancelImmediate: "✅ An soke membarki {plan} — mun gode da zama memba!",
    membershipCancelNone: "Ba ka da membarki mai aiki da za a soke.",
    ussdSavingsHeader: "Kungiyoyin adashenka:",
    ussdSavingsNone: "Ba ka cikin kungiyar adashe tukuna.",
    ussdSavingsLine: "{name}: {amount}/{freq}, zagaye {cycle}. Na gaba biya: {next}.",
    ussdLoyaltyBalance: "Makin loyalti: {points} pts.",
    ussdLoyaltyDisabled: "Ba a amfani da kyautar loyalti a wannan shago.",
    // === W55 parity (PARITY-8) ===
    walletBalanceLine: "👛 Balansin walat: {balance}.",
    walletBalanceNone: "👛 Ba ku da walat a wannan kantin tukuna — maida kuɗi da bashin kantin suna zuwa nan.",
    walletLedgerHeader: "Ayyukan walat na baya-bayan nan:",
    walletLedgerEntry: "{sign}{amount} — {reason} ({date})",
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
    // === W50 CHANNELS ===
    discoveryAskLocationTelegram: "📍 Tẹ bọtìnnì ìsàlẹ̀ yìí láti pín ipò rẹ kí o rí àwọn ilé-iṣòwò tó sun mọ́ ọ́.",
    discoveryAskLocationTyped: "📍 Dáhùn pẹ̀lú agbègbè rẹ tàbí ami-ìdílé tó sun mọ́ ọ́ (bíi \"Wuse 2\") láti wá àwọn ilé-iṣòwò nítòsí.",
    discoveryConfirmStaleLocation: "📍 Mo ní àdírẹ́sì ìfiranṣẹ́ rẹ tó wà nípamọ́. Dáhùn USE SAVED láti wá ní àyíká rẹ̀, tàbí pín ipò rẹ lọ́wọ́lọ́wọ́.",
    discoveryRadiusExpanded: "🔍 Kò sí ohun kankan laàbò {fromKm} km — mo ti gbé ìwádìí dé {radiusKm} km.",
    discoveryMapsHint: "💡 Pín ipò míì nígbàkúgbà láti wá ní agbègbè míì.",
    paymentPrompt: "💳 Àpapọ̀ owó tó yẹ kí o san: {total} {currency}.",
    paymentLinkReady: "Tẹ láti sanwó láìní ẹ̀wà: {url}",
    paymentReceived: "✅ A ti gba owó — ẹ ṣeun! A ń ṣe àṣẹ rẹ.",
    paymentFailed: "❌ Owó kò lọ — gbìyànjú lẹ́ẹ̀kansi tàbí yan ọ̀nà míì.",
    paymentPending: "A ń jẹ́rìí sí owó rẹ — a ó sọ fún ọ láìpẹ́.",
    // === W51 PROMOS ===
    promoSpotlightBody: "🔥 {title} — {discount} pẹ̀lú kóòdù {code}",
    promoShopNow: "🛍️ Ra níṣìí",
    promoViewDeal: "Wo ọ̀pọ̀tọ́ náà",
    promoLine: "Ọ̀PỌ̀TỌ́: {title} — {discount}. Lo kóòdù {code}",
    popularBadge: "⭐ Ẹni tí wọ́n pa ọ̀rọ̀ rẹ̀ jùlọ",
    popularHeader: "⭐ Àwọn ohun tí wọ́n pa ọ̀rọ̀ wọn jùlọ:",
    popularEmpty: "Kò sí ohun gbajúmọ̀ fún ìsìn — padà wá laìpẹ́.",
    popularMenuLabel: "⭐ Gbajúmọ̀",
    // === W52 SHARE ===
    shareDealBlurb: "🔥 {title} — {discount} ní ìtajà wa! Lo kóòdù {code}. Referral: {ref}",
    shareDealForward: "Rán ẹ́ sí ọ̀rẹ́: {blurb} {link}",
    shareDealBundleMessage: "📤 Pín ọ̀pọ̀tọ́ yìí pẹ̀lú àwọn ọ̀rẹ́ rẹ!\n{blurb}\n\nWhatsApp: {waUrl}\nTelegram: {tgUrl}\n\n{forward}",
    shareButtonLabel: "📤 Pín",
    shareDealRedeemed: "✅ Ọ̀pọ̀tọ́ {code} ti wọlé — yóò lo ara rẹ̀ nígbà ìsanwó. Kú òwò!",
    shareDealSelfReferral: "Ma binu — o ò lè lo kóòdù referral tirẹ fún ara rẹ. Rán án sí ọ̀rẹ́!",
    shareDealBadPromo: "Mi ò rí ọ̀pọ̀tọ́ yẹn ({code}) — ó lè ti parí. Dahun MENU láti wo ìtajà.",
    // === W53 EVENTS ===
    eventsHeader: "🎟️ Àwọn ọ̀rọ̀ tí ń bọ̀:",
    eventsEmpty: "Kò sí ọ̀rọ̀ kankan fún ìsinsinyí — jọ̀wọ́ ṣàyẹ̀wò lẹ́yìn.",
    eventsPickHint: "Dahun TICKET <nọ́ńbà> láti rí oríṣi ìkówé (bíi TICKET 1).",
    eventsPickInvalid: "Dahun EVENTS ṣáájú, lẹ́yìn náà TICKET <nọ́ńbà> lára àkópọ̀.",
    eventTicketTypesHeader: "Oríṣi ìkówé:",
    eventTicketTypesEmpty: "A kò tíì fi ìkówé ọ̀rọ̀ yìí jábò fún títà.",
    eventTicketsLeft: "{count} ó kù",
    eventBuyHint: "Dahun BUY <nọ́ńbà> [iye] láti gba ọ̀nà sánwó (bíi BUY 1 2).",
    eventTicketPurchaseReady: "🎟️ {qty} × {type} fún {event} — papò {currency} {total} (àṣẹ {orderNumber}).",
    eventTicketLinkPending: "Ń ṣe ọ̀nà sánwó rẹ — ìtajà á kàn sí ọ.",
    eventTicketPurchaseFailed: "Pèlé, n kò lè bẹ̀rù rà ìkówé yìí — gbìyànjú lẹ́ẹ̀kan sí i.",
    eventTicketSoldOut: "Pèlé — oríṣi ìkówé yìí ti tà á.",
    eventMyTicketsHeader: "Àwọn ìkówé rẹ:",
    eventMyTicketsEmpty: "Ìwọ kò tíì ní ìkówé — dahun EVENTS láti wo ohun tó wà.",
    eventCheckinNotStaff: "Pèlé, àwọn òṣìṣẹ́ ìtajà nìkan ló lè ṣe ìforúkọsílẹ̀ ìkówé.",
    eventCheckinOk: "✅ Ti forúkọsílẹ̀: {code} ({event}). Káàbọ̀!",
    eventCheckinNotFound: "Mi ò rí ìkówé pẹ̀lú kóòdù {code} fún ìtajà yìí.",
    eventCheckinAlready: "⚠️ A ti forúkọsílẹ̀ ìkówé {code} ní {when}.",
    eventCheckinEventCancelled: "Ìkówé {code} jẹ́ ti ọ̀rọ̀ tí a ti fagi lé — kò wọlé.",
    eventCheckinVoid: "Ìkówé {code} jẹ́ {status} — kò wọlé.",
    eventUssdPickEvent: "Dahun pẹ̀lú nọ́ńbà ọ̀rọ̀ náà.",
    eventUssdPickQty: "Ìkówé mélòó? Dahun pẹ̀lú nọ́ńbà.",
    // === W54 disputes ===
    disputeResolvedBuyer: "📋 A ti yan ẹjọ́ lórí àṣẹ {orderNumber} pé. Èsì: {outcome}.{notes}",
    disputeOutcomeFullRefund: "a ti da gbogbo owó {amount} padà",
    disputeOutcomePartialRefund: "a ti da apá kan nínú owó {amount} padà",
    disputeOutcomeRelease: "a ti fi owó ránṣẹ́ sí oníṣòwò (kò sí ìpadàbò)",
    disputeOutcomeNoAction: "kò sí ìgbésẹ̀ mìíràn tí a gbé",
    disputeOutcomeReplacement: "a ṣí ìbéèrè àròpọ̀/ìpadàsí (ref {rmaRef})",
    disputeMerchantResponded: "📋 Oníṣòwò ti dáhùn lórí ẹjọ́ rẹ lórí àṣẹ {orderNumber}. Ẹgbẹ́ wa ń ṣàyẹ̀wò rẹ̀.",
    membershipPlansHeader: "💎 Àwọn ètò ìkówé:",
    membershipPlansEmpty: "Kò sí ètò ìkówé fún ìsinsinyí — jọ̀wọ́ ṣàyẹ̀wò lẹ́yìn.",
    membershipPlanLine: "{n}. {name} — {price} ({benefits})",
    membershipJoinHint: "Dahun JOIN MEMBERSHIP <nọ́ńbà> láti darapọ̀, tàbí MY MEMBERSHIP láti wo ipò rẹ.",
    membershipJoinActive: "🎉 Káàbọ̀ sí {plan}! Ìkówé rẹ ti ṢIṢẸ́ — {benefits}. Ó ń lo fúnra rẹ̀ nígbà ìsanwó.",
    membershipJoinPayment: "💎 Ìkówé {plan} — iye {currency} {total} (àṣẹ {orderNumber}).",
    membershipJoinLinkPending: "A ń ṣètò ọ̀nà ìsanwó rẹ — ilé ìtajà yóò kàn sí ẹ laipẹ́.",
    membershipJoinAlready: "O ti ní ìkówé {plan} tó ń ṣiṣẹ́ — dahun MY MEMBERSHIP láti wo ò.",
    membershipJoinFailed: "Pèlé, n kò lè bẹ̀rù ìkówé yìí báyìí — gbìyànjú lẹ́ẹ̀kan sí i.",
    membershipPickInvalid: "Dahun MEMBERSHIP níṣáájú, lẹ́yìn náà JOIN MEMBERSHIP <nọ́ńbà> láti inú àkójọ.",
    membershipBenefitsBoth: "ìdínkù {discount}% + àmì x{mult}",
    membershipBenefitsDiscount: "ìdínkù {discount}% lórí àwọn àṣẹ",
    membershipBenefitsPoints: "àmì x{mult}",
    membershipPriceFree: "Ọ̀FẸ́",
    membershipStatusActive: "💎 Ìkówé rẹ: {plan} — {benefits}.",
    membershipStatusUntil: " Ó ń ṣiṣẹ́ títí dé {date}.",
    membershipStatusCancelling: " Yóò parí ní {date} (a ti ṣètò fagi lé).",
    membershipStatusNone: "Ìwọ kò ní ìkówé tó ń ṣiṣẹ́ — dahun MEMBERSHIP láti wo àwọn ètò.",
    membershipCancelPeriodEnd: "✅ Ìkówé {plan} rẹ yóò parí ní {date} — àwọn àǹfààní rẹ ń ṣiṣẹ́ títí dé ìgbà náà.",
    membershipCancelImmediate: "✅ A ti fagi lé ìkówé {plan} rẹ — ẹ ṣeun fún jíjẹ́ ọmọ ẹgbẹ́!",
    membershipCancelNone: "Ìwọ kò ní ìkówé tó ń ṣiṣẹ́ tí a lè fagi lé.",
    ussdSavingsHeader: "Àwọn ẹgbẹ́ àdájọ rẹ:",
    ussdSavingsNone: "Ìwọ kò sí nínú ẹgbẹ́ àdájọ kankan síbò.",
    ussdSavingsLine: "{name}: {amount}/{freq}, yìí {cycle}. Ènì tó kàn ní ìsanwó tó nbọ̀: {next}.",
    ussdLoyaltyBalance: "Àmì ìfẹ́rarẹ: {points} pts.",
    ussdLoyaltyDisabled: "Ẹ̀bùn ìfẹ́rarẹ kò ṣiṣẹ́ ní ilé ìtajà yìí.",
    // === W55 parity (PARITY-8) ===
    walletBalanceLine: "👛 Balónsì apó-owó: {balance}.",
    walletBalanceNone: "👛 Kò sí apó-owó fún ọ ní ilé ìtajà yìí — àpèyìn owó àti kírédìtì ilé ìtajà máa wá síbí.",
    walletLedgerHeader: "Àwọn ìṣẹ̀lẹ̀ apó-owó tuntun:",
    walletLedgerEntry: "{sign}{amount} — {reason} ({date})",
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
    // === W50 CHANNELS ===
    discoveryAskLocationTelegram: "📍 Pịa bọtịnụ dị n'okpuru iji kesaa ebe ị nọ wee hụ ụlọ ahịa dị gị nso.",
    discoveryAskLocationTyped: "📍 Zaa mpaghara gị ma ọ bụ ama ebe a ma ama (dịka \"Wuse 2\") iji chọta ụlọ ahịa dị nso.",
    discoveryConfirmStaleLocation: "📍 Enwere m adreesị nnabata gị echekwara. Zaa USE SAVED iji chọọ gburugburu ya, ma ọ bụ kesaa ebe ị nọ ugbu a.",
    discoveryRadiusExpanded: "🔍 Enweghị ihe ọ bụla n'ime {fromKm} km — agbasaala m ọchụchọ ruo {radiusKm} km.",
    discoveryMapsHint: "💡 Kesaa ebe ọzọ oge ọ bụla iji chọọ na mpaghara ọzọ.",
    paymentPrompt: "💳 Ngụkọta ị ga-akwụ: {total} {currency}.",
    paymentLinkReady: "Pịa iji kwụọ ụgwọ n'enweghị nsogbu: {url}",
    paymentReceived: "✅ Enwetala ụgwọ — daalụ! Ana m akọzi ihe ị zụrụ.",
    paymentFailed: "❌ Ịkwụ ụgwọ agaghị — nwaa ọzọ ma ọ bụ họrọ ụzọ ọzọ.",
    // === W55 parity (PARITY-7) === Igbo translation added (was the last
    // intentionally-missing key; fallback chain now exercised via J137's
    // unknown-locale seam).
    paymentPending: "A na-akwenye ụgwọ gị ugbu a — anyị ga-agwa gị n'oge na-adịghị anya.",
    // === W51 PROMOS ===
    promoSpotlightBody: "🔥 {title} — {discount} site na koodu {code}",
    promoShopNow: "🛍️ Zụta ugbu a",
    promoViewDeal: "Lee nkwekọrịta",
    promoLine: "NKWEKỌRỊTA: {title} — {discount}. Jiri koodu {code}",
    popularBadge: "⭐ Ihe a na-achọsi ike",
    popularHeader: "⭐ Ihe ndị a na-achọsi ike:",
    popularEmpty: "Ọ dịbeghị ihe a ma ama — laghachi ozugbo.",
    popularMenuLabel: "⭐ Ndị a ma ama",
    // === W52 SHARE ===
    shareDealBlurb: "🔥 {title} — {discount} n'ụlọ ahịa anyị! Jiri koodu {code}. Referral: {ref}",
    shareDealForward: "Ziga enyi gị: {blurb} {link}",
    shareDealBundleMessage: "📤 Kesaa nkwekọrịta a ndị enyi gị!\n{blurb}\n\nWhatsApp: {waUrl}\nTelegram: {tgUrl}\n\n{forward}",
    shareButtonLabel: "📤 Kesaa",
    shareDealRedeemed: "✅ Nkwekọrịta {code} adọbaala — ọ ga-arụ ọrụ ozugbo mgbe ị na-akwụ ụgwọ. Ka ahịa dị gị mma!",
    shareDealSelfReferral: "Ndo — ị nweghị ike iji koodu referral gị onwe gị. Ziga ya enyi!",
    shareDealBadPromo: "Ahụghị m nkwekọrịta ahụ ({code}) — ọ nwere ike ịgwụcha. Zaa MENU ịchọrọ ụlọ ahịa.",
    // === W53 EVENTS ===
    eventsHeader: "🎟️ Ihe omume na-abịa:",
    eventsEmpty: "Enweghị ihe omume ugbu a — biko laghachi ozugbo.",
    eventsPickHint: "Zaa TICKET <nọmba> iji hụ ụdị tiketi (dịk TICKET 1).",
    eventsPickInvalid: "Burụ ụzọ zaa EVENTS, mgbe ahụ TICKET <nọmba> site na ndepụta.",
    eventTicketTypesHeader: "Ụdị tiketi:",
    eventTicketTypesEmpty: "Ejibeghị tiketi maka ihe omume ahụ ere.",
    eventTicketsLeft: "{count} fọdụrụ",
    eventBuyHint: "Zaa BUY <nọmba> [ọnụ ọgụgụ] iji nweta njikọ ịkwụ ụgwọ (dịk BUY 1 2).",
    eventTicketPurchaseReady: "🎟️ {qty} × {type} maka {event} — ngụkọta {currency} {total} (ọrụ {orderNumber}).",
    eventTicketLinkPending: "A na-akwadebe njikọ ịkwụ ụgwọ gị — ụlọ ahịa ga-akpọtụrụ gị.",
    eventTicketPurchaseFailed: "Ndo, enweghị m ike ịmalite ịzụta tiketi ahụ — nwaa ọzọ.",
    eventTicketSoldOut: "Ndo — ereela ụdị tiketi ahụ.",
    eventMyTicketsHeader: "Tiketi gị:",
    eventMyTicketsEmpty: "I nwebeghị tiketi — zaa EVENTS iji hụ ihe dị.",
    eventCheckinNotStaff: "Ndo, naanị ndị ọrụ ụlọ ahịa nwere ike ịdenye tiketi.",
    eventCheckinOk: "✅ Edebanyela: {code} ({event}). Nnọọ!",
    eventCheckinNotFound: "Ahụghị m tiketi nwere koodu {code} maka ụlọ ahịa a.",
    eventCheckinAlready: "⚠️ Edebanyela tiketi {code} na {when}.",
    eventCheckinEventCancelled: "Tiketi {code} bụ nke ihe omume e kagbuola — ọ naghị arụ ọrụ.",
    eventCheckinVoid: "Tiketi {code} bụ {status} — ọ naghị arụ ọrụ.",
    eventUssdPickEvent: "Zaa nọmba ihe omume ahụ.",
    eventUssdPickQty: "Tiketi ole? Zaa nọmba.",
    // === W54 disputes ===
    disputeResolvedBuyer: "📋 E doziela arụmụka na order {orderNumber}. Nsonaazụ: {outcome}.{notes}",
    disputeOutcomeFullRefund: "a kwụghachịla ego {amount} niile",
    disputeOutcomePartialRefund: "a kwụghachịla akụkụ nke ego {amount}",
    disputeOutcomeRelease: "a kwụrụ onye na-ere ahịa (enweghị nkwụghachi)",
    disputeOutcomeNoAction: "ọ dịghị ihe ọzọ e mere",
    disputeOutcomeReplacement: "emepechara arịrị nnọchi/nyeghachi (ref {rmaRef})",
    disputeMerchantResponded: "📋 Onye na-ere ahịa azaghachila arụmụka gị na order {orderNumber}. Otu anyị na-enyocha ya.",
    membershipPlansHeader: "💎 Atụmatụ otu:",
    membershipPlansEmpty: "Enweghị atụmatụ otu ugbu a — biko lelee ọzọ.",
    membershipPlanLine: "{n}. {name} — {price} ({benefits})",
    membershipJoinHint: "Zaa JOIN MEMBERSHIP <nọmba> iji sonye, ma ọ bụ MY MEMBERSHIP iji hụ otu gị.",
    membershipJoinActive: "🎉 Nnọọ na {plan}! Otu gị NA-ARỤ ỌRỤ — {benefits}. O na-arụ ọrụ ozugbo mgbe ị kwụrụ ụgwọ.",
    membershipJoinPayment: "💎 Otu {plan} — mkpokọta {currency} {total} (ọrụ {orderNumber}).",
    membershipJoinLinkPending: "A na-akwado njikọ ịkwụ ụgwọ gị — ụlọ ahịa ga-akpọtụrụ gị n'oge na-adịghị anya.",
    membershipJoinAlready: "Ị nwerịrị otu {plan} na-arụ ọrụ — zaa MY MEMBERSHIP iji hụ ya.",
    membershipJoinFailed: "Ndo, enweghị m ike ịmalite otu ahụ ugbu a — nwaa ọzọ.",
    membershipPickInvalid: "Biko zaa MEMBERSHIP mbụ, wee zaa JOIN MEMBERSHIP <nọmba> site na ndepụta.",
    membershipBenefitsBoth: "mbelata {discount}% + isi x{mult}",
    membershipBenefitsDiscount: "mbelata {discount}% na ọrụ",
    membershipBenefitsPoints: "isi x{mult}",
    membershipPriceFree: "N'EFU",
    membershipStatusActive: "💎 Otu gị: {plan} — {benefits}.",
    membershipStatusUntil: " Na-arụ ọrụ ruo {date}.",
    membershipStatusCancelling: " O ga-agwụ na {date} (edoziri ịkagbu).",
    membershipStatusNone: "Ị nweghị otu na-arụ ọrụ — zaa MEMBERSHIP iji hụ atụmatụ.",
    membershipCancelPeriodEnd: "✅ Otu {plan} gị ga-agwụ na {date} — uru gị na-arụ ọrụ ruo mgbe ahụ.",
    membershipCancelImmediate: "✅ Ekagbuola otu {plan} gị — daalụ n'ihi na ị bụ onye otu!",
    membershipCancelNone: "Ị nweghị otu na-arụ ọrụ iji kagbuo.",
    ussdSavingsHeader: "Otu ekwote gị:",
    ussdSavingsNone: "Ị nọbeghị n'otu ekwote ọ bụla ugbu a.",
    ussdSavingsLine: "{name}: {amount}/{freq}, okirikiri {cycle}. Ịkwụ ụgwọ na-esote: {next}.",
    ussdLoyaltyBalance: "Isi loyalty: {points} pts.",
    ussdLoyaltyDisabled: "Onyinye loyalty anaghị arụ ọrụ n'ụlọ ahịa a.",
    // === W55 parity (PARITY-8) ===
    walletBalanceLine: "👛 Balansị akpa ego: {balance}.",
    walletBalanceNone: "👛 I nwebeghị akpa ego na ụlọ ahịa a — nkwụghachi ụgwọ na kredit ụlọ ahịa na-abịa ebe a.",
    walletLedgerHeader: "Ihe omume akpa ego ọhụrụ:",
    walletLedgerEntry: "{sign}{amount} — {reason} ({date})",
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
    // === W50 CHANNELS ===
    discoveryAskLocationTelegram: "📍 Gusa kitufe hapa chini kushiriki eneo lako na kuona biashara zilizo karibu nawe.",
    discoveryAskLocationTyped: "📍 Jibu kwa eneo lako au alama ya karibu (k.m. \"Wuse 2\") kupata biashara zilizo karibu nawe.",
    discoveryConfirmStaleLocation: "📍 Nina anwani yako ya kufikishia iliyohifadhiwa. Jibu USE SAVED kutafuta karibu nayo, au shiriki eneo lako la sasa.",
    discoveryRadiusExpanded: "🔍 Hakuna chochote ndani ya km {fromKm} — nimepanua utafutaji hadi km {radiusKm}.",
    discoveryMapsHint: "💡 Shiriki eneo tofauti wakati wowote kutafuta sehemu nyingine.",
    paymentPrompt: "💳 Jumla ya kulipa: {total} {currency}.",
    paymentLinkReady: "Gusa kulipa kwa usalama: {url}",
    paymentReceived: "✅ Malipo yamepokea — asante! Agizo lako linaandaliwa.",
    paymentFailed: "❌ Malipo hayakufanikiwa — jaribu tena au chagua njia nyingine.",
    paymentPending: "Malipo yako yanathibitishwa — tutakujulisha hivi karibuni.",
    // === W51 PROMOS ===
    promoSpotlightBody: "🔥 {title} — {discount} kwa msimbo {code}",
    promoShopNow: "🛍️ Nunua sasa",
    promoViewDeal: "Angalia ofa",
    promoLine: "OFA: {title} — {discount}. Tumia msimbo {code}",
    popularBadge: "⭐ Inayoagizwa zaidi",
    popularHeader: "⭐ Bidhaa zinazoagizwa zaidi:",
    popularEmpty: "Hakuna bidhaa maarufu bado — rudi hivi karibuni.",
    popularMenuLabel: "⭐ Maarufu",
    // === W52 SHARE ===
    shareDealBlurb: "🔥 {title} — {discount} dukani kwetu! Tumia msimbo {code}. Referral: {ref}",
    shareDealForward: "Tuma kwa rafiki: {blurb} {link}",
    shareDealBundleMessage: "📤 Shiriki ofa hii na marafiki!\n{blurb}\n\nWhatsApp: {waUrl}\nTelegram: {tgUrl}\n\n{forward}",
    shareButtonLabel: "📤 Shiriki",
    shareDealRedeemed: "✅ Ofa {code} imewekwa — itatumika moja kwa moja unapolipa. Karibu!",
    shareDealSelfReferral: "Samahani — huwezi kutumia msimbo wako mwenyewe wa referral. Mtumie rafiki!",
    shareDealBadPromo: "Sikuipata ofa hiyo ({code}) — huenda imeisha. Jibu MENU kuona duka.",
    // === W53 EVENTS ===
    eventsHeader: "🎟️ Matukio yajayo:",
    eventsEmpty: "Hakuna matukio yajayo kwa sasa — rudi hivi karibuni.",
    eventsPickHint: "Jibu TICKET <namba> kuona aina za tiketi (mf. TICKET 1).",
    eventsPickInvalid: "Jibu EVENTS kwanza, kisha TICKET <namba> kutoka orodha.",
    eventTicketTypesHeader: "Aina za tiketi:",
    eventTicketTypesEmpty: "Hakuna tiketi zinazouzwa kwa tukio hilo bado.",
    eventTicketsLeft: "{count} zimebaki",
    eventBuyHint: "Jibu BUY <namba> [idadi] kupata kiungo cha malipo (mf. BUY 1 2).",
    eventTicketPurchaseReady: "🎟️ {qty} × {type} kwa {event} — jumla {currency} {total} (oda {orderNumber}).",
    eventTicketLinkPending: "Kiungo chako cha malipo kinatayarishwa — duka litakufuatilia.",
    eventTicketPurchaseFailed: "Samahani, sikuweza kuanzisha ununuzi huo wa tiketi — jaribu tena.",
    eventTicketSoldOut: "Samahani — aina hiyo ya tiketi imeisha.",
    eventMyTicketsHeader: "Tiketi zako:",
    eventMyTicketsEmpty: "Bado huna tiketi — jibu EVENTS kuona yaliyopo.",
    eventCheckinNotStaff: "Samahani, wafanyakazi wa duka pekee ndio wanaoweza kukagua tiketi.",
    eventCheckinOk: "✅ Imekaguliwa: {code} ({event}). Karibu!",
    eventCheckinNotFound: "Sikuipata tiketi yenye msimbo {code} kwa duka hili.",
    eventCheckinAlready: "⚠️ Tiketi {code} tayari ilikaguliwa saa {when}.",
    eventCheckinEventCancelled: "Tiketi {code} ni ya tukio lililofutwa — hairuhusiwi kuingia.",
    eventCheckinVoid: "Tiketi {code} ni {status} — hairuhusiwi kuingia.",
    eventUssdPickEvent: "Jibu kwa namba ya tukio.",
    eventUssdPickQty: "Tiketi ngapi? Jibu kwa namba.",
    // === W54 disputes ===
    disputeResolvedBuyer: "📋 Mgogoro wa agizo {orderNumber} umetatuliwa. Matokeo: {outcome}.{notes}",
    disputeOutcomeFullRefund: "rudisho kamili la {amount} limetolewa",
    disputeOutcomePartialRefund: "rudisho la sehemu la {amount} limetolewa",
    disputeOutcomeRelease: "malipo yametolewa kwa muuzaji (hakuna rudisho)",
    disputeOutcomeNoAction: "hakuna hatua zaidi iliyochukuliwa",
    disputeOutcomeReplacement: "ombi la badiliko/urejesheji limefunguliwa (ref {rmaRef})",
    disputeMerchantResponded: "📋 Muuzaji amejibu mgogoro wako wa agizo {orderNumber}. Timu yetu inaukagua.",
    membershipPlansHeader: "💎 Mpango wa uanachama:",
    membershipPlansEmpty: "Hakuna mpango wa uanachama kwa sasa — rudi tena baadaye.",
    membershipPlanLine: "{n}. {name} — {price} ({benefits})",
    membershipJoinHint: "Jibu JOIN MEMBERSHIP <namba> kujiunga, au MY MEMBERSHIP kuona hali yako.",
    membershipJoinActive: "🎉 Karibu {plan}! Uanachama wako UMEANZA — {benefits}. Unatumika moja kwa moja unapolipa.",
    membershipJoinPayment: "💎 Uanachama {plan} — jumla {currency} {total} (oda {orderNumber}).",
    membershipJoinLinkPending: "Kiungo chako cha malipo kinatayarishwa — duka litakupigia hivi karibuni.",
    membershipJoinAlready: "Tayari una uanachama {plan} unaofanya kazi — jibu MY MEMBERSHIP kuuona.",
    membershipJoinFailed: "Samahani, sikuweza kuanzisha uanachama huo sasa — jaribu tena.",
    membershipPickInvalid: "Tafadhali jibu MEMBERSHIP kwanza, kisha JOIN MEMBERSHIP <namba> kutoka kwenye orodha.",
    membershipBenefitsBoth: "punguzo la {discount}% + pointi x{mult}",
    membershipBenefitsDiscount: "punguzo la {discount}% kwa oda",
    membershipBenefitsPoints: "pointi x{mult}",
    membershipPriceFree: "BURE",
    membershipStatusActive: "💎 Uanachama wako: {plan} — {benefits}.",
    membershipStatusUntil: " Unaofanya kazi hadi {date}.",
    membershipStatusCancelling: " Utaisha {date} (ughairi umepangwa).",
    membershipStatusNone: "Huna uanachama unaofanya kazi — jibu MEMBERSHIP kuona mipango.",
    membershipCancelPeriodEnd: "✅ Uanachama wako {plan} utaisha {date} — manufaa yako yanaendelea hadi wakati huo.",
    membershipCancelImmediate: "✅ Uanachama wako {plan} umeghairishwa — asante kwa kuwa mwanachama!",
    membershipCancelNone: "Huna uanachama unaofanya kazi wa kughairi.",
    ussdSavingsHeader: "Vyama vyako vya akiba:",
    ussdSavingsNone: "Bado hauko kwenye chama cha akiba.",
    ussdSavingsLine: "{name}: {amount}/{freq}, mzunguko {cycle}. Malipo yajayo: {next}.",
    ussdLoyaltyBalance: "Salio la pointi: {points} pts.",
    ussdLoyaltyDisabled: "Zawadi za uongozi hazijawashwa dukani hapa.",
    // === W55 parity (PARITY-8) ===
    walletBalanceLine: "👛 Salio la pochi: {balance}.",
    walletBalanceNone: "👛 Huna pochi na duka hili bado — marejesho na mikopo ya duka hufika hapa.",
    walletLedgerHeader: "Shughuli za hivi karibuni za pochi:",
    walletLedgerEntry: "{sign}{amount} — {reason} ({date})",
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
    // === W50 CHANNELS ===
    discoveryAskLocationTelegram: "📍 አካባቢዎን ለማጋራት እና በአቅራቢያዊ ያሉ ንግዶችን ለማየት ከታች ያለውን ቁልፍ ይንኩ።",
    discoveryAskLocationTyped: "📍 በአቅራቢያዊ ያሉ ንግዶችን ለማግኘት አካባቢዎን ወይም የቅርብ ምልክት ቦታ (ለምሳሌ \"Wuse 2\") ይመልሱ።",
    discoveryConfirmStaleLocation: "📍 የተቀመጠ የመላኪያ አድራሻዎ አለኝ። ዙሪያውን ለመፈተሽ USE SAVED ብለው ይመልሱ፣ ወይም የአሁኑን አካባቢዎን ያጋሩ።",
    discoveryRadiusExpanded: "🔍 በ{fromKm} km ውስጥ ምንም አልተገኘም — ፍለጋውን ወደ {radiusKm} km አሰራዝሬአለሁ።",
    discoveryMapsHint: "💡 በሌላ አካባቢ ለመፈተሽ በማንኛውም ጊዜ ሌላ አካባቢ ያጋሩ።",
    paymentPrompt: "💳 የሚከፍሉት ጠቅላላ: {total} {currency}።",
    paymentLinkReady: "በደህና ለመክፈል ይንኩ: {url}",
    paymentReceived: "✅ ክፍያ ደርሷል — አመሰግናለሁ! ትእዛዝዎ እየተዘጋጀ ነው።",
    paymentFailed: "❌ ክፍያ አልተሳካም — እባክዎ እንደገና ይሞክሩ ወይም ሌላ መንገድ ይምረጡ።",
    // === W51 PROMOS ===
    promoSpotlightBody: "🔥 {title} — {discount} በኮድ {code}",
    promoShopNow: "🛍️ አሁን ይግዙ",
    promoViewDeal: "ቅናሹን ይመልከቱ",
    promoLine: "ቅናሽ: {title} — {discount}. ኮድ {code} ይጠቀሙ",
    popularBadge: "⭐ በብዛት የሚያዝ",
    popularHeader: "⭐ በብዛት የሚያዙ እቃዎች:",
    popularEmpty: "እስካሁን ታዋቂ እቃዎች የሉም — በቅርቡ ይመልሱ።",
    popularMenuLabel: "⭐ ታዋቂዎች",
    // === W52 SHARE ===
    shareDealBlurb: "🔥 {title} — {discount} በሱቃችን! ኮድ {code} ይጠቀሙ። Referral: {ref}",
    shareDealForward: "ለጓደኛ ያስተላልፉ: {blurb} {link}",
    shareDealBundleMessage: "📤 ይህንን ቅናሽ ከጓደኞችዎ ጋር ያጋሩ!\n{blurb}\n\nWhatsApp: {waUrl}\nTelegram: {tgUrl}\n\n{forward}",
    shareButtonLabel: "📤 አጋራ",
    shareDealRedeemed: "✅ ቅናሽ {code} ተግብሯል — ሲከፍሉ በራስ-ሰር ይተገበራል። ምርጡ ይምረጡ!",
    shareDealSelfReferral: "ይቅርታ — የራስዎን referral ኮድ መጠቀም አይችሉም። ለጓደኛ ያጋሩት!",
    shareDealBadPromo: "ያንን ቅናሽ ({code}) ማግኘት አልቻልኩም — ሊያበቃ ይችላል። ሱቁን ለማየት MENU ብለው ይመልሱ።",
    // === W53 EVENTS ===
    eventsHeader: "🎟️ የሚመጡ ዝግጅቶች:",
    eventsEmpty: "በአሁኑ ጊዜ የሚመጡ ዝግጅቶች የሉም — እባክዎ ቆይተው ይመልሱ።",
    eventsPickHint: "የትኬት ዓይነቶችን ለማየት TICKET <ቁጥር> ይመልሱ (ለምሳሌ TICKET 1)።",
    eventsPickInvalid: "መጀመሪያ EVENTS ይመልሱ፣ ከዚያ ከዝርዝሩ TICKET <ቁጥር>።",
    eventTicketTypesHeader: "የትኬት ዓይነቶች:",
    eventTicketTypesEmpty: "ለዚህ ዝግጅት ገና ሽያጭ ላይ የሚሉ ትኬቶች የሉም።",
    eventTicketsLeft: "{count} ቀርተዋል",
    eventBuyHint: "የክፍያ አገናኝ ለማግኘት BUY <ቁጥር> [ብዛት] ይመልሱ (ለምሳሌ BUY 1 2)።",
    eventTicketPurchaseReady: "🎟️ {qty} × {type} ለ{event} — ድምር {currency} {total} (ትዕዛዝ {orderNumber})።",
    eventTicketLinkPending: "የክፍያ አገናኝዎ በዝግጅት ላይ ነው — ሱቁ ያግኝዎታል።",
    eventTicketPurchaseFailed: "ይቅርታ፣ የትኬት ግዢውን መጀመር አልቻልኩም — እባክዎ እንደገና ይሞክሩ።",
    eventTicketSoldOut: "ይቅርታ — ይህ የትኬት ዓይነት ተሽጦ አልቋል።",
    eventMyTicketsHeader: "ትኬቶችዎ:",
    eventMyTicketsEmpty: "ገና ትኬት የሎትም — ያለውን ለማየት EVENTS ይመልሱ።",
    eventCheckinNotStaff: "ይቅርታ፣ የሱቅ ሰራተኞች ብቻ ትኬት ማረጋገጥ ይችላሉ።",
    eventCheckinOk: "✅ ገብቷል: {code} ({event}). እንኳን ደህና መጡ!",
    eventCheckinNotFound: "ለዚህ ሱቅ በኮድ {code} ትኬት አላገኘሁም።",
    eventCheckinAlready: "⚠️ ትኬት {code} አስቀድሞ በ{when} ገብቷል።",
    eventCheckinEventCancelled: "ትኬት {code} የተሰረዘ ዝግጅት ነው — መግባት አይችሉም።",
    eventCheckinVoid: "ትኬት {code} {status} ነው — መግባት አይችሉም።",
    eventUssdPickEvent: "በዝግጅቱ ቁጥር ይመልሱ።",
    eventUssdPickQty: "ስንት ትኬት? በቁጥር ይመልሱ።",
    // === W54 disputes ===
    disputeResolvedBuyer: "📋 በትእዛዝ {orderNumber} ላይ ያለው አለካክ ተፈትቷል። ውጤት: {outcome}.{notes}",
    disputeOutcomeFullRefund: "ሙሉ የገንዘብ ተመላሽ {amount} ተሰጥቷል",
    disputeOutcomePartialRefund: "የከፍል የገንዘብ ተመላሽ {amount} ተሰጥቷል",
    disputeOutcomeRelease: "ክፍያው ለነጋዴው ተለቋል (ምንም ተመላሽ የለም)",
    disputeOutcomeNoAction: "ምንም ተጨማሪ እርምጃ አልተወሰደም",
    disputeOutcomeReplacement: "የምትክ/መመለሻ ጥያቄ ተከፍቷል (ref {rmaRef})",
    disputeMerchantResponded: "📋 ነጋዴው በትእዛዝ {orderNumber} ላይ ለእርስዎ አለካክ ምላሽ ሰጥቷል። ቡድናችን እያጠናው ነው።",
    membershipPlansHeader: "💎 የአባልነት እቅዶች:",
    membershipPlansEmpty: "በአሁኑ ጊዜ የአባልነት እቅድ የለም — እባክዎ ቆይተው ይመልከቱ።",
    membershipPlanLine: "{n}. {name} — {price} ({benefits})",
    membershipJoinHint: "ለመቀላቀል JOIN MEMBERSHIP <ቁጥር> ይመልሱ፣ ወይም ሁኔታዎን ለማየት MY MEMBERSHIP።",
    membershipJoinActive: "🎉 እንኳን ወደ {plan} መጡ! አባልነትዎ ገብቷል — {benefits}። በክፍያ ጊዜ በራሱ ይተገበራል።",
    membershipJoinPayment: "💎 {plan} አባልነት — ድምር {currency} {total} (ትዕዛዝ {orderNumber})።",
    membershipJoinLinkPending: "የክፍያ አገናኝዎ በዝግጅት ላይ ነው — ሱቁ በቅርቡ ያግኝዎታል።",
    membershipJoinAlready: "አስቀድመው ንቁ የ{plan} አባልነት አለዎት — ለማየት MY MEMBERSHIP ይመልሱ።",
    membershipJoinFailed: "ይቅርታ፣ አሁን ያ አባልነት መጀመር አልቻልኩም — እባክዎ እንደገና ይሞክሩ።",
    membershipPickInvalid: "እባክዎ መጀመሪያ MEMBERSHIP ይመልሱ፣ ከዚያ ከዝርዝሩ JOIN MEMBERSHIP <ቁጥር>።",
    membershipBenefitsBoth: "{discount}% ቅናሽ + ነጥብ x{mult}",
    membershipBenefitsDiscount: "በትዕዛዞች ላይ {discount}% ቅናሽ",
    membershipBenefitsPoints: "ነጥብ x{mult}",
    membershipPriceFree: "ነጻ",
    membershipStatusActive: "💎 አባልነትዎ: {plan} — {benefits}።",
    membershipStatusUntil: " እስከ {date} ንቁ ነው።",
    membershipStatusCancelling: " በ {date} ያበቃል (መሰረዝ ተያይዟል)።",
    membershipStatusNone: "ንቁ አባልነት የለዎትም — እቅዶቹን ለማየት MEMBERSHIP ይመልሱ።",
    membershipCancelPeriodEnd: "✅ የ{plan} አባልነትዎ በ {date} ያበቃል — ጥቅሞቹ እስከዚያ ይቀጥላሉ።",
    membershipCancelImmediate: "✅ የ{plan} አባልነትዎ ተሰርዟል — አባል ስለነበሩ እናመሰግናለን!",
    membershipCancelNone: "የሚሰረዝ ንቁ አባልነት የለዎትም።",
    ussdSavingsHeader: "የቁጠባ ክቦችዎ:",
    ussdSavingsNone: "እስካሁን በምንም የቁጠባ ክብ ውስጥ አይደሉም።",
    ussdSavingsLine: "{name}: {amount}/{freq}፣ ዙር {cycle}። ቀጣይ ክፍያ: {next}።",
    ussdLoyaltyBalance: "የትጋት ነጥብ ሂሳብ: {points} pts።",
    ussdLoyaltyDisabled: "የትጋት ሽልማቶች በዚህ ሱቅ አልነቁም።",
    // === W55 parity (PARITY-8) ===
    walletBalanceLine: "👛 የዋሌት ቀሪ ሂሳብ: {balance}።",
    walletBalanceNone: "👛 እስካሁን በዚህ ሱቅ ዋሌት የለዎትም — ተመላሾች እና የሱቅ ክሬዲቶች እዚህ ይደርሳሉ።",
    walletLedgerHeader: "የቅርብ ጊዜ የዋሌት እንቅስቃሴ:",
    walletLedgerEntry: "{sign}{amount} — {reason} ({date})",
    // === W55 parity (PARITY-7) === Amharic translation added (was the last
    // intentionally-missing key; fallback chain now exercised via J137's
    // unknown-locale seam).
    paymentPending: "ክፍያዎ እየተረጋገጠ ነው — በቅርቡ እናሳውቆታለን።",
  },
  // === W49 I18N-PCM === full catalog (all 27 MessageKeys — complete).
  // W55 parity (PARITY-7): ig/am paymentPending filled too — every locale
  // is now 101/101; the en fallback only ever fires for unknown locales.
  pcm: {
    languageMenuPrompt: "🌐 Choose your language / Wetin you wan speak:",
    languageSetConfirm: "Language don set to {language}. You fit change am any time — just type LANGUAGE.",
    languageMenuHint: "Type LANGUAGE any time make you change your language.",
    mainMenuPrompt: "Reply with number, or tell me wetin you dey find.",
    backToMenu: "Back to main menu",
    invalidSelection: "Sorry o, I no understand dat one — reply MENU make you see the options again.",
    catalogHeader: "🛍️ Wetin we get:",
    catalogEmpty: "No products dey now — abeg check back small time.",
    catalogItemOutOfStock: "(e don finish)",
    catalogItemAdded: "I don add {product} ×{qty} to your cart. 🛒",
    catalogMoreHint: "Reply with the product name or number make I add am to your cart.",
    cartSummaryHeader: "🛒 Your cart:",
    cartEmpty: "Your cart dey empty.",
    checkoutPrompt: "Reply CHECKOUT make you place your order, or continue shopping.",
    orderConfirmPrompt: "Confirm your order? Reply YES to confirm or NO to cancel.",
    orderPlaced: "✅ Order {orderNumber} don place! Total: {total} {currency}.",
    orderCancelled: "Your order don cancel — dem no charge you.",
    askDeliveryAddress: "Abeg send your delivery address (street, area, city).",
    discoveryAskLocation: "📍 Share your location make you see businesses wey dey near you.",
    discoveryEmpty: "We never see any business near you yet — try another location.",
    discoveryHeader: "Businesses wey dey near you:",
    // === W50 CHANNELS ===
    discoveryAskLocationTelegram: "📍 Tap the button wey dey below make you share your location and see businesses near you.",
    discoveryAskLocationTyped: "📍 Reply with your area or landmark wey dey near you (like \"Wuse 2\") make you see businesses wey dey near.",
    discoveryConfirmStaleLocation: "📍 I get your saved delivery location for file. Reply USE SAVED make I search around am, or share where you dey now.",
    discoveryRadiusExpanded: "🔍 Nothing dey within {fromKm} km — I don widen the search reach {radiusKm} km.",
    discoveryMapsHint: "💡 Share another location any time make you search another area.",
    paymentPrompt: "💳 Total wey you go pay: {total} {currency}.",
    paymentLinkReady: "Tap here make you pay well: {url}",
    paymentReceived: "✅ Payment don enter — thank you! We dey prepare your order.",
    paymentFailed: "❌ Payment no go — abeg try again or choose another way.",
    paymentPending: "Dem dey confirm your payment — we go update you small time.",
    // === W51 PROMOS ===
    promoSpotlightBody: "🔥 {title} — {discount} with code {code}",
    promoShopNow: "🛍️ Shop now",
    promoViewDeal: "See di deal",
    promoLine: "DEAL: {title} — {discount}. Use code {code}",
    popularBadge: "⭐ Wey pipo dey order pass",
    popularHeader: "⭐ Items wey pipo dey order pass:",
    popularEmpty: "Popular items never dey yet — check am later.",
    popularMenuLabel: "⭐ Popular items",
    // === W52 SHARE ===
    shareDealBlurb: "🔥 {title} — {discount} for our shop! Use code {code}. Referral: {ref}",
    shareDealForward: "Forward am: {blurb} {link}",
    shareDealBundleMessage: "📤 Share dis deal give your padi dem!\n{blurb}\n\nWhatsApp: {waUrl}\nTelegram: {tgUrl}\n\n{forward}",
    shareButtonLabel: "📤 Share am",
    shareDealRedeemed: "✅ Deal {code} don lock — e go apply by itself wen you dey checkout. Enjoy!",
    shareDealSelfReferral: "Sorry o — you no fit use your own referral code by yourself. Share am give your padi!",
    shareDealBadPromo: "I no fit find dat deal ({code}) — e fit don expire. Reply MENU make you check di shop.",
    // === W53 EVENTS ===
    eventsHeader: "🎟️ Events wey dey come:",
    eventsEmpty: "No event dey for now — abeg check back later.",
    eventsPickHint: "Reply TICKET <number> to see ticket types (e.g. TICKET 1).",
    eventsPickInvalid: "Reply EVENTS first, den TICKET <number> from di list.",
    eventTicketTypesHeader: "Ticket types:",
    eventTicketTypesEmpty: "Dem never put tickets for dat event on sale yet.",
    eventTicketsLeft: "{count} remain",
    eventBuyHint: "Reply BUY <number> [qty] to collect payment link (e.g. BUY 1 2).",
    eventTicketPurchaseReady: "🎟️ {qty} × {type} for {event} — total {currency} {total} (order {orderNumber}).",
    eventTicketLinkPending: "Your payment link dey come — di shop go message you.",
    eventTicketPurchaseFailed: "Sorry, I no fit start dat ticket buy now — try again.",
    eventTicketSoldOut: "Sorry — dat ticket type don sell finish.",
    eventMyTicketsHeader: "Your tickets:",
    eventMyTicketsEmpty: "You never get ticket — reply EVENTS to see wetin dey.",
    eventCheckinNotStaff: "Sorry, na only shop staff fit check tickets in.",
    eventCheckinOk: "✅ Checked in: {code} ({event}). Welcome!",
    eventCheckinNotFound: "I no fit find ticket with code {code} for dis shop.",
    eventCheckinAlready: "⚠️ Ticket {code} don already check in at {when}.",
    eventCheckinEventCancelled: "Ticket {code} na for cancelled event — e no valid.",
    eventCheckinVoid: "Ticket {code} na {status} — e no valid for entry.",
    eventUssdPickEvent: "Reply with di event number.",
    eventUssdPickQty: "How many tickets? Reply with number.",
    // === W54 disputes ===
    disputeResolvedBuyer: "📋 Dem don settle di dispute for order {orderNumber}. Result: {outcome}.{notes}",
    disputeOutcomeFullRefund: "dem don return all di money {amount}",
    disputeOutcomePartialRefund: "dem don return part of di money {amount}",
    disputeOutcomeRelease: "dem don release di money give di seller (no refund)",
    disputeOutcomeNoAction: "dem no do anything again",
    disputeOutcomeReplacement: "dem don open replacement/return request (ref {rmaRef})",
    disputeMerchantResponded: "📋 Di seller don answer your dispute for order {orderNumber}. Our team dey review am.",
    membershipPlansHeader: "💎 Membership plans:",
    membershipPlansEmpty: "No membership plan dey now — check back later.",
    membershipPlanLine: "{n}. {name} — {price} ({benefits})",
    membershipJoinHint: "Reply JOIN MEMBERSHIP <number> to join, or MY MEMBERSHIP to check your own.",
    membershipJoinActive: "🎉 Welcome to {plan}! Your membership don ACTIVE — {benefits}. E go apply by itself when you dey checkout.",
    membershipJoinPayment: "💎 {plan} membership — total {currency} {total} (order {orderNumber}).",
    membershipJoinLinkPending: "We dey prepare your payment link — the shop go message you soon.",
    membershipJoinAlready: "You don already get active {plan} membership — reply MY MEMBERSHIP to see am.",
    membershipJoinFailed: "Sorry, I no fit start that membership now — try again.",
    membershipPickInvalid: "Abeg reply MEMBERSHIP first, then JOIN MEMBERSHIP <number> from the list.",
    membershipBenefitsBoth: "{discount}% off orders + {mult}x points",
    membershipBenefitsDiscount: "{discount}% off orders",
    membershipBenefitsPoints: "{mult}x loyalty points",
    membershipPriceFree: "FREE",
    membershipStatusActive: "💎 Your membership: {plan} — {benefits}.",
    membershipStatusUntil: " E dey active till {date}.",
    membershipStatusCancelling: " E go end on {date} (cancel don dey booked).",
    membershipStatusNone: "You no get active membership — reply MEMBERSHIP to see the plans.",
    membershipCancelPeriodEnd: "✅ Your {plan} membership go end on {date} — your benefits still dey active till then.",
    membershipCancelImmediate: "✅ Your {plan} membership don cancel — thank you for being a member!",
    membershipCancelNone: "You no get active membership wey you fit cancel.",
    ussdSavingsHeader: "Your savings circles:",
    ussdSavingsNone: "You never join any savings circle yet.",
    ussdSavingsLine: "{name}: {amount}/{freq}, cycle {cycle}. Next payout: {next}.",
    ussdLoyaltyBalance: "Loyalty points balance: {points} pts.",
    ussdLoyaltyDisabled: "Loyalty rewards no dey active for this shop.",
    // === W55 parity (PARITY-8) ===
    walletBalanceLine: "👛 Wallet balance: {balance}.",
    walletBalanceNone: "👛 You never get wallet for dis shop yet — refund and store credit go land here.",
    walletLedgerHeader: "Recent wallet activity:",
    walletLedgerEntry: "{sign}{amount} — {reason} ({date})",
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
  pcm: "Naija (Pidgin)", // === W49 I18N-PCM ===
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
    // === W49 I18N-PCM === pidgin aliases (mirror copilot LANGUAGE_ALIASES).
    pidgin: "pcm", naija: "pcm", "naija pidgin": "pcm",
    "nigerian pidgin": "pcm", "broken english": "pcm", broken: "pcm",
  };
  return realAliases[t] ?? null;
}

/** True when the inbound text asks to (re)open the language picker. */
export function isLanguageMenuRequest(text: string): boolean {
  const t = (text ?? "").trim().toLowerCase();
  return (
    t === "language" || t === "languages" || t === "lang" ||
    t === "change language" || t === "harshe" || t === "èdè" || t === "asụsụ" ||
    t === "lugha" || t === "langue" || t === "ቋንቋ" ||
    t === "pidgin" // === W49 I18N-PCM === "pidgin" alone opens the picker
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
    pcm: ["menu", "start", "fess"],
  },
  shop: {
    en: ["shop", "buy", "products", "catalog", "browse"],
    fr: ["acheter", "produits", "catalogue", "boutique"],
    ha: ["sayayya", "saya", "kayayyaki", "shago", "shaguna"],
    yo: ["rà", "ọjà", "ra oja", "itaja"],
    ig: ["zụta", "ahịa", "ngwaahịa", "ịzụ"],
    sw: ["nunua", "bidhaa", "duka", "mnunuzi"],
    am: ["ግዛ", "ምርቶች", "ሱቅ", "ግብዣ"],
    pcm: ["buy", "wetin you get", "wetin dey", "shop", "products"],
  },
  track: {
    en: ["track", "status", "where is my order"],
    fr: ["suivre", "statut", "suivi"],
    ha: ["bibiya", "bibiyi", "matsayi"],
    yo: ["tọpa", "ipò àṣẹ"],
    ig: ["lelee", "soro"],
    sw: ["fuatilia", "hali"],
    am: ["ከታተል", "ሁኔታ"],
    pcm: ["wey my order", "track am", "order status"],
  },
  support: {
    en: ["help", "support"],
    fr: ["aide", "assistance"],
    ha: ["taimako", "taimaka"],
    yo: ["ìrànlọ́wọ́", "ranlowo"],
    ig: ["enyemaka"],
    sw: ["msaada", "saidia"],
    am: ["እርዳታ", "ርዳታ"],
    pcm: ["help", "abeg help", "support"],
  },
  handoff: {
    en: ["human", "agent", "person"],
    fr: ["agent", "humain", "personne"],
    ha: ["wakili", "mutum"],
    yo: ["aṣojú", "ẹ̀nìyàn"],
    ig: ["nnọchi", "mmadụ"],
    sw: ["mtu", "wakala"],
    am: ["ሰው", "ወኪል"],
    pcm: ["person", "human being", "talk to person", "oga"],
  },
  booking: {
    en: ["book", "appointment"],
    fr: ["rendez-vous", "réserver"],
    ha: ["alƙawari", "naya alƙawari"],
    yo: ["ìpàdé", "pa àkókò"],
    ig: ["oge njikọ", "hazie"],
    sw: ["miadi", "weka miadi"],
    am: ["ቀጠሮ"],
    pcm: ["book", "appointment", "book appointment"],
  },
  checkout: {
    en: ["checkout", "cart", "done"],
    fr: ["panier", "commander", "terminé"],
    ha: ["kwando", "gama", "kammala"],
    yo: ["àpò", "parí", "checkout"],
    ig: ["ngọdo", "mezue"],
    sw: ["kikapu", "maliza", "kamilisha"],
    am: ["ጋሪ", "ጨርስ", "አጠናቅቅ"],
    pcm: ["checkout", "cart", "finish am", "don finish"],
  },
  pay: {
    en: ["pay", "payment", "pay now"],
    fr: ["payer", "paiement"],
    ha: ["biya", "biyan"],
    yo: ["sanwó", "sanwo"],
    ig: ["kwụọ", "ịkwụ ụgwọ"],
    sw: ["lipa", "malipo"],
    am: ["ክፈል", "ክፍያ", "መክፈል"],
    pcm: ["pay", "send money", "pay now", "make payment"],
  },
  discover: {
    en: ["near me", "nearby", "around me", "discover"],
    fr: ["près de moi", "à proximité", "proximité"],
    ha: ["kusa da ni", "a kusa", "kusa"],
    yo: ["nítòsí mi", "nítòsí", "sun mọ́ mi"],
    ig: ["dị m nso", "nso"],
    sw: ["karibu nami", "karibu", "jirani"],
    am: ["በአቅራቢያዬ", "አቅራቢያ", "ቅርብ"],
    pcm: ["near me", "wey dey near me", "around me"],
  },
  language: {
    en: ["language", "change language"],
    fr: ["langue", "changer de langue"],
    ha: ["harshe", "canza harshe"],
    yo: ["èdè", "yí èdè padà"],
    ig: ["asụsụ", "gbanwee asụsụ"],
    sw: ["lugha", "badilisha lugha"],
    am: ["ቋንቋ", "ቋንቋ ቀይር"],
    pcm: ["language", "change language", "pidgin"],
  },
  confirm: {
    en: ["yes", "confirm", "ok"],
    fr: ["oui", "confirmer", "d'accord"],
    ha: ["eh", "ee", "tabbatar", "lafiya"],
    yo: ["bẹẹni", "been", "jẹ́rìí"],
    ig: ["ee", "kwado"],
    sw: ["ndiyo", "thibitisha", "sawa"],
    am: ["አዎ", "አረጋግጥ", "እሺ"],
    pcm: ["yes o", "na so", "sharp", "confirm am", "yes"],
  },
  cancel: {
    en: ["no", "cancel", "stop"],
    fr: ["non", "annuler", "arrêter"],
    ha: ["a'a", "soke", "daina"],
    yo: ["rara", "fagi lé", "dáwọ́"],
    ig: ["mba", "kagbuo", "kwụsị"],
    sw: ["hapana", "ghairi", "acha"],
    am: ["አይ", "ሰርዝ", "ተው"],
    pcm: ["no", "comot", "leave am", "cancel am", "no do"],
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
