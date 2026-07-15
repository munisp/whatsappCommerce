import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import DashboardLayout from "@/components/DashboardLayout";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import EscrowTimeline from "@/components/EscrowTimeline";
import { SlaCountdown } from "@/components/SlaCountdown";
import { GitBranch, Clock4, History, CheckCircle2, XCircle, CheckSquare, X } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";

const STATE_COLORS: Record<string, string> = {
  payment_received: "bg-blue-100 text-blue-800",
  escrow_held: "bg-yellow-100 text-yellow-800",
  delivery_confirmed: "bg-purple-100 text-purple-800",
  release_instructed: "bg-orange-100 text-orange-800",
  settled: "bg-green-100 text-green-800",
  dispute_raised: "bg-red-100 text-red-800",
  dispute_resolved: "bg-teal-100 text-teal-800",
  refunded: "bg-gray-100 text-gray-700",
  expired: "bg-gray-100 text-gray-500",
};

function formatNGN(val: string | number | null | undefined) {
  const n = typeof val === "string" ? parseFloat(val) : (val ?? 0);
  return `₦${n.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function StatCard({ title, value, sub, color }: { title: string; value: string; sub?: string; color?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{title}</p>
        <p className={`text-2xl font-bold mt-1 ${color ?? ""}`}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

const EXT_STATUS_STYLES: Record<string, { label: string; className: string; icon: React.ReactNode }> = {
  pending: { label: "Pending", className: "bg-yellow-100 text-yellow-800", icon: <Clock4 className="h-3 w-3" /> },
  approved: { label: "Approved", className: "bg-green-100 text-green-800", icon: <CheckCircle2 className="h-3 w-3" /> },
  rejected: { label: "Rejected", className: "bg-red-100 text-red-800", icon: <XCircle className="h-3 w-3" /> },
  expired: { label: "Expired", className: "bg-gray-100 text-gray-500", icon: <XCircle className="h-3 w-3" /> },
};

function SlaExtensionHistoryPanel({ escrowId }: { escrowId: string }) {
  const { data, isLoading } = trpc.slaExtension.listByEscrow.useQuery({ escrowId });
  if (isLoading) return <div className="space-y-2 py-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14" />)}</div>;
  if (!data?.length) return <p className="text-sm text-muted-foreground py-4 text-center">No extension requests for this transaction.</p>;
  return (
    <div className="space-y-3 pt-2">
      {data.map((ext: any) => {
        const s = EXT_STATUS_STYLES[ext.status] ?? EXT_STATUS_STYLES.pending;
        return (
          <div key={ext.id} className="border rounded-lg p-3 space-y-1">
            <div className="flex items-center justify-between">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${s.className}`}>{s.icon}{s.label}</span>
              <span className="text-xs text-muted-foreground">{new Date(ext.createdAt).toLocaleString()}</span>
            </div>
            <p className="text-sm font-medium">+{ext.extensionHours}h extension requested</p>
            {ext.reason && <p className="text-xs text-muted-foreground">Reason: {ext.reason}</p>}
            {ext.buyerResponse && <p className="text-xs text-muted-foreground italic">Buyer: "{ext.buyerResponse}"</p>}
            {ext.respondedAt && <p className="text-xs text-muted-foreground">Responded: {new Date(ext.respondedAt).toLocaleString()}</p>}
          </div>
        );
      })}
    </div>
  );
}

function SlaExtensionAllList() {
  const { data: txList } = trpc.escrow.listAll.useQuery({ limit: 200 });
  const escrowIds = (txList?.items ?? []).map((t: any) => t.id).slice(0, 20);
  // Show a placeholder — real usage is via the History button per row
  if (!escrowIds.length) return <p className="text-sm text-muted-foreground py-6 text-center">No escrow transactions yet.</p>;
  return (
    <div className="px-4 py-3 text-sm text-muted-foreground">
      Click the <span className="font-medium text-purple-600">History</span> button on any transaction row to view its SLA extension audit trail.
    </div>
  );
}

