#!/usr/bin/env python3
"""Insert W54 capabilities i18n keys (membership CAP-1 + USSD depth CAP-2)
into server/services/i18n.ts — MessageKey union + EN catalog + 7 locales."""
import io

PATH = "server/services/i18n.ts"
src = open(PATH, encoding="utf-8").read()

TYPE_KEYS = """  | "eventUssdPickEvent" | "eventUssdPickQty";"""
TYPE_NEW = """  | "eventUssdPickEvent" | "eventUssdPickQty"
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
  | "ussdLoyaltyBalance" | "ussdLoyaltyDisabled";"""
assert src.count(TYPE_KEYS) == 1
src = src.replace(TYPE_KEYS, TYPE_NEW)

EN = {
    "membershipPlansHeader": "💎 Membership plans:",
    "membershipPlansEmpty": "No membership plans are available right now — please check back soon.",
    "membershipPlanLine": "{n}. {name} — {price} ({benefits})",
    "membershipJoinHint": "Reply JOIN MEMBERSHIP <number> to join, or MY MEMBERSHIP to check your status.",
    "membershipJoinActive": "🎉 Welcome to {plan}! Your membership is ACTIVE — {benefits}. It applies automatically at checkout.",
    "membershipJoinPayment": "💎 {plan} membership — total {currency} {total} (order {orderNumber}).",
    "membershipJoinLinkPending": "Your payment link is being prepared — the store will follow up shortly.",
    "membershipJoinAlready": "You already have an active {plan} membership — reply MY MEMBERSHIP to see it.",
    "membershipJoinFailed": "Sorry, I couldn't start that membership just now — please try again.",
    "membershipPickInvalid": "Please reply MEMBERSHIP first, then JOIN MEMBERSHIP <number> from the list.",
    "membershipBenefitsBoth": "{discount}% off orders + {mult}x loyalty points",
    "membershipBenefitsDiscount": "{discount}% off orders",
    "membershipBenefitsPoints": "{mult}x loyalty points",
    "membershipPriceFree": "FREE",
    "membershipStatusActive": "💎 Your membership: {plan} — {benefits}.",
    "membershipStatusUntil": " Active until {date}.",
    "membershipStatusCancelling": " It will end on {date} (cancellation scheduled).",
    "membershipStatusNone": "You don't have an active membership — reply MEMBERSHIP to see the plans.",
    "membershipCancelPeriodEnd": "✅ Your {plan} membership will end on {date} — your benefits stay active until then.",
    "membershipCancelImmediate": "✅ Your {plan} membership is cancelled — thank you for being a member!",
    "membershipCancelNone": "You don't have an active membership to cancel.",
    "ussdSavingsHeader": "Your savings circles:",
    "ussdSavingsNone": "You are not in any savings circle yet.",
    "ussdSavingsLine": "{name}: {amount}/{freq}, cycle {cycle}. Next payout: {next}.",
    "ussdLoyaltyBalance": "Loyalty points balance: {points} pts.",
    "ussdLoyaltyDisabled": "Loyalty rewards are not active at this store.",
}

