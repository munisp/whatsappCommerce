/**
 * === W33 ai-qa-forecast (Coder B) ===
 * financeQa — read-only, tenant-scoped AP/AR Q&A for the WhatsApp assistant.
 *
 * Six canonical intents (keyword-matched deterministically — when the NL/LLM
 * layer is unavailable these STILL answer; the LLM may rephrase but never
 * invents numbers):
 *   1. bills_due        "bills due this week" / "what bills are due"
 *   2. top_creditor     "who do I owe most" / "biggest supplier debt"
 *   3. invoice_paid     "invoice paid?" / "has invoice 12 been paid"
 *   4. expected_inflows "expected inflows" / "what money is coming in"
 *   5. top_debtor       "who owes me most" / "biggest unpaid invoice"
 *   6. cash_forecast    "cash forecast" / "will I run out of money"
 *
 * HONESTY CONTRACT: every figure in a reply comes from a real tenant-scoped
 * query against vendor_bills / ar_invoices / escrow_transactions /
 * cashflow_forecasts (via cashflowForecast.computeForecast). No fabricated
 * numbers, no cross-tenant reads (tenantId always from the session), no
 * writes. Mixed currencies are reported per currency and NEVER summed
 * across. All amounts integer cents → formatted via formatNairaExact.
 */
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  arInvoices,
  escrowTransactions,
  vendorBills,
} from "../../drizzle/schema";
import { formatNairaExact, toCents } from "./bookkeeping";

type Db = any;

export type FinanceIntent =
  | "bills_due"
  | "top_creditor"
  | "invoice_paid"
  | "expected_inflows"
  | "top_debtor"
  | "cash_forecast";

export const FINANCE_INTENTS: FinanceIntent[] = [
  "bills_due",
  "top_creditor",
  "invoice_paid",
  "expected_inflows",
  "top_debtor",
  "cash_forecast",
];

/** Unpaid AP statuses (open vendor bill balances). */
const OPEN_BILL_STATUSES = ["pending", "scheduled", "approved", "overdue", "partially_paid"] as const;
/** Open AR statuses (money still expected from customers). */
const OPEN_INVOICE_STATUSES = ["sent", "viewed", "overdue", "partially_paid"] as const;

/**
 * Deterministic keyword intent matcher. Runs WITHOUT any LLM key; this is
 * the guaranteed fallback. Returns null when no canonical intent matches so
 * the caller falls through to the existing assistant pipeline.
 */
