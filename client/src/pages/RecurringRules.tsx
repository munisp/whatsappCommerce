// === W55 ui-c ===
// Recurring payment rules surface for the W32 recurringRules router
// (ORPHAN-BE-07). List/create/pause/resume/cancel per existing procedures.
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
import { Pause, Play, Plus, Repeat, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const statusColors: Record<string, string> = {
  active: "bg-green-500/20 text-green-400 border-green-500/30",
  paused: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  cancelled: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

function fmtMoney(cents: number, currency: string) {
  return `${currency} ${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function RecurringRules() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const utils = trpc.useUtils();

  const { data: rules, isLoading } = trpc.recurringRules.list.useQuery({
    tenantId,
    status: statusFilter === "all" ? undefined : (statusFilter as any),
    limit: 100,
  });

  const invalidate = () => utils.recurringRules.list.invalidate();
  const actionOpts = (label: string) => ({
    onSuccess: () => { toast.success(label); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });
  const pauseMut = trpc.recurringRules.pause.useMutation(actionOpts("Rule paused"));
  const resumeMut = trpc.recurringRules.resume.useMutation(actionOpts("Rule resumed"));
  const cancelMut = trpc.recurringRules.cancel.useMutation(actionOpts("Rule cancelled"));
  const createMut = trpc.recurringRules.create.useMutation({
    onSuccess: () => { toast.success("Recurring rule created"); setCreateOpen(false); invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const [form, setForm] = useState({
    kind: "adhoc" as "vendor_bill" | "adhoc",
    amountNaira: "",
    cadence: "monthly" as "weekly" | "monthly",
    dayOfMonth: "1",
    recipientName: "",
    recipientPhone: "",
    firstRunAt: "",
  });

  const submitCreate = () => {
    const amountCents = Math.round(Number(form.amountNaira) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    createMut.mutate({
      tenantId,
      kind: form.kind,
      amountCents,
      currency: "NGN",
      cadence: form.cadence,
      dayOfMonth: form.cadence === "monthly" ? Math.min(31, Math.max(1, Number(form.dayOfMonth) || 1)) : undefined,
      firstRunAt: form.firstRunAt ? new Date(form.firstRunAt) : undefined,
      recipient: {
        name: form.recipientName || undefined,
        phone: form.recipientPhone || undefined,
      },
    });
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Recurring Rules</h1>
            <p className="text-muted-foreground mt-1">Weekly/monthly standing payments — run by the daily recurring sweep</p>
          </div>
          <Button onClick={() => setCreateOpen(true)} className="gap-1">
            <Plus className="w-4 h-4" /> New rule
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-48 bg-card border-border">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Rules</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Kind</TableHead>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Cadence</TableHead>
                  <TableHead>Next run</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
                ) : !rules?.length ? (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    <div className="flex flex-col items-center gap-2">
                      <Repeat className="w-8 h-8 opacity-40" />
                      No recurring rules
                    </div>
                  </TableCell></TableRow>
                ) : rules.map((r: any) => {
                  const recipient = (r.recipient as { name?: string; vendorName?: string } | null) ?? null;
                  return (
                    <TableRow key={r.id} className="border-border hover:bg-accent/30">
                      <TableCell><Badge variant="outline">{String(r.kind).replaceAll("_", " ")}</Badge></TableCell>
                      <TableCell className="text-sm">{recipient?.name ?? recipient?.vendorName ?? "—"}</TableCell>
                      <TableCell className="font-mono">{fmtMoney(r.amountCents, r.currency)}</TableCell>
                      <TableCell className="text-sm">{r.cadence}{r.cadence === "monthly" && r.dayOfMonth ? ` (day ${r.dayOfMonth})` : ""}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {r.nextRunAt ? formatDistanceToNow(new Date(r.nextRunAt), { addSuffix: true }) : "—"}
                      </TableCell>
                      <TableCell><Badge variant="outline" className={statusColors[r.status] ?? ""}>{r.status}</Badge></TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {r.status === "active" && (
                            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"
                              disabled={pauseMut.isPending}
                              onClick={() => pauseMut.mutate({ tenantId, id: r.id })}>
                              <Pause className="w-3 h-3" /> Pause
                            </Button>
                          )}
                          {r.status === "paused" && (
                            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"
                              disabled={resumeMut.isPending}
                              onClick={() => resumeMut.mutate({ tenantId, id: r.id })}>
                              <Play className="w-3 h-3" /> Resume
                            </Button>
                          )}
                          {r.status !== "cancelled" && (
                            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-red-400 hover:text-red-300"
                              disabled={cancelMut.isPending}
                              onClick={() => cancelMut.mutate({ tenantId, id: r.id })}>
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
            <DialogHeader><DialogTitle>New recurring rule</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Kind</Label>
                  <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v as any })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="adhoc">Ad-hoc</SelectItem>
                      <SelectItem value="vendor_bill">Vendor bill</SelectItem>
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
                  <Label>Cadence</Label>
                  <Select value={form.cadence} onValueChange={(v) => setForm({ ...form, cadence: v as any })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {form.cadence === "monthly" && (
                  <div className="space-y-2">
                    <Label>Day of month</Label>
                    <Input type="number" min={1} max={31} value={form.dayOfMonth}
                      onChange={(e) => setForm({ ...form, dayOfMonth: e.target.value })} />
                  </div>
                )}
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
              <div className="space-y-2">
                <Label>First run (optional)</Label>
                <Input type="datetime-local" value={form.firstRunAt} onChange={(e) => setForm({ ...form, firstRunAt: e.target.value })} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>Close</Button>
              <Button onClick={submitCreate} disabled={createMut.isPending}>Create rule</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
