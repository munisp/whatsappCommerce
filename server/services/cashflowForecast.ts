/**
 * === W33 ai-qa-forecast (Coder B) ===
 * cashflowForecast — 30/60/90-day cash-flow projection from REAL rows only.
 *
 * Outflow sources (tenant-scoped, integer cents):
 *   - scheduled_payments (status pending, execute_at within horizon)
 *   - recurring_rules (active; next occurrences projected per cadence)
 *   - installment_plans (active; schedule entries due within horizon)
 *   - vendor_bills (open statuses, due_date within horizon)
 * Inflow sources:
 *   - ar_invoices (open statuses, due_date within horizon, remaining balance)
 *   - escrow_transactions (held states, expected release at buyer_confirm_deadline)
 *   - historical paid-invoice velocity HEURISTIC: average weekly paid-AR
 *     amount over the trailing 90 days, scaled to the horizon — always
 *     labelled `heuristic: true` in the detail lines.
 *
 * Currency honesty: the projection is computed in the tenant wallet's
 * currency; lines in other currencies are EXCLUDED and listed in
 * detail.skippedCurrencies (never converted, never summed across).
 *
 * Conservation: sum(inflow lines) == inflowCents, sum(outflow lines) ==
 * outflowCents, netCents == inflowCents - outflowCents. shortfallAt is the
 * first calendar date where startingBalance + cumulative net < 0 (null when
 * never negative). Snapshots persist to cashflow_forecasts (migration 0113)
 * idempotently per (tenant, horizon, day) — read-then-skip plus the unique
 * expression index as backstop (23505 tolerated).
 */
