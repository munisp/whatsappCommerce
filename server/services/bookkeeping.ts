/**
 * W27 bookkeeping — sales summaries / simple bookkeeping for merchants.
 *
 * Three capabilities:
 *   1. Daily/weekly sales digests ("You made ₦42,300 this week, up 12%")
 *      computed from paid orders (integer cents) and delivered via WhatsApp
 *      on an opt-in schedule (runScheduledDigests drives the cron endpoint
 *      /api/scheduled/bookkeeping-digests).
 *   2. Expense capture: merchant texts "expense", photos the supplier
 *      receipt, the shared receipt-vision OCR pipeline (receiptVision.ts)
 *      parses amount/vendor/date, and a confirm flow finalises the record.
 *   3. Tax-ready export: CSV (+ minimal PDF) of sales + expenses per period
 *      with a formalization-friendly summary (total sales, expenses, net).
 *
 * Determinism: ALL money is INTEGER CENTS; order totals (decimal major
 * units) are converted via toCents (Math.round — no float drift). Period
 * math is UTC-only. No Math.random anywhere in this module.
 */
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import {
  bookkeepingDigestLog,
  bookkeepingDigestPrefs,
  expenses,
  orders,
} from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { analyzeReceiptImage, parseReceiptAmount } from "./receiptVision";
import { resolveTenantWaCredentials, sendWhatsAppText } from "./waSender";

type Db = any;

// ─── Money helpers ──────────────────────────────────────────────────────────