export function matchFinanceIntent(text: string): { intent: FinanceIntent; invoiceNo: number | null } | null {
  const t = text.toLowerCase();
  const num = t.match(/(?:invoice|inv)\s*#?\s*(\d{1,9})/);
  const invoiceNo = num ? parseInt(num[1], 10) : null;

  // invoice_paid — must win before generic "owe"/"due" intents when an
  // invoice number is present or paid-status vocabulary is used.
  if (invoiceNo != null && /paid|pay|status|settled|received/.test(t)) {
    return { intent: "invoice_paid", invoiceNo };
  }
  if (/invoice paid|has (the )?invoice been paid|payment received/.test(t)) {
    return { intent: "invoice_paid", invoiceNo };
  }
  // top_creditor
  if (/who do i owe|owe most|biggest (supplier|vendor) (debt|bill)|most to/.test(t)) {
    return { intent: "top_creditor", invoiceNo: null };
  }
  // top_debtor
  if (/who owes me|owes me most|biggest (unpaid|outstanding) invoice|biggest debtor/.test(t)) {
    return { intent: "top_debtor", invoiceNo: null };
  }
  // expected_inflows
  if (/expected inflow|money (is )?coming in|incoming (money|cash|payments)|what('| i)?s coming in|cash coming/.test(t)) {
    return { intent: "expected_inflows", invoiceNo: null };
  }
  // cash_forecast
  if (/cash ?flow|forecast|run out of (money|cash)|shortfall|project(ed|ion)/.test(t)) {
    return { intent: "cash_forecast", invoiceNo: null };
  }
  // bills_due
  if (/bills? (are )?due|due this week|upcoming bills?|bills? to pay|what do i (need to )?pay|payments? due/.test(t)) {
    return { intent: "bills_due", invoiceNo: null };
  }
  return null;
}

type CurMap = Map<string, number>;
function addCents(map: CurMap, currency: string, cents: number) {
  map.set(currency, (map.get(currency) ?? 0) + cents);
}
function fmtMap(map: CurMap): string {
  return Array.from(map.entries()).map(([cur, cents]) => formatNairaExact(cents, cur)).join(" + ");
}

/** 1. Bills due within `days` days (default 7), real open balances. */
export async function answerBillsDue(db: Db, tenantId: string, days = 7): Promise<string> {
  const until = new Date(Date.now() + days * 86_400_000);
  const rows = await db
    .select({
      vendorName: vendorBills.vendorName,
      amountCents: vendorBills.amountCents,
      paidCents: vendorBills.paidCents,
      currency: vendorBills.currency,
      dueDate: vendorBills.dueDate,
    })
    .from(vendorBills)
    .where(and(
      eq(vendorBills.tenantId, tenantId),
      inArray(vendorBills.status, [...OPEN_BILL_STATUSES]),
      isNotNull(vendorBills.dueDate),
      lte(vendorBills.dueDate, until),
    ));
  const open = rows.filter((r: any) => r.amountCents - r.paidCents > 0);
  if (open.length === 0) return `You have no bills due in the next ${days} days. ✅`;
  const totals: CurMap = new Map();
  for (const r of open) addCents(totals, r.currency ?? "NGN", r.amountCents - r.paidCents);
  const lines = open.slice(0, 5).map((r: any) =>
    `• ${r.vendorName}: ${formatNairaExact(r.amountCents - r.paidCents, r.currency ?? "NGN")}` +
    (r.dueDate ? ` (due ${new Date(r.dueDate).toISOString().slice(0, 10)})` : ""));
  return `You have ${open.length} bill${open.length === 1 ? "" : "s"} due in the next ${days} days, total ${fmtMap(totals)}:\n${lines.join("\n")}`;
}

/** 2. Vendor with the largest open balance. */
export async function answerTopCreditor(db: Db, tenantId: string): Promise<string> {
  const rows = await db
    .select({
      vendorName: vendorBills.vendorName,
      openCents: sql<number>`SUM(${vendorBills.amountCents} - ${vendorBills.paidCents})::bigint`,
      currency: vendorBills.currency,
    })
    .from(vendorBills)
    .where(and(eq(vendorBills.tenantId, tenantId), inArray(vendorBills.status, [...OPEN_BILL_STATUSES])))
    .groupBy(vendorBills.vendorName, vendorBills.currency);
  const open = rows.filter((r: any) => Number(r.openCents) > 0)
    .sort((a: any, b: any) => Number(b.openCents) - Number(a.openCents));
  if (open.length === 0) return "You don't owe any vendors right now. ✅";
  const top = open[0];
  const others = open.slice(1, 4).map((r: any) =>
    `• ${r.vendorName}: ${formatNairaExact(Number(r.openCents), r.currency ?? "NGN")}`);
  return `You owe ${top.vendorName} the most: ${formatNairaExact(Number(top.openCents), top.currency ?? "NGN")} open.` +
    (others.length ? `\nAlso owed:\n${others.join("\n")}` : "");
}

/** 3. Invoice paid? — real status of an AR invoice (by number, else latest open). */
export async function answerInvoicePaid(db: Db, tenantId: string, invoiceNo: number | null): Promise<string> {
  let rows: any[];
  if (invoiceNo != null) {
    rows = await db.select().from(arInvoices)
      .where(and(eq(arInvoices.tenantId, tenantId), eq(arInvoices.invoiceNo, invoiceNo))).limit(1);
    if (rows.length === 0) return `I couldn't find invoice #${invoiceNo} for your business.`;
  } else {
    rows = await db.select().from(arInvoices)
      .where(and(eq(arInvoices.tenantId, tenantId), inArray(arInvoices.status, [...OPEN_INVOICE_STATUSES, "paid"])))
      .orderBy(sql`${arInvoices.invoiceNo} DESC`).limit(1);
    if (rows.length === 0) return "You have no invoices yet. Create one from the dashboard or by sending a sale here.";
  }
  const inv = rows[0];
  const cur = inv.currency ?? "NGN";
  const remaining = inv.amountCents - inv.paidCents;
  switch (inv.status) {
    case "paid":
      return `Invoice #${inv.invoiceNo} (${inv.customerName ?? "customer"}) is PAID ✅ — ${formatNairaExact(inv.paidCents, cur)} received.`;
    case "partially_paid":
      return `Invoice #${inv.invoiceNo} (${inv.customerName ?? "customer"}) is PARTIALLY PAID — ${formatNairaExact(inv.paidCents, cur)} of ${formatNairaExact(inv.amountCents, cur)} received; ${formatNairaExact(remaining, cur)} still outstanding.`;
    case "cancelled":
      return `Invoice #${inv.invoiceNo} was cancelled — no payment is expected.`;
    case "draft":
      return `Invoice #${inv.invoiceNo} is still a DRAFT — it hasn't been sent, so no payment has been received.`;
    default:
      return `Invoice #${inv.invoiceNo} (${inv.customerName ?? "customer"}) is NOT PAID yet — ${formatNairaExact(remaining, cur)} outstanding` +
        (inv.dueDate ? ` (due ${new Date(inv.dueDate).toISOString().slice(0, 10)}).` : ".") +
        (inv.status === "overdue" ? " It is OVERDUE." : "");
  }
}

/** 4. Expected inflows: open AR + escrow releases awaiting buyer confirm. */
export async function answerExpectedInflows(db: Db, tenantId: string): Promise<string> {
  const arRows = await db
    .select({
      remaining: sql<number>`SUM(${arInvoices.amountCents} - ${arInvoices.paidCents})::bigint`,
      n: sql<number>`COUNT(*)::int`,
      currency: arInvoices.currency,
    })
    .from(arInvoices)
    .where(and(eq(arInvoices.tenantId, tenantId), inArray(arInvoices.status, [...OPEN_INVOICE_STATUSES])))
    .groupBy(arInvoices.currency);
  const escrowRows = await db
    .select({
      amount: escrowTransactions.netMerchantAmount,
      currency: escrowTransactions.currency,
    })
    .from(escrowTransactions)
    .where(and(
      eq(escrowTransactions.tenantId, tenantId),
      inArray(escrowTransactions.state, ["payment_received", "escrow_held", "delivery_confirmed"] as any),
    ));
  const ar: CurMap = new Map();
  for (const r of arRows) if (Number(r.remaining) > 0) addCents(ar, r.currency ?? "NGN", Number(r.remaining));
  const esc: CurMap = new Map();
  for (const r of escrowRows) addCents(esc, r.currency ?? "NGN", toCents(r.amount));
  if (ar.size === 0 && esc.size === 0) return "No expected inflows right now — no open invoices or escrow pending release.";
  const parts: string[] = [];
  if (ar.size) parts.push(`open invoices: ${fmtMap(ar)}`);
  if (esc.size) parts.push(`escrow pending release: ${fmtMap(esc)}`);
  return `Expected inflows — ${parts.join("; ")}.`;
}

/** 5. Customer with the largest outstanding invoice balance. */
export async function answerTopDebtor(db: Db, tenantId: string): Promise<string> {
  const rows = await db
    .select({
      customerName: arInvoices.customerName,
      openCents: sql<number>`SUM(${arInvoices.amountCents} - ${arInvoices.paidCents})::bigint`,
      currency: arInvoices.currency,
    })
    .from(arInvoices)
    .where(and(eq(arInvoices.tenantId, tenantId), inArray(arInvoices.status, [...OPEN_INVOICE_STATUSES])))
    .groupBy(arInvoices.customerName, arInvoices.currency);
  const open = rows.filter((r: any) => Number(r.openCents) > 0)
    .sort((a: any, b: any) => Number(b.openCents) - Number(a.openCents));
  if (open.length === 0) return "Nobody owes you right now — all invoices are settled. ✅";
  const top = open[0];
  return `${top.customerName ?? "A customer"} owes you the most: ${formatNairaExact(Number(top.openCents), top.currency ?? "NGN")} outstanding across open invoices.`;
}

/** 6. 30-day cash forecast summary (real computation via cashflowForecast). */
export async function answerCashForecast(db: Db, tenantId: string): Promise<string> {
  const { computeForecast } = await import("./cashflowForecast");
  const f = await computeForecast(db, tenantId, 30);
  if (f.lines.length === 0) {
    return "No data yet for a cash-flow forecast — once you have bills, invoices or scheduled payments I'll project your cash position here.";
  }
  const cur = f.currency;
  const base = `Next 30 days: expected in ${formatNairaExact(f.inflowCents, cur)}, going out ${formatNairaExact(f.outflowCents, cur)}, net ${formatNairaExact(f.netCents, cur)}.`;
  if (f.shortfallAt) {
    return `${base} ⚠️ Projected shortfall around ${f.shortfallAt} — your balance plus expected inflows won't cover scheduled outflows from that date.`;
  }
  return `${base} No shortfall projected on your current balance and scheduled items.`;
}

/** Dispatch a matched intent to its answer function. */
export async function answerFinanceIntent(
  db: Db,
  tenantId: string,
  match: { intent: FinanceIntent; invoiceNo: number | null },
): Promise<string> {
  switch (match.intent) {
    case "bills_due": return answerBillsDue(db, tenantId);
    case "top_creditor": return answerTopCreditor(db, tenantId);
    case "invoice_paid": return answerInvoicePaid(db, tenantId, match.invoiceNo);
    case "expected_inflows": return answerExpectedInflows(db, tenantId);
    case "top_debtor": return answerTopDebtor(db, tenantId);
    case "cash_forecast": return answerCashForecast(db, tenantId);
  }
}

/**
 * Assistant pipeline hook (mirrors the W27 savingsWa seam): match + answer a
 * canonical finance intent, or return null to fall through to the existing
 * use-case / NLP pipeline. tenantId comes from the caller session — never
 * from the message text.
 */
export async function handleFinanceQa(opts: {
  db: Db;
  tenantId: string;
  phone: string;
  text: string;
}): Promise<{ handled: true; reply: string } | null> {
  const match = matchFinanceIntent(opts.text);
  if (!match) return null;
  const reply = await answerFinanceIntent(opts.db, opts.tenantId, match);
  return { handled: true, reply };
}
// === END W33 ai-qa-forecast ===
