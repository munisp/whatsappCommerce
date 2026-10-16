// === W55 ui-a ===
/**
 * W55 (Coder UI-A): MembershipPlans — merchant surface for the W54 CAP-1
 * membershipPlans router: plan CRUD (name, price in integer cents, period,
 * discountPercent, pointsMultiplier, archive toggle) plus the member roster
 * (customer_memberships) with plan/status filters. Buyer join/status/cancel
 * stays WA/TG/USSD-only by design.
 */
import { useState } from "react";
import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

function fmt(cents: number, currency = "NGN") {
  return `${currency} ${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string | Date | null | undefined) {
  return d ? new Date(d).toLocaleDateString() : "—";
}

type PlanForm = {
  name: string;
  description: string;
  priceMajor: string;
  period: "day" | "week" | "month";
  discountPercent: string;
  pointsMultiplier: string;
};

const emptyForm: PlanForm = { name: "", description: "", priceMajor: "0", period: "month", discountPercent: "0", pointsMultiplier: "1" };

export default function MembershipPlans() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const utils = trpc.useUtils();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PlanForm>(emptyForm);
  const [rosterPlanId, setRosterPlanId] = useState<string>("all");
  const [rosterStatus, setRosterStatus] = useState<string>("all");

  const { data: plans } = trpc.membershipPlans.listPlans.useQuery({ tenantId, includeArchived });
  const { data: roster } = trpc.membershipPlans.roster.useQuery({
    tenantId,
    planId: rosterPlanId === "all" ? undefined : rosterPlanId,
    status: rosterStatus === "all" ? undefined : (rosterStatus as any),
    limit: 200,
  });

  const onError = (e: any) => toast.error(e?.message ?? "Failed");
  const invalidate = () => {
    utils.membershipPlans.listPlans.invalidate();
    utils.membershipPlans.roster.invalidate();
  };
  const createMut = trpc.membershipPlans.createPlan.useMutation({
    onSuccess: () => { toast.success("Plan created"); setDialogOpen(false); setForm(emptyForm); invalidate(); }, onError,
  });
  const updateMut = trpc.membershipPlans.updatePlan.useMutation({
    onSuccess: () => { toast.success("Plan updated"); setDialogOpen(false); setEditingId(null); setForm(emptyForm); invalidate(); }, onError,
  });
  const archiveMut = trpc.membershipPlans.archivePlan.useMutation({
    onSuccess: () => { toast.success("Plan archived"); invalidate(); }, onError,
  });

  const openCreate = () => { setEditingId(null); setForm(emptyForm); setDialogOpen(true); };
  const openEdit = (p: any) => {
    setEditingId(p.id);
    setForm({
      name: p.name,
      description: p.description ?? "",
      priceMajor: (p.priceCents / 100).toString(),
      period: p.period,
      discountPercent: String(p.discountPercent),
      pointsMultiplier: String(p.pointsMultiplier),
    });
    setDialogOpen(true);
  };

  const submit = () => {
    const payload = {
      name: form.name,
      description: form.description || undefined,
      priceCents: Math.round(parseFloat(form.priceMajor || "0") * 100),
      period: form.period,
      discountPercent: parseInt(form.discountPercent || "0", 10),
      pointsMultiplier: parseInt(form.pointsMultiplier || "1", 10),
    };
    if (editingId) updateMut.mutate({ tenantId, planId: editingId, ...payload });
    else createMut.mutate({ tenantId, ...payload });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Membership Plans</h1>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
              Show archived
            </label>
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild><Button onClick={openCreate}>Create plan</Button></DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>{editingId ? "Edit plan" : "Create plan"}</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                  <div><Label>Description</Label><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><Label>Price (major units)</Label><Input value={form.priceMajor} onChange={(e) => setForm({ ...form, priceMajor: e.target.value })} inputMode="decimal" /></div>
                    <div>
                      <Label>Period</Label>
                      <Select value={form.period} onValueChange={(v) => setForm({ ...form, period: v as PlanForm["period"] })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="day">Day</SelectItem>
                          <SelectItem value="week">Week</SelectItem>
                          <SelectItem value="month">Month</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div><Label>Discount % (0-100)</Label><Input value={form.discountPercent} onChange={(e) => setForm({ ...form, discountPercent: e.target.value })} inputMode="numeric" /></div>
                    <div><Label>Points multiplier (1-10)</Label><Input value={form.pointsMultiplier} onChange={(e) => setForm({ ...form, pointsMultiplier: e.target.value })} inputMode="numeric" /></div>
                  </div>
                  <Button disabled={createMut.isPending || updateMut.isPending || !form.name} onClick={submit}>
                    {editingId ? "Save changes" : "Create"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <Card>
          <CardHeader><CardTitle>Plans</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Price</TableHead><TableHead>Period</TableHead><TableHead>Discount</TableHead><TableHead>Points ×</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {(plans ?? []).map((p: any) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>{fmt(p.priceCents, p.currency)}</TableCell>
                    <TableCell>{p.period}</TableCell>
                    <TableCell>{p.discountPercent}%</TableCell>
                    <TableCell>{p.pointsMultiplier}×</TableCell>
                    <TableCell><Badge variant={p.status === "active" ? "default" : "secondary"}>{p.status}</Badge></TableCell>
                    <TableCell className="space-x-2">
                      <Button size="sm" variant="outline" onClick={() => openEdit(p)}>Edit</Button>
                      {p.status === "active" && (
                        <Button size="sm" variant="destructive" disabled={archiveMut.isPending}
                          onClick={() => archiveMut.mutate({ tenantId, planId: p.id })}>Archive</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {(plans ?? []).length === 0 && <TableRow><TableCell colSpan={7}>No plans yet.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Member roster</CardTitle>
            <div className="flex gap-3">
              <Select value={rosterPlanId} onValueChange={setRosterPlanId}>
                <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All plans</SelectItem>
                  {(plans ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={rosterStatus} onValueChange={setRosterStatus}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                  <SelectItem value="expired">Expired</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Customer</TableHead><TableHead>Plan</TableHead><TableHead>Status</TableHead><TableHead>Started</TableHead><TableHead>Period end</TableHead><TableHead>Cancels at end</TableHead></TableRow></TableHeader>
              <TableBody>
                {(roster ?? []).map((r: any) => (
                  <TableRow key={r.membershipId}>
                    <TableCell className="font-mono">{r.customerId}</TableCell>
                    <TableCell>{r.planName}</TableCell>
                    <TableCell><Badge variant={r.status === "active" ? "default" : "secondary"}>{r.status}</Badge></TableCell>
                    <TableCell>{fmtDate(r.startedAt)}</TableCell>
                    <TableCell>{fmtDate(r.currentPeriodEnd)}</TableCell>
                    <TableCell>{r.cancelAtPeriodEnd ? "Yes" : "—"}</TableCell>
                  </TableRow>
                ))}
                {(roster ?? []).length === 0 && <TableRow><TableCell colSpan={6}>No members found.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
// === END W55 ui-a ===
