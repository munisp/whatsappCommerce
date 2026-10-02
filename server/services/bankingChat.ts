// === W59 banking-pos ===
/**
 * bankingChat.ts — merchant banking keywords, WA+TG parity (deterministic,
 * never LLM), admin-phone authz (resolveAdminPhone — the SAME seam as the
 * W27/W56/W58 merchant commands; non-admins get handled=false silent
 * fall-through):
 *
 *   "BANK ACCOUNTS"                → verified payout accounts list
 *   "CASH IN <phone> <amount>"     → two-step CICO: parks a pending intent,
 *                                    replies with CICO-<ref>
 *   "CASH OUT <phone> <amount>"    → same, kind cash_out
 *   "CONFIRM CICO-<ref>"           → executes the parked CICO atomically
 *   "FLOAT"                        → agent float summary + low-float flag
 *   "PAY BY POS <amount>"          → creates a ussd_ref POS session, replies
 *                                    with the 6-digit short code + reference
 *
 * Amounts are typed in NAIRA (major units) — converted to integer cents at
 * the boundary. Money movement goes through services/agentBanking.ts /
 * services/posPayments.ts (claim-first, idempotent).
 */
import { eq } from "drizzle-orm";
import { tenants } from "../../drizzle/schema";
import { resolveAdminPhone } from "./creditWhatsApp";
import { t27, resolveLocale, type Locale } from "./i18n";

type Db = any;

export interface BankingChatOutcome {
  handled: boolean;
  reply?: string;
}

function normPhone(p: string): string {
  return p.replace(/[^\d]/g, "").replace(/^0+/, "");
}

export type BankingCommand =
  | { cmd: "bankAccounts" }
  | { cmd: "cico"; kind: "cash_in" | "cash_out"; phone: string; amountMajor: number }
  | { cmd: "confirmCico"; reference: string }
  | { cmd: "float" }
  | { cmd: "payByPos"; amountMajor: number }
  | { cmd: "usage"; kind: "cico" | "pos" };

/** Deterministic parse. Returns null for anything else (falls through). */
export function parseBankingCommand(text: string): BankingCommand | null {
  const t = text.trim();
  if (/^BANK\s+ACCOUNTS?$/i.test(t)) return { cmd: "bankAccounts" };
  if (/^FLOAT$/i.test(t)) return { cmd: "float" };
  let m = t.match(/^CASH\s+(IN|OUT)\s+(\+?[\d\s-]{7,16})\s+(\d+(?:\.\d{1,2})?)$/i);
  if (m) {
    return {
      cmd: "cico",
      kind: m[1]!.toLowerCase() === "in" ? "cash_in" : "cash_out",
      phone: m[2]!.replace(/[\s-]/g, ""),
      amountMajor: parseFloat(m[3]!),
    };
  }
  if (/^CASH\s+(IN|OUT)\b/i.test(t)) return { cmd: "usage", kind: "cico" };
  m = t.match(/^CONFIRM\s+(CICO-[A-Za-z0-9-]{3,60})$/i);
  if (m) return { cmd: "confirmCico", reference: m[1]!.toUpperCase() };
  if (/^CONFIRM\b/i.test(t)) return { cmd: "usage", kind: "cico" };
  m = t.match(/^PAY\s+BY\s+POS\s+(\d+(?:\.\d{1,2})?)$/i);
  if (m) return { cmd: "payByPos", amountMajor: parseFloat(m[1]!) };
  if (/^PAY\s+BY\s+POS\b/i.test(t)) return { cmd: "usage", kind: "pos" };
  return null;
}

/** Pending two-step CICO intents, keyed by CICO-<ref> (tenant-qualified). */
interface PendingCico {
  tenantId: string;
  kind: "cash_in" | "cash_out";
  phone: string;
  amountCents: number;
  createdAt: number;
}
const PENDING_TTL_MS = 10 * 60 * 1000;

// === W60 persistence ===
// W60-A CRITICAL #1: the in-proc pendingCico Map is gone — intents live in
// the pending_cico_intents table (migration 0180). parkCico inserts
// idempotently (ON CONFLICT DO NOTHING); takeCico claims atomically via
// DELETE ... WHERE key AND "expiresAt" > now() RETURNING * so a CONFIRM
// executes exactly once, survives restarts, and is multi-instance safe.
import { sql, and, gt } from "drizzle-orm";
import { pendingCicoIntents } from "../../drizzle/schema";

