// === W56 credit ===
/**
 * W56 credit intelligence chat — merchant credit-score + bureau keywords,
 * WA+TG parity (deterministic, never LLM):
 *
 *   "CREDIT SCORE <phone/customer>"  → buyer's internal score + grade
 *                                      (admin-phone authz — same resolution
 *                                      as creditWhatsApp/chatDispute).
 *   "BUREAU CHECK <phone/customer>"  → consent-first flow: shows the
 *                                      localized BUREAU_CONSENT_TEXT and
 *                                      asks for BUREAU CONFIRM; NEVER
 *                                      auto-pulls.
 *   "BUREAU CONFIRM <phone/customer>" → records the consent artefact
 *                                      (channel-stamped) and pulls the
 *                                      report via services/bureau.ts
 *                                      (fail-open on provider outage).
 *
 * Bare "CREDIT" / "CREDIT SCORE" (no argument) stays with the W27
 * creditWhatsApp merchant-score handler — this module only takes over when
 * a subject argument is present. Identity: TG chats resolve to the linked
 * E.164 phone upstream (telegramInbound W55 parity seam).
 */
import { eq } from "drizzle-orm";
import { tenants } from "../../drizzle/schema";
import { resolveAdminPhone } from "./creditWhatsApp";
import {
  computeAndStoreSubjectScore,
  gradeForScore,
  resolveBuyerSubject,
} from "./creditScoring";
import {
  getLiveBureauConsent,
  pullCreditReport,
  recordBureauConsent,
} from "./bureau";
import { t27, resolveLocale, type Locale } from "./i18n";
import type { DbHandle } from "./tradeCredit/accounts";

export interface CreditIntelOutcome {
  handled: boolean;
  reply?: string;
}

function normPhone(p: string): string {
  return p.replace(/[^\d]/g, "").replace(/^0+/, "");
}

export type CreditIntelCommand =
  | { cmd: "buyerScore"; ref: string }
  | { cmd: "bureauCheck"; ref: string }
  | { cmd: "bureauConfirm"; ref: string };

/**
 * Deterministic keyword parse. Returns null for anything else (falls
 * through to the normal menu/NLP pipeline). "CREDIT SCORE <ref>" requires
 * a non-numeric-only OR phone-length argument so bare W27 commands are
 * untouched.
 */
export function parseCreditIntelCommand(text: string): CreditIntelCommand | null {
  const t = text.trim();
  let m = t.match(/^CREDIT\s+SCORE\s+(\S+)\s*$/i);
  if (m) {
    const ref = m[1];
    // Bare amounts (e.g. "CREDIT ACCEPT 500") are W27's — a score subject is
    // a phone (7+ digits) or any non-numeric ref.
    if (!/^\d{1,6}(\.\d{1,2})?$/.test(ref)) return { cmd: "buyerScore", ref };
    return null;
  }
  m = t.match(/^BUREAU\s+CHECK\s+(\S+)\s*$/i);
  if (m) return { cmd: "bureauCheck", ref: m[1] };
  m = t.match(/^BUREAU\s+CONFIRM\s+(\S+)\s*$/i);
  if (m) return { cmd: "bureauConfirm", ref: m[1] };
  return null;
}

async function isAdmin(
  db: DbHandle, tenantId: string, fromPhone: string,
): Promise<{ admin: boolean; settings: Record<string, unknown> | null }> {
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const settings = (tenant?.settings ?? null) as Record<string, unknown> | null;
  const adminPhone = resolveAdminPhone(settings);
  return { admin: !!adminPhone && normPhone(adminPhone) === normPhone(fromPhone), settings };
}

/**
 * Handle one inbound credit-intelligence command. `channel` stamps the
 * consent artefact ('whatsapp' | 'telegram'). Admin-phone authz: non-admin
 * senders get handled=false (fall through silently — keyword probing by
 * buyers must not leak credit data).
 */