/** decimal major units ("2500.00") → integer cents. Deterministic. */
export function toCents(amount: string | number | null | undefined): number {
  if (amount == null) return 0;
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** ₦ formatting for whole-naira amounts (cents → "₦42,300"). */
export function formatNaira(cents: number, currency = "NGN"): string {
  const major = cents / 100;
  const rounded = Math.round(major);
  const grouped = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = rounded < 0 ? "-" : "";
  if (currency === "NGN") return `${sign}₦${grouped}`;
  return `${sign}${currency} ${grouped}`;
}

/** ₦ formatting that keeps kobo when non-zero ("₦42,300.50"). */
export function formatNairaExact(cents: number, currency = "NGN"): string {
  const whole = Math.floor(Math.abs(cents) / 100);
  const frac = Math.abs(cents) % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = cents < 0 ? "-" : "";
  const body = frac ? `${grouped}.${String(frac).padStart(2, "0")}` : grouped;
  if (currency === "NGN") return `${sign}₦${body}`;
  return `${sign}${currency} ${body}`;
}

// ─── Period math (UTC-only, deterministic) ──────────────────────────────────

export type DigestFrequency = "daily" | "weekly";

export interface PeriodRange {
  from: Date;
  to: Date; // exclusive
  prevFrom: Date;
  prevTo: Date; // exclusive
  periodKey: string;
}

const DAY_MS = 24 * 3600 * 1000;

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Period range for a digest/summary. daily = the UTC day containing `now`;
 * weekly = the 7 UTC days ending today (inclusive). prev* is the immediately
 * preceding window of the same length — the basis for week-over-week math.
 * periodKey is stable per period ("D2026-02-14" / "W2026-02-14") so digest
 * sends are idempotent.
 */
export function periodRange(frequency: DigestFrequency, now: Date): PeriodRange {
  const lenDays = frequency === "daily" ? 1 : 7;
  const from = utcDayStart(now);
  if (frequency === "weekly") from.setTime(from.getTime() - 6 * DAY_MS);
  const to = new Date(utcDayStart(now).getTime() + DAY_MS);
  const prevTo = from;
  const prevFrom = new Date(from.getTime() - lenDays * DAY_MS);
  const dayKey = utcDayStart(now).toISOString().slice(0, 10);
  return { from, to, prevFrom, prevTo, periodKey: `${frequency === "daily" ? "D" : "W"}${dayKey}` };
}

// ─── Sales summaries ────────────────────────────────────────────────────────

export interface SalesSummary {
  tenantId: string;
  frequency: DigestFrequency;
  periodKey: string;
  from: Date;
  to: Date;
  salesCents: number;
  orderCount: number;
  prevSalesCents: number;
  prevOrderCount: number;
  /** rounded % change vs previous period; null when previous period was 0. */
  changePct: number | null;
  currency: string;
}

async function sumPaidOrders(db: Db, tenantId: string, from: Date, to: Date): Promise<{ cents: number; count: number; currency: string }> {
  const rows = await db
    .select({ totalAmount: orders.totalAmount, currency: orders.currency })
    .from(orders)
    .where(and(
      eq(orders.tenantId, tenantId),
      eq(orders.paymentStatus, "completed"),
      gte(orders.createdAt, from),
      lt(orders.createdAt, to),
    ));
  let cents = 0;
  let currency = "NGN";
  for (const r of rows) {
    cents += toCents(r.totalAmount);
    if (r.currency) currency = r.currency;
  }
  return { cents, count: rows.length, currency };
}

export async function computeSalesSummary(
  db: Db,
  tenantId: string,
  frequency: DigestFrequency,
  now: Date = new Date(),
): Promise<SalesSummary> {
  const p = periodRange(frequency, now);
  const cur = await sumPaidOrders(db, tenantId, p.from, p.to);
  const prev = await sumPaidOrders(db, tenantId, p.prevFrom, p.prevTo);
  const changePct = prev.cents > 0 ? Math.round(((cur.cents - prev.cents) / prev.cents) * 100) : null;
  return {
    tenantId,
    frequency,
    periodKey: p.periodKey,
    from: p.from,
    to: p.to,
    salesCents: cur.cents,
    orderCount: cur.count,
    prevSalesCents: prev.cents,
    prevOrderCount: prev.count,
    changePct,
    currency: cur.currency,
  };
}

/** "📊 You made ₦42,300 this week, up 12% vs last week (5 orders)." */
export function renderDigestMessage(s: SalesSummary): string {
  const span = s.frequency === "daily" ? "today" : "this week";
  const prevSpan = s.frequency === "daily" ? "yesterday" : "last week";
  const amount = formatNaira(s.salesCents, s.currency);
  const ordersTxt = `${s.orderCount} order${s.orderCount === 1 ? "" : "s"}`;
  let trend: string;
  if (s.changePct == null) {
    trend = s.prevSalesCents === 0 && s.salesCents > 0 ? ` — no sales ${prevSpan} to compare` : "";
  } else if (s.changePct > 0) {
    trend = `, up ${s.changePct}% vs ${prevSpan}`;
  } else if (s.changePct < 0) {
    trend = `, down ${Math.abs(s.changePct)}% vs ${prevSpan}`;
  } else {
    trend = `, flat vs ${prevSpan}`;
  }
  return `📊 You made ${amount} ${span}${trend} (${ordersTxt}). Reply "export" for a tax-ready report.`;
}

// ─── Digest prefs + scheduled sends ─────────────────────────────────────────

export async function getDigestPref(db: Db, tenantId: string, phone: string) {
  const [row] = await db.select().from(bookkeepingDigestPrefs)
    .where(and(eq(bookkeepingDigestPrefs.tenantId, tenantId), eq(bookkeepingDigestPrefs.phone, phone)))
    .limit(1);
  return row ?? null;
}

export async function setDigestPref(
  db: Db,
  tenantId: string,
  phone: string,
  opts: { frequency?: DigestFrequency; optedIn: boolean },
) {
  const frequency: DigestFrequency = opts.frequency ?? "weekly";
  const existing = await getDigestPref(db, tenantId, phone);
  if (existing) {
    await db.update(bookkeepingDigestPrefs)
      .set({ frequency: opts.frequency ?? existing.frequency, optedIn: opts.optedIn, updatedAt: new Date() })
      .where(eq(bookkeepingDigestPrefs.id, existing.id));
    return { ...existing, frequency: opts.frequency ?? existing.frequency, optedIn: opts.optedIn };
  }
  const [row] = await db.insert(bookkeepingDigestPrefs)
    .values({ tenantId, phone, frequency, optedIn: opts.optedIn })
    .onConflictDoNothing()
    .returning();
  return row ?? (await getDigestPref(db, tenantId, phone));
}

export interface DigestRunResult {
  sent: number;
  skipped: number;
  periodKeys: string[];
}

/**
 * Send due digests. A pref is due when opted-in and its period key for `now`
 * hasn't been sent yet (digest_log unique (tenant, phone, period_key) is the
 * idempotency anchor — safe to invoke repeatedly).
 */
export async function runScheduledDigests(db: Db, now: Date = new Date()): Promise<DigestRunResult> {
  const prefs = await db.select().from(bookkeepingDigestPrefs)
    .where(eq(bookkeepingDigestPrefs.optedIn, true));
  const result: DigestRunResult = { sent: 0, skipped: 0, periodKeys: [] };
  for (const pref of prefs) {
    const frequency = (pref.frequency === "daily" ? "daily" : "weekly") as DigestFrequency;
    const p = periodRange(frequency, now);
    if (pref.lastSentPeriodKey === p.periodKey) { result.skipped++; continue; }
    const [dupe] = await db.select({ id: bookkeepingDigestLog.id }).from(bookkeepingDigestLog)
      .where(and(
        eq(bookkeepingDigestLog.tenantId, pref.tenantId),
        eq(bookkeepingDigestLog.phone, pref.phone),
        eq(bookkeepingDigestLog.periodKey, p.periodKey),
      )).limit(1);
    if (dupe) {
      await db.update(bookkeepingDigestPrefs)
        .set({ lastSentPeriodKey: p.periodKey, updatedAt: new Date() })
        .where(eq(bookkeepingDigestPrefs.id, pref.id)).catch(() => {});
      result.skipped++; continue;
    }
    const summary = await computeSalesSummary(db, pref.tenantId, frequency, now);
    // Claim the slot BEFORE sending so a concurrent cron run can't double-send.
    const claimed = await db.insert(bookkeepingDigestLog).values({
      tenantId: pref.tenantId,
      phone: pref.phone,
      frequency,
      periodKey: p.periodKey,
      salesCents: summary.salesCents,
      orderCount: summary.orderCount,
    }).onConflictDoNothing().returning({ id: bookkeepingDigestLog.id });
    if (!claimed?.length) { result.skipped++; continue; }
    try {
      await sendWhatsAppText(pref.tenantId, pref.phone, renderDigestMessage(summary));
      await db.update(bookkeepingDigestPrefs)
        .set({ lastSentPeriodKey: p.periodKey, updatedAt: new Date() })
        .where(eq(bookkeepingDigestPrefs.id, pref.id)).catch(() => {});
      result.sent++;
      result.periodKeys.push(p.periodKey);
    } catch (e: any) {
      // Roll the claim back so the next cron tick retries.
      await db.delete(bookkeepingDigestLog).where(eq(bookkeepingDigestLog.id, claimed[0].id)).catch(() => {});
      console.warn(`[bookkeeping] digest send failed for ${pref.tenantId}/${pref.phone}:`, e?.message);
    }
  }
  return result;
}

// ─── Expenses ───────────────────────────────────────────────────────────────

export const EXPENSE_CATEGORIES = [
  "stock", "transport", "rent", "utilities", "wages", "packaging", "marketing", "fees", "general",
] as const;

export function normalizeCategory(raw: string | null | undefined): string {
  const c = (raw ?? "").trim().toLowerCase();
  return (EXPENSE_CATEGORIES as readonly string[]).includes(c) ? c : "general";
}

/** Open a receipt-capture session: merchant will photo the receipt next. */
export async function startExpenseCapture(db: Db, tenantId: string, phone: string) {
  // One open session at a time: clear a stale one first.
  await db.delete(expenses).where(and(
    eq(expenses.tenantId, tenantId),
    eq(expenses.createdByPhone, phone),
    eq(expenses.status, "awaiting_receipt"),
  ));
  const [row] = await db.insert(expenses).values({
    tenantId,
    amountCents: 0,
    status: "awaiting_receipt",
    source: "receipt_photo",
    createdByPhone: phone,
    expenseDate: new Date(),
  }).returning();
  return row;
}

export async function findAwaitingReceipt(db: Db, tenantId: string, phone: string) {
  const [row] = await db.select().from(expenses)
    .where(and(
      eq(expenses.tenantId, tenantId),
      eq(expenses.createdByPhone, phone),
      eq(expenses.status, "awaiting_receipt"),
    ))
    .orderBy(desc(expenses.createdAt))
    .limit(1);
  return row ?? null;
}

export async function findPendingConfirm(db: Db, tenantId: string, phone: string) {
  const [row] = await db.select().from(expenses)
    .where(and(
      eq(expenses.tenantId, tenantId),
      eq(expenses.createdByPhone, phone),
      eq(expenses.status, "pending_confirm"),
    ))
    .orderBy(desc(expenses.createdAt))
    .limit(1);
  return row ?? null;
}

export async function confirmExpense(db: Db, tenantId: string, phone: string) {
  const row = await findPendingConfirm(db, tenantId, phone);
  if (!row) return null;
  await db.update(expenses)
    .set({ status: "confirmed", updatedAt: new Date() })
    .where(eq(expenses.id, row.id));
  return { ...row, status: "confirmed" };
}

export async function cancelExpense(db: Db, tenantId: string, phone: string) {
  const row = (await findPendingConfirm(db, tenantId, phone)) ?? (await findAwaitingReceipt(db, tenantId, phone));
  if (!row) return null;
  await db.update(expenses)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(eq(expenses.id, row.id));
  return { ...row, status: "rejected" };
}

export async function addManualExpense(
  db: Db,
  tenantId: string,
  input: { amountCents: number; vendor?: string; category?: string; date?: Date; note?: string; phone?: string },
) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("amountCents must be a positive integer");
  }
  const [row] = await db.insert(expenses).values({
    tenantId,
    amountCents: input.amountCents,
    vendor: input.vendor ?? null,
    category: normalizeCategory(input.category),
    expenseDate: input.date ?? new Date(),
    status: "confirmed",
    source: "manual",
    note: input.note ?? null,
    createdByPhone: input.phone ?? null,
  }).returning();
  return row;
}

