import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { useState } from "react";

const TX_TYPE_COLORS: Record<string, string> = {
  escrow_credit: "text-yellow-600",
  escrow_release: "text-green-600",
  escrow_refund: "text-red-500",
  float_income: "text-blue-600",
  withdrawal: "text-gray-600",
  fee_deduction: "text-orange-600",
};

function formatNGN(val: string | number | null | undefined) {
  const n = typeof val === "string" ? parseFloat(val) : (val ?? 0);
  return `₦${n.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function MerchantWallet({ tenantId }: { tenantId: string }) {
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [bankName, setBankName] = useState("");

  const { data: wallet, isLoading: walletLoading, refetch } = trpc.wallet.getBalance.useQuery({ tenantId });
  const { data: txs, isLoading: txLoading } = trpc.wallet.listTransactions.useQuery({ tenantId, limit: 50 });
  const { data: config } = trpc.escrow.getConfig.useQuery();

  const withdraw = trpc.wallet.requestWithdrawal.useMutation({
    onSuccess: (data) => {
      toast.success(`Withdrawal of ${formatNGN(data.amount)} initiated. Ref: ${data.reference}`);
      setWithdrawOpen(false);
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const isPspMode = config?.custodyMode === "psp";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
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
        {isPspMode && (
          <Button onClick={() => setWithdrawOpen(true)} disabled={!wallet || parseFloat(wallet.availableBalance) <= 0}>
            Request Withdrawal
          </Button>
        )}
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
          <CardTitle className="text-base">Transaction History</CardTitle>
        </CardHeader>
        <CardContent>
          {txLoading ? (
            <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : (txs ?? []).length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No transactions yet</p>
          ) : (
            <div className="space-y-0">
              {(txs ?? []).map((tx) => (
                <div key={tx.id} className="flex items-center justify-between py-3 border-b last:border-0">
                  <div>
                    <p className="text-sm font-medium">{tx.description ?? tx.type.replace(/_/g, " ")}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(tx.createdAt).toLocaleString()} · {tx.reference ?? tx.id.slice(0, 8)}
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
                placeholder="Enter amount" max={parseFloat(wallet?.availableBalance ?? "0")} />
              <p className="text-xs text-muted-foreground">Available: {formatNGN(wallet?.availableBalance)}</p>
            </div>
            <div className="space-y-1">
              <Label>Bank Account Number</Label>
              <Input value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} placeholder="0123456789" />
            </div>
            <div className="space-y-1">
              <Label>Bank Code (CBN code)</Label>
              <Input value={bankCode} onChange={(e) => setBankCode(e.target.value)} placeholder="e.g. 044" />
            </div>
            <div className="space-y-1">
              <Label>Account Name</Label>
              <Input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="Account holder name" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWithdrawOpen(false)}>Cancel</Button>
            <Button
              disabled={withdraw.isPending || !withdrawAmount || parseFloat(withdrawAmount) <= 0}
              onClick={() => withdraw.mutate({
                tenantId,
                amount: parseFloat(withdrawAmount),
                bankAccountNumber: bankAccount || undefined,
                bankCode: bankCode || undefined,
                bankAccountName: bankName || undefined,
              })}>
              {withdraw.isPending ? "Processing…" : "Submit Withdrawal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

