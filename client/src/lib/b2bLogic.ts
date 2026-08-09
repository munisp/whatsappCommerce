/**
 * b2bLogic.ts — PURE logic for the wave-8 B2B frontend (supply-chain credit
 * network). No React, no tRPC, no I/O — every function here is unit-testable
 * in a node environment. Shared by the pages/components and the test suite.
 *
 * Data shapes mirror the backend contracts that land with wave-8 S1–S3:
 *   trpc.procurement.*  (suppliers, purchase orders)
 *   trpc.tradeCredit.*  (credit accounts, ledger, limits)
 *   trpc.creditRepay.*  (repayment links)
 * Amounts are NGN (naira) as plain numbers unless a field name says otherwise.
 */

// ─── Shared data shapes (mirror backend contracts; adjust on rebase) ────────

export interface CreditAccountRef {
  id: string;
  limit: number;
  outstanding: number;
  status: CreditAccountStatus;
}

export interface SupplierSummary {
  supplierTenantId: string;
  businessName: string;
  categories: string[];
  /** Minimum order value in ₦. */
  moq: number;
  leadTimeDays: number;
  /** Supported net terms in days, e.g. [7, 14, 30]. */
  termsDays: number[];
  /** The viewing tenant's credit account with this supplier, if any. */
  myAccount?: CreditAccountRef | null;
}

export interface CatalogItem {
  id: string;
  name: string;
  sku?: string | null;
  unitPrice: number;
  unit?: string | null;
}

export interface SupplierProfile extends SupplierSummary {
  description?: string | null;
  catalog: CatalogItem[];
}

export type PoStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "invoiced"
  | "paid"
  | "fulfilled"
  | "cancelled";

export type PoPaymentMode = "credit" | "paynow";

export interface PoLine {
  catalogItemId?: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  buyerTenantId: string;
  supplierTenantId: string;
  buyerName?: string | null;
  supplierName?: string | null;
  lines: PoLine[];
  subtotal: number;
  status: PoStatus;
  paymentMode: PoPaymentMode;
  termsDays?: number | null;
  dueDate?: string | null;
  rejectionReason?: string | null;
  /** Checkout URL for pay-now POs (present once the PO is approved). */
  paymentUrl?: string | null;
  createdAt: string;
}

export type CreditAccountStatus = "active" | "frozen" | "closed";

/**
 * Aging buckets — mirrors the backend bucketForDraw boundaries
 * (server/services/tradeCredit/accounts.ts). Amounts in ₦ (normalized from
 * the backend's *_cents columns by the b2b.ts bridge).
 */
export interface AgingBuckets {
  current: number;
  days1to30: number;
  days31to60: number;
  days61to90: number;
  days90plus: number;
}

export interface CreditAccount {
  id: string;
  buyerTenantId: string;
  supplierTenantId: string;
  /** Display name of the counterparty (resolved from the tenant directory when known). */
  counterpartyName: string;
  limit: number;
  outstanding: number;
  status: CreditAccountStatus;
  termsDays: number;
  nextDueDate?: string | null;
  score?: number | null;
  scoreReasons?: string[];
  aging?: AgingBuckets;
}

export type LedgerKind = "invoice_draw" | "repayment" | "fee" | "adjustment";

