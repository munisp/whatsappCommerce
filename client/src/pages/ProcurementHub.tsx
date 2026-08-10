/**
 * ProcurementHub — buyer procurement workspace (route /procurement).
 *
 * Tab "My POs": purchase orders created by this tenant (side=buyer) with
 * status filter, due-date countdowns and contextual actions — pay-now POs get
 * a "Pay" button (payment link), credit-invoiced POs get "Repay"
 * (RepaymentDialog → creditRepay.requestRepaymentLink), draft/pending POs can
 * be cancelled.
 *
 * Tab "Build PO": pick a supplier and compose a PO in the PoBuilderDrawer
 * (catalog lines, MOQ validation, terms + payment mode).
 */
import { useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { PoBuilderDrawer } from "@/components/b2b/PoBuilderDrawer";
import { PoStatusBadge } from "@/components/b2b/PoStatusBadge";
import { RepaymentDialog } from "@/components/b2b/RepaymentDialog";
import { SupplierCard } from "@/components/b2b/SupplierCard";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useActiveTenant } from "@/contexts/TenantContext";
import { useB2bUtils, useCancelPo, useCreditAccounts, usePos, useRequestCreditAccount, useSuppliers, useTenantNames } from "@/lib/b2b";
import {
  dueCountdown, formatDate, formatNaira, type PoStatus, type PurchaseOrder, type SupplierSummary,
} from "@/lib/b2bLogic";
import { FileText, HandCoins, Loader2, Plus, ShoppingCart } from "lucide-react";
import { toast } from "sonner";

const STATUS_FILTERS: Array<{ value: "all" | PoStatus; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "submitted", label: "Pending approval" },
  { value: "approved", label: "Approved" },
  { value: "invoiced", label: "Invoiced" },
  { value: "fulfilled", label: "Fulfilled" },
  { value: "paid", label: "Paid" },
  { value: "rejected", label: "Rejected" },
];

const DUE_TONE: Record<string, string> = {
  ok: "text-muted-foreground",
  warn: "text-amber-400",
  danger: "text-red-400",
  none: "text-muted-foreground",
};