export default function EscrowDashboard() {
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [configEditing, setConfigEditing] = useState(false);
  const [timelineEscrowId, setTimelineEscrowId] = useState<string | null>(null);
  const [slaExtensionTx, setSlaExtensionTx] = useState<{ id: string; orderId: string | null } | null>(null);
  const [extensionHours, setExtensionHours] = useState("24");
  const [extensionReason, setExtensionReason] = useState("");
  const [historyEscrowId, setHistoryEscrowId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<"release" | "refund" | null>(null);

  const { data: stats, isLoading: statsLoading } = trpc.escrow.getStats.useQuery();
  const { data: config, isLoading: configLoading, refetch: refetchConfig } = trpc.escrow.getConfig.useQuery();
  const { data: txList, isLoading: txLoading } = trpc.escrow.listAll.useQuery({
    state: stateFilter === "all" ? undefined : stateFilter,
    limit: 50,
  });

  const utils = trpc.useUtils();
  const setConfig = trpc.escrow.setConfig.useMutation({
    onSuccess: () => {
      toast.success("Escrow configuration saved");
      setConfigEditing(false);
      refetchConfig();
    },
    onError: (e) => toast.error(e.message),
  });

  const buyerConfirm = trpc.escrow.buyerConfirm.useMutation({
    onSuccess: () => { toast.success("Escrow released to merchant"); utils.escrow.listAll.invalidate(); utils.escrow.getStats.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const initiateRefund = trpc.escrow.initiateRefund.useMutation({
    onSuccess: () => { toast.success("Refund initiated"); utils.escrow.listAll.invalidate(); utils.escrow.getStats.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const requestExtension = trpc.slaExtension.requestExtension.useMutation({
    onSuccess: () => {
      toast.success("SLA extension request sent to buyer");
      setSlaExtensionTx(null);
      setExtensionHours("24");
      setExtensionReason("");
      utils.escrow.listAll.invalidate();
    },
    onError: (e: { message: string }) => toast.error(e.message),
  });

  const bulkUpdate = trpc.escrow.bulkUpdateState.useMutation({
    onSuccess: (res) => {
      toast.success(`Bulk ${bulkAction}: ${res.succeeded} succeeded, ${res.failed} failed`);
      setSelectedIds(new Set());
      setBulkAction(null);
      utils.escrow.listAll.invalidate();
      utils.escrow.getStats.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const [cfgForm, setCfgForm] = useState<Record<string, string | boolean>>({});

  function startEditConfig() {
    if (!config) return;
    setCfgForm({
      custodyMode: config.custodyMode,
      bankPartnerName: config.bankPartnerName ?? "",
      bankPartnerCode: config.bankPartnerCode ?? "",
      bankEscrowAccountNumber: config.bankEscrowAccountNumber ?? "",
      platformFeeRate: config.platformFeeRate,
      buyerConfirmWindowHours: String(config.buyerConfirmWindowHours),
      disputeWindowHours: String(config.disputeWindowHours),
      autoConfirmEnabled: config.autoConfirmEnabled,
      floatYieldRate: config.floatYieldRate,
      minScanConfidence: String(Math.round(parseFloat(String((config as any).minScanConfidence ?? "0.6")) * 100)),
    });
    setConfigEditing(true);
  }

  function saveConfig() {
    setConfig.mutate({
      custodyMode: cfgForm.custodyMode as "pssp" | "psp",
      bankPartnerName: cfgForm.bankPartnerName as string,
      bankPartnerCode: cfgForm.bankPartnerCode as string,
      bankEscrowAccountNumber: cfgForm.bankEscrowAccountNumber as string,
      platformFeeRate: cfgForm.platformFeeRate as string,
      buyerConfirmWindowHours: parseInt(cfgForm.buyerConfirmWindowHours as string),
      disputeWindowHours: parseInt(cfgForm.disputeWindowHours as string),
      autoConfirmEnabled: cfgForm.autoConfirmEnabled as boolean,
      floatYieldRate: cfgForm.floatYieldRate as string,
      minScanConfidence: String(parseInt(cfgForm.minScanConfidence as string) / 100),
    });
  }

  const STATES = [
    "all", "payment_received", "escrow_held", "delivery_confirmed",
    "release_instructed", "settled", "dispute_raised", "dispute_resolved", "refunded",
  ];

  // Quick-filter chips: each chip sets the stateFilter AND selects all matching rows
  const QUICK_FILTERS = [
    { label: "All", state: "all", color: "bg-slate-100 text-slate-700 hover:bg-slate-200 border-slate-300" },
    { label: "Held", state: "escrow_held", color: "bg-yellow-100 text-yellow-800 hover:bg-yellow-200 border-yellow-300" },
    { label: "Disputed", state: "dispute_raised", color: "bg-red-100 text-red-700 hover:bg-red-200 border-red-300" },
    { label: "Pending Release", state: "release_instructed", color: "bg-orange-100 text-orange-700 hover:bg-orange-200 border-orange-300" },
    { label: "Settled", state: "settled", color: "bg-green-100 text-green-700 hover:bg-green-200 border-green-300" },
    { label: "Refunded", state: "refunded", color: "bg-gray-100 text-gray-600 hover:bg-gray-200 border-gray-300" },
  ] as const;

  function applyQuickFilter(state: string) {
    setStateFilter(state);
    if (state === "all") {
      setSelectedIds(new Set());
    } else {
      const matching = allItems
        .filter(tx => tx.state === state && !["settled", "refunded", "expired"].includes(tx.state))
        .map(tx => tx.id);
      setSelectedIds(new Set(matching));
    }
  }

  const allItems = txList?.items ?? [];
  const selectableIds = useMemo(
    () => allItems.filter(tx => !["settled", "refunded", "expired"].includes(tx.state)).map(tx => tx.id),
    [allItems],
  );
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIds.has(id));
  const someSelected = selectedIds.size > 0;

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableIds));
    }
  }

  function toggleRow(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <>
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Escrow Dashboard</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Custody mode:{" "}
              <Badge variant={config?.custodyMode === "psp" ? "default" : "secondary"} className="ml-1">
                {config?.custodyMode?.toUpperCase() ?? "—"}
              </Badge>
              {config?.custodyMode === "pssp" && (
                <span className="ml-2 text-xs text-muted-foreground">Bank-partner custody (PSSP licence)</span>
              )}
              {config?.custodyMode === "psp" && (
                <span className="ml-2 text-xs text-green-600 font-medium">Native wallet custody (PSP licence)</span>
              )}
            </p>
          </div>
        </div>

        {/* KPI Cards */}
        {statsLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24" />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard title="Total Held in Escrow" value={formatNGN(stats?.totalHeld)} sub="Active escrow balance" color="text-yellow-600" />
            <StatCard title="Total Settled" value={formatNGN(stats?.totalSettled)} sub="All-time settlements" color="text-green-600" />
            <StatCard title="Platform Fees Earned" value={formatNGN(stats?.totalFees)} sub={`Rate: ${(parseFloat(stats?.platformFeeRate ?? "0") * 100).toFixed(2)}%`} />
            <StatCard title="Open Disputes" value={String(stats?.openDisputes ?? 0)} sub="Requires review" color={stats?.openDisputes ? "text-red-600" : ""} />
          </div>
        )}

        <Tabs defaultValue="transactions">
          <TabsList>
            <TabsTrigger value="transactions">Transactions</TabsTrigger>
            <TabsTrigger value="state-breakdown">State Breakdown</TabsTrigger>
            <TabsTrigger value="config">Configuration</TabsTrigger>
            <TabsTrigger value="sla-history">SLA Extensions</TabsTrigger>
          </TabsList>

          {/* Transactions Tab */}
          <TabsContent value="transactions" className="space-y-4">
            {/* Quick-filter chips */}
            <div className="flex flex-wrap gap-1.5">
              {QUICK_FILTERS.map(({ label, state, color }) => {
                const matchCount = state === "all"
                  ? allItems.length
                  : allItems.filter(tx => tx.state === state).length;
                const isActive = stateFilter === state;
                return (
                  <button
                    key={state}
                    type="button"
                    onClick={() => applyQuickFilter(state)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-all ${color} ${
                      isActive ? "ring-2 ring-offset-1 ring-primary font-semibold shadow-sm" : ""
                    }`}
                  >
                    {label}
                    <span className="inline-flex items-center justify-center rounded-full bg-black/10 px-1.5 min-w-[1.25rem] h-4 text-[10px] font-bold">
                      {matchCount}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-3">
              <Label className="text-sm">Filter by state:</Label>
              <Select value={stateFilter} onValueChange={setStateFilter}>
                <SelectTrigger className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATES.map((s) => (
                    <SelectItem key={s} value={s}>{s === "all" ? "All States" : s.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-sm text-muted-foreground">{txList?.total ?? 0} records</span>
            </div>
            {someSelected && (
              <div className="flex items-center gap-3 px-4 py-2.5 bg-primary/5 border border-primary/20 rounded-lg">
                <CheckSquare className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">{selectedIds.size} selected</span>
                <div className="flex-1" />
                <Button size="sm" variant="outline" className="text-green-700 border-green-300 hover:bg-green-50"
                  onClick={() => setBulkAction("release")} disabled={bulkUpdate.isPending}>
                  Bulk Release
                </Button>
                <Button size="sm" variant="outline" className="text-red-600 border-red-300 hover:bg-red-50"
                  onClick={() => setBulkAction("refund")} disabled={bulkUpdate.isPending}>
                  Bulk Refund
                </Button>
                <Button size="sm" variant="ghost" className="text-muted-foreground"
                  onClick={() => setSelectedIds(new Set())}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}
            {txLoading ? (
              <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
            ) : (
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-4 py-3 w-10">
                        <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} aria-label="Select all" />
                      </th>
                      <th className="text-left px-4 py-3 font-medium">Escrow ID</th>
                      <th className="text-left px-4 py-3 font-medium">Order</th>
                      <th className="text-left px-4 py-3 font-medium">Amount</th>
                      <th className="text-left px-4 py-3 font-medium">Net Merchant</th>
                      <th className="text-left px-4 py-3 font-medium">State</th>
                      <th className="text-left px-4 py-3 font-medium">Mode</th>
                      <th className="text-left px-4 py-3 font-medium">Created</th>
                      <th className="text-left px-4 py-3 font-medium">SLA Deadline</th>
                      <th className="text-left px-4 py-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(txList?.items ?? []).length === 0 ? (
                      <tr><td colSpan={10} className="text-center py-8 text-muted-foreground">No escrow transactions found</td></tr>
                    ) : (txList?.items ?? []).map((tx) => (
                      <tr key={tx.id} className={`border-t hover:bg-muted/30 transition-colors ${selectedIds.has(tx.id) ? "bg-primary/5" : ""}`}>
                        <td className="px-4 py-3">
                          {!["settled", "refunded", "expired"].includes(tx.state) && (
                            <Checkbox checked={selectedIds.has(tx.id)} onCheckedChange={() => toggleRow(tx.id)} aria-label={`Select ${tx.id}`} />
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">{tx.id.slice(0, 8)}…</td>
                        <td className="px-4 py-3 font-mono text-xs">{tx.orderId.slice(0, 8)}…</td>
                        <td className="px-4 py-3 font-medium">{formatNGN(tx.amount)}</td>
                        <td className="px-4 py-3 text-green-700">{formatNGN(tx.netMerchantAmount)}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATE_COLORS[tx.state] ?? "bg-gray-100"}`}>
                            {tx.state.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={tx.custodyMode === "psp" ? "default" : "outline"} className="text-xs">
                            {tx.custodyMode.toUpperCase()}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">
                          {new Date(tx.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3">
                          <SlaCountdown
                            slaDeadline={(tx as any).buyerConfirmDeadline}
                            warningHours={24}
                            variant="compact"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1">
                            {["delivery_confirmed", "escrow_held"].includes(tx.state) && (
                              <Button size="sm" variant="outline" className="text-xs h-7"
                                onClick={() => buyerConfirm.mutate({ escrowId: tx.id, autoConfirmed: true })}>
                                Release
                              </Button>
                            )}
                            {!["settled", "refunded", "expired"].includes(tx.state) && (
                              <Button size="sm" variant="outline" className="text-xs h-7 text-red-600 border-red-200 hover:bg-red-50"
                                onClick={() => initiateRefund.mutate({ escrowId: tx.id, reason: "Admin manual refund" })}>
                                Refund
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" className="text-xs h-7 text-muted-foreground"
                             onClick={() => setTimelineEscrowId(tx.id)}>
                             <GitBranch className="h-3 w-3 mr-1" />
                             Timeline
                           </Button>
                            <Button size="sm" variant="ghost" className="text-xs h-7 text-purple-600 hover:bg-purple-50"
                              onClick={() => setHistoryEscrowId(tx.id)}>
                              <History className="h-3 w-3 mr-1" />
                              History
                            </Button>
                            {["escrow_held", "delivery_confirmed"].includes(tx.state) && (tx as any).buyerConfirmDeadline && (
                              <Button size="sm" variant="ghost" className="text-xs h-7 text-amber-600 hover:bg-amber-50"
                                onClick={() => setSlaExtensionTx({ id: tx.id, orderId: (tx as any).orderId })}>
                                <Clock4 className="h-3 w-3 mr-1" />
                                Extend SLA
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>

          {/* State Breakdown Tab */}
          <TabsContent value="state-breakdown">
            {statsLoading ? <Skeleton className="h-64" /> : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {Object.entries(stats?.byState ?? {}).map(([state, data]: [string, any]) => (
                  <Card key={state}>
                    <CardContent className="pt-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATE_COLORS[state] ?? "bg-gray-100"}`}>
                          {state.replace(/_/g, " ")}
                        </span>
                        <span className="text-lg font-bold">{data.count}</span>
                      </div>
                      <p className="text-sm font-medium">{formatNGN(data.amount)}</p>
                      <p className="text-xs text-muted-foreground">Fees: {formatNGN(data.fees)}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Config Tab */}
          <TabsContent value="config" className="space-y-4">
            {configLoading ? <Skeleton className="h-64" /> : (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Platform Escrow Configuration</CardTitle>
                    {!configEditing ? (
                      <Button size="sm" onClick={startEditConfig}>Edit</Button>
                    ) : (
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => setConfigEditing(false)}>Cancel</Button>
                        <Button size="sm" onClick={saveConfig} disabled={setConfig.isPending}>Save</Button>
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Custody Mode */}
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Custody Mode</Label>
                    {configEditing ? (
                      <Select value={cfgForm.custodyMode as string} onValueChange={(v) => setCfgForm(p => ({ ...p, custodyMode: v }))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pssp">PSSP — Bank-partner custody</SelectItem>
                          <SelectItem value="psp">PSP — Native wallet custody</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <p className="font-medium">{config?.custodyMode?.toUpperCase()}</p>
                    )}
                  </div>
                  {/* Platform Fee Rate */}
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Platform Fee Rate</Label>
                    {configEditing ? (
                      <Input value={cfgForm.platformFeeRate as string} onChange={(e) => setCfgForm(p => ({ ...p, platformFeeRate: e.target.value }))} />
                    ) : (
                      <p className="font-medium">{(parseFloat(config?.platformFeeRate ?? "0") * 100).toFixed(3)}%</p>
                    )}
                  </div>
                  {/* Buyer Confirm Window */}
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Buyer Confirm Window (hours)</Label>
                    {configEditing ? (
                      <Input type="number" value={cfgForm.buyerConfirmWindowHours as string} onChange={(e) => setCfgForm(p => ({ ...p, buyerConfirmWindowHours: e.target.value }))} />
                    ) : (
                      <p className="font-medium">{config?.buyerConfirmWindowHours}h</p>
                    )}
                  </div>
                  {/* Dispute Window */}
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Dispute Window (hours)</Label>
                    {configEditing ? (
                      <Input type="number" value={cfgForm.disputeWindowHours as string} onChange={(e) => setCfgForm(p => ({ ...p, disputeWindowHours: e.target.value }))} />
                    ) : (
                      <p className="font-medium">{config?.disputeWindowHours}h</p>
                    )}
                  </div>
                  {/* Auto Confirm */}
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Auto-Confirm After Window</Label>
                    {configEditing ? (
                      <Switch checked={cfgForm.autoConfirmEnabled as boolean} onCheckedChange={(v) => setCfgForm(p => ({ ...p, autoConfirmEnabled: v }))} />
                    ) : (
                      <p className="font-medium">{config?.autoConfirmEnabled ? "Enabled" : "Disabled"}</p>
                    )}
                  </div>
                  {/* Float Yield Rate (PSP only) */}
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Float Yield Rate (annual, PSP mode)</Label>
                    {configEditing ? (
                      <Input value={cfgForm.floatYieldRate as string} onChange={(e) => setCfgForm(p => ({ ...p, floatYieldRate: e.target.value }))} />
                    ) : (
                      <p className="font-medium">{(parseFloat(config?.floatYieldRate ?? "0") * 100).toFixed(1)}% p.a.</p>
                    )}
                  </div>
                  {/* AI Scan Confidence Threshold */}
                  <div className="space-y-1 md:col-span-2">
                    <Label className="text-xs text-muted-foreground">Min. AI Scan Confidence — Evidence Portal</Label>
                    {configEditing ? (
                      <div className="flex items-center gap-2">
                        <Input
                          type="number" min="0" max="100"
                          value={cfgForm.minScanConfidence as string}
                          onChange={(e) => setCfgForm(p => ({ ...p, minScanConfidence: e.target.value }))}
                          className="w-24"
                        />
                        <span className="text-sm text-muted-foreground">% — set to 0 to disable blocking</span>
                      </div>
                    ) : (
                      <p className="font-medium">
                        {(config as any)?.minScanConfidence && parseFloat(String((config as any).minScanConfidence)) > 0
                          ? `${Math.round(parseFloat(String((config as any).minScanConfidence)) * 100)}% minimum clarity required`
                          : "Disabled (all images accepted)"}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">Evidence images below this AI clarity score will be blocked from submission on the dispute evidence portal.</p>
                  </div>
                  {/* Bank Partner (PSSP mode) */}
                  {(configEditing ? cfgForm.custodyMode === "pssp" : config?.custodyMode === "pssp") && (
                    <>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Bank Partner Name</Label>
                        {configEditing ? (
                          <Input value={cfgForm.bankPartnerName as string} onChange={(e) => setCfgForm(p => ({ ...p, bankPartnerName: e.target.value }))} placeholder="e.g. Access Bank" />
                        ) : (
                          <p className="font-medium">{config?.bankPartnerName ?? "—"}</p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Bank Code</Label>
                        {configEditing ? (
                          <Input value={cfgForm.bankPartnerCode as string} onChange={(e) => setCfgForm(p => ({ ...p, bankPartnerCode: e.target.value }))} placeholder="e.g. 044" />
                        ) : (
                          <p className="font-medium">{config?.bankPartnerCode ?? "—"}</p>
                        )}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>
          {/* SLA Extension History Tab */}
          <TabsContent value="sla-history" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <History className="h-4 w-4" />
                  SLA Extension Audit Trail
                </CardTitle>
                <p className="text-xs text-muted-foreground pt-1">Click the <span className="font-medium text-purple-600">History</span> button on any transaction row to view per-escrow extension history in a dialog.</p>
              </CardHeader>
              <CardContent>
                <SlaExtensionAllList />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
    {/* SLA Extension History Dialog */}
    <Dialog open={!!historyEscrowId} onOpenChange={(open) => { if (!open) setHistoryEscrowId(null); }}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" />
            SLA Extension History
            {historyEscrowId && <span className="text-xs font-mono text-muted-foreground ml-1">{historyEscrowId.slice(0, 8)}…</span>}
          </DialogTitle>
        </DialogHeader>
        {historyEscrowId && <SlaExtensionHistoryPanel escrowId={historyEscrowId} />}
      </DialogContent>
    </Dialog>
    {/* Escrow Timeline Dialog */}
    <Dialog open={!!timelineEscrowId} onOpenChange={(open) => { if (!open) setTimelineEscrowId(null); }}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Escrow Timeline
            {timelineEscrowId && (
              <span className="text-xs font-mono text-muted-foreground ml-1">{timelineEscrowId.slice(0, 8)}…</span>
            )}
          </DialogTitle>
        </DialogHeader>
        {timelineEscrowId && (
          <EscrowTimeline escrowId={timelineEscrowId} className="mt-2" />
        )}
      </DialogContent>
    </Dialog>
    {/* SLA Extension Dialog */}
    <Dialog open={!!slaExtensionTx} onOpenChange={(open) => { if (!open) setSlaExtensionTx(null); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock4 className="h-4 w-4 text-amber-500" />
            Request SLA Extension
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <p className="text-sm text-muted-foreground">
            Ask the buyer for additional delivery time. They will receive a notification to approve or reject this request.
            {slaExtensionTx?.orderId && <span className="block mt-1 font-medium text-foreground">Order: {slaExtensionTx.orderId}</span>}
          </p>
          {/* Email preview */}
          {extensionReason.trim() && (
            <div className="rounded-lg border bg-muted/30 p-3 space-y-1 text-xs">
              <p className="font-semibold text-muted-foreground uppercase tracking-wide text-[10px]">Email Preview</p>
              <p className="font-medium">Subject: SLA Extension Request — {slaExtensionTx?.orderId ?? "Order"}</p>
              <p className="text-muted-foreground leading-relaxed">
                Hi, the seller has requested an extension of <strong>{extensionHours}h</strong> for your order.
                Reason: <em>{extensionReason}</em>. Please approve or reject in your portal.
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label>Extension Duration</Label>
            <Select value={extensionHours} onValueChange={setExtensionHours}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="12">12 hours</SelectItem>
                <SelectItem value="24">24 hours (1 day)</SelectItem>
                <SelectItem value="48">48 hours (2 days)</SelectItem>
                <SelectItem value="72">72 hours (3 days)</SelectItem>
                <SelectItem value="120">120 hours (5 days)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Reason for Extension</Label>
            <Textarea
              placeholder="e.g. Courier delay due to public holiday, awaiting customs clearance…"
              value={extensionReason}
              onChange={(e) => setExtensionReason(e.target.value)}
              rows={3}
              maxLength={500}
            />
            <p className="text-xs text-muted-foreground text-right">{extensionReason.length}/500</p>
          </div>
          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={() => setSlaExtensionTx(null)}>Cancel</Button>
            <Button
              className="flex-1 bg-amber-600 hover:bg-amber-500 text-white"
              disabled={requestExtension.isPending}
              onClick={() => slaExtensionTx && requestExtension.mutate({
                escrowId: slaExtensionTx.id,
                extensionHours: parseInt(extensionHours),
                reason: extensionReason || undefined,
              })}
            >
              {requestExtension.isPending ? "Sending…" : "Send Request"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    {/* Bulk Action Confirmation Dialog */}
    <AlertDialog open={!!bulkAction} onOpenChange={(open) => { if (!open) setBulkAction(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {bulkAction === "release" ? "Bulk Release Funds" : "Bulk Refund Orders"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {bulkAction === "release"
              ? `You are about to release funds for ${selectedIds.size} escrow transaction(s). Merchant net amounts will be settled and orders marked as delivered.`
              : `You are about to refund ${selectedIds.size} escrow transaction(s). Full amounts will be returned and orders marked as refunded.`
            }
            {" "}This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setBulkAction(null)}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={bulkAction === "refund" ? "bg-red-600 hover:bg-red-700" : "bg-green-700 hover:bg-green-600"}
            onClick={() => {
              if (!bulkAction) return;
              bulkUpdate.mutate({ escrowIds: Array.from(selectedIds), action: bulkAction });
            }}
            disabled={bulkUpdate.isPending}
          >
            {bulkUpdate.isPending ? "Processing…" : bulkAction === "release" ? `Release ${selectedIds.size}` : `Refund ${selectedIds.size}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
