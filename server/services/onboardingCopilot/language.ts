/**
 * onboardingCopilot/language.ts — multilingual onboarding intake (wave 15, F5).
 *
 * Extends the wave-9 copilot so merchants can onboard in Hausa (ha), Yoruba
 * (yo), Igbo (ig) and Nigerian Pidgin (pcm) in addition to English (en) and
 * French (fr). Follows the conventions of server/services/i18n.ts (stopword +
 * diacritic heuristic detection, pack-per-locale strings) but is copilot-local:
 * the detected/chosen language is persisted on the onboarding session itself
 * (session.intake jsonb — schema-stable, no migration needed), so the whole
 * onboarding thread stays in-language.
 *
 * Language resolution per inbound message:
 *   1. EXPLICIT choice wins ("speak Yoruba", "ka yi hausa", menu selection).
 *   2. High-confidence heuristic detection switches the thread language
 *      (mixed-language tolerance — the copilot follows the latest message).
 *   3. Low-confidence / empty detection → stay in the current language.
 *   4. Unknown → English (the platform default).
 *
 * The English pack is byte-for-byte identical to the wave-9 strings; `en` and
 * `fr` behaviour is unchanged when the feature isn't triggered.
 */

export const COPILOT_LANGUAGES = ["en", "fr", "ha", "yo", "ig", "pcm"] as const;
export type CopilotLanguage = (typeof COPILOT_LANGUAGES)[number];
export const DEFAULT_COPILOT_LANGUAGE: CopilotLanguage = "en";

export function isCopilotLanguage(v: unknown): v is CopilotLanguage {
  return typeof v === "string" && (COPILOT_LANGUAGES as readonly string[]).includes(v);
}

/** Human-readable language names (used in the switch confirmation). */
export const LANGUAGE_NAMES: Record<CopilotLanguage, string> = {
  en: "English",
  fr: "Français",
  ha: "Hausa",
  yo: "Yorùbá",
  ig: "Igbo",
  pcm: "Nigerian Pidgin",
};

// ─── Copilot text packs ──────────────────────────────────────────────────────
//
// Placeholders use {name} syntax, substituted by t(). The `en` pack is the
// source of truth and MUST stay byte-identical to the wave-9 hard-coded
// strings (regression-guarded by tests).

export interface CopilotTextPack {
  /** startSession greeting. */
  greeting: string;
  /** Intake fallback question when the business name is still unknown. */
  askBusiness: string;
  /** Intro above the proposal cards ({businessName}). */
  proposalIntro: string;
  /** Text-command approvals ({kinds} = comma list of kinds). */
  approved: string;
  rejected: string;
  /** decideProposal outcomes ({kind}). */
  decideApproved: string;
  decideEdited: string;
  decideDiscarded: string;
  /** Intro above re-drafted proposals after feedback. */
  reworkedIntro: string;
  /** Nudge when feedback matched nothing. */
  reviewPrompt: string;
  /** Validation passed → go-live checkpoint. */
  goLiveReady: string;
  live: string;
  alreadyLive: string;
  /** "go live" while validating but checks failed ({reason}). */
  notYet: string;
  /** "go live" too early ({missing}). */
  notReady: string;
  missingIntake: string;
  missingProposals: string; // {count}
  missingConfiguring: string;
  missingState: string; // {state}
  /** Credential capture in configuring state. */
  credsUpdated: string;
  credsNote: string;
  /** configure with no tenant (nothing approved). */
  nothingApproved: string;
  couldNotApply: string; // {kind} {error}
  profilePushSkipped: string; // {error}
  couldNotGoLive: string; // {error}
  /** Post-live chat. */
  liveHint: string;
  failedState: string; // {errPart} — " (reason)" or ""
  abandoned: string;
  /** Repair loop ({reasons} bullet-joined, {provider}, {reason}). */
  repairCap: string;
  repairWhatsapp: string;
  repairWaba: string;
  repairIntegration: string;
  repairGeneric: string;
  /** Proposal-card action labels. */
  actionApprove: string;
  actionEdit: string;
  actionReject: string;
  /** "Applied: <summary>" after applyProposal ({summary}). */
  appliedSummary: string;
  /** WhatsApp profile push outcome ({pushed} / {failed}). */
  pushOk: string;
  pushFail: string;
  /** Proposal summaries ({list} = comma list). */
  summaryWaMenu: string;
  summaryUseCases: string;
  summaryIntegrations: string;
  summaryWaMenuRevised: string;
  summaryUseCasesRevised: string;
  summaryIntegrationsRevised: string;
  /** Confirmation after an explicit language switch ({language}). */
  languageSwitched: string;
}

