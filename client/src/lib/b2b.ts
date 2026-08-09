/**
 * b2b.ts — typed access layer for the wave-8 supply-chain tRPC routers.
 *
 * tradeCredit.* merged with S1 (server/routers/tradeCredit.ts) and this module
 * speaks its REAL contract — inputs use supplierTenantId/buyerTenantId and
 * money columns are *_cents, normalized here to ₦ for the UI. procurement.*
 * (S2) and creditRepay.* (S3) are still in flight; those sections use the
 * agreed contract shapes and bind at runtime after the rebase.
 *
 * The shared client is cast once (`api`) because the new routers' types land
 * with the backend PRs; the wrappers below give the UI stable, typed hooks.
 */
import { trpc } from "@/lib/trpc";
import type {
  AgingBuckets,
  CreditAccount,
  LedgerEntry,
  LedgerKind,
  PoLine,
  PoPaymentMode,
  PoStatus,
  PurchaseOrder,
  SupplierProfile,
  SupplierSummary,
} from "@/lib/b2bLogic";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = trpc as any;

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

// ─── Backend row shapes (drizzle credit_accounts / credit_ledger, superjson) ─

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

// ─── procurement.* inputs (S2 contract) ─────────────────────────────────────

export interface CreatePoInput {
  tenantId: string;
  supplierTenantId: string;
  lines: PoLine[];
  paymentMode: PoPaymentMode;
  termsDays?: number;
  notes?: string;
}

export interface ListPosInput {
  tenantId: string;
  side: "buyer" | "supplier";
  status?: PoStatus;
}

