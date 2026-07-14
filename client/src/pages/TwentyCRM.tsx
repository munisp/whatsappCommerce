import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Users, Briefcase, MessageSquare, RefreshCw, CheckCircle2,
  XCircle, AlertCircle, Settings, Send, TrendingUp, Building2,
  Phone, Mail, Link2, Loader2
} from "lucide-react";

const STAGE_COLORS: Record<string, string> = {
  Lead: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  Prospect: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  Qualified: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  Opportunity: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  Proposal: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  Negotiation: "bg-pink-500/20 text-pink-400 border-pink-500/30",
  Won: "bg-green-500/20 text-green-400 border-green-500/30",
  Customer: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  Lost: "bg-red-500/20 text-red-400 border-red-500/30",
};

function stageBadge(stage?: string | null) {
  const cls = STAGE_COLORS[stage ?? ""] ?? "bg-muted text-muted-foreground border-border";
  return <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${cls}`}>{stage ?? "—"}</span>;
}

function StatusDot({ status }: { status: string }) {
  const map: Record<string, string> = { connected: "bg-green-400", disconnected: "bg-zinc-500", error: "bg-red-400" };
  return <span className={`inline-block w-2 h-2 rounded-full ${map[status] ?? "bg-zinc-500"}`} />;
}

export default function TwentyCRM() {
  const [configOpen, setConfigOpen] = useState(false);
  const [form, setForm] = useState({ baseUrl: "https://api.twenty.com", apiKey: "", workspaceId: "", syncContacts: true, syncDeals: true, whatsappEnabled: true });
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTarget, setSendTarget] = useState<{ id: string; name: string; phone: string } | null>(null);
  const [sendMsg, setSendMsg] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const { data: templatesData } = trpc.template.list.useQuery({ limit: 50 });
  const templates = templatesData?.templates ?? [];

  const { data: config, refetch: refetchConfig } = trpc.twenty.getConfig.useQuery();
  const { data: contactsData, refetch: refetchContacts } = trpc.twenty.listContacts.useQuery({ limit: 50, offset: 0 });
  const { data: dealsData, refetch: refetchDeals } = trpc.twenty.listDeals.useQuery({ limit: 50, offset: 0 });

  const saveConfig = trpc.twenty.saveConfig.useMutation({
    onSuccess: () => { toast.success("Twenty CRM configuration saved"); refetchConfig(); setConfigOpen(false); },
    onError: (e) => toast.error(e.message),
  });
  const testConn = trpc.twenty.testConnection.useMutation({
    onSuccess: (d) => { toast[d.success ? "success" : "error"](d.success ? "Connection successful!" : "Connection failed"); refetchConfig(); },
    onError: (e) => toast.error(e.message),
  });
  const syncAll = trpc.twenty.syncAll.useMutation({
    onSuccess: (d) => { toast.success(`Synced ${d.contactsSynced} contacts, ${d.dealsSynced} deals`); refetchContacts(); refetchDeals(); refetchConfig(); },
    onError: (e) => toast.error(e.message),
  });
  const sendWhatsApp = trpc.twenty.sendWhatsApp.useMutation({
    onSuccess: () => { toast.success("WhatsApp message sent!"); setSendOpen(false); setSendMsg(""); refetchContacts(); },
    onError: (e) => toast.error(e.message),
  });

  const contacts = contactsData?.contacts ?? [];
  const deals = dealsData?.deals ?? [];
  const status = config?.status ?? "disconnected";

  // Deal pipeline grouped by stage
  const dealsByStage = deals.reduce<Record<string, typeof deals>>((acc, d) => {
    const s = d.stage ?? "Pipeline";
    if (!acc[s]) acc[s] = [];
    acc[s].push(d);
    return acc;
  }, {});

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <div className="w-10 h-10 rounded-xl bg-violet-500/20 border border-violet-500/30 flex items-center justify-center">
                <Users className="w-5 h-5 text-violet-400" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">Twenty CRM</h1>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <StatusDot status={status} />
                  <span className="capitalize">{status}</span>
                  {config?.lastSyncAt && <span>· Last sync: {new Date(config.lastSyncAt).toLocaleString()}</span>}
                </div>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => syncAll.mutate()} disabled={syncAll.isPending || status === "disconnected"} className="gap-2 border-border">
              {syncAll.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Sync Now
            </Button>
            <Dialog open={configOpen} onOpenChange={setConfigOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2 border-border">
                  <Settings className="w-4 h-4" /> Configure
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-card border-border max-w-md">
                <DialogHeader>
                  <DialogTitle>Twenty CRM Connection</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 pt-2">
                  <div className="space-y-1.5">
                    <Label>API Base URL</Label>
                    <Input value={form.baseUrl} onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))} placeholder="https://api.twenty.com" className="bg-background border-border" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>API Key</Label>
                    <Input type="password" value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} placeholder="your-twenty-api-key" className="bg-background border-border" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Workspace ID (optional)</Label>
                    <Input value={form.workspaceId} onChange={e => setForm(f => ({ ...f, workspaceId: e.target.value }))} placeholder="workspace-id" className="bg-background border-border" />
                  </div>
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    {[
                      { key: "syncContacts", label: "Sync Contacts" },
                      { key: "syncDeals", label: "Sync Deals" },
                      { key: "whatsappEnabled", label: "WhatsApp Enabled" },
                    ].map(({ key, label }) => (
                      <div key={key} className="flex items-center gap-2">
                        <Switch checked={form[key as keyof typeof form] as boolean} onCheckedChange={v => setForm(f => ({ ...f, [key]: v }))} />
                        <Label className="text-sm">{label}</Label>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2 pt-2">
                    <Button variant="outline" size="sm" className="border-border gap-2" onClick={() => testConn.mutate({ baseUrl: form.baseUrl, apiKey: form.apiKey })} disabled={testConn.isPending}>
                      {testConn.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />} Test
                    </Button>
                    <Button size="sm" className="flex-1 bg-primary text-primary-foreground" onClick={() => saveConfig.mutate(form)} disabled={saveConfig.isPending}>
                      {saveConfig.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null} Save
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Contacts", value: contacts.length, icon: Users, color: "text-violet-400" },
            { label: "Deals", value: deals.length, icon: Briefcase, color: "text-blue-400" },
            { label: "Pipeline Value", value: `$${deals.reduce((s, d) => s + Number(d.amount ?? 0), 0).toLocaleString()}`, icon: TrendingUp, color: "text-green-400" },
            { label: "WhatsApp Sent", value: contacts.filter(c => c.lastWhatsappAt).length, icon: MessageSquare, color: "text-primary" },
          ].map(kpi => (
            <Card key={kpi.label} className="bg-card border-border">
              <CardContent className="p-4 flex items-center gap-3">
                <kpi.icon className={`w-8 h-8 ${kpi.color}`} />
                <div>
                  <div className="text-xl font-bold">{kpi.value}</div>
                  <div className="text-xs text-muted-foreground">{kpi.label}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Tabs defaultValue="contacts">
          <TabsList className="bg-muted border border-border">
            <TabsTrigger value="contacts">Contacts ({contacts.length})</TabsTrigger>
            <TabsTrigger value="deals">Deal Pipeline ({deals.length})</TabsTrigger>
          </TabsList>

          {/* ── Contacts Tab ── */}
          <TabsContent value="contacts" className="mt-4">
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Synced Contacts</CardTitle>
                <CardDescription>Contacts from Twenty CRM with WhatsApp integration</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {contacts.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground">
                    <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p>No contacts synced yet. Configure Twenty CRM and click Sync Now.</p>
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {contacts.map(c => (
                      <div key={c.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/40 transition-colors">
                        <div className="w-9 h-9 rounded-full bg-violet-500/20 border border-violet-500/30 flex items-center justify-center text-sm font-semibold text-violet-400 shrink-0">
                          {(c.name ?? "?")[0]?.toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{c.name ?? "—"}</div>
                          <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                            {c.company && <span className="flex items-center gap-1"><Building2 className="w-3 h-3" />{c.company}</span>}
                            {c.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{c.email}</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {stageBadge(c.stage)}
                          {c.whatsappPhone && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 gap-1 border-primary/40 text-primary hover:bg-primary/10"
                              onClick={() => { setSendTarget({ id: c.id, name: c.name ?? "", phone: c.whatsappPhone! }); setSendOpen(true); }}
                            >
                              <MessageSquare className="w-3 h-3" /> WhatsApp
                            </Button>
                          )}
                          {c.lastWhatsappAt && (
                            <span className="text-xs text-muted-foreground hidden md:block">
                              Sent {new Date(c.lastWhatsappAt).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Deals Tab ── */}
          <TabsContent value="deals" className="mt-4">
            {Object.keys(dealsByStage).length === 0 ? (
              <Card className="bg-card border-border">
                <CardContent className="p-8 text-center text-muted-foreground">
                  <Briefcase className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p>No deals synced yet. Configure Twenty CRM and click Sync Now.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {Object.entries(dealsByStage).map(([stage, stageDeals]) => (
                  <Card key={stage} className="bg-card border-border">
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm font-semibold">{stageBadge(stage)}</CardTitle>
                        <span className="text-xs text-muted-foreground">{stageDeals.length} deal{stageDeals.length !== 1 ? "s" : ""}</span>
                      </div>
                      <div className="text-xs text-muted-foreground font-medium">
                        ${stageDeals.reduce((s, d) => s + Number(d.amount ?? 0), 0).toLocaleString()} total
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2 pt-0">
                      {stageDeals.map(d => (
                        <div key={d.id} className="rounded-lg bg-muted/50 border border-border p-3">
                          <div className="font-medium text-sm truncate">{d.name ?? "—"}</div>
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-xs text-muted-foreground">{d.currency ?? "USD"} {Number(d.amount ?? 0).toLocaleString()}</span>
                            {d.probability != null && (
                              <span className="text-xs text-primary font-medium">{d.probability}%</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* WhatsApp Send Dialog */}
      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent className="bg-card border-border max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-primary" />
              Send WhatsApp to {sendTarget?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
              <Phone className="w-4 h-4" />
              {sendTarget?.phone}
            </div>
            {templates.length > 0 && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground font-medium">Use Template (optional)</label>
                <select
                  className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  value={selectedTemplateId}
                  onChange={e => {
                    setSelectedTemplateId(e.target.value);
                    const t = templates.find((tmpl: { id: string }) => tmpl.id === e.target.value) as { id: string; bodyText: string; name: string } | undefined;
                    if (t) setSendMsg(t.bodyText
                      .replace(/\{\{customer_name\}\}/g, sendTarget?.name ?? "Customer")
                      .replace(/\{\{store_name\}\}/g, "My Store"));
                  }}
                >
                  <option value="">— Select a template —</option>
                  {templates.map((t: { id: string; name: string; category: string }) => (
                    <option key={t.id} value={t.id}>{t.name} ({t.category})</option>
                  ))}
                </select>
              </div>
            )}
            <textarea
              className="w-full bg-background border border-border rounded-lg p-3 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
              rows={4}
              placeholder="Type your WhatsApp message..."
              value={sendMsg}
              onChange={e => setSendMsg(e.target.value)}
            />
            <Button
              className="w-full bg-primary text-primary-foreground gap-2"
              disabled={!sendMsg.trim() || sendWhatsApp.isPending}
              onClick={() => sendTarget && sendWhatsApp.mutate({ contactId: sendTarget.id, message: sendMsg })}
            >
              {sendWhatsApp.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Send Message
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