const en: CopilotTextPack = {
  greeting:
    "Hi! I'm your onboarding assistant. Tell me about your business — " +
    "the name, what you sell, and your city — and I'll draft your WhatsApp " +
    "menu, branding and integrations for you to approve.",
  askBusiness:
    "Great to meet you! What's your business called, and what do you sell? " +
    "A city and how you handle delivery helps too.",
  proposalIntro:
    "Here's the setup I propose for {businessName}. " +
    "Review each card — approve, edit or reject. Nothing is applied until you approve it.",
  approved: "Approved: {kinds}.",
  rejected: "Rejected: {kinds}.",
  decideApproved: "Approved the {kind} proposal.",
  decideEdited: "Updated the {kind} proposal with your edits.",
  decideDiscarded: "Discarded the {kind} proposal. Tell me what you'd prefer and I'll draft another.",
  reworkedIntro:
    "I've reworked the proposal(s) with your changes — take another look and approve when ready.",
  reviewPrompt:
    "Please review the proposal cards above — reply \"approve all\", \"approve waMenu\", " +
    "or \"reject …\", or use the Approve/Edit buttons.",
  goLiveReady:
    "🎉 All validation checks passed! One last step: approve go-live to switch your " +
    "WhatsApp assistant on for customers (or reply \"go live\").",
  live: "🎉 You're LIVE! Your customers can now message your business on WhatsApp.",
  alreadyLive: "You're already live! 🎉",
  notYet: "Not yet — {reason}.",
  notReady: "Not ready to go live: {missing}",
  missingIntake: "we haven't finished intake — tell me about your business first.",
  missingProposals:
    "there are {count} proposal(s) waiting for your approval — approve them first.",
  missingConfiguring:
    "validation hasn't passed yet — fix the failing checks above and I'll re-run them.",
  missingState: "this session is {state} — start a new session to onboard.",
  credsUpdated: "Got it — credentials updated. Re-running the checks…",
  credsNote:
    "Thanks — once you've updated the setting, paste the new value here (e.g. \"token is EAA…\" " +
    "or \"phone number id is 123456\") and I'll re-run the validation.",
  nothingApproved:
    "No proposals were approved, so there's nothing to set up yet. Tell me what you'd like to change!",
  couldNotApply: "Couldn't apply {kind}: {error}",
  profilePushSkipped: "Profile push skipped: {error}",
  couldNotGoLive: "Couldn't go live yet: {error}",
  liveHint:
    "You're already live! Use the admin dashboard to tweak menus, branding or integrations.",
  failedState:
    "This onboarding run hit its retry limit{errPart}. Please contact support, or start a new session.",
  abandoned: "This session was abandoned. Start a new one to continue.",
  repairCap:
    "I've tried to validate your setup a few times and some checks are still failing: " +
    "{reasons} Please contact support to finish onboarding.",
  repairWhatsapp:
    "I couldn't reach your WhatsApp phone number with the token on file. " +
    "Please re-paste your WhatsApp access token and phone number ID from Meta Business Settings → WhatsApp → API Setup.",
  repairWaba:
    "Your WhatsApp token can't read the WhatsApp Business Account (WABA) — " +
    "please re-paste the token from Meta Business Settings and make sure it has the whatsapp_business_management permission.",
  repairIntegration:
    "The {provider} connection test failed. Please check the {provider} URL and API key " +
    "in Settings → Integrations (or paste them here) and I'll try again.",
  repairGeneric:
    "A validation check failed ({reason}). Please review the setting and I'll re-run the checks.",
  actionApprove: "Approve",
  actionEdit: "Edit",
  actionReject: "Reject",
  appliedSummary: "Applied: {summary}",
  pushOk: "WhatsApp profile updated ({pushed}).",
  pushFail: "Could not update the WhatsApp profile: {failed}.",
  summaryWaMenu: "WhatsApp menu (template): greeting + top use cases",
  summaryUseCases: "Suggested use cases: {list}",
  summaryIntegrations: "Suggested integrations: {list}",
  summaryWaMenuRevised: "WhatsApp menu (revised): greeting + top use cases",
  summaryUseCasesRevised: "Suggested use cases (revised): {list}",
  summaryIntegrationsRevised: "Suggested integrations (revised): {list}",
  languageSwitched: "No problem — I'll continue in {language}.",
};

const fr: CopilotTextPack = {
  greeting:
    "Bonjour ! Je suis votre assistant d'intégration. Parlez-moi de votre commerce — " +
    "le nom, ce que vous vendez et votre ville — et je préparerai votre menu WhatsApp, " +
    "votre image de marque et vos intégrations pour approbation.",
  askBusiness:
    "Ravi de vous rencontrer ! Comment s'appelle votre commerce et que vendez-vous ? " +
    "La ville et votre mode de livraison m'aident aussi.",
  proposalIntro:
    "Voici la configuration que je propose pour {businessName}. " +
    "Examinez chaque carte — approuvez, modifiez ou rejetez. Rien n'est appliqué sans votre accord.",
  approved: "Approuvé : {kinds}.",
  rejected: "Rejeté : {kinds}.",
  decideApproved: "Proposition {kind} approuvée.",
  decideEdited: "Proposition {kind} mise à jour avec vos modifications.",
  decideDiscarded: "Proposition {kind} écartée. Dites-moi ce que vous préférez et j'en préparerai une autre.",
  reworkedIntro:
    "J'ai retravaillé les propositions avec vos changements — vérifiez et approuvez quand vous êtes prêt.",
  reviewPrompt:
    "Veuillez examiner les cartes ci-dessus — répondez « approve all », « approve waMenu », " +
    "ou « reject … », ou utilisez les boutons Approuver/Modifier.",
  goLiveReady:
    "🎉 Toutes les vérifications sont passées ! Dernière étape : approuvez la mise en ligne " +
    "pour activer votre assistant WhatsApp (ou répondez « go live »).",
  live: "🎉 Vous êtes EN LIGNE ! Vos clients peuvent désormais écrire à votre commerce sur WhatsApp.",
  alreadyLive: "Vous êtes déjà en ligne ! 🎉",
  notYet: "Pas encore — {reason}.",
  notReady: "Pas prêt pour la mise en ligne : {missing}",
  missingIntake: "nous n'avons pas terminé la collecte — parlez-moi d'abord de votre commerce.",
  missingProposals: "il y a {count} proposition(s) en attente de votre approbation — approuvez-les d'abord.",
  missingConfiguring:
    "la validation n'a pas encore réussi — corrigez les vérifications en échec ci-dessus et je les relancerai.",
  missingState: "cette session est {state} — démarrez une nouvelle session pour vous intégrer.",
  credsUpdated: "C'est noté — identifiants mis à jour. Je relance les vérifications…",
  credsNote:
    "Merci — une fois le paramètre mis à jour, collez la nouvelle valeur ici (ex. « token is EAA… » " +
    "ou « phone number id is 123456 ») et je relancerai la validation.",
  nothingApproved:
    "Aucune proposition n'a été approuvée, il n'y a donc rien à configurer. Dites-moi ce que vous voulez changer !",
  couldNotApply: "Impossible d'appliquer {kind} : {error}",
  profilePushSkipped: "Envoi du profil ignoré : {error}",
  couldNotGoLive: "Mise en ligne impossible pour le moment : {error}",
  liveHint:
    "Vous êtes déjà en ligne ! Utilisez le tableau de bord admin pour ajuster menus, image de marque ou intégrations.",
  failedState:
    "Cette intégration a atteint sa limite de tentatives{errPart}. Contactez le support ou démarrez une nouvelle session.",
  abandoned: "Cette session a été abandonnée. Démarrez-en une nouvelle pour continuer.",
  repairCap:
    "J'ai tenté de valider votre configuration plusieurs fois et des vérifications échouent encore : " +
    "{reasons} Contactez le support pour terminer l'intégration.",
  repairWhatsapp:
    "Je n'ai pas pu joindre votre numéro WhatsApp avec le jeton enregistré. " +
    "Veuillez recoller votre jeton d'accès WhatsApp et l'ID de numéro depuis Meta Business Settings → WhatsApp → API Setup.",
  repairWaba:
    "Votre jeton WhatsApp ne peut pas lire le compte WhatsApp Business (WABA) — " +
    "recollez le jeton depuis Meta Business Settings et vérifiez la permission whatsapp_business_management.",
  repairIntegration:
    "Le test de connexion {provider} a échoué. Vérifiez l'URL et la clé API {provider} " +
    "dans Paramètres → Intégrations (ou collez-les ici) et je réessaierai.",
  repairGeneric:
    "Une vérification a échoué ({reason}). Vérifiez le paramètre et je relancerai les contrôles.",
  actionApprove: "Approuver",
  actionEdit: "Modifier",
  actionReject: "Rejeter",
  appliedSummary: "Appliqué : {summary}",
  pushOk: "Profil WhatsApp mis à jour ({pushed}).",
  pushFail: "Impossible de mettre à jour le profil WhatsApp : {failed}.",
  summaryWaMenu: "Menu WhatsApp (modèle) : accueil + cas d'usage principaux",
  summaryUseCases: "Cas d'usage suggérés : {list}",
  summaryIntegrations: "Intégrations suggérées : {list}",
  summaryWaMenuRevised: "Menu WhatsApp (révisé) : accueil + cas d'usage principaux",
  summaryUseCasesRevised: "Cas d'usage suggérés (révisés) : {list}",
  summaryIntegrationsRevised: "Intégrations suggérées (révisées) : {list}",
  languageSwitched: "Pas de problème — je continue en {language}.",
};

