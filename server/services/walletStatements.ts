// === W58 statements ===
/**
 * walletStatements.ts — bank-style monthly statement for MERCHANT wallets.
 *
 * Reuses the W46 uc-docs document machinery (ucDocsPdf.linesToPdf /
 * writeDocPdf / sendChatDocument) — dependency-free Courier PDF, honest
 * local persistence under UC_DOCS_DIR, delivery as a chat document (WA
 * document link / telegram sendDocument via channelParity category
 * 'wallet_statement').
 *
 * Storage doctrine: PDFs land under the PRIVATE uc-docs prefix
 *   <tenantId>/wallet-statements/<file>.pdf
 * served only by /api/uc-docs/* (authenticated session whose tenant matches
 * the first path segment, platform admin, or a capability token bound to
 * the exact key). No public prefix, no anonymous access.
 *
 * Statement metadata (idempotency + listing) is kept in a per-wallet JSON
 * manifest (<tenantId>/wallet-statements/manifest.json) — NO schema change
 * (invariant: migration 0179 only if indispensable; the ledger itself is
 * the source of truth, the manifest is a derivable index).
 *
 * Money: wallet amounts are numeric(14,2) NGN; all statement math runs in
 * integer cents (toCents) and renders via the same 2-decimal convention as
 * formatNGN.
 */
import crypto from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { merchantWallets, tenants, walletTransactions } from "../../drizzle/schema";
import { linesToPdf, ucDocsDir, writeDocPdf, sendChatDocument } from "./ucDocsPdf";

type Db = any;

export class WalletStatementError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WalletStatementError";
    this.code = code;
  }
}

