/**
 * W16 template pre-approval library (roadmap F9).
 *
 * A curated, Meta-policy-compliant library of per-use-case message templates
 * that a tenant can submit to their WABA for pre-approval in one click after
 * embedded signup. Each template ships with bodies in English plus the four
 * most-used Nigerian languages/pidgin: Hausa (ha), Yoruba (yo), Igbo (ig)
 * and Nigerian Pidgin (pcm).
 *
 * Copy rules enforced by validateLibrary():
 *   - every key has a body for every supported locale;
 *   - placeholders are positional {{1}}..{{n}}, contiguous, and match the
 *     declared `variables` list exactly;
 *   - category is UTILITY or MARKETING (Meta rejects AUTHENTICATION bodies
 *     from arbitrary senders);
 *   - MARKETING templates include opt-out language; UTILITY templates must
 *     NOT read like promotions (checked loosely: no promo keywords);
 *   - `name` is Meta-safe (lowercase letters, digits, underscores, ≤512).
 */

export const WA_TEMPLATE_LOCALES = ["en", "ha", "yo", "ig", "pcm"] as const;
export type WaTemplateLocale = (typeof WA_TEMPLATE_LOCALES)[number];

export type WaTemplateCategory = "UTILITY" | "MARKETING";

export interface WaTemplateLibraryEntry {
  /** Stable library key referenced by submitTemplate. */
  key: string;
  /** Meta-safe template name submitted to the WABA. */
  name: string;
  category: WaTemplateCategory;
  /** Human description of the use case (operator-facing). */
  useCase: string;
  /** Positional variable names, in {{1}}..{{n}} order. */
  variables: string[];
  /** Body text per locale; placeholders must match `variables`. */
  bodies: Record<WaTemplateLocale, string>;
}

