import { useState } from "react";
import { Plus, FileText, CheckCircle, Clock, AlertTriangle, DollarSign, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

const STATUS_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  draft: { label: "Draft", variant: "secondary" },
  sent: { label: "Sent", variant: "default" },
  paid: { label: "Paid", variant: "default" },
  overdue: { label: "Overdue", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
};

export default function Invoices() {
  const [tenantId] = useState("tenant-001");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    type: "subscription" as "subscription" | "profit_share" | "one_time",
    subscriptionFee: "25000",
    commissionRate: "0.05",
    currency: "NGN",
  });

  const { data: invoiceList, refetch } = trpc.invoice.list.useQuery({ tenantId });
  const { data: stats } = trpc.invoice.stats.useQuery({ tenantId });
  const generateMut = trpc.invoice.generate.useMutation({
    onSuccess: () => { toast.success("Invoice generated"); setShowCreate(false); refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const sendMut = trpc.invoice.send.useMutation({
    onSuccess: () => { toast.success("Invoice marked as sent"); refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const paidMut = trpc.invoice.markPaid.useMutation({
    onSuccess: () => { toast.success("Invoice marked as paid"); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const handleGenerate = () => {
    generateMut.mutate({
      tenantId,
      type: form.type,
      subscriptionFee: form.type !== "profit_share" ? Number(form.subscriptionFee) : undefined,
      commissionRate: form.type === "profit_share" ? Number(form.commissionRate) : undefined,
      currency: form.currency,
    });
  };

  const kpis = [
    { label: "Draft", value: stats?.draft_count ?? 0, icon: FileText, color: "text-muted-foreground" },
    { label: "Sent", value: stats?.sent_count ?? 0, icon: Send, color: "text-blue-500" },
    { label: "Paid", value: stats?.paid_count ?? 0, icon: CheckCircle, color: "text-green-500" },
    { label: "Overdue", value: stats?.overdue_count ?? 0, icon: AlertTriangle, color: "text-red-500" },
    { label: "Collected", value: `₦${Number(stats?.total_collected ?? 0).toLocaleString()}`, icon: DollarSign, color: "text-green-600" },
    { label: "Outstanding", value: `₦${Number(stats?.total_outstanding ?? 0).toLocaleString()}`, icon: Clock, color: "text-orange-500" },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Invoices</h1>
          <p className="text-muted-foreground text-sm mt-1">Subscription & profit-sharing billing</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-2" /> Generate Invoice
        </Button>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-4">
        {kpis.map(k => (
          <Card key={k.label}>
            <CardContent className="p-4 flex flex-col gap-1">
              <k.icon className={`h-4 w-4 ${k.color}`} />
              <p className="text-xl font-bold">{k.value}</p>
              <p className="text-xs text-muted-foreground">{k.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Invoice list */}
      <Card>
        <CardHeader><CardTitle>Invoice History</CardTitle></CardHeader>
        <CardContent>
          {!invoiceList?.length ? (
            <p className="text-muted-foreground text-sm text-center py-8">No invoices yet. Generate your first invoice above.</p>
          ) : (
            <div className="space-y-3">
              {invoiceList.map(inv => (
                <div key={inv.id} className="flex items-center justify-between p-3 rounded-lg border">
                  <div className="flex items-center gap-3">
                    <FileText className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-sm">{inv.invoiceNumber}</p>
                      <p className="text-xs text-muted-foreground capitalize">{inv.type.replace("_", " ")} · {inv.currency}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="font-semibold">{inv.currency} {Number(inv.totalAmount).toLocaleString()}</p>
                    <Badge variant={STATUS_BADGE[inv.status]?.variant ?? "secondary"}>
                      {STATUS_BADGE[inv.status]?.label ?? inv.status}
                    </Badge>
                    {inv.status === "draft" && (
                      <Button size="sm" variant="outline" onClick={() => sendMut.mutate({ invoiceId: inv.id })}>
                        <Send className="h-3 w-3 mr-1" /> Send
                      </Button>
                    )}
                    {inv.status === "sent" && (
                      <Button size="sm" variant="outline" onClick={() => paidMut.mutate({ invoiceId: inv.id })}>
                        <CheckCircle className="h-3 w-3 mr-1" /> Mark Paid
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Generate dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Generate Invoice</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Billing Type</Label>
              <Select value={form.type} onValueChange={v => setForm(f => ({ ...f, type: v as typeof f.type }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="subscription">Subscription</SelectItem>
                  <SelectItem value="profit_share">Profit Share</SelectItem>
                  <SelectItem value="one_time">One-time</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.type === "profit_share" ? (
              <div>
                <Label>Commission Rate</Label>
                <Input value={form.commissionRate} onChange={e => setForm(f => ({ ...f, commissionRate: e.target.value }))} placeholder="0.05 = 5%" />
              </div>
            ) : (
              <div>
                <Label>Fee Amount ({form.currency})</Label>
                <Input value={form.subscriptionFee} onChange={e => setForm(f => ({ ...f, subscriptionFee: e.target.value }))} />
              </div>
            )}
            <div>
              <Label>Currency</Label>
              <Select value={form.currency} onValueChange={v => setForm(f => ({ ...f, currency: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="NGN">NGN</SelectItem>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="GHS">GHS</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleGenerate} disabled={generateMut.isPending}>
              {generateMut.isPending ? "Generating..." : "Generate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

