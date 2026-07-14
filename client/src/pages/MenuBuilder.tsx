import { useState, useMemo } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Plus, Trash2, Send, Zap, Eye, ChevronRight, ChevronDown,
  Smartphone, RefreshCw, CheckCircle2, Package, Users, Briefcase,
  MessageSquare, Globe, List, Loader2, LayoutGrid, ArrowUpDown,
  ShoppingBag, Edit3, X, Radio
} from "lucide-react";

type ItemType = "section" | "button" | "list_item" | "quick_reply" | "catalog_link" | "url";

interface MenuItem {
  id: string;
  parentId?: string | null;
  type: ItemType;
  title: string;
  description?: string | null;
  payload?: string | null;
  url?: string | null;
  sortOrder: number;
}

const TYPE_META: Record<ItemType, { label: string; icon: React.ElementType; color: string; waLabel: string }> = {
  section:      { label: "Section",       icon: LayoutGrid,   color: "text-blue-400",    waLabel: "Section Header" },
  list_item:    { label: "List Item",     icon: List,         color: "text-green-400",   waLabel: "Row" },
  quick_reply:  { label: "Quick Reply",   icon: Radio,        color: "text-primary",     waLabel: "Quick Reply" },
  button:       { label: "Button",        icon: MessageSquare,color: "text-yellow-400",  waLabel: "Button" },
  catalog_link: { label: "Catalog Link",  icon: ShoppingBag,  color: "text-orange-400",  waLabel: "Catalog" },
  url:          { label: "URL Link",      icon: Globe,        color: "text-purple-400",  waLabel: "URL" },
};