const ha: CopilotTextPack = {
  greeting:
    "Sannu! Ni ne mataimakin rajistarka. Faɗa min game da kasuwancinka — " +
    "sunan, abin da kake sayarwa, da birninka — zan kuma shirya maka menu na WhatsApp, " +
    "tambari da haɗin kayan aiki don ka amince da su.",
  askBusiness:
    "Muna farin cikin ganinka! Mene ne sunan kasuwancinka, kuma me kake sayarwa? " +
    "Birni da yadda kake isar da kaya ma suna taimakawa.",
  proposalIntro:
    "Ga shirin da nake ba da shawara don {businessName}. " +
    "Duba kowane kati — amince, gyara ko ƙi. Ba a aiwatar da kome sai ka amince.",
  approved: "An amince: {kinds}.",
  rejected: "An ƙi: {kinds}.",
  decideApproved: "An amince da shawarar {kind}.",
  decideEdited: "An sabunta shawarar {kind} da gyare-gyarenka.",
  decideDiscarded: "An watsar da shawarar {kind}. Faɗa min abin da ka fi so zan shirya wata.",
  reworkedIntro:
    "Na sake gyara shawarwarin da canje-canjenka — duba su kuma amince idan ka shirya.",
  reviewPrompt:
    "Don Allah duba katunan shawarwari a sama — amsa \"approve all\", \"approve waMenu\", " +
    "ko \"reject …\", ko ka yi amfani da madukan Amince/Gyara.",
  goLiveReady:
    "🎉 Dukkan binciken sun yi nasara! Mataki na ƙarshe: amince da kaddamarwa don kunna " +
    "mataimakin WhatsApp ɗinka ga abokan ciniki (ko amsa \"go live\").",
  live: "🎉 Ka shiga LAYI! Abokan cinikinka yanzu suna iya aika saƙo ga kasuwancinka ta WhatsApp.",
  alreadyLive: "Kana layi riga! 🎉",
  notYet: "Ba yanzu ba — {reason}.",
  notReady: "Ba a shirye kaddamarwa ba tukuna: {missing}",
  missingIntake: "ba mu gama tattara bayanai ba — faɗa min game da kasuwancinka da farko.",
  missingProposals: "akwai shawara {count} da ke jiran amincewarka — amince da su da farko.",
  missingConfiguring:
    "binciken bai yi nasara ba tukuna — gyara abubuwan da suka kasa a sama zan sake gudanar da su.",
  missingState: "wannan zama {state} yake — fara sabon zama don rajista.",
  credsUpdated: "Madalla — an sabunta bayanan shiga. Ina sake gudanar da bincike…",
  credsNote:
    "Na gode — idan ka sabunta saitin, manna sabon ƙimar a nan (misali \"token is EAA…\" " +
    "ko \"phone number id is 123456\") zan sake gudanar da binciken.",
  nothingApproved:
    "Ba a amince da kowace shawara ba, don haka babu abin da za a saita tukuna. Faɗa min abin da kake so ka canza!",
  couldNotApply: "Ba a iya aiwatar da {kind} ba: {error}",
  profilePushSkipped: "An ƙetare tura bayanan martaba: {error}",
  couldNotGoLive: "Ba a iya kaddamarwa tukuna ba: {error}",
  liveHint:
    "Kana layi riga! Yi amfani da allon sarrafawa don gyara menu, tambari ko haɗin kayan aiki.",
  failedState:
    "Wannan rajista ta kai iyakar gwaje-gwaje{errPart}. Don Allah tuntuɓi goyon baya, ko ka fara sabon zama.",
  abandoned: "An bar wannan zama. Fara sabon don ci gaba.",
  repairCap:
    "Na gwada inganta saitinka sau da dama amma wasu binciken har yanzu suna kasawa: " +
    "{reasons} Don Allah tuntuɓi goyon baya don kammala rajista.",
  repairWhatsapp:
    "Ban iya isa lambar WhatsApp ɗinka ba da alamar da aka rubuta. " +
    "Don Allah sake manna alamar shiga ta WhatsApp da ID na lamba daga Meta Business Settings → WhatsApp → API Setup.",
  repairWaba:
    "Alamar WhatsApp ɗinka ba za ta iya karanta asusun WhatsApp Business (WABA) ba — " +
    "sake manna alamar daga Meta Business Settings kuma tabbata tana da izinin whatsapp_business_management.",
  repairIntegration:
    "Gwajin haɗin {provider} ya kasa. Don Allah duba URL na {provider} da maɓallin API " +
    "a Saiti → Haɗin kai (ko ka manna su a nan) zan sake gwadawa.",
  repairGeneric:
    "Wani bincike ya kasa ({reason}). Don Allah duba saitin zan sake gudanar da binciken.",
  actionApprove: "Amince",
  actionEdit: "Gyara",
  actionReject: "Ƙi",
  appliedSummary: "An aiwatar: {summary}",
  pushOk: "An sabunta bayanan martabar WhatsApp ({pushed}).",
  pushFail: "Ba a iya sabunta bayanan martabar WhatsApp ba: {failed}.",
  summaryWaMenu: "Menu na WhatsApp (samfuri): gaisuwa + manyan amfanoni",
  summaryUseCases: "Amfanoni da aka ba da shawara: {list}",
  summaryIntegrations: "Haɗin kayan aiki da aka ba da shawara: {list}",
  summaryWaMenuRevised: "Menu na WhatsApp (gyararre): gaisuwa + manyan amfanoni",
  summaryUseCasesRevised: "Amfanoni da aka ba da shawara (gyararre): {list}",
  summaryIntegrationsRevised: "Haɗin kayan aiki da aka ba da shawara (gyararre): {list}",
  languageSwitched: "Ba wata matsala — zan ci gaba da {language}.",
};