export async function listExpenses(db: Db, tenantId: string, opts: { from?: Date; to?: Date; status?: string; limit?: number } = {}) {
  const conds: any[] = [eq(expenses.tenantId, tenantId)];
  if (opts.from) conds.push(gte(expenses.expenseDate, opts.from));
  if (opts.to) conds.push(lt(expenses.expenseDate, opts.to));
  conds.push(sql`${expenses.status} <> 'awaiting_receipt'`);
  return db.select().from(expenses)
    .where(and(...conds))
    .orderBy(desc(expenses.expenseDate))
    .limit(Math.min(opts.limit ?? 200, 1000));
}

// ─── Receipt-photo OCR (reuses the shared receipt-vision pipeline) ──────────

/** Download a WhatsApp media object, base64-encoded (same pattern as receiptVerification). */
async function downloadWaMedia(tenantId: string, mediaId: string): Promise<{ base64: string; mimeType: string } | null> {
  const creds = await resolveTenantWaCredentials(tenantId);
  if (!creds) return null;
  const meta = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const url: string | undefined = (meta as any)?.url;
  if (!url) return null;
  const bin = await fetch(url, { headers: { Authorization: `Bearer ${creds.accessToken}` } })
    .then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  if (!bin) return null;
  const mimeType = ((meta as any)?.mime_type ?? "image/jpeg") as string;
  return { base64: Buffer.from(bin).toString("base64"), mimeType };
}