// ── Phone Preview Component ────────────────────────────────────────────────────
function PhonePreview({ menuName, items }: { menuName: string; items: MenuItem[] }) {
  const sections = items.filter(i => i.type === "section");
  const topItems = items.filter(i => !i.parentId && i.type !== "section");

  return (
    <div className="flex flex-col items-center">
      {/* Phone shell */}
      <div className="relative w-[260px] bg-zinc-900 rounded-[2.5rem] border-4 border-zinc-700 shadow-2xl overflow-hidden">
        {/* Notch */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-24 h-6 bg-zinc-900 rounded-b-2xl z-10" />
        {/* Screen */}
        <div className="bg-[#0a1929] min-h-[520px] pt-8 pb-4 flex flex-col">
          {/* WhatsApp header */}
          <div className="bg-[#128C7E] px-3 py-2 flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold text-white">
              {menuName[0]?.toUpperCase() ?? "M"}
            </div>
            <div>
              <div className="text-white text-xs font-semibold">{menuName || "My Store"}</div>
              <div className="text-white/70 text-[10px]">online</div>
            </div>
          </div>

          {/* Chat area */}
          <div className="flex-1 px-2 py-3 space-y-2 overflow-y-auto">
            {/* Incoming message */}
            <div className="flex justify-start">
              <div className="bg-[#1f2c34] rounded-xl rounded-tl-none px-3 py-2 max-w-[85%]">
                <p className="text-white text-[11px]">Hello! 👋 How can I help you today?</p>
                <p className="text-white/40 text-[9px] text-right mt-1">10:30 AM</p>
              </div>
            </div>

            {/* Interactive list message */}
            <div className="flex justify-start">
              <div className="bg-[#1f2c34] rounded-xl rounded-tl-none max-w-[90%] overflow-hidden">
                <div className="px-3 pt-2 pb-1">
                  <p className="text-white/80 text-[10px] font-semibold mb-1">Welcome! 👋</p>
                  <p className="text-white text-[11px]">Please select an option from the menu below:</p>
                </div>
                {sections.length > 0 ? (
                  <div className="border-t border-white/10 mt-1">
                    {sections.slice(0, 3).map(section => {
                      const children = items.filter(i => i.parentId === section.id).slice(0, 3);
                      return (
                        <div key={section.id} className="px-3 py-1.5">
                          <p className="text-[#128C7E] text-[9px] font-bold uppercase tracking-wide mb-1">{section.title}</p>
                          {children.map(child => (
                            <div key={child.id} className="flex items-center justify-between py-1 border-b border-white/5 last:border-0">
                              <div>
                                <p className="text-white text-[10px] font-medium">{child.title.slice(0, 20)}</p>
                                {child.description && <p className="text-white/50 text-[9px]">{child.description.slice(0, 30)}</p>}
                              </div>
                              <ChevronRight className="w-3 h-3 text-white/30 shrink-0" />
                            </div>
                          ))}
                        </div>
                      );
                    })}
                    <div className="border-t border-white/10 px-3 py-2">
                      <button className="w-full text-[#128C7E] text-[11px] font-semibold text-center">Open Menu ›</button>
                    </div>
                  </div>
                ) : topItems.length > 0 ? (
                  <div className="border-t border-white/10 px-3 py-2 space-y-1">
                    {topItems.slice(0, 4).map(item => (
                      <button key={item.id} className="w-full text-left text-[10px] text-[#128C7E] border border-[#128C7E]/30 rounded px-2 py-1">
                        {item.title}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="px-3 py-3 text-white/30 text-[10px] text-center">Add items to preview menu</div>
                )}
                <p className="text-white/40 text-[9px] text-right px-3 pb-2">10:31 AM</p>
              </div>
            </div>
          </div>

          {/* Input bar */}
          <div className="px-2 flex items-center gap-1">
            <div className="flex-1 bg-[#1f2c34] rounded-full px-3 py-1.5 text-white/30 text-[10px]">Message</div>
            <div className="w-7 h-7 rounded-full bg-[#128C7E] flex items-center justify-center">
              <Send className="w-3 h-3 text-white" />
            </div>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mt-3 text-center">Live WhatsApp Preview</p>
    </div>
  );
}

// ── Tree Item Component ────────────────────────────────────────────────────────
function TreeItem({
  item, children, onEdit, onDelete, onAddChild, depth = 0
}: {
  item: MenuItem;
  children?: MenuItem[];
  onEdit: (item: MenuItem) => void;
  onDelete: (id: string) => void;
  onAddChild: (parentId: string) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const meta = TYPE_META[item.type];
  const Icon = meta.icon;
  const hasChildren = (children?.length ?? 0) > 0;
  const isSection = item.type === "section";

  return (
    <div className={`${depth > 0 ? "ml-6 border-l border-border pl-3" : ""}`}>
      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-muted/50 group transition-colors ${isSection ? "bg-muted/30 border border-border mb-1" : ""}`}>
        {isSection && (
          <button onClick={() => setExpanded(e => !e)} className="text-muted-foreground hover:text-foreground">
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        )}
        <Icon className={`w-4 h-4 shrink-0 ${meta.color}`} />
        <div className="flex-1 min-w-0">
          <span className={`text-sm font-medium truncate ${isSection ? "text-foreground" : "text-muted-foreground"}`}>{item.title}</span>
          {item.description && <span className="text-xs text-muted-foreground ml-2 truncate hidden md:inline">{item.description}</span>}
        </div>
        <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5 hidden group-hover:inline">{meta.waLabel}</span>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {isSection && (
            <button onClick={() => onAddChild(item.id)} className="p-1 hover:text-primary text-muted-foreground" title="Add child item">
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={() => onEdit(item)} className="p-1 hover:text-primary text-muted-foreground">
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => onDelete(item.id)} className="p-1 hover:text-red-400 text-muted-foreground">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {isSection && expanded && children && children.length > 0 && (
        <div className="mb-2">
          {children.map(child => (
            <TreeItem key={child.id} item={child} onEdit={onEdit} onDelete={onDelete} onAddChild={onAddChild} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function MenuBuilder() {
  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [newMenuName, setNewMenuName] = useState("");
  const [newMenuDesc, setNewMenuDesc] = useState("");
  const [editItemOpen, setEditItemOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Partial<MenuItem> | null>(null);
  const [editingParentId, setEditingParentId] = useState<string | null>(null);
  const [autoPopOpen, setAutoPopOpen] = useState(false);
  const [autoSources, setAutoSources] = useState({ odooProductsByCategory: true, odooOrderStatus: true, twentyDealStages: false, twentyContactList: false });
  const [pushOpen, setPushOpen] = useState(false);
  const [pushResult, setPushResult] = useState<{ payload: unknown; pushedAt: Date; itemCount: number } | null>(null);

  const utils = trpc.useUtils();
  const { data: menus = [], refetch: refetchMenus } = trpc.menu.list.useQuery();
  const { data: menuDetail, refetch: refetchDetail } = trpc.menu.get.useQuery(
    { menuId: selectedMenuId! },
    { enabled: !!selectedMenuId }
  );
  const { data: dataSources } = trpc.menu.getDataSources.useQuery();

  const createMenu = trpc.menu.create.useMutation({
    onSuccess: (d) => { toast.success("Menu created"); setSelectedMenuId(d.id); refetchMenus(); setCreateMenuOpen(false); setNewMenuName(""); setNewMenuDesc(""); },
    onError: (e) => toast.error(e.message),
  });
  const deleteMenu = trpc.menu.delete.useMutation({
    onSuccess: () => { toast.success("Menu deleted"); setSelectedMenuId(null); refetchMenus(); },
    onError: (e) => toast.error(e.message),
  });
  const addItem = trpc.menu.addItem.useMutation({
    onSuccess: () => { refetchDetail(); setEditItemOpen(false); setEditingItem(null); },
    onError: (e) => toast.error(e.message),
  });
  const updateItem = trpc.menu.updateItem.useMutation({
    onSuccess: () => { refetchDetail(); setEditItemOpen(false); setEditingItem(null); },
    onError: (e) => toast.error(e.message),
  });
  const deleteItem = trpc.menu.deleteItem.useMutation({
    onSuccess: () => { refetchDetail(); toast.success("Item removed"); },
    onError: (e) => toast.error(e.message),
  });
  const autoPopulate = trpc.menu.autoPopulate.useMutation({
    onSuccess: (d) => { toast.success(`Auto-populated ${d.itemsCreated} items from Odoo & Twenty`); refetchDetail(); setAutoPopOpen(false); },
    onError: (e) => toast.error(e.message),
  });
  const pushToWhatsApp = trpc.menu.pushToWhatsApp.useMutation({
    onSuccess: (d) => { toast.success(`Menu pushed to WhatsApp! ${d.itemCount} items sent`); setPushResult({ payload: d.payload, pushedAt: new Date(d.pushedAt), itemCount: d.itemCount }); setPushOpen(true); refetchDetail(); refetchMenus(); },
    onError: (e) => toast.error(e.message),
  });
  const publish = trpc.menu.publish.useMutation({
    onSuccess: () => { toast.success("Menu published"); refetchDetail(); refetchMenus(); },
    onError: (e) => toast.error(e.message),
  });

  const currentMenu = menuDetail?.menu;
  const items: MenuItem[] = (menuDetail?.items ?? []) as MenuItem[];
  const topLevelItems = items.filter(i => !i.parentId);
  const childrenOf = (parentId: string) => items.filter(i => i.parentId === parentId);

  function openAddItem(parentId?: string) {
    setEditingParentId(parentId ?? null);
    setEditingItem({ type: "list_item", title: "", description: "", payload: "", sortOrder: items.length });
    setEditItemOpen(true);
  }
  function openEditItem(item: MenuItem) {
    setEditingParentId(item.parentId ?? null);
    setEditingItem({ ...item });
    setEditItemOpen(true);
  }
  function saveItem() {
    if (!editingItem || !selectedMenuId) return;
    const payload = {
      parentId: editingParentId,
      type: editingItem.type as ItemType,
      title: editingItem.title ?? "",
      description: editingItem.description ?? undefined,
      payload: editingItem.payload ?? undefined,
      url: editingItem.url ?? undefined,
      sortOrder: editingItem.sortOrder ?? 0,
    };
    if (editingItem.id) {
      updateItem.mutate({ itemId: editingItem.id, item: payload });
    } else {
      addItem.mutate({ menuId: selectedMenuId, item: payload });
    }
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/20 border border-primary/30 flex items-center justify-center">
              <Smartphone className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">WhatsApp Menu Builder</h1>
              <p className="text-sm text-muted-foreground">Build interactive menus from Odoo inventory & Twenty CRM, then push to WhatsApp</p>
            </div>
          </div>
          <Button className="bg-primary text-primary-foreground gap-2" onClick={() => setCreateMenuOpen(true)}>
            <Plus className="w-4 h-4" /> New Menu
          </Button>
        </div>

        {/* Data source badges */}
        <div className="flex flex-wrap gap-2">
          <div className="flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-1.5 text-xs text-orange-400">
            <Package className="w-3.5 h-3.5" />
            <span>{dataSources?.odooProducts?.length ?? 0} Odoo Products</span>
          </div>
          <div className="flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-1.5 text-xs text-orange-400">
            <ShoppingBag className="w-3.5 h-3.5" />
            <span>{dataSources?.odooCategories?.length ?? 0} Categories</span>
          </div>
          <div className="flex items-center gap-2 bg-violet-500/10 border border-violet-500/20 rounded-lg px-3 py-1.5 text-xs text-violet-400">
            <Users className="w-3.5 h-3.5" />
            <span>{dataSources?.twentyContacts?.length ?? 0} Twenty Contacts</span>
          </div>
          <div className="flex items-center gap-2 bg-violet-500/10 border border-violet-500/20 rounded-lg px-3 py-1.5 text-xs text-violet-400">
            <Briefcase className="w-3.5 h-3.5" />
            <span>{dataSources?.twentyDeals?.length ?? 0} Deals</span>
          </div>
          {(dataSources?.odooProducts?.length ?? 0) === 0 && (
            <div className="flex items-center gap-2 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-1.5 text-xs text-yellow-400">
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Sync Odoo & Twenty first to enable auto-populate</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* ── Menu List Sidebar ── */}
          <div className="lg:col-span-3">
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Menus ({menus.length})</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {menus.length === 0 ? (
                  <div className="p-4 text-center text-muted-foreground text-xs">
                    <Smartphone className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    No menus yet. Create one!
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {menus.map(m => (
                      <button
                        key={m.id}
                        onClick={() => setSelectedMenuId(m.id)}
                        className={`w-full text-left px-3 py-3 hover:bg-muted/50 transition-colors ${selectedMenuId === m.id ? "bg-primary/10 border-l-2 border-primary" : ""}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium truncate">{m.name}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${m.status === "published" ? "bg-green-500/20 text-green-400 border-green-500/30" : "bg-zinc-500/20 text-zinc-400 border-zinc-500/30"}`}>
                            {m.status}
                          </span>
                        </div>
                        {m.pushStatus === "success" && m.lastPushedAt && (
                          <div className="text-[10px] text-primary mt-0.5 flex items-center gap-1">
                            <CheckCircle2 className="w-2.5 h-2.5" /> Pushed {new Date(m.lastPushedAt).toLocaleDateString()}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Tree Editor ── */}
          <div className="lg:col-span-5">
            {!selectedMenuId ? (
              <Card className="bg-card border-border h-full flex items-center justify-center min-h-[400px]">
                <div className="text-center text-muted-foreground p-8">
                  <Smartphone className="w-12 h-12 mx-auto mb-3 opacity-20" />
                  <p className="font-medium">Select or create a menu</p>
                  <p className="text-xs mt-1">Choose from the list or click New Menu</p>
                </div>
              </Card>
            ) : (
              <Card className="bg-card border-border">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">{currentMenu?.name ?? "Loading..."}</CardTitle>
                      <CardDescription className="text-xs mt-0.5">{items.length} items</CardDescription>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" className="gap-1.5 border-border text-xs h-8" onClick={() => setAutoPopOpen(true)}>
                        <Zap className="w-3.5 h-3.5 text-yellow-400" /> Auto-Populate
                      </Button>
                      <Button variant="outline" size="sm" className="gap-1.5 border-border text-xs h-8" onClick={() => openAddItem()}>
                        <Plus className="w-3.5 h-3.5" /> Add
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-1 max-h-[500px] overflow-y-auto">
                  {items.length === 0 ? (
                    <div className="py-8 text-center text-muted-foreground text-sm">
                      <List className="w-10 h-10 mx-auto mb-2 opacity-20" />
                      <p>No items yet.</p>
                      <p className="text-xs mt-1">Use Auto-Populate to pull from Odoo & Twenty, or add items manually.</p>
                    </div>
                  ) : (
                    topLevelItems.map(item => (
                      <TreeItem
                        key={item.id}
                        item={item}
                        children={childrenOf(item.id)}
                        onEdit={openEditItem}
                        onDelete={(id) => deleteItem.mutate({ itemId: id })}
                        onAddChild={(parentId) => openAddItem(parentId)}
                      />
                    ))
                  )}
                </CardContent>
                {/* Action bar */}
                <div className="border-t border-border px-4 py-3 flex gap-2">
                  <Button variant="outline" size="sm" className="border-border gap-1.5 text-xs"
                    onClick={() => selectedMenuId && publish.mutate({ menuId: selectedMenuId })} disabled={publish.isPending}>
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-400" /> Publish
                  </Button>
                  <Button size="sm" className="flex-1 bg-primary text-primary-foreground gap-1.5 text-xs"
                    onClick={() => selectedMenuId && pushToWhatsApp.mutate({ menuId: selectedMenuId })} disabled={pushToWhatsApp.isPending || items.length === 0}>
                    {pushToWhatsApp.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    Push to WhatsApp
                  </Button>
                  <Button variant="outline" size="sm" className="border-red-500/30 text-red-400 hover:bg-red-500/10 text-xs"
                    onClick={() => selectedMenuId && deleteMenu.mutate({ menuId: selectedMenuId })}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </Card>
            )}
          </div>

          {/* ── Phone Preview ── */}
          <div className="lg:col-span-4 flex justify-center">
            <PhonePreview menuName={currentMenu?.name ?? "My Store"} items={items} />
          </div>
        </div>
      </div>

      {/* ── Create Menu Dialog ── */}
      <Dialog open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
        <DialogContent className="bg-card border-border max-w-sm">
          <DialogHeader><DialogTitle>Create New Menu</DialogTitle></DialogHeader>
          <div className="space-y-3 pt-2">
            <div className="space-y-1.5">
              <Label>Menu Name</Label>
              <Input value={newMenuName} onChange={e => setNewMenuName(e.target.value)} placeholder="e.g. Main Store Menu" className="bg-background border-border" />
            </div>
            <div className="space-y-1.5">
              <Label>Description (optional)</Label>
              <Input value={newMenuDesc} onChange={e => setNewMenuDesc(e.target.value)} placeholder="Brief description" className="bg-background border-border" />
            </div>
            <Button className="w-full bg-primary text-primary-foreground" onClick={() => createMenu.mutate({ name: newMenuName, description: newMenuDesc })} disabled={!newMenuName.trim() || createMenu.isPending}>
              {createMenu.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null} Create Menu
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Auto-Populate Dialog ── */}
      <Dialog open={autoPopOpen} onOpenChange={setAutoPopOpen}>
        <DialogContent className="bg-card border-border max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-yellow-400" /> Auto-Populate from Data Sources
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <p className="text-sm text-muted-foreground">Select which data sources to pull menu items from. Existing items will be replaced.</p>
            <div className="space-y-3">
              {[
                { key: "odooProductsByCategory", label: "Odoo Products by Category", icon: Package, color: "text-orange-400", count: dataSources?.odooProducts?.length ?? 0, source: "Odoo" },
                { key: "odooOrderStatus", label: "Order Status Shortcuts", icon: ShoppingBag, color: "text-blue-400", count: 3, source: "Odoo" },
                { key: "twentyDealStages", label: "Twenty CRM Deal Stages", icon: Briefcase, color: "text-violet-400", count: dataSources?.twentyDeals?.length ?? 0, source: "Twenty" },
                { key: "twentyContactList", label: "Twenty CRM Contacts", icon: Users, color: "text-violet-400", count: dataSources?.twentyContacts?.length ?? 0, source: "Twenty" },
              ].map(({ key, label, icon: Icon, color, count, source }) => (
                <div key={key} className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border border-border">
                  <div className="flex items-center gap-3">
                    <Icon className={`w-5 h-5 ${color}`} />
                    <div>
                      <p className="text-sm font-medium">{label}</p>
                      <p className="text-xs text-muted-foreground">{count} items from {source}</p>
                    </div>
                  </div>
                  <Switch
                    checked={autoSources[key as keyof typeof autoSources]}
                    onCheckedChange={v => setAutoSources(s => ({ ...s, [key]: v }))}
                  />
                </div>
              ))}
            </div>
            <Button
              className="w-full bg-primary text-primary-foreground gap-2"
              disabled={autoPopulate.isPending || !Object.values(autoSources).some(Boolean)}
              onClick={() => selectedMenuId && autoPopulate.mutate({ menuId: selectedMenuId, sources: autoSources })}
            >
              {autoPopulate.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              Generate Menu Items
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Edit/Add Item Dialog ── */}
      <Dialog open={editItemOpen} onOpenChange={setEditItemOpen}>
        <DialogContent className="bg-card border-border max-w-sm">
          <DialogHeader>
            <DialogTitle>{editingItem?.id ? "Edit Item" : "Add Menu Item"}</DialogTitle>
          </DialogHeader>
          {editingItem && (
            <div className="space-y-3 pt-2">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={editingItem.type} onValueChange={v => setEditingItem(i => ({ ...i, type: v as ItemType }))}>
                  <SelectTrigger className="bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border">
                    {Object.entries(TYPE_META).map(([type, meta]) => (
                      <SelectItem key={type} value={type}>
                        <span className="flex items-center gap-2">
                          <meta.icon className={`w-3.5 h-3.5 ${meta.color}`} />
                          {meta.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Title <span className="text-muted-foreground text-xs">(max 24 chars for WhatsApp)</span></Label>
                <Input value={editingItem.title ?? ""} onChange={e => setEditingItem(i => ({ ...i, title: e.target.value.slice(0, 24) }))} placeholder="Menu item title" className="bg-background border-border" />
              </div>
              <div className="space-y-1.5">
                <Label>Description <span className="text-muted-foreground text-xs">(optional, max 72 chars)</span></Label>
                <Input value={editingItem.description ?? ""} onChange={e => setEditingItem(i => ({ ...i, description: e.target.value.slice(0, 72) }))} placeholder="Short description" className="bg-background border-border" />
              </div>
              {editingItem.type !== "section" && (
                <div className="space-y-1.5">
                  <Label>Payload / Action</Label>
                  <Input value={editingItem.payload ?? ""} onChange={e => setEditingItem(i => ({ ...i, payload: e.target.value }))} placeholder="e.g. PRODUCT_001 or TRACK_ORDER" className="bg-background border-border" />
                </div>
              )}
              {editingItem.type === "url" && (
                <div className="space-y-1.5">
                  <Label>URL</Label>
                  <Input value={editingItem.url ?? ""} onChange={e => setEditingItem(i => ({ ...i, url: e.target.value }))} placeholder="https://..." className="bg-background border-border" />
                </div>
              )}
              <Button className="w-full bg-primary text-primary-foreground" onClick={saveItem} disabled={!editingItem.title?.trim() || addItem.isPending || updateItem.isPending}>
                {(addItem.isPending || updateItem.isPending) ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                {editingItem.id ? "Update Item" : "Add Item"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Push Success Dialog ── */}
      <Dialog open={pushOpen} onOpenChange={setPushOpen}>
        <DialogContent className="bg-card border-border max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-green-400">
              <CheckCircle2 className="w-5 h-5" /> Menu Pushed to WhatsApp!
            </DialogTitle>
          </DialogHeader>
          {pushResult && (
            <div className="space-y-3 pt-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-muted/50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-primary">{pushResult.itemCount}</div>
                  <div className="text-xs text-muted-foreground">Items Sent</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3 text-center">
                  <div className="text-sm font-bold text-green-400">{pushResult.pushedAt.toLocaleTimeString()}</div>
                  <div className="text-xs text-muted-foreground">Pushed At</div>
                </div>
              </div>
              <div className="bg-muted/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground mb-2 font-medium">WhatsApp Cloud API Payload Preview</p>
                <pre className="text-[10px] text-foreground overflow-auto max-h-48 font-mono">
                  {JSON.stringify(pushResult.payload, null, 2)}
                </pre>
              </div>
              <p className="text-xs text-muted-foreground text-center">
                In production, this payload is POSTed to the WhatsApp Cloud API. Connect your WhatsApp Business phone number in Settings to go live.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