const yo: CopilotTextPack = {
  greeting:
    "Ẹ káàbọ̀! Èmi ni olùrànlọ́wọ́ ìforúkọsílẹ̀ rẹ. Sọ fún mi nípa iṣòwò rẹ — " +
    "orúkọ, ohun tí o ń ta, àti ìlú rẹ — màá sì ṣe àtòsọ̀nà fún àtòjọ WhatsApp rẹ, " +
    "àmì-ìdájọ́ àti àwọn ìsopọ̀ fún ìfọwọ́sí rẹ.",
  askBusiness:
    "Ó dùn mọ́ ọn láti pàdé yín! Kí ni orúkọ iṣòwò yín, kí ni ẹ sì ń ta? " +
    "Ìlú àti bí ẹ ṣe ń fi ọjà ráńṣẹ́ tún wúlò.",
  proposalIntro:
    "Èyí ni ètò tí mo dámọ̀ọ́nìí fún {businessName}. " +
    "Ṣàyẹ̀wò kólóòkù kàdì — fọwọ́ sí, ṣàtúnṣe tàbí kọ̀. Kò sí ohun tí a ó lo títí tí ẹ yóò fi fọwọ́ sí i.",
  approved: "A ti fọwọ́ sí: {kinds}.",
  rejected: "A ti kọ̀: {kinds}.",
  decideApproved: "A ti fọwọ́ sí àbá {kind}.",
  decideEdited: "A ti ṣe àtúnṣe àbá {kind} pẹ̀lú àwọn àtúnṣe yín.",
  decideDiscarded: "A ti fẹ̀ àbá {kind} sílẹ̀. Sọ ohun tí ẹ fẹ́ kí n tún ṣe èlòmíì.",
  reworkedIntro:
    "Mo ti tún àbá náà ṣe pẹ̀lú àwọn àtúnṣe yín — ṣàyẹ̀wò wọn kí ẹ sì fọwọ́ sí nígbà tí ẹ bá ṣetán.",
  reviewPrompt:
    "Jọ̀wọ́ ṣàyẹ̀wò àwọn kàdì àbá lókè — dáhùn \"approve all\", \"approve waMenu\", " +
    "tàbí \"reject …\", tàbí kí ẹ lo àwọn bọ́tìnì Fọwọ́sí/Àtúnṣe.",
  goLiveReady:
    "🎉 Gbogbo àyẹ̀wò ti ṣàṣeyọrí! Ìgbésẹ̀ tó kẹ́yìn: fọwọ́ sí ìbẹ̀rẹ̀ láìsí àfikún " +
    "láti tan olùrànlọ́wọ́ WhatsApp yín fún àwọn ónìbàárà (tàbí dáhùn \"go live\").",
  live: "🎉 Ẹ TI WÀ LÁYÀRÁ! Àwọn ónìbàárà yín lè rá iṣòwò yín lẹ́tà lórí WhatsApp báyìí.",
  alreadyLive: "Ẹ ti wà láyàrárí! 🎉",
  notYet: "Kò tíì ṣeé ṣe — {reason}.",
  notReady: "A kò tíì ṣetán fún ìbẹ̀rẹ̀: {missing}",
  missingIntake: "a kò tíì parí ìgbígbé àlàyé — sọ fún wa nípa iṣòwò yín ní ṣáájú.",
  missingProposals: "àbá {count} ló ń dúró de ìfọwọ́sí yín — fọwọ́ sí wọn ní ṣáájú.",
  missingConfiguring:
    "ìdíwọ́ kò tíì ṣàṣeyọrí — ṣàtúnṣe àwọn àyẹ̀wò tó kùnà lókè, màá sì tún wọn ránṣẹ́.",
  missingState: "ìsìn yìí wà ní {state} — bẹ̀rẹ̀ ìsìn tuntun láti forúkọsílẹ̀.",
  credsUpdated: "Ó dáa — a ti ṣe àtúnṣe àwọn ẹ̀rí ìwọlé. Ń tún àwọn àyẹ̀wò ránṣẹ́…",
  credsNote:
    "Ẹ ṣeun — nígbà tí ẹ bá ti ṣe àtúnṣe ètò náà, lẹ́ àyè tuntun síbí (àpẹẹrẹ \"token is EAA…\" " +
    "tàbí \"phone number id is 123456\") màá sì tún ìdíwọ́ ránṣẹ́.",
  nothingApproved:
    "A kò fọwọ́ sí àbá kankan, nítorí náà kò sí ohun tí a lè ṣe títí. Sọ ohun tí ẹ fẹ́ yí padà!",
  couldNotApply: "A kò lè lo {kind}: {error}",
  profilePushSkipped: "A fòwọ́rò fífi profaili ránṣẹ́: {error}",
  couldNotGoLive: "A kò tíì lè bẹ̀rẹ̀: {error}",
  liveHint:
    "Ẹ ti wà láyàrárí! Lo àkópọ̀ iṣàkóso láti ṣàtúnṣe àtòjọ, àmì-ìdájọ́ tàbí ìsopọ̀.",
  failedState:
    "Ìforúkọsílẹ̀ yìí ti dé òpin ìgbìyànjú rẹ̀{errPart}. Jọ̀wọ́ kàn sí ẹgbẹ́ ìrànlọ́wọ́, tàbí bẹ̀rẹ̀ ìsìn tuntun.",
  abandoned: "A ti fi ìsìn yìí sílẹ̀. Bẹ̀rẹ̀ tuntun láti tẹ̀síwájú.",
  repairCap:
    "Mo ti gbìyànjú láti ṣàyẹ̀wò ètò yín ní ẹ̀ṣọ́ púpọ̀, àmọ́ àwọn àyẹ̀wò kan ṣì ń kùnà: " +
    "{reasons} Jọ̀wọ́ kàn sí ẹgbẹ́ ìrànlọ́wọ́ láti parí ìforúkọsílẹ̀.",
  repairWhatsapp:
    "N kò lè dé nọ́ńbà WhatsApp yín pẹ̀lú tọ́kìn tó wà lọ́wọ́ wa. " +
    "Jọ̀wọ́ tún lẹ́ tọ́kìn àti ID nọ́ńbà WhatsApp yín láti inú Meta Business Settings → WhatsApp → API Setup.",
  repairWaba:
    "Tọ́kìn WhatsApp yín kò lè ka àkántì WhatsApp Business (WABA) — " +
    "tún tọ́kìn náà lẹ́ láti inú Meta Business Settings kí ẹ sì rí i pé ó ní àṣẹ whatsapp_business_management.",
  repairIntegration:
    "Ìdánwò ìsopọ̀ {provider} kùnà. Jọ̀wọ́ ṣàyẹ̀wò URL àti kókóró API {provider} " +
    "ní Ètò → Ìsopọ̀ (tàbí lẹ́ wọ́n síbí) màá sì tún gbìyànjú.",
  repairGeneric:
    "Àyẹ̀wò kan kùnà ({reason}). Jọ̀wọ́ ṣàyẹ̀wò ètò náà, màá sì tún àwọn àyẹ̀wò ránṣẹ́.",
  actionApprove: "Fọwọ́ sí",
  actionEdit: "Ṣàtúnṣe",
  actionReject: "Kọ̀",
  appliedSummary: "A ti lo: {summary}",
  pushOk: "A ti ṣe àtúnṣe profaili WhatsApp ({pushed}).",
  pushFail: "A kò lè ṣe àtúnṣe profaili WhatsApp: {failed}.",
  summaryWaMenu: "Àtòjọ WhatsApp (àpẹẹrẹ): ìkáàbọ̀ + àwọn lílò tó ṣe pàtàkì",
  summaryUseCases: "Àwọn lílò tí a dámọ̀ọ́nìí: {list}",
  summaryIntegrations: "Àwọn ìsopọ̀ tí a dámọ̀ọ́nìí: {list}",
  summaryWaMenuRevised: "Àtòjọ WhatsApp (àtúnṣe): ìkáàbọ̀ + àwọn lílò tó ṣe pàtàkì",
  summaryUseCasesRevised: "Àwọn lílò tí a dámọ̀ọ́nìí (àtúnṣe): {list}",
  summaryIntegrationsRevised: "Àwọn ìsopọ̀ tí a dámọ̀ọ́nìí (àtúnṣe): {list}",
  languageSwitched: "Kò sí wàhálà — màá tẹ̀síwájú ní {language}.",
};