FR = {
    "membershipPlansHeader": "💎 Formules d'adhésion :",
    "membershipPlansEmpty": "Aucune formule d'adhésion disponible pour le moment — revenez bientôt.",
    "membershipPlanLine": "{n}. {name} — {price} ({benefits})",
    "membershipJoinHint": "Répondez JOIN MEMBERSHIP <numéro> pour adhérer, ou MY MEMBERSHIP pour voir votre statut.",
    "membershipJoinActive": "🎉 Bienvenue dans {plan} ! Votre adhésion est ACTIVE — {benefits}. Elle s'applique automatiquement au paiement.",
    "membershipJoinPayment": "💎 Adhésion {plan} — total {currency} {total} (commande {orderNumber}).",
    "membershipJoinLinkPending": "Votre lien de paiement est en préparation — la boutique vous contactera bientôt.",
    "membershipJoinAlready": "Vous avez déjà une adhésion {plan} active — répondez MY MEMBERSHIP pour la voir.",
    "membershipJoinFailed": "Désolé, impossible de démarrer cette adhésion pour le moment — réessayez.",
    "membershipPickInvalid": "Répondez d'abord MEMBERSHIP, puis JOIN MEMBERSHIP <numéro> dans la liste.",
    "membershipBenefitsBoth": "{discount}% de remise + points fidélité x{mult}",
    "membershipBenefitsDiscount": "{discount}% de remise sur les commandes",
    "membershipBenefitsPoints": "points fidélité x{mult}",
    "membershipPriceFree": "GRATUIT",
    "membershipStatusActive": "💎 Votre adhésion : {plan} — {benefits}.",
    "membershipStatusUntil": " Active jusqu'au {date}.",
    "membershipStatusCancelling": " Elle prendra fin le {date} (annulation programmée).",
    "membershipStatusNone": "Vous n'avez pas d'adhésion active — répondez MEMBERSHIP pour voir les formules.",
    "membershipCancelPeriodEnd": "✅ Votre adhésion {plan} prendra fin le {date} — vos avantages restent actifs jusque-là.",
    "membershipCancelImmediate": "✅ Votre adhésion {plan} est annulée — merci d'avoir été membre !",
    "membershipCancelNone": "Vous n'avez pas d'adhésion active à annuler.",
    "ussdSavingsHeader": "Vos cercles d'épargne :",
    "ussdSavingsNone": "Vous n'êtes dans aucun cercle d'épargne pour le moment.",
    "ussdSavingsLine": "{name} : {amount}/{freq}, cycle {cycle}. Prochain versement : {next}.",
    "ussdLoyaltyBalance": "Solde de points fidélité : {points} pts.",
    "ussdLoyaltyDisabled": "Les récompenses fidélité ne sont pas actives dans cette boutique.",
}

HA = {
    "membershipPlansHeader": "💎 Shirye-shiryen zama memba:",
    "membershipPlansEmpty": "Babu shirin zama memba a yanzu — don Allah sake duba nan gaba.",
    "membershipPlanLine": "{n}. {name} — {price} ({benefits})",
    "membershipJoinHint": "Amsa JOIN MEMBERSHIP <lamba> don shiga, ko MY MEMBERSHIP don duba matsayinka.",
    "membershipJoinActive": "🎉 Barka da zuwa {plan}! Membarki ta yi aiki — {benefits}. Ana amfani da ita kai tsaye yayin biya.",
    "membershipJoinPayment": "💎 Membarki {plan} — jimla {currency} {total} (oda {orderNumber}).",
    "membershipJoinLinkPending": "Ana shirya hanyar biyanka — shagon zai tuntube ka nan ba da jimawa ba.",
    "membershipJoinAlready": "Kana da membarki {plan} mai aiki — amsa MY MEMBERSHIP don ganinta.",
    "membershipJoinFailed": "Yi haƙuri, ban iya fara wannan membarki yanzu — sake gwadawa.",
    "membershipPickInvalid": "Da farko amsa MEMBERSHIP, sannan JOIN MEMBERSHIP <lamba> daga jerin.",
    "membershipBenefitsBoth": "rangwame {discount}% + maki x{mult}",
    "membershipBenefitsDiscount": "rangwamen {discount}% akan odoci",
    "membershipBenefitsPoints": "maki x{mult}",
    "membershipPriceFree": "KYAUTA",
    "membershipStatusActive": "💎 Membarki: {plan} — {benefits}.",
    "membershipStatusUntil": " Tana aiki har {date}.",
    "membershipStatusCancelling": " Za ta ƙare ran {date} (an shirya soke).",
    "membershipStatusNone": "Ba ka da membarki mai aiki — amsa MEMBERSHIP don ganin shirye-shirye.",
    "membershipCancelPeriodEnd": "✅ Membarki {plan} za ta ƙare ran {date} — amfaninka yana aiki har sai.",
    "membershipCancelImmediate": "✅ An soke membarki {plan} — mun gode da zama memba!",
    "membershipCancelNone": "Ba ka da membarki mai aiki da za a soke.",
    "ussdSavingsHeader": "Kungiyoyin adashenka:",
    "ussdSavingsNone": "Ba ka cikin kungiyar adashe tukuna.",
    "ussdSavingsLine": "{name}: {amount}/{freq}, zagaye {cycle}. Na gaba biya: {next}.",
    "ussdLoyaltyBalance": "Makin loyalti: {points} pts.",
    "ussdLoyaltyDisabled": "Ba a amfani da kyautar loyalti a wannan shago.",
}

