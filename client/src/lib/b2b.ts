/**
 * b2b.ts — typed access layer for the wave-8 supply-chain tRPC routers.
 *
 * All three backend routers now exist with real types in AppRouter:
 *   procurement.*  (S2) — supplier directory, wholesale catalog, POs
 *   tradeCredit.*  (S1) — credit accounts, ledger, limits, scoring
 *   creditRepay.*  (S3) — Paystack repayment links
 *
 * The wrappers below adapt backend contracts (cents, *_TenantId inputs, row
 * shapes) to the ₦-denormalized UI types in client/src/lib/b2bLogic.ts, so
 * pages stay stable even as the backend evolves.
 */
import { trpc } from "@/lib/trpc";
import type {
  CreditAccount,
  LedgerEntry,
  LedgerKind,
  PoLine,
  PoPaymentMode,
  PoStatus,
  PurchaseOrder,
  SupplierCatalog,
  SupplierSummary,
} from "@/lib/b2bLogic";

// ─── Generic hook result shapes (subset of the react-query results we use) ──

export interface QueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: { message: string } | null;
  refetch: () => void;
}

export interface MutationOpts<TData> {
  onSuccess?: (data: TData) => void;
  onError?: (error: { message: string }) => void;
}

export interface MutationResult<TVars, TData> {
  mutate: (vars: TVars) => void;
  mutateAsync: (vars: TVars) => Promise<TData>;
  isPending: boolean;
}

type QOpts = { enabled?: boolean };

// ─── Backend row shapes (drizzle rows over superjson; Dates stay Dates) ─────

interface RawDirectoryEntry {
  tenantId: string;
  name: string | null;
  moqCents: number;
  leadTimeDays: number;
  termsOffered: number[];
  defaultTermsDays: number;
  categories: string[];
  credit: {
    accountId: string;
    status: string;
    limitCents: number;
    outstandingCents: number;
    termsDays: number;
  } | null;
}

interface RawWholesaleCatalog {
  supplierTenantId: string;
  items: Array<{
    productRef: string;
    name: string;
    unitPriceCents: number;
    minQty: number;
    currency: string;
    source: string;
  }>;
  moqCents: number;
  leadTimeDays: number;
  termsOffered: number[];
  defaultTermsDays: number;
  source: string;
}

interface RawPoRow {
  id: string;
  poNumber: string;
  buyerTenantId: string;
  supplierTenantId: string;
  status: PoStatus;
  subtotalCents: number;
  paymentMode: PoPaymentMode;
  creditAccountId: string | null;
  termsDays: number | null;
  dueDate: string | Date | null;
  buyerPhone: string | null;
  notes: string | null;
  createdAt: string | Date;
}

