// === W55 ui-b ===
/**
 * FxPayouts — cross-border FX vendor payouts (W32 `fxPayouts` router):
 * quote → accept → execute. All procedures are tenant-scoped moneyProcedure /
 * protectedProcedure + assertTenantAccess, so this page lives in the tenant
 * portal (not platform-admin). Honest failures (no corridor / expired /
 * insufficient funds) surface as toast errors — nothing moves.
 */
import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { useActiveTenant } from "@/contexts/TenantContext";
import { Plus, Loader2, ArrowRightLeft, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { formatCents, formatDate } from "@/lib/b2bLogic";

const STATUS_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  quoted: "secondary", accepted: "default", executed: "default", expired: "outline", failed: "destructive",
};
const CURRENCIES = ["NGN", "USD", "GHS", "KES", "ZAR", "EUR", "GBP"];

export default function FxPayouts() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const [showQuote, setShowQuote] = useState(false);
  const [form, setForm] = useState({ fromCurrency: "NGN", toCurrency: "USD", amount: "" });

  const listQ = trpc.fxPayouts.list.useQuery({ tenantId }, { enabled: !!tenantId });

  const onErr = (e: { message: string }) => toast.error(e.message);
  const quoteMut = trpc.fxPayouts.quote.useMutation({
    onSuccess: () => { toast.success("Quote minted — accept it before it expires"); setShowQuote(false); listQ.refetch(); },
    onError: onErr,
  });
  const acceptMut = trpc.fxPayouts.accept.useMutation({
    onSuccess: () => { toast.success("Quote accepted"); listQ.refetch(); },
    onError: onErr,
  });
  const executeMut = trpc.fxPayouts.execute.useMutation({
    onSuccess: () => { toast.success("Payout executed"); listQ.refetch(); },
    onError: onErr,
  });

  const rows = listQ.data ?? [];

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">FX Payouts</h1>
            <p className="text-muted-foreground text-sm mt-1">Cross-border vendor payouts: quote → accept → execute</p>
          </div>
          <Button onClick={() => setShowQuote(true)}><Plus className="h-4 w-4 mr-2" /> New Quote</Button>
        </div>

        <Card>
          <CardContent className="p-0">
            {!rows.length ? (
              <p className="text-muted-foreground text-sm text-center py-10">No FX quotes yet. Mint a quote to start a payout.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Corridor</TableHead><TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Rate</TableHead><TableHead className="text-right">Fee</TableHead>
                    <TableHead>Expires</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((q) => (
                    <TableRow key={q.id}>
                      <TableCell className="font-medium">{q.fromCurrency} → {q.toCurrency}</TableCell>
                      <TableCell className="text-right">{formatCents(q.amountCents, q.fromCurrency)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{Number(q.rate).toFixed(4)}</TableCell>
                      <TableCell className="text-right">{formatCents(q.feeCents, q.fromCurrency)}</TableCell>
                      <TableCell>{formatDate(q.expiresAt)}</TableCell>
                      <TableCell><Badge variant={STATUS_BADGE[q.status] ?? "secondary"} className="capitalize">{q.status}</Badge></TableCell>
                      <TableCell className="text-right space-x-1">
                        {q.status === "quoted" && new Date(q.expiresAt).getTime() > Date.now() && (
                          <Button size="sm" variant="outline" onClick={() => acceptMut.mutate({ tenantId, quoteId: q.id })}>
                            <ArrowRightLeft className="h-3 w-3 mr-1" />Accept
                          </Button>
                        )}
                        {q.status === "accepted" && (
                          <Button size="sm" onClick={() => executeMut.mutate({ tenantId, quoteId: q.id })}>
                            <Play className="h-3 w-3 mr-1" />Execute
                          </Button>
                        )}
                        {q.status === "executed" && q.payoutRef && (
                          <span className="font-mono text-xs text-muted-foreground">{q.payoutRef}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Dialog open={showQuote} onOpenChange={setShowQuote}>
          <DialogContent>
            <DialogHeader><DialogTitle>New FX Quote</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>From</Label>
                  <Select value={form.fromCurrency} onValueChange={(v) => setForm({ ...form, fromCurrency: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>To</Label>
                  <Select value={form.toCurrency} onValueChange={(v) => setForm({ ...form, toCurrency: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <div><Label>Amount ({form.fromCurrency})</Label><Input type="number" min={0} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div>
            </div>
            <DialogFooter>
              <Button
                disabled={quoteMut.isPending || !form.amount || Number(form.amount) <= 0 || form.fromCurrency === form.toCurrency}
                onClick={() => quoteMut.mutate({
                  tenantId,
                  fromCurrency: form.fromCurrency,
                  toCurrency: form.toCurrency,
                  amountCents: Math.round(Number(form.amount) * 100),
                })}
              >
                {quoteMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Get quote
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
// === END W55 ui-b ===