YO = {
    "membershipPlansHeader": "💎 Àwọn ètò ìkówé:",
    "membershipPlansEmpty": "Kò sí ètò ìkówé fún ìsinsinyí — jọ̀wọ́ ṣàyẹ̀wò lẹ́yìn.",
    "membershipPlanLine": "{n}. {name} — {price} ({benefits})",
    "membershipJoinHint": "Dahun JOIN MEMBERSHIP <nọ́ńbà> láti darapọ̀, tàbí MY MEMBERSHIP láti wo ipò rẹ.",
    "membershipJoinActive": "🎉 Káàbọ̀ sí {plan}! Ìkówé rẹ ti ṢIṢẸ́ — {benefits}. Ó ń lo fúnra rẹ̀ nígbà ìsanwó.",
    "membershipJoinPayment": "💎 Ìkówé {plan} — iye {currency} {total} (àṣẹ {orderNumber}).",
    "membershipJoinLinkPending": "A ń ṣètò ọ̀nà ìsanwó rẹ — ilé ìtajà yóò kàn sí ẹ laipẹ́.",
    "membershipJoinAlready": "O ti ní ìkówé {plan} tó ń ṣiṣẹ́ — dahun MY MEMBERSHIP láti wo ò.",
    "membershipJoinFailed": "Pèlé, n kò lè bẹ̀rù ìkówé yìí báyìí — gbìyànjú lẹ́ẹ̀kan sí i.",
    "membershipPickInvalid": "Dahun MEMBERSHIP níṣáájú, lẹ́yìn náà JOIN MEMBERSHIP <nọ́ńbà> láti inú àkójọ.",
    "membershipBenefitsBoth": "ìdínkù {discount}% + àmì x{mult}",
    "membershipBenefitsDiscount": "ìdínkù {discount}% lórí àwọn àṣẹ",
    "membershipBenefitsPoints": "àmì x{mult}",
    "membershipPriceFree": "Ọ̀FẸ́",
    "membershipStatusActive": "💎 Ìkówé rẹ: {plan} — {benefits}.",
    "membershipStatusUntil": " Ó ń ṣiṣẹ́ títí dé {date}.",
    "membershipStatusCancelling": " Yóò parí ní {date} (a ti ṣètò fagi lé).",
    "membershipStatusNone": "Ìwọ kò ní ìkówé tó ń ṣiṣẹ́ — dahun MEMBERSHIP láti wo àwọn ètò.",
    "membershipCancelPeriodEnd": "✅ Ìkówé {plan} rẹ yóò parí ní {date} — àwọn àǹfààní rẹ ń ṣiṣẹ́ títí dé ìgbà náà.",
    "membershipCancelImmediate": "✅ A ti fagi lé ìkówé {plan} rẹ — ẹ ṣeun fún jíjẹ́ ọmọ ẹgbẹ́!",
    "membershipCancelNone": "Ìwọ kò ní ìkówé tó ń ṣiṣẹ́ tí a lè fagi lé.",
    "ussdSavingsHeader": "Àwọn ẹgbẹ́ àdájọ rẹ:",
    "ussdSavingsNone": "Ìwọ kò sí nínú ẹgbẹ́ àdájọ kankan síbò.",
    "ussdSavingsLine": "{name}: {amount}/{freq}, yìí {cycle}. Ènì tó kàn ní ìsanwó tó nbọ̀: {next}.",
    "ussdLoyaltyBalance": "Àmì ìfẹ́rarẹ: {points} pts.",
    "ussdLoyaltyDisabled": "Ẹ̀bùn ìfẹ́rarẹ kò ṣiṣẹ́ ní ilé ìtajà yìí.",
}