/** Parse a YYYY-MM-DD / DD/MM/YYYY-ish date out of OCR text; fallback now. */
export function parseExpenseDate(raw: string | null | undefined, fallback: Date): Date {
  if (!raw) return fallback;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    if (!Number.isNaN(d.getTime())) return d;
  }
  const dmy = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(raw);
  if (dmy) {
    const d = new Date(Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1]));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
}

export interface ExpenseImageOutcome {
  handled: boolean;
  outcome?: "parsed" | "no_session" | "download_failed" | "ocr_failed" | "no_amount";
  expenseId?: string;
  amountCents?: number;
}

/**
 * Inbound image hook: only claims the image when this sender has an OPEN
 * expense-capture session (status awaiting_receipt) — otherwise returns
 * handled:false so the visual-search pipeline can proceed unchanged.
 * Never throws at the webhook layer: failures produce a reply + outcome.
 */
export async function handleInboundExpenseImage(opts: {
  tenantId: string;
  waPhoneNumber: string;
  mediaId: string;
}): Promise<ExpenseImageOutcome> {
  const { getDb } = await import("../db");
  const db = await getDb();
  if (!db) return { handled: false, outcome: "no_session" };
  const session = await findAwaitingReceipt(db, opts.tenantId, opts.waPhoneNumber);
  if (!session) return { handled: false, outcome: "no_session" };

  const media = await downloadWaMedia(opts.tenantId, opts.mediaId);
  if (!media) {
    await sendWhatsAppText(opts.tenantId, opts.waPhoneNumber,
      "⚠️ I couldn't download that receipt photo. Please retake it in good light and send again (or reply \"cancel expense\").")
      .catch(() => {});
    return { handled: true, outcome: "download_failed", expenseId: session.id };
  }
  let scan;
  try {
    const mime = (["image/jpeg", "image/png", "image/webp"].includes(media.mimeType) ? media.mimeType : "image/jpeg") as "image/jpeg" | "image/png" | "image/webp";
    scan = await analyzeReceiptImage(media.base64, mime);
  } catch (e: any) {
    console.warn("[bookkeeping] expense OCR failed:", e?.message);
    await sendWhatsAppText(opts.tenantId, opts.waPhoneNumber,
      "⚠️ I couldn't read that receipt. Please send a clearer photo (or reply \"cancel expense\").")
      .catch(() => {});
    return { handled: true, outcome: "ocr_failed", expenseId: session.id };
  }
  const amountMajor = parseReceiptAmount(scan.keyFields?.amount) ?? parseReceiptAmount(scan.extractedText);
  if (amountMajor == null || amountMajor <= 0) {
    await db.update(expenses)
      .set({ ocrText: scan.extractedText ?? null, mediaId: opts.mediaId, updatedAt: new Date() })
      .where(eq(expenses.id, session.id));
    await sendWhatsAppText(opts.tenantId, opts.waPhoneNumber,
      "🧾 I received the receipt but couldn't find the total amount. Send a clearer close-up of the total, or reply \"cancel expense\".")
      .catch(() => {});
    return { handled: true, outcome: "no_amount", expenseId: session.id };
  }
  const amountCents = toCents(amountMajor);
  const vendor = (scan.keyFields?.sellerName ?? "").trim().slice(0, 160) || null;
  const expenseDate = parseExpenseDate(scan.keyFields?.date ?? scan.extractedText, new Date());
  await db.update(expenses)
    .set({
      amountCents,
      vendor,
      expenseDate,
      mediaId: opts.mediaId,
      ocrText: scan.extractedText ?? null,
      status: "pending_confirm",
      updatedAt: new Date(),
    })
    .where(eq(expenses.id, session.id));
  await sendWhatsAppText(opts.tenantId, opts.waPhoneNumber,
    `🧾 Expense captured: ${formatNairaExact(amountCents)}${vendor ? ` at ${vendor}` : ""} on ${expenseDate.toISOString().slice(0, 10)}.\nReply "confirm expense" to save it, or "cancel expense" to discard.`)
    .catch(() => {});
  return { handled: true, outcome: "parsed", expenseId: session.id, amountCents };
}

