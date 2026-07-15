import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { Building2, Plus, TrendingUp, Users } from "lucide-react";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const planColors: Record<string, string> = {
  starter: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  growth: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  enterprise: "bg-purple-500/20 text-purple-400 border-purple-500/30",
};
const statusColors: Record<string, string> = {
  active: "bg-green-500/20 text-green-400 border-green-500/30",
  trial: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  suspended: "bg-red-500/20 text-red-400 border-red-500/30",
  churned: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

export default function Tenants() {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", slug: "", plan: "starter" as const, defaultCurrency: "USD" });

  const { data: stats } = trpc.tenant.stats.useQuery();
  const { data: tenantList, refetch } = trpc.tenant.list.useQuery();
  const { data: ssoProfiles } = trpc.keycloak.listSsoProfiles.useQuery({ limit: 200 });
  const ssoMap = new Map((ssoProfiles?.profiles ?? []).map((p) => [p.tenantId, p]));
  const createMutation = trpc.tenant.create.useMutation({
    onSuccess: () => { toast.success("Tenant created"); setOpen(false); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Tenants</h1>
            <p className="text-muted-foreground mt-1">Manage merchant accounts and their configurations</p>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="bg-primary text-primary-foreground gap-2"><Plus className="w-4 h-4" />New Tenant</Button>
            </DialogTrigger>
            <DialogContent className="bg-card border-border">
              <DialogHeader><DialogTitle>Create Tenant</DialogTitle></DialogHeader>
              <div className="space-y-4 mt-2">
                <div className="space-y-1">
                  <Label>Name</Label>
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme Store" className="bg-input border-border" />
                </div>
                <div className="space-y-1">
                  <Label>Slug</Label>
                  <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} placeholder="acme-store" className="bg-input border-border" />
                </div>
                <div className="space-y-1">
                  <Label>Plan</Label>
                  <Select value={form.plan} onValueChange={(v) => setForm({ ...form, plan: v as any })}>
                    <SelectTrigger className="bg-input border-border"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="starter">Starter</SelectItem>
                      <SelectItem value="growth">Growth</SelectItem>
                      <SelectItem value="enterprise">Enterprise</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button className="w-full bg-primary text-primary-foreground" onClick={() => createMutation.mutate(form)} disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Creating..." : "Create Tenant"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: "Total", value: stats?.total ?? 0, icon: Building2, color: "text-foreground" },
            { label: "Active", value: stats?.active ?? 0, icon: TrendingUp, color: "text-green-400" },
            { label: "Trial", value: stats?.trial ?? 0, icon: Users, color: "text-yellow-400" },
            { label: "Suspended", value: stats?.suspended ?? 0, icon: Building2, color: "text-red-400" },
          ].map((s) => (
            <Card key={s.label} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">{s.label}</p>
                    <p className={`text-2xl font-bold mt-1 ${s.color}`}>{s.value}</p>
                  </div>
                  <s.icon className={`w-8 h-8 ${s.color} opacity-50`} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">All Tenants</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead>AI</TableHead>
                  <TableHead>SSO</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!tenantList || tenantList.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No tenants yet. Create your first one.</TableCell></TableRow>
                ) : tenantList.map((t) => (
                  <TableRow key={t.id} className="border-border hover:bg-accent/30 cursor-pointer" onClick={() => navigate(`/tenants/${t.id}`)}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{t.slug}</TableCell>
                    <TableCell><Badge variant="outline" className={planColors[t.plan] ?? ""}>{t.plan}</Badge></TableCell>
                    <TableCell><Badge variant="outline" className={statusColors[t.status] ?? ""}>{t.status}</Badge></TableCell>
                    <TableCell className="font-mono text-xs">{t.defaultCurrency}</TableCell>
                    <TableCell><Badge variant="outline" className={t.aiEnabled ? "bg-green-500/20 text-green-400 border-green-500/30" : "bg-muted text-muted-foreground"}>{t.aiEnabled ? "On" : "Off"}</Badge></TableCell>
                    <TableCell>
                      {ssoMap.has(t.id) ? (
                        <div className="flex items-center gap-1.5">
                          <KeyRound className="w-3 h-3 text-violet-400" />
                          <span className="text-xs text-violet-400">{(ssoMap.get(t.id) as any)?.ssoProvider ?? "SSO"}</span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatDistanceToNow(new Date(t.createdAt), { addSuffix: true })}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