const ig: CopilotTextPack = {
  greeting:
    "Nnọọ! Abụ m onye enyemaka ndebanye aha gị. Gwa m banyere azụmahịa gị — " +
    "aha, ihe ị na-ere, na obodo gị — m ga-akwadebe menu WhatsApp gị, " +
    "Ọdịdị ụdị na njikọ maka nkwenye gị.",
  askBusiness:
    "Ọ dị m ụtọ izute gị! Kedu aha azụmahịa gị, kedu ihe ị na-ere? " +
    "Obodo na otu ị si ezipu ihe ndị ahịa na-enyekwa aka.",
  proposalIntro:
    "Nke a bụ nhazi m na-atụ aro maka {businessName}. " +
    "Nyochaa kaadị ọ bụla — kweny, dozie ma ọ bụ jụ. E tinyeghị ihe ọ bụla ruo mgbe ị kwenyere.",
  approved: "Ekwenyela: {kinds}.",
  rejected: "Ajụla: {kinds}.",
  decideApproved: "Ekwenyere atụmatụ {kind}.",
  decideEdited: "Emelitere atụmatụ {kind} site na mgbanwe gị.",
  decideDiscarded: "A hapụla atụmatụ {kind}. Gwa m ihe ị chọrọ ka m mee, m ga-akwadebe ọzọ.",
  reworkedIntro:
    "E mechaa m atụmatụ ndị ahụ na mgbanwe gị — nyochaa ha wee kwenye mgbe ị dị njikere.",
  reviewPrompt:
    "Biko nyochaa kaadị atụmatụ dị n'elu — zaa \"approve all\", \"approve waMenu\", " +
    "ma ọ bụ \"reject …\", ma ọ bụ jiri bọtịnụ Kwene/Dozie.",
  goLiveReady:
    "🎉 Nchọpụta niile gafewo! Nzọụkwụ ikpeazụ: kwenye ịmalite iji gbanye " +
    "onye enyemaka WhatsApp gị maka ndị ahịa (ma ọ bụ zaa \"go live\").",
  live: "🎉 Ị NO UGBU A NA-ARỤ ỌRỤ! Ndị ahịa gị nwere ike izitere azụmahịa gị ozi na WhatsApp ugbu a.",
  alreadyLive: "Ị nọ na-arụ ọrụ kwa! 🎉",
  notYet: "Ọ dịbeghị — {reason}.",
  notReady: "Ọ dịbeghị njikere ịmalite: {missing}",
  missingIntake: "anyị ejidewecha njikọta ozi — gwa m banyere azụmahịa gị tupu.",
  missingProposals: "enwere atụmatụ {count} na-echere nkwenye gị — kwenye ha tupu.",
  missingConfiguring:
    "nchọpụta agafebechaghị — dozie nlele ndị dara n'elu, m ga-agba ha ọzọ.",
  missingState: "nnọkọ a dị na {state} — malite nnọkọ ọhụrụ iji debanye aha.",
  credsUpdated: "Ọ dị mma — emelitere ihe nbanye. Ana m agba nchọpụta ọzọ…",
  credsNote:
    "Daalụ — mgbe ị mezuru ntọala ahụ, tinye uru ọhụrụ ebe a (dịka \"token is EAA…\" " +
    "ma ọ bụ \"phone number id is 123456\") m ga-agba nchọpụta ọzọ.",
  nothingApproved:
    "Ekwenyeghị atụmatụ ọ bụla, yabụ enwebeghị ihe a ga-edobe. Gwa m ihe ị chọrọ ịgbanwe!",
  couldNotApply: "Enweghị ike itinye {kind}: {error}",
  profilePushSkipped: "A gafere iziga profaịlụ: {error}",
  couldNotGoLive: "Enwebeghị ike ịmalite ugbu a: {error}",
  liveHint:
    "Ị nọ na-arụ ọrụ kwa! Jiri dashbọọdụ nchịkwa iji gbanwee menu, ụdị ma ọ bụ njikọ.",
  failedState:
    "Ndebanye a ruru ókè nnwa{errPart}. Biko kpọtụrụ ndị nkwado, ma ọ bụ malite nnọkọ ọhụrụ.",
  abandoned: "A hapụrụ nnọkọ a. Malite nnọkọ ọzọ iji gaa n'ihu.",
  repairCap:
    "Anwala m ịnchọpụta ntọala gị ọtụtụ ugboro ma ụfọdụ nlele ka na-adaba: " +
    "{reasons} Biko kpọtụrụ ndị nkwado iji mezue ndebanye.",
  repairWhatsapp:
    "Enweghị m ike iru nọmba WhatsApp gị site na ihe nbanye dị na faịlụ. " +
    "Biko tinye ọzọ ihe nbanye WhatsApp gị na ID nọmba site na Meta Business Settings → WhatsApp → API Setup.",
  repairWaba:
    "Ihe nbanye WhatsApp gị enweghị ike ịgụ akaụntụ WhatsApp Business (WABA) — " +
    "tinye ọzọ ihe nbanye ahụ site na Meta Business Settings wee hụ na ọ nwere ikike whatsapp_business_management.",
  repairIntegration:
    "Nnwale njikọ {provider} dara. Biko lelee URL na igodo API {provider} " +
    "na Ntọala → Njikọ (ma ọ bụ tinye ha ebe a), m ga-anwa ọzọ.",
  repairGeneric:
    "Nlele ọ bụla dara ({reason}). Biko nyochaa ntọala ahụ, m ga-agba nlele ọzọ.",
  actionApprove: "Kwene",
  actionEdit: "Dozie",
  actionReject: "Jụ",
  appliedSummary: "Etinyela: {summary}",
  pushOk: "Emelitere profaịlụ WhatsApp ({pushed}).",
  pushFail: "Enweghị ike imelite profaịlụ WhatsApp: {failed}.",
  summaryWaMenu: "Menu WhatsApp (ihe nlereanya): ekele + ojiji kacha elu",
  summaryUseCases: "Ojiji a tụrụ aro: {list}",
  summaryIntegrations: "Njikọ a tụrụ aro: {list}",
  summaryWaMenuRevised: "Menu WhatsApp (edoziri): ekele + ojiji kacha elu",
  summaryUseCasesRevised: "Ojiji a tụrụ aro (edoziri): {list}",
  summaryIntegrationsRevised: "Njikọ a tụrụ aro (edoziri): {list}",
  languageSwitched: "Ọ dị mma — m aga n'ihu na {language}.",
};

