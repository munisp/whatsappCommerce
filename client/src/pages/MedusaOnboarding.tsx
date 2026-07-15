import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ShoppingBag,
  Plus,
  Trash2,
  Upload,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Package,
  Tag,
  Globe,
  ArrowRight,
  Send,
} from "lucide-react";
import { toast } from "sonner";

interface ProductDraft {
  id: string;
  title: string;
  description: string;
  price: string;
  currency: string;
  sku: string;
  category: string;
  stock: string;
  imageUrl: string;
}

function emptyDraft(): ProductDraft {
  return {
    id: crypto.randomUUID(),
    title: "",
    description: "",
    price: "",
    currency: "USD",
    sku: "",
    category: "",
    stock: "0",
    imageUrl: "",
  };
}

export default function MedusaOnboarding() {
  const [drafts, setDrafts] = useState<ProductDraft[]>([emptyDraft()]);
  const [submitting, setSubmitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // tRPC procedures
  const { data: queueData, refetch: refetchQueue } = trpc.medusaOnboarding.list.useQuery();
  const { data: statsData } = trpc.medusaOnboarding.stats.useQuery();
  const addProductMutation = trpc.medusaOnboarding.addProduct.useMutation();
  const pushToMedusaMutation = trpc.medusaOnboarding.pushToMedusa.useMutation();
  const removeMutation = trpc.medusaOnboarding.remove.useMutation();

  const updateDraft = (id: string, field: keyof ProductDraft, value: string) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, [field]: value } : d)));
  };

  const removeDraft = (id: string) => {
    if (drafts.length === 1) return;
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  };

  const addDraft = () => setDrafts((prev) => [...prev, emptyDraft()]);

  const handleAddToQueue = async () => {
    const valid = drafts.filter((d) => d.title.trim() && d.price && Number(d.price) > 0);
    if (valid.length === 0) {
      toast.error("Please fill in at least one product with a title and price.");
      return;
    }
    setSubmitting(true);
    let succeeded = 0;
    try {
      for (const d of valid) {
        await addProductMutation.mutateAsync({
          title: d.title.trim(),
          description: d.description.trim() || undefined,
          price: Number(d.price),
          currency: d.currency || "USD",
          sku: d.sku.trim() || undefined,
          stockQuantity: Number(d.stock) || 0,
          images: d.imageUrl.trim() ? [d.imageUrl.trim()] : undefined,
          categories: d.category.trim() ? [d.category.trim()] : undefined,
        });
        succeeded++;
      }
      toast.success(`${succeeded} product(s) added to onboarding queue!`);
      setDrafts([emptyDraft()]);
      refetchQueue();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to add products");
    } finally {
      setSubmitting(false);
    }
  };

  const handlePushToMedusa = async () => {
    if (selectedIds.length === 0) {
      toast.error("Select products to push to Medusa.");
      return;
    }
    setPushing(true);
    try {
      const res = await pushToMedusaMutation.mutateAsync({ ids: selectedIds });
      const pushed = (res as { pushed?: number }).pushed ?? 0;
      toast.success(`${pushed} product(s) pushed to Medusa!`);
      setSelectedIds([]);
      refetchQueue();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Push failed";
      toast.error(msg.includes("not configured") ? "Medusa credentials not set. Add MEDUSA_BASE_URL and MEDUSA_API_KEY in Secrets." : msg);
    } finally {
      setPushing(false);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await removeMutation.mutateAsync({ id });
      refetchQueue();
      toast.success("Removed from queue");
    } catch {
      toast.error("Failed to remove");
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const queueItems = queueData?.items ?? [];
  const stats = statsData as { total?: number; synced?: number; draft?: number; failed?: number } | undefined;

  return (
    <DashboardLayout>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <ShoppingBag className="w-6 h-6 text-indigo-600" />
              Medusa Product Onboarding
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Add your products and services to your Medusa v2 store via the Admin API
            </p>
          </div>
        </div>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: "Total", value: stats.total ?? 0, color: "text-foreground" },
              { label: "Synced", value: stats.synced ?? 0, color: "text-emerald-600" },
              { label: "Draft", value: stats.draft ?? 0, color: "text-amber-600" },
              { label: "Failed", value: stats.failed ?? 0, color: "text-red-500" },
            ].map((s) => (
              <Card key={s.label}>
                <CardContent className="pt-4 text-center">
                  <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Product form */}
          <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Add Products</h2>
              <Button variant="outline" size="sm" onClick={addDraft} className="gap-1">
                <Plus className="w-4 h-4" /> Add Row
              </Button>
            </div>

            {drafts.map((draft, idx) => (
              <Card key={draft.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-medium text-muted-foreground">
                      Product #{idx + 1}
                    </CardTitle>
                    {drafts.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeDraft(draft.id)}
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <Label>Product Title *</Label>
                      <Input
                        placeholder="e.g. Coca-Cola 500ml"
                        value={draft.title}
                        onChange={(e) => updateDraft(draft.id, "title", e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Price *</Label>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        value={draft.price}
                        onChange={(e) => updateDraft(draft.id, "price", e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Currency</Label>
                      <select
                        value={draft.currency}
                        onChange={(e) => updateDraft(draft.id, "currency", e.target.value)}
                        className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                      >
                        {["USD", "EUR", "GBP", "NGN", "KES", "GHS", "ZAR", "XOF"].map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label>SKU</Label>
                      <Input
                        placeholder="e.g. COKE-500ML"
                        value={draft.sku}
                        onChange={(e) => updateDraft(draft.id, "sku", e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Category</Label>
                      <Input
                        placeholder="e.g. Beverages"
                        value={draft.category}
                        onChange={(e) => updateDraft(draft.id, "category", e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Initial Stock</Label>
                      <Input
                        type="number"
                        min="0"
                        value={draft.stock}
                        onChange={(e) => updateDraft(draft.id, "stock", e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Image URL</Label>
                      <Input
                        placeholder="https://..."
                        value={draft.imageUrl}
                        onChange={(e) => updateDraft(draft.id, "imageUrl", e.target.value)}
                      />
                    </div>
                    <div className="col-span-2">
                      <Label>Description</Label>
                      <Textarea
                        placeholder="Product description..."
                        value={draft.description}
                        onChange={(e) => updateDraft(draft.id, "description", e.target.value)}
                        rows={2}
                        className="text-sm"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}

            <Button
              onClick={handleAddToQueue}
              disabled={submitting}
              className="w-full gap-2 bg-indigo-600 hover:bg-indigo-700"
            >
              {submitting ? (
                <><RefreshCw className="w-4 h-4 animate-spin" /> Adding to queue…</>
              ) : (
                <><Upload className="w-4 h-4" /> Add to Onboarding Queue</>
              )}
            </Button>
          </div>

          {/* Right: Queue */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Package className="w-4 h-4" /> Onboarding Queue
                  </CardTitle>
                  {selectedIds.length > 0 && (
                    <Button
                      size="sm"
                      onClick={handlePushToMedusa}
                      disabled={pushing}
                      className="h-7 text-xs gap-1 bg-indigo-600 hover:bg-indigo-700"
                    >
                      {pushing ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                      Push {selectedIds.length}
                    </Button>
                  )}
                </div>
                <CardDescription className="text-xs">
                  Select items and click Push to sync to Medusa
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {queueItems.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-4">
                      Queue is empty. Add products above.
                    </p>
                  ) : (
                    (queueItems as Array<{ id: string; title: string; price: string; currency: string; status: string; medusaProductId?: string | null }>).map((item) => (
                      <div
                        key={item.id}
                        className={`p-2 rounded-lg border cursor-pointer transition-colors ${
                          selectedIds.includes(item.id)
                            ? "border-indigo-400 bg-indigo-50/50 dark:bg-indigo-950/20"
                            : "border-transparent bg-muted/50 hover:bg-muted"
                        }`}
                        onClick={() => item.status !== "synced" && toggleSelect(item.id)}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium truncate">{item.title}</p>
                          <div className="flex items-center gap-1 shrink-0">
                            <Badge
                              variant={
                                item.status === "synced"
                                  ? "default"
                                  : item.status === "failed"
                                  ? "destructive"
                                  : "secondary"
                              }
                              className="text-xs"
                            >
                              {item.status === "synced" ? <CheckCircle className="w-3 h-3" /> : item.status}
                            </Badge>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
                              onClick={(e) => { e.stopPropagation(); handleRemove(item.id); }}
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {item.currency} {item.price}
                          {item.medusaProductId && <span className="ml-2 text-emerald-600">✓ In Medusa</span>}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>

            {/* How it works */}
            <Card className="bg-indigo-50/50 dark:bg-indigo-950/20 border-indigo-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">How It Works</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {[
                  "Add products to the queue",
                  "Select and push to Medusa v2",
                  "Medusa Admin API creates products",
                  "Available on WhatsApp storefront",
                  "Inventory synced via Odoo bridge",
                ].map((step, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="w-5 h-5 rounded-full bg-indigo-600 text-white flex items-center justify-center text-xs font-bold shrink-0">
                      {i + 1}
                    </span>
                    <span>{step}</span>
                    {i < 4 && <ArrowRight className="w-3 h-3 text-muted-foreground ml-auto" />}
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