import { and, eq, gte, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import {
  arInvoices,
  cashflowForecasts,
  escrowTransactions,
  installmentPlans,
  merchantWallets,
  recurringRules,
  scheduledPayments,
  vendorBills,
} from "../../drizzle/schema";
import { toCents } from "./bookkeeping";

type Db = any;

const DAY_MS = 86_400_000;
const OPEN_BILL_STATUSES = ["pending", "scheduled", "approved", "overdue", "partially_paid"] as const;
const OPEN_INVOICE_STATUSES = ["sent", "viewed", "overdue", "partially_paid"] as const;
const HELD_ESCROW_STATES = ["payment_received", "escrow_held", "delivery_confirmed"] as const;

export interface ForecastLine {
  kind:
    | "scheduled_payment" | "recurring_rule" | "installment_due" | "vendor_bill"
    | "ar_invoice" | "escrow_release" | "historical_velocity";
  direction: "inflow" | "outflow";
  date: string; // YYYY-MM-DD (UTC)
  amountCents: number;
  sourceId: string;
  note?: string;
  heuristic?: boolean;
}

export interface ForecastResult {
  tenantId: string;
  horizonDays: number;
  generatedAt: string; // ISO
  currency: string;
  startingBalanceCents: number;
  inflowCents: number;
  outflowCents: number;
  netCents: number;
  shortfallAt: string | null;
  lines: ForecastLine[];
  skippedCurrencies: string[];
  empty: boolean; // true when the tenant has no data at all ("No data yet")
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addMonthsClamped(d: Date, dayOfMonth: number | null): Date {
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(dayOfMonth ?? d.getUTCDate(), lastDay));
  return next;
}

/** Project active recurring-rule occurrences within [from, until]. */
export function projectOccurrences(rule: {
  id: string; amountCents: number; cadence: string;
  dayOfMonth: number | null; nextRunAt: Date;
}, from: Date, until: Date): Array<{ date: Date; amountCents: number }> {
  const out: Array<{ date: Date; amountCents: number }> = [];
  let at = new Date(rule.nextRunAt);
  // Occurrences before `from` are not part of the projection window; advance.
  let guard = 0;
  while (at < from && guard++ < 520) {
    at = rule.cadence === "weekly" ? new Date(at.getTime() + 7 * DAY_MS) : addMonthsClamped(at, rule.dayOfMonth);
  }
  guard = 0;
  while (at <= until && guard++ < 520) {
    out.push({ date: new Date(at), amountCents: rule.amountCents });
    at = rule.cadence === "weekly" ? new Date(at.getTime() + 7 * DAY_MS) : addMonthsClamped(at, rule.dayOfMonth);
  }
  return out;
}

/**
 * Pure totals + shortfall walk. Conservation: sum(inflow lines) ==
 * inflowCents, sum(outflow lines) == outflowCents, net == inflow - outflow.
 * shortfallAt = first date (UTC day) where startingBalance + cumulative net
 * < 0; today when the starting balance alone is already negative.
 */
export function summarizeLines(
  lines: ForecastLine[],
  startingBalanceCents: number,
  today: string,
): { inflowCents: number; outflowCents: number; netCents: number; shortfallAt: string | null } {
  const inflowCents = lines.filter((l) => l.direction === "inflow").reduce((s, l) => s + l.amountCents, 0);
  const outflowCents = lines.filter((l) => l.direction === "outflow").reduce((s, l) => s + l.amountCents, 0);
  const netCents = inflowCents - outflowCents;
  let shortfallAt: string | null = null;
  const byDay = new Map<string, number>();
  for (const l of lines) {
    byDay.set(l.date, (byDay.get(l.date) ?? 0) + (l.direction === "inflow" ? l.amountCents : -l.amountCents));
  }
  let cum = startingBalanceCents;
  for (const day of Array.from(byDay.keys()).sort()) {
    cum += byDay.get(day)!;
    if (cum < 0) { shortfallAt = day; break; }
  }
  if (shortfallAt === null && startingBalanceCents < 0) shortfallAt = today;
  return { inflowCents, outflowCents, netCents, shortfallAt };
}

export async function computeForecast(
  db: Db,
  tenantId: string,
  horizonDays: number,
  now: Date = new Date(),
): Promise<ForecastResult> {
  const until = new Date(now.getTime() + horizonDays * DAY_MS);
  const [wallet] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantId)).limit(1);
  const currency: string = wallet?.currency ?? "NGN";
  const startingBalanceCents = toCents(wallet?.availableBalance ?? "0");
  const lines: ForecastLine[] = [];
  const skipped = new Set<string>();
  const keepCur = (cur: string | null | undefined) => {
    const c = cur ?? "NGN";
    if (c !== currency) { skipped.add(c); return false; }
    return true;
  };

  // ── Outflows ────────────────────────────────────────────────────────────
  const sched = await db.select().from(scheduledPayments).where(and(
    eq(scheduledPayments.tenantId, tenantId),
    eq(scheduledPayments.status, "pending"),
    lte(scheduledPayments.executeAt, until),
  ));
  for (const r of sched) {
    if (!keepCur(r.currency)) continue;
    lines.push({ kind: "scheduled_payment", direction: "outflow", date: ymd(new Date(r.executeAt)), amountCents: r.amountCents, sourceId: r.id, note: `${r.kind} scheduled payment` });
  }

  const rules = await db.select().from(recurringRules).where(and(
    eq(recurringRules.tenantId, tenantId),
    eq(recurringRules.status, "active"),
  ));
  for (const r of rules) {
    if (!keepCur(r.currency)) continue;
    for (const occ of projectOccurrences(r, now, until)) {
      lines.push({ kind: "recurring_rule", direction: "outflow", date: ymd(occ.date), amountCents: occ.amountCents, sourceId: r.id, note: `recurring ${r.cadence} ${r.kind}` });
    }
  }

  const plans = await db.select().from(installmentPlans).where(and(
    eq(installmentPlans.tenantId, tenantId),
    eq(installmentPlans.status, "active"),
  ));
  for (const p of plans) {
    if (!keepCur(p.currency)) continue;
    const schedule = Array.isArray(p.schedule) ? (p.schedule as any[]) : [];
    for (const e of schedule) {
      if (e?.status === "paid" || !e?.dueAt) continue;
      const due = new Date(e.dueAt);
      if (due > until) continue;
      lines.push({ kind: "installment_due", direction: "outflow", date: ymd(due), amountCents: Math.round(Number(e.amountCents)), sourceId: p.id, note: `installment ${e.seq ?? "?"} (pay-over-time)` });
    }
  }

  const bills = await db.select().from(vendorBills).where(and(
    eq(vendorBills.tenantId, tenantId),
    inArray(vendorBills.status, [...OPEN_BILL_STATUSES]),
    isNotNull(vendorBills.dueDate),
    lte(vendorBills.dueDate, until),
  ));
  for (const b of bills) {
    if (!keepCur(b.currency)) continue;
    const open = b.amountCents - b.paidCents;
    if (open <= 0) continue;
    // Pay-over-time financed bills are repaid via their installment plan
    // (projected above) — skip the bill line so the same debt never counts twice.
    const financed = (b.metadata as any)?.financing === "pay_over_time";
    if (financed) continue;
    lines.push({ kind: "vendor_bill", direction: "outflow", date: ymd(new Date(b.dueDate)), amountCents: open, sourceId: b.id, note: `bill ${b.vendorName}` });
  }

  // ── Inflows ─────────────────────────────────────────────────────────────
  const invoices = await db.select().from(arInvoices).where(and(
    eq(arInvoices.tenantId, tenantId),
    inArray(arInvoices.status, [...OPEN_INVOICE_STATUSES]),
    isNotNull(arInvoices.dueDate),
    lte(arInvoices.dueDate, until),
  ));
  for (const inv of invoices) {
    if (!keepCur(inv.currency)) continue;
    const remaining = inv.amountCents - inv.paidCents;
    if (remaining <= 0) continue;
    lines.push({ kind: "ar_invoice", direction: "inflow", date: ymd(new Date(inv.dueDate)), amountCents: remaining, sourceId: inv.id, note: `invoice #${inv.invoiceNo} ${inv.customerName ?? ""}`.trim() });
  }

  const escrows = await db.select().from(escrowTransactions).where(and(
    eq(escrowTransactions.tenantId, tenantId),
    inArray(escrowTransactions.state, [...HELD_ESCROW_STATES] as any),
  ));
  for (const e of escrows) {
    if (!keepCur(e.currency)) continue;
    // Expected release at the buyer-confirm deadline; when none is recorded
    // yet, the escrow is still awaiting delivery — exclude from the dated
    // projection (honest: we don't know when it lands).
    if (!e.buyerConfirmDeadline) continue;
    const rel = new Date(e.buyerConfirmDeadline);
    if (rel > until) continue;
    lines.push({ kind: "escrow_release", direction: "inflow", date: ymd(rel), amountCents: toCents(e.netMerchantAmount), sourceId: e.id, note: "expected escrow release (buyer-confirm deadline)" });
  }

  // Historical paid-invoice velocity heuristic (labelled): trailing-90d paid
  // AR per week, scaled to the horizon, spread as one line at horizon end.
  const since = new Date(now.getTime() - 90 * DAY_MS);
  const [paid] = await db.select({
    total: sql<number>`COALESCE(SUM(${arInvoices.paidCents}),0)::bigint`,
  }).from(arInvoices).where(and(
    eq(arInvoices.tenantId, tenantId),
    eq(arInvoices.currency, currency),
    isNotNull(arInvoices.paidAt),
    gte(arInvoices.paidAt, since),
  ));
  const paid90 = Number(paid?.total ?? 0);
  if (paid90 > 0) {
    const weekly = paid90 / (90 / 7);
    const projected = Math.round(weekly * (horizonDays / 7));
    lines.push({
      kind: "historical_velocity", direction: "inflow", date: ymd(until),
      amountCents: projected, sourceId: "heuristic:velocity90d", heuristic: true,
      note: `heuristic: historical paid-invoice velocity (₦-cents ${paid90} paid over trailing 90d → ~${Math.round(weekly)}/week)`,
    });
  }

  // ── Totals + shortfall walk ─────────────────────────────────────────────
  const { inflowCents, outflowCents, netCents, shortfallAt } = summarizeLines(lines, startingBalanceCents, ymd(now));

  return {
    tenantId, horizonDays, generatedAt: now.toISOString(), currency,
    startingBalanceCents, inflowCents, outflowCents, netCents, shortfallAt,
    lines: lines.sort((a, b) => a.date.localeCompare(b.date)),
    skippedCurrencies: Array.from(skipped),
    empty: lines.length === 0,
  };
}

