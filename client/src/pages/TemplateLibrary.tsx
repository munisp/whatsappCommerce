import { useState, type ReactNode } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Search, Plus, Eye, Edit2, Trash2, Send, Copy, MessageSquare,
  ShoppingBag, Truck, CreditCard, Star, Megaphone, HeadphonesIcon, Zap,
  BarChart2, CheckCircle2, Clock
} from "lucide-react";
import { EyeOff, Upload, XCircle, AlertTriangle } from "lucide-react";

const CATEGORIES = [
  { value: "all", label: "All Templates", icon: MessageSquare },
  { value: "order_confirmation", label: "Order Confirmation", icon: ShoppingBag },
  { value: "shipping_update", label: "Shipping Update", icon: Truck },
  { value: "payment_reminder", label: "Payment Reminder", icon: CreditCard },
  { value: "welcome", label: "Welcome", icon: Star },
  { value: "promotion", label: "Promotion", icon: Megaphone },
  { value: "support", label: "Support", icon: HeadphonesIcon },
  { value: "custom", label: "Custom", icon: Zap },
];

const CATEGORY_COLORS: Record<string, string> = {
  order_confirmation: "bg-emerald-500/20 text-emerald-700 border-emerald-500/30",
  shipping_update: "bg-blue-500/20 text-blue-700 border-blue-500/30",
  payment_reminder: "bg-amber-500/20 text-amber-700 border-amber-500/30",
  welcome: "bg-purple-500/20 text-purple-700 border-purple-500/30",
  promotion: "bg-pink-500/20 text-pink-700 border-pink-500/30",
  support: "bg-cyan-500/20 text-cyan-700 border-cyan-500/30",
  custom: "bg-slate-500/20 text-foreground border-slate-500/30",
};

type Template = {
  id: string;
  name: string;
  category: string;
  language: string;
  headerText?: string | null;
  bodyText: string;
  footerText?: string | null;
  variables?: unknown;
  buttons?: unknown;
  isActive: boolean;
  usageCount: number;
  lastUsedAt?: Date | null;
  approvalStatus?: string | null;
  approvalSubmittedAt?: Date | null;
  rejectionReason?: string | null;
  metaTemplateId?: string | null;
};

