// === W59 banking-pos ===
/**
 * Agent banking page: CICO form (cash-in/cash-out), recent transaction list,
 * and the float card (balance + low-float flag + today totals).
 */
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useState } from "react";

const fmt = (cents: number) => `NGN ${(cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

export default function AgentBanking() {
  const { data: myTenant } = trpc.tenantPortal.getMyTenant.useQuery();
  const tenantId = myTenant?.id ?? "";
  const { data: summary, refetch } = trpc.agentBanking.floatSummary.useQuery({ tenantId }, { enabled: !!tenantId });
  const { data: txs, refetch: refetchTxs } = trpc.agentBanking.transactions.useQuery({ tenantId, limit: 50 }, { enabled: !!tenantId });
  const [phone, setPhone] = useState("");
  const [amount, setAmount] = useState("");
  const onDone = (r: { reference: string; duplicate: boolean }) => {
    toast.success(`${r.reference} ${r.duplicate ? "already processed (idempotent replay)" : "completed"}.`);
    refetch(); refetchTxs();
  };
  const onErr = (e: { message: string }) => toast.error(e.message);
  const cashIn = trpc.agentBanking.cashIn.useMutation({ onSuccess: onDone, onError: onErr });
  const cashOut = trpc.agentBanking.cashOut.useMutation({ onSuccess: onDone, onError: onErr });

  const submit = (kind: "cash_in" | "cash_out") => {
    const amountCents = Math.round(parseFloat(amount) * 100);
    if (!phone || !Number.isInteger(amountCents) || amountCents <= 0) {
      toast.error("Enter a customer phone and a valid amount.");
      return;
    }
    const reference = `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    (kind === "cash_in" ? cashIn : cashOut).mutate({ tenantId, customerPhone: phone, amountCents, reference });
  };

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Agent Banking</h1>
        <Card>
          <CardHeader><CardTitle>Float {summary?.lowFloat && <Badge variant="destructive" className="ml-2">LOW FLOAT</Badge>}</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div><p className="text-sm text-muted-foreground">Float balance</p><p className="text-xl font-semibold">{summary ? fmt(summary.floatCents) : "…"}</p></div>
            <div><p className="text-sm text-muted-foreground">Today cash-in</p><p className="text-xl">{summary ? fmt(summary.todayCashInCents) : "…"}</p></div>
            <div><p className="text-sm text-muted-foreground">Today cash-out</p><p className="text-xl">{summary ? fmt(summary.todayCashOutCents) : "…"}</p></div>
            <div><p className="text-sm text-muted-foreground">Today commission</p><p className="text-xl">{summary ? fmt(summary.todayCommissionCents) : "…"}</p></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>New cash-in / cash-out</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-3">
            <div>
              <Label htmlFor="w59-cico-phone">Customer phone</Label>
              <Input id="w59-cico-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0803…" />
            </div>
            <div>
              <Label htmlFor="w59-cico-amt">Amount (NGN)</Label>
              <Input id="w59-cico-amt" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            </div>
            <Button disabled={cashIn.isPending} onClick={() => submit("cash_in")}>Cash in</Button>
            <Button variant="outline" disabled={cashOut.isPending} onClick={() => submit("cash_out")}>Cash out</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Recent CICO transactions</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {(txs ?? []).map((t: any) => (
              <div key={t.id} className="flex justify-between border-b pb-1 text-sm">
                <span>{t.reference}</span>
                <span>{t.kind === "cash_in" ? "Cash-in" : "Cash-out"} — {fmt(t.amountCents)} (fee {fmt(t.feeCents)}, comm {fmt(t.commissionCents)})</span>
                <Badge variant={t.status === "completed" ? "default" : "outline"}>{t.status}</Badge>
              </div>
            ))}
            {(txs ?? []).length === 0 && <p className="text-sm text-muted-foreground">No transactions yet.</p>}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
// === END W59 banking-pos ===
