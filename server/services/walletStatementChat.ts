// === W58 statements ===
/**
 * walletStatementChat.ts — merchant "statement" keyword, WA+TG parity
 * (deterministic, never LLM):
 *
 *   "STATEMENT"            → previous-month wallet statement, generated on
 *                            demand and delivered as a PDF chat document.
 *   "STATEMENT <month>"    → a specific month ("2025-08" or an English month
 *                            name, optionally with a year: "august 2025").
 *
 * Authz: admin-phone only (resolveAdminPhone — the SAME seam as the W27
 * creditWhatsApp / W56 credit-intelligence merchant commands). Non-admins
 * get handled=false (silent fall-through — keyword probing by buyers must
 * not leak wallet data). TG identity resolves to the linked E.164 phone
 * upstream (telegramInbound W55 parity seam).
 */
import { eq } from "drizzle-orm";
import { merchantWallets, tenants } from "../../drizzle/schema";
import { resolveAdminPhone } from "./creditWhatsApp";
import { t27, resolveLocale, type Locale } from "./i18n";

type Db = any;

export interface StatementChatOutcome {
  handled: boolean;
  reply?: string;
}

function normPhone(p: string): string {
  return p.replace(/[^\d]/g, "").replace(/^0+/, "");
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

export type StatementCommand =
  | { cmd: "statement"; month: null }
  | { cmd: "statement"; month: { y: number; m: number } }
  | { cmd: "badMonth" };

/** Deterministic parse. Returns null for anything else (falls through). */
export function parseStatementCommand(text: string): StatementCommand | null {
  const t = text.trim();
  let m = t.match(/^STATEMENT\s*$/i);
  if (m) return { cmd: "statement", month: null };
  m = t.match(/^STATEMENT\s+(\d{4})-(\d{1,2})\s*$/i);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    return mo >= 0 && mo <= 11 ? { cmd: "statement", month: { y, m: mo } } : { cmd: "badMonth" };
  }
  m = t.match(/^STATEMENT\s+([A-Za-z]+)(?:\s+(\d{4}))?\s*$/i);
  if (m) {
    const mo = MONTHS[m[1]!.toLowerCase()];
    if (mo === undefined) return { cmd: "badMonth" };
    const y = m[2] ? Number(m[2]) : new Date().getUTCFullYear();
    return { cmd: "statement", month: { y, m: mo } };
  }
  m = t.match(/^STATEMENT\s+(\S+)\s*$/i);
  if (m) return { cmd: "badMonth" };
  return null;
}

/**
 * Handle one inbound statement command. Admin-phone authz inside; the PDF
 * document is delivered via walletStatements.deliverWalletStatement (WA
 * document push / telegram sendDocument through channelParity).
 */
export async function handleStatementCommand(opts: {
  db: Db;
  tenantId: string;
  fromPhone: string;
  text: string;
  channel: "whatsapp" | "telegram";
  locale?: Locale;
}): Promise<StatementChatOutcome> {
  const parsed = parseStatementCommand(opts.text);
  if (!parsed) return { handled: false };

  const [tenant] = await opts.db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, opts.tenantId))
    .limit(1);
  const settings = (tenant?.settings ?? null) as Record<string, unknown> | null;
  const adminPhone = resolveAdminPhone(settings);
  if (!adminPhone || normPhone(adminPhone) !== normPhone(opts.fromPhone)) {
    return { handled: false }; // not the merchant — silent fall-through
  }

  const locale = opts.locale
    ?? (await resolveLocale({ tenantId: opts.tenantId, phone: opts.fromPhone, text: opts.text }).catch(() => "en" as Locale));

  if (parsed.cmd === "badMonth") {
    return { handled: true, reply: t27(locale, "walletStatementBadMonth") };
  }

  const [wallet] = await opts.db.select({ id: merchantWallets.id, currency: merchantWallets.currency })
    .from(merchantWallets)
    .where(eq(merchantWallets.tenantId, opts.tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  if (!wallet) {
    return { handled: true, reply: t27(locale, "walletStatementNoWallet") };
  }

  const { generateWalletStatement, deliverWalletStatement, previousMonthPeriod } = await import("./walletStatements");
  const period = parsed.month
    ? { from: new Date(Date.UTC(parsed.month.y, parsed.month.m, 1)), to: new Date(Date.UTC(parsed.month.y, parsed.month.m + 1, 1)) }
    : previousMonthPeriod(new Date());
  const periodLabel = `${period.from.toISOString().slice(0, 10)} .. ${period.to.toISOString().slice(0, 10)}`;

  try {
    const { record } = await generateWalletStatement(opts.db, { tenantId: opts.tenantId, from: period.from, to: period.to });
    const fmt = (cents: number) => `${wallet.currency} ${(cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
    // Delivery is best-effort: the text reply still lands even if the
    // document push fails (fail-open notify doctrine).
    await deliverWalletStatement(opts.db, { tenantId: opts.tenantId, statementId: record.id, phone: opts.fromPhone })
      .catch((e: any) => console.warn("[wallet-statement] chat delivery failed (fail-open):", e?.message));
    return {
      handled: true,
      reply: t27(locale, "walletStatementReady", {
        period: periodLabel,
        opening: fmt(record.openingCents),
        closing: fmt(record.closingCents),
      }),
    };
  } catch (e: any) {
    console.error("[wallet-statement] generation failed (fail-open):", e?.message);
    return { handled: true, reply: t27(locale, "walletStatementFailed") };
  }
}
// === END W58 statements ===