export const WA_TEMPLATE_LIBRARY: readonly WaTemplateLibraryEntry[] = [
  {
    key: "order_confirmation",
    name: "w16_order_confirmation",
    category: "UTILITY",
    useCase: "Confirm a placed order with id and total.",
    variables: ["customerName", "orderId", "total"],
    bodies: {
      en: "Hello {{1}}, your order {{2}} totalling {{3}} has been received. We will update you as it progresses. Thank you for shopping with us.",
      ha: "Sannu {{1}}, an karɓi odar ku {{2}} mai jimlar {{3}}. Za mu sanar da ku ci gaban ta. Mun gode da sayayya da mu.",
      yo: "Pẹlẹ o {{1}}, a ti gba ibere rẹ {{2}} ti o jẹ {{3}} lapapọ. A ma sọ ipo rẹ fun ọ nigbagbogbo. Ẹ seun fun rira lọdọ wa.",
      ig: "Ndewo {{1}}, anyị enwetala order gị {{2}} nke mkpokọta ya bụ {{3}}. Anyị ga-agwa gị ọganihu ya. Daalụ n'ịzụ ahịa na anyị.",
      pcm: "Hello {{1}}, we don receive your order {{2}} wey total na {{3}}. We go dey update you as e dey go. Thank you for shopping with us.",
    },
  },
  {
    key: "payment_reminder",
    name: "w16_payment_reminder",
    category: "UTILITY",
    useCase: "Remind a customer of an outstanding payment and due date.",
    variables: ["customerName", "amount", "dueDate"],
    bodies: {
      en: "Hello {{1}}, this is a friendly reminder that your payment of {{2}} is due on {{3}}. Please pay before the due date to avoid service interruption.",
      ha: "Sannu {{1}}, muna tunatar da ku cewa biyan kuɗin ku na {{2}} ya cika ranar {{3}}. Don Allah ku biya kafin ranar domin guje wa katse sabis.",
      yo: "Pẹlẹ o {{1}}, a fẹ ran ọ lẹti pe gbese rẹ ti {{2}} yoo de okeerun ni ọjọ {{3}}. Jọwọ sanwó kí ọjọ náà tó dé láti yẹ fún idiwọ iṣẹ.",
      ig: "Ndewo {{1}}, anyị na-echeta gị na ụgwọ gị nke {{2}} ga-eru ruo ụbọchị {{3}}. Biko kwụọ tupu ụbọchị ahụ ka ọ bụghị nkwụsị ọrụ.",
      pcm: "Hello {{1}}, na reminder say your payment of {{2}} go reach on {{3}}. Abeg pay before that day make dem no stop your service.",
    },
  },
  {
    key: "delivery_update",
    name: "w16_delivery_update",
    category: "UTILITY",
    useCase: "Notify a customer about the delivery status of an order.",
    variables: ["customerName", "orderId", "status"],
    bodies: {
      en: "Hello {{1}}, delivery update for your order {{2}}: {{3}}. We will let you know once it arrives.",
      ha: "Sannu {{1}}, labarin isar da odar ku {{2}}: {{3}}. Za mu sanar da ku da zarar ta iso.",
      yo: "Pẹlẹ o {{1}}, imudojuiwọn fifi-ránṣẹ fun ibere rẹ {{2}}: {{3}}. A o jọ ọ mọ ni kete nibọ.",
      ig: "Ndewo {{1}}, mmelite nnyefe maka order gị {{2}}: {{3}}. Anyị ga-ama gị ozugbo o ruru.",
      pcm: "Hello {{1}}, delivery update for your order {{2}}: {{3}}. We go tell you once e don land.",
    },
  },
  {
    key: "credit_repayment_reminder",
    name: "w16_credit_repayment",
    category: "UTILITY",
    useCase: "Remind a trade-credit customer of an upcoming repayment.",
    variables: ["customerName", "amount", "dueDate"],
    bodies: {
      en: "Hello {{1}}, your credit repayment of {{2}} is due on {{3}}. Kindly repay on time to keep your credit line in good standing.",
      ha: "Sannu {{1}}, biyan bashin ku na {{2}} ya cika ranar {{3}}. Don Allah ku biya a lokaci domin ci gaba da samun bashi.",
      yo: "Pẹlẹ o {{1}}, isanpadà gbese rẹ ti {{2}} yoo de okeerun ni ọjọ {{3}}. Jọwọ san pada lọjọ ṣetìlẹ́yìn lati jẹ́ kí ila gbese rẹ dúró ṣinṣin.",
      ig: "Ndewo {{1}}, ịkwụ ụgwọ akwụmụgwọ gị nke {{2}} ga-eru ụbọchị {{3}}. Biko kwụọ n'oge ka ị nọgide na-enweta akwụmụgwọ.",
      pcm: "Hello {{1}}, your credit payback of {{2}} dey due on {{3}}. Abeg pay on time so your credit line go still dey ok.",
    },
  },
  {
    key: "payment_received",
    name: "w16_payment_received",
    category: "UTILITY",
    useCase: "Acknowledge receipt of a customer payment with reference.",
    variables: ["customerName", "amount", "receiptRef"],
    bodies: {
      en: "Hello {{1}}, we have received your payment of {{2}}. Your receipt reference is {{3}}. Thank you.",
      ha: "Sannu {{1}}, mun karɓi biyan kuɗin ku na {{2}}. Lambar rasit ku ita ce {{3}}. Mun gode.",
      yo: "Pẹlẹ o {{1}}, a ti gba isanwó rẹ ti {{2}}. Amoye irísíì rẹ ni {{3}}. Ẹ seun.",
      ig: "Ndewo {{1}}, anyị enwetala ụgwọ gị nke {{2}}. Ntugharị ọnụọgụ nnata gị bụ {{3}}. Daalụ.",
      pcm: "Hello {{1}}, we don receive your payment of {{2}}. Your receipt number na {{3}}. Thank you.",
    },
  },
  {
    key: "order_shipped",
    name: "w16_order_shipped",
    category: "UTILITY",
    useCase: "Tell a customer their order has shipped with the courier name.",
    variables: ["customerName", "orderId", "courier"],
    bodies: {
      en: "Hello {{1}}, good news — your order {{2}} has shipped via {{3}}. We will share the delivery status shortly.",
      ha: "Sannu {{1}}, bishara — an aika odar ku {{2}} ta hanyar {{3}}. Za mu aiko muku da labarin isarwa nan ba da jimawa ba.",
      yo: "Pẹlẹ o {{1}}, iroyin to dara — a ti rán ibere rẹ {{2}} lọ nipasẹ {{3}}. A o sọ ipo ifijiṣẹ fun ọ laipẹ yii.",
      ig: "Ndewo {{1}}, ozi ọma — e zigala order gị {{2}} site na {{3}}. Anyị ga-agwa gị ọnọdụ nnyefe ya n'oge na-adịghị anya.",
      pcm: "Hello {{1}}, good news — your order {{2}} don ship through {{3}}. We go share the delivery status with you soon.",
    },
  },
  {
    key: "broadcast_opt_in",
    name: "w16_broadcast_opt_in",
    category: "MARKETING",
    useCase: "Invite customers to receive occasional offers; includes opt-out.",
    variables: ["businessName"],
    bodies: {
      en: "Hello from {{1}}! Would you like to receive occasional offers and new-product news from us on WhatsApp? Reply YES to join or STOP at any time to opt out.",
      ha: "Sannu daga {{1}}! Shin kuna son samun tayi da labarai kan sababbin kayayyaki a WhatsApp? Amsa da EH don shiga ko STOP a kowane lokaci don ficewa.",
      yo: "Pẹlẹ o lọdọ {{1}}! Ṣe o fẹ gba awọn ìfilọlẹ ati iroyin ọja tuntun lọwọ wa lori WhatsApp? Dahun YES lati darapọ tabi STOP nigbakugba lati jade.",
      ig: "Ndewo si {{1}}! Ị chọrọ ịnata oge ufodi ọnụahịa pụrụ iche na ozi ngwaahịa ọhụrụ anyị na WhatsApp? Zaa YES ka ị sonye ma ọ bụ STOP oge ọ bụla ka ị pụọ.",
      pcm: "Hello from {{1}}! You wan dey receive better offers and new product gist from us for WhatsApp? Reply YES to join or STOP anytime to comot.",
    },
  },
  {
    key: "back_in_stock",
    name: "w16_back_in_stock",
    category: "MARKETING",
    useCase: "Tell an interested customer a product is available again.",
    variables: ["customerName", "productName"],
    bodies: {
      en: "Hello {{1}}, {{2}} is back in stock! Order now while quantities last. Reply STOP to opt out of these messages.",
      ha: "Sannu {{1}}, {{2}} ya dawo aji! Yi oda yanzu kafin ya ƙare. Amsa STOP don ficewa daga irin wannan sakon.",
      yo: "Pẹlẹ o {{1}}, {{2}} ti padà si ibi-ṣaja! Bere ni bayi kí ó tó tan. Dahun STOP lati jade kuro ninu awọn ifiranṣẹ wọnyi.",
      ig: "Ndewo {{1}}, {{2}} adịlarị ọzọ n'ụlọ ahịa! Nye order ugbu a tupu ọ gwụcha. Zaa STOP ka ị pụọ na ozi ndị a.",
      pcm: "Hello {{1}}, {{2}} don come back stock! Order now before e finish. Reply STOP to comot for this kind message.",
    },
  },
  {
    key: "weekly_promo",
    name: "w16_weekly_promo",
    category: "MARKETING",
    useCase: "Send a weekly promotion to opted-in customers.",
    variables: ["customerName", "offer"],
    bodies: {
      en: "Hello {{1}}, this week's offer just for you: {{2}}. Valid while stocks last. Reply STOP to opt out of promotions.",
      ha: "Sannu {{1}}, tayin mako na musamman a gare ku: {{2}}. Yana aiki yayin da kayan suka wuce. Amsa STOP don ficewa daga tallace-tallace.",
      yo: "Pẹlẹ o {{1}}, ìfilọlẹ ọsẹ yii fun ọ nikan: {{2}}. Ó wulo titi ọja yoo fi ṣáẹ́. Dahun STOP lati yọ kúrò nínú ìpolówó.",
      ig: "Ndewo {{1}}, onyinye izu a maka gị: {{2}}. Ọ dị irè ruo mgbe ngwaahịa dị. Zaa STOP ka ị pụọ na mgbasa ozi.",
      pcm: "Hello {{1}}, this week offer just for you: {{2}}. E dey valid while stock last. Reply STOP to comot for promo message.",
    },
  },
  {
    key: "welcome_message",
    name: "w16_welcome_message",
    category: "UTILITY",
    useCase: "Welcome a new customer and introduce the business.",
    variables: ["customerName", "businessName"],
    bodies: {
      en: "Welcome to {{2}}, {{1}}! We are glad to have you. Send us a message any time to browse products, place orders or ask questions.",
      ha: "Barka da zuwa {{2}}, {{1}}! Mun yarda da ku. Aiko mana da saƙo a kowane lokaci don duba kayayyaki, yi oda ko tambaya.",
      yo: "Kaabo si {{2}}, {{1}}! Inu wa dun lati ni ọ. Fi ifiranṣẹ ranṣẹ si wa nigbakugba lati wo awọn ọja, gbe ibere kale tabi beere ibeere.",
      ig: "Nnọọ na {{2}}, {{1}}! Anyị na-enwe obi ụtọ inwe gị. Zitere anyị ozi oge ọ bụla iji chọgharịa ngwaahịa, tinye order ma ọ bụ jụọ ajụjụ.",
      pcm: "Welcome to {{2}}, {{1}}! We happy to have you. Message us anytime to check products, place order or ask question.",
    },
  },
] as const;

