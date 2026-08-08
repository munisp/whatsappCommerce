/**
 * WaMenuBuilder — tenant WhatsApp menu editor (the buyer-facing text menu).
 *
 * Left panel edits the tenant's waMenu config (greeting, the 5 use cases with
 * enable/reorder/label, custom items, fallback). Right panel is a WhatsApp-style
 * phone preview rendered with the SAME pure renderer the server preview uses
 * (shared/waMenu.renderWaMenu), enriched with live catalog/order counts from
 * tenantConfig.previewWaMenu. Saving does a full-replace via
 * tenantConfig.setWaMenuConfig; backend zod errors (unknown id, order
 * collision, empty label, duplicate key) are surfaced inline.
 */
import { useEffect, useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useActiveTenant } from "@/contexts/TenantContext";
import {
  ArrowDown, ArrowUp, Loader2, Plus, RefreshCw, Save, Smartphone, Trash2, Undo2, AlertTriangle,
} from "lucide-react";
import {
  DEFAULT_WA_MENU,
  moveUseCase,
  renderWaMenu,
  sortUseCasesByOrder,
  waMenuConfigSchema,
  WA_USE_CASE_IDS,
  type WaMenuConfig,
  type WaMenuCustomItem,
  type WaUseCaseId,
} from "@shared/waMenu";

const USE_CASE_HINTS: Record<WaUseCaseId, string> = {
  shop: "Browse the catalog",
  track: "Order status lookups",
  support: "FAQ / help flow",
  booking: "Appointments",
  handoff: "Escalate to a human agent",
};