export function toCents(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** debit types reduce the available balance; everything else is a credit. */
const DEBIT_TYPES = new Set(["escrow_refund", "fee_deduction", "withdrawal", "loan_repayment", "wholesale_trade_debit"]);
export function isDebitType(type: string): boolean {
  // wholesale_trade is a debit for the buyer leg and a credit for the
  // supplier leg; the sign is derivable from balanceBefore/After per row —
  // this static set is only the fallback. See narrationSign().
  return DEBIT_TYPES.has(type);
}

/** True sign of a ledger row, from the recorded balances (honest, per-row). */
export function rowIsDebit(tx: { balanceBefore?: unknown; balanceAfter?: unknown; type: string }): boolean {
  const before = toCents(tx.balanceBefore);
  const after = toCents(tx.balanceAfter);
  if (after !== before) return after < before;
  return isDebitType(tx.type);
}

/**
 * W58 narration templates — plain-language per wallet_tx_type. NEVER leak
 * the raw enum into customer-facing text; unknown types fall back to a
 * neutral label. {ref} = order number / reference when present.
 */
export const TX_NARRATION: Record<string, { en: string; enWithRef: string }> = {
  escrow_credit:    { en: "Payment held in escrow",          enWithRef: "Payment held in escrow — Order {ref}" },
  escrow_release:   { en: "Payment received",                enWithRef: "Payment received — Order {ref}" },
  escrow_refund:    { en: "Refund to buyer",                 enWithRef: "Refund to buyer — Order {ref}" },
  float_income:     { en: "Interest earned on balance",      enWithRef: "Interest earned on balance" },
  withdrawal:       { en: "Withdrawal to bank",              enWithRef: "Withdrawal to bank — Ref {ref}" },
  fee_deduction:    { en: "Platform fee",                    enWithRef: "Platform fee — Order {ref}" },
  loan_disbursement:{ en: "Loan disbursement",               enWithRef: "Loan disbursement — Ref {ref}" },
  loan_repayment:   { en: "Loan repayment",                  enWithRef: "Loan repayment — Ref {ref}" },
  wholesale_trade:  { en: "Wholesale trade settlement",      enWithRef: "Wholesale trade settlement — Order {ref}" },
  fx_refund:        { en: "FX payout reversal",              enWithRef: "FX payout reversal — Ref {ref}" },
  // W59 banking-pos: agent banking cash-in/cash-out leg on the agent wallet.
  agent_cico:       { en: "Agent banking cash-in/out",       enWithRef: "Agent banking cash-in/out — Ref {ref}" },
};

export function narrateTx(type: string, ref?: string | null): string {
  const tpl = TX_NARRATION[type];
  const refText = ref && ref.trim() ? ref.trim() : null;
  if (!tpl) return refText ? `Wallet transaction — Ref ${refText}` : "Wallet transaction";
  return refText ? tpl.enWithRef.replace("{ref}", refText) : tpl.en;
}

export interface WalletStatementLine {
  date: string;
  narration: string;
  type: string;
  reference: string | null;
  debitCents: number;
  creditCents: number;
  balanceAfterCents: number;
}

export interface WalletStatement {
  walletId: string;
  tenantId: string;
  currency: string;
  periodStart: string; // ISO date
  periodEnd: string;   // ISO date (exclusive bound rendered as inclusive label)
  openingCents: number;
  closingCents: number;
  totalDebitCents: number;
  totalCreditCents: number;
  txCount: number;
  lines: WalletStatementLine[];
}

/** Compute a statement from the real wallet ledger. Empty periods are
 *  honest: opening = balance after the last tx before the period (or the
 *  wallet's current balance when there is no history at all), closing =
 *  opening, zero totals, no fabricated rows. */
export async function computeWalletStatement(
  db: Db,
  opts: { tenantId: string; from: Date; to: Date },
): Promise<WalletStatement> {
  const { tenantId, from, to } = opts;
  if (!(from < to)) throw new WalletStatementError("invalid-period", "from must be before to");
  const [wallet] = await db.select().from(merchantWallets)
    .where(eq(merchantWallets.tenantId, tenantId)).limit(1);
  if (!wallet) throw new WalletStatementError("no-wallet", "no merchant wallet for this tenant");

  const txs = await db.select().from(walletTransactions)
    .where(and(
      eq(walletTransactions.walletId, wallet.id),
      gte(walletTransactions.createdAt, from),
      lt(walletTransactions.createdAt, to),
    ))
    .orderBy(asc(walletTransactions.createdAt));

  // Opening balance: balanceBefore of the first in-period tx (the ledger's
  // own record) — else balanceAfter of the last tx BEFORE the period —
  // else the wallet's current available balance when there is no history.
  let openingCents: number;
  if (txs.length) {
    openingCents = toCents(txs[0]!.balanceBefore);
  } else {
    const [prior] = await db.select().from(walletTransactions)
      .where(and(eq(walletTransactions.walletId, wallet.id), lt(walletTransactions.createdAt, from)))
      .orderBy(desc(walletTransactions.createdAt)).limit(1);
    openingCents = prior ? toCents(prior.balanceAfter) : toCents(wallet.availableBalance);
  }

  // Order numbers for narration (escrow/payment refs read better as Order #).
  const orderIds = Array.from(new Set(txs.map((t: any) => t.orderId).filter(Boolean)));
  const orderNumbers = new Map<string, string>();
  if (orderIds.length) {
    try {
      const { orders } = await import("../../drizzle/schema");
      const rows = await db.select({ id: orders.id, orderNumber: orders.orderNumber })
        .from(orders).where(eq(orders.tenantId, tenantId));
      for (const r of rows ?? []) if (orderIds.includes(r.id)) orderNumbers.set(r.id, `#${r.orderNumber}`);
    } catch { /* narration degrades to the template without ref — fail-open */ }
  }

  let totalDebit = 0;
  let totalCredit = 0;
  const lines: WalletStatementLine[] = txs.map((t: any) => {
    const debit = rowIsDebit(t);
    const amt = toCents(t.amount);
    if (debit) totalDebit += amt; else totalCredit += amt;
    const ref = (t.orderId && orderNumbers.get(t.orderId)) || t.reference || null;
    return {
      date: (t.createdAt instanceof Date ? t.createdAt : new Date(t.createdAt)).toISOString().slice(0, 10),
      narration: narrateTx(String(t.type), ref),
      type: String(t.type),
      reference: t.reference ?? null,
      debitCents: debit ? amt : 0,
      creditCents: debit ? 0 : amt,
      balanceAfterCents: toCents(t.balanceAfter),
    };
  });

  const closingCents = txs.length ? toCents(txs[txs.length - 1]!.balanceAfter) : openingCents;
  return {
    walletId: wallet.id,
    tenantId,
    currency: String(wallet.currency ?? "NGN"),
    periodStart: from.toISOString().slice(0, 10),
    periodEnd: to.toISOString().slice(0, 10),
    openingCents,
    closingCents,
    totalDebitCents: totalDebit,
    totalCreditCents: totalCredit,
    txCount: txs.length,
    lines,
  };
}

function fmtMoney(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function walletStatementPdfLines(st: WalletStatement, opts: { tenantName?: string | null }): string[] {
  const fmt = (c: number) => fmtMoney(c, st.currency);
  const money = (c: number) => c > 0 ? fmt(c).padStart(14) : "".padStart(14);
  const lines: string[] = [
    `Merchant:        ${opts.tenantName ?? st.tenantId}`,
    `Wallet:          ${st.walletId}`,
    `Period:          ${st.periodStart} .. ${st.periodEnd}`,
    `Currency:        ${st.currency}`,
    "",
    `Opening balance: ${fmt(st.openingCents)}`,
    "",
    "DATE        NARRATION                              DEBIT          CREDIT         BALANCE",
    "-".repeat(92),
    ...(st.lines.length
      ? st.lines.map((l) =>
          `${l.date}  ${l.narration.slice(0, 38).padEnd(38)} ${money(l.debitCents)} ${money(l.creditCents)} ${fmt(l.balanceAfterCents).padStart(14)}`)
      : ["  (no transactions in this period)"]),
    "-".repeat(92),
    `TOTALS                                             ${money(st.totalDebitCents)} ${money(st.totalCreditCents)}`,
    "",
    `Closing balance: ${fmt(st.closingCents)}`,
    "",
    "Generated from the real wallet ledger.",
  ];
  return lines;
}

// ── Manifest (no-migration statement index + delivery idempotency) ──────────

export interface WalletStatementRecord {
  id: string;
  walletId: string;
  periodStart: string;
  periodEnd: string;
  pdfPath: string;
  openingCents: number;
  closingCents: number;
  txCount: number;
  generatedAt: string;
  deliveries: { channel: string; at: string; messageId: string | null; target: string }[];
}

function tenantDir(tenantId: string): string {
  return `${String(tenantId).replace(/[^A-Za-z0-9_.-]/g, "_")}/wallet-statements`;
}

function manifestAbs(tenantId: string): string {
  return join(ucDocsDir(), tenantDir(tenantId), "manifest.json");
}

export function readStatementManifest(tenantId: string): WalletStatementRecord[] {
  try {
    const abs = manifestAbs(tenantId);
    if (!existsSync(abs)) return [];
    const parsed = JSON.parse(readFileSync(abs, "utf8"));
    return Array.isArray(parsed?.statements) ? parsed.statements : [];
  } catch {
    return []; // corrupt manifest must never break the ledger reads
  }
}

function writeStatementManifest(tenantId: string, statements: WalletStatementRecord[]): void {
  const abs = manifestAbs(tenantId);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, JSON.stringify({ statements }, null, 2));
}

/** Generate (idempotently regenerate) the statement PDF for one period. */
export async function generateWalletStatement(
  db: Db,
  opts: { tenantId: string; from: Date; to: Date },
): Promise<{ record: WalletStatementRecord; regenerated: boolean }> {
  const st = await computeWalletStatement(db, opts);
  const [tenant] = await db.select({ name: tenants.name }).from(tenants)
    .where(eq(tenants.id, opts.tenantId)).limit(1).catch(() => [] as any[]);
  const pdf = linesToPdf({
    title: "Wallet Statement",
    lines: walletStatementPdfLines(st, { tenantName: tenant?.name ?? null }),
  });
  // Deterministic filename → regeneration overwrites, never duplicates.
  const rel = `${tenantDir(opts.tenantId)}/statement-${st.periodStart}_${st.periodEnd}.pdf`;
  writeDocPdf(rel, pdf); // throws honestly — the manifest only records real files

  const manifest = readStatementManifest(opts.tenantId);
  const existing = manifest.find((r) => r.walletId === st.walletId && r.periodStart === st.periodStart && r.periodEnd === st.periodEnd);
  const now = new Date().toISOString();
  if (existing) {
    existing.pdfPath = rel;
    existing.openingCents = st.openingCents;
    existing.closingCents = st.closingCents;
    existing.txCount = st.txCount;
    existing.generatedAt = now;
    writeStatementManifest(opts.tenantId, manifest);
    return { record: existing, regenerated: true };
  }
  const record: WalletStatementRecord = {
    id: crypto.randomUUID(),
    walletId: st.walletId,
    periodStart: st.periodStart,
    periodEnd: st.periodEnd,
    pdfPath: rel,
    openingCents: st.openingCents,
    closingCents: st.closingCents,
    txCount: st.txCount,
    generatedAt: now,
    deliveries: [],
  };
  manifest.push(record);
  writeStatementManifest(opts.tenantId, manifest);
  return { record, regenerated: false };
}

export function getWalletStatementRecord(tenantId: string, statementId: string): WalletStatementRecord | null {
  return readStatementManifest(tenantId).find((r) => r.id === statementId) ?? null;
}

export function listWalletStatements(tenantId: string): WalletStatementRecord[] {
  return readStatementManifest(tenantId)
    .slice()
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart));
}