/** Row shape stored in cashflow_forecasts.detail. */
function detailOf(f: ForecastResult) {
  return {
    lines: f.lines,
    startingBalanceCents: f.startingBalanceCents,
    skippedCurrencies: f.skippedCurrencies,
    sources: ["scheduled_payments", "recurring_rules", "installment_plans", "vendor_bills", "ar_invoices", "escrow_transactions", "historical_velocity(labelled heuristic)"],
  };
}

/**
 * Store today's snapshot for (tenant, horizon). Idempotent: same-day
 * recompute returns the existing row ({stored:false}); the unique expression
 * index is the concurrency backstop (23505 → treated as already stored).
 */
export async function storeSnapshot(
  db: Db,
  tenantId: string,
  horizonDays: number,
  now: Date = new Date(),
): Promise<{ stored: boolean; forecast: ForecastResult }> {
  const forecast = await computeForecast(db, tenantId, horizonDays, now);
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const [existing] = await db.select({ id: cashflowForecasts.id }).from(cashflowForecasts).where(and(
    eq(cashflowForecasts.tenantId, tenantId),
    eq(cashflowForecasts.horizonDays, horizonDays),
    gte(cashflowForecasts.generatedAt, dayStart),
    lt(cashflowForecasts.generatedAt, dayEnd),
  )).limit(1);
  if (existing) return { stored: false, forecast };
  try {
    await db.insert(cashflowForecasts).values({
      tenantId,
      horizonDays,
      generatedAt: now,
      inflowCents: forecast.inflowCents,
      outflowCents: forecast.outflowCents,
      netCents: forecast.netCents,
      currency: forecast.currency,
      shortfallAt: forecast.shortfallAt,
      detail: detailOf(forecast),
    });
    return { stored: true, forecast };
  } catch (err: any) {
    if (err?.code === "23505") return { stored: false, forecast };
    throw err;
  }
}

/**
 * Weekly cron sweep (`/api/scheduled/cashflow-forecast`): store a 30-day
 * snapshot for every tenant that has ANY forecast-relevant data (empty
 * tenants are skipped honestly — no fabricated zero-rows).
 */
export async function runForecastSweep(db: Db, now: Date = new Date()): Promise<{
  tenantsConsidered: number; stored: number; skipped: number; empty: number;
}> {
  const tenants = await db.select({ tenantId: merchantWallets.tenantId })
    .from(merchantWallets).where(eq(merchantWallets.isActive, true));
  let stored = 0, skipped = 0, empty = 0;
  for (const t of tenants) {
    // Compute first: tenants with no data get NO row at all (honest — no
    // fabricated zero-snapshots), so check emptiness before persisting.
    const probe = await computeForecast(db, t.tenantId, 30, now);
    if (probe.empty) { empty++; continue; }
    const res = await storeSnapshot(db, t.tenantId, 30, now);
    if (res.stored) stored++; else skipped++;
  }
  return { tenantsConsidered: tenants.length, stored, skipped, empty };
}
// === END W33 ai-qa-forecast ===
