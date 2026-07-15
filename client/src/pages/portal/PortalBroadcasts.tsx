import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { TenantPortalLayout } from "@/components/TenantPortalLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Megaphone, Plus, Send, CheckCircle2, XCircle, Clock, Users,
  MessageSquare, Search, ChevronRight, Eye, Calendar,
} from "lucide-react";

type Category = "all" | "transactional" | "marketing" | "utility" | "authentication" | "custom";

const CATEGORY_COLORS: Record<string, string> = {
  transactional: "bg-blue-100 text-blue-700",
  marketing: "bg-purple-100 text-purple-700",
  utility: "bg-amber-100 text-amber-700",
  authentication: "bg-green-100 text-green-700",
  custom: "bg-slate-100 text-slate-700",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  scheduled: "bg-blue-100 text-blue-700",
  sending: "bg-amber-100 text-amber-700",
  completed: "bg-green-100 text-green-700",
  cancelled: "bg-red-100 text-red-700",
  failed: "bg-red-100 text-red-700",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  draft: <Clock className="w-3 h-3" />,
  scheduled: <Clock className="w-3 h-3" />,
  sending: <Send className="w-3 h-3" />,
  completed: <CheckCircle2 className="w-3 h-3" />,
  cancelled: <XCircle className="w-3 h-3" />,
  failed: <XCircle className="w-3 h-3" />,
};

const SEGMENT_LABELS: Record<string, string> = {
  all: "All Contacts",
  new_contacts: "New Contacts",
  recent_orders: "Recent Orders",
  overdue_invoices: "Overdue Invoices",
  shipped_orders: "Shipped Orders",
  vip_customers: "VIP Customers",
  custom: "Custom Segment",
};

/** Substitutes {{variable}} placeholders with sample values for preview */
function previewBody(body: string, variables: string[]): string {
  const samples: Record<string, string> = {
    name: "Amaka Obi",
    first_name: "Amaka",
    order_id: "ORD-20240715",
    amount: "₦12,500",
    product: "iPhone 15 Pro",
    date: new Date().toLocaleDateString(),
    store_name: "Your Store",
    link: "https://wa.me/…",
  };
  return variables.reduce((text, v) => {
    const sample = samples[v] ?? `[${v}]`;
    return text.replace(new RegExp(`\\{\\{${v}\\}\\}`, "g"), sample);
  }, body);
}

