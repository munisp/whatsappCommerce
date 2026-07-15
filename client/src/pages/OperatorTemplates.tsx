import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Plus, Search, Edit2, Trash2, ToggleLeft, ToggleRight, FileCode, Eye } from "lucide-react";

type Category = "transactional" | "marketing" | "utility" | "authentication" | "custom";

const CATEGORIES: Category[] = ["transactional", "marketing", "utility", "authentication", "custom"];

const CATEGORY_COLORS: Record<Category, string> = {
  transactional: "bg-blue-100 text-blue-700",
  marketing: "bg-purple-100 text-purple-700",
  utility: "bg-amber-100 text-amber-700",
  authentication: "bg-green-100 text-green-700",
  custom: "bg-gray-100 text-gray-700",
};

interface TemplateFormData {
  name: string;
  category: Category;
  language: string;
  headerText: string;
  bodyText: string;
  footerText: string;
  variables: string; // comma-separated
  isActive: boolean;
  description: string;
}

const defaultForm: TemplateFormData = {
  name: "",
  category: "transactional",
  language: "en",
  headerText: "",
  bodyText: "",
  footerText: "",
  variables: "",
  isActive: true,
  description: "",
};

export default function OperatorTemplates() {
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"all" | Category>("all");
  const [page, setPage] = useState(1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<TemplateFormData>(defaultForm);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<{ name: string; bodyText: string; headerText?: string | null; footerText?: string | null } | null>(null);

  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.operatorTemplates.list.useQuery({
    search: search || undefined,
    category: categoryFilter,
    page,
    pageSize: 15,
  });

  const createMutation = trpc.operatorTemplates.create.useMutation({
    onSuccess: () => {
      toast.success("Template created");
      setShowForm(false);
      setForm(defaultForm);
      utils.operatorTemplates.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const updateMutation = trpc.operatorTemplates.update.useMutation({
    onSuccess: () => {
      toast.success("Template updated");
      setShowForm(false);
      setEditingId(null);
      setForm(defaultForm);
      utils.operatorTemplates.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const toggleMutation = trpc.operatorTemplates.toggleActive.useMutation({
    onSuccess: (t) => {
      toast.success(`Template ${t.isActive ? "activated" : "deactivated"}`);
      utils.operatorTemplates.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteMutation = trpc.operatorTemplates.delete.useMutation({
    onSuccess: () => {
      toast.success("Template deleted");
      setDeleteId(null);
      utils.operatorTemplates.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  function openCreate() {
    setEditingId(null);
    setForm(defaultForm);
    setShowForm(true);
  }

  function openEdit(tmpl: typeof data extends { items: (infer T)[] } | undefined ? T : never) {
    setEditingId((tmpl as { id: string }).id);
    setForm({
      name: (tmpl as { name: string }).name,
      category: (tmpl as { category: Category }).category,
      language: (tmpl as { language: string }).language,
      headerText: (tmpl as { headerText?: string | null }).headerText ?? "",
      bodyText: (tmpl as { bodyText: string }).bodyText,
      footerText: (tmpl as { footerText?: string | null }).footerText ?? "",
      variables: ((tmpl as { variables?: string[] | null }).variables ?? []).join(", "),
      isActive: (tmpl as { isActive: boolean }).isActive,
      description: (tmpl as { description?: string | null }).description ?? "",
    });
    setShowForm(true);
  }

  function handleSubmit() {
    const payload = {
      name: form.name,
      category: form.category,
      language: form.language,
      headerText: form.headerText || undefined,
      bodyText: form.bodyText,
      footerText: form.footerText || undefined,
      variables: form.variables ? form.variables.split(",").map(v => v.trim()).filter(Boolean) : [],
      isActive: form.isActive,
      description: form.description || undefined,
    };
    if (editingId) {
      updateMutation.mutate({ id: editingId, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending;
  const totalPages = data ? Math.ceil(data.total / 15) : 1;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <FileCode className="h-6 w-6 text-primary" />
              Operator Message Templates
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Platform-level WhatsApp message templates available to all merchants.
            </p>
          </div>
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" />
            New Template
          </Button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search templates…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="pl-9"
            />
          </div>
          <Select value={categoryFilter} onValueChange={(v) => { setCategoryFilter(v as typeof categoryFilter); setPage(1); }}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {CATEGORIES.map(c => (
                <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">{data?.total ?? 0} templates</span>
        </div>

        {/* Template Grid */}
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-44" />)}
          </div>
        ) : (data?.items ?? []).length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <FileCode className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No templates found</p>
            <p className="text-sm mt-1">Create your first operator template to get started.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {(data?.items ?? []).map((tmpl) => (
              <Card key={tmpl.id} className={`transition-all ${!tmpl.isActive ? "opacity-60" : ""}`}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="text-sm font-semibold truncate">{tmpl.name}</CardTitle>
                      {tmpl.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{tmpl.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Badge className={`text-xs ${CATEGORY_COLORS[tmpl.category]}`} variant="outline">
                        {tmpl.category}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {tmpl.headerText && (
                    <p className="text-xs font-medium text-muted-foreground border-b pb-1">{tmpl.headerText}</p>
                  )}
                  <p className="text-sm line-clamp-3 whitespace-pre-wrap">{tmpl.bodyText}</p>
                  {tmpl.footerText && (
                    <p className="text-xs text-muted-foreground italic">{tmpl.footerText}</p>
                  )}
                  {tmpl.variables && (tmpl.variables as string[]).length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {(tmpl.variables as string[]).map((v, i) => (
                        <Badge key={i} variant="secondary" className="text-xs font-mono">{`{{${v}}}`}</Badge>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-1">
                      <Switch
                        checked={tmpl.isActive}
                        onCheckedChange={() => toggleMutation.mutate({ id: tmpl.id })}
                        disabled={toggleMutation.isPending}
                        aria-label="Toggle active"
                      />
                      <span className="text-xs text-muted-foreground">{tmpl.isActive ? "Active" : "Inactive"}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setPreviewTemplate(tmpl)}>
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(tmpl)}>
                        <Edit2 className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteId(tmpl.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
            <span className="text-sm text-muted-foreground">Page {page} of {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
          </div>
        )}
      </div>

      {/* Create / Edit Dialog */}
      <Dialog open={showForm} onOpenChange={(open) => { if (!open) { setShowForm(false); setEditingId(null); setForm(defaultForm); } }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Template" : "New Operator Template"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label>Template Name *</Label>
                <Input placeholder="e.g. order_confirmation_v1" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v as Category }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Language</Label>
                <Select value={form.language} onValueChange={v => setForm(f => ({ ...f, language: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">English</SelectItem>
                    <SelectItem value="ar">Arabic</SelectItem>
                    <SelectItem value="fr">French</SelectItem>
                    <SelectItem value="es">Spanish</SelectItem>
                    <SelectItem value="pt">Portuguese</SelectItem>
                    <SelectItem value="id">Indonesian</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>Header Text <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input placeholder="Short header line" value={form.headerText} onChange={e => setForm(f => ({ ...f, headerText: e.target.value }))} maxLength={255} />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>Body Text *</Label>
                <Textarea
                  placeholder="Hello {{name}}, your order {{order_id}} has been confirmed."
                  value={form.bodyText}
                  onChange={e => setForm(f => ({ ...f, bodyText: e.target.value }))}
                  rows={4}
                />
                <p className="text-xs text-muted-foreground">Use {"{{variable_name}}"} for dynamic values.</p>
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>Footer Text <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input placeholder="Reply STOP to unsubscribe" value={form.footerText} onChange={e => setForm(f => ({ ...f, footerText: e.target.value }))} maxLength={255} />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>Variables <span className="text-muted-foreground text-xs">(comma-separated)</span></Label>
                <Input placeholder="name, order_id, amount" value={form.variables} onChange={e => setForm(f => ({ ...f, variables: e.target.value }))} />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>Description <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input placeholder="Internal note about this template" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
              </div>
              <div className="col-span-2 flex items-center gap-3">
                <Switch checked={form.isActive} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} />
                <Label>Active (visible to merchants)</Label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowForm(false); setEditingId(null); setForm(defaultForm); }}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={isPending || !form.name || !form.bodyText}>
              {isPending ? "Saving…" : editingId ? "Update Template" : "Create Template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog */}
      <Dialog open={!!previewTemplate} onOpenChange={(open) => { if (!open) setPreviewTemplate(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-4 w-4" />
              Template Preview
            </DialogTitle>
          </DialogHeader>
          {previewTemplate && (
            <div className="bg-[#DCF8C6] rounded-xl p-4 space-y-1 shadow-sm max-w-xs mx-auto">
              {previewTemplate.headerText && (
                <p className="text-sm font-semibold text-gray-800">{previewTemplate.headerText}</p>
              )}
              <p className="text-sm text-gray-800 whitespace-pre-wrap">{previewTemplate.bodyText}</p>
              {previewTemplate.footerText && (
                <p className="text-xs text-gray-500 italic mt-1">{previewTemplate.footerText}</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Template</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the template. Merchants who have used it in campaigns will retain their copies. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => deleteId && deleteMutation.mutate({ id: deleteId })}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
}
