// === W55 ui-c ===
// Scheduled payments surface for the W31 scheduledPayments router
// (ORPHAN-BE-06). List/schedule/cancel/retry per existing procedures.
import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { CalendarClock, Plus, RefreshCw, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const statusColors: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  claimed: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  executed: "bg-green-500/20 text-green-400 border-green-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
  cancelled: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  insufficient_funds: "bg-orange-500/20 text-orange-400 border-orange-500/30",
};

function fmtMoney(cents: number, currency: string) {
  return `${currency} ${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function ScheduledPayments() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const utils = trpc.useUtils();

  const { data: payments, isLoading } = trpc.scheduledPayments.list.useQuery({
    tenantId,
    status: statusFilter === "all" ? undefined : (statusFilter as any),
    limit: 100,
  });

  const invalidate = () => utils.scheduledPayments.list.invalidate();

  const cancelMut = trpc.scheduledPayments.cancel.useMutation({
    onSuccess: () => { toast.success("Scheduled payment cancelled"); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const retryMut = trpc.scheduledPayments.retry.useMutation({
    onSuccess: () => { toast.success("Payment re-queued for the next batch"); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const scheduleMut = trpc.scheduledPayments.schedule.useMutation({
    onSuccess: (r) => {
      toast.success(r.note ?? "Payment scheduled");
      setCreateOpen(false);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const [form, setForm] = useState({
    kind: "adhoc" as "vendor_bill" | "payout" | "adhoc",
    amountNaira: "",
    recipientName: "",
    recipientPhone: "",
    bankAccountNumber: "",
    bankCode: "",
    executeAt: "",
    speed: "standard" as "standard" | "instant",
  });

  const submitCreate = () => {
    const amountCents = Math.round(Number(form.amountNaira) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    if (!form.executeAt) {
      toast.error("Pick an execution date/time");
      return;
    }
    scheduleMut.mutate({
      tenantId,
      kind: form.kind,
      amountCents,
      currency: "NGN",
      executeAt: new Date(form.executeAt),
      speed: form.speed,
      idempotencyKey: crypto.randomUUID(),
      recipient: {
        name: form.recipientName || undefined,
        phone: form.recipientPhone || undefined,
        bankAccountNumber: form.bankAccountNumber || undefined,
        bankCode: form.bankCode || undefined,
      },
    });
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Scheduled Payments</h1>
            <p className="text-muted-foreground mt-1">Future and batch wallet payments — executed by the payment scheduler</p>
          </div>
          <Button onClick={() => setCreateOpen(true)} className="gap-1">
            <Plus className="w-4 h-4" /> Schedule payment
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-56 bg-card border-border">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="claimed">Claimed</SelectItem>
              <SelectItem value="executed">Executed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="insufficient_funds">Insufficient funds</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Scheduled payments</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Kind</TableHead>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Execute at</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
                ) : !payments?.length ? (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    <div className="flex flex-col items-center gap-2">
                      <CalendarClock className="w-8 h-8 opacity-40" />
                      No scheduled payments
                    </div>
                  </TableCell></TableRow>
                ) : payments.map((p) => {
                  const recipient = (p.recipient as { name?: string; phone?: string } | null) ?? null;
                  return (
                    <TableRow key={p.id} className="border-border hover:bg-accent/30">
                      <TableCell><Badge variant="outline">{p.kind.replaceAll("_", " ")}</Badge></TableCell>
                      <TableCell className="text-sm">
                        {recipient?.name ?? "—"}
                        {recipient?.phone && <span className="block text-xs text-muted-foreground">{recipient.phone}</span>}
                      </TableCell>
                      <TableCell className="font-mono">{fmtMoney(p.amountCents, p.currency)}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{formatDistanceToNow(new Date(p.executeAt), { addSuffix: true })}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={statusColors[p.status] ?? ""}>{p.status.replaceAll("_", " ")}</Badge>
                        {p.lastError && <span className="block text-[10px] text-red-400 mt-1 max-w-[220px] truncate" title={p.lastError}>{p.lastError}</span>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{p.attempts}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {(p.status === "failed" || p.status === "insufficient_funds") && (
                            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"
                              disabled={retryMut.isPending}
                              onClick={() => retryMut.mutate({ tenantId, id: p.id })}>
                              <RefreshCw className="w-3 h-3" /> Retry
                            </Button>
                          )}
                          {(p.status === "pending" || p.status === "failed" || p.status === "insufficient_funds") && (
                            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-red-400 hover:text-red-300"
                              disabled={cancelMut.isPending}
                              onClick={() => cancelMut.mutate({ tenantId, id: p.id })}>
                              <XCircle className="w-3 h-3" /> Cancel
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Schedule a payment</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Kind</Label>
                  <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v as any })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="adhoc">Ad-hoc</SelectItem>
                      <SelectItem value="vendor_bill">Vendor bill</SelectItem>
                      <SelectItem value="payout">Payout</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Amount (NGN)</Label>
                  <Input type="number" min="0" step="0.01" value={form.amountNaira}
                    onChange={(e) => setForm({ ...form, amountNaira: e.target.value })} placeholder="0.00" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Recipient name</Label>
                  <Input value={form.recipientName} onChange={(e) => setForm({ ...form, recipientName: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Recipient phone</Label>
                  <Input value={form.recipientPhone} onChange={(e) => setForm({ ...form, recipientPhone: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Bank account number</Label>
                  <Input value={form.bankAccountNumber} onChange={(e) => setForm({ ...form, bankAccountNumber: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Bank code</Label>
                  <Input value={form.bankCode} onChange={(e) => setForm({ ...form, bankCode: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Execute at</Label>
                  <Input type="datetime-local" value={form.executeAt} onChange={(e) => setForm({ ...form, executeAt: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Speed</Label>
                  <Select value={form.speed} onValueChange={(v) => setForm({ ...form, speed: v as any })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="standard">Standard (next batch, free)</SelectItem>
                      <SelectItem value="instant">Instant (fee applies)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>Close</Button>
              <Button onClick={submitCreate} disabled={scheduleMut.isPending}>Schedule</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
