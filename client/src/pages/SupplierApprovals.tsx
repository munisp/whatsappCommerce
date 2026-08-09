/**
 * SupplierApprovals — supplier-side PO inbox (route /supplier-approvals).
 *
 * "Pending" tab: POs awaiting my decision, one card each — buyer, lines
 * summary, subtotal, requested terms and a credit-fit chip (within-limit /
 * over-limit / no-account / frozen from the buyer's credit account with me).
 * Approve directly; Reject requires a reason.
 *
 * "History" tab: decided POs (approved / rejected / cancelled) as a table.
 */
import { useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { CreditStatusChip } from "@/components/b2b/CreditStatusChip";
import { PoStatusBadge } from "@/components/b2b/PoStatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useActiveTenant } from "@/contexts/TenantContext";
import { useApprovePo, useB2bUtils, useCreditAccounts, usePos, useRejectPo } from "@/lib/b2b";
import { formatDate, formatNaira, type PurchaseOrder } from "@/lib/b2bLogic";
import { Check, ClipboardCheck, Inbox, Loader2, X } from "lucide-react";
import { toast } from "sonner";

function linesSummary(po: PurchaseOrder): string {
  const parts = po.lines.slice(0, 2).map((l) => `${l.quantity}× ${l.name}`);
  const rest = po.lines.length - parts.length;
  return rest > 0 ? `${parts.join(", ")} +${rest} more` : parts.join(", ");
}

function PendingCard({
  tenantId,
  po,
  account,
  onApprove,
  onReject,
  busy,
}: {
  tenantId: string;
  po: PurchaseOrder;
  account: { status: string; limit: number; outstanding: number } | null;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  void tenantId;
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base">{po.buyerName ?? po.buyerTenantId}</CardTitle>
            <CardDescription>
              <span className="font-mono text-xs">{po.poNumber}</span> · {formatDate(po.createdAt)}
            </CardDescription>
          </div>
          <CreditStatusChip
            account={account as { status: "active" | "frozen" | "closed"; limit: number; outstanding: number } | null}
            poSubtotal={po.subtotal}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{linesSummary(po) || "No lines"}</p>
        <div className="flex items-center gap-4 text-sm flex-wrap">
          <span className="font-semibold">{formatNaira(po.subtotal)}</span>
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {po.paymentMode === "credit" ? `On credit · net ${po.termsDays ?? 0}d` : "Pay now"}
          </Badge>
        </div>
        <div className="flex gap-2 pt-1">
          <Button size="sm" className="gap-1.5" disabled={busy} onClick={onApprove}>
            <Check className="w-4 h-4" /> Approve
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5 text-destructive" disabled={busy} onClick={onReject}>
            <X className="w-4 h-4" /> Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SupplierApprovals() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const utils = useB2bUtils();
  const { data: pending, isLoading, error, refetch } = usePos({ tenantId, side: "supplier", status: "pending_approval" });
  const { data: decided, isLoading: decidedLoading } = usePos({ tenantId, side: "supplier" });
  const { data: accounts } = useCreditAccounts({ tenantId, side: "supplier" });

  const [rejectTarget, setRejectTarget] = useState<PurchaseOrder | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const invalidate = () => utils?.procurement?.listPos?.invalidate();

  const approve = useApprovePo({
    onSuccess: (po) => {
      toast.success(`Approved ${po.poNumber ?? "PO"}`);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const reject = useRejectPo({
    onSuccess: (po) => {
      toast.success(`Rejected ${po.poNumber ?? "PO"}`);
      invalidate();
      setRejectTarget(null);
      setRejectReason("");
    },
    onError: (e) => toast.error(e.message),
  });

  // buyerTenantId → their credit account with me
  const accountByBuyer = useMemo(() => {
    const map = new Map<string, { status: string; limit: number; outstanding: number }>();
    for (const a of accounts ?? []) map.set(a.buyerTenantId, { status: a.status, limit: a.limit, outstanding: a.outstanding });
    return map;
  }, [accounts]);

  const history = useMemo(
    () => (decided ?? []).filter((p) => ["approved", "rejected", "invoiced", "paid", "fulfilled", "cancelled"].includes(p.status)),
    [decided],
  );

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <ClipboardCheck className="w-6 h-6 text-primary" /> PO Approvals
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Purchase orders from your buyers waiting for a decision.
          </p>
        </div>

        <Tabs defaultValue="pending">
          <TabsList>
            <TabsTrigger value="pending">
              Pending{(pending ?? []).length > 0 ? ` (${(pending ?? []).length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="pending" className="mt-4">
            {isLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground py-16 justify-center">
                <Loader2 className="w-5 h-5 animate-spin" /> Loading inbox…
              </div>
            ) : error ? (
              <Card>
                <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
                  <p className="text-sm font-medium">Could not load the approvals inbox</p>
                  <p className="text-xs text-muted-foreground max-w-md">{error.message}</p>
                  <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
                </CardContent>
              </Card>
            ) : (pending ?? []).length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
                  <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
                    <Inbox className="h-7 w-7 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="font-medium">Inbox zero</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      New purchase orders from buyers will land here for approval.
                    </p>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {(pending ?? []).map((po) => (
                  <PendingCard
                    key={po.id}
                    tenantId={tenantId}
                    po={po}
                    account={accountByBuyer.get(po.buyerTenantId) ?? null}
                    busy={approve.isPending || reject.isPending}
                    onApprove={() => approve.mutate({ tenantId, poId: po.id })}
                    onReject={() => setRejectTarget(po)}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            {decidedLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground py-16 justify-center">
                <Loader2 className="w-5 h-5 animate-spin" /> Loading history…
              </div>
            ) : history.length === 0 ? (
              <Card>
                <CardContent className="py-14 text-center text-sm text-muted-foreground">
                  No decided purchase orders yet.
                </CardContent>
              </Card>
            ) : (
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>PO #</TableHead>
                      <TableHead>Buyer</TableHead>
                      <TableHead className="text-right">Subtotal</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Decided reason</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((po) => (
                      <TableRow key={po.id}>
                        <TableCell className="font-mono text-xs">{po.poNumber}</TableCell>
                        <TableCell className="font-medium">{po.buyerName ?? po.buyerTenantId}</TableCell>
                        <TableCell className="text-right">{formatNaira(po.subtotal)}</TableCell>
                        <TableCell><PoStatusBadge status={po.status} /></TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-48 truncate">
                          {po.rejectionReason ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{formatDate(po.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Reject with reason */}
      <Dialog open={!!rejectTarget} onOpenChange={(o) => { if (!o) { setRejectTarget(null); setRejectReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject {rejectTarget?.poNumber}</DialogTitle>
            <DialogDescription>
              Tell the buyer why this purchase order was rejected.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reject-reason">Reason</Label>
            <Textarea
              id="reject-reason"
              rows={3}
              maxLength={300}
              placeholder="e.g. Over your current credit limit — repay ₦X first"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRejectTarget(null); setRejectReason(""); }}>Back</Button>
            <Button
              variant="destructive"
              disabled={!rejectReason.trim() || reject.isPending}
              onClick={() => rejectTarget && reject.mutate({ tenantId, poId: rejectTarget.id, reason: rejectReason.trim() })}
            >
              {reject.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Reject PO
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
