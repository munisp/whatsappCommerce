/**
 * SupplierApprovals — supplier-side PO inbox (route /supplier-approvals).
 *
 * "Pending" tab: submitted POs awaiting my decision, one card each — buyer,
 * lines summary (from getPo), subtotal, requested terms and a credit-fit chip
 * (within-limit / over-limit / no-account / frozen from the buyer's credit
 * account with me). Approve (credit draws immediately; pay-now generates the
 * buyer's payment link, shown for sharing); Reject with an optional reason.
 * Credit-guard failures come back as a normal outcome (approved: false), not
 * an error, and are surfaced as a warning toast.
 *
 * "History" tab: decided POs with follow-through actions — mark fulfilled
 * (delivered) and manually confirm payment on pay-now POs.
 */
import { useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { CreditStatusChip } from "@/components/b2b/CreditStatusChip";
import { PoStatusBadge } from "@/components/b2b/PoStatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useActiveTenant } from "@/contexts/TenantContext";
import {
  useApprovePo, useB2bUtils, useCreditAccounts, useMarkFulfilled, useMarkPaid, usePo, usePos, useRejectPo, useTenantNames,
} from "@/lib/b2b";
import { formatDate, formatNaira, type PurchaseOrder } from "@/lib/b2bLogic";
import { Check, ClipboardCheck, Copy, Inbox, Loader2, PackageCheck, Wallet, X } from "lucide-react";
import { toast } from "sonner";

function linesSummary(po: PurchaseOrder): string {
  const lines = po.lines ?? [];
  const parts = lines.slice(0, 2).map((l) => `${l.quantity}× ${l.name}`);
  const rest = lines.length - parts.length;
  return rest > 0 ? `${parts.join(", ")} +${rest} more` : parts.join(", ");
}

function PendingCard({
  po,
  buyerName,
  account,
  onApprove,
  onReject,
  busy,
}: {
  po: PurchaseOrder;
  buyerName: string;
  account: { status: "active" | "frozen" | "closed"; limit: number; outstanding: number } | null;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  const { data: detail, isLoading: detailLoading } = usePo("", po.id);
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base">{buyerName}</CardTitle>
            <CardDescription>
              <span className="font-mono text-xs">{po.poNumber}</span> · {formatDate(po.createdAt)}
            </CardDescription>
          </div>
          <CreditStatusChip account={account} poSubtotal={po.subtotal} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {detailLoading ? "Loading lines…" : linesSummary(detail ?? po) || "No lines"}
        </p>
        <div className="flex items-center gap-4 text-sm flex-wrap">
          <span className="font-semibold">{formatNaira(po.subtotal)}</span>
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {po.paymentMode === "credit" ? `On credit · net ${po.termsDays ?? 0}d` : "Pay now"}
          </Badge>
        </div>
        {po.notes && <p className="text-xs text-muted-foreground italic">“{po.notes}”</p>}
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
  const { data: pending, isLoading, error, refetch } = usePos({ tenantId, side: "supplier", status: "submitted" });
  const { data: decided, isLoading: decidedLoading } = usePos({ tenantId, side: "supplier" });
  const { data: accounts } = useCreditAccounts({ tenantId, side: "supplier" });
  const tenantNames = useTenantNames();

  const [rejectTarget, setRejectTarget] = useState<PurchaseOrder | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [paymentLink, setPaymentLink] = useState<string | null>(null);

  const invalidate = () => utils.procurement.listPos.invalidate();

  const approve = useApprovePo({
    onSuccess: (outcome) => {
      if (!outcome.approved) {
        // Credit guard failure is a normal business outcome, not an error.
        toast.warning(`Approval blocked: ${outcome.creditFailure?.replaceAll("_", " ") ?? "credit check failed"}`);
        return;
      }
      toast.success("PO approved");
      if (outcome.paymentUrl) setPaymentLink(outcome.paymentUrl);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const reject = useRejectPo({
    onSuccess: () => {
      toast.success("PO rejected");
      invalidate();
      setRejectTarget(null);
      setRejectReason("");
    },
    onError: (e) => toast.error(e.message),
  });
  const markFulfilled = useMarkFulfilled({
    onSuccess: () => { toast.success("Marked as fulfilled"); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const markPaid = useMarkPaid({
    onSuccess: () => { toast.success("Payment confirmed"); invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  // buyerTenantId → their credit account with me
  const accountByBuyer = useMemo(() => {
    const map = new Map<string, { status: "active" | "frozen" | "closed"; limit: number; outstanding: number }>();
    for (const a of accounts ?? []) map.set(a.buyerTenantId, { status: a.status, limit: a.limit, outstanding: a.outstanding });
    return map;
  }, [accounts]);

  const history = useMemo(
    () => (decided ?? []).filter((p) => p.status !== "submitted" && p.status !== "draft"),
    [decided],
  );

  const busy = approve.isPending || reject.isPending;

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
                    po={po}
                    buyerName={po.buyerName ?? tenantNames.get(po.buyerTenantId) ?? po.buyerTenantId}
                    account={accountByBuyer.get(po.buyerTenantId) ?? null}
                    busy={busy}
                    onApprove={() => approve.mutate({ poId: po.id })}
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
                      <TableHead>Notes</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((po) => (
                      <TableRow key={po.id}>
                        <TableCell className="font-mono text-xs">{po.poNumber}</TableCell>
                        <TableCell className="font-medium">{po.buyerName ?? tenantNames.get(po.buyerTenantId) ?? po.buyerTenantId}</TableCell>
                        <TableCell className="text-right">{formatNaira(po.subtotal)}</TableCell>
                        <TableCell><PoStatusBadge status={po.status} /></TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-48 truncate">
                          {po.notes ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{formatDate(po.createdAt)}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1.5">
                            {po.status === "approved" && po.paymentMode === "paynow" && (
                              <Button
                                size="sm" variant="outline" className="h-8 gap-1"
                                disabled={markPaid.isPending}
                                onClick={() => markPaid.mutate({ poId: po.id })}
                              >
                                <Wallet className="w-3.5 h-3.5" /> Mark paid
                              </Button>
                            )}
                            {(po.status === "approved" || po.status === "invoiced") && (
                              <Button
                                size="sm" variant="ghost" className="h-8 gap-1"
                                disabled={markFulfilled.isPending}
                                onClick={() => markFulfilled.mutate({ poId: po.id })}
                              >
                                <PackageCheck className="w-3.5 h-3.5" /> Fulfilled
                              </Button>
                            )}
                          </div>
                        </TableCell>
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
              Tell the buyer why this purchase order was rejected (optional).
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
              disabled={reject.isPending}
              onClick={() => rejectTarget && reject.mutate({ poId: rejectTarget.id, reason: rejectReason.trim() || undefined })}
            >
              {reject.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Reject PO
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pay-now payment link generated at approval */}
      <Dialog open={!!paymentLink} onOpenChange={(o) => !o && setPaymentLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Payment link for the buyer</DialogTitle>
            <DialogDescription>
              This link was also sent to the buyer on WhatsApp — share it again if needed.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={paymentLink ?? ""} className="font-mono text-xs" />
            <Button
              variant="outline" size="icon"
              aria-label="Copy payment link"
              onClick={() => {
                navigator.clipboard?.writeText(paymentLink ?? "");
                toast.success("Link copied");
              }}
            >
              <Copy className="w-4 h-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setPaymentLink(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