IG = {
    "membershipPlansHeader": "💎 Atụmatụ otu:",
    "membershipPlansEmpty": "Enweghị atụmatụ otu ugbu a — biko lelee ọzọ.",
    "membershipPlanLine": "{n}. {name} — {price} ({benefits})",
    "membershipJoinHint": "Zaa JOIN MEMBERSHIP <nọmba> iji sonye, ma ọ bụ MY MEMBERSHIP iji hụ otu gị.",
    "membershipJoinActive": "🎉 Nnọọ na {plan}! Otu gị NA-ARỤ ỌRỤ — {benefits}. O na-arụ ọrụ ozugbo mgbe ị kwụrụ ụgwọ.",
    "membershipJoinPayment": "💎 Otu {plan} — mkpokọta {currency} {total} (ọrụ {orderNumber}).",
    "membershipJoinLinkPending": "A na-akwado njikọ ịkwụ ụgwọ gị — ụlọ ahịa ga-akpọtụrụ gị n'oge na-adịghị anya.",
    "membershipJoinAlready": "Ị nwerịrị otu {plan} na-arụ ọrụ — zaa MY MEMBERSHIP iji hụ ya.",
    "membershipJoinFailed": "Ndo, enweghị m ike ịmalite otu ahụ ugbu a — nwaa ọzọ.",
    "membershipPickInvalid": "Biko zaa MEMBERSHIP mbụ, wee zaa JOIN MEMBERSHIP <nọmba> site na ndepụta.",
    "membershipBenefitsBoth": "mbelata {discount}% + isi x{mult}",
    "membershipBenefitsDiscount": "mbelata {discount}% na ọrụ",
    "membershipBenefitsPoints": "isi x{mult}",
    "membershipPriceFree": "N'EFU",
    "membershipStatusActive": "💎 Otu gị: {plan} — {benefits}.",
    "membershipStatusUntil": " Na-arụ ọrụ ruo {date}.",
    "membershipStatusCancelling": " O ga-agwụ na {date} (edoziri ịkagbu).",
    "membershipStatusNone": "Ị nweghị otu na-arụ ọrụ — zaa MEMBERSHIP iji hụ atụmatụ.",
    "membershipCancelPeriodEnd": "✅ Otu {plan} gị ga-agwụ na {date} — uru gị na-arụ ọrụ ruo mgbe ahụ.",
    "membershipCancelImmediate": "✅ Ekagbuola otu {plan} gị — daalụ n'ihi na ị bụ onye otu!",
    "membershipCancelNone": "Ị nweghị otu na-arụ ọrụ iji kagbuo.",
    "ussdSavingsHeader": "Otu ekwote gị:",
    "ussdSavingsNone": "Ị nọbeghị n'otu ekwote ọ bụla ugbu a.",
    "ussdSavingsLine": "{name}: {amount}/{freq}, okirikiri {cycle}. Ịkwụ ụgwọ na-esote: {next}.",
    "ussdLoyaltyBalance": "Isi loyalty: {points} pts.",
    "ussdLoyaltyDisabled": "Onyinye loyalty anaghị arụ ọrụ n'ụlọ ahịa a.",
}

SW = {
    "membershipPlansHeader": "💎 Mpango wa uanachama:",
    "membershipPlansEmpty": "Hakuna mpango wa uanachama kwa sasa — rudi tena baadaye.",
    "membershipPlanLine": "{n}. {name} — {price} ({benefits})",
    "membershipJoinHint": "Jibu JOIN MEMBERSHIP <namba> kujiunga, au MY MEMBERSHIP kuona hali yako.",
    "membershipJoinActive": "🎉 Karibu {plan}! Uanachama wako UMEANZA — {benefits}. Unatumika moja kwa moja unapolipa.",
    "membershipJoinPayment": "💎 Uanachama {plan} — jumla {currency} {total} (oda {orderNumber}).",
    "membershipJoinLinkPending": "Kiungo chako cha malipo kinatayarishwa — duka litakupigia hivi karibuni.",
    "membershipJoinAlready": "Tayari una uanachama {plan} unaofanya kazi — jibu MY MEMBERSHIP kuuona.",
    "membershipJoinFailed": "Samahani, sikuweza kuanzisha uanachama huo sasa — jaribu tena.",
    "membershipPickInvalid": "Tafadhali jibu MEMBERSHIP kwanza, kisha JOIN MEMBERSHIP <namba> kutoka kwenye orodha.",
    "membershipBenefitsBoth": "punguzo la {discount}% + pointi x{mult}",
    "membershipBenefitsDiscount": "punguzo la {discount}% kwa oda",
    "membershipBenefitsPoints": "pointi x{mult}",
    "membershipPriceFree": "BURE",
    "membershipStatusActive": "💎 Uanachama wako: {plan} — {benefits}.",
    "membershipStatusUntil": " Unaofanya kazi hadi {date}.",
    "membershipStatusCancelling": " Utaisha {date} (ughairi umepangwa).",
    "membershipStatusNone": "Huna uanachama unaofanya kazi — jibu MEMBERSHIP kuona mipango.",
    "membershipCancelPeriodEnd": "✅ Uanachama wako {plan} utaisha {date} — manufaa yako yanaendelea hadi wakati huo.",
    "membershipCancelImmediate": "✅ Uanachama wako {plan} umeghairishwa — asante kwa kuwa mwanachama!",
    "membershipCancelNone": "Huna uanachama unaofanya kazi wa kughairi.",
    "ussdSavingsHeader": "Vyama vyako vya akiba:",
    "ussdSavingsNone": "Bado hauko kwenye chama cha akiba.",
    "ussdSavingsLine": "{name}: {amount}/{freq}, mzunguko {cycle}. Malipo yajayo: {next}.",
    "ussdLoyaltyBalance": "Salio la pointi: {points} pts.",
    "ussdLoyaltyDisabled": "Zawadi za uongozi hazijawashwa dukani hapa.",
}

