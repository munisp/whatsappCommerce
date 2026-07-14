import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import {
  RefreshCw, Package, AlertTriangle, CheckCircle2, XCircle,
  Database, Clock, TrendingDown, ShieldCheck
} from "lucide-react";

const DEMO_TENANT = "tenant-001";

function StockStatusBadge({ status }: { status: string }) {
  if (status === "out_of_stock") return <Badge variant="destructive" className="gap-1"><XCircle className="w-3 h-3" />Out of Stock</Badge>;
  if (status === "low_stock") return <Badge className="gap-1 bg-amber-500/20 text-amber-400 border-amber-500/30"><AlertTriangle className="w-3 h-3" />Low Stock</Badge>;
  return <Badge className="gap-1 bg-emerald-500/20 text-emerald-400 border-emerald-500/30"><CheckCircle2 className="w-3 h-3" />In Stock</Badge>;
}

function SyncStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    success: { label: "Success", cls: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
    failed: { label: "Failed", cls: "bg-red-500/20 text-red-400 border-red-500/30" },
    syncing: { label: "Syncing", cls: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
    idle: { label: "Idle", cls: "bg-slate-500/20 text-slate-400 border-slate-500/30" },
  };
  const s = map[status] ?? map.idle;
  return <Badge className={`gap-1 ${s.cls}`}>{s.label}</Badge>;
}

