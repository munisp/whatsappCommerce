import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { toast } from "sonner";
import { useState } from "react";
import { Download, CalendarIcon, X, Check, ChevronsUpDown } from "lucide-react";
import { PlusCircle } from "lucide-react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { cn } from "@/lib/utils";

const TX_TYPE_COLORS: Record<string, string> = {
  escrow_credit: "text-yellow-600",
  escrow_release: "text-green-600",
  escrow_refund: "text-red-500",
  float_income: "text-blue-600",
  withdrawal: "text-gray-600",
  fee_deduction: "text-orange-600",
};

// Coerce any backend amount (string/number/null/undefined/garbage) to a finite
// number so the page can never render NaN or crash on malformed data.
function toNum(val: string | number | null | undefined): number {
  const n = typeof val === "string" ? parseFloat(val) : (val ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function formatNGN(val: string | number | null | undefined) {
  return `₦${toNum(val).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function toISODate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default function MerchantWallet() {
  // Sourced from the session-derived tenant record (not the localStorage-backed
  // TenantContext switcher) — this page moves real money, so tenantId must
  // never be a stale/placeholder client-side value. See PortalDashboard.tsx
  // for the same fix.
  const { data: myTenant } = trpc.tenantPortal.getMyTenant.useQuery();
  const tenantId = myTenant?.id ?? "";
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [selectedBankLabel, setSelectedBankLabel] = useState("");
  const [bankPickerOpen, setBankPickerOpen] = useState(false);
  const [csvLoading, setCsvLoading] = useState(false);
  // Date range picker state
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState("");
  const [topUpNote, setTopUpNote] = useState("");

  const { data: wallet, isLoading: walletLoading, refetch } = trpc.wallet.getBalance.useQuery({ tenantId }, { enabled: !!tenantId });
  const { data: txs, isLoading: txLoading } = trpc.wallet.listTransactions.useQuery({ tenantId, limit: 50 }, { enabled: !!tenantId });
  const { data: config } = trpc.escrow.getConfig.useQuery();
  // Bank list barely ever changes — cache it for the whole session rather
  // than refetching every time the withdrawal dialog opens.
  const { data: banks, isLoading: banksLoading } = trpc.wallet.listBanks.useQuery(undefined, { staleTime: Infinity });
  // The account holder's name is resolved from the bank (NIBSS lookup via
  // Paystack) once both fields are complete, rather than trusted as free
  // text — a typo or mismatch here would send real money to the wrong name.
  const {
    data: resolvedAccount,
    isFetching: resolvingAccount,
    error: resolveError,
  } = trpc.wallet.resolveAccount.useQuery(
    { accountNumber: bankAccount, bankCode },
    { enabled: bankAccount.length === 10 && !!bankCode, retry: false },
  );
  const utils = trpc.useUtils();

  const stepUpRequest = trpc.phoneAuth.stepUpRequest.useMutation();
  const updateBankDetails = trpc.wallet.updatePayoutBankDetails.useMutation();
  const withdraw = trpc.wallet.requestWithdrawal.useMutation({
    onSuccess: (data) => {
      toast.success(`Withdrawal of ${formatNGN(data.amount)} initiated. Ref: ${data.reference}`);
      setWithdrawOpen(false);
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const topUp = trpc.wallet.topUp.useMutation({
    onSuccess: (data: any) => {
      // topUp always returns a real provider checkout link (Paystack/
      // Flutterwave) — the wallet is only ever credited later, via webhook,
      // once the merchant actually completes payment there. Redirect rather
      // than just toasting, or the merchant has no way to actually pay.
      if (data?.paymentUrl) {
        window.location.href = data.paymentUrl;
        return;
      }
      toast.info(`Deposit of ${formatNGN(data.amount)} initiated (Ref: ${data.reference}). It will be credited once your payment provider confirms it.`);
      setTopUpOpen(false);
      setTopUpAmount("");
      setTopUpNote("");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const isPspMode = config?.custodyMode === "psp";

  async function handleExportCsv(startDate?: string, endDate?: string) {
    setCsvLoading(true);
    try {
      const result = await utils.wallet.exportLedgerCsv.fetch({ tenantId, startDate, endDate });
      if (!result?.csv) { toast.info("No transactions found for the selected period."); return; }
      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = result.filename;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
      const rowMsg = result.rowCount != null ? ` (${result.rowCount} rows)` : "";
      toast.success(`Ledger exported${rowMsg}.`);
      setDateRangeOpen(false);
    } catch (e: any) {
      toast.error(e.message ?? "Export failed");
    } finally {
      setCsvLoading(false);
    }
  }

  function handleDateRangeExport() {
    if (dateRange?.from && dateRange?.to) {
      handleExportCsv(toISODate(dateRange.from), toISODate(dateRange.to));
    } else if (dateRange?.from) {
      handleExportCsv(toISODate(dateRange.from), undefined);
    } else {
      handleExportCsv();
    }
  }

  const dateRangeLabel = dateRange?.from
    ? dateRange.to
      ? `${format(dateRange.from, "MMM d, yyyy")} – ${format(dateRange.to, "MMM d, yyyy")}`
      : format(dateRange.from, "MMM d, yyyy")
    : "All time";

  return (
    <DashboardLayout>
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold">Merchant Wallet</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Custody mode:{" "}
            <Badge variant={isPspMode ? "default" : "secondary"} className="ml-1">
              {config?.custodyMode?.toUpperCase() ?? "—"}
            </Badge>
            {!isPspMode && (
              <span className="ml-2 text-xs text-muted-foreground">
                Wallet balances are tracked for reference. Withdrawals require PSP licence.
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isPspMode && (
            <Button onClick={() => setWithdrawOpen(true)} disabled={!wallet || toNum(wallet.availableBalance) <= 0}>
              Request Withdrawal
            </Button>
          )}
          {isPspMode && (
            <Button variant="outline" onClick={() => setTopUpOpen(true)}>
              <PlusCircle className="h-4 w-4 mr-2" />
              Top Up
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setDateRangeOpen(true)}>
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Balance Cards */}
      {walletLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
      ) : wallet ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Available Balance</p>
              <p className="text-2xl font-bold text-green-600">{formatNGN(wallet.availableBalance)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">In Escrow</p>
              <p className="text-2xl font-bold text-yellow-600">{formatNGN(wallet.escrowBalance)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Total Earned</p>
              <p className="text-2xl font-bold">{formatNGN(wallet.totalEarned)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Total Withdrawn</p>
              <p className="text-2xl font-bold text-muted-foreground">{formatNGN(wallet.totalWithdrawn)}</p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card>
          <CardContent className="pt-6 text-center text-muted-foreground py-12">
            No wallet found. A wallet will be created automatically when your first order is processed.
          </CardContent>
        </Card>
      )}

      {/* Transaction History */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Transaction History</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setDateRangeOpen(true)} className="text-xs text-muted-foreground">
              <Download className="h-3.5 w-3.5 mr-1" />
              Export CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {txLoading ? (
            <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : (txs ?? []).length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No transactions yet</p>
          ) : (
            <div className="space-y-0">
              {(txs ?? []).map((tx, idx) => (
                <div key={tx.id ?? idx} className="flex items-center justify-between py-3 border-b last:border-0">
                  <div>
                    <p className="text-sm font-medium">{tx.description ?? (tx.type ?? "transaction").replace(/_/g, " ")}</p>
                    <p className="text-xs text-muted-foreground">
                      {tx.createdAt ? new Date(tx.createdAt).toLocaleString() : "—"} · {tx.reference ?? tx.id?.slice(0, 8) ?? "—"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`font-semibold ${TX_TYPE_COLORS[tx.type] ?? ""}`}>
                      {["escrow_refund", "fee_deduction", "withdrawal"].includes(tx.type) ? "−" : "+"}
                      {formatNGN(tx.amount)}
                    </p>
                    <p className="text-xs text-muted-foreground">Bal: {formatNGN(tx.balanceAfter)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Date Range Export Dialog */}
      <Dialog open={dateRangeOpen} onOpenChange={setDateRangeOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarIcon className="h-4 w-4" />
              Export Ledger
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Select a date range to export a filtered ledger, or export all transactions.
            </p>
            <div className="flex justify-center">
              <Calendar
                mode="range"
                selected={dateRange}
                onSelect={setDateRange}
                numberOfMonths={1}
                className="rounded-md border"
              />
            </div>
            {dateRange?.from && (
              <div className="flex items-center justify-between text-sm bg-muted rounded-md px-3 py-2">
                <span className="text-muted-foreground">Selected:</span>
                <span className="font-medium">{dateRangeLabel}</span>
                <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => setDateRange(undefined)}>
                  <X className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setDateRange(undefined); handleExportCsv(); }} disabled={csvLoading}>
              Export All
            </Button>
            <Button onClick={handleDateRangeExport} disabled={csvLoading}>
              <Download className="h-4 w-4 mr-2" />
              {csvLoading ? "Exporting…" : dateRange?.from ? "Export Range" : "Export All"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Top-Up Dialog */}
      <Dialog open={topUpOpen} onOpenChange={setTopUpOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PlusCircle className="h-4 w-4 text-green-600" />
              Top Up Wallet
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Deposit funds into your merchant wallet. Deposits are processed via your payment provider and credited on confirmation.</p>
            <div className="space-y-1">
              <Label>Amount (NGN)</Label>
              <Input type="number" value={topUpAmount} onChange={(e) => setTopUpAmount(e.target.value)} placeholder="e.g. 50000" min={1} />
            </div>
            <div className="space-y-1">
              <Label>Note (optional)</Label>
              <Input value={topUpNote} onChange={(e) => setTopUpNote(e.target.value)} placeholder="e.g. Initial deposit" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTopUpOpen(false)}>Cancel</Button>
            <Button
              className="bg-green-600 hover:bg-green-700 text-white"
              disabled={topUp.isPending || !topUpAmount || toNum(topUpAmount) <= 0}
              onClick={() => topUp.mutate({ tenantId, amount: toNum(topUpAmount), note: topUpNote || undefined })}
            >
              {topUp.isPending ? "Processing…" : "Confirm Top-Up"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Withdrawal Dialog */}
      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Request Withdrawal</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Amount (NGN)</Label>
              <Input type="number" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="Enter amount" max={toNum(wallet?.availableBalance)} />
              <p className="text-xs text-muted-foreground">Available: {formatNGN(wallet?.availableBalance)}</p>
            </div>
            <div className="space-y-1">
              <Label>Bank Account Number</Label>
              <Input value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} placeholder="0123456789" />
            </div>
            <div className="space-y-1">
              <Label>Bank</Label>
              <Popover open={bankPickerOpen} onOpenChange={setBankPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={bankPickerOpen}
                    disabled={banksLoading}
                    className="w-full justify-between font-normal"
                  >
                    {selectedBankLabel || (banksLoading ? "Loading banks…" : "Select bank…")}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
                  <Command>
                    <CommandInput placeholder="Search bank…" />
                    <CommandList>
                      <CommandEmpty>No match found.</CommandEmpty>
                      <CommandGroup>
                        {(banks ?? []).map((b) => (
                          <CommandItem
                            key={b.code}
                            value={b.name}
                            onSelect={() => {
                              setBankCode(b.code);
                              setSelectedBankLabel(b.name);
                              setBankPickerOpen(false);
                            }}
                          >
                            <Check className={cn("mr-2 h-4 w-4", bankCode === b.code ? "opacity-100" : "opacity-0")} />
                            {b.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-1">
              <Label>Account Name</Label>
              <div className="flex items-center h-10 px-3 rounded-md border bg-muted/40 text-sm">
                {bankAccount.length !== 10 || !bankCode ? (
                  <span className="text-muted-foreground">Enter account number and bank to resolve</span>
                ) : resolvingAccount ? (
                  <span className="text-muted-foreground">Resolving…</span>
                ) : resolveError ? (
                  <span className="text-red-500">{resolveError.message}</span>
                ) : resolvedAccount ? (
                  <span className="font-medium">{resolvedAccount.accountName}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWithdrawOpen(false)}>Cancel</Button>
            <Button
              disabled={withdraw.isPending || !withdrawAmount || toNum(withdrawAmount) <= 0 || (!resolvedAccount && !wallet?.bankAccountNumber)}
              onClick={async () => {
                try {
                  // Changing the payout destination is a separate, audited,
                  // step-up-gated action (W30) — an OTP is sent to the tenant
                  // admin phone before the new bank details are saved.
                  if (bankAccount && bankCode && resolvedAccount) {
                    const challenge = await stepUpRequest.mutateAsync({ tenantId, purpose: "payout_change" });
                    const otp = window.prompt(
                      `Enter the 6-digit verification code sent to the tenant admin phone (${challenge.phoneHint})`
                    );
                    if (!otp) return;
                    await updateBankDetails.mutateAsync({
                      tenantId,
                      bankAccountName: resolvedAccount.accountName,
                      bankAccountNumber: bankAccount,
                      bankCode,
                      stepUpChallengeId: challenge.challengeId,
                      stepUpOtp: otp,
                    });
                    toast.success("Payout bank details updated.");
                  }
                  withdraw.mutate({ tenantId, amount: toNum(withdrawAmount) });
                } catch (e: any) {
                  toast.error(e.message ?? "Step-up verification failed");
                }
              }}>
              {withdraw.isPending ? "Processing…" : "Submit Withdrawal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </DashboardLayout>
  );
}
