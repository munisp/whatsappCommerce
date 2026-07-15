import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, CheckCircle2, Download, Package, Plus, TrendingUp, Upload, XCircle } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

const statusColors: Record<string, string> = {
  active: "bg-green-500/20 text-green-400 border-green-500/30",
  inactive: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  archived: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

export default function Products() {
  const { activeTenantId: DEMO_TENANT } = useActiveTenant();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ sku: "", name: "", description: "", category: "", price: "", stockQuantity: 0 });

  // CSV import state
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  const [csvStep, setCsvStep] = useState<"upload" | "preview" | "result">("upload");
  const [importResult, setImportResult] = useState<{ inserted: number; skipped: number; errors: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: stats } = trpc.product.stats.useQuery({ tenantId: DEMO_TENANT });
  const { data: productList, refetch } = trpc.product.list.useQuery({ tenantId: DEMO_TENANT, search: search || undefined });
  const createMutation = trpc.product.create.useMutation({
    onSuccess: () => { toast.success("Product created"); setOpen(false); refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const validateCsvQuery = trpc.product.validateCsv.useQuery(
    { rows: csvRows.map(r => ({ sku: r.sku ?? "", name: r.name ?? "", price: r.price ?? "" })) },
    { enabled: csvRows.length > 0 && csvStep === "preview" }
  );
  const importMutation = trpc.product.importCsv.useMutation({
    onSuccess: (result) => {
      setImportResult(result);
      setCsvStep("result");
      refetch();
      if (result.inserted > 0) toast.success(`Imported ${result.inserted} products`);
    },
    onError: (e) => toast.error(e.message),
  });

  function parseCsvFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) { toast.error("CSV must have a header row and at least one data row"); return; }
      const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/\s+/g, "_"));
      const rows = lines.slice(1).map(line => {
        const vals = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
        return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""])) as Record<string, string>;
      });
      setCsvRows(rows);
      setCsvStep("preview");
    };
    reader.readAsText(file);
  }

  function downloadTemplate() {
    const csv = "sku,name,description,category,price,currency,stock_quantity,low_stock_threshold\nPROD-001,Sample Product,A great product,Electronics,1500.00,NGN,100,10";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "product_import_template.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Products</h1>
            <p className="text-muted-foreground mt-1">Manage your product catalog</p>
          </div>
          <div className="flex gap-2">
            {/* CSV Import Dialog */}
            <Dialog open={csvOpen} onOpenChange={(v) => { setCsvOpen(v); if (!v) { setCsvStep("upload"); setCsvRows([]); setImportResult(null); } }}>
              <DialogTrigger asChild>
                <Button variant="outline" className="gap-2 border-border bg-transparent"><Upload className="w-4 h-4" />Import CSV</Button>
              </DialogTrigger>
              <DialogContent className="bg-card border-border max-w-2xl">
                <DialogHeader><DialogTitle>Bulk Import Products</DialogTitle></DialogHeader>

                {csvStep === "upload" && (
                  <div className="space-y-4 mt-2">
                    <p className="text-sm text-muted-foreground">Upload a CSV with columns: <code className="bg-muted px-1 rounded text-xs">sku, name, description, category, price, currency, stock_quantity, low_stock_threshold</code></p>
                    <Button variant="outline" size="sm" className="gap-2 border-border bg-transparent" onClick={downloadTemplate}><Download className="w-3 h-3" />Download Template</Button>
                    <div
                      className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
                      onClick={() => fileInputRef.current?.click()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) parseCsvFile(f); }}
                    >
                      <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
                      <p className="text-sm text-muted-foreground">Drag & drop a CSV file here, or click to browse</p>
                      <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) parseCsvFile(f); }} />
                    </div>
                  </div>
                )}

                {csvStep === "preview" && (
                  <div className="space-y-4 mt-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-muted-foreground">{csvRows.length} rows detected</p>
                      {validateCsvQuery.data && (
                        <Badge variant="outline" className={validateCsvQuery.data.valid ? "text-green-400 border-green-500/30" : "text-red-400 border-red-500/30"}>
                          {validateCsvQuery.data.valid ? <CheckCircle2 className="w-3 h-3 mr-1 inline" /> : <XCircle className="w-3 h-3 mr-1 inline" />}
                          {validateCsvQuery.data.valid ? "All rows valid" : `${validateCsvQuery.data.issues.length} issue(s)`}
                        </Badge>
                      )}
                    </div>
                    {validateCsvQuery.data && !validateCsvQuery.data.valid && (
                      <div className="bg-red-500/10 border border-red-500/20 rounded p-3 max-h-32 overflow-y-auto">
                        {validateCsvQuery.data.issues.slice(0, 10).map((issue, i) => (
                          <p key={i} className="text-xs text-red-400">Row {issue.row} — {issue.field}: {issue.message}</p>
                        ))}
                      </div>
                    )}
                    <div className="max-h-48 overflow-y-auto border border-border rounded">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-border"><TableHead>SKU</TableHead><TableHead>Name</TableHead><TableHead>Price</TableHead><TableHead>Stock</TableHead></TableRow>
                        </TableHeader>
                        <TableBody>
                          {csvRows.slice(0, 20).map((r, i) => (
                            <TableRow key={i} className="border-border text-xs">
                              <TableCell className="font-mono">{r.sku}</TableCell>
                              <TableCell>{r.name}</TableCell>
                              <TableCell className="font-mono">{r.price}</TableCell>
                              <TableCell>{r.stock_quantity ?? "0"}</TableCell>
                            </TableRow>
                          ))}
                          {csvRows.length > 20 && <TableRow><TableCell colSpan={4} className="text-center text-xs text-muted-foreground">…and {csvRows.length - 20} more rows</TableCell></TableRow>}
                        </TableBody>
                      </Table>
                    </div>
                    <div className="flex gap-2 justify-end">
                      <Button variant="outline" className="border-border bg-transparent" onClick={() => setCsvStep("upload")}>Back</Button>
                      <Button
                        className="bg-primary text-primary-foreground"
                        disabled={importMutation.isPending || (validateCsvQuery.data ? !validateCsvQuery.data.valid : false)}
                        onClick={() => importMutation.mutate({
                          tenantId: DEMO_TENANT,
                          rows: csvRows.map(r => ({
                            sku: r.sku ?? "",
                            name: r.name ?? "",
                            description: r.description || undefined,
                            category: r.category || undefined,
                            price: r.price ?? "0",
                            currency: r.currency || "NGN",
                            stockQuantity: parseInt(r.stock_quantity ?? "0") || 0,
                            lowStockThreshold: parseInt(r.low_stock_threshold ?? "10") || 10,
                            imageUrl: r.image_url || undefined,
                          })),
                          skipDuplicates: true,
                        })}
                      >
                        {importMutation.isPending ? "Importing…" : `Import ${csvRows.length} Products`}
                      </Button>
                    </div>
                  </div>
                )}

                {csvStep === "result" && importResult && (
                  <div className="space-y-4 mt-2 text-center py-4">
                    <CheckCircle2 className="w-12 h-12 text-green-400 mx-auto" />
                    <h3 className="text-lg font-semibold">Import Complete</h3>
                    <div className="grid grid-cols-3 gap-3 text-sm">
                      <div className="bg-green-500/10 rounded p-3"><p className="text-2xl font-bold text-green-400">{importResult.inserted}</p><p className="text-muted-foreground">Imported</p></div>
                      <div className="bg-yellow-500/10 rounded p-3"><p className="text-2xl font-bold text-yellow-400">{importResult.skipped}</p><p className="text-muted-foreground">Skipped</p></div>
                      <div className="bg-red-500/10 rounded p-3"><p className="text-2xl font-bold text-red-400">{importResult.errors.length}</p><p className="text-muted-foreground">Errors</p></div>
                    </div>
                    {importResult.errors.length > 0 && (
                      <div className="bg-red-500/10 border border-red-500/20 rounded p-3 text-left max-h-32 overflow-y-auto">
                        {importResult.errors.map((e, i) => <p key={i} className="text-xs text-red-400">{e}</p>)}
                      </div>
                    )}
                    <Button className="bg-primary text-primary-foreground" onClick={() => setCsvOpen(false)}>Done</Button>
                  </div>
                )}
              </DialogContent>
            </Dialog>

            {/* Single product add dialog */}
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
                    { key: "price", label: "Price (NGN)", placeholder: "1500.00" },
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
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No products yet. Add your first product or import via CSV.</TableCell></TableRow>
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