export default function InventorySync() {
  const [tenantId] = useState(DEMO_TENANT);

  const { data: stockLevels = [], isLoading: loadingStock, refetch: refetchStock } =
    trpc.inventory.getStockLevels.useQuery({ tenantId });
  const { data: alerts, isLoading: loadingAlerts, refetch: refetchAlerts } =
    trpc.inventory.getStockAlerts.useQuery({ tenantId });
  const { data: syncHistory = [], refetch: refetchHistory } =
    trpc.inventory.getSyncHistory.useQuery({ tenantId, limit: 10 });

  const syncMutation = trpc.inventory.syncFromOdoo.useMutation({
    onSuccess: (data) => {
      toast.success(`Sync complete — ${data.recordsSynced} products updated`);
      refetchStock();
      refetchAlerts();
      refetchHistory();
    },
    onError: (err) => toast.error(`Sync failed: ${err.message}`),
  });

  const handleSync = () => syncMutation.mutate({ tenantId });

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Inventory Sync</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Real-time stock levels synced from Odoo ERP — oversell prevention via atomic reservations
          </p>
        </div>
        <Button onClick={handleSync} disabled={syncMutation.isPending} className="gap-2">
          {syncMutation.isPending ? <Spinner className="w-4 h-4" /> : <RefreshCw className="w-4 h-4" />}
          Sync from Odoo
        </Button>
      </div>

      {/* Alert KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="border-red-500/20 bg-red-500/5">
          <CardContent className="p-4 flex items-center gap-3">
            <XCircle className="w-8 h-8 text-red-400 shrink-0" />
            <div>
              <div className="text-2xl font-bold text-red-400">{loadingAlerts ? "—" : alerts?.outOfStock ?? 0}</div>
              <div className="text-xs text-muted-foreground">Out of Stock</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-amber-500/20 bg-amber-500/5">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="w-8 h-8 text-amber-400 shrink-0" />
            <div>
              <div className="text-2xl font-bold text-amber-400">{loadingAlerts ? "—" : alerts?.lowStock ?? 0}</div>
              <div className="text-xs text-muted-foreground">Low Stock</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-emerald-500/20 bg-emerald-500/5">
          <CardContent className="p-4 flex items-center gap-3">
            <CheckCircle2 className="w-8 h-8 text-emerald-400 shrink-0" />
            <div>
              <div className="text-2xl font-bold text-emerald-400">{loadingAlerts ? "—" : alerts?.inStock ?? 0}</div>
              <div className="text-xs text-muted-foreground">In Stock</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-blue-500/20 bg-blue-500/5">
          <CardContent className="p-4 flex items-center gap-3">
            <ShieldCheck className="w-8 h-8 text-blue-400 shrink-0" />
            <div>
              <div className="text-xs font-semibold text-blue-400">Oversell Guard</div>
              <div className="text-xs text-muted-foreground">Atomic reservations</div>
              <div className="text-xs text-emerald-400 font-medium mt-0.5">Active</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* How It Works — Integration Explainer */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="w-4 h-4 text-primary" />
            How CRM & ERP Integrate with the Dashboard
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-3 gap-4 text-sm">
            <div className="space-y-2 p-3 rounded-lg bg-muted/30 border border-border/50">
              <div className="font-semibold text-primary flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-primary/20 text-primary text-xs flex items-center justify-center font-bold">1</span>
                Odoo ERP → Stock Sync
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                The Odoo integration pulls product stock quantities via XML-RPC every 5 minutes (heartbeat job). 
                Synced values are written to <code className="bg-muted px-1 rounded">inventory_snapshots</code> with a 
                separate <em>reserved</em> and <em>available</em> column. When a WhatsApp order is placed, 
                an atomic SQL UPDATE decrements <code className="bg-muted px-1 rounded">availableQty</code> — 
                if it would go negative, the transaction is rejected, preventing overselling.
              </p>
            </div>
            <div className="space-y-2 p-3 rounded-lg bg-muted/30 border border-border/50">
              <div className="font-semibold text-cyan-400 flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-cyan-500/20 text-cyan-400 text-xs flex items-center justify-center font-bold">2</span>
                Twenty CRM → Customer Data
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Twenty CRM contacts are synced into <code className="bg-muted px-1 rounded">twenty_contacts</code>. 
                The Dashboard's Customers KPI counts unique contacts. Deal pipeline stages from Twenty 
                populate the WhatsApp Menu Builder's CRM data source, so menu options reflect live deal stages. 
                WhatsApp messages sent from the CRM page are logged back to Twenty via the API.
              </p>
            </div>
            <div className="space-y-2 p-3 rounded-lg bg-muted/30 border border-border/50">
              <div className="font-semibold text-violet-400 flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-violet-500/20 text-violet-400 text-xs flex items-center justify-center font-bold">3</span>
                Dashboard KPI Aggregation
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                The Dashboard queries <code className="bg-muted px-1 rounded">analytics.platformOverview</code> which 
                joins across all tenant tables in a single round-trip. Revenue comes from <code className="bg-muted px-1 rounded">orders</code>, 
                conversation counts from <code className="bg-muted px-1 rounded">conversations</code>, and 
                AI interactions from <code className="bg-muted px-1 rounded">agent_events</code>. 
                Stock alerts are surfaced via the inventory snapshot query.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stock Levels Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="w-4 h-4 text-primary" />
            Stock Levels
            {alerts?.lastSyncedAt && (
              <span className="text-xs text-muted-foreground font-normal ml-auto flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Last synced {new Date(alerts.lastSyncedAt).toLocaleTimeString()}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loadingStock ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">Odoo Stock</TableHead>
                  <TableHead className="text-right">Reserved</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                  <TableHead className="text-right">Threshold</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stockLevels.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No products found</TableCell></TableRow>
                ) : stockLevels.map((row: any) => (
                  <TableRow key={row.productId}>
                    <TableCell className="font-medium">{row.productName}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{row.sku}</TableCell>
                    <TableCell className="text-right">{Number(row.stockQty)}</TableCell>
                    <TableCell className="text-right text-amber-400">{Number(row.reservedQty)}</TableCell>
                    <TableCell className="text-right font-semibold">{Number(row.availableQty)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{row.lowStockThreshold}</TableCell>
                    <TableCell><StockStatusBadge status={row.stockStatus} /></TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {row.lastSyncedAt ? "Odoo" : "Local"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Sync History */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingDown className="w-4 h-4 text-primary" />
            Sync History
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Records</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {syncHistory.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">No sync history yet</TableCell></TableRow>
              ) : syncHistory.map((log: any) => (
                <TableRow key={log.id}>
                  <TableCell className="text-xs text-muted-foreground">{new Date(log.syncedAt).toLocaleString()}</TableCell>
                  <TableCell><Badge variant="outline" className="capitalize">{log.source}</Badge></TableCell>
                  <TableCell><SyncStatusBadge status={log.status} /></TableCell>
                  <TableCell className="text-right">{log.recordsSynced}</TableCell>
                  <TableCell className="text-xs text-red-400 max-w-xs truncate">{log.errors ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