export async function handleCreditIntelCommand(opts: {
  db: DbHandle;
  tenantId: string;
  fromPhone: string;
  text: string;
  channel: "whatsapp" | "telegram";
  locale?: Locale;
}): Promise<CreditIntelOutcome> {
  const parsed = parseCreditIntelCommand(opts.text);
  if (!parsed) return { handled: false };

  const { admin, settings } = await isAdmin(opts.db, opts.tenantId, opts.fromPhone);
  if (!admin) return { handled: false };

  const locale = opts.locale
    ?? (await resolveLocale({ tenantId: opts.tenantId, phone: opts.fromPhone, text: opts.text }).catch(() => "en" as Locale));

  // Resolve the subject ref → buyer customer row.
  const buyer = await resolveBuyerSubject(opts.db, opts.tenantId, parsed.ref);
  if (!buyer) {
    return { handled: true, reply: t27(locale, "creditScoreNotFound", { ref: parsed.ref }) };
  }
  const subjectLabel = buyer.phone;

  if (parsed.cmd === "buyerScore") {
    const r = await computeAndStoreSubjectScore(opts.db, opts.tenantId, "buyer", buyer.id);
    if (!r) return { handled: true, reply: t27(locale, "creditScoreNotFound", { ref: parsed.ref }) };
    return {
      handled: true,
      reply: t27(locale, "creditScoreLine", { subject: subjectLabel, score: r.score, grade: r.grade ?? gradeForScore(r.score) }),
    };
  }

  if (parsed.cmd === "bureauCheck") {
    const live = await getLiveBureauConsent(opts.db, opts.tenantId, "buyer", buyer.id);
    if (live) {
      // Consent already on file — pull straight away (consent-first honored).
      const outcome = await pullCreditReport(opts.db, {
        tenantId: opts.tenantId,
        subject: { subjectType: "buyer", subjectId: buyer.id, phone: buyer.phone },
        tenantSettings: settings,
      });
      if (!outcome.ok || !outcome.report) {
        return { handled: true, reply: t27(locale, "bureauPullFailed", { subject: subjectLabel }) };
      }
      return {
        handled: true,
        reply: t27(locale, "bureauPullSummary", {
          provider: outcome.provider,
          subject: subjectLabel,
          score: outcome.report.score ?? "—",
          facilities: outcome.report.totalFacilities,
          defaults: outcome.report.activeDefaults,
          ref: outcome.report.rawRef,
        }),
      };
    }
    // No consent yet — show the consent text; NEVER auto-pull.
    const { BUREAU_CONSENT_TEXT } = await import("./i18n");
    return {
      handled: true,
      reply: t27(locale, "bureauConsentPrompt", {
        subject: subjectLabel,
        consentText: BUREAU_CONSENT_TEXT[locale] ?? BUREAU_CONSENT_TEXT.en,
        ref: parsed.ref,
      }),
    };
  }

  // bureauConfirm — record the artefact (BEFORE the pull) then pull.
  await recordBureauConsent(opts.db, {
    tenantId: opts.tenantId,
    subjectType: "buyer",
    subjectId: buyer.id,
    channel: opts.channel,
    locale,
  });
  const outcome = await pullCreditReport(opts.db, {
    tenantId: opts.tenantId,
    subject: { subjectType: "buyer", subjectId: buyer.id, phone: buyer.phone },
    tenantSettings: settings,
  });
  if (!outcome.ok || !outcome.report) {
    return { handled: true, reply: t27(locale, "bureauPullFailed", { subject: subjectLabel }) };
  }
  return {
    handled: true,
    reply: t27(locale, "bureauPullSummary", {
      provider: outcome.provider,
      subject: subjectLabel,
      score: outcome.report.score ?? "—",
      facilities: outcome.report.totalFacilities,
      defaults: outcome.report.activeDefaults,
      ref: outcome.report.rawRef,
    }),
  };
}