// ─── WhatsApp text command surface ──────────────────────────────────────────

function portalExportUrl(): string {
  const base = (ENV.appUrl || "http://localhost:3000").replace(/\/$/, "");
  return `${base}/portal/bookkeeping`;
}

/**
 * Merchant bookkeeping commands. Returns a reply string when the message was
 * claimed, or null when it isn't a bookkeeping command (falls through to NLP).
 * Matching is deliberately exact/prefix-based — deterministic, no LLM.
 */
export async function handleBookkeepingText(opts: {
  db: Db;
  tenantId: string;
  phone: string;
  text: string;
}): Promise<string | null> {
  const { db, tenantId, phone } = opts;
  const t = opts.text.trim();
  const lower = t.toLowerCase();

  // ── Sales summary ──────────────────────────────────────────────────────
  if (/^(sales\s+)?summary(\s+(today|daily|week|weekly))?$/.test(lower) || lower === "sales summary") {
    const frequency: DigestFrequency = /today|daily/.test(lower) ? "daily" : "weekly";
    const s = await computeSalesSummary(db, tenantId, frequency, new Date());
    const extra = `\nExpenses ${spanLabel(frequency)}: ${formatNairaExact(await expenseTotal(db, tenantId, frequency))}.`;
    return renderDigestMessage(s) + extra;
  }

  // ── Digest opt-in/out ──────────────────────────────────────────────────
  const digestMatch = /^digest\s+(on|off)(?:\s+(daily|weekly))?$/.exec(lower);
  if (digestMatch) {
    const on = digestMatch[1] === "on";
    const frequency = (digestMatch[2] as DigestFrequency | undefined) ?? undefined;
    const pref = await setDigestPref(db, tenantId, phone, { optedIn: on, frequency });
    if (!on) return `🔕 Sales digests turned OFF. Reply "digest on weekly" any time to re-enable.`;
    return `🔔 Sales digest ON (${pref.frequency}). You'll get your ${pref.frequency === "daily" ? "daily" : "weekly"} summary here on WhatsApp. Reply "digest off" to stop.`;
  }

  // ── Expense capture ────────────────────────────────────────────────────
  if (lower === "expense" || lower === "add expense" || lower === "log expense") {
    await startExpenseCapture(db, tenantId, phone);
    return `🧾 Send a clear photo of the supplier receipt now. I'll read the amount and vendor, then ask you to confirm. Reply "cancel expense" to abort.`;
  }
  const manual = /^expense\s+(\d+(?:\.\d{1,2})?)\s+(.+)$/.exec(lower);
  if (manual) {
    const amountCents = toCents(manual[1]);
    if (amountCents <= 0) return `⚠️ I couldn't parse that amount. Try: expense 1500 Chidi Supplies`;
    const row = await addManualExpense(db, tenantId, {
      amountCents,
      vendor: manual[2].slice(0, 160),
      phone,
    });
    return `✅ Expense saved: ${formatNairaExact(row.amountCents)} at ${row.vendor ?? "unknown vendor"}.`;
  }
  if (lower === "confirm expense") {
    const row = await confirmExpense(db, tenantId, phone);
    if (!row) return `ℹ️ No expense waiting for confirmation. Send "expense" to capture one.`;
    return `✅ Expense confirmed: ${formatNairaExact(row.amountCents)}${row.vendor ? ` at ${row.vendor}` : ""}. View it any time in your portal: ${portalExportUrl()}`;
  }
  if (lower === "cancel expense") {
    const row = await cancelExpense(db, tenantId, phone);
    if (!row) return `ℹ️ No open expense to cancel.`;
    return `🗑️ Expense discarded.`;
  }

  // ── Tax-ready export link ──────────────────────────────────────────────
  if (lower === "export" || lower === "tax export" || lower === "bookkeeping export") {
    return `📑 Your tax-ready sales & expense export lives in your tenant portal: ${portalExportUrl()} — download CSV or PDF for any period (includes totals for banks/MFIs).`;
  }

  return null;
}