export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  /** Signed amount in ₦: draws/fees positive (debit), repayments negative (credit). */
  amount: number;
  poId?: string | null;
  ref?: string | null;
  note?: string | null;
  dueDate?: string | null;
  status?: string;
  createdAt: string;
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/** ₦ formatting — NGN via Intl, no decimals for whole naira in compact UI. */
export function formatNaira(val: number | string | null | undefined, opts: { decimals?: number } = {}): string {
  const n = typeof val === "string" ? parseFloat(val) : (val ?? 0);
  if (!Number.isFinite(n)) return "₦0.00";
  const decimals = opts.decimals ?? 2;
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

/** Short date, e.g. "12 Mar 2026". Falls back to "—" for missing/invalid. */
export function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ─── PO status badges ───────────────────────────────────────────────────────

export interface StatusMeta {
  label: string;
  /** Muted badge classes — low saturation, no solid backgrounds. */
  className: string;
}

export const PO_STATUS_META: Record<PoStatus, StatusMeta> = {
  draft:            { label: "Draft",            className: "border-border text-muted-foreground" },
  pending_approval: { label: "Pending approval", className: "border-amber-500/40 text-amber-400" },
  approved:         { label: "Approved",         className: "border-emerald-500/40 text-emerald-400" },
  rejected:         { label: "Rejected",         className: "border-red-500/40 text-red-400" },
  invoiced:         { label: "Invoiced",         className: "border-sky-500/40 text-sky-400" },
  paid:             { label: "Paid",             className: "border-emerald-500/40 text-emerald-400" },
  fulfilled:        { label: "Fulfilled",        className: "border-teal-500/40 text-teal-400" },
  cancelled:        { label: "Cancelled",        className: "border-border text-muted-foreground" },
};

/** Status metadata with a safe fallback for statuses added server-side later. */
export function poStatusMeta(status: string): StatusMeta {
  return (
    PO_STATUS_META[status as PoStatus] ?? {
      label: status.replaceAll("_", " "),
      className: "border-border text-muted-foreground",
    }
  );
}

// ─── Ledger kind badges ─────────────────────────────────────────────────────

export const LEDGER_KIND_META: Record<LedgerKind, StatusMeta> = {
  invoice_draw: { label: "Invoice draw", className: "border-sky-500/40 text-sky-400" },
  repayment:    { label: "Repayment",    className: "border-emerald-500/40 text-emerald-400" },
  adjustment:   { label: "Adjustment",   className: "border-amber-500/40 text-amber-400" },
  fee:          { label: "Fee",          className: "border-red-500/40 text-red-400" },
};

export function ledgerKindMeta(kind: string): StatusMeta {
  return (
    LEDGER_KIND_META[kind as LedgerKind] ?? {
      label: kind,
      className: "border-border text-muted-foreground",
    }
  );
}

// ─── MOQ validation ─────────────────────────────────────────────────────────

export interface MoqResult {
  ok: boolean;
  /** Human-readable reason when !ok. */
  reason: string | null;
  /** How far below the MOQ the subtotal is (0 when ok). */
  shortfall: number;
}

/** Validate a draft PO subtotal against the supplier's minimum order value. */
export function validateMoq(subtotal: number, moq: number | null | undefined): MoqResult {
  const min = moq ?? 0;
  if (min <= 0) return { ok: true, reason: null, shortfall: 0 };
  if (subtotal >= min) return { ok: true, reason: null, shortfall: 0 };
  const shortfall = min - subtotal;
  return {
    ok: false,
    reason: `Below supplier minimum order of ${formatNaira(min)} — add ${formatNaira(shortfall)} more`,
    shortfall,
  };
}

// ─── Payment-mode enablement ────────────────────────────────────────────────

export interface PaymentModeOption {
  mode: PoPaymentMode;
  label: string;
  enabled: boolean;
  /** Why the mode is unavailable (shown under the disabled radio). */
  disabledReason: string | null;
}

/**
 * "Pay on credit (net N)" requires an ACTIVE credit account with the supplier.
 * Frozen / missing accounts disable the credit option with a reason.
 */
export function poPaymentModes(
  account: Pick<CreditAccountRef, "status"> | null | undefined,
  termsDays?: number | null,
): PaymentModeOption[] {
  const hasAccount = !!account;
  const isActive = account?.status === "active";
  const netLabel = termsDays ? `Pay on credit (net ${termsDays}d)` : "Pay on credit";
  return [
    {
      mode: "credit",
      label: netLabel,
      enabled: hasAccount && isActive,
      disabledReason: !hasAccount
        ? "No credit account with this supplier — request credit first"
        : !isActive
          ? `Credit account is ${account?.status ?? "inactive"}`
          : null,
    },
    { mode: "paynow", label: "Pay now", enabled: true, disabledReason: null },
  ];
}

// ─── Aging buckets ──────────────────────────────────────────────────────────

export type AgingBucketKey = keyof AgingBuckets;

export const AGING_BUCKET_LABELS: Record<AgingBucketKey, string> = {
  current: "Current",
  d1_7: "1–7 days",
  d8_30: "8–30 days",
  over30: ">30 days",
};

/**
 * Bucket an overdue amount by days past due:
 *   not yet due (<= 0) → current; 1–7 → d1_7; 8–30 → d8_30; >30 → over30.
 */
export function agingBucketFor(daysPastDue: number): AgingBucketKey {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 7) return "d1_7";
  if (daysPastDue <= 30) return "d8_30";
  return "over30";
}

