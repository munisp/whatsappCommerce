// === W55 ui-c ===
// Inventory depth surface for the W46 inventoryDepth router
// (ORPHAN-BE-20): warehouses, batches (FEFO + expiry sweep), product
// variants, and delivery claims.
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { Boxes, Layers, Package, Plus, ShieldAlert, Warehouse as WarehouseIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const claimStatusColors: Record<string, string> = {
  open: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  under_review: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  approved: "bg-green-500/20 text-green-400 border-green-500/30",
  rejected: "bg-red-500/20 text-red-400 border-red-500/30",
  resolved: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

const CLAIM_TRANSITIONS: Record<string, string[]> = {
  open: ["under_review", "rejected"],
  under_review: ["approved", "rejected"],
  approved: ["resolved"],
  rejected: ["resolved"],
  resolved: [],
};

export default function InventoryDepth() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const utils = trpc.useUtils();

  const { data: warehouses, isLoading: whLoading } = trpc.inventoryDepth.listWarehouses.useQuery({ tenantId });
  const { data: batches, isLoading: batchLoading } = trpc.inventoryDepth.listBatches.useQuery({ tenantId });
  const { data: variants, isLoading: varLoading } = trpc.inventoryDepth.listVariants.useQuery({ tenantId });
  const { data: claims, isLoading: claimsLoading } = trpc.inventoryDepth.listClaims.useQuery({ tenantId });
  const { data: products } = trpc.product.list.useQuery({ tenantId });

  const invalidate = () => utils.inventoryDepth.invalidate();
  const opts = (label: string, close?: () => void) => ({
    onSuccess: () => { toast.success(label); close?.(); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });

  const createWarehouseMut = trpc.inventoryDepth.createWarehouse.useMutation(opts("Warehouse created", () => setWarehouseOpen(false)));
  const receiveBatchMut = trpc.inventoryDepth.receiveBatch.useMutation(opts("Batch received", () => setBatchOpen(false)));
  const upsertVariantMut = trpc.inventoryDepth.upsertVariant.useMutation(opts("Variant saved", () => setVariantOpen(false)));
  const receiveVariantStockMut = trpc.inventoryDepth.receiveVariantStock.useMutation(opts("Stock received", () => setStockFor(null)));
  const sweepMut = trpc.inventoryDepth.runExpirySweep.useMutation({
    onSuccess: (r: any) => { toast.success(`Expiry sweep done — ${r?.swept ?? r?.expired ?? 0} batches handled`); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const transitionClaimMut = trpc.inventoryDepth.transitionClaim.useMutation(opts("Claim updated"));

  const [warehouseOpen, setWarehouseOpen] = useState(false);
  const [warehouseName, setWarehouseName] = useState("");
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchForm, setBatchForm] = useState({ productId: "", qty: "", batchCode: "", expiryDate: "" });
  const [variantOpen, setVariantOpen] = useState(false);
  const [variantForm, setVariantForm] = useState({ productId: "", sku: "", name: "", barcode: "", initialStock: "0" });
  const [stockFor, setStockFor] = useState<string | null>(null);
  const [stockQty, setStockQty] = useState("");

  const productName = (id: string) => (products ?? []).find((p: any) => p.id === id)?.name ?? id.slice(0, 8);

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Inventory Depth</h1>
          <p className="text-muted-foreground mt-1">Warehouses, batches, variants and delivery claims</p>
        </div>

        <Tabs defaultValue="warehouses">
          <TabsList>
            <TabsTrigger value="warehouses"><WarehouseIcon className="w-3.5 h-3.5 mr-1" />Warehouses</TabsTrigger>
            <TabsTrigger value="batches"><Layers className="w-3.5 h-3.5 mr-1" />Batches</TabsTrigger>
            <TabsTrigger value="variants"><Boxes className="w-3.5 h-3.5 mr-1" />Variants</TabsTrigger>
            <TabsTrigger value="claims"><ShieldAlert className="w-3.5 h-3.5 mr-1" />Claims</TabsTrigger>
          </TabsList>

          <TabsContent value="warehouses" className="space-y-4 pt-4">
            <div className="flex justify-end">
              <Button size="sm" className="gap-1" onClick={() => { setWarehouseName(""); setWarehouseOpen(true); }}>
                <Plus className="w-4 h-4" /> New warehouse
              </Button>
            </div>
            <Card className="bg-card border-border">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead>Name</TableHead>
                      <TableHead>Default</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {whLoading ? (
                      <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
                    ) : !warehouses?.length ? (
                      <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground py-8">No warehouses yet</TableCell></TableRow>
                    ) : warehouses.map((w) => (
                      <TableRow key={w.id} className="border-border hover:bg-accent/30">
                        <TableCell className="font-medium">{w.name}</TableCell>
                        <TableCell>{w.isDefault ? <Badge variant="outline" className="bg-green-500/20 text-green-400 border-green-500/30">default</Badge> : "—"}</TableCell>
                        <TableCell className="text-muted-foreground text-xs">{w.createdAt ? formatDistanceToNow(new Date(w.createdAt), { addSuffix: true }) : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="batches" className="space-y-4 pt-4">
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => sweepMut.mutate({ tenantId })} disabled={sweepMut.isPending}>
                Run expiry sweep
              </Button>
              <Button size="sm" className="gap-1" onClick={() => { setBatchForm({ productId: "", qty: "", batchCode: "", expiryDate: "" }); setBatchOpen(true); }}>
                <Plus className="w-4 h-4" /> Receive batch
              </Button>
            </div>
            <Card className="bg-card border-border">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead>Batch</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Qty</TableHead>
                      <TableHead>Expiry</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {batchLoading ? (
                      <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
                    ) : !batches?.length ? (
                      <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">No batches</TableCell></TableRow>
                    ) : batches.map((b: any) => (
                      <TableRow key={b.id} className="border-border hover:bg-accent/30">
                        <TableCell className="font-mono text-xs">{b.batchCode ?? b.id.slice(0, 8)}</TableCell>
                        <TableCell className="text-sm">{productName(b.productId)}</TableCell>
                        <TableCell className="font-mono">{b.qtyOnHand ?? b.qty}</TableCell>
                        <TableCell className="text-xs">
                          {b.expiryDate ? (
                            <span className={new Date(b.expiryDate) < new Date() ? "text-red-400" : "text-muted-foreground"}>
                              {new Date(b.expiryDate).toLocaleDateString()}
                            </span>
                          ) : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="variants" className="space-y-4 pt-4">
            <div className="flex justify-end">
              <Button size="sm" className="gap-1" onClick={() => { setVariantForm({ productId: "", sku: "", name: "", barcode: "", initialStock: "0" }); setVariantOpen(true); }}>
                <Plus className="w-4 h-4" /> New variant
              </Button>
            </div>
            <Card className="bg-card border-border">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead>SKU</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Barcode</TableHead>
                      <TableHead>Stock</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {varLoading ? (
                      <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
                    ) : !variants?.length ? (
                      <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No variants</TableCell></TableRow>
                    ) : variants.map((v) => (
                      <TableRow key={v.id} className="border-border hover:bg-accent/30">
                        <TableCell className="font-mono text-xs">{v.sku}</TableCell>
                        <TableCell className="text-sm">{productName(v.productId)}</TableCell>
                        <TableCell className="text-sm">{v.name ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{v.barcode ?? "—"}</TableCell>
                        <TableCell className="font-mono">{v.stockQuantity}</TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"
                            onClick={() => { setStockFor(v.id); setStockQty(""); }}>
                            <Package className="w-3 h-3" /> Receive stock
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="claims" className="space-y-4 pt-4">
            <Card className="bg-card border-border">
              <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Delivery claims</CardTitle></CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead>Type</TableHead>
                      <TableHead>Shipment</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Reported</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {claimsLoading ? (
                      <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
                    ) : !claims?.length ? (
                      <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No delivery claims</TableCell></TableRow>
                    ) : claims.map((c: any) => (
                      <TableRow key={c.id} className="border-border hover:bg-accent/30">
                        <TableCell><Badge variant="outline">{c.type}</Badge></TableCell>
                        <TableCell className="font-mono text-xs">{String(c.shipmentId).slice(0, 8)}...</TableCell>
                        <TableCell><Badge variant="outline" className={claimStatusColors[c.status] ?? ""}>{String(c.status).replaceAll("_", " ")}</Badge></TableCell>
                        <TableCell className="text-muted-foreground text-xs">{c.createdAt ? formatDistanceToNow(new Date(c.createdAt), { addSuffix: true }) : "—"}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {(CLAIM_TRANSITIONS[c.status] ?? []).map((to) => (
                              <Button key={to} variant="ghost" size="sm" className="h-7 text-xs"
                                disabled={transitionClaimMut.isPending}
                                onClick={() => transitionClaimMut.mutate({ tenantId, claimId: c.id, to: to as any })}>
                                → {to.replaceAll("_", " ")}
                              </Button>
                            ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <Dialog open={warehouseOpen} onOpenChange={setWarehouseOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>New warehouse</DialogTitle></DialogHeader>
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={warehouseName} onChange={(e) => setWarehouseName(e.target.value)} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setWarehouseOpen(false)}>Close</Button>
              <Button disabled={createWarehouseMut.isPending || !warehouseName.trim()}
                onClick={() => createWarehouseMut.mutate({ tenantId, name: warehouseName.trim(), isDefault: !(warehouses?.length) })}>
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Receive batch</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Product</Label>
                <Select value={batchForm.productId} onValueChange={(v) => setBatchForm({ ...batchForm, productId: v })}>
                  <SelectTrigger><SelectValue placeholder="Pick a product" /></SelectTrigger>
                  <SelectContent>
                    {(products ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Quantity</Label>
                  <Input type="number" min={1} value={batchForm.qty} onChange={(e) => setBatchForm({ ...batchForm, qty: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Batch code (optional)</Label>
                  <Input value={batchForm.batchCode} onChange={(e) => setBatchForm({ ...batchForm, batchCode: e.target.value })} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Expiry date (optional)</Label>
                <Input type="date" value={batchForm.expiryDate} onChange={(e) => setBatchForm({ ...batchForm, expiryDate: e.target.value })} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setBatchOpen(false)}>Close</Button>
              <Button disabled={receiveBatchMut.isPending || !batchForm.productId || !(Number(batchForm.qty) > 0)}
                onClick={() => receiveBatchMut.mutate({
                  tenantId, productId: batchForm.productId, qty: Number(batchForm.qty),
                  batchCode: batchForm.batchCode || undefined,
                  expiryDate: batchForm.expiryDate ? new Date(batchForm.expiryDate) : undefined,
                })}>
                Receive
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={variantOpen} onOpenChange={setVariantOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>New variant</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Product</Label>
                <Select value={variantForm.productId} onValueChange={(v) => setVariantForm({ ...variantForm, productId: v })}>
                  <SelectTrigger><SelectValue placeholder="Pick a product" /></SelectTrigger>
                  <SelectContent>
                    {(products ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>SKU</Label>
                  <Input value={variantForm.sku} onChange={(e) => setVariantForm({ ...variantForm, sku: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Name (optional)</Label>
                  <Input value={variantForm.name} onChange={(e) => setVariantForm({ ...variantForm, name: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Barcode (optional)</Label>
                  <Input value={variantForm.barcode} onChange={(e) => setVariantForm({ ...variantForm, barcode: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Initial stock</Label>
                  <Input type="number" min={0} value={variantForm.initialStock} onChange={(e) => setVariantForm({ ...variantForm, initialStock: e.target.value })} />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setVariantOpen(false)}>Close</Button>
              <Button disabled={upsertVariantMut.isPending || !variantForm.productId || !variantForm.sku.trim()}
                onClick={() => upsertVariantMut.mutate({
                  tenantId, productId: variantForm.productId, sku: variantForm.sku.trim(),
                  name: variantForm.name || undefined, barcode: variantForm.barcode || undefined,
                  initialStock: Number(variantForm.initialStock) || 0,
                })}>
                Save variant
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!stockFor} onOpenChange={() => setStockFor(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Receive variant stock</DialogTitle></DialogHeader>
            <div className="space-y-2">
              <Label>Quantity</Label>
              <Input type="number" min={1} value={stockQty} onChange={(e) => setStockQty(e.target.value)} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStockFor(null)}>Close</Button>
              <Button disabled={receiveVariantStockMut.isPending || !(Number(stockQty) > 0)}
                onClick={() => stockFor && receiveVariantStockMut.mutate({ tenantId, variantId: stockFor, qty: Number(stockQty) })}>
                Receive
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
