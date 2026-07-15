import { useState } from "react";
import { TenantPortalLayout } from "@/components/TenantPortalLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Package, Edit2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
type ProductRow = {
  id: string; tenantId: string; sku: string; name: string;
  description: string | null; category: string | null; price: string;
  currency: string; imageUrl: string | null;
  status: "active" | "inactive" | "archived";
  stockQuantity: number; lowStockThreshold: number | null;
  createdAt: Date; updatedAt: Date;
};

export default function PortalProducts() {
  const { data: products, refetch } = trpc.tenantPortal.listMyProducts.useQuery({ limit: 100 });
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [form, setForm] = useState({ name: "", price: "", stockQuantity: 0, status: "active" as "active" | "inactive" | "archived" });

  const updateMutation = trpc.tenantPortal.updateMyProduct.useMutation({
    onSuccess: () => { toast.success("Product updated"); refetch(); setEditing(null); },
    onError: (e) => toast.error(e.message),
  });

  function openEdit(p: ProductRow) {
    setEditing(p);
    setForm({ name: p.name, price: String(p.price), stockQuantity: p.stockQuantity, status: p.status });
  }

  return (
    <TenantPortalLayout>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">My Products</h1>
        {/* Low-stock alert banner */}
        {(() => {
          const lowStockItems = ((products ?? []) as ProductRow[]).filter(
            p => p.status === "active" && p.stockQuantity <= (p.lowStockThreshold ?? 10)
          );
          if (lowStockItems.length === 0) return null;
          return (
            <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
              <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-400">
                  {lowStockItems.length} product{lowStockItems.length > 1 ? "s" : ""} running low on stock
                </p>
                <p className="text-xs text-amber-400/70 mt-0.5">
                  {lowStockItems.map(p => `${p.name} (${p.stockQuantity} left)`).join(" · ")}
                </p>
              </div>
            </div>
          );
        })()}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {((products ?? []) as ProductRow[]).map(p => (
            <Card key={p.id} className="bg-slate-800 border-slate-700">
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-3">
                  <div className="bg-slate-700 p-2 rounded-lg">
                    <Package className="h-5 w-5 text-slate-300" />
                  </div>
                  <Badge className={p.status === "active" ? "bg-emerald-600/20 text-emerald-400 border-emerald-600/30" : "bg-slate-600/20 text-slate-400 border-slate-600/30"}>
                    {p.status}
                  </Badge>
                </div>
                <p className="font-semibold text-white text-sm mb-1 truncate">{p.name}</p>
                <p className="text-xs text-slate-400 mb-2">SKU: {p.sku}</p>
                <div className="flex items-center justify-between">
                  <span className="text-emerald-400 font-bold">${Number(p.price).toFixed(2)}</span>
                  <div className="flex items-center gap-1 text-xs text-slate-400">
                    {p.stockQuantity <= (p.lowStockThreshold ?? 10) && (
                      <AlertTriangle className="h-3 w-3 text-amber-400" />
                    )}
                    <span>{p.stockQuantity} in stock</span>
                  </div>
                </div>
                <Button size="sm" variant="outline" className="w-full mt-3 border-slate-600 text-slate-300 hover:bg-slate-700"
                  onClick={() => openEdit(p)}>
                  <Edit2 className="h-3 w-3 mr-1" /> Edit
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <Dialog open={!!editing} onOpenChange={() => setEditing(null)}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white">
          <DialogHeader><DialogTitle>Edit Product</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><label className="text-xs text-slate-400">Name</label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="bg-slate-700 border-slate-600 text-white mt-1" /></div>
            <div><label className="text-xs text-slate-400">Price</label>
              <Input value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))}
                className="bg-slate-700 border-slate-600 text-white mt-1" /></div>
            <div><label className="text-xs text-slate-400">Stock Quantity</label>
              <Input type="number" value={form.stockQuantity} onChange={e => setForm(f => ({ ...f, stockQuantity: Number(e.target.value) }))}
                className="bg-slate-700 border-slate-600 text-white mt-1" /></div>
            <div><label className="text-xs text-slate-400">Status</label>
              <Select value={form.status} onValueChange={(v: "active" | "inactive" | "archived") => setForm(f => ({ ...f, status: v }))}>
                <SelectTrigger className="bg-slate-700 border-slate-600 text-white mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-500"
              disabled={updateMutation.isPending}
              onClick={() => editing && updateMutation.mutate({
                productId: editing.id, ...form,
                stockQuantity: Number(form.stockQuantity),
              })}>
              {updateMutation.isPending ? "Saving…" : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TenantPortalLayout>
  );
}