export function daysPastDue(dueDate: string, now: Date = new Date()): number {
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return 0;
  return Math.floor((now.getTime() - due.getTime()) / 86_400_000);
}

/** Build aging buckets from ledger entries that carry a dueDate. */
export function computeAging(entries: Array<Pick<LedgerEntry, "amount" | "dueDate" | "kind">>, now: Date = new Date()): AgingBuckets {
  const buckets: AgingBuckets = { current: 0, d1_7: 0, d8_30: 0, over30: 0 };
  for (const e of entries) {
    // Only debits (invoices/fees) age; payments reduce the current bucket.
    if (!e.dueDate) {
      if (e.amount > 0) buckets.current += e.amount;
      continue;
    }
    const bucket = agingBucketFor(daysPastDue(e.dueDate, now));
    buckets[bucket] += e.amount;
  }
  return buckets;
}

/**
 * Earliest unsettled due date across a ledger (overdue entries first, then
 * upcoming). Repayments/adjustments never carry meaningful due dates.
 */
export function nextDueFromLedger(
  entries: Array<Pick<LedgerEntry, "dueDate" | "status" | "kind">>,
): string | null {
  const candidates = entries
    .filter(
      (e) =>
        e.dueDate &&
        e.kind !== "repayment" &&
        e.kind !== "adjustment" &&
        e.status !== "settled" &&
        e.status !== "void",
    )
    .map((e) => e.dueDate!)
    .sort();
  return candidates[0] ?? null;
}

// ─── Limit gauge math ───────────────────────────────────────────────────────
export interface LimitGaugeResult {
  /** 0..100, clamped. */
  pct: number;
  used: number;
  limit: number;
  available: number;
  /** Muted tone for the gauge fill. */
  tone: "ok" | "warn" | "danger";
}

export function limitGauge(used: number, limit: number): LimitGaugeResult {
  const safeLimit = Math.max(0, limit);
  const safeUsed = Math.max(0, used);
  const pct = safeLimit > 0 ? Math.min(100, Math.round((safeUsed / safeLimit) * 100)) : safeUsed > 0 ? 100 : 0;
  const tone: LimitGaugeResult["tone"] = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok";
  return { pct, used: safeUsed, limit: safeLimit, available: Math.max(0, safeLimit - safeUsed), tone };
}

// ─── Credit account status chip (supplier approvals inbox) ─────────────────

export type CreditFitStatus = "within-limit" | "over-limit" | "no-account" | "frozen";

export interface CreditFitResult {
  status: CreditFitStatus;
  label: string;
  className: string;
}

/**
 * For a pending PO, how does the requested amount sit against the buyer's
 * credit account with this supplier?
 */
export function creditFitForPo(
  account: Pick<CreditAccountRef, "status" | "limit" | "outstanding"> | null | undefined,
  poSubtotal: number,
): CreditFitResult {
  if (!account) {
    return { status: "no-account", label: "No credit account", className: "border-border text-muted-foreground" };
  }
  if (account.status === "frozen") {
    return { status: "frozen", label: "Account frozen", className: "border-red-500/40 text-red-400" };
  }
  const headroom = account.limit - account.outstanding;
  if (poSubtotal <= headroom) {
    return { status: "within-limit", label: "Within limit", className: "border-emerald-500/40 text-emerald-400" };
  }
  return { status: "over-limit", label: "Over limit", className: "border-amber-500/40 text-amber-400" };
}

// ─── Due-date countdown ─────────────────────────────────────────────────────