interface RawPoItem {
  id: string;
  poId: string;
  productRef: string | null;
  name: string;
  qty: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

interface RawCreditAccount {
  id: string;
  supplierTenantId: string;
  buyerTenantId: string;
  limitCents: number;
  outstandingCents: number;
  termsDays: number;
  status: CreditAccount["status"];
  score: number | null;
  scoreReasons: unknown;
  createdAt: string | Date;
  updatedAt: string | Date;
  aging?: {
    current: number;
    days1to30: number;
    days31to60: number;
    days61to90: number;
    days90plus: number;
  };
}

interface RawLedgerEntry {
  id: string;
  creditAccountId: string;
  kind: LedgerKind;
  amountCents: number;
  poId: string | null;
  dueDate: string | Date | null;
  status: string;
  ref: string | null;
  note: string | null;
  createdAt: string | Date;
}

function iso(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : v;
}

function normalizeSupplier(raw: RawDirectoryEntry): SupplierSummary {
  return {
    supplierTenantId: raw.tenantId,
    businessName: raw.name?.trim() || "Supplier",
    categories: raw.categories ?? [],
    moq: raw.moqCents / 100,
    leadTimeDays: raw.leadTimeDays,
    termsDays: raw.termsOffered ?? [],
    defaultTermsDays: raw.defaultTermsDays ?? null,
    myAccount: raw.credit
      ? {
          id: raw.credit.accountId,
          status: raw.credit.status as CreditAccount["status"],
          limit: raw.credit.limitCents / 100,
          outstanding: raw.credit.outstandingCents / 100,
        }
      : null,
  };
}

function normalizeCatalog(raw: RawWholesaleCatalog): SupplierCatalog {
  return {
    supplierTenantId: raw.supplierTenantId,
    catalog: (raw.items ?? []).map((i) => ({
      id: i.productRef,
      name: i.name,
      unitPrice: i.unitPriceCents / 100,
      minQty: i.minQty,
      unit: null,
      sku: i.source === "local" ? null : i.source,
    })),
    moq: raw.moqCents / 100,
    leadTimeDays: raw.leadTimeDays,
    termsDays: raw.termsOffered ?? [],
    defaultTermsDays: raw.defaultTermsDays ?? null,
  };
}

function normalizePo(raw: RawPoRow, items?: RawPoItem[]): PurchaseOrder {
  return {
    id: raw.id,
    poNumber: raw.poNumber,
    buyerTenantId: raw.buyerTenantId,
    supplierTenantId: raw.supplierTenantId,
    subtotal: Number(raw.subtotalCents) / 100,
    status: raw.status,
    paymentMode: raw.paymentMode,
    termsDays: raw.termsDays,
    dueDate: iso(raw.dueDate),
    creditAccountId: raw.creditAccountId,
    notes: raw.notes,
    createdAt: iso(raw.createdAt) ?? "",
    lines: items?.map((i): PoLine => ({
      catalogItemId: i.productRef,
      name: i.name,
      quantity: i.qty,
      unitPrice: i.unitPriceCents / 100,
    })),
  };
}

function normalizeAccount(raw: RawCreditAccount): CreditAccount {
  return {
    id: raw.id,
    buyerTenantId: raw.buyerTenantId,
    supplierTenantId: raw.supplierTenantId,
    // Resolved to a display name by the pages via the tenant directory.
    counterpartyName: raw.buyerTenantId,
    limit: raw.limitCents / 100,
    outstanding: raw.outstandingCents / 100,
    status: raw.status,
    termsDays: raw.termsDays,
    score: raw.score ?? null,
    scoreReasons: Array.isArray(raw.scoreReasons) ? (raw.scoreReasons as string[]) : [],
    aging: raw.aging
      ? {
          current: raw.aging.current / 100,
          days1to30: raw.aging.days1to30 / 100,
          days31to60: raw.aging.days31to60 / 100,
          days61to90: raw.aging.days61to90 / 100,
          days90plus: raw.aging.days90plus / 100,
        }
      : undefined,
  };
}

function normalizeLedgerEntry(raw: RawLedgerEntry): LedgerEntry {
  // amountCents is stored non-negative; direction is encoded by kind.
  const sign = raw.kind === "repayment" ? -1 : 1;
  return {
    id: raw.id,
    kind: raw.kind,
    amount: (sign * raw.amountCents) / 100,
    poId: raw.poId,
    ref: raw.ref,
    note: raw.note,
    dueDate: iso(raw.dueDate),
    status: raw.status,
    createdAt: iso(raw.createdAt) ?? "",
  };
}

// ─── procurement.* inputs (UI-facing, ₦) ────────────────────────────────────

export interface CreatePoInput {
  tenantId: string;
  supplierTenantId: string;
  lines: PoLine[];
  paymentMode: PoPaymentMode;
  termsDays?: number;
  notes?: string;
}

export interface CreatePoOutcome {
  po: PurchaseOrder;
  autoApproved: boolean;
}

export interface ListPosInput {
  tenantId: string;
  side: "buyer" | "supplier";
  status?: PoStatus;
}

export interface ApprovePoOutcome {
  approved: boolean;
  /** Business-level credit guard failure (no account / over limit / frozen). */
  creditFailure?: string;
  /** Pay-now checkout URL generated at approval (supplier can share it). */
  paymentUrl?: string | null;
}

export interface UpsertSupplierProfileInput {
  tenantId: string;
  categories: string[];
  /** ₦ — converted to moqCents for the backend. */
  moq: number;
  leadTimeDays: number;
  termsDays: number[];
}

export interface ListAccountsInput {
  tenantId: string;
  side: "buyer" | "supplier";
}

export interface UpsertAccountInput {
  tenantId: string;
  accountId?: string;
  buyerTenantId?: string;
  /** ₦ — converted to cents for the backend. */
  limit: number;
  termsDays: number;
}

export interface SuggestedLimit {
  score: number;
  /** ₦ (normalized from suggestedLimitCents). */
  suggested: number;
  reasons: string[];
}

// ─── procurement.* (S2 — real router: server/routers/procurement.ts) ────────

export function useSuppliers(tenantId: string, opts?: QOpts): QueryResult<SupplierSummary[]> {
  return trpc.procurement.listSuppliers.useQuery(
    { tenantId, limit: 100 },
    { enabled: !!tenantId && opts?.enabled !== false, select: (rows) => (rows as RawDirectoryEntry[]).map(normalizeSupplier) },
  ) as QueryResult<SupplierSummary[]>;
}

export function useWholesaleCatalog(tenantId: string, supplierTenantId: string | null, opts?: QOpts): QueryResult<SupplierCatalog> {
  return trpc.procurement.getWholesaleCatalog.useQuery(
    { tenantId, supplierTenantId: supplierTenantId ?? "", limit: 50 },
    { enabled: !!tenantId && !!supplierTenantId && opts?.enabled !== false, select: (c) => normalizeCatalog(c as RawWholesaleCatalog) },
  ) as QueryResult<SupplierCatalog>;
}

/** The active tenant's own supplier profile (for the directory edit dialog). */
export function useMySupplierProfile(tenantId: string, opts?: QOpts) {
  return trpc.procurement.getMySupplierProfile.useQuery(
    { tenantId },
    { enabled: !!tenantId && opts?.enabled !== false },
  );
}

export function useUpsertSupplierProfile(opts?: MutationOpts<unknown>): MutationResult<UpsertSupplierProfileInput, unknown> {
  const m = trpc.procurement.upsertSupplierProfile.useMutation(opts);
  const toBackend = (v: UpsertSupplierProfileInput) => ({
    tenantId: v.tenantId,
    categories: v.categories,
    moqCents: Math.round(v.moq * 100),
    leadTimeDays: v.leadTimeDays,
    termsOffered: v.termsDays,
    defaultTermsDays: v.termsDays[0],
  });
  return {
    ...m,
    mutate: (v) => m.mutate(toBackend(v)),
    mutateAsync: (v) => m.mutateAsync(toBackend(v)),
  };
}

export function useCreatePo(opts?: MutationOpts<CreatePoOutcome>): MutationResult<CreatePoInput, CreatePoOutcome> {
  const m = trpc.procurement.createPo.useMutation({
    onSuccess: (r) =>
      opts?.onSuccess?.({ po: normalizePo(r.po as unknown as RawPoRow), autoApproved: r.autoApproved }),
    onError: opts?.onError,
  });
  const toBackend = (v: CreatePoInput) => ({
    buyerTenantId: v.tenantId,
    supplierTenantId: v.supplierTenantId,
    paymentMode: v.paymentMode,
    termsDays: v.termsDays,
    notes: v.notes,
    lines: v.lines.map((l) => ({
      productRef: l.catalogItemId ?? undefined,
      name: l.name,
      qty: Math.round(l.quantity),
      unitPriceCents: Math.round(l.unitPrice * 100),
    })),
  });
  return {
    ...m,
    mutate: (v) => m.mutate(toBackend(v)),
    mutateAsync: (v) => m.mutateAsync(toBackend(v)).then((r) => ({
      po: normalizePo(r.po as unknown as RawPoRow),
      autoApproved: r.autoApproved,
    })),
  };
}

export function usePos(input: ListPosInput, opts?: QOpts): QueryResult<PurchaseOrder[]> {
  return trpc.procurement.listPos.useQuery(
    { tenantId: input.tenantId, role: input.side, status: input.status, limit: 200 },
    { enabled: !!input.tenantId && opts?.enabled !== false, select: (rows) => (rows as unknown as RawPoRow[]).map((r) => normalizePo(r)) },
  ) as QueryResult<PurchaseOrder[]>;
}

export function usePo(tenantId: string, poId: string | null, opts?: QOpts): QueryResult<PurchaseOrder> {
  void tenantId; // getPo authorizes either side by poId alone
  return trpc.procurement.getPo.useQuery(
    { poId: poId ?? "" },
    { enabled: !!poId && opts?.enabled !== false, select: (r) => normalizePo(r.po as unknown as RawPoRow, r.items as unknown as RawPoItem[]) },
  ) as QueryResult<PurchaseOrder>;
}

export function useApprovePo(opts?: MutationOpts<ApprovePoOutcome>): MutationResult<{ poId: string; termsDays?: number }, ApprovePoOutcome> {
  const m = trpc.procurement.approvePo.useMutation({
    onSuccess: (r) => {
      if (r.approved) {
        opts?.onSuccess?.({ approved: true, paymentUrl: (r.result as { paymentUrl?: string | null }).paymentUrl ?? null });
      } else {
        opts?.onSuccess?.({ approved: false, creditFailure: r.creditFailure });
      }
    },
    onError: opts?.onError,
  });
  return {
    ...m,
    mutate: (v) => m.mutate(v),
    mutateAsync: (v) =>
      m.mutateAsync(v).then((r): ApprovePoOutcome =>
        r.approved
          ? { approved: true, paymentUrl: (r.result as { paymentUrl?: string | null }).paymentUrl ?? null }
          : { approved: false, creditFailure: r.creditFailure },
      ),
  };
}

export function useRejectPo(opts?: MutationOpts<unknown>): MutationResult<{ poId: string; reason?: string }, unknown> {
  return trpc.procurement.rejectPo.useMutation(opts) as MutationResult<{ poId: string; reason?: string }, unknown>;
}

/** Buyer-side cancel — only DRAFT POs can be cancelled (cancelDraftPo). */
export function useCancelPo(opts?: MutationOpts<unknown>): MutationResult<{ tenantId: string; poId: string }, unknown> {
  const m = trpc.procurement.cancelDraftPo.useMutation(opts);
  return {
    ...m,
    mutate: (v) => m.mutate({ poId: v.poId, buyerTenantId: v.tenantId }),
    mutateAsync: (v) => m.mutateAsync({ poId: v.poId, buyerTenantId: v.tenantId }),
  };
}

/** Supplier marks an approved PO as delivered/fulfilled. */
export function useMarkFulfilled(opts?: MutationOpts<unknown>): MutationResult<{ poId: string }, unknown> {
  return trpc.procurement.markFulfilled.useMutation(opts) as MutationResult<{ poId: string }, unknown>;
}

/** Supplier manually confirms payment receipt on a pay-now PO. */
export function useMarkPaid(opts?: MutationOpts<unknown>): MutationResult<{ poId: string; reference?: string }, unknown> {
  return trpc.procurement.markPaid.useMutation(opts) as MutationResult<{ poId: string; reference?: string }, unknown>;
}

// ─── tradeCredit.* (S1 — real router: server/routers/tradeCredit.ts) ────────

/**
 * Credit accounts for the active tenant. Buyer side → myAccounts (own
 * facilities across suppliers); supplier side → listAccounts (portfolio with
 * aging buckets). Rows are normalized from cents to ₦.
 */
export function useCreditAccounts(input: ListAccountsInput, opts?: QOpts): QueryResult<CreditAccount[]> {
  const enabled = !!input.tenantId && opts?.enabled !== false;
  const select = (rows: unknown) => (rows as RawCreditAccount[]).map(normalizeAccount);
  if (input.side === "supplier") {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return trpc.tradeCredit.listAccounts.useQuery({ supplierTenantId: input.tenantId }, { enabled, select }) as QueryResult<CreditAccount[]>;
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return trpc.tradeCredit.myAccounts.useQuery({ buyerTenantId: input.tenantId }, { enabled, select }) as QueryResult<CreditAccount[]>;
}

/** Ledger for one account; `side` selects the buyer- or supplier-gated procedure. */
export function useCreditLedger(
  tenantId: string,
  accountId: string | null,
  side: "buyer" | "supplier" = "buyer",
  opts?: QOpts,
): QueryResult<LedgerEntry[]> {
  const enabled = !!tenantId && !!accountId && opts?.enabled !== false;
  const select = (rows: unknown) => (rows as RawLedgerEntry[]).map(normalizeLedgerEntry);
  if (side === "supplier") {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return trpc.tradeCredit.accountLedger.useQuery({ supplierTenantId: tenantId, accountId: accountId ?? "" }, { enabled, select }) as QueryResult<LedgerEntry[]>;
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return trpc.tradeCredit.myLedger.useQuery({ buyerTenantId: tenantId, accountId: accountId ?? "" }, { enabled, select }) as QueryResult<LedgerEntry[]>;
}

/** Supplier-side deterministic limit suggestion for a buyer (supplier-gated). */
export function useSuggestLimit(supplierTenantId: string, buyerTenantId: string | null, opts?: QOpts): QueryResult<SuggestedLimit> {
  return trpc.tradeCredit.suggestLimit.useQuery(
    { supplierTenantId, buyerTenantId: buyerTenantId ?? "" },
    {
      enabled: !!supplierTenantId && !!buyerTenantId && opts?.enabled !== false,
      select: (r): SuggestedLimit => ({
        score: r.score,
        suggested: r.suggestedLimitCents / 100,
        reasons: r.reasons ?? [],
      }),
    },
  ) as QueryResult<SuggestedLimit>;
}

/** Buyer-side ledgers for many accounts at once (dashboard rollups). */
export function useBuyerLedgers(
  tenantId: string,
  accountIds: string[],
): Array<{ data: LedgerEntry[] | undefined; isLoading: boolean }> {
  return trpc.useQueries((t) =>
    accountIds.map((accountId) =>
      t.tradeCredit.myLedger(
        { buyerTenantId: tenantId, accountId },
        { select: (rows) => (rows as RawLedgerEntry[]).map(normalizeLedgerEntry) },
      ),
    ),
  ) as Array<{ data: LedgerEntry[] | undefined; isLoading: boolean }>;
}

/**
 * Buyer asks a supplier to open a credit facility. No backend endpoint exists
 * this wave — the call fails gracefully and the UI shows a friendly hint;
 * if a requestAccount procedure lands later it starts working automatically.
 */
export function useRequestCreditAccount(opts?: MutationOpts<unknown>): MutationResult<{ tenantId: string; supplierTenantId: string; requestedLimit?: number; note?: string }, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (trpc as any).tradeCredit.requestAccount.useMutation(opts);
}

/** Buyer-side limit-increase request (₦ in, requestedLimitCents out). */
export function useRequestLimitIncrease(
  opts?: MutationOpts<unknown>,
): MutationResult<{ tenantId: string; accountId: string; requestedLimit: number; reason?: string }, unknown> {
  const m = trpc.tradeCredit.requestLimitIncrease.useMutation(opts);
  const toBackend = (v: { tenantId: string; accountId: string; requestedLimit: number; reason?: string }) => ({
    buyerTenantId: v.tenantId,
    accountId: v.accountId,
    requestedLimitCents: Math.round(v.requestedLimit * 100),
    note: v.reason,
  });
  return {
    ...m,
    mutate: (v) => m.mutate(toBackend(v)),
    mutateAsync: (v) => m.mutateAsync(toBackend(v)),
  };
}

/**
 * Supplier-side upsert: with accountId → updateAccount (limit/terms), without
 * → createAccount for a buyer. ₦ in, limitCents out.
 */
export function useUpsertAccount(opts?: MutationOpts<unknown>): MutationResult<UpsertAccountInput, unknown> {
  const update = trpc.tradeCredit.updateAccount.useMutation(opts);
  const create = trpc.tradeCredit.createAccount.useMutation(opts);
  return {
    isPending: update.isPending || create.isPending,
    mutate: (v) => {
      if (v.accountId) {
        update.mutate({ supplierTenantId: v.tenantId, accountId: v.accountId, limitCents: Math.round(v.limit * 100), termsDays: v.termsDays });
      } else {
        create.mutate({ supplierTenantId: v.tenantId, buyerTenantId: v.buyerTenantId!, limitCents: Math.round(v.limit * 100), termsDays: v.termsDays });
      }
    },
    mutateAsync: (v) => {
      if (v.accountId) {
        return update.mutateAsync({ supplierTenantId: v.tenantId, accountId: v.accountId, limitCents: Math.round(v.limit * 100), termsDays: v.termsDays });
      }
      return create.mutateAsync({ supplierTenantId: v.tenantId, buyerTenantId: v.buyerTenantId!, limitCents: Math.round(v.limit * 100), termsDays: v.termsDays });
    },
  };
}

function useSetAccountStatus(status: "frozen" | "active", opts?: MutationOpts<unknown>): MutationResult<{ tenantId: string; accountId: string }, unknown> {
  const m = trpc.tradeCredit.setAccountStatus.useMutation(opts);
  return {
    ...m,
    mutate: (v) => m.mutate({ supplierTenantId: v.tenantId, accountId: v.accountId, status }),
    mutateAsync: (v) => m.mutateAsync({ supplierTenantId: v.tenantId, accountId: v.accountId, status }),
  };
}

export function useFreezeAccount(opts?: MutationOpts<unknown>) {
  return useSetAccountStatus("frozen", opts);
}

export function useUnfreezeAccount(opts?: MutationOpts<unknown>) {
  return useSetAccountStatus("active", opts);
}

// ─── creditRepay.* (S3 — real router: server/routers/creditRepay.ts) ────────

/**
 * Buyer requests a Paystack repayment link. Backend returns
 * { paymentUrl, reference, amountCents, … }; the UI contract is { url }.
 * `amount` is ₦ (converted to amountCents; omitted → full outstanding).
 */
export function useRequestRepaymentLink(
  opts?: MutationOpts<{ url: string }>,
): MutationResult<{ tenantId: string; accountId: string; amount?: number; poId?: string }, { url: string }> {
  const m = trpc.creditRepay.requestRepaymentLink.useMutation({
    onSuccess: (r) => opts?.onSuccess?.({ url: r.paymentUrl }),
    onError: opts?.onError,
  });
  const toBackend = (v: { tenantId: string; accountId: string; amount?: number; poId?: string }) => ({
    tenantId: v.tenantId,
    accountId: v.accountId,
    ...(v.amount != null ? { amountCents: Math.round(v.amount * 100) } : {}),
    ...(v.poId ? { poId: v.poId } : {}),
  });
  return {
    ...m,
    mutate: (v) => m.mutate(toBackend(v)),
    mutateAsync: (v) => m.mutateAsync(toBackend(v)).then((r) => ({ url: r.paymentUrl })),
  };
}

// ─── Tenant directory (typed, pre-existing router) ──────────────────────────

/** tenantId → business name map for counterparty display. */
export function useTenantNames(): Map<string, string> {
  const { data } = trpc.tenant.list.useQuery({ limit: 200 });
  const map = new Map<string, string>();
  for (const t of (data ?? []) as Array<{ id: string; name: string }>) map.set(t.id, t.name);
  return map;
}

// ─── Cache invalidation ─────────────────────────────────────────────────────

/** Typed utils proxy for query invalidation after mutations. */
export function useB2bUtils() {
  return trpc.useUtils();
}
