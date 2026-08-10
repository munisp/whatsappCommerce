/**
 * CreditAccounts — trade-credit workspace (route /credit-accounts).
 *
 * "As buyer": my credit facilities with suppliers (tradeCredit.myAccounts) —
 * limit gauge, outstanding, next due date derived from the ledger, ledger
 * table with kind badges, Repay (RepaymentDialog → creditRepay link) and
 * Request-increase (tradeCredit.requestLimitIncrease) CTAs.
 *
 * "As supplier": facilities I extend to buyers (tradeCredit.listAccounts with
 * aging) — score with reasons tooltip, editable limit/terms
 * (tradeCredit.updateAccount), freeze/unfreeze (setAccountStatus) with
 * confirmation, aging-bucket summary cards across the book, and a
 * deterministic limit suggestion (suggestLimit) inside the terms dialog.
 */
import { useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { CreditAgingCards } from "@/components/b2b/CreditAgingTable";
import { LimitGauge } from "@/components/b2b/LimitGauge";
import { RepaymentDialog } from "@/components/b2b/RepaymentDialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useActiveTenant } from "@/contexts/TenantContext";
import {
  useB2bUtils, useCreditAccounts, useCreditLedger, useFreezeAccount,
  useRequestLimitIncrease, useSuggestLimit, useTenantNames, useUnfreezeAccount, useUpsertAccount,
} from "@/lib/b2b";
import {
  dueCountdown, formatDate, formatNaira, ledgerKindMeta, nextDueFromLedger, validateLimitForm,
  type AgingBuckets, type CreditAccount, type LedgerEntry,
} from "@/lib/b2bLogic";
import {
  HandCoins, Info, Loader2, Pencil, Snowflake, Sun, TrendingUp, Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";

// ─── Shared bits ────────────────────────────────────────────────────────────

function LedgerTable({ ledger }: { ledger: LedgerEntry[] }) {
  if (ledger.length === 0) {
    return <p className="text-sm text-muted-foreground py-6 text-center">No ledger entries yet.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Reference</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ledger.map((e) => {
          const meta = ledgerKindMeta(e.kind);
          return (
            <TableRow key={e.id}>
              <TableCell className="text-xs text-muted-foreground">{formatDate(e.createdAt)}</TableCell>
              <TableCell>
                <Badge variant="outline" className={`font-normal ${meta.className}`}>{meta.label}</Badge>
              </TableCell>
              <TableCell className="text-xs">
                {e.poId ? <span className="font-mono">PO {e.poId.slice(0, 8)}</span> : (e.note ?? e.ref ?? "—")}
              </TableCell>
              <TableCell className={`text-right font-medium ${e.amount < 0 ? "text-emerald-400" : ""}`}>
                {formatNaira(e.amount)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function AccountStatusBadge({ status }: { status: CreditAccount["status"] }) {
  return (
    <Badge
      variant="outline"
      className={`font-normal ${status === "active" ? "border-emerald-500/40 text-emerald-400" : status === "frozen" ? "border-amber-500/40 text-amber-400" : "border-border text-muted-foreground"}`}
    >
      {status}
    </Badge>
  );
}

// ─── Buyer view ─────────────────────────────────────────────────────────────

function RequestIncreaseDialog({
  tenantId,
  account,
  open,
  onOpenChange,
}: {
  tenantId: string;
  account: CreditAccount;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = useB2bUtils();
  const [requested, setRequested] = useState("");
  const [reason, setReason] = useState("");

  const requestIncrease = useRequestLimitIncrease({
    onSuccess: () => {
      toast.success("Limit increase requested — the supplier will review it");
      utils?.tradeCredit?.myAccounts?.invalidate();
      utils?.tradeCredit?.myLedger?.invalidate();
      onOpenChange(false);
      setRequested("");
      setReason("");
    },
    onError: (e) => toast.error(e.message),
  });

  const parsed = Number(requested);
  const valid = Number.isFinite(parsed) && parsed > account.limit;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request limit increase</DialogTitle>
          <DialogDescription>
            Current limit with {account.counterpartyName}: {formatNaira(account.limit)}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ri-amount">Requested limit (₦)</Label>
            <Input id="ri-amount" type="number" min={0} value={requested} onChange={(e) => setRequested(e.target.value)} />
            {requested.trim() !== "" && !valid && (
              <p className="text-xs text-destructive">Requested limit must be higher than the current limit.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ri-reason">Reason (optional)</Label>
            <Textarea id="ri-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={!valid || requestIncrease.isPending}
            onClick={() => requestIncrease.mutate({ tenantId, accountId: account.id, requestedLimit: parsed, reason: reason.trim() || undefined })}
          >
            {requestIncrease.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            Send request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One buyer-side facility card; fetches its own ledger for next-due + table. */
function BuyerAccountCard({
  tenantId,
  account,
  name,
  onRepay,
  onRequestIncrease,
}: {
  tenantId: string;
  account: CreditAccount;
  name: string;
  onRepay: () => void;
  onRequestIncrease: () => void;
}) {
  const { data: ledger, isLoading: ledgerLoading } = useCreditLedger(tenantId, account.id, "buyer");
  const [ledgerOpen, setLedgerOpen] = useState(false);

  const nextDue = useMemo(() => nextDueFromLedger(ledger ?? []), [ledger]);
  const due = dueCountdown(nextDue);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base">{name}</CardTitle>
            <CardDescription>Net {account.termsDays}d terms</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <AccountStatusBadge status={account.status} />
            <Button size="sm" variant="outline" className="gap-1" onClick={onRequestIncrease}>
              <TrendingUp className="w-3.5 h-3.5" /> Request increase
            </Button>
            <Button
              size="sm" className="gap-1"
              disabled={account.status !== "active" || account.outstanding <= 0}
              onClick={onRepay}
            >
              <HandCoins className="w-3.5 h-3.5" /> Repay
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div className="md:col-span-2">
            <LimitGauge used={account.outstanding} limit={account.limit} />
          </div>
          <div className="text-sm">
            <p className="text-xs text-muted-foreground">Next due</p>
            <p className="font-medium">{ledgerLoading ? "…" : formatDate(nextDue)}</p>
            {nextDue && (
              <p className={`text-xs ${due.tone === "danger" ? "text-red-400" : due.tone === "warn" ? "text-amber-400" : "text-muted-foreground"}`}>
                {due.label}
              </p>
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" className="text-xs text-muted-foreground px-0" onClick={() => setLedgerOpen((v) => !v)}>
          {ledgerOpen ? "Hide ledger ▲" : "Show ledger ▼"}
        </Button>
        {ledgerOpen && (
          ledgerLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-6 justify-center text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading ledger…
            </div>
          ) : (
            <LedgerTable ledger={ledger ?? []} />
          )
        )}
      </CardContent>
    </Card>
  );
}

function BuyerView({ tenantId }: { tenantId: string }) {
  const { data: accounts, isLoading, error, refetch } = useCreditAccounts({ tenantId, side: "buyer" });
  const tenantNames = useTenantNames();
  const [repayAccount, setRepayAccount] = useState<CreditAccount | null>(null);
  const [increaseAccount, setIncreaseAccount] = useState<CreditAccount | null>(null);

  const named = useMemo(
    () => (accounts ?? []).map((a) => ({ ...a, counterpartyName: tenantNames.get(a.supplierTenantId) ?? a.supplierTenantId })),
    [accounts, tenantNames],
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-16 justify-center">
        <Loader2 className="w-5 h-5 animate-spin" /> Loading credit accounts…
      </div>
    );
  }
  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
          <p className="text-sm font-medium">Could not load credit accounts</p>
          <p className="text-xs text-muted-foreground max-w-md">{error.message}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }
  if (named.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
          <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
            <Wallet className="h-7 w-7 text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium">No credit accounts yet</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md">
              Request credit from a supplier in the Supplier Directory to start buying on terms.
            </p>
          </div>
          <Link href="/suppliers">
            <Button size="sm" variant="outline">Browse suppliers</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {named.map((a) => (
        <BuyerAccountCard
          key={a.id}
          tenantId={tenantId}
          account={a}
          name={a.counterpartyName}
          onRepay={() => setRepayAccount(a)}
          onRequestIncrease={() => setIncreaseAccount(a)}
        />
      ))}

      {repayAccount && (
        <RepaymentDialog
          tenantId={tenantId}
          accountId={repayAccount.id}
          counterpartyName={repayAccount.counterpartyName}
          outstanding={repayAccount.outstanding}
          open={!!repayAccount}
          onOpenChange={(o) => !o && setRepayAccount(null)}
        />
      )}
      {increaseAccount && (
        <RequestIncreaseDialog
          tenantId={tenantId}
          account={increaseAccount}
          open={!!increaseAccount}
          onOpenChange={(o) => !o && setIncreaseAccount(null)}
        />
      )}
    </div>
  );
}

// ─── Supplier view ──────────────────────────────────────────────────────────

function EditAccountDialog({
  tenantId,
  account,
  name,
  open,
  onOpenChange,
}: {
  tenantId: string;
  account: CreditAccount;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = useB2bUtils();
  const { data: suggestion } = useSuggestLimit(tenantId, account.buyerTenantId, { enabled: open });
  const [form, setForm] = useState({ limit: String(account.limit), termsDays: String(account.termsDays) });
  const errors = validateLimitForm(form);

  const save = useUpsertAccount({
    onSuccess: () => {
      toast.success(`Updated credit terms for ${name}`);
      utils?.tradeCredit?.listAccounts?.invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Credit terms — {name}</DialogTitle>
          <DialogDescription>
            {suggestion
              ? `Suggested limit ${formatNaira(suggestion.suggested)} (score ${suggestion.score}) based on repayment history.`
              : "Adjust the credit limit and payment terms for this buyer."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="ea-limit">Limit (₦)</Label>
            <Input
              id="ea-limit" type="number" min={0}
              value={form.limit}
              className={errors.limit ? "border-destructive" : ""}
              onChange={(e) => setForm((f) => ({ ...f, limit: e.target.value }))}
            />
            {errors.limit && <p className="text-xs text-destructive">{errors.limit}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ea-terms">Terms (days)</Label>
            <Input
              id="ea-terms" type="number" min={1} max={90}
              value={form.termsDays}
              className={errors.termsDays ? "border-destructive" : ""}
              onChange={(e) => setForm((f) => ({ ...f, termsDays: e.target.value }))}
            />
            {errors.termsDays && <p className="text-xs text-destructive">{errors.termsDays}</p>}
          </div>
        </div>
        {suggestion && suggestion.reasons.length > 0 && (
          <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
            {suggestion.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={Object.keys(errors).length > 0 || save.isPending}
            onClick={() => save.mutate({ tenantId, accountId: account.id, limit: Number(form.limit), termsDays: Number(form.termsDays) })}
          >
            {save.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            Save terms
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SupplierView({ tenantId }: { tenantId: string }) {
  const utils = useB2bUtils();
  const { data: accounts, isLoading, error, refetch } = useCreditAccounts({ tenantId, side: "supplier" });
  const tenantNames = useTenantNames();
  const [editAccount, setEditAccount] = useState<CreditAccount | null>(null);
  const [freezeTarget, setFreezeTarget] = useState<CreditAccount | null>(null);

  const freeze = useFreezeAccount({
    onSuccess: () => {
      toast.success("Credit account frozen — buyer cannot draw on it");
      utils?.tradeCredit?.listAccounts?.invalidate();
      setFreezeTarget(null);
    },
    onError: (e) => toast.error(e.message),
  });
  const unfreeze = useUnfreezeAccount({
    onSuccess: () => {
      toast.success("Credit account reactivated");
      utils?.tradeCredit?.listAccounts?.invalidate();
      setFreezeTarget(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const named = useMemo(
    () => (accounts ?? []).map((a) => ({ ...a, counterpartyName: tenantNames.get(a.buyerTenantId) ?? a.buyerTenantId })),
    [accounts, tenantNames],
  );

  // Aggregate aging across the whole book.
  const bookAging = useMemo<AgingBuckets>(() => {
    const total: AgingBuckets = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, days90plus: 0 };
    for (const a of named) {
      if (!a.aging) continue;
      total.current += a.aging.current;
      total.days1to30 += a.aging.days1to30;
      total.days31to60 += a.aging.days31to60;
      total.days61to90 += a.aging.days61to90;
      total.days90plus += a.aging.days90plus;
    }
    return total;
  }, [named]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-16 justify-center">
        <Loader2 className="w-5 h-5 animate-spin" /> Loading buyer accounts…
      </div>
    );
  }
  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
          <p className="text-sm font-medium">Could not load buyer accounts</p>
          <p className="text-xs text-muted-foreground max-w-md">{error.message}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }
  if (named.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
          <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
            <HandCoins className="h-7 w-7 text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium">No buyers on credit yet</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md">
              When buyers order on credit, their facilities appear here — set limits and terms per buyer.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <CreditAgingCards buckets={bookAging} />

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Buyer</TableHead>
              <TableHead>Score</TableHead>
              <TableHead>Utilization</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {named.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">{a.counterpartyName}</TableCell>
                <TableCell>
                  {a.score != null ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex items-center gap-1 text-sm cursor-help">
                          {a.score}
                          {(a.scoreReasons?.length ?? 0) > 0 && <Info className="w-3.5 h-3.5 text-muted-foreground" />}
                        </span>
                      </TooltipTrigger>
                      {(a.scoreReasons?.length ?? 0) > 0 && (
                        <TooltipContent className="max-w-xs">
                          <ul className="list-disc pl-4 space-y-0.5 text-xs">
                            {a.scoreReasons!.map((r, i) => <li key={i}>{r}</li>)}
                          </ul>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </TableCell>
                <TableCell className="min-w-40">
                  <LimitGauge used={a.outstanding} limit={a.limit} compact />
                </TableCell>
                <TableCell className="text-right">{formatNaira(a.outstanding)}</TableCell>
                <TableCell><AccountStatusBadge status={a.status} /></TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => setEditAccount(a)}>
                      <Pencil className="w-3.5 h-3.5" /> Terms
                    </Button>
                    <Button
                      size="sm" variant="ghost" className="h-8 gap-1"
                      disabled={a.status === "closed"}
                      onClick={() => setFreezeTarget(a)}
                    >
                      {a.status === "frozen" ? <Sun className="w-3.5 h-3.5" /> : <Snowflake className="w-3.5 h-3.5" />}
                      {a.status === "frozen" ? "Unfreeze" : "Freeze"}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {editAccount && (
        <EditAccountDialog
          tenantId={tenantId}
          account={editAccount}
          name={editAccount.counterpartyName}
          open={!!editAccount}
          onOpenChange={(o) => !o && setEditAccount(null)}
        />
      )}

      {/* Freeze / unfreeze confirmation */}
      <AlertDialog open={!!freezeTarget} onOpenChange={(o) => !o && setFreezeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {freezeTarget?.status === "frozen" ? "Unfreeze" : "Freeze"} credit for {freezeTarget?.counterpartyName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {freezeTarget?.status === "frozen"
                ? "The buyer will be able to draw on their credit line again."
                : "The buyer will not be able to place new credit POs until you unfreeze. Existing invoices still age."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction
              disabled={freeze.isPending || unfreeze.isPending}
              onClick={() => {
                if (!freezeTarget) return;
                const input = { tenantId, accountId: freezeTarget.id };
                if (freezeTarget.status === "frozen") unfreeze.mutate(input);
                else freeze.mutate(input);
              }}
            >
              {freeze.isPending || unfreeze.isPending ? "Working…" : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function CreditAccounts() {
  const { activeTenantId: tenantId } = useActiveTenant();
  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Wallet className="w-6 h-6 text-primary" /> Credit Accounts
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Trade credit you use as a buyer and credit you extend as a supplier.
          </p>
        </div>
        <Tabs defaultValue="buyer">
          <TabsList>
            <TabsTrigger value="buyer">As buyer</TabsTrigger>
            <TabsTrigger value="supplier">As supplier</TabsTrigger>
          </TabsList>
          <TabsContent value="buyer" className="mt-4">
            <BuyerView tenantId={tenantId} />
          </TabsContent>
          <TabsContent value="supplier" className="mt-4">
            <SupplierView tenantId={tenantId} />
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
