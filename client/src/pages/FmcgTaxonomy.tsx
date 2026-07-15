import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Search, Plus, RefreshCw, Package, Tag, Globe, Layers,
  CheckCircle, Filter, X,
} from "lucide-react";

type TaxonomyItem = {
  id: string; category: string; subcategory?: string | null; brand: string;
  productName: string; variants: string[]; aliases: string[];
  isLocal: boolean; isSachet: boolean; typicalUnit?: string | null;
  isCustom: boolean; isActive: boolean;
};

export default function FmcgTaxonomy() {
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterLocal, setFilterLocal] = useState<boolean | undefined>(undefined);
  const [filterSachet, setFilterSachet] = useState<boolean | undefined>(undefined);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newItem, setNewItem] = useState({ category: "", subcategory: "", brand: "", productName: "", variants: "", aliases: "", isSachet: false, typicalUnit: "unit" });
  const [seeding, setSeeding] = useState(false);

  const { data: listData, refetch } = trpc.taxonomy.list.useQuery({
    search: search || undefined,
    category: filterCategory || undefined,
    isLocal: filterLocal,
    isSachet: filterSachet,
    limit: 200,
  });
  const { data: catsData } = trpc.taxonomy.categories.useQuery();
  const { data: statsData } = trpc.taxonomy.stats.useQuery();
  const addCustomMutation = trpc.taxonomy.addCustom.useMutation();
  const seedMutation = trpc.taxonomy.seed.useMutation();

  const items: TaxonomyItem[] = (listData?.items ?? []) as TaxonomyItem[];
  const categories = (catsData ?? []) as { category: string; subcategories: string[] }[];
  const stats = statsData as { total?: number; categories?: number; brands?: number; local?: number; sachet?: number; custom?: number } | undefined;

  const handleSeed = async () => {
    setSeeding(true);
    try {
      const result = await seedMutation.mutateAsync();
      const r = result as { seeded: number; message: string };
      toast.success(r.message);
      refetch();
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : "Seed failed"); }
    finally { setSeeding(false); }
  };

  const handleAddCustom = async () => {
    if (!newItem.category || !newItem.brand || !newItem.productName) {
      toast.error("Category, brand, and product name are required");
      return;
    }
    try {
      await addCustomMutation.mutateAsync({
        ...newItem,
        variants: newItem.variants.split(",").map(v => v.trim()).filter(Boolean),
        aliases: newItem.aliases.split(",").map(a => a.trim()).filter(Boolean),
      });
      toast.success("Custom product added to taxonomy");
      setNewItem({ category: "", subcategory: "", brand: "", productName: "", variants: "", aliases: "", isSachet: false, typicalUnit: "unit" });
      setShowAddForm(false);
      refetch();
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : "Add failed"); }
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6 max-w-6xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Package className="w-6 h-6 text-green-600" /> Nigerian FMCG Taxonomy
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Product knowledge base for AI visual inventory — brands, variants, aliases, and sachet economy items
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleSeed} disabled={seeding} className="gap-1 text-xs">
              {seeding ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
              Seed FMCG Data
            </Button>
            <Button size="sm" onClick={() => setShowAddForm(p => !p)} className="gap-1 text-xs">
              <Plus className="w-3.5 h-3.5" /> Add Custom
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
          {[
            { label: "Products", value: stats?.total ?? 0, color: "text-green-600" },
            { label: "Categories", value: stats?.categories ?? 0, color: "text-blue-600" },
            { label: "Brands", value: stats?.brands ?? 0, color: "text-purple-600" },
            { label: "Local Brands", value: stats?.local ?? 0, color: "text-emerald-600" },
            { label: "Sachet Items", value: stats?.sachet ?? 0, color: "text-amber-600" },
            { label: "Custom Added", value: stats?.custom ?? 0, color: "text-rose-600" },
          ].map(s => (
            <Card key={s.label} className="text-center">
              <CardContent className="pt-3 pb-2">
                <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Add custom form */}
        {showAddForm && (
          <Card className="border-green-200 bg-green-50/40 dark:bg-green-950/20">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">Add Custom Product</CardTitle>
                <button onClick={() => setShowAddForm(false)}><X className="w-4 h-4 text-muted-foreground" /></button>
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { key: "category", label: "Category", placeholder: "Beverages" },
                { key: "subcategory", label: "Subcategory", placeholder: "Carbonated Drinks" },
                { key: "brand", label: "Brand", placeholder: "Bigi" },
                { key: "productName", label: "Product Name", placeholder: "Bigi Cola 500ml" },
                { key: "variants", label: "Variants (comma-sep)", placeholder: "350ml, 500ml, 1L" },
                { key: "aliases", label: "Aliases (comma-sep)", placeholder: "Bigi, bigi drink" },
                { key: "typicalUnit", label: "Typical Unit", placeholder: "bottle" },
              ].map(f => (
                <div key={f.key}>
                  <Label className="text-xs">{f.label}</Label>
                  <Input className="mt-1 text-xs" placeholder={f.placeholder} value={(newItem as unknown as Record<string, string>)[f.key]} onChange={e => setNewItem(p => ({ ...p, [f.key]: e.target.value }))} />
                </div>
              ))}
              <div className="flex items-end">
                <Button size="sm" onClick={handleAddCustom} disabled={addCustomMutation.isPending} className="w-full gap-1">
                  {addCustomMutation.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input className="pl-9 text-sm" placeholder="Search products, brands, aliases…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className="text-sm border rounded-md px-3 py-2 bg-background" value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
            <option value="">All Categories</option>
            {categories.map(c => <option key={c.category} value={c.category}>{c.category}</option>)}
          </select>
          <Button variant={filterLocal === true ? "default" : "outline"} size="sm" className="text-xs gap-1" onClick={() => setFilterLocal(p => p === true ? undefined : true)}>
            <Globe className="w-3.5 h-3.5" /> Local Only
          </Button>
          <Button variant={filterSachet === true ? "default" : "outline"} size="sm" className="text-xs gap-1" onClick={() => setFilterSachet(p => p === true ? undefined : true)}>
            <Tag className="w-3.5 h-3.5" /> Sachet Only
          </Button>
          {(search || filterCategory || filterLocal !== undefined || filterSachet !== undefined) && (
            <Button variant="ghost" size="sm" className="text-xs gap-1" onClick={() => { setSearch(""); setFilterCategory(""); setFilterLocal(undefined); setFilterSachet(undefined); }}>
              <X className="w-3.5 h-3.5" /> Clear
            </Button>
          )}
          <span className="text-xs text-muted-foreground ml-auto">{items.length} results</span>
        </div>

        {/* Product grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {items.length === 0 ? (
            <div className="col-span-3 text-center py-12 text-muted-foreground">
              <Package className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No products found. Click <strong>Seed FMCG Data</strong> to populate with Nigerian market products.</p>
            </div>
          ) : items.map(item => (
            <Card key={item.id} className="hover:shadow-sm transition-shadow">
              <CardContent className="pt-3 pb-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{item.productName}</p>
                    <p className="text-xs text-muted-foreground">{item.brand} · {item.category}</p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {item.isLocal && <Badge className="text-[10px] px-1.5 py-0 bg-green-100 text-green-700 border-green-200">🇳🇬 Local</Badge>}
                    {item.isSachet && <Badge className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-700 border-amber-200">Sachet</Badge>}
                    {item.isCustom && <Badge variant="outline" className="text-[10px] px-1.5 py-0">Custom</Badge>}
                  </div>
                </div>
                {item.subcategory && <p className="text-xs text-muted-foreground mb-1">{item.subcategory}</p>}
                {(item.variants as string[]).length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1">
                    {(item.variants as string[]).slice(0, 4).map((v: string) => (
                      <span key={v} className="text-[10px] bg-muted px-1.5 py-0.5 rounded">{v}</span>
                    ))}
                    {(item.variants as string[]).length > 4 && <span className="text-[10px] text-muted-foreground">+{(item.variants as string[]).length - 4}</span>}
                  </div>
                )}
                {(item.aliases as string[]).length > 0 && (
                  <p className="text-[10px] text-muted-foreground truncate">
                    Also: {(item.aliases as string[]).slice(0, 3).join(", ")}
                  </p>
                )}
                <div className="flex items-center gap-2 mt-2 pt-2 border-t">
                  <span className="text-[10px] text-muted-foreground">Unit: {item.typicalUnit}</span>
                  <CheckCircle className="w-3 h-3 text-emerald-500 ml-auto" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </DashboardLayout>
  );
}