/**
 * Deliver a generated statement as a chat document (WA document push /
 * telegram sendDocument via channelParity, category 'wallet_statement').
 * Delivery is recorded on the manifest entry so replays stay honest.
 */
export async function deliverWalletStatement(
  db: Db,
  opts: { tenantId: string; statementId: string; phone: string },
): Promise<{ channel: string; sent: boolean; simulated: boolean; messageId: string | null }> {
  const record = getWalletStatementRecord(opts.tenantId, opts.statementId);
  if (!record) throw new WalletStatementError("not-found", "statement not found for this tenant");
  const res = await sendChatDocument(opts.tenantId, opts.phone, {
    relPath: record.pdfPath,
    filename: record.pdfPath.split("/").pop()!,
    caption: `Your wallet statement ${record.periodStart} .. ${record.periodEnd}`,
    notifType: "wallet_statement_send",
    category: "wallet_statement",
  });
  const manifest = readStatementManifest(opts.tenantId);
  const entry = manifest.find((r) => r.id === record.id);
  if (entry) {
    entry.deliveries.push({ channel: res.channel, at: new Date().toISOString(), messageId: res.messageId, target: opts.phone });
    writeStatementManifest(opts.tenantId, manifest);
  }
  return res;
}

/** Previous calendar month period [from, to) for the monthly sweep. */
export function previousMonthPeriod(now: Date): { from: Date; to: Date; key: string } {
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const firstOfPrev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { from: firstOfPrev, to: firstOfThisMonth, key: firstOfPrev.toISOString().slice(0, 7) };
}