const META_NAME_RE = /^[a-z0-9_]{1,512}$/;
const PROMO_HINT_RE = /\b(offer|promo|discount|sale|deal)\b/i;
const OPT_OUT_HINT_RE = /\b(stop|opt out|opt-out|comot|ficewa|jade|pụọ|jíbiti)\b/i;

export interface LibraryIssue {
  key: string;
  locale?: string;
  problem: string;
}

/** Ordered, deduped positional placeholders of a body. */
export function bodyParams(body: string): number[] {
  const seen = new Set<number>();
  for (const m of Array.from(body.matchAll(/\{\{(\d+)\}\}/g))) seen.add(Number(m[1]));
  return Array.from(seen).sort((a, b) => a - b);
}

/** Validate the whole library; returns [] when every entry is sound. */
export function validateLibrary(): LibraryIssue[] {
  const issues: LibraryIssue[] = [];
  for (const entry of WA_TEMPLATE_LIBRARY) {
    if (!META_NAME_RE.test(entry.name)) {
      issues.push({ key: entry.key, problem: `name "${entry.name}" is not Meta-safe` });
    }
    if (entry.category !== "UTILITY" && entry.category !== "MARKETING") {
      issues.push({ key: entry.key, problem: `bad category ${entry.category}` });
    }
    for (const locale of WA_TEMPLATE_LOCALES) {
      const body = entry.bodies[locale];
      if (!body || !body.trim()) {
        issues.push({ key: entry.key, locale, problem: "missing body" });
        continue;
      }
      const params = bodyParams(body);
      const contiguous = params.every((n, i) => n === i + 1);
      if (!contiguous || params.length !== entry.variables.length) {
        issues.push({
          key: entry.key,
          locale,
          problem: `placeholders [${params.join(",")}] do not match ${entry.variables.length} variables`,
        });
      }
      if (entry.category === "MARKETING" && !OPT_OUT_HINT_RE.test(body)) {
        issues.push({ key: entry.key, locale, problem: "MARKETING body lacks opt-out language" });
      }
      if (entry.category === "UTILITY" && PROMO_HINT_RE.test(body)) {
        issues.push({ key: entry.key, locale, problem: "UTILITY body reads like a promotion" });
      }
    }
  }
  return issues;
}

/** Look up a library entry by key (undefined when unknown). */
export function getLibraryEntry(key: string): WaTemplateLibraryEntry | undefined {
  return WA_TEMPLATE_LIBRARY.find((e) => e.key === key);
}