const pcm: CopilotTextPack = {
  greeting:
    "How far! Na me be your onboarding padi. Tell me about your business — " +
    "the name, wetin you dey sell, and your city — I go draft your WhatsApp " +
    "menu, branding and integrations make you approve am.",
  askBusiness:
    "Good to meet you o! Wetin be your business name, and wetin you dey sell? " +
    "Your city and how you dey deliver go help too.",
  proposalIntro:
    "See the setup wey I dey propose for {businessName}. " +
    "Check each card — approve, edit or reject. Nothing go apply until you approve am.",
  approved: "Approved: {kinds}.",
  rejected: "Rejected: {kinds}.",
  decideApproved: "You don approve the {kind} proposal.",
  decideEdited: "I don update the {kind} proposal with your edits.",
  decideDiscarded: "I don drop the {kind} proposal. Tell me wetin you prefer make I draft another one.",
  reworkedIntro:
    "I don rework the proposal(s) with your changes — check am again and approve when you ready.",
  reviewPrompt:
    "Abeg check the proposal cards up — reply \"approve all\", \"approve waMenu\", " +
    "or \"reject …\", or use the Approve/Edit buttons.",
  goLiveReady:
    "🎉 All the validation checks don pass! One last step: approve go-live make we switch on " +
    "your WhatsApp assistant for customers (or reply \"go live\").",
  live: "🎉 You don LIVE! Your customers fit message your business for WhatsApp now.",
  alreadyLive: "You don live already! 🎉",
  notYet: "Never — {reason}.",
  notReady: "We never ready to go live: {missing}",
  missingIntake: "we never finish intake — tell me about your business first.",
  missingProposals: "{count} proposal(s) dey wait for your approval — approve dem first.",
  missingConfiguring:
    "validation never pass yet — fix the checks wey fail up there and I go run dem again.",
  missingState: "this session na {state} — start new session to onboard.",
  credsUpdated: "I hear you — credentials don update. I dey run the checks again…",
  credsNote:
    "Thanks — once you don update the setting, paste the new value here (e.g. \"token is EAA…\" " +
    "or \"phone number id is 123456\") and I go run the validation again.",
  nothingApproved:
    "No proposal approve, so nothing dey to set up yet. Tell me wetin you wan change!",
  couldNotApply: "I no fit apply {kind}: {error}",
  profilePushSkipped: "Profile push skip: {error}",
  couldNotGoLive: "We no fit go live yet: {error}",
  liveHint:
    "You don live already! Use the admin dashboard take tweak menus, branding or integrations.",
  failedState:
    "This onboarding run don reach im retry limit{errPart}. Abeg contact support, or start new session.",
  abandoned: "Dem don abandon this session. Start new one to continue.",
  repairCap:
    "I don try validate your setup plenty times and some checks still dey fail: " +
    "{reasons} Abeg contact support make dem help you finish onboarding.",
  repairWhatsapp:
    "I no fit reach your WhatsApp phone number with the token wey dey file. " +
    "Abeg paste your WhatsApp access token and phone number ID again from Meta Business Settings → WhatsApp → API Setup.",
  repairWaba:
    "Your WhatsApp token no fit read the WhatsApp Business Account (WABA) — " +
    "paste the token again from Meta Business Settings and make sure say e get the whatsapp_business_management permission.",
  repairIntegration:
    "The {provider} connection test fail. Abeg check the {provider} URL and API key " +
    "for Settings → Integrations (or paste dem here) and I go try again.",
  repairGeneric:
    "One validation check fail ({reason}). Abeg check the setting and I go run the checks again.",
  actionApprove: "Approve",
  actionEdit: "Edit",
  actionReject: "Reject",
  appliedSummary: "Applied: {summary}",
  pushOk: "WhatsApp profile don update ({pushed}).",
  pushFail: "I no fit update the WhatsApp profile: {failed}.",
  summaryWaMenu: "WhatsApp menu (template): greeting + top use cases",
  summaryUseCases: "Use cases wey I suggest: {list}",
  summaryIntegrations: "Integrations wey I suggest: {list}",
  summaryWaMenuRevised: "WhatsApp menu (revised): greeting + top use cases",
  summaryUseCasesRevised: "Use cases wey I suggest (revised): {list}",
  summaryIntegrationsRevised: "Integrations wey I suggest (revised): {list}",
  languageSwitched: "No wahala — I go continue for {language}.",
};