AM = {
    "membershipPlansHeader": "💎 የአባልነት እቅዶች:",
    "membershipPlansEmpty": "በአሁኑ ጊዜ የአባልነት እቅድ የለም — እባክዎ ቆይተው ይመልከቱ።",
    "membershipPlanLine": "{n}. {name} — {price} ({benefits})",
    "membershipJoinHint": "ለመቀላቀል JOIN MEMBERSHIP <ቁጥር> ይመልሱ፣ ወይም ሁኔታዎን ለማየት MY MEMBERSHIP።",
    "membershipJoinActive": "🎉 እንኳን ወደ {plan} መጡ! አባልነትዎ ገብቷል — {benefits}። በክፍያ ጊዜ በራሱ ይተገበራል።",
    "membershipJoinPayment": "💎 {plan} አባልነት — ድምር {currency} {total} (ትዕዛዝ {orderNumber})።",
    "membershipJoinLinkPending": "የክፍያ አገናኝዎ በዝግጅት ላይ ነው — ሱቁ በቅርቡ ያግኝዎታል።",
    "membershipJoinAlready": "አስቀድመው ንቁ የ{plan} አባልነት አለዎት — ለማየት MY MEMBERSHIP ይመልሱ።",
    "membershipJoinFailed": "ይቅርታ፣ አሁን ያ አባልነት መጀመር አልቻልኩም — እባክዎ እንደገና ይሞክሩ።",
    "membershipPickInvalid": "እባክዎ መጀመሪያ MEMBERSHIP ይመልሱ፣ ከዚያ ከዝርዝሩ JOIN MEMBERSHIP <ቁጥር>።",
    "membershipBenefitsBoth": "{discount}% ቅናሽ + ነጥብ x{mult}",
    "membershipBenefitsDiscount": "በትዕዛዞች ላይ {discount}% ቅናሽ",
    "membershipBenefitsPoints": "ነጥብ x{mult}",
    "membershipPriceFree": "ነጻ",
    "membershipStatusActive": "💎 አባልነትዎ: {plan} — {benefits}።",
    "membershipStatusUntil": " እስከ {date} ንቁ ነው።",
    "membershipStatusCancelling": " በ {date} ያበቃል (መሰረዝ ተያይዟል)።",
    "membershipStatusNone": "ንቁ አባልነት የለዎትም — እቅዶቹን ለማየት MEMBERSHIP ይመልሱ።",
    "membershipCancelPeriodEnd": "✅ የ{plan} አባልነትዎ በ {date} ያበቃል — ጥቅሞቹ እስከዚያ ይቀጥላሉ።",
    "membershipCancelImmediate": "✅ የ{plan} አባልነትዎ ተሰርዟል — አባል ስለነበሩ እናመሰግናለን!",
    "membershipCancelNone": "የሚሰረዝ ንቁ አባልነት የለዎትም።",
    "ussdSavingsHeader": "የቁጠባ ክቦችዎ:",
    "ussdSavingsNone": "እስካሁን በምንም የቁጠባ ክብ ውስጥ አይደሉም።",
    "ussdSavingsLine": "{name}: {amount}/{freq}፣ ዙር {cycle}። ቀጣይ ክፍያ: {next}።",
    "ussdLoyaltyBalance": "የትጋት ነጥብ ሂሳብ: {points} pts።",
    "ussdLoyaltyDisabled": "የትጋት ሽልማቶች በዚህ ሱቅ አልነቁም።",
}