function WhatsAppBubble({ header, body, footer, buttons }: {
  header?: string | null;
  body: string;
  footer?: string | null;
  buttons?: Array<{ type: string; text: string }>;
}) {
  const renderBold = (text: string) => {
    const parts = text.split(/(\*[^*]+\*)/g);
    return parts.map((p, i) =>
      p.startsWith("*") && p.endsWith("*")
        ? <strong key={i}>{p.slice(1, -1)}</strong>
        : <span key={i}>{p}</span>
    );
  };

  return (
    <div className="bg-[#0b141a] rounded-lg p-4 min-h-[200px] flex flex-col gap-2">
      {/* Phone header */}
      <div className="flex items-center gap-2 pb-2 border-b border-border">
        <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center text-xs font-bold text-white">W</div>
        <div>
          <div className="text-xs font-semibold text-white">OAK</div>
          <div className="text-[10px] text-white/40">Business Account</div>
        </div>
      </div>
      {/* Message bubble */}
      <div className="bg-[#1f2c34] rounded-xl rounded-tl-sm p-3 max-w-[90%] self-start shadow">
        {header && (
          <div className="text-sm font-semibold text-white mb-1">{header}</div>
        )}
        <div className="text-xs text-white/90 whitespace-pre-wrap leading-relaxed">
          {body.split("\n").map((line, i) => (
            <div key={i}>{renderBold(line)}</div>
          ))}
        </div>
        {footer && (
          <div className="text-[10px] text-white/40 mt-2 pt-2 border-t border-white/10">{footer}</div>
        )}
        <div className="text-[10px] text-white/30 text-right mt-1">✓✓</div>
      </div>
      {/* Buttons */}
      {buttons && buttons.length > 0 && (
        <div className="flex flex-col gap-1 max-w-[90%]">
          {buttons.map((btn, i) => (
            <div key={i} className="bg-[#1f2c34] border border-emerald-500/30 rounded-lg px-3 py-2 text-xs text-emerald-400 text-center cursor-pointer hover:bg-emerald-500/10 transition-colors">
              {btn.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateTemplateDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    name: "", category: "custom" as const, language: "en",
    headerText: "", bodyText: "", footerText: "",
  });
  const create = trpc.template.create.useMutation({
    onSuccess: () => { toast.success("Template created"); onCreated(); onClose(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl bg-[#FDFAF3] border-border text-foreground">
        <DialogHeader>
          <DialogTitle className="text-foreground">New WhatsApp Template</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-3">
            <div>
              <Label className="text-foreground/70 text-xs">Template Name</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Order Confirmation" className="bg-muted border-border text-foreground mt-1" />
            </div>
            <div>
              <Label className="text-foreground/70 text-xs">Category</Label>
              <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v as any }))}>
                <SelectTrigger className="bg-muted border-border text-foreground mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#DDD3BD] border-border">
                  {CATEGORIES.filter(c => c.value !== "all").map(c => (
                    <SelectItem key={c.value} value={c.value} className="text-foreground">{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-foreground/70 text-xs">Header (optional)</Label>
              <Input value={form.headerText} onChange={e => setForm(f => ({ ...f, headerText: e.target.value }))}
                placeholder="Bold header text" className="bg-muted border-border text-foreground mt-1" />
            </div>
            <div>
              <Label className="text-foreground/70 text-xs">Body <span className="text-muted-foreground">(use {"{{variable}}"} for dynamic values)</span></Label>
              <Textarea value={form.bodyText} onChange={e => setForm(f => ({ ...f, bodyText: e.target.value }))}
                placeholder="Hi {{customer_name}}, your order is confirmed!" rows={5}
                className="bg-muted border-border text-foreground mt-1 resize-none" />
            </div>
            <div>
              <Label className="text-foreground/70 text-xs">Footer (optional)</Label>
              <Input value={form.footerText} onChange={e => setForm(f => ({ ...f, footerText: e.target.value }))}
                placeholder="Reply STOP to unsubscribe" className="bg-muted border-border text-foreground mt-1" />
            </div>
          </div>
          <div>
            <Label className="text-foreground/70 text-xs">Live Preview</Label>
            <div className="mt-1">
              <WhatsAppBubble
                header={form.headerText || undefined}
                body={form.bodyText || "Your message will appear here..."}
                footer={form.footerText || undefined}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="border-border text-foreground/70">Cancel</Button>
          <Button onClick={() => create.mutate({ ...form, bodyText: form.bodyText || " " })}
            disabled={!form.name || !form.bodyText || create.isPending}
            className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {create.isPending ? "Creating..." : "Create Template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TemplateCard({ template, onSelect, onDelete, onSend, onToggleActive }: {
  template: Template;
  onSelect: () => void;
  onDelete: () => void;
  onSend: () => void;
  onToggleActive?: (isActive: boolean) => void;
}) {
  const vars = (template.variables as Array<{ name: string }> | null) ?? [];
  const btns = (template.buttons as Array<{ type: string; text: string }> | null) ?? [];
  const catColor = CATEGORY_COLORS[template.category] ?? "bg-slate-500/20 text-foreground border-slate-500/30";
  const catLabel = CATEGORIES.find(c => c.value === template.category)?.label ?? template.category;

  const utils = trpc.useUtils();
  const submitApproval = trpc.template.submitForApproval.useMutation({
    onSuccess: () => {
      toast.success("Template submitted to Meta for approval");
      utils.template.list.invalidate();
    },
    onError: (e) => toast.error(`Submission failed: ${e.message}`),
  });

  const approvalStatus = (template as any).approvalStatus ?? "none";
  const approvalBadgeMap: Record<string, ReactNode> = {
    none: null,
    draft: <Badge className="text-[10px] border bg-slate-500/20 text-foreground border-slate-500/30">draft</Badge>,
    submitted: <Badge className="text-[10px] border bg-blue-500/20 text-blue-700 border-blue-500/30 gap-1"><Upload className="w-2.5 h-2.5" />submitted</Badge>,
    approved: <Badge className="text-[10px] border bg-emerald-500/20 text-emerald-700 border-emerald-500/30 gap-1"><CheckCircle2 className="w-2.5 h-2.5" />approved</Badge>,
    rejected: <Badge className="text-[10px] border bg-red-500/20 text-red-700 border-red-500/30 gap-1"><XCircle className="w-2.5 h-2.5" />rejected</Badge>,
    paused: <Badge className="text-[10px] border bg-amber-500/20 text-amber-700 border-amber-500/30 gap-1"><AlertTriangle className="w-2.5 h-2.5" />paused</Badge>,
  };
  const approvalBadge = approvalBadgeMap[approvalStatus] ?? null;

  return (
    <Card className="bg-[#FDFAF3] border-border hover:border-emerald-500/40 transition-all group cursor-pointer" onClick={onSelect}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm text-foreground truncate">{template.name}</CardTitle>
            <div className="flex items-center gap-2 mt-1">
              <Badge className={`text-[10px] border ${catColor}`}>{catLabel}</Badge>
              <span className="text-[10px] text-muted-foreground uppercase">{template.language}</span>
              <Badge className={`text-[10px] border ${template.isActive ? "bg-emerald-500/20 text-emerald-700 border-emerald-500/30" : "bg-amber-500/20 text-amber-700 border-amber-500/30"}`}>
                {template.isActive ? "published" : "draft"}
              </Badge>
              {approvalBadge}
            </div>
            {approvalStatus === "rejected" && (template as any).rejectionReason && (
              <p className="text-[10px] text-red-400/70 mt-1 truncate" title={(template as any).rejectionReason}>
                ✕ {(template as any).rejectionReason}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
            {onToggleActive && (
              <Button
                size="icon" variant="ghost"
                className={`h-7 w-7 ${template.isActive ? "text-amber-400 hover:text-amber-300" : "text-emerald-400 hover:text-emerald-300"}`}
                title={template.isActive ? "Set to draft" : "Publish"}
                onClick={() => onToggleActive(!template.isActive)}
              >
                {template.isActive ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </Button>
            )}
            {/* Submit to Meta button — shown when not yet submitted/approved */}
            {(approvalStatus === "none" || approvalStatus === "draft" || approvalStatus === "rejected") && (
              <Button
                size="icon" variant="ghost"
                className="h-7 w-7 text-blue-400 hover:text-blue-300"
                title="Submit to Meta for approval"
                disabled={submitApproval.isPending}
                onClick={() => submitApproval.mutate({ id: template.id })}
              >
                <Upload className="w-3.5 h-3.5" />
              </Button>
            )}
            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-white" onClick={onSelect}>
              <Eye className="w-3.5 h-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-400 hover:text-emerald-300" onClick={onSend}>
              <Send className="w-3.5 h-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-red-400 hover:text-red-300" onClick={onDelete}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {template.headerText && (
          <div className="text-xs font-semibold text-foreground/80 mb-1">{template.headerText}</div>
        )}
        <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">{template.bodyText}</p>
        <div className="flex items-center gap-3 mt-3 pt-3 border-t border-border">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <BarChart2 className="w-3 h-3" />
            <span>{template.usageCount} uses</span>
          </div>
          {vars.length > 0 && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Zap className="w-3 h-3" />
              <span>{vars.length} vars</span>
            </div>
          )}
          {btns.length > 0 && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <CheckCircle2 className="w-3 h-3" />
              <span>{btns.length} buttons</span>
            </div>
          )}
          {template.lastUsedAt && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground ml-auto">
              <Clock className="w-3 h-3" />
              <span>{new Date(template.lastUsedAt).toLocaleDateString()}</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PreviewPanel({ template, onClose, onSend }: { template: Template; onClose: () => void; onSend: () => void }) {
  const vars = (template.variables as Array<{ name: string; example?: string; description?: string }> | null) ?? [];
  const btns = (template.buttons as Array<{ type: string; text: string }> | null) ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    vars.forEach(v => { init[v.name] = v.example ?? ""; });
    return init;
  });

  const substitute = (text: string | null | undefined) => {
    if (!text) return text ?? "";
    return text.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? `{{${key}}}`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#FDFAF3] border border-border rounded-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h2 className="text-foreground font-semibold">{template.name}</h2>
            <p className="text-muted-foreground text-xs mt-0.5">Template Preview & Variable Editor</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="text-muted-foreground">✕</Button>
        </div>
        <div className="grid grid-cols-2 gap-6 p-6">
          {/* Variable editor */}
          <div className="space-y-4">
            <h3 className="text-foreground/70 text-xs font-semibold uppercase tracking-wider">Variables</h3>
            {vars.length === 0 ? (
              <p className="text-muted-foreground text-sm">No variables in this template.</p>
            ) : (
              vars.map(v => (
                <div key={v.name}>
                  <Label className="text-muted-foreground text-xs">
                    {`{{${v.name}}}`}
                    {v.description && <span className="text-muted-foreground ml-1">— {v.description}</span>}
                  </Label>
                  <Input
                    value={values[v.name] ?? ""}
                    onChange={e => setValues(prev => ({ ...prev, [v.name]: e.target.value }))}
                    placeholder={v.example ?? v.name}
                    className="bg-muted border-border text-foreground mt-1 text-sm"
                  />
                </div>
              ))
            )}
            <Separator className="bg-muted" />
            <h3 className="text-foreground/70 text-xs font-semibold uppercase tracking-wider">Buttons</h3>
            {btns.length === 0 ? (
              <p className="text-muted-foreground text-sm">No buttons.</p>
            ) : (
              btns.map((b, i) => (
                <div key={i} className="flex items-center gap-2 bg-muted rounded-lg px-3 py-2">
                  <Badge className="text-[10px] bg-emerald-500/20 text-emerald-700 border-emerald-500/30">{b.type}</Badge>
                  <span className="text-foreground/70 text-xs">{b.text}</span>
                </div>
              ))
            )}
          </div>
          {/* Phone preview */}
          <div>
            <h3 className="text-foreground/70 text-xs font-semibold uppercase tracking-wider mb-3">Live Preview</h3>
            <WhatsAppBubble
              header={substitute(template.headerText)}
              body={substitute(template.bodyText)}
              footer={substitute(template.footerText)}
              buttons={btns}
            />
          </div>
        </div>
        <div className="flex items-center justify-between p-4 border-t border-border">
          <Button variant="ghost" size="sm" className="text-muted-foreground gap-1.5" onClick={() => {
            navigator.clipboard.writeText(substitute(template.bodyText));
            toast.success("Body text copied");
          }}>
            <Copy className="w-3.5 h-3.5" /> Copy Body
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose} className="border-border text-foreground/70">Close</Button>
            <Button size="sm" onClick={onSend} className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5">
              <Send className="w-3.5 h-3.5" /> Use Template
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function TemplateLibrary() {
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<Template | null>(null);
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.template.list.useQuery({
    category: category === "all" ? undefined : category,
    search: search || undefined,
  });

  const deleteTemplate = trpc.template.delete.useMutation({
    onSuccess: () => { toast.success("Template deleted"); utils.template.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const recordUsage = trpc.template.recordUsage.useMutation({
    onSuccess: () => utils.template.list.invalidate(),
  });
  const toggleActive = trpc.template.toggleActive.useMutation({
    onSuccess: (_: unknown, vars: { id: string; isActive: boolean }) => {
      toast.success(vars.isActive ? "Template published" : "Template set to draft");
      utils.template.list.invalidate();
    },
    onError: (e: { message: string }) => toast.error(e.message),
  });

  const templates = data?.templates ?? [];
  const total = data?.total ?? 0;

  const handleSend = (t: Template) => {
    recordUsage.mutate({ id: t.id });
    toast.success(`Template "${t.name}" marked as used. Wire to your send dialog to dispatch via WhatsApp.`);
    setSelected(null);
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Template Library</h1>
            <p className="text-muted-foreground text-sm mt-1">
              {total} reusable WhatsApp message templates — pulled from Odoo & Twenty send dialogs
            </p>
          </div>
          <Button onClick={() => setShowCreate(true)} className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2">
            <Plus className="w-4 h-4" /> New Template
          </Button>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: "Total Templates", value: total, icon: MessageSquare, color: "text-emerald-400" },
            { label: "Active", value: templates.filter(t => t.isActive).length, icon: CheckCircle2, color: "text-blue-400" },
            { label: "Total Uses", value: templates.reduce((s, t) => s + t.usageCount, 0), icon: BarChart2, color: "text-purple-400" },
            { label: "Categories", value: new Set(templates.map(t => t.category)).size, icon: Zap, color: "text-amber-400" },
          ].map(stat => (
            <Card key={stat.label} className="bg-[#FDFAF3] border-border">
              <CardContent className="p-4 flex items-center gap-3">
                <stat.icon className={`w-8 h-8 ${stat.color} opacity-80`} />
                <div>
                  <div className="text-2xl font-bold text-foreground">{stat.value}</div>
                  <div className="text-xs text-muted-foreground">{stat.label}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search templates..."
              className="pl-9 bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <Tabs value={category} onValueChange={setCategory}>
            <TabsList className="bg-muted border border-border flex-wrap h-auto gap-1 p-1">
              {CATEGORIES.map(c => (
                <TabsTrigger key={c.value} value={c.value}
                  className="text-xs data-[state=active]:bg-emerald-600 data-[state=active]:text-white text-muted-foreground">
                  {c.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {/* Grid */}
        {isLoading ? (
          <div className="grid grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-48 bg-muted rounded-xl animate-pulse" />
            ))}
          </div>
        ) : templates.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground">
            <MessageSquare className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No templates found. Create your first one!</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {templates.map(t => (
              <TemplateCard
                key={t.id}
                template={t as Template}
                onSelect={() => setSelected(t as Template)}
                onDelete={() => deleteTemplate.mutate({ id: t.id })}
                onSend={() => handleSend(t as Template)}
                onToggleActive={(isActive: boolean) => toggleActive.mutate({ id: t.id, isActive })}
              />
            ))}
          </div>
        )}
      </div>

      {/* Modals */}
      {showCreate && (
        <CreateTemplateDialog
          open={showCreate}
          onClose={() => setShowCreate(false)}
          onCreated={() => utils.template.list.invalidate()}
        />
      )}
      {selected && (
        <PreviewPanel
          template={selected}
          onClose={() => setSelected(null)}
          onSend={() => handleSend(selected)}
        />
      )}
    </DashboardLayout>
  );
}