export const COPILOT_TEXT_PACKS: Record<CopilotLanguage, CopilotTextPack> = {
  en, fr, ha, yo, ig, pcm,
};

/** Render one copilot string in `lang`, falling back to English. */
export function t(
  lang: CopilotLanguage | string | null | undefined,
  key: keyof CopilotTextPack,
  params?: Record<string, string | number>,
): string {
  const pack = COPILOT_TEXT_PACKS[isCopilotLanguage(lang) ? lang : DEFAULT_COPILOT_LANGUAGE];
  let s = pack[key] ?? en[key];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

// ─── Heuristic detection ─────────────────────────────────────────────────────

/**
 * Stopword lists per language (fr/ha/yo/ig mirror i18n.ts; pcm is new).
 * Multi-word entries score double. Pidgin shares vocabulary with Nigerian
 * English, so its list skews to high-precision function words ("dey",
 * "wetin", "abeg", …).
 */
const COPILOT_STOPWORDS: Record<Exclude<CopilotLanguage, "en">, string[]> = {
  fr: [
    "bonjour", "merci", "commande", "livraison", "combien", "voulez", "s'il",
    "svp", "panier", "prix", "acheter", "bonsoir", "monsieur", "madame",
    "beaucoup", "maintenant", "adresse", "payer", "oui", "non",
  ],
  ha: [
    "sannu", "barka", "nawa", "kudin", "kada", "don", "yaya", "zaka", "nake",
    "madalla", "kwando", "oda", "sayayya", "taimako", "ina son", "don allah",
    "muna", "za mu", "gode", "eh", "a'a", "yanzu", "kake", "kasuwanci",
    "na gode", "zaka iya", "faɗa", "don ka",
  ],
  yo: [
    "bawo", "jowo", "pupo", "kini", "ese", "nko", "wọle", "ẹ", "ṣe", "owo",
    "ọjà", "káàbọ̀", "e kaabo", "mo fe", "mo fẹ́", "elo", "se o", "tọpa",
    "àṣẹ", "bẹẹni", "rara", "nje", "ṣeun", "tẹ", "fun mi", "sọ fun mi",
    "iṣowo", "owo mi",
  ],
  ig: [
    "kedu", "biko", "ndewo", "ego", "ole", "chukwu", "anyi", "ahia", "ngọdo",
    "ihe", "nke", "daalụ", "nnọọ", "gị", "zụta", "zipu", "mba", "chọrọ",
    "ka m", "gwa m", "otu", "oge",
  ],
  pcm: [
    "abeg", "how far", "dey", "wetin", "wahala", "oga", "sabi", "comot",
    "waka", "chop", "una", "make i", "no dey", "e dey", "na me",
    "i don", "e don", "we don", "dem don", "you don",
    "no wahala", "sha", "wey", "wan", "fit", "dey sell", "na so", "yarn",
    "padi", "sef", "tori",
  ],
};

/** Diacritic bonuses: [regex, language, points] — mirrors i18n.ts. */
const COPILOT_CHAR_HINTS: Array<[RegExp, CopilotLanguage, number]> = [
  [/ṣ/i, "yo", 3],
  [/[ịụñ]/i, "ig", 3],
  [/[ẹọ]/i, "yo", 1.5],
  [/[ẹọ]/i, "ig", 1],
  [/[éèêçà]/i, "fr", 1],
];

/** Minimum score to treat a detection as high-confidence. */
export const DETECTION_CONFIDENCE_THRESHOLD = 1.5;

export interface LanguageDetection {
  language: CopilotLanguage;
  /** "high" = at least one real signal at/above threshold; else "low". */
  confidence: "high" | "low";
  score: number;
}

/**
 * Heuristic language detection from free onboarding text. Returns en/low when
 * nothing scores — the caller treats that as "stay in the current language"
 * (Nigerian English shares vocabulary with all four local languages).
 */
export function detectMessageLanguage(text: string): LanguageDetection {
  const lower = (text ?? "").toLowerCase();
  const scores: Record<CopilotLanguage, number> = { en: 0, fr: 0, ha: 0, yo: 0, ig: 0, pcm: 0 };
  if (lower.trim()) {
    for (const [lang, words] of Object.entries(COPILOT_STOPWORDS) as Array<
      [Exclude<CopilotLanguage, "en">, string[]]
    >) {
      for (const w of words) {
        // Apostrophe is NOT a boundary on the right — keeps pcm "i don"/"you don"
        // from matching English "I don't"/"you don't".
        const re = new RegExp(`(^|[^a-zà-ỹ'])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-zà-ỹ']|$)`, "i");
        if (re.test(lower)) scores[lang] += w.includes(" ") ? 2 : 1.5;
      }
    }
    for (const [re, lang, pts] of COPILOT_CHAR_HINTS) {
      if (re.test(lower)) scores[lang] += pts;
    }
  }
  let best: CopilotLanguage = DEFAULT_COPILOT_LANGUAGE;
  let bestScore = 0;
  for (const lang of COPILOT_LANGUAGES) {
    if (scores[lang] > bestScore) {
      bestScore = scores[lang];
      best = lang;
    }
  }
  if (bestScore >= DETECTION_CONFIDENCE_THRESHOLD) {
    return { language: best, confidence: "high", score: bestScore };
  }
  return { language: DEFAULT_COPILOT_LANGUAGE, confidence: "low", score: bestScore };
}

// ─── Explicit language choice ────────────────────────────────────────────────

/**
 * Aliases: language names in English plus common self-names / misspellings.
 * Longer aliases first so "nigerian pidgin" wins over "pidgin".
 */
// W15.1 bugfix: \b is ASCII-only in JS regex, so diacritic aliases like
// "yorùbá" never matched ("ka sọ̀rọ̀ ní yorùbá" — the docblock example —
// silently failed). Use Unicode-aware boundaries instead.
const WB_L = "(?<![a-zà-ỹ])";
const WB_R = "(?![a-zà-ỹ])";
const LANGUAGE_ALIASES: Array<[RegExp, CopilotLanguage]> = [
  [new RegExp(`${WB_L}(?:hausa|harshen hausa|bahaushe)${WB_R}`, "i"), "ha"],
  [new RegExp(`${WB_L}(?:yoruba|yorùbá|ede yoruba)${WB_R}`, "i"), "yo"],
  [new RegExp(`${WB_L}(?:igbo|asusu igbo|ndigbo)${WB_R}`, "i"), "ig"],
  [new RegExp(`${WB_L}(?:nigerian pidgin|pidgin|najia pidgin|naija(?: pidgin)?|broken(?: english)?|pcm)${WB_R}`, "i"), "pcm"],
  [new RegExp(`${WB_L}(?:french|français|francais)${WB_R}`, "i"), "fr"],
  [new RegExp(`${WB_L}english${WB_R}`, "i"), "en"],
];

const EXPLICIT_VERB_RE =
  /(?:speak|talk|use|reply|respond|answer|continue|switch|change|write).{0,20}?\b(?:in|to|with)?\s*$/i;

/**
 * Parse an EXPLICIT language request from a message:
 *   "speak Yoruba", "please reply in Hausa", "switch to pidgin",
 *   "use French please", "yi hausa", "ka sọ̀rọ̀ ní yorùbá" …
 * Also matches a bare trailing alias ("Hausa please", "yoruba?").
 * Returns null when no explicit choice is present.
 */
export function parseExplicitLanguageChoice(text: string): CopilotLanguage | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const [aliasRe, lang] of LANGUAGE_ALIASES) {
    const m = lower.match(new RegExp(`${aliasRe.source}`, "i"));
    if (!m) continue;
    const before = lower.slice(0, m.index);
    const after = lower.slice((m.index ?? 0) + m[0].length);
    // Case 1: verb phrase immediately before the alias ("speak …", "reply in …").
    if (EXPLICIT_VERB_RE.test(before)) return lang;
    // Case 2: alias at the very start followed by a request-ish tail
    // ("yoruba please", "pidgin abeg").
    if (m.index === 0 && /^[\s,.!]*(?:please|pls|abeg|jowo|jọ̀wọ́|biko|don allah|nagode)?[\s,.!?]*$/.test(after)) {
      return lang;
    }
    // Case 3: trailing alias preceded by "in"/"to"/"with"/"ní"/"na"
    // ("ka sọ̀rọ̀ ní yorùbá", "yi hausa").
    if (/\b(?:in|to|with|ní|ni|na|ta)\s*$/.test(before)) return lang;
    // Case 4: whole message is just the language name ("Hausa", "pidgin?").
    if (/^[\s,.!?]*$/.test(before) && /^[\s,.!?]*$/.test(after)) return lang;
  }
  return null;
}