export default function ProcurementHub() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const utils = useB2bUtils();
  const [statusFilter, setStatusFilter] = useState<"all" | PoStatus>("all");
  const { data: pos, isLoading, error, refetch } = usePos(
    { tenantId, side: "buyer", ...(statusFilter === "all" ? {} : { status: statusFilter }) },
  );
  const { data: accounts } = useCreditAccounts({ tenantId, side: "buyer" });
  const { data: suppliers, isLoading: suppliersLoading } = useSuppliers(tenantId);
  const tenantNames = useTenantNames();

  const [poSupplier, setPoSupplier] = useState<SupplierSummary | null>(null);
  const [poOpen, setPoOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<PurchaseOrder | null>(null);
  const [repayTarget, setRepayTarget] = useState<PurchaseOrder | null>(null);

  const cancelPo = useCancelPo({
    onSuccess: () => {
      toast.success("Draft purchase order cancelled");
      utils.procurement.listPos.invalidate();
      setCancelTarget(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const requestCredit = useRequestCreditAccount({
    onSuccess: () => {
      toast.success("Credit request sent — the supplier will review it");
      utils.tradeCredit.myAccounts.invalidate();
      utils.procurement.listSuppliers.invalidate();
    },
    // No requestAccount endpoint exists yet this wave — degrade gracefully.
    onError: () =>
      toast.info("Credit is opened by the supplier — ask them to set you a limit from their Credit Accounts page."),
  });

  // supplierTenantId → my credit account (fallback for Repay when the PO has
  // no creditAccountId yet, and for the dialog's outstanding balance).
  const accountBySupplier = useMemo(() => {
    const map = new Map<string, { id: string; outstanding: number }>();
    for (const a of accounts ?? []) map.set(a.supplierTenantId, { id: a.id, outstanding: a.outstanding });
    return map;
  }, [accounts]);
  const accountById = useMemo(() => {
    const map = new Map<string, { id: string; outstanding: number }>();
    for (const a of accounts ?? []) map.set(a.id, { id: a.id, outstanding: a.outstanding });
    return map;
  }, [accounts]);

  const repayAccount = repayTarget
    ? (repayTarget.creditAccountId ? accountById.get(repayTarget.creditAccountId) : undefined) ??
      accountBySupplier.get(repayTarget.supplierTenantId)
    : undefined;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <ShoppingCart className="w-6 h-6 text-primary" /> Procurement Hub
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Raise purchase orders, track approvals and settle supplier credit.
          </p>
        </div>

        <Tabs defaultValue="pos">
          <TabsList>
            <TabsTrigger value="pos">My POs</TabsTrigger>
            <TabsTrigger value="build">Build PO</TabsTrigger>
          </TabsList>

          {/* ── My POs ─────────────────────────────────────────────────── */}
          <TabsContent value="pos" className="space-y-4 mt-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as "all" | PoStatus)}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_FILTERS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" className="gap-1.5" onClick={() => { setPoSupplier(null); setPoOpen(true); }}>
                <Plus className="w-4 h-4" /> New PO
              </Button>
            </div>

            {isLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground py-16 justify-center">
                <Loader2 className="w-5 h-5 animate-spin" /> Loading purchase orders…
              </div>
            ) : error ? (
              <Card>
                <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
                  <p className="text-sm font-medium">Could not load purchase orders</p>
                  <p className="text-xs text-muted-foreground max-w-md">{error.message}</p>
                  <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
                </CardContent>
              </Card>
            ) : (pos ?? []).length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
                  <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
                    <FileText className="h-7 w-7 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="font-medium">No purchase orders yet</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Build your first PO from a supplier's catalog.
                    </p>
                  </div>
                  <Button size="sm" className="gap-1.5" onClick={() => { setPoSupplier(null); setPoOpen(true); }}>
                    <Plus className="w-4 h-4" /> Build a PO
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>PO #</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead className="text-right">Subtotal</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(pos ?? []).map((po) => {
                      const due = dueCountdown(po.dueDate);
                      // Pay-now POs: the payment link is generated at approval and
                      // delivered to the buyer over WhatsApp (no stored URL).
                      const awaitingPayment = po.paymentMode === "paynow" && po.status === "approved";
                      const canRepay = po.paymentMode === "credit" && po.status === "invoiced" &&
                        (!!po.creditAccountId || accountBySupplier.has(po.supplierTenantId));
                      const canCancel = po.status === "draft"; // only drafts are buyer-cancellable
                      return (
                        <TableRow key={po.id}>
                          <TableCell className="font-mono text-xs">{po.poNumber}</TableCell>
                          <TableCell className="font-medium">{po.supplierName ?? tenantNames.get(po.supplierTenantId) ?? po.supplierTenantId}</TableCell>
                          <TableCell className="text-right">{formatNaira(po.subtotal)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <PoStatusBadge status={po.status} />
                              {po.paymentMode === "credit" && (
                                <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">credit</Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="text-xs">
                              <span className="text-muted-foreground">{formatDate(po.dueDate)}</span>
                              {po.dueDate && (
                                <span className={`block ${DUE_TONE[due.tone]}`}>{due.label}</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1.5">
                              {awaitingPayment && (
                                <span className="text-xs text-muted-foreground italic self-center">Payment link sent via WhatsApp</span>
                              )}
                              {canRepay && (
                                <Button size="sm" variant="outline" className="gap-1 h-8" onClick={() => setRepayTarget(po)}>
                                  <HandCoins className="w-3.5 h-3.5" /> Repay
                                </Button>
                              )}
                              {canCancel && (
                                <Button size="sm" variant="ghost" className="h-8 text-destructive" onClick={() => setCancelTarget(po)}>
                                  Cancel
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </Card>
            )}
          </TabsContent>

          {/* ── Build PO ───────────────────────────────────────────────── */}
          <TabsContent value="build" className="space-y-4 mt-4">
            {suppliersLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground py-16 justify-center">
                <Loader2 className="w-5 h-5 animate-spin" /> Loading suppliers…
              </div>
            ) : (suppliers ?? []).length === 0 ? (
              <Card>
                <CardContent className="py-14 text-center text-sm text-muted-foreground">
                  No suppliers in the directory yet.
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {(suppliers ?? []).map((s) => (
                  <SupplierCard
                    key={s.supplierTenantId}
                    supplier={s}
                    requestingCredit={requestCredit.isPending}
                    onRequestCredit={(sup) => requestCredit.mutate({ tenantId, supplierTenantId: sup.supplierTenantId })}
                    onStartPo={(sup) => { setPoSupplier(sup); setPoOpen(true); }}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <PoBuilderDrawer tenantId={tenantId} supplier={poSupplier} open={poOpen} onOpenChange={setPoOpen} />

      {/* Cancel confirmation */}
      <AlertDialog open={!!cancelTarget} onOpenChange={(o) => !o && setCancelTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {cancelTarget?.poNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              The supplier will no longer see this purchase order. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep PO</AlertDialogCancel>
            <AlertDialogAction
              disabled={cancelPo.isPending}
              onClick={() => cancelTarget && cancelPo.mutate({ tenantId, poId: cancelTarget.id })}
            >
              {cancelPo.isPending ? "Cancelling…" : "Cancel PO"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Repay a credit-invoiced PO */}
      {repayTarget && repayAccount && (
        <RepaymentDialog
          tenantId={tenantId}
          accountId={repayAccount.id}
          counterpartyName={repayTarget.supplierName ?? tenantNames.get(repayTarget.supplierTenantId) ?? repayTarget.supplierTenantId}
          outstanding={repayAccount.outstanding}
          poId={repayTarget.id}
          open={!!repayTarget}
          onOpenChange={(o) => !o && setRepayTarget(null)}
        />
      )}
    </DashboardLayout>
  );
}
