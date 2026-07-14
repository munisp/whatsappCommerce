import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, Package, Plus, TrendingUp } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const DEMO_TENANT = "demo-tenant-001";

const statusColors: Record<string, string> = {
  active: "bg-green-500/20 text-green-400 border-green-500/30",
  inactive: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  archived: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

export default function Products() {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ sku: "", name: "", description: "", category: "", price: "", stockQuantity: 0 });

  const { data: stats } = trpc.product.stats.useQuery({ tenantId: DEMO_TENANT });
  const { data: productList, refetch } = trpc.product.list.useQuery({ tenantId: DEMO_TENANT, search: search || undefined });
  const createMutation = trpc.product.create.useMutation({
    onSuccess: () => { toast.success("Product created"); setOpen(false); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Products</h1>
            <p className="text-muted-foreground mt-1">Manage your product catalog</p>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="bg-primary text-primary-foreground gap-2"><Plus className="w-4 h-4" />Add Product</Button>
            </DialogTrigger>
            <DialogContent className="bg-card border-border">
              <DialogHeader><DialogTitle>Add Product</DialogTitle></DialogHeader>
              <div className="space-y-3 mt-2">
                {[
                  { key: "sku", label: "SKU", placeholder: "PROD-001" },
                  { key: "name", label: "Name", placeholder: "Product Name" },
                  { key: "category", label: "Category", placeholder: "Electronics" },
                  { key: "price", label: "Price (USD)", placeholder: "29.99" },
                ].map((f) => (
                  <div key={f.key} className="space-y-1">
                    <Label>{f.label}</Label>
                    <Input value={(form as any)[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} placeholder={f.placeholder} className="bg-input border-border" />
                  </div>
                ))}
                <div className="space-y-1">
                  <Label>Stock Quantity</Label>
                  <Input type="number" value={form.stockQuantity} onChange={(e) => setForm({ ...form, stockQuantity: parseInt(e.target.value) || 0 })} className="bg-input border-border" />
                </div>
                <Button className="w-full bg-primary text-primary-foreground" onClick={() => createMutation.mutate({ tenantId: DEMO_TENANT, ...form })} disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Creating..." : "Create Product"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Total Products", value: stats?.total ?? 0, icon: Package, color: "text-foreground" },
            { label: "Active", value: stats?.active ?? 0, icon: TrendingUp, color: "text-green-400" },
            { label: "Low Stock", value: stats?.lowStock ?? 0, icon: AlertTriangle, color: "text-yellow-400" },
          ].map((s) => (
            <Card key={s.label} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">{s.label}</p>
                    <p className={`text-2xl font-bold mt-1 ${s.color}`}>{s.value}</p>
                  </div>
                  <s.icon className={`w-8 h-8 ${s.color} opacity-50`} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex gap-3">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products..." className="max-w-xs bg-card border-border" />
        </div>

        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Product Catalog</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>SKU</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Stock</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!productList || productList.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No products yet. Add your first product.</TableCell></TableRow>
                ) : productList.map((p) => (
                  <TableRow key={p.id} className="border-border hover:bg-accent/30">
                    <TableCell className="font-mono text-xs">{p.sku}</TableCell>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="text-muted-foreground">{p.category ?? "—"}</TableCell>
                    <TableCell className="font-mono">{p.currency} {Number(p.price).toFixed(2)}</TableCell>
                    <TableCell className={p.stockQuantity <= (p.lowStockThreshold ?? 10) ? "text-yellow-400 font-mono" : "font-mono"}>{p.stockQuantity}</TableCell>
                    <TableCell><Badge variant="outline" className={statusColors[p.status] ?? ""}>{p.status}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

