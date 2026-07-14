import { useState } from "react";
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
import EscrowTimeline from "@/components/EscrowTimeline";
import { GitBranch } from "lucide-react";

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

export default function EscrowDashboard() {
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [configEditing, setConfigEditing] = useState(false);
  const [timelineEscrowId, setTimelineEscrowId] = useState<string | null>(null);

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
    });
  }

  const STATES = [
    "all", "payment_received", "escrow_held", "delivery_confirmed",
    "release_instructed", "settled", "dispute_raised", "dispute_resolved", "refunded",
  ];

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
          </TabsList>

          {/* Transactions Tab */}
          <TabsContent value="transactions" className="space-y-4">
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
            {txLoading ? (
              <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
            ) : (
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium">Escrow ID</th>
                      <th className="text-left px-4 py-3 font-medium">Order</th>
                      <th className="text-left px-4 py-3 font-medium">Amount</th>
                      <th className="text-left px-4 py-3 font-medium">Net Merchant</th>
                      <th className="text-left px-4 py-3 font-medium">State</th>
                      <th className="text-left px-4 py-3 font-medium">Mode</th>
                      <th className="text-left px-4 py-3 font-medium">Created</th>
                      <th className="text-left px-4 py-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(txList?.items ?? []).length === 0 ? (
                      <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">No escrow transactions found</td></tr>
                    ) : (txList?.items ?? []).map((tx) => (
                      <tr key={tx.id} className="border-t hover:bg-muted/30 transition-colors">
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
        </Tabs>
      </div>
    </DashboardLayout>
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
    </>
  );
}
