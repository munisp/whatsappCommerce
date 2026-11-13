import DashboardLayout from "@/components/DashboardLayout";
import { AdminGuard } from "@/components/AdminGuard";
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
import { Plus, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const planColors: Record<string, string> = {
  starter: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  growth: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  enterprise: "bg-purple-500/20 text-purple-400 border-purple-500/30",
};
const STATE: Record<string, { label: string; cls: string }> = {
  live: { label: "Live", cls: "bg-green-500/15 text-green-600 border-green-500/30" },
  setting_up: { label: "Setting up", cls: "bg-amber-500/15 text-amber-600 border-amber-500/30" },
  trial: { label: "Trial", cls: "bg-amber-500/10 text-amber-600 border-amber-500/20" },
  failed: { label: "Setup failed", cls: "bg-red-500/15 text-red-600 border-red-500/30" },
  suspended: { label: "Suspended", cls: "bg-muted text-muted-foreground" },
};
const KYB: Record<string, { label: string; cls: string }> = {
  approved: { label: "Verified", cls: "bg-green-500/15 text-green-600 border-green-500/30" },
  pending: { label: "Waiting for review", cls: "bg-amber-500/15 text-amber-600 border-amber-500/30" },
  under_review: { label: "In review", cls: "bg-amber-500/15 text-amber-600 border-amber-500/30" },
  appealed: { label: "Appealed", cls: "bg-amber-500/15 text-amber-600 border-amber-500/30" },
  rejected: { label: "Rejected", cls: "bg-red-500/15 text-red-600 border-red-500/30" },
  expired: { label: "Expired", cls: "bg-red-500/15 text-red-600 border-red-500/30" },
  resubmit_required: { label: "Resubmit", cls: "bg-red-500/15 text-red-600 border-red-500/30" },
  not_started: { label: "Not started", cls: "bg-muted text-muted-foreground" },
};
const statusColors: Record<string, string> = {
  active: "bg-green-500/20 text-green-400 border-green-500/30",
  trial: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  suspended: "bg-red-500/20 text-red-400 border-red-500/30",
  churned: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

function TenantsInner() {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", slug: "", plan: "starter" as const, defaultCurrency: "NGN" });

  const shops = trpc.platformOverview.shops.useQuery();
  const refetch = shops.refetch;
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<string>(() => new URLSearchParams(window.location.search).get("state") ?? "all");
  const all = shops.data ?? [];
  const counts = { live: 0, setting_up: 0, trial: 0, failed: 0, suspended: 0 } as Record<string, number>;
  for (const t of all) counts[t.state] = (counts[t.state] ?? 0) + 1;
  const needle = q.trim().toLowerCase();
  const shown = all.filter((t) =>
    (filter === "all" || t.state === filter || (filter === "setting_up" && t.state === "trial")) &&
    (!needle || t.name.toLowerCase().includes(needle) || t.slug.includes(needle)));
  const createMutation = trpc.tenant.create.useMutation({
    onSuccess: () => { toast.success("Shop created"); setOpen(false); refetch(); },
    onError: (e) => toast.error(e.message),
  });


  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Shops</h1>
            <p className="text-muted-foreground mt-1">Every shop on the platform, where it is in setup, and how customers reach it</p>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="bg-primary text-primary-foreground gap-2"><Plus className="w-4 h-4" />New shop</Button>
            </DialogTrigger>
            <DialogContent className="bg-card border-border">
              <DialogHeader><DialogTitle>Create shop</DialogTitle></DialogHeader>
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
                  {createMutation.isPending ? "Creating..." : "Create shop"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { key: "live", label: "Live", value: counts.live, hint: "Taking orders" },
            { key: "setting_up", label: "Setting up", value: counts.setting_up + counts.trial, hint: "Not open for orders yet" },
            { key: "failed", label: "Setup failed", value: counts.failed, hint: "Need a look" },
            { key: "suspended", label: "Suspended", value: counts.suspended, hint: "Switched off" },
          ].map((c) => (
            <button key={c.key} type="button" onClick={() => setFilter(filter === c.key ? "all" : c.key)}
              className={`text-left rounded-lg border p-4 bg-card transition-colors hover:bg-accent/30 ${filter === c.key ? "border-primary ring-1 ring-primary" : "border-border"}`}>
              <p className="text-xs text-muted-foreground">{c.label}</p>
              <p className="text-2xl font-bold mt-1 text-foreground tabular-nums">{c.value}</p>
              <p className="text-xs text-muted-foreground mt-1">{c.hint}</p>
            </button>
          ))}
        </div>

        <Card className="bg-card border-border">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between space-y-0">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {filter === "all" ? "All shops" : STATE[filter]?.label ?? "Shops"} · {shown.length}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or slug" aria-label="Search shops" className="pl-8 h-9 w-56 bg-input border-border" />
              </div>
              {filter !== "all" && <Button variant="ghost" size="sm" onClick={() => setFilter("all")}>Show all</Button>}
            </div>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Shop</TableHead>
                  <TableHead>Setup</TableHead>
                  <TableHead>WhatsApp</TableHead>
                  <TableHead>Verification</TableHead>
                  <TableHead className="text-right">Products</TableHead>
                  <TableHead className="text-right">Orders</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shops.isLoading ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">Loading shops…</TableCell></TableRow>
                ) : shown.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    {q || filter !== "all" ? "No shops match." : "No shops yet. Create the first one."}
                  </TableCell></TableRow>
                ) : shown.map((t) => (
                  <TableRow key={t.id} className="border-border hover:bg-accent/30 cursor-pointer" onClick={() => navigate(`/tenants/${t.id}`)}>
                    <TableCell>
                      <div className="font-medium">{t.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{t.slug}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATE[t.state]?.cls ?? ""} title={t.setupProblems.join("; ") || undefined}>{STATE[t.state]?.label ?? t.state}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {t.whatsapp === "own" ? "Own number" : "Shared number"}
                      {t.whatsapp === "shared" && t.state === "live" && !t.hasLocation && <div className="text-xs text-amber-500">No map location</div>}
                    </TableCell>
                    <TableCell><Badge variant="outline" className={KYB[t.verification]?.cls ?? "bg-muted text-muted-foreground"}>{KYB[t.verification]?.label ?? t.verification.replace(/_/g, " ")}</Badge></TableCell>
                    <TableCell className="text-right tabular-nums">
                      {t.products}
                      {t.products > 0 && t.productsWithoutPhoto === t.products && <div className="text-xs text-muted-foreground">no photos</div>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {t.orders}
                      {t.lastOrderAt && <div className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(t.lastOrderAt), { addSuffix: true })}</div>}
                    </TableCell>
                    <TableCell><Badge variant="outline" className={planColors[t.plan ?? ""] ?? ""}>{t.plan ?? "—"}</Badge></TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">{formatDistanceToNow(new Date(t.createdAt), { addSuffix: true })}</TableCell>
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

export default function Tenants() {
  return (
    <AdminGuard>
      <TenantsInner />
    </AdminGuard>
  );
}