export interface UpsertSupplierProfileInput {
  tenantId: string;
  businessName?: string;
  categories: string[];
  moq: number;
  leadTimeDays: number;
  termsDays: number[];
  description?: string;
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

// ─── procurement.* (S2 — agreed contract, binds after rebase) ───────────────

export function useSuppliers(tenantId: string, opts?: QOpts): QueryResult<SupplierSummary[]> {
  return api.procurement.listSuppliers.useQuery({ tenantId }, { enabled: !!tenantId && opts?.enabled !== false });
}

export function useSupplierProfile(tenantId: string, supplierTenantId: string | null, opts?: QOpts): QueryResult<SupplierProfile> {
  return api.procurement.getSupplierProfile.useQuery(
    { tenantId, supplierTenantId },
    { enabled: !!tenantId && !!supplierTenantId && opts?.enabled !== false },
  );
}

export function useUpsertSupplierProfile(opts?: MutationOpts<SupplierProfile>): MutationResult<UpsertSupplierProfileInput, SupplierProfile> {
  return api.procurement.upsertSupplierProfile.useMutation(opts);
}

export function useCreatePo(opts?: MutationOpts<PurchaseOrder>): MutationResult<CreatePoInput, PurchaseOrder> {
  return api.procurement.createPo.useMutation(opts);
}

export function usePos(input: ListPosInput, opts?: QOpts): QueryResult<PurchaseOrder[]> {
  return api.procurement.listPos.useQuery(input, { enabled: !!input.tenantId && opts?.enabled !== false });
}

export function usePo(tenantId: string, poId: string | null, opts?: QOpts): QueryResult<PurchaseOrder> {
  return api.procurement.getPo.useQuery({ tenantId, poId }, { enabled: !!tenantId && !!poId && opts?.enabled !== false });
}

export function useApprovePo(opts?: MutationOpts<PurchaseOrder>): MutationResult<{ tenantId: string; poId: string }, PurchaseOrder> {
  return api.procurement.approvePo.useMutation(opts);
}

export function useRejectPo(opts?: MutationOpts<PurchaseOrder>): MutationResult<{ tenantId: string; poId: string; reason: string }, PurchaseOrder> {
  return api.procurement.rejectPo.useMutation(opts);
}

export function useCancelPo(opts?: MutationOpts<PurchaseOrder>): MutationResult<{ tenantId: string; poId: string }, PurchaseOrder> {
  return api.procurement.cancelPo.useMutation(opts);
}

// ─── tradeCredit.* (S1 — REAL contract: server/routers/tradeCredit.ts) ──────

/**
 * Credit accounts for the active tenant. Buyer side → myAccounts (own
 * facilities across suppliers); supplier side → listAccounts (portfolio with
 * aging buckets). Rows are normalized from cents to ₦.
 */
export function useCreditAccounts(input: ListAccountsInput, opts?: QOpts): QueryResult<CreditAccount[]> {
  const enabled = !!input.tenantId && opts?.enabled !== false;
  const select = (rows: RawCreditAccount[]) => (rows ?? []).map(normalizeAccount);
  if (input.side === "supplier") {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return api.tradeCredit.listAccounts.useQuery({ supplierTenantId: input.tenantId }, { enabled, select });
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return api.tradeCredit.myAccounts.useQuery({ buyerTenantId: input.tenantId }, { enabled, select });
}

/** Ledger for one account; `side` selects the buyer- or supplier-gated procedure. */
export function useCreditLedger(
  tenantId: string,
  accountId: string | null,
  side: "buyer" | "supplier" = "buyer",
  opts?: QOpts,
): QueryResult<LedgerEntry[]> {
  const enabled = !!tenantId && !!accountId && opts?.enabled !== false;
  const select = (rows: RawLedgerEntry[]) => (rows ?? []).map(normalizeLedgerEntry);
  if (side === "supplier") {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return api.tradeCredit.accountLedger.useQuery({ supplierTenantId: tenantId, accountId }, { enabled, select });
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return api.tradeCredit.myLedger.useQuery({ buyerTenantId: tenantId, accountId }, { enabled, select });
}

/** Supplier-side deterministic limit suggestion for a buyer (supplier-gated). */
export function useSuggestLimit(supplierTenantId: string, buyerTenantId: string | null, opts?: QOpts): QueryResult<SuggestedLimit> {
  return api.tradeCredit.suggestLimit.useQuery(
    { supplierTenantId, buyerTenantId },
    {
      enabled: !!supplierTenantId && !!buyerTenantId && opts?.enabled !== false,
      select: (r: { score: number; suggestedLimitCents: number; reasons: string[] }): SuggestedLimit => ({
        score: r.score,
        suggested: r.suggestedLimitCents / 100,
        reasons: r.reasons ?? [],
      }),
    },
  );
}

/** Buyer-side ledgers for many accounts at once (dashboard rollups). */
export function useBuyerLedgers(
  tenantId: string,
  accountIds: string[],
): Array<{ data: LedgerEntry[] | undefined; isLoading: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return api.useQueries((t: any) =>
    accountIds.map((accountId) =>
      t.tradeCredit.myLedger(
        { buyerTenantId: tenantId, accountId },
        { select: (rows: RawLedgerEntry[]) => (rows ?? []).map(normalizeLedgerEntry) },
      ),
    ),
  );
}

/**
 * Buyer asks a supplier to open a credit facility. Lands with S2/S3; until
 * then the mutation fails with a surfaced error toast.
 */
export function useRequestCreditAccount(opts?: MutationOpts<CreditAccount>): MutationResult<{ tenantId: string; supplierTenantId: string; requestedLimit?: number; note?: string }, CreditAccount> {
  return api.tradeCredit.requestAccount.useMutation(opts);
}

/** Buyer-side limit-increase request (₦ in, requestedLimitCents out). */
export function useRequestLimitIncrease(
  opts?: MutationOpts<unknown>,
): MutationResult<{ tenantId: string; accountId: string; requestedLimit: number; reason?: string }, unknown> {
  const m = api.tradeCredit.requestLimitIncrease.useMutation(opts);
  return {
    ...m,
    mutate: (v) =>
      m.mutate({
        buyerTenantId: v.tenantId,
        accountId: v.accountId,
        requestedLimitCents: Math.round(v.requestedLimit * 100),
        note: v.reason,
      }),
    mutateAsync: (v) =>
      m.mutateAsync({
        buyerTenantId: v.tenantId,
        accountId: v.accountId,
        requestedLimitCents: Math.round(v.requestedLimit * 100),
        note: v.reason,
      }),
  };
}

/**
 * Supplier-side upsert: with accountId → updateAccount (limit/terms), without
 * → createAccount for a buyer. ₦ in, limitCents out.
 */
export function useUpsertAccount(opts?: MutationOpts<unknown>): MutationResult<UpsertAccountInput, unknown> {
  const update = api.tradeCredit.updateAccount.useMutation(opts);
  const create = api.tradeCredit.createAccount.useMutation(opts);
  const toBackend = (v: UpsertAccountInput) => ({
    supplierTenantId: v.tenantId,
    accountId: v.accountId,
    buyerTenantId: v.buyerTenantId,
    limitCents: Math.round(v.limit * 100),
    termsDays: v.termsDays,
  });
  return {
    isPending: update.isPending || create.isPending,
    mutate: (v) => {
      const b = toBackend(v);
      if (v.accountId) {
        update.mutate({ supplierTenantId: b.supplierTenantId, accountId: b.accountId!, limitCents: b.limitCents, termsDays: b.termsDays });
      } else {
        create.mutate({ supplierTenantId: b.supplierTenantId, buyerTenantId: b.buyerTenantId!, limitCents: b.limitCents, termsDays: b.termsDays });
      }
    },
    mutateAsync: (v) => {
      const b = toBackend(v);
      if (v.accountId) {
        return update.mutateAsync({ supplierTenantId: b.supplierTenantId, accountId: b.accountId!, limitCents: b.limitCents, termsDays: b.termsDays });
      }
      return create.mutateAsync({ supplierTenantId: b.supplierTenantId, buyerTenantId: b.buyerTenantId!, limitCents: b.limitCents, termsDays: b.termsDays });
    },
  };
}

function useSetAccountStatus(status: "frozen" | "active", opts?: MutationOpts<unknown>): MutationResult<{ tenantId: string; accountId: string }, unknown> {
  const m = api.tradeCredit.setAccountStatus.useMutation(opts);
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

// ─── creditRepay.* (S3 — REAL contract: server/routers/creditRepay.ts) ──────

/**
 * Buyer requests a Paystack repayment link. Backend returns
 * { paymentUrl, reference, amountCents, … }; the UI contract is { url }.
 * `amount` is ₦ (converted to amountCents; omitted → full outstanding).
 */
export function useRequestRepaymentLink(
  opts?: MutationOpts<{ url: string }>,
): MutationResult<{ tenantId: string; accountId: string; amount?: number; poId?: string }, { url: string }> {
  const m = api.creditRepay.requestRepaymentLink.useMutation({
    onSuccess: (r: { paymentUrl: string }) => opts?.onSuccess?.({ url: r.paymentUrl }),
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
    mutateAsync: (v) => m.mutateAsync(toBackend(v)),
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

/**
 * Utils proxy for the wave-8 routers (untyped until the backend merges).
 * Use e.g. `b2bUtils.tradeCredit.myAccounts.invalidate()` or fall back to
 * `b2bUtils.invalidate()` to refetch everything.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useB2bUtils(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return trpc.useUtils() as any;
}
