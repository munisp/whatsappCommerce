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
// === W66 learning ===
import { trpc } from "@/lib/trpc";
// === END W66 learning ===
import { useB2bUtils, useCancelPo, useCreditAccounts, usePos, useRequestCreditAccount, useSuppliers, useTenantNames } from "@/lib/b2b";
import {
  dueCountdown, formatDate, formatNaira, paidViaCreditLabel, type PoStatus, type PurchaseOrder, type SupplierSummary,
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
            {/* === W66 learning === R6 restock intelligence + hermes copilot */}
            <TabsTrigger value="restock">Restock AI</TabsTrigger>
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
                              {po.paymentMode === "credit" && po.status === "invoiced" ? (
                                // Credit draw settled straight to the supplier — no payment link.
                                <Badge variant="outline" className="text-[10px] font-normal border-sky-500/40 text-sky-400">
                                  {paidViaCreditLabel(po.dueDate)}
                                </Badge>
                              ) : po.paymentMode === "credit" ? (
                                <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">credit</Badge>
                              ) : null}
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

          {/* === W66 learning === R6: restock signals, auto-drafted POs with
              one-tap confirm, and the hermes procurement copilot (free text →
              structured PO draft via the W65 command bar; confirm executes). */}
          <TabsContent value="restock" className="space-y-4 mt-4">
            <RestockIntelPanel tenantId={tenantId} />
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

// === W66 learning === R6 restock intelligence panel: depletion signals,
// auto-drafted restock POs (merchant confirms — drafts never auto-submit),
// and the hermes procurement copilot (NL text → structured PO draft via the
// W65 command bar's restock_po intent; confirm executes the real mutation).
function RestockIntelPanel({ tenantId }: { tenantId: string }) {
  const utils = trpc.useUtils();
  const { data: signals } = trpc.learning.restockSignals.useQuery({ tenantId });
  const { data: drafts, refetch: refetchDrafts } = trpc.learning.restockDrafts.useQuery({ tenantId });
  const confirm = trpc.learning.confirmRestockDraft.useMutation({
    onSuccess: (r) => {
      toast.success(`PO ${r.poNumber} submitted to supplier`);
      refetchDrafts();
      utils.procurement.listPos.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // Hermes copilot: draft PO text → structured PO via the command bar.
  const [copilotText, setCopilotText] = useState("");
  const [copilotDraft, setCopilotDraft] = useState<{ summary: string; missingFields: string[]; confirmToken: string | null } | null>(null);
  const parse = trpc.commandBar.parse.useMutation({
    onSuccess: (d: any) => setCopilotDraft({ summary: d.summary, missingFields: d.missingFields ?? [], confirmToken: d.confirmToken }),
    onError: (e) => toast.error(`Copilot parse failed: ${e.message}`),
  });
  const execute = trpc.commandBar.execute.useMutation({
    onSuccess: (r: any) => {
      toast.success(`Done: ${r.summary}`);
      setCopilotDraft(null);
      setCopilotText("");
      refetchDrafts();
      utils.procurement.listPos.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="font-semibold text-foreground">Low-cover products</h3>
          {(signals ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No products below the days-of-cover threshold right now.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Stock</TableHead>
                  <TableHead>Sold (30d)</TableHead>
                  <TableHead>Days of cover</TableHead>
                  <TableHead>Suggested qty</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(signals ?? []).map((s) => (
                  <TableRow key={s.productId}>
                    <TableCell className="font-medium">{s.productName}</TableCell>
                    <TableCell>{s.stockQuantity}</TableCell>
                    <TableCell>{s.soldQtyWindow}</TableCell>
                    <TableCell><Badge variant="outline">{s.daysOfCover}d</Badge></TableCell>
                    <TableCell>{s.suggestedQty}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="font-semibold text-foreground">Auto-drafted restock POs</h3>
          {(drafts ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No restock drafts pending confirmation.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PO</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Subtotal</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(drafts ?? []).map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.poNumber}</TableCell>
                    <TableCell className="text-muted-foreground">{d.supplierTenantId.slice(0, 8)}…</TableCell>
                    <TableCell>{formatNaira(d.subtotalCents / 100)}</TableCell>
                    <TableCell className="text-muted-foreground max-w-[280px] truncate">{d.notes}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        disabled={confirm.isPending}
                        onClick={() => confirm.mutate({ tenantId, poId: d.id })}
                      >
                        {confirm.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Confirm & submit"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="font-semibold text-foreground">Procurement copilot</h3>
          <p className="text-xs text-muted-foreground">
            Describe the PO in plain language, e.g. “restock 120 bags of rice from supplier &lt;id&gt;”. The copilot drafts a structured PO — nothing is sent until you confirm.
          </p>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={copilotText}
              onChange={(e) => setCopilotText(e.target.value)}
              placeholder="restock 120 × Basmati rice from supplier …"
            />
            <Button
              variant="outline"
              disabled={parse.isPending || copilotText.trim().length < 4}
              onClick={() => parse.mutate({ text: `restock ${copilotText}` })}
            >
              {parse.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Draft"}
            </Button>
          </div>
          {copilotDraft && (
            <div className="rounded-md border border-border p-3 space-y-2">
              <p className="text-sm">{copilotDraft.summary}</p>
              {copilotDraft.missingFields.length > 0 && (
                <p className="text-xs text-amber-400">Missing: {copilotDraft.missingFields.join(", ")} — include them in the text and re-draft.</p>
              )}
              <Button
                size="sm"
                disabled={execute.isPending || !copilotDraft.confirmToken || copilotDraft.missingFields.length > 0}
                onClick={() => copilotDraft.confirmToken && execute.mutate({ confirmToken: copilotDraft.confirmToken })}
              >
                {execute.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Confirm draft PO"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
// === END W66 learning ===
