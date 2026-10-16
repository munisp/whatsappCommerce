// === W55 ui-b ===
/**
 * ArInvoices — AR invoices with payment links (W31 `arInvoices` router):
 * create draft → send (mints a PSP payment link + WhatsApps the customer) →
 * recordPayment reconciles only verified provider payments. Aging buckets
 * come from the router (computed server-side).
 */
import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { useActiveTenant } from "@/contexts/TenantContext";
import { Plus, Send, Link2, Loader2, XCircle, CheckCheck } from "lucide-react";
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
  draft: "secondary", sent: "default", viewed: "default", partially_paid: "outline",
  paid: "default", overdue: "destructive", cancelled: "outline",
};
const AGING_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  current: "secondary", "1-30": "outline", "31-60": "outline", "61-90": "destructive", "90+": "destructive", paid: "default",
};

export default function ArInvoices() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const [status, setStatus] = useState("all");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ customerName: "", customerPhone: "", customerEmail: "", description: "", amount: "", dueDate: "" });

  const listQ = trpc.arInvoices.list.useQuery(
    { tenantId, status: status === "all" ? undefined : (status as any) },
    { enabled: !!tenantId },
  );

  const onErr = (e: { message: string }) => toast.error(e.message);
  const createMut = trpc.arInvoices.create.useMutation({
    onSuccess: () => { toast.success("Invoice created"); setShowCreate(false); setForm({ customerName: "", customerPhone: "", customerEmail: "", description: "", amount: "", dueDate: "" }); listQ.refetch(); },
    onError: onErr,
  });
  const sendMut = trpc.arInvoices.send.useMutation({
    onSuccess: (r: any) => {
      toast.success("Payment link created & invoice sent");
      if (r?.paymentUrl) navigator.clipboard?.writeText(r.paymentUrl).catch(() => {});
      listQ.refetch();
    },
    onError: onErr,
  });
  const recordMut = trpc.arInvoices.recordPayment.useMutation({
    onSuccess: (r: any) => {
      toast.success(r?.recorded ? "Verified payment recorded" : `No verified payment yet${r?.reason ? ` (${r.reason})` : ""}`);
      listQ.refetch();
    },
    onError: onErr,
  });
  const cancelMut = trpc.arInvoices.cancel.useMutation({
    onSuccess: () => { toast.success("Invoice cancelled"); listQ.refetch(); },
    onError: onErr,
  });

  const rows = listQ.data ?? [];
  const totals = rows.reduce(
    (acc, r) => {
      if (r.status !== "cancelled") {
        acc.outstanding += r.outstandingCents;
        if (r.status === "paid") acc.collected += r.paidCents;
        if (r.status === "overdue") acc.overdue += r.outstandingCents;
      }
      return acc;
    },
    { outstanding: 0, collected: 0, overdue: 0 },
  );
  const currency = rows[0]?.currency ?? "NGN";

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">AR Invoices</h1>
            <p className="text-muted-foreground text-sm mt-1">Customer invoices with payment links & aging</p>
          </div>
          <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4 mr-2" /> New Invoice</Button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card><CardContent className="p-4"><p className="text-xl font-bold">{rows.length}</p><p className="text-xs text-muted-foreground">Invoices</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xl font-bold">{formatCents(totals.outstanding, currency)}</p><p className="text-xs text-muted-foreground">Outstanding</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xl font-bold text-red-500">{formatCents(totals.overdue, currency)}</p><p className="text-xs text-muted-foreground">Overdue</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xl font-bold text-green-500">{formatCents(totals.collected, currency)}</p><p className="text-xs text-muted-foreground">Collected</p></CardContent></Card>
        </div>

        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {["all", "draft", "sent", "viewed", "partially_paid", "paid", "overdue", "cancelled"].map((s) => (
              <SelectItem key={s} value={s} className="capitalize">{s.replace("_", " ")}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Card>
          <CardContent className="p-0">
            {!rows.length ? (
              <p className="text-muted-foreground text-sm text-center py-10">No AR invoices yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>No.</TableHead><TableHead>Customer</TableHead><TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead><TableHead>Due</TableHead><TableHead>Aging</TableHead>
                    <TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-medium">#{inv.invoiceNo}</TableCell>
                      <TableCell>{inv.customerName ?? inv.customerPhone ?? "—"}</TableCell>
                      <TableCell className="text-right">{formatCents(inv.amountCents, inv.currency)}</TableCell>
                      <TableCell className="text-right font-semibold">{formatCents(inv.outstandingCents, inv.currency)}</TableCell>
                      <TableCell>{formatDate(inv.dueDate)}</TableCell>
                      <TableCell><Badge variant={AGING_BADGE[inv.aging] ?? "secondary"}>{inv.aging}</Badge></TableCell>
                      <TableCell><Badge variant={STATUS_BADGE[inv.status] ?? "secondary"} className="capitalize">{inv.status.replace("_", " ")}</Badge></TableCell>
                      <TableCell className="text-right space-x-1">
                        {inv.status === "draft" && (
                          <Button size="sm" onClick={() => sendMut.mutate({ tenantId, invoiceId: inv.id })}><Link2 className="h-3 w-3 mr-1" />Create link & send</Button>
                        )}
                        {["sent", "viewed", "partially_paid", "overdue"].includes(inv.status) && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => sendMut.mutate({ tenantId, invoiceId: inv.id })}><Send className="h-3 w-3 mr-1" />Resend</Button>
                            <Button size="sm" variant="outline" onClick={() => recordMut.mutate({ tenantId, invoiceId: inv.id })}><CheckCheck className="h-3 w-3 mr-1" />Verify payment</Button>
                          </>
                        )}
                        {inv.status !== "paid" && inv.status !== "cancelled" && (
                          <Button size="sm" variant="ghost" onClick={() => cancelMut.mutate({ tenantId, invoiceId: inv.id })}><XCircle className="h-3 w-3" /></Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogContent>
            <DialogHeader><DialogTitle>New AR Invoice</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Customer name</Label><Input value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} /></div>
                <div><Label>Customer phone</Label><Input value={form.customerPhone} onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} /></div>
              </div>
              <div><Label>Customer email</Label><Input type="email" value={form.customerEmail} onChange={(e) => setForm({ ...form, customerEmail: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Amount (₦)</Label><Input type="number" min={0} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div>
                <div><Label>Due date</Label><Input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></div>
              </div>
              <div><Label>Description</Label><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            </div>
            <DialogFooter>
              <Button
                disabled={createMut.isPending || !form.amount || Number(form.amount) <= 0}
                onClick={() => createMut.mutate({
                  tenantId,
                  customerName: form.customerName || undefined,
                  customerPhone: form.customerPhone || undefined,
                  customerEmail: form.customerEmail || undefined,
                  description: form.description || undefined,
                  amountCents: Math.round(Number(form.amount) * 100),
                  dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : undefined,
                })}
              >
                {createMut.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
// === END W55 ui-b ===
