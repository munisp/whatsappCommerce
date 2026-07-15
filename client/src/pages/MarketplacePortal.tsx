import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Store, DollarSign, Users, TrendingUp, Plus } from "lucide-react";
import { toast } from "sonner";

const TENANT_ID = "default";

export default function MarketplacePortal() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ businessName: "", ownerPhone: "", ownerName: "", email: "", category: "", commissionRate: "10.00" });

  const { data: sellers, refetch } = trpc.marketplace.listSellers.useQuery({ tenantId: TENANT_ID });
  const { data: commissions } = trpc.marketplace.listCommissions.useQuery({ tenantId: undefined });
  const { data: stats } = trpc.marketplace.marketplaceStats.useQuery({ tenantId: TENANT_ID });

  const register = trpc.marketplace.registerSeller.useMutation({
    onSuccess: () => { toast.success("Seller registered"); setOpen(false); refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const updateStatus = trpc.marketplace.updateSellerStatus.useMutation({ onSuccess: () => refetch() });

  const statusColor = (s: string) => {
    if (s === "active") return "bg-green-100 text-green-800";
    if (s === "pending") return "bg-yellow-100 text-yellow-800";
    if (s === "suspended") return "bg-red-100 text-red-800";
    return "bg-gray-100 text-gray-700";
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">Marketplace Portal</h1>
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Total Sellers", value: stats.totalSellers, icon: Store, color: "text-blue-600" },
              { label: "Active Sellers", value: stats.activeSellers, icon: Users, color: "text-green-600" },
              { label: "Commission Earned", value: `₦${parseFloat(stats.totalCommissionEarned).toLocaleString()}`, icon: TrendingUp, color: "text-purple-600" },
              { label: "Pending Commission", value: `₦${parseFloat(stats.pendingCommission).toLocaleString()}`, icon: DollarSign, color: "text-orange-600" },
            ].map(({ label, value, icon: Icon, color }) => (
              <Card key={label}><CardContent className="pt-4"><div className="flex items-center gap-3"><Icon className={`w-8 h-8 ${color}`} /><div><p className="text-2xl font-bold">{value}</p><p className="text-xs text-gray-500">{label}</p></div></div></CardContent></Card>
            ))}
          </div>
        )}
        <Tabs defaultValue="sellers">
          <TabsList><TabsTrigger value="sellers">Sellers</TabsTrigger><TabsTrigger value="commissions">Commissions</TabsTrigger></TabsList>
          <TabsContent value="sellers" className="pt-4 space-y-3">
            <div className="flex justify-end">
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild><Button size="sm"><Plus className="w-4 h-4 mr-1" />Register Seller</Button></DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Register New Seller</DialogTitle></DialogHeader>
                  <div className="space-y-3 pt-2">
                    {["businessName", "ownerPhone", "ownerName", "email", "category"].map(k => (
                      <Input key={k} placeholder={k.replace(/([A-Z])/g, " $1").trim()} value={(form as Record<string,string>)[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
                    ))}
                    <Input placeholder="Commission Rate (%)" value={form.commissionRate} onChange={e => setForm(f => ({ ...f, commissionRate: e.target.value }))} />
                    <Button className="w-full" onClick={() => register.mutate({ tenantId: TENANT_ID, ...form })} disabled={register.isPending}>Register</Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            {(sellers ?? []).map(s => (
              <Card key={s.id}><CardContent className="pt-4"><div className="flex items-center justify-between"><div><p className="font-semibold">{s.businessName}</p><p className="text-sm text-gray-500">{s.ownerPhone} | {s.category ?? "General"} | {s.commissionRate}% commission</p></div><div className="flex items-center gap-2"><Badge className={statusColor(s.status)}>{s.status}</Badge>{s.status === "pending" && <Button size="sm" variant="outline" onClick={() => updateStatus.mutate({ id: s.id, status: "active" })}>Approve</Button>}</div></div></CardContent></Card>
            ))}
            {(sellers ?? []).length === 0 && <p className="text-center text-gray-400 py-8">No sellers registered yet.</p>}
          </TabsContent>
          <TabsContent value="commissions" className="pt-4 space-y-3">
            {(commissions ?? []).map(c => (
              <Card key={c.id}><CardContent className="pt-4"><div className="flex items-center justify-between"><div><p className="font-semibold">Order #{c.orderId.slice(0,8)}</p><p className="text-sm text-gray-500">Sale: {c.currency} {c.saleAmount} | Commission: {c.commissionRate}% = {c.commissionAmount}</p></div><Badge className={c.status === "paid" ? "bg-green-100 text-green-800" : "bg-yellow-100 text-yellow-800"}>{c.status}</Badge></div></CardContent></Card>
            ))}
            {(commissions ?? []).length === 0 && <p className="text-center text-gray-400 py-8">No commissions recorded yet.</p>}
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
