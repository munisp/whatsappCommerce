/**
 * b2b.ts — typed access layer for the wave-8 supply-chain tRPC routers
 * (procurement / tradeCredit / creditRepay).
 *
 * Those backend routers merge with wave-8 S1–S3; until their types land in
 * AppRouter this module casts the shared client and re-exposes strongly-typed
 * hook wrappers, so the client compiles standalone today and binds to the
 * real procedures at runtime after the rebase. Input/output shapes mirror the
 * backend contracts in client/src/lib/b2bLogic.ts — keep them in sync.
 */
import { trpc } from "@/lib/trpc";
import type {
  CreditAccount,
  LedgerEntry,
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

// ─── Inputs ─────────────────────────────────────────────────────────────────

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
  limit: number;
  termsDays: number;
}

export interface SuggestedLimit {
  suggested: number;
  reasons: string[];
}

// ─── procurement.* ──────────────────────────────────────────────────────────

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

// ─── tradeCredit.* ──────────────────────────────────────────────────────────

export function useCreditAccounts(input: ListAccountsInput, opts?: QOpts): QueryResult<CreditAccount[]> {
  return api.tradeCredit.listAccounts.useQuery(input, { enabled: !!input.tenantId && opts?.enabled !== false });
}

export function useCreditAccount(tenantId: string, accountId: string | null, opts?: QOpts): QueryResult<CreditAccount> {
  return api.tradeCredit.getAccount.useQuery({ tenantId, accountId }, { enabled: !!tenantId && !!accountId && opts?.enabled !== false });
}

export function useCreditLedger(tenantId: string, accountId: string | null, opts?: QOpts): QueryResult<LedgerEntry[]> {
  return api.tradeCredit.listLedger.useQuery({ tenantId, accountId }, { enabled: !!tenantId && !!accountId && opts?.enabled !== false });
}

export function useSuggestLimit(tenantId: string, accountId: string | null, opts?: QOpts): QueryResult<SuggestedLimit> {
  return api.tradeCredit.suggestLimit.useQuery({ tenantId, accountId }, { enabled: !!tenantId && !!accountId && opts?.enabled !== false });
}

export function useRequestCreditAccount(opts?: MutationOpts<CreditAccount>): MutationResult<{ tenantId: string; supplierTenantId: string; requestedLimit?: number; note?: string }, CreditAccount> {
  // Buyer initiates a credit relationship with a supplier (supplier approves
  // and sets the limit via upsertAccount on their side).
  return api.tradeCredit.requestAccount.useMutation(opts);
}

export function useRequestLimitIncrease(opts?: MutationOpts<CreditAccount>): MutationResult<{ tenantId: string; accountId: string; requestedLimit: number; reason?: string }, CreditAccount> {
  return api.tradeCredit.requestLimitIncrease.useMutation(opts);
}

export function useUpsertAccount(opts?: MutationOpts<CreditAccount>): MutationResult<UpsertAccountInput, CreditAccount> {
  return api.tradeCredit.upsertAccount.useMutation(opts);
}

export function useFreezeAccount(opts?: MutationOpts<CreditAccount>): MutationResult<{ tenantId: string; accountId: string }, CreditAccount> {
  return api.tradeCredit.freezeAccount.useMutation(opts);
}

export function useUnfreezeAccount(opts?: MutationOpts<CreditAccount>): MutationResult<{ tenantId: string; accountId: string }, CreditAccount> {
  return api.tradeCredit.unfreezeAccount.useMutation(opts);
}

// ─── creditRepay.* ──────────────────────────────────────────────────────────

export function useRequestRepaymentLink(opts?: MutationOpts<{ url: string }>): MutationResult<{ tenantId: string; accountId: string; amount?: number }, { url: string }> {
  return api.creditRepay.requestRepaymentLink.useMutation(opts);
}

// ─── Cache invalidation ─────────────────────────────────────────────────────

/**
 * Utils proxy for the wave-8 routers (untyped until the backend merges).
 * Use e.g. `b2bUtils.procurement.listPos.invalidate()` or fall back to
 * `b2bUtils.invalidate()` to refetch everything.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useB2bUtils(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return trpc.useUtils() as any;
}
