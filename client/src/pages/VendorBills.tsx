// === W55 ui-b ===
/**
 * VendorBills — AP inbox for the W31 `vendorBills` router. List with
 * status/vendor/due filters, create (manual capture), pay (full/partial,
 * optional pay-over-time), cancel, and overdue sweep — all existing
 * procedures. Pay-over-time plans and vendor registry are surfaced read-only.
 */
import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { useActiveTenant } from "@/contexts/TenantContext";
import { Plus, RefreshCw, Loader2, XCircle, Banknote, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  pending: "secondary", scheduled: "secondary", approved: "default", pending_approval: "secondary",
  paid: "default", partially_paid: "outline", overdue: "destructive", cancelled: "outline",
};

export default function VendorBills() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const [status, setStatus] = useState("all");
  const [vendorFilter, setVendorFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [payBill, setPayBill] = useState<{ id: string; remaining: number; currency: string } | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payInstallments, setPayInstallments] = useState("0");
  const [form, setForm] = useState({ vendorName: "", billNumber: "", description: "", amount: "", dueDate: "" });

  const listQ = trpc.vendorBills.list.useQuery(
    { tenantId, status: status === "all" ? undefined : (status as any), vendor: vendorFilter || undefined },
    { enabled: !!tenantId },
  );
  const vendorsQ = trpc.vendorBills.listVendors.useQuery({ tenantId }, { enabled: !!tenantId });
  const plansQ = trpc.vendorBills.installmentPlans.useQuery({ tenantId }, { enabled: !!tenantId });

  const onErr = (e: { message: string }) => toast.error(e.message);
  const createMut = trpc.vendorBills.create.useMutation({
    onSuccess: () => { toast.success("Bill created"); setShowCreate(false); setForm({ vendorName: "", billNumber: "", description: "", amount: "", dueDate: "" }); listQ.refetch(); },
    onError: onErr,
  });
  const payMut = trpc.vendorBills.recordPayment.useMutation({
    onSuccess: (r: any) => {
      toast.success(r?.duplicate ? "Payment already recorded (idempotent)" : "Payment recorded");
      setPayBill(null); listQ.refetch(); plansQ.refetch();
    },
    onError: onErr,
  });
  const cancelMut = trpc.vendorBills.cancel.useMutation({
    onSuccess: () => { toast.success("Bill cancelled"); listQ.refetch(); },
    onError: onErr,
  });
  const sweepMut = trpc.vendorBills.markOverdue.useMutation({
    onSuccess: (r: any) => { toast.success(`Overdue sweep done${typeof r?.flipped === "number" ? ` — ${r.flipped} flipped` : ""}`); listQ.refetch(); },
    onError: onErr,
  });

  const totals = (listQ.data ?? []).reduce(
    (acc, b) => {
      if (b.status !== "cancelled") {
        acc.outstanding += Math.max(0, b.amountCents - b.paidCents);
        if (b.status === "overdue") acc.overdue += Math.max(0, b.amountCents - b.paidCents);
      }
      return acc;
    },
    { outstanding: 0, overdue: 0 },
  );
  const currency = listQ.data?.[0]?.currency ?? "NGN";

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Vendor Bills (AP)</h1>
            <p className="text-muted-foreground text-sm mt-1">Accounts-payable inbox — capture, approve and pay vendor bills</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => sweepMut.mutate({ tenantId })} disabled={sweepMut.isPending}>
              <RefreshCw className="h-4 w-4 mr-2" /> Sweep overdue
            </Button>
            <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4 mr-2" /> New Bill</Button>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card><CardContent className="p-4"><p className="text-xl font-bold">{listQ.data?.length ?? 0}</p><p className="text-xs text-muted-foreground">Bills</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xl font-bold">{formatCents(totals.outstanding, currency)}</p><p className="text-xs text-muted-foreground">Outstanding</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xl font-bold text-red-500">{formatCents(totals.overdue, currency)}</p><p className="text-xs text-muted-foreground">Overdue</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xl font-bold">{vendorsQ.data?.length ?? 0}</p><p className="text-xs text-muted-foreground">Registered vendors</p></CardContent></Card>
        </div>

        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              {["all", "pending", "pending_approval", "approved", "scheduled", "partially_paid", "paid", "overdue", "cancelled"].map((s) => (
                <SelectItem key={s} value={s} className="capitalize">{s.replace("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input className="w-56" placeholder="Filter by vendor…" value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} />
        </div>

        <Card>
          <CardContent className="p-0">
            {!listQ.data?.length ? (
              <p className="text-muted-foreground text-sm text-center py-10">No vendor bills found.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor</TableHead><TableHead>Bill #</TableHead><TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Paid</TableHead><TableHead>Due</TableHead><TableHead>Source</TableHead>
                    <TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listQ.data.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="font-medium">{b.vendorName}</TableCell>
                      <TableCell>{b.billNumber ?? "—"}</TableCell>
                      <TableCell className="text-right">{formatCents(b.amountCents, b.currency)}</TableCell>
                      <TableCell className="text-right">{formatCents(b.paidCents, b.currency)}</TableCell>
                      <TableCell>{formatDate(b.dueDate)}</TableCell>
                      <TableCell className="capitalize text-xs">{b.captureSource}</TableCell>
                      <TableCell><Badge variant={STATUS_BADGE[b.status] ?? "secondary"} className="capitalize">{b.status.replace("_", " ")}</Badge></TableCell>
                      <TableCell className="text-right space-x-1">
                        {!["paid", "cancelled"].includes(b.status) && (
                          <Button size="sm" variant="outline" onClick={() => { setPayBill({ id: b.id, remaining: b.amountCents - b.paidCents, currency: b.currency }); setPayAmount(((b.amountCents - b.paidCents) / 100).toFixed(2)); setPayInstallments("0"); }}>
                            <Banknote className="h-3 w-3 mr-1" />Pay
                          </Button>
                        )}
                        {b.paidCents === 0 && b.status !== "cancelled" && (
                          <Button size="sm" variant="ghost" onClick={() => cancelMut.mutate({ tenantId, billId: b.id })}><XCircle className="h-3 w-3" /></Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {(plansQ.data?.length ?? 0) > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Receipt className="h-4 w-4" /> Pay-over-time plans</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow><TableHead>Plan</TableHead><TableHead className="text-right">Installments</TableHead><TableHead className="text-right">Remaining</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                <TableBody>
                  {(plansQ.data as any[]).map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-mono text-xs">{String(p.id).slice(0, 8)}…</TableCell>
                      <TableCell className="text-right">{p.installmentsPaid ?? "—"}/{p.installments ?? "—"}</TableCell>
                      <TableCell className="text-right">{formatCents(p.remainingCents ?? p.remainingBalanceCents, p.currency)}</TableCell>
                      <TableCell><Badge variant="secondary" className="capitalize">{p.status}</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {/* Create dialog */}
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogContent>
            <DialogHeader><DialogTitle>New Vendor Bill</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Vendor name</Label><Input value={form.vendorName} onChange={(e) => setForm({ ...form, vendorName: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Bill number</Label><Input value={form.billNumber} onChange={(e) => setForm({ ...form, billNumber: e.target.value })} /></div>
                <div><Label>Amount (₦)</Label><Input type="number" min={0} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div>
              </div>
              <div><Label>Due date</Label><Input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></div>
              <div><Label>Description</Label><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            </div>
            <DialogFooter>
              <Button
                disabled={createMut.isPending || !form.amount || Number(form.amount) <= 0}
                onClick={() => createMut.mutate({
                  tenantId,
                  vendorName: form.vendorName || undefined,
                  billNumber: form.billNumber || undefined,
                  description: form.description || undefined,
                  amountCents: Math.round(Number(form.amount) * 100),
                  dueDate: form.dueDate ? new Date(form.dueDate) : undefined,
                  captureSource: "manual",
                })}
              >
                {createMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Pay dialog */}
        <Dialog open={!!payBill} onOpenChange={(o) => !o && setPayBill(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Record Payment</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Remaining balance: <span className="font-semibold text-foreground">{payBill ? formatCents(payBill.remaining, payBill.currency) : "—"}</span></p>
              <div><Label>Amount ({payBill?.currency ?? "NGN"})</Label><Input type="number" min={0} step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} /></div>
              <div>
                <Label>Pay over time (optional)</Label>
                <Select value={payInstallments} onValueChange={setPayInstallments}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Pay in full now</SelectItem>
                    <SelectItem value="3">3 installments</SelectItem>
                    <SelectItem value="6">6 installments</SelectItem>
                    <SelectItem value="12">12 installments</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={payMut.isPending || !payAmount || Number(payAmount) <= 0}
                onClick={() => payBill && payMut.mutate({
                  tenantId,
                  billId: payBill.id,
                  amountCents: Math.round(Number(payAmount) * 100),
                  paymentRef: `ui-${payBill.id}-${Date.now()}`,
                  payOverTime: payInstallments !== "0" ? { installments: Number(payInstallments) as 3 | 6 | 12 } : undefined,
                })}
              >
                {payMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Record payment
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
// === END W55 ui-b ===