// ─── Session-level resolution ────────────────────────────────────────────────

interface LanguageCarrier {
  intake: { language?: unknown; [k: string]: unknown };
}

/**
 * Resolve the copilot language for one inbound message and persist the outcome
 * on the session intake jsonb:
 *   explicit choice > high-confidence detection (switch) > current (sticky) > en.
 * Returns { language, switched } — `switched` is true when this message
 * CHANGED the stored preference (so callers can optionally acknowledge).
 */
export function resolveTurnLanguage(
  session: LanguageCarrier,
  text: string,
): { language: CopilotLanguage; switched: boolean; explicit: boolean } {
  const current = isCopilotLanguage(session.intake.language)
    ? session.intake.language
    : DEFAULT_COPILOT_LANGUAGE;

  const explicit = parseExplicitLanguageChoice(text);
  if (explicit) {
    session.intake.language = explicit;
    return { language: explicit, switched: explicit !== current, explicit: true };
  }

  const det = detectMessageLanguage(text);
  if (det.confidence === "high" && det.language !== current) {
    session.intake.language = det.language;
    return { language: det.language, switched: true, explicit: false };
  }
  return { language: current, switched: false, explicit: false };
}

/** Read the persisted session language (defaults to en). */
export function sessionLanguage(session: LanguageCarrier): CopilotLanguage {
  return isCopilotLanguage(session.intake.language)
    ? session.intake.language
    : DEFAULT_COPILOT_LANGUAGE;
}