export interface DueCountdown {
  /** Signed days: negative = overdue. */
  days: number;
  label: string;
  tone: "ok" | "warn" | "danger" | "none";
}

export function dueCountdown(dueDate: string | null | undefined, now: Date = new Date()): DueCountdown {
  if (!dueDate) return { days: 0, label: "—", tone: "none" };
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return { days: 0, label: "—", tone: "none" };
  const days = Math.ceil((due.getTime() - now.getTime()) / 86_400_000);
  if (days < 0) return { days, label: `${Math.abs(days)}d overdue`, tone: "danger" };
  if (days === 0) return { days, label: "Due today", tone: "warn" };
  if (days <= 7) return { days, label: `Due in ${days}d`, tone: "warn" };
  return { days, label: `Due in ${days}d`, tone: "ok" };
}

// ─── Form validation ────────────────────────────────────────────────────────

export interface LimitFormValues {
  limit: string;
  termsDays: string;
}

export interface LimitFormErrors {
  limit?: string;
  termsDays?: string;
}

/** Supplier-side editable limit/terms form. Returns {} when valid. */
export function validateLimitForm(values: LimitFormValues): LimitFormErrors {
  const errors: LimitFormErrors = {};
  const limit = Number(values.limit);
  if (values.limit.trim() === "" || !Number.isFinite(limit) || limit < 0) {
    errors.limit = "Limit must be a non-negative number";
  } else if (limit > 100_000_000) {
    errors.limit = "Limit looks unreasonably high (max ₦100,000,000)";
  }
  const terms = Number(values.termsDays);
  if (values.termsDays.trim() === "" || !Number.isInteger(terms) || terms < 1) {
    errors.termsDays = "Terms must be a whole number of days (min 1)";
  } else if (terms > 90) {
    errors.termsDays = "Terms longer than 90 days are not supported";
  }
  return errors;
}

/** A PO line is submittable when it has a name, qty ≥ 1 and price ≥ 0. */
export function validatePoLines(lines: PoLine[]): string | null {
  if (lines.length === 0) return "Add at least one line item";
  for (const [i, l] of lines.entries()) {
    if (!l.name.trim()) return `Line ${i + 1}: item name is required`;
    if (!Number.isFinite(l.quantity) || l.quantity <= 0) return `Line ${i + 1}: quantity must be at least 1`;
    if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) return `Line ${i + 1}: unit price must be ≥ 0`;
  }
  return null;
}

export function poSubtotal(lines: Array<Pick<PoLine, "quantity" | "unitPrice">>): number {
  return lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
}

// ─── Dashboard widget derivations ──────────────────────────────────────────

export interface CreditSummary {
  totalOutstanding: number;
  totalLimit: number;
  utilizationPct: number;
  nextDueDate: string | null;
  accountCount: number;
}

/** Aggregate the buyer's credit accounts for the dashboard widget. */
export function summarizeCreditAccounts(accounts: Array<Pick<CreditAccount, "outstanding" | "limit" | "nextDueDate" | "status">>): CreditSummary {
  const active = accounts.filter((a) => a.status !== "closed");
  const totalOutstanding = active.reduce((s, a) => s + Math.max(0, a.outstanding), 0);
  const totalLimit = active.reduce((s, a) => s + Math.max(0, a.limit), 0);
  const utilizationPct = totalLimit > 0 ? Math.round((totalOutstanding / totalLimit) * 100) : 0;
  const upcoming = active
    .map((a) => a.nextDueDate)
    .filter((d): d is string => !!d)
    .sort();
  return {
    totalOutstanding,
    totalLimit,
    utilizationPct,
    nextDueDate: upcoming[0] ?? null,
    accountCount: active.length,
  };
}

/** Count supplier-side POs awaiting a decision (dashboard widget). */
export function countPendingApprovals(pos: Array<Pick<PurchaseOrder, "status">>): number {
  return pos.filter((p) => p.status === "pending_approval").length;
}
ing a decision (dashboard widget). */
export function countPendingApprovals(pos: Array<Pick<PurchaseOrder, "status">>): number {
  return pos.filter((p) => p.status === "pending_approval").length;
}
