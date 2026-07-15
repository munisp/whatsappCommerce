import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  RefreshCw,
  Link2,
  ArrowLeftRight,
  Package,
  AlertCircle,
  CheckCircle,
  Database,
  ShoppingBag,
  Plus,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

export default function OdooMedusaBridge() {
  const [syncing, setSyncing] = useState(false);
  const [newMapping, setNewMapping] = useState({
    odooProductId: "",
    medusaProductId: "",
    medusaVariantId: "",
    medusaInventoryItemId: "",
    productName: "",
  });
  const [showAddMapping, setShowAddMapping] = useState(false);

  const { data: mappings, refetch: refetchMappings } = trpc.odooMedusaBridge.list.useQuery();
  const { data: stats } = trpc.odooMedusaBridge.stats.useQuery();
  const syncMutation = trpc.odooMedusaBridge.syncOdooToMedusa.useMutation();
  const upsertMutation = trpc.odooMedusaBridge.upsertMapping.useMutation();

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await syncMutation.mutateAsync();
      const r = res as { synced?: number; errors?: string[]; skipped?: number };
      toast.success(`Sync complete: ${r.synced ?? 0} updated, ${r.skipped ?? 0} skipped`);
      if ((r.errors?.length ?? 0) > 0) {
        toast.warning(`${r.errors!.length} errors during sync`);
      }
      refetchMappings();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Sync failed";
      if (msg.includes("not configured")) {
        toast.error("Odoo or Medusa credentials not configured. Check Settings → Secrets.");
      } else {
        toast.error(msg);
      }
    } finally {
      setSyncing(false);
    }
  };

  const handleAddMapping = async () => {
    if (!newMapping.odooProductId || !newMapping.medusaProductId) {
      toast.error("Odoo Product ID and Medusa Product ID are required.");
      return;
    }
    try {
      await upsertMutation.mutateAsync({
        odooProductId: newMapping.odooProductId,
        medusaProductId: newMapping.medusaProductId,
        medusaVariantId: newMapping.medusaVariantId || undefined,
        medusaInventoryItemId: newMapping.medusaInventoryItemId || undefined,
        odooProductName: newMapping.productName || undefined,
      });
      toast.success("Mapping saved!");
      setNewMapping({ odooProductId: "", medusaProductId: "", medusaVariantId: "", medusaInventoryItemId: "", productName: "" });
      setShowAddMapping(false);
      refetchMappings();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save mapping");
    }
  };

  const bridgeMappings = (mappings?.items ?? []) as Array<{
    id: string;
    odooProductId: string;
    medusaProductId?: string | null;
    medusaVariantId?: string | null;
    odooProductName?: string | null;
    lastSyncedAt?: Date | null;
    syncStatus?: string | null;
    odooStockQty?: string | null;
    medusaStockQty?: string | null;
  }>;

  const bridgeStats = stats as {
    totalMappings?: number;
    syncedToday?: number;
    lastSyncAt?: string | null;
    odooConnected?: boolean;
    medusaConnected?: boolean;
  } | undefined;

  return (
    <DashboardLayout>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <ArrowLeftRight className="w-6 h-6 text-teal-600" />
              Odoo ↔ Medusa Inventory Bridge
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Bidirectional inventory sync between Odoo ERP and Medusa v2 store
            </p>
          </div>
          <Button
            onClick={handleSync}
            disabled={syncing}
            className="gap-2 bg-teal-600 hover:bg-teal-700"
          >
            {syncing ? (
              <><RefreshCw className="w-4 h-4 animate-spin" /> Syncing…</>
            ) : (
              <><Zap className="w-4 h-4" /> Sync Now</>
            )}
          </Button>
        </div>

        {/* Connection status */}
        <div className="grid grid-cols-2 gap-4">
          <Card className={bridgeStats?.odooConnected ? "border-emerald-200" : "border-amber-200"}>
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <Database className={`w-8 h-8 ${bridgeStats?.odooConnected ? "text-emerald-600" : "text-amber-500"}`} />
                <div>
                  <p className="font-medium text-sm">Odoo ERP</p>
                  <Badge variant={bridgeStats?.odooConnected ? "default" : "secondary"} className="text-xs mt-1">
                    {bridgeStats?.odooConnected ? <><CheckCircle className="w-3 h-3 mr-1" />Connected</> : <><AlertCircle className="w-3 h-3 mr-1" />Not configured</>}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className={bridgeStats?.medusaConnected ? "border-emerald-200" : "border-amber-200"}>
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <ShoppingBag className={`w-8 h-8 ${bridgeStats?.medusaConnected ? "text-emerald-600" : "text-amber-500"}`} />
                <div>
                  <p className="font-medium text-sm">Medusa v2</p>
                  <Badge variant={bridgeStats?.medusaConnected ? "default" : "secondary"} className="text-xs mt-1">
                    {bridgeStats?.medusaConnected ? <><CheckCircle className="w-3 h-3 mr-1" />Connected</> : <><AlertCircle className="w-3 h-3 mr-1" />Not configured</>}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Stats */}
        {bridgeStats && (
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <CardContent className="pt-4 text-center">
                <p className="text-2xl font-bold">{bridgeStats.totalMappings ?? 0}</p>
                <p className="text-xs text-muted-foreground">Product Mappings</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 text-center">
                <p className="text-2xl font-bold text-teal-600">{bridgeStats.syncedToday ?? 0}</p>
                <p className="text-xs text-muted-foreground">Synced Today</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 text-center">
                <p className="text-xs font-medium">Last Sync</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {bridgeStats.lastSyncAt
                    ? new Date(bridgeStats.lastSyncAt).toLocaleString()
                    : "Never"}
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Architecture explanation */}
        <Card className="bg-teal-50/50 dark:bg-teal-950/20 border-teal-200">
          <CardContent className="pt-4">
            <p className="text-sm font-medium mb-3">How the Bridge Works</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
              <div className="space-y-1">
                <p className="font-semibold text-teal-700 dark:text-teal-300">Odoo Inventory System</p>
                <p className="text-muted-foreground">
                  Odoo is the <strong>source of truth</strong> for physical stock. It tracks warehouse locations,
                  lot numbers, expiry dates, and purchase orders. Stock moves are recorded in Odoo first.
                </p>
              </div>
              <div className="flex items-center justify-center">
                <div className="text-center">
                  <ArrowLeftRight className="w-8 h-8 text-teal-600 mx-auto" />
                  <p className="text-xs text-muted-foreground mt-1">Bidirectional sync<br />via this bridge</p>
                </div>
              </div>
              <div className="space-y-1">
                <p className="font-semibold text-indigo-700 dark:text-indigo-300">Medusa Inventory Module</p>
                <p className="text-muted-foreground">
                  Medusa has its <strong>own inventory system</strong> (inventory items, stock locations, reservations).
                  The bridge maps Odoo products to Medusa inventory items and pushes stock levels via the Admin API.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Mappings table */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Link2 className="w-4 h-4" /> Product Mappings
                </CardTitle>
                <CardDescription className="text-xs">
                  Map Odoo product IDs to Medusa product/variant IDs for sync
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAddMapping(!showAddMapping)}
                className="gap-1"
              >
                <Plus className="w-4 h-4" /> Add Mapping
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {showAddMapping && (
              <Card className="border-dashed">
                <CardContent className="pt-4 space-y-3">
                  <p className="text-sm font-medium">New Mapping</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Odoo Product ID *</Label>
                      <Input
                        placeholder="e.g. 42"
                        value={newMapping.odooProductId}
                        onChange={(e) => setNewMapping((p) => ({ ...p, odooProductId: e.target.value }))}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Medusa Product ID *</Label>
                      <Input
                        placeholder="e.g. prod_01ABCDEF"
                        value={newMapping.medusaProductId}
                        onChange={(e) => setNewMapping((p) => ({ ...p, medusaProductId: e.target.value }))}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Medusa Variant ID</Label>
                      <Input
                        placeholder="e.g. variant_01ABCDEF"
                        value={newMapping.medusaVariantId}
                        onChange={(e) => setNewMapping((p) => ({ ...p, medusaVariantId: e.target.value }))}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Medusa Inventory Item ID</Label>
                      <Input
                        placeholder="e.g. iitem_01ABCDEF"
                        value={newMapping.medusaInventoryItemId}
                        onChange={(e) => setNewMapping((p) => ({ ...p, medusaInventoryItemId: e.target.value }))}
                      />
                    </div>
                    <div className="col-span-2">
                      <Label className="text-xs">Product Name (optional)</Label>
                      <Input
                        placeholder="e.g. Coca-Cola 500ml"
                        value={newMapping.productName}
                        onChange={(e) => setNewMapping((p) => ({ ...p, productName: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleAddMapping} className="bg-teal-600 hover:bg-teal-700">
                      Save Mapping
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setShowAddMapping(false)}>
                      Cancel
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {bridgeMappings.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground border-dashed border rounded-lg">
                <Link2 className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No product mappings yet.</p>
                <p className="text-xs mt-1">Add a mapping to start syncing inventory between Odoo and Medusa.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 font-medium text-muted-foreground">Product</th>
                      <th className="text-left py-2 font-medium text-muted-foreground">Odoo ID</th>
                      <th className="text-left py-2 font-medium text-muted-foreground">Medusa ID</th>
                      <th className="text-right py-2 font-medium text-muted-foreground">Odoo Stock</th>
                      <th className="text-right py-2 font-medium text-muted-foreground">Medusa Stock</th>
                      <th className="text-left py-2 font-medium text-muted-foreground">Last Sync</th>
                      <th className="text-left py-2 font-medium text-muted-foreground">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bridgeMappings.map((m) => (
                      <tr key={m.id} className="border-b hover:bg-muted/30">
                        <td className="py-2 font-medium max-w-32 truncate">{m.odooProductName ?? "—"}</td>
                        <td className="py-2 font-mono">{m.odooProductId}</td>
                        <td className="py-2 font-mono text-muted-foreground max-w-24 truncate">{m.medusaProductId}</td>
                        <td className="py-2 text-right">{m.odooStockQty ?? "—"}</td>
                        <td className="py-2 text-right">{m.medusaStockQty ?? "—"}</td>
                        <td className="py-2 text-muted-foreground">
                          {m.lastSyncedAt ? new Date(m.lastSyncedAt).toLocaleTimeString() : "Never"}
                        </td>
                        <td className="py-2">
                          <Badge
                            variant={
                              m.syncStatus === "success"
                                ? "default"
                                : m.syncStatus === "failed"
                                ? "destructive"
                                : "secondary"
                            }
                            className="text-xs"
                          >
                            {m.syncStatus ?? "idle"}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