async function parkCico(db: Db, intent: PendingCico, agentIdentity?: string | null): Promise<string> {
  // Lazy sweep of expired intents on insert.
  await db.execute(sql`DELETE FROM pending_cico_intents WHERE "expiresAt" <= now()`).catch(() => {});
  const ref = `CICO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const key = `${intent.tenantId}:${ref}`;
  await db
    .insert(pendingCicoIntents)
    .values({
      key,
      tenantId: intent.tenantId,
      agentIdentity: agentIdentity ?? null,
      kind: intent.kind,
      phone: intent.phone,
      amountCents: intent.amountCents,
      payload: null,
      expiresAt: new Date(intent.createdAt + PENDING_TTL_MS),
      createdAt: new Date(intent.createdAt),
    })
    .onConflictDoNothing();
  return ref;
}

async function takeCico(db: Db, tenantId: string, reference: string): Promise<PendingCico | null> {
  const key = `${tenantId}:${reference.toUpperCase()}`;
  // Atomic exactly-once claim: single-statement DELETE … RETURNING.
  const rows = await db
    .delete(pendingCicoIntents)
    .where(and(eq(pendingCicoIntents.key, key), gt(pendingCicoIntents.expiresAt, new Date())))
    .returning();
  const row = rows?.[0];
  if (!row) return null;
  return {
    tenantId: row.tenantId,
    kind: row.kind as "cash_in" | "cash_out",
    phone: row.phone,
    amountCents: Number(row.amountCents),
    createdAt: new Date(row.createdAt).getTime(),
  };
}
// === END W60 persistence ===

const fmt = (cents: number) => `NGN ${(cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

export async function handleBankingCommand(opts: {
  db: Db;
  tenantId: string;
  fromPhone: string;
  text: string;
  channel: "whatsapp" | "telegram";
  locale?: Locale;
}): Promise<BankingChatOutcome> {
  const parsed = parseBankingCommand(opts.text);
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

  try {
    switch (parsed.cmd) {
      case "bankAccounts": {
        const { backfillLegacyPayoutAccount, listPayoutAccounts } = await import("./payoutAccounts");
        await backfillLegacyPayoutAccount(opts.db, opts.tenantId);
        const accounts = await listPayoutAccounts(opts.db, opts.tenantId);
        const active = accounts.filter((a: any) => a.status === "active");
        if (active.length === 0) return { handled: true, reply: t27(locale, "bankAccountsNone") };
        const lines = active.map((a: any) =>
          t27(locale, "bankAccountLine", {
            primary: a.isPrimary ? "★" : "•",
            label: a.label ?? a.provider,
            number: `…${String(a.accountNumber).slice(-4)}`,
            name: a.accountName,
          }));
        return { handled: true, reply: `${t27(locale, "bankAccountsHeader")}\n${lines.join("\n")}` };
      }

      case "cico": {
        const { assertAgentBankingEnabled } = await import("./agentBanking");
        await assertAgentBankingEnabled(opts.db, opts.tenantId);
        const amountCents = Math.round(parsed.amountMajor * 100);
        if (!Number.isInteger(amountCents) || amountCents <= 0) {
          return { handled: true, reply: t27(locale, "cicoUsage") };
        }
        const ref = await parkCico(opts.db, { tenantId: opts.tenantId, kind: parsed.kind, phone: parsed.phone, amountCents, createdAt: Date.now() }, opts.fromPhone);
        return { handled: true, reply: t27(locale, "cicoStarted", { ref, amount: fmt(amountCents), phone: parsed.phone }) };
      }

      case "confirmCico": {
        const { assertAgentBankingEnabled, executeCico } = await import("./agentBanking");
        await assertAgentBankingEnabled(opts.db, opts.tenantId);
        const intent = await takeCico(opts.db, opts.tenantId, parsed.reference);
        if (!intent) return { handled: true, reply: t27(locale, "cicoNotFound") };
        try {
          const res = await executeCico(opts.db, {
            agentTenantId: intent.tenantId,
            customerPhone: intent.phone,
            kind: intent.kind,
            amountCents: intent.amountCents,
            clientRef: parsed.reference,
          });
          return {
            handled: true,
            reply: t27(locale, "cicoConfirmed", {
              ref: res.reference,
              amount: fmt(res.amountCents),
              commission: fmt(res.commissionCents),
              float: fmt(res.agentFloatCents),
            }),
          };
        } catch (err: any) {
          return { handled: true, reply: t27(locale, "cicoFailed", { reason: String(err?.message ?? "error").slice(0, 120) }) };
        }
      }

      case "float": {
        const { floatSummary } = await import("./agentBanking");
        const summary = await floatSummary(opts.db, opts.tenantId);
        return {
          handled: true,
          reply: t27(locale, "floatLine", {
            float: fmt(summary.floatCents),
            in: fmt(summary.todayCashInCents),
            out: fmt(summary.todayCashOutCents),
            commission: fmt(summary.todayCommissionCents),
            low: summary.lowFloat ? t27(locale, "floatLowFlag") : "",
          }),
        };
      }

      case "payByPos": {
        const amountCents = Math.round(parsed.amountMajor * 100);
        if (!Number.isInteger(amountCents) || amountCents <= 0) {
          return { handled: true, reply: t27(locale, "posUsage") };
        }
        const { createSession } = await import("./posPayments");
        const session = await createSession(opts.db, { tenantId: opts.tenantId, amountCents, channel: "ussd_ref" });
        return {
          handled: true,
          reply: t27(locale, "posSessionReady", { code: session.ussdCode, amount: fmt(session.amountCents), ref: session.reference }),
        };
      }

      case "usage":
      default:
        return { handled: true, reply: t27(locale, parsed.cmd === "usage" && parsed.kind === "pos" ? "posUsage" : "cicoUsage") };
    }
  } catch (err: any) {
    if (err?.code === "FORBIDDEN") return { handled: true, reply: t27(locale, "agentBankingDisabled") };
    console.error("[banking-chat] command failed (fail-open):", err?.message);
    return { handled: true, reply: t27(locale, "cicoFailed", { reason: "temporarily unavailable" }) };
  }
}

/** Merchant-facing POS charge receipt (no-order sessions), WA text to the
 *  tenant admin phone — fail-open notify seam used by posPayments.confirmSession. */
export async function notifyMerchantPosCharge(db: Db, tenantId: string, reference: string, settledCents: number): Promise<void> {
  const [tenant] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const adminPhone = resolveAdminPhone((tenant?.settings ?? null) as Record<string, unknown> | null);
  if (!adminPhone) return;
  const { sendWhatsAppText } = await import("./waSender");
  await sendWhatsAppText(tenantId, adminPhone, t27("en", "posChargeReceipt", { ref: reference, amount: fmt(settledCents) }), {
    notifType: "pos_charge_receipt",
  });
}
// === END W59 banking-pos ===