export default function WaMenuBuilder() {
  const { activeTenantId } = useActiveTenant();
  const tenantId = activeTenantId;
  const utils = trpc.useUtils();

  const { data: savedMenu, isLoading } = trpc.tenantConfig.getWaMenuConfig.useQuery(
    { tenantId },
    { enabled: !!tenantId },
  );
  const {
    data: preview,
    isFetching: previewFetching,
    refetch: refetchPreview,
  } = trpc.tenantConfig.previewWaMenu.useQuery({ tenantId }, { enabled: !!tenantId });

  const [draft, setDraft] = useState<WaMenuConfig | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset the draft whenever the tenant or the saved config changes.
  useEffect(() => {
    setDraft(savedMenu ? (JSON.parse(JSON.stringify(savedMenu)) as WaMenuConfig) : null);
    setSaveError(null);
  }, [savedMenu, tenantId]);

  const dirty = useMemo(
    () => !!draft && !!savedMenu && JSON.stringify(draft) !== JSON.stringify(savedMenu),
    [draft, savedMenu],
  );

  // Unsaved-changes guard for tab close / hard navigation.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty], );

  const saveMutation = trpc.tenantConfig.setWaMenuConfig.useMutation({
    onSuccess: () => {
      setSaveError(null);
      toast.success("Menu saved — live preview updated");
      utils.tenantConfig.getWaMenuConfig.invalidate({ tenantId });
      utils.tenantConfig.previewWaMenu.invalidate({ tenantId });
    },
    onError: (e) => setSaveError(e.message),
  });

  const menu = draft ?? savedMenu ?? null;

  // Client-side contract check mirrors the backend zod schema so the operator
  // sees contract violations (empty label, order collision, …) before saving.
  const localIssues = useMemo(() => {
    if (!menu) return [];
    const res = waMenuConfigSchema.safeParse(menu);
    if (res.success) return [];
    return res.error.issues.map((i) => i.message);
  }, [menu]);

  const previewText = useMemo(() => {
    if (!menu) return "";
    // Render the DRAFT with the same renderer as the server, enriched with the
    // live counts from the last server preview.
    const live = preview?.data;
    return renderWaMenu(menu, {
      businessName: live?.businessName ?? "your store",
      shopItemCount: live?.shopItemCount,
      topProducts: live?.topProducts,
      openOrderCount: live?.openOrderCount,
    });
  }, [menu, preview]);

  const patchDraft = (patch: Partial<WaMenuConfig>) => {
    if (!menu) return;
    setDraft({ ...menu, ...patch });
    setSaveError(null);
  };

  const patchUseCase = (id: WaUseCaseId, patch: Partial<{ label: string; enabled: boolean }>) => {
    if (!menu) return;
    patchDraft({
      useCases: menu.useCases.map((u) => (u.id === id ? { ...u, ...patch } : u)),
    });
  };

  const move = (id: WaUseCaseId, direction: "up" | "down") => {
    if (!menu) return;
    patchDraft({ useCases: moveUseCase(menu.useCases, id, direction) });
  };

  // ── Custom item add/edit dialog state ──────────────────────────────────────
  const [itemDialogOpen, setItemDialogOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [itemForm, setItemForm] = useState<WaMenuCustomItem>({ key: "", label: "", response: "" });

  const openAddItem = () => {
    setEditingKey(null);
    setItemForm({ key: "", label: "", response: "" });
    setItemDialogOpen(true);
  };
  const openEditItem = (item: WaMenuCustomItem) => {
    setEditingKey(item.key);
    setItemForm({ ...item });
    setItemDialogOpen(true);
  };
  const saveItem = () => {
    if (!menu) return;
    const key = itemForm.key.trim();
    const label = itemForm.label.trim();
    const response = itemForm.response;
    if (!editingKey && menu.customItems.some((i) => i.key === key)) {
      toast.error(`custom item "${key}" already exists`);
      return;
    }
    const next: WaMenuCustomItem = { key, label, response };
    const customItems = editingKey
      ? menu.customItems.map((i) => (i.key === editingKey ? next : i))
      : [...menu.customItems, next];
    patchDraft({ customItems });
    setItemDialogOpen(false);
  };
  const removeItem = (key: string) => {
    if (!menu) return;
    patchDraft({ customItems: menu.customItems.filter((i) => i.key !== key) });
  };

  const handleSave = () => {
    if (!menu) return;
    if (localIssues.length > 0) {
      setSaveError(localIssues.join("; "));
      return;
    }
    saveMutation.mutate({ tenantId, config: menu });
  };

  const handleReset = () => {
    if (!savedMenu) return;
    setDraft(JSON.parse(JSON.stringify(savedMenu)) as WaMenuConfig);
    setSaveError(null);
  };

  const sortedUseCases = menu ? sortUseCasesByOrder(menu.useCases) : [];
  const allIdsPresent = menu && WA_USE_CASE_IDS.every((id) => menu.useCases.some((u) => u.id === id));

  return (
    <DashboardLayout>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Smartphone className="w-6 h-6 text-primary" />
              WhatsApp Menu Builder
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Edit the text menu buyers see when they message your WhatsApp number.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {dirty && <Badge variant="outline" className="border-amber-500/40 text-amber-400">Unsaved changes</Badge>}
            <Button variant="outline" size="sm" onClick={handleReset} disabled={!dirty || saveMutation.isPending}>
              <Undo2 className="w-4 h-4 mr-1" /> Reset
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!dirty || saveMutation.isPending || localIssues.length > 0}
            >
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
              Save menu
            </Button>
          </div>
        </div>

        {saveError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Could not save menu</AlertTitle>
            <AlertDescription className="whitespace-pre-wrap">{saveError}</AlertDescription>
          </Alert>
        )}
        {!saveError && localIssues.length > 0 && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Menu contract violations</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {localIssues.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {isLoading || !menu ? (
          <div className="flex items-center gap-2 text-muted-foreground py-16 justify-center">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading menu configuration…
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-6 items-start">
            {/* ── Left: editor ─────────────────────────────────────────── */}
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Greeting</CardTitle>
                  <CardDescription>
                    First line of the menu. Use {"{businessName}"} to insert your store name.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Textarea
                    value={menu.greeting}
                    onChange={(e) => patchDraft({ greeting: e.target.value })}
                    rows={2}
                    maxLength={500}
                    className={menu.greeting.trim() === "" ? "border-destructive" : ""}
                  />
                  {menu.greeting.trim() === "" && (
                    <p className="text-xs text-destructive mt-1">greeting must not be empty</p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Use cases</CardTitle>
                  <CardDescription>
                    Toggle, rename and reorder the five built-in flows. Disabled entries stay
                    configured but are hidden from buyers.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {sortedUseCases.map((uc, idx) => (
                    <div
                      key={uc.id}
                      className={`flex items-center gap-3 rounded-lg border p-3 ${uc.enabled ? "" : "opacity-60"}`}
                    >
                      <div className="flex flex-col">
                        <Button
                          variant="ghost" size="icon" className="h-6 w-6"
                          disabled={idx === 0}
                          onClick={() => move(uc.id, "up")}
                          aria-label={`Move ${uc.id} up`}
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost" size="icon" className="h-6 w-6"
                          disabled={idx === sortedUseCases.length - 1}
                          onClick={() => move(uc.id, "down")}
                          aria-label={`Move ${uc.id} down`}
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className="flex-1 min-w-0">
                        <Input
                          value={uc.label}
                          maxLength={60}
                          onChange={(e) => patchUseCase(uc.id, { label: e.target.value })}
                          className={`h-8 ${uc.label.trim() === "" ? "border-destructive" : ""}`}
                        />
                        <p className="text-[11px] text-muted-foreground mt-1">
                          <span className="font-mono">{uc.id}</span> · {USE_CASE_HINTS[uc.id]}
                        </p>
                      </div>
                      <Switch
                        checked={uc.enabled}
                        onCheckedChange={(v) => patchUseCase(uc.id, { enabled: v })}
                        aria-label={`Enable ${uc.id}`}
                      />
                    </div>
                  ))}
                  {!allIdsPresent && (
                    <p className="text-xs text-destructive">
                      The saved menu is missing built-in use cases; saving will restore the full set validation.
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <div>
                    <CardTitle className="text-base">Custom items</CardTitle>
                    <CardDescription>
                      Extra numbered entries with a fixed auto-reply (max 20).
                    </CardDescription>
                  </div>
                  <Button size="sm" variant="outline" onClick={openAddItem} disabled={menu.customItems.length >= 20}>
                    <Plus className="w-4 h-4 mr-1" /> Add item
                  </Button>
                </CardHeader>
                <CardContent className="space-y-2">
                  {menu.customItems.length === 0 && (
                    <p className="text-sm text-muted-foreground">No custom items yet.</p>
                  )}
                  {menu.customItems.map((item) => (
                    <div key={item.key} className="flex items-start gap-3 rounded-lg border p-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{item.label}</span>
                          <Badge variant="secondary" className="font-mono text-[10px]">{item.key}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2 whitespace-pre-wrap">
                          {item.response}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => openEditItem(item)}>Edit</Button>
                      <Button
                        variant="ghost" size="icon" className="text-destructive"
                        onClick={() => removeItem(item.key)}
                        aria-label={`Remove ${item.key}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Fallback</CardTitle>
                  <CardDescription>
                    What happens when a buyer replies with something that is not a menu number.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Select
                    value={menu.fallback}
                    onValueChange={(v) => patchDraft({ fallback: v as WaMenuConfig["fallback"] })}
                  >
                    <SelectTrigger className="w-full max-w-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="nlp">AI assistant (NLP) handles free text</SelectItem>
                      <SelectItem value="menu">Re-send the menu</SelectItem>
                    </SelectContent>
                  </Select>
                </CardContent>
              </Card>
            </div>

            {/* ── Right: phone preview ─────────────────────────────────── */}
            <div className="xl:sticky xl:top-6">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <div>
                    <CardTitle className="text-base">Live preview</CardTitle>
                    <CardDescription>
                      {dirty
                        ? "Showing your unsaved draft with live catalog/order counts."
                        : "Exactly what buyers receive, from the saved config + live data."}
                    </CardDescription>
                  </div>
                  <Button
                    variant="ghost" size="icon"
                    onClick={() => refetchPreview()}
                    disabled={previewFetching}
                    aria-label="Refresh live data"
                  >
                    {previewFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  </Button>
                </CardHeader>
                <CardContent className="flex flex-col items-center">
                  <div className="relative w-[280px] bg-zinc-900 rounded-[2.5rem] border-4 border-zinc-700 shadow-2xl overflow-hidden">
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-24 h-6 bg-zinc-900 rounded-b-2xl z-10" />
                    <div className="bg-[#0b141a] min-h-[480px] pt-8 pb-4 flex flex-col">
                      {/* WhatsApp header */}
                      <div className="bg-[#1f2c34] px-3 py-2 flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-primary/30 flex items-center justify-center text-xs font-bold text-white">
                          {(preview?.data.businessName ?? "S")[0]?.toUpperCase()}
                        </div>
                        <div>
                          <div className="text-white text-xs font-semibold truncate max-w-[160px]">
                            {preview?.data.businessName ?? "Your store"}
                          </div>
                          <div className="text-white/60 text-[10px]">online</div>
                        </div>
                      </div>
                      {/* Chat area */}
                      <div className="flex-1 px-2 py-3 space-y-2 overflow-y-auto">
                        <div className="flex justify-end">
                          <div className="bg-[#005c4b] rounded-xl rounded-tr-none px-3 py-2 max-w-[85%]">
                            <p className="text-white text-[11px]">Hi</p>
                            <p className="text-white/40 text-[9px] text-right mt-0.5">10:30 ✓✓</p>
                          </div>
                        </div>
                        <div className="flex justify-start">
                          <div className="bg-[#1f2c34] rounded-xl rounded-tl-none px-3 py-2 max-w-[92%]">
                            <p className="text-white text-[11px] whitespace-pre-wrap font-mono leading-relaxed">
                              {previewText}
                            </p>
                            <p className="text-white/40 text-[9px] text-right mt-1">10:30</p>
                          </div>
                        </div>
                        <div className="flex justify-start">
                          <div className="bg-[#1f2c34]/60 rounded-xl px-3 py-1.5 max-w-[92%]">
                            <p className="text-white/50 text-[10px] italic">
                              {menu.fallback === "nlp"
                                ? "Unrecognized replies go to the AI assistant."
                                : "Unrecognized replies re-send this menu."}
                            </p>
                          </div>
                        </div>
                      </div>
                      {/* Input bar */}
                      <div className="px-2 pt-2">
                        <div className="bg-[#1f2c34] rounded-full px-3 py-2 text-white/40 text-[11px]">
                          Message
                        </div>
                      </div>
                    </div>
                  </div>
                  {preview?.text && (
                    <>
                      <Separator className="my-4" />
                      <details className="w-full text-xs text-muted-foreground">
                        <summary className="cursor-pointer">Last saved server render</summary>
                        <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-[11px]">
                          {preview.text}
                        </pre>
                      </details>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* ── Custom item dialog ─────────────────────────────────────────── */}
        <Dialog open={itemDialogOpen} onOpenChange={setItemDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingKey ? "Edit custom item" : "Add custom item"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="ci-key">Key</Label>
                <Input
                  id="ci-key"
                  value={itemForm.key}
                  disabled={!!editingKey}
                  placeholder="opening_hours"
                  onChange={(e) => setItemForm((f) => ({ ...f, key: e.target.value }))}
                />
                <p className="text-[11px] text-muted-foreground">
                  lowercase alphanumeric with - or _ (stable identifier)
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ci-label">Menu label</Label>
                <Input
                  id="ci-label"
                  value={itemForm.label}
                  maxLength={60}
                  placeholder="Opening hours"
                  onChange={(e) => setItemForm((f) => ({ ...f, label: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ci-response">Auto-reply</Label>
                <Textarea
                  id="ci-response"
                  value={itemForm.response}
                  rows={4}
                  maxLength={1000}
                  placeholder="We are open Mon–Sat, 9:00–18:00."
                  onChange={(e) => setItemForm((f) => ({ ...f, response: e.target.value }))}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setItemDialogOpen(false)}>Cancel</Button>
              <Button
                onClick={saveItem}
                disabled={!itemForm.key.trim() || !itemForm.label.trim() || !itemForm.response.trim()}
              >
                {editingKey ? "Update item" : "Add item"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