export interface MonthlyStatementSweepResult {
  wallets: number;
  generated: number;
  deliveredWa: number;
  deliveredEmail: number;
  skipped: number;
  failed: number;
  details: { tenantId: string; outcome: string }[];
}

/**
 * Monthly sweep: for each ACTIVE merchant wallet generate the previous-month
 * statement and deliver it on the merchant's preferred channel — WA document
 * to the tenant admin phone when configured (same identity as the W27/W56
 * merchant commands), else email when the tenant has a notification email,
 * else skip with a log. Fail-open per tenant; idempotent per (wallet,
 * period): a replay for the same month reuses the manifest entry and does
 * NOT re-deliver.
 */
export async function runMonthlyStatementSweep(db: Db, opts: { now?: Date } = {}): Promise<MonthlyStatementSweepResult> {
  const now = opts.now ?? new Date();
  const period = previousMonthPeriod(now);
  const out: MonthlyStatementSweepResult = { wallets: 0, generated: 0, deliveredWa: 0, deliveredEmail: 0, skipped: 0, failed: 0, details: [] };
  const wallets = await db.select().from(merchantWallets)
    .where(eq(merchantWallets.isActive, true)).catch(() => [] as any[]);
  for (const wallet of wallets ?? []) {
    out.wallets += 1;
    try {
      const manifest = readStatementManifest(wallet.tenantId);
      const existing = manifest.find((r) => r.walletId === wallet.id && r.periodStart === period.from.toISOString().slice(0, 10));
      if (existing && existing.deliveries.length > 0) {
        out.skipped += 1;
        out.details.push({ tenantId: wallet.tenantId, outcome: "already-delivered" });
        continue;
      }
      const { record } = await generateWalletStatement(db, { tenantId: wallet.tenantId, from: period.from, to: period.to });
      out.generated += 1;

      const [tenant] = await db.select({ settings: tenants.settings }).from(tenants)
        .where(eq(tenants.id, wallet.tenantId)).limit(1).catch(() => [] as any[]);
      const settings = (tenant?.settings ?? null) as Record<string, any> | null;
      const { resolveAdminPhone } = await import("./creditWhatsApp");
      const adminPhone = resolveAdminPhone(settings);
      const email = (settings as any)?.adminEmail ?? (settings as any)?.notifications?.email ?? null;

      if (adminPhone) {
        await deliverWalletStatement(db, { tenantId: wallet.tenantId, statementId: record.id, phone: adminPhone });
        out.deliveredWa += 1;
        out.details.push({ tenantId: wallet.tenantId, outcome: "delivered-wa" });
      } else if (typeof email === "string" && email.includes("@")) {
        const { sendEmail } = await import("./email/resend");
        const { publicMediaUrl } = await import("./richMedia");
        const link = publicMediaUrl(`/api/uc-docs/${record.pdfPath}`) ?? `/api/uc-docs/${record.pdfPath}`;
        const ok = await sendEmail({
          to: email,
          subject: `Wallet statement ${record.periodStart} .. ${record.periodEnd}`,
          html: `<p>Your wallet statement for ${record.periodStart} .. ${record.periodEnd} is ready.</p><p><a href="${link}">Download statement PDF</a></p>`,
        } as any);
        // sendEmail returns false when SIMULATED (no RESEND_API_KEY) — the
        // delivery is still recorded (channel 'email') so the sweep stays
        // idempotent per (wallet, period) in every environment.
        if (!ok) console.info(`[wallet-statements] email delivery simulated for tenant ${wallet.tenantId}`);
        // Record the delivery on the manifest for idempotency.
        const m2 = readStatementManifest(wallet.tenantId);
        const e2 = m2.find((r) => r.id === record.id);
        if (e2) {
          e2.deliveries.push({ channel: "email", at: new Date().toISOString(), messageId: null, target: email });
          writeStatementManifest(wallet.tenantId, m2);
        }
        out.deliveredEmail += 1;
        out.details.push({ tenantId: wallet.tenantId, outcome: "delivered-email" });
      } else {
        console.warn(`[wallet-statements] no WA identity or email for tenant ${wallet.tenantId} — statement generated, delivery skipped`);
        out.skipped += 1;
        out.details.push({ tenantId: wallet.tenantId, outcome: "no-channel" });
      }
    } catch (e: any) {
      out.failed += 1;
      out.details.push({ tenantId: wallet.tenantId, outcome: `failed: ${e?.message ?? "error"}` });
      console.error(`[wallet-statements] monthly statement failed for tenant ${wallet.tenantId} (fail-open):`, e?.message);
    }
  }
  return out;
}
// === END W58 statements ===