export default function PortalBroadcasts() {
  const [createOpen, setCreateOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);

  // Create form state
  const [newName, setNewName] = useState("");
  const [newSegment, setNewSegment] = useState("all");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateSearch, setTemplateSearch] = useState("");
  const [templateCategory, setTemplateCategory] = useState<Category>("all");
  const [varMapping, setVarMapping] = useState<Record<string, string>>({});
  const [scheduledAt, setScheduledAt] = useState("");

  // Campaigns list
  const { data: campaignsData, isLoading: campaignsLoading, refetch } = trpc.broadcast.list.useQuery({
    limit: 50,
    offset: 0,
  });
  const campaigns = campaignsData?.campaigns ?? [];

  // Approved operator templates for picker
  const { data: templatesData, isLoading: templatesLoading } = trpc.tenantPortal.listApprovedTemplates.useQuery({
    category: templateCategory,
    search: templateSearch || undefined,
  });
  const templates = templatesData?.items ?? [];

  // Selected template for preview
  const selectedTemplate = useMemo(
    () => templates.find(t => t.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  );

  // Variables extracted from selected template body
  const templateVars = useMemo(() => {
    if (!selectedTemplate) return [];
    const matches = selectedTemplate.bodyText.match(/\{\{([^}]+)\}\}/g) ?? [];
    return matches.map(m => m.slice(2, -2));
  }, [selectedTemplate]);

  const createCampaign = trpc.broadcast.create.useMutation({
    onSuccess: () => {
      toast.success("Broadcast campaign created");
      setCreateOpen(false);
      setNewName("");
      setNewSegment("all");
      setSelectedTemplateId("");
      setVarMapping({});
      setScheduledAt("");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const sendCampaign = trpc.broadcast.send.useMutation({
    onSuccess: () => { toast.success("Campaign sent!"); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const selectedCampaign = campaigns.find(c => c.id === selectedCampaignId);

  return (
    <TenantPortalLayout>
      <div className="p-6 space-y-6 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Megaphone className="w-6 h-6 text-primary" />
              Broadcasts
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Send WhatsApp messages to your customers using approved templates
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            New Campaign
          </Button>
        </div>

        {/* Campaign list */}
        <div className="grid gap-3">
          {campaignsLoading ? (
            [...Array(4)].map((_, i) => <Skeleton key={i} className="h-20 w-full" />)
          ) : campaigns.length === 0 ? (
            <Card>
              <CardContent className="py-12 flex flex-col items-center gap-3 text-muted-foreground">
                <Megaphone className="w-10 h-10 opacity-30" />
                <p className="text-sm">No campaigns yet. Create your first broadcast.</p>
              </CardContent>
            </Card>
          ) : (
            campaigns.map(c => (
              <Card
                key={c.id}
                className={`cursor-pointer transition-all hover:shadow-md ${selectedCampaignId === c.id ? "ring-2 ring-primary" : ""}`}
                onClick={() => setSelectedCampaignId(c.id === selectedCampaignId ? null : c.id)}
              >
                <CardContent className="py-4">
                  <div className="flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold truncate">{c.name}</span>
                        <Badge className={`text-xs gap-1 ${STATUS_COLORS[c.status] ?? ""}`}>
                          {STATUS_ICONS[c.status]}
                          {c.status}
                        </Badge>
                        {c.segment && (
                          <span className="text-xs text-muted-foreground">
                            {SEGMENT_LABELS[c.segment] ?? c.segment}
                          </span>
                        )}
                      </div>
                      {/* Delivery stats */}
                      <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Users className="w-3 h-3" /> {c.totalRecipients ?? 0} recipients
                        </span>
                        <span className="flex items-center gap-1">
                          <Send className="w-3 h-3" /> {c.sentCount ?? 0} sent
                        </span>
                        <span className="flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3 text-emerald-500" /> {c.deliveredCount ?? 0} delivered
                        </span>
                        {(c.failedCount ?? 0) > 0 && (
                          <span className="flex items-center gap-1 text-red-500">
                            <XCircle className="w-3 h-3" /> {c.failedCount} failed
                          </span>
                        )}
                      </div>
                    </div>
                    <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${selectedCampaignId === c.id ? "rotate-90" : ""}`} />
                  </div>

                  {/* Expanded detail */}
                  {selectedCampaignId === c.id && (
                    <div className="mt-4 pt-4 border-t space-y-3">
                      {/* Progress bar */}
                      {c.totalRecipients > 0 && (
                        <div>
                          <div className="flex justify-between text-xs text-muted-foreground mb-1">
                            <span>Delivery progress</span>
                            <span>{Math.round(((c.deliveredCount ?? 0) / c.totalRecipients) * 100)}%</span>
                          </div>
                          <div className="h-2 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-emerald-500 rounded-full transition-all"
                              style={{ width: `${Math.round(((c.deliveredCount ?? 0) / c.totalRecipients) * 100)}%` }}
                            />
                          </div>
                        </div>
                      )}
                      {/* Actions */}
                      {(c.status === "draft" || c.status === "scheduled") && (
                        <Button
                          size="sm"
                          className="gap-2"
                          onClick={(e) => { e.stopPropagation(); sendCampaign.mutate({ campaignId: c.id }); }}
                          disabled={sendCampaign.isPending}
                        >
                          <Send className="w-3 h-3" />
                          Send Now
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>

      {/* ── Create Campaign Dialog ─────────────────────────────────────────── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Megaphone className="w-4 h-4 text-primary" />
              Create Broadcast Campaign
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-5">
            {/* Campaign name */}
            <div className="space-y-1.5">
              <Label>Campaign Name</Label>
              <Input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. July Flash Sale, Payment Reminder"
              />
            </div>

            {/* Contact segment */}
            <div className="space-y-1.5">
              <Label>Contact Segment</Label>
              <Select value={newSegment} onValueChange={setNewSegment}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(SEGMENT_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Template picker */}
            <div className="space-y-2">
              <Label>Message Template</Label>
              <p className="text-xs text-muted-foreground">
                Select from operator-approved templates. Only active templates are shown.
              </p>

              {/* Search + category filter */}
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <Input
                    className="pl-8 h-8 text-sm"
                    placeholder="Search templates…"
                    value={templateSearch}
                    onChange={e => setTemplateSearch(e.target.value)}
                  />
                </div>
                <Select value={templateCategory} onValueChange={v => setTemplateCategory(v as Category)}>
                  <SelectTrigger className="w-40 h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["all", "transactional", "marketing", "utility", "authentication", "custom"] as Category[]).map(c => (
                      <SelectItem key={c} value={c} className="text-sm capitalize">{c === "all" ? "All Categories" : c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Template grid */}
              {templatesLoading ? (
                <div className="space-y-2">
                  {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
                </div>
              ) : templates.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm border rounded-lg bg-muted/20">
                  <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  No active templates found.
                  {templateSearch && " Try clearing the search."}
                </div>
              ) : (
                <div className="grid gap-2 max-h-56 overflow-y-auto pr-1">
                  {templates.map(t => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setSelectedTemplateId(t.id === selectedTemplateId ? "" : t.id)}
                      className={`w-full text-left p-3 rounded-lg border transition-all ${
                        selectedTemplateId === t.id
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:border-primary/40 hover:bg-muted/30"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm truncate">{t.name}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${CATEGORY_COLORS[t.category] ?? "bg-muted text-muted-foreground"}`}>
                              {t.category}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{t.bodyText}</p>
                        </div>
                        {selectedTemplateId === t.id && (
                          <CheckCircle2 className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Live WhatsApp-style preview */}
            {selectedTemplate && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-1.5">
                    <Eye className="w-3.5 h-3.5" />
                    Message Preview
                  </Label>
                  <span className="text-xs text-muted-foreground">Sample values shown</span>
                </div>
                <div className="bg-[#e5ddd5] rounded-xl p-4">
                  <div className="max-w-xs ml-auto">
                    <div className="bg-white rounded-xl rounded-tr-sm shadow-sm p-3 space-y-1.5">
                      {selectedTemplate.headerText && (
                        <p className="text-sm font-semibold text-gray-800">{selectedTemplate.headerText}</p>
                      )}
                      <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                        {previewBody(selectedTemplate.bodyText, templateVars)}
                      </p>
                      {selectedTemplate.footerText && (
                        <p className="text-xs text-gray-400 mt-1">{selectedTemplate.footerText}</p>
                      )}
                      <p className="text-[10px] text-gray-400 text-right">
                        {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ✓✓
                      </p>
                    </div>
                  </div>
                </div>
                {templateVars.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {templateVars.map(v => (
                      <Badge key={v} variant="outline" className="text-xs font-mono text-primary border-primary/30">
                        {`{{${v}}}`}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

            {/* Variable mapping inputs */}
            {selectedTemplate && templateVars.length > 0 && (
              <div className="space-y-2 border rounded-lg p-3 bg-muted/20 mb-4">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Variable Mapping</Label>
                <div className="grid grid-cols-2 gap-2">
                  {templateVars.map(v => (
                    <div key={v} className="space-y-1">
                      <Label className="text-xs font-mono text-primary">{`{{${v}}}`}</Label>
                      <Input className="h-7 text-xs" placeholder={`Value for ${v}`} value={varMapping[v] ?? ""} onChange={e => setVarMapping(prev => ({ ...prev, [v]: e.target.value }))} />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Scheduled send time */}
            <div className="space-y-1.5 mb-4">
              <Label className="flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5" />Schedule Send (optional)</Label>
              <Input type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} className="text-sm" />
              <p className="text-xs text-muted-foreground">Leave empty to send immediately.</p>
            </div>
          <DialogFooter className="pt-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={() => createCampaign.mutate({
                tenantId: "demo-tenant-1",
                name: newName,
                templateId: selectedTemplateId || undefined,
                segment: newSegment as any,
                scheduledAt: scheduledAt ? new Date(scheduledAt).getTime() : undefined,
              })}
              disabled={createCampaign.isPending || !newName.trim()}
            >
              {createCampaign.isPending ? "Creating…" : "Create Campaign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TenantPortalLayout>
  );
}