PCM = {
    "membershipPlansHeader": "💎 Membership plans:",
    "membershipPlansEmpty": "No membership plan dey now — check back later.",
    "membershipPlanLine": "{n}. {name} — {price} ({benefits})",
    "membershipJoinHint": "Reply JOIN MEMBERSHIP <number> to join, or MY MEMBERSHIP to check your own.",
    "membershipJoinActive": "🎉 Welcome to {plan}! Your membership don ACTIVE — {benefits}. E go apply by itself when you dey checkout.",
    "membershipJoinPayment": "💎 {plan} membership — total {currency} {total} (order {orderNumber}).",
    "membershipJoinLinkPending": "We dey prepare your payment link — the shop go message you soon.",
    "membershipJoinAlready": "You don already get active {plan} membership — reply MY MEMBERSHIP to see am.",
    "membershipJoinFailed": "Sorry, I no fit start that membership now — try again.",
    "membershipPickInvalid": "Abeg reply MEMBERSHIP first, then JOIN MEMBERSHIP <number> from the list.",
    "membershipBenefitsBoth": "{discount}% off orders + {mult}x points",
    "membershipBenefitsDiscount": "{discount}% off orders",
    "membershipBenefitsPoints": "{mult}x loyalty points",
    "membershipPriceFree": "FREE",
    "membershipStatusActive": "💎 Your membership: {plan} — {benefits}.",
    "membershipStatusUntil": " E dey active till {date}.",
    "membershipStatusCancelling": " E go end on {date} (cancel don dey booked).",
    "membershipStatusNone": "You no get active membership — reply MEMBERSHIP to see the plans.",
    "membershipCancelPeriodEnd": "✅ Your {plan} membership go end on {date} — your benefits still dey active till then.",
    "membershipCancelImmediate": "✅ Your {plan} membership don cancel — thank you for being a member!",
    "membershipCancelNone": "You no get active membership wey you fit cancel.",
    "ussdSavingsHeader": "Your savings circles:",
    "ussdSavingsNone": "You never join any savings circle yet.",
    "ussdSavingsLine": "{name}: {amount}/{freq}, cycle {cycle}. Next payout: {next}.",
    "ussdLoyaltyBalance": "Loyalty points balance: {points} pts.",
    "ussdLoyaltyDisabled": "Loyalty rewards no dey active for this shop.",
}

ANCHORS = {
    "EN": '  eventUssdPickQty: "How many tickets? Reply with a number.",',
    "fr": '    eventUssdPickQty: "Combien de billets ? Répondez avec un nombre.",',
    "ha": '    eventUssdPickQty: "Tikiti nawa? Amsa da lamba.",',
    "yo": '    eventUssdPickQty: "Ìkówé mélòó? Dahun pẹ̀lú nọ́ńbà.",',
    "ig": '    eventUssdPickQty: "Tiketi ole? Zaa nọmba.",',
    "sw": '    eventUssdPickQty: "Tiketi ngapi? Jibu kwa namba.",',
    "am": '    eventUssdPickQty: "ስንት ትኬት? በቁጥር ይመልሱ።",',
    "pcm": '    eventUssdPickQty: "How many tickets? Reply with number.",',
}
INDENT = {"EN": "  ", "fr": "    ", "ha": "    ", "yo": "    ", "ig": "    ", "sw": "    ", "am": "    ", "pcm": "    "}
LOCALES = {"EN": EN, "fr": FR, "ha": HA, "yo": YO, "ig": IG, "sw": SW, "am": AM, "pcm": PCM}

for loc, anchor in ANCHORS.items():
    assert src.count(anchor) == 1, (loc, src.count(anchor))
    ind = INDENT[loc]
    block = "".join(
        f'{ind}{k}: {v!r},'.replace("'", '"').replace('\\"', "'")
        for k, v in LOCALES[loc].items()
    )
    lines = "".join(f'{ind}{k}: "{v}",\n' if '"' not in v else f"{ind}{k}: '{v}',\n" for k, v in LOCALES[loc].items())
    src = src.replace(anchor, anchor + "\n" + lines.rstrip("\n"))

open(PATH, "w", encoding="utf-8").write(src)
print("i18n keys inserted")