function spanLabel(f: DigestFrequency): string {
  return f === "daily" ? "today" : "this week";
}

async function expenseTotal(db: Db, tenantId: string, frequency: DigestFrequency, now: Date = new Date()): Promise<number> {
  const p = periodRange(frequency, now);
  const rows = await db.select({ amountCents: expenses.amountCents }).from(expenses)
    .where(and(
      eq(expenses.tenantId, tenantId),
      eq(expenses.status, "confirmed"),
      gte(expenses.expenseDate, p.from),
      lt(expenses.expenseDate, p.to),
    ));
  return rows.reduce((a: number, r: any) => a + (r.amountCents ?? 0), 0);
}

// ─── Tax-ready export (CSV + minimal PDF) ───────────────────────────────────

export interface BookkeepingExport {
  tenantId: string;
  from: Date;
  to: Date;
  currency: string;
  sales: Array<{ orderNumber: string; date: string; amountCents: number; currency: string }>;
  expenseRows: Array<{ date: string; vendor: string; category: string; amountCents: number }>;
  totalSalesCents: number;
  totalExpensesCents: number;
  netCents: number;
}

export async function buildBookkeepingExport(db: Db, tenantId: string, from: Date, to: Date): Promise<BookkeepingExport> {
  const salesRows = await db
    .select({
      orderNumber: orders.orderNumber,
      createdAt: orders.createdAt,
      totalAmount: orders.totalAmount,
      currency: orders.currency,
    })
    .from(orders)
    .where(and(
      eq(orders.tenantId, tenantId),
      eq(orders.paymentStatus, "completed"),
      gte(orders.createdAt, from),
      lt(orders.createdAt, to),
    ))
    .orderBy(orders.createdAt);
  const expenseRows = await db.select().from(expenses)
    .where(and(
      eq(expenses.tenantId, tenantId),
      eq(expenses.status, "confirmed"),
      gte(expenses.expenseDate, from),
      lt(expenses.expenseDate, to),
    ))
    .orderBy(expenses.expenseDate);
  let currency = "NGN";
  const sales = salesRows.map((r: any) => {
    if (r.currency) currency = r.currency;
    return {
      orderNumber: r.orderNumber,
      date: new Date(r.createdAt).toISOString().slice(0, 10),
      amountCents: toCents(r.totalAmount),
      currency: r.currency ?? "NGN",
    };
  });
  const totalSalesCents = sales.reduce((a: number, r: any) => a + r.amountCents, 0);
  const totalExpensesCents = expenseRows.reduce((a: number, r: any) => a + (r.amountCents ?? 0), 0);
  return {
    tenantId,
    from,
    to,
    currency,
    sales,
    expenseRows: expenseRows.map((r: any) => ({
      date: new Date(r.expenseDate).toISOString().slice(0, 10),
      vendor: r.vendor ?? "",
      category: r.category ?? "general",
      amountCents: r.amountCents ?? 0,
    })),
    totalSalesCents,
    totalExpensesCents,
    netCents: totalSalesCents - totalExpensesCents,
  };
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV with a formalization-friendly summary block at the top. */
export function exportToCsv(x: BookkeepingExport): string {
  const fmt = (c: number) => (c / 100).toFixed(2);
  const lines: string[] = [];
  lines.push(`Bookkeeping export,${x.tenantId}`);
  lines.push(`Period,${x.from.toISOString().slice(0, 10)},to,${x.to.toISOString().slice(0, 10)}`);
  lines.push(`Currency,${x.currency}`);
  lines.push(`Total sales,${fmt(x.totalSalesCents)}`);
  lines.push(`Total expenses,${fmt(x.totalExpensesCents)}`);
  lines.push(`Net income,${fmt(x.netCents)}`);
  lines.push("");
  lines.push("Sales");
  lines.push("order_number,date,amount");
  for (const s of x.sales) lines.push(`${csvEscape(s.orderNumber)},${s.date},${fmt(s.amountCents)}`);
  lines.push("");
  lines.push("Expenses");
  lines.push("date,vendor,category,amount");
  for (const e of x.expenseRows) lines.push(`${e.date},${csvEscape(e.vendor)},${csvEscape(e.category)},${fmt(e.amountCents)}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Minimal single-font plain-text PDF (no dependencies). Good enough for a
 * one-page summary a merchant can present to a bank/MFI; the CSV carries
 * the row-level detail.
 */
export function exportToPdf(x: BookkeepingExport): Buffer {
  const fmt = (c: number) => formatNairaExact(c, x.currency).replace(/₦/g, "NGN ");
  const lines = [
    "Bookkeeping Summary",
    `Tenant: ${x.tenantId}`,
    `Period: ${x.from.toISOString().slice(0, 10)} to ${x.to.toISOString().slice(0, 10)}`,
    "",
    `Total sales:    ${fmt(x.totalSalesCents)}  (${x.sales.length} orders)`,
    `Total expenses: ${fmt(x.totalExpensesCents)}  (${x.expenseRows.length} records)`,
    `Net income:     ${fmt(x.netCents)}`,
    "",
    "Sales",
    ...x.sales.slice(0, 25).map((s) => `  ${s.date}  ${s.orderNumber}  ${fmt(s.amountCents)}`),
    x.sales.length > 25 ? `  ... and ${x.sales.length - 25} more (see CSV)` : "",
    "",
    "Expenses",
    ...x.expenseRows.slice(0, 25).map((e) => `  ${e.date}  ${e.vendor || "-"} (${e.category})  ${fmt(e.amountCents)}`),
    x.expenseRows.length > 25 ? `  ... and ${x.expenseRows.length - 25} more (see CSV)` : "",
  ].filter((l) => l !== null);

  // Build PDF objects.
  const esc = (s: string) => s.replace(/[^\x20-\x7E]/g, "?").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  let content = "BT /F1 11 Tf 50 780 Td 16 TL\n";
  for (const line of lines) content += `(${esc(line)}) Tj T*\n`;
  content += "ET\n";

  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";
  objects[5] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`;

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(pdf);
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}
