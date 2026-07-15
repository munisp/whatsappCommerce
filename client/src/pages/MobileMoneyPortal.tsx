import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Smartphone, TrendingUp, CheckCircle2, XCircle, Plus } from "lucide-react";
import { toast } from "sonner";

const TENANT_ID = "default";
const PROVIDERS = ["mtn_momo", "airtel_money", "mpesa", "orange_money", "wave"] as const;

export default function MobileMoneyPortal() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ provider: "mtn_momo", phoneNumber: "", amount: "", currency: "NGN", description: "" });

  const { data: txns, refetch } = trpc.mobileMoney.listTransactions.useQuery({ tenantId: TENANT_ID });
  const { data: stats } = trpc.mobileMoney.stats.useQuery({ tenantId: TENANT_ID });

  const initiate = trpc.mobileMoney.initiate.useMutation({
    onSuccess: () => { toast.success("Payment initiated"); setOpen(false); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const statusColor = (s: string) => {
    if (s === "successful") return "bg-green-100 text-green-800";
    if (s === "failed" || s === "cancelled") return "bg-red-100 text-red-800";
    return "bg-yellow-100 text-yellow-800";
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">Mobile Money Portal</h1>
        <p className="text-gray-500 text-sm">MTN MoMo · Airtel Money · M-Pesa · Orange Money · Wave</p>
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Total Transactions", value: stats.total, icon: Smartphone, color: "text-blue-600" },
              { label: "Successful", value: stats.successful, icon: CheckCircle2, color: "text-green-600" },
              { label: "Failed", value: stats.failed, icon: XCircle, color: "text-red-600" },
              { label: "Total Volume", value: `₦${parseFloat(stats.totalVolume).toLocaleString()}`, icon: TrendingUp, color: "text-purple-600" },
            ].map(({ label, value, icon: Icon, color }) => (
              <Card key={label}><CardContent className="pt-4"><div className="flex items-center gap-3"><Icon className={`w-8 h-8 ${color}`} /><div><p className="text-2xl font-bold">{value}</p><p className="text-xs text-gray-500">{label}</p></div></div></CardContent></Card>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button size="sm"><Plus className="w-4 h-4 mr-1" />Initiate Payment</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Initiate Mobile Money Payment</DialogTitle></DialogHeader>
              <div className="space-y-3 pt-2">
                <Select value={form.provider} onValueChange={v => setForm(f => ({ ...f, provider: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{PROVIDERS.map(p => <SelectItem key={p} value={p}>{p.replace(/_/g, " ").toUpperCase()}</SelectItem>)}</SelectContent>
                </Select>
                <Input placeholder="Phone Number" value={form.phoneNumber} onChange={e => setForm(f => ({ ...f, phoneNumber: e.target.value }))} />
                <Input placeholder="Amount" type="number" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
                <Input placeholder="Description (optional)" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                <Button className="w-full" onClick={() => initiate.mutate({ tenantId: TENANT_ID, provider: form.provider as typeof PROVIDERS[number], phoneNumber: form.phoneNumber, amount: form.amount, currency: form.currency, description: form.description })} disabled={initiate.isPending}>
                  {initiate.isPending ? "Initiating..." : "Initiate Payment"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
        <div className="space-y-2">
          {(txns ?? []).map(t => (
            <Card key={t.id}><CardContent className="pt-3 pb-3"><div className="flex items-center justify-between"><div><p className="font-semibold">{t.provider.replace(/_/g, " ").toUpperCase()}</p><p className="text-sm text-gray-500">{t.phoneNumber} | {t.currency} {t.amount}</p><p className="text-xs text-gray-400">{new Date(t.createdAt).toLocaleString()}</p></div><Badge className={statusColor(t.status)}>{t.status}</Badge></div></CardContent></Card>
          ))}
          {(txns ?? []).length === 0 && <p className="text-center text-gray-400 py-8">No mobile money transactions yet.</p>}
        </div>
      </div>
    </DashboardLayout>
  );
}
