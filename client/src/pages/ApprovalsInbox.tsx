// === W55 ui-c ===
// Threshold-approvals inbox for the W31 approvals router (ORPHAN-BE-15):
// pending request list with approve/reject, plus the owner-only policy
// config (threshold, kinds, approver role, expiry).
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
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { Check, ClipboardCheck, Settings, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const statusColors: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  approved: "bg-green-500/20 text-green-400 border-green-500/30",
  executed: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  rejected: "bg-red-500/20 text-red-400 border-red-500/30",
  expired: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

function fmtMoney(cents: number, currency: string) {
  return `${currency} ${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function ApprovalsInbox() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [policyOpen, setPolicyOpen] = useState(false);
  const [decision, setDecision] = useState<{ id: string; approve: boolean } | null>(null);
  const [note, setNote] = useState("");
  const utils = trpc.useUtils();

  const { data: requests, isLoading } = trpc.approvals.list.useQuery({
    tenantId,
    status: statusFilter === "all" ? undefined : (statusFilter as any),
    limit: 100,
  });
  const { data: policy } = trpc.approvals.getPolicy.useQuery({ tenantId });

  const invalidate = () => {
    utils.approvals.list.invalidate();
    utils.approvals.getPolicy.invalidate();
  };

  const approveMut = trpc.approvals.approve.useMutation({
    onSuccess: (r) => {
      toast.success(r.executed ? "Approved and executed" : "Approved");
      setDecision(null); setNote("");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const rejectMut = trpc.approvals.reject.useMutation({
    onSuccess: () => { toast.success("Rejected"); setDecision(null); setNote(""); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const setPolicyMut = trpc.approvals.setPolicy.useMutation({
    onSuccess: (r) => { toast.success(r.enabled ? "Approval policy enabled" : "Approval policy disabled"); setPolicyOpen(false); invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const [policyForm, setPolicyForm] = useState({ thresholdNaira: "", approverRole: "owner" as "owner" | "operator", expiryHours: "72" });
  useEffect(() => {
    if (policy) {
      setPolicyForm({
        thresholdNaira: ((policy.thresholdCents ?? 0) / 100).toString(),
        approverRole: (policy.approverRole as "owner" | "operator") ?? "owner",
        expiryHours: String(policy.expiryHours ?? 72),
      });
    }
  }, [policy]);

  const submitPolicy = () => {
    const thresholdCents = Math.round(Number(policyForm.thresholdNaira) * 100);
    if (!Number.isFinite(thresholdCents) || thresholdCents < 0) {
      toast.error("Enter a valid threshold (0 disables approvals)");
      return;
    }
    setPolicyMut.mutate({
      tenantId,
      thresholdCents,
      approverRole: policyForm.approverRole,
      expiryHours: Math.min(720, Math.max(1, Number(policyForm.expiryHours) || 72)),
    });
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Approvals</h1>
            <p className="text-muted-foreground mt-1">
              Money movements above your threshold wait here for a decision
              {policy && policy.thresholdCents > 0
                ? ` — currently gating at ${fmtMoney(policy.thresholdCents, "NGN")}`
                : " — approvals are currently off"}
            </p>
          </div>
          <Button variant="outline" onClick={() => setPolicyOpen(true)} className="gap-1">
            <Settings className="w-4 h-4" /> Policy
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-48 bg-card border-border">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="executed">Executed</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Approval requests</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Kind</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
                ) : !requests?.length ? (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    <div className="flex flex-col items-center gap-2">
                      <ClipboardCheck className="w-8 h-8 opacity-40" />
                      No {statusFilter === "all" ? "" : statusFilter} approval requests
                    </div>
                  </TableCell></TableRow>
                ) : requests.map((r) => (
                  <TableRow key={r.id} className="border-border hover:bg-accent/30">
                    <TableCell><Badge variant="outline">{r.kind.replaceAll("_", " ")}</Badge></TableCell>
                    <TableCell className="font-mono">{fmtMoney(r.amountCents, r.currency)}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatDistanceToNow(new Date(r.expiresAt), { addSuffix: true })}</TableCell>
                    <TableCell><Badge variant="outline" className={statusColors[r.status] ?? ""}>{r.status}</Badge></TableCell>
                    <TableCell>
                      {r.status === "pending" && (
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-green-400 hover:text-green-300"
                            onClick={() => { setDecision({ id: r.id, approve: true }); setNote(""); }}>
                            <Check className="w-3 h-3" /> Approve
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-red-400 hover:text-red-300"
                            onClick={() => { setDecision({ id: r.id, approve: false }); setNote(""); }}>
                            <X className="w-3 h-3" /> Reject
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Dialog open={!!decision} onOpenChange={() => setDecision(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>{decision?.approve ? "Approve" : "Reject"} request</DialogTitle></DialogHeader>
            <div className="space-y-2">
              <Label>Decision note (optional)</Label>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
              {decision?.approve && (
                <p className="text-xs text-muted-foreground">
                  Approving executes the gated action immediately. Withdrawals above the step-up threshold
                  still require a fresh OTP — the server will reject honestly if one is needed.
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDecision(null)}>Close</Button>
              <Button
                variant={decision?.approve ? "default" : "destructive"}
                disabled={approveMut.isPending || rejectMut.isPending}
                onClick={() => {
                  if (!decision) return;
                  if (decision.approve) {
                    approveMut.mutate({ tenantId, approvalId: decision.id, note: note || undefined });
                  } else {
                    rejectMut.mutate({ tenantId, approvalId: decision.id, note: note || undefined });
                  }
                }}
              >
                {decision?.approve ? "Approve" : "Reject"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={policyOpen} onOpenChange={setPolicyOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Approval policy</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Threshold (NGN) — 0 disables approvals</Label>
                <Input type="number" min="0" step="0.01" value={policyForm.thresholdNaira}
                  onChange={(e) => setPolicyForm({ ...policyForm, thresholdNaira: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Approver role</Label>
                  <Select value={policyForm.approverRole} onValueChange={(v) => setPolicyForm({ ...policyForm, approverRole: v as any })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="owner">Owner only</SelectItem>
                      <SelectItem value="operator">Operator</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Request expiry (hours)</Label>
                  <Input type="number" min={1} max={720} value={policyForm.expiryHours}
                    onChange={(e) => setPolicyForm({ ...policyForm, expiryHours: e.target.value })} />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPolicyOpen(false)}>Close</Button>
              <Button onClick={submitPolicy} disabled={setPolicyMut.isPending}>Save policy</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
