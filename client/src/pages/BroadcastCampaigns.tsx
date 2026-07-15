import { useState, useMemo } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  FlaskConical, Trophy, Split
} from "lucide-react";
import {
  Send, Users, CheckCircle2, Eye, XCircle, Clock, Radio,
  Plus, BarChart3, Megaphone, ChevronRight, Play, Ban,
  TrendingUp, MessageSquare, Loader2
} from "lucide-react";
import { MessageCircle } from "lucide-react";
import { FlaskConical as SimIcon } from "lucide-react";

const statusColors: Record<string, string> = {
  draft: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  scheduled: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  sending: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  completed: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  cancelled: "bg-red-500/15 text-red-400 border-red-500/30",
  failed: "bg-red-500/15 text-red-400 border-red-500/30",
};

const statusIcons: Record<string, React.ReactNode> = {
  draft: <Clock className="w-3 h-3" />,
  scheduled: <Clock className="w-3 h-3" />,
  sending: <Radio className="w-3 h-3 animate-pulse" />,
  completed: <CheckCircle2 className="w-3 h-3" />,
  cancelled: <XCircle className="w-3 h-3" />,
  failed: <XCircle className="w-3 h-3" />,
};

const segmentLabels: Record<string, string> = {
  all: "All Contacts",
  new_contacts: "New Contacts",
  recent_orders: "Recent Orders",
  overdue_invoices: "Overdue Invoices",
  shipped_orders: "Shipped Orders",
  vip_customers: "VIP Customers",
  custom: "Custom Segment",
};

type Campaign = {
  id: string;
  name: string;
  status: string;
  segment: string | null;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  createdAt: Date;
  completedAt: Date | null;
};

function DeliveryBar({ campaign }: { campaign: Campaign }) {
  const total = campaign.totalRecipients || 1;
  const deliveryRate = Math.round((campaign.deliveredCount / total) * 100);
  const readRate = Math.round((campaign.readCount / total) * 100);
  const failRate = Math.round((campaign.failedCount / total) * 100);

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Delivery {deliveryRate}%</span>
        <span>Read {readRate}%</span>
        <span className="text-red-400">Failed {failRate}%</span>
      </div>
      <div className="h-2 bg-muted/30 rounded-full overflow-hidden flex">
        <div className="bg-emerald-500 h-full transition-all" style={{ width: `${deliveryRate}%` }} />
        <div className="bg-blue-500 h-full transition-all" style={{ width: `${Math.max(0, readRate - deliveryRate)}%` }} />
        <div className="bg-red-500/60 h-full transition-all" style={{ width: `${failRate}%` }} />
      </div>
      <div className="flex gap-4 text-xs">
        <span className="flex items-center gap-1 text-muted-foreground">
          <Send className="w-3 h-3 text-blue-400" />{campaign.sentCount.toLocaleString()} sent
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          <CheckCircle2 className="w-3 h-3 text-emerald-400" />{campaign.deliveredCount.toLocaleString()} delivered
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          <Eye className="w-3 h-3 text-blue-400" />{campaign.readCount.toLocaleString()} read
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          <XCircle className="w-3 h-3 text-red-400" />{campaign.failedCount.toLocaleString()} failed
        </span>
      </div>
    </div>
  );
}

export default function BroadcastCampaigns() {
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewCampaignId, setPreviewCampaignId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newSegment, setNewSegment] = useState("all");
  const [newTemplateId, setNewTemplateId] = useState("");
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [abTestOpen, setAbTestOpen] = useState(false);
  const [abVariantA, setAbVariantA] = useState("");
  const [abVariantB, setAbVariantB] = useState("");
  const [abSplit, setAbSplit] = useState("50");
  const [abCriteria, setAbCriteria] = useState<"read_rate" | "delivery_rate">("read_rate");
  const [abDuration, setAbDuration] = useState("24");

  const { data: campaignsData, isLoading, refetch } = trpc.broadcast.list.useQuery({});
  const campaigns = (campaignsData?.campaigns ?? []) as Campaign[];

  const { data: statsData } = trpc.broadcast.stats.useQuery();
  const stats = statsData ?? { totalCampaigns: 0, totalSent: 0, avgDeliveryRate: 0, avgReadRate: 0 };

  const { data: templatesData } = trpc.template.list.useQuery({});
  const templates = templatesData?.templates ?? [];

  const { data: detailData } = trpc.broadcast.get.useQuery(
    { id: selectedId ?? "" },
    { enabled: !!selectedId }
  );

  const { data: abResults } = trpc.broadcastAb.getAbResults.useQuery(
    { campaignId: selectedId ?? "" },
    { enabled: !!selectedId }
  );

  const createAbTest = trpc.broadcastAb.createAbTest.useMutation({
    onSuccess: () => {
      toast.success("A/B test created — campaign will split recipients between variants");
      setAbTestOpen(false);
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const autoSelectWinner = trpc.broadcastAb.autoSelectWinner.useMutation({
    onSuccess: (data) => {
      toast.success(`Winner auto-selected: Variant ${data.winner}`);
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });


  const createCampaign = trpc.broadcast.create.useMutation({
    onSuccess: () => {
      toast.success("Campaign created");
      setCreateOpen(false);
      setNewName("");
      setNewSegment("all");
      setNewTemplateId("");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const sendCampaign = trpc.broadcast.send.useMutation({
    onSuccess: (data) => {
      toast.success(`Campaign sent to ${data.total} recipients — ${data.delivered} delivered, ${data.read} read`);
      setSendingId(null);
      refetch();
    },
    onError: (e) => {
      toast.error(e.message);
      setSendingId(null);
    },
  });

  const cancelCampaign = trpc.broadcast.cancel.useMutation({
    onSuccess: () => {
      toast.success("Campaign cancelled");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const simulateDelivery = trpc.broadcast.simulateDelivery.useMutation({
    onSuccess: (data) => {
      const rate = data.total > 0 ? Math.round((data.delivered / data.total) * 100) : 0;
      toast.success(`Simulation complete — ${data.delivered}/${data.total} delivered (${rate}%), ${data.read} read`);
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const handleSend = (campaignId: string) => {
    const campaign = campaigns.find(c => c.id === campaignId);
    if (campaign) {
      setPreviewCampaignId(campaignId);
      setPreviewOpen(true);
    } else {
      setSendingId(campaignId);
      sendCampaign.mutate({ campaignId });
    }
  };

  const selectedCampaign = campaigns.find(c => c.id === selectedId);
  const confirmSend = () => {
    if (!previewCampaignId) return;
    setPreviewOpen(false);
    setSendingId(previewCampaignId);
    sendCampaign.mutate({ campaignId: previewCampaignId });
    setPreviewCampaignId(null);
  };
  const previewCampaign = campaigns.find(c => c.id === previewCampaignId);
  const previewTemplate = templates.find(t => t.id === (previewCampaign as any)?.templateId);
  const previewRendered = (() => {
    if (!previewTemplate) return "(No template body)";
    const body = (previewTemplate as any).bodyText ?? "";
    const varMap = ((previewCampaign as any)?.varMapping ?? {}) as Record<string, string>;
    let rendered = body;
    Object.entries(varMap).forEach(([k, v]) => {
      rendered = rendered.split("{{" + k + "}}").join(v || "{{" + k + "}}");
    });
    return rendered;
  })();

  return (
    <>
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Megaphone className="w-6 h-6 text-primary" />
              Broadcast Campaigns
            </h1>
            <p className="text-muted-foreground mt-1">
              Send bulk WhatsApp messages to segmented contact lists with delivery tracking
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            New Campaign
          </Button>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: "Total Campaigns", value: stats.totalCampaigns, icon: <Megaphone className="w-4 h-4" />, color: "text-primary" },
            { label: "Total Sent", value: stats.totalSent.toLocaleString(), icon: <Send className="w-4 h-4" />, color: "text-blue-400" },
            { label: "Avg Delivery Rate", value: `${stats.avgDeliveryRate}%`, icon: <CheckCircle2 className="w-4 h-4" />, color: "text-emerald-400" },
            { label: "Avg Read Rate", value: `${stats.avgReadRate}%`, icon: <Eye className="w-4 h-4" />, color: "text-amber-400" },
          ].map(s => (
            <Card key={s.label} className="border-border/50 bg-card/50">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-muted-foreground">{s.label}</span>
                  <span className={s.color}>{s.icon}</span>
                </div>
                <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-12 gap-6">
          {/* Campaign List */}
          <div className="col-span-5">
            <Card className="border-border/50 bg-card/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Campaigns ({campaigns.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[480px]">
                  {isLoading ? (
                    <div className="p-4 space-y-3">
                      {[1, 2, 3].map(i => (
                        <div key={i} className="h-24 bg-muted/30 rounded-lg animate-pulse" />
                      ))}
                    </div>
                  ) : campaigns.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">
                      <Megaphone className="w-10 h-10 mx-auto mb-3 opacity-30" />
                      <p className="font-medium">No campaigns yet</p>
                      <Button size="sm" variant="outline" className="mt-3" onClick={() => setCreateOpen(true)}>
                        Create First Campaign
                      </Button>
                    </div>
                  ) : (
                    <div className="divide-y divide-border/30">
                      {campaigns.map(c => (
                        <button
                          key={c.id}
                          onClick={() => setSelectedId(c.id)}
                          className={`w-full text-left px-4 py-3 transition-colors hover:bg-muted/30 ${
                            selectedId === c.id ? "bg-primary/10 border-l-2 border-primary" : ""
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="font-medium text-sm text-foreground">{c.name}</span>
                            <Badge variant="outline" className={`text-xs gap-1 ${statusColors[c.status] ?? ""}`}>
                              {statusIcons[c.status]}
                              {c.status}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground mb-2">
                            <span className="flex items-center gap-1">
                              <Users className="w-3 h-3" />
                              {segmentLabels[c.segment ?? "all"] ?? c.segment}
                            </span>
                            <span>{c.totalRecipients.toLocaleString()} recipients</span>
                          </div>
                          {c.status === "completed" && (
                            <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden flex">
                              <div className="bg-emerald-500 h-full" style={{ width: `${Math.round((c.deliveredCount / Math.max(c.totalRecipients, 1)) * 100)}%` }} />
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* Campaign Detail */}
          <div className="col-span-7">
            {!selectedCampaign ? (
              <Card className="border-border/50 bg-card/50 h-[560px] flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <BarChart3 className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p className="font-medium">Select a campaign</p>
                  <p className="text-sm mt-1">Choose a campaign to view delivery analytics</p>
                </div>
              </Card>
            ) : (
              <Card className="border-border/50 bg-card/50">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-base font-semibold">{selectedCampaign.name}</CardTitle>
                      <div className="flex items-center gap-2 mt-1.5">
                        <Badge variant="outline" className={`text-xs gap-1 ${statusColors[selectedCampaign.status] ?? ""}`}>
                          {statusIcons[selectedCampaign.status]}
                          {selectedCampaign.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {segmentLabels[selectedCampaign.segment ?? "all"] ?? selectedCampaign.segment}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {(selectedCampaign.status === "draft" || selectedCampaign.status === "scheduled") && (
                        <Button
                          size="sm"
                          className="gap-1.5 bg-emerald-600 hover:bg-emerald-700"
                          onClick={() => handleSend(selectedCampaign.id)}
                          disabled={sendingId === selectedCampaign.id}
                        >
                          {sendingId === selectedCampaign.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Play className="w-3.5 h-3.5" />
                          )}
                          {sendingId === selectedCampaign.id ? "Sending…" : "Send Now"}
                        </Button>
                      )}
                      {(selectedCampaign.status === "draft" || selectedCampaign.status === "scheduled") && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 border-violet-500/30 text-violet-400 hover:bg-violet-500/10"
                          onClick={() => simulateDelivery.mutate({ campaignId: selectedCampaign.id })}
                          disabled={simulateDelivery.isPending}
                        >
                          {simulateDelivery.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <SimIcon className="w-3.5 h-3.5" />}
                          {simulateDelivery.isPending ? "Simulating…" : "Simulate"}
                        </Button>
                      )}
                      {selectedCampaign.status === "sending" && (
                        <Button
                          size="sm"
                          variant="destructive"
                          className="gap-1.5"
                          onClick={() => cancelCampaign.mutate({ campaignId: selectedCampaign.id })}
                        >
                          <Ban className="w-3.5 h-3.5" />
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <Separator />
                <CardContent className="p-4 space-y-5">
                  {/* Delivery Stats */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Delivery Analytics</h3>
                    <DeliveryBar campaign={selectedCampaign} />
                  </div>

                  {/* Funnel */}
                  <div className="grid grid-cols-4 gap-3">
                    {[
                      { label: "Total", value: selectedCampaign.totalRecipients, icon: <Users className="w-4 h-4" />, color: "text-foreground" },
                      { label: "Sent", value: selectedCampaign.sentCount, icon: <Send className="w-4 h-4" />, color: "text-blue-400" },
                      { label: "Delivered", value: selectedCampaign.deliveredCount, icon: <CheckCircle2 className="w-4 h-4" />, color: "text-emerald-400" },
                      { label: "Read", value: selectedCampaign.readCount, icon: <Eye className="w-4 h-4" />, color: "text-amber-400" },
                    ].map(s => (
                      <div key={s.label} className="bg-muted/20 rounded-lg p-3 text-center border border-border/30">
                        <div className={`flex justify-center mb-1 ${s.color}`}>{s.icon}</div>
                        <p className={`text-xl font-bold ${s.color}`}>{s.value.toLocaleString()}</p>
                        <p className="text-xs text-muted-foreground">{s.label}</p>
                      </div>
                    ))}
                  </div>

                  {/* Recipient Sample */}
                  {detailData?.recipients && detailData.recipients.length > 0 && (
                    <div>
                      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                        Recipients Sample ({detailData.recipients.length})
                      </h3>
                      <ScrollArea className="h-[200px]">
                        <div className="space-y-2">
                          {detailData.recipients.slice(0, 10).map(r => (
                            <div key={r.id} className="flex items-center justify-between bg-muted/10 rounded-lg px-3 py-2 border border-border/20">
                              <div className="flex items-center gap-2">
                                <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold text-primary">
                                  {(r.name ?? r.phone).charAt(0).toUpperCase()}
                                </div>
                                <div>
                                  <p className="text-xs font-medium text-foreground">{r.name ?? "Unknown"}</p>
                                  <p className="text-xs text-muted-foreground">{r.phone}</p>
                                </div>
                              </div>
                              <Badge variant="outline" className={`text-xs gap-1 ${statusColors[r.status] ?? ""}`}>
                                {statusIcons[r.status]}
                                {r.status}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  )}

                  {/* Timestamps */}
                  <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t border-border/30">
                    <p>Created: {new Date(selectedCampaign.createdAt).toLocaleString()}</p>
                    {selectedCampaign.completedAt && (
                      <p>Completed: {new Date(selectedCampaign.completedAt).toLocaleString()}</p>
                    )}
                  </div>

                  {/* A/B Test Panel */}
                  {abResults ? (
                    <div className="border border-violet-500/20 bg-violet-500/5 rounded-xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-violet-400 flex items-center gap-2">
                          <FlaskConical className="w-4 h-4" />
                          A/B Test Results
                        </h3>
                        {abResults.isComplete && !abResults.hasWinner && (
                          <Button
                            size="sm" variant="outline"
                            className="gap-1.5 border-violet-500/30 text-violet-400 hover:bg-violet-500/10"
                            onClick={() => autoSelectWinner.mutate({ abTestId: abResults.id })}
                            disabled={autoSelectWinner.isPending}
                          >
                            <Trophy className="w-3.5 h-3.5" />
                            Auto-Select Winner
                          </Button>
                        )}
                        {abResults.hasWinner && (
                          <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 gap-1">
                            <Trophy className="w-3 h-3" />
                            Winner: Variant {abResults.winnerVariant}
                          </Badge>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        {[
                          { label: abResults.variantAName, sent: abResults.variantASent, delivered: abResults.variantADelivered, read: abResults.variantARead, readRate: abResults.variantAReadRate, deliveryRate: abResults.variantADeliveryRate, isWinner: abResults.winnerVariant === "A" },
                          { label: abResults.variantBName, sent: abResults.variantBSent, delivered: abResults.variantBDelivered, read: abResults.variantBRead, readRate: abResults.variantBReadRate, deliveryRate: abResults.variantBDeliveryRate, isWinner: abResults.winnerVariant === "B" },
                        ].map((v, i) => (
                          <div key={i} className={`rounded-lg p-3 border ${v.isWinner ? "bg-amber-500/10 border-amber-500/30" : "bg-muted/20 border-border/30"}`}>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs font-semibold text-foreground">{v.label}</span>
                              {v.isWinner && <Trophy className="w-3.5 h-3.5 text-amber-400" />}
                            </div>
                            <div className="space-y-1.5 text-xs">
                              <div className="flex justify-between text-muted-foreground"><span>Sent</span><span className="font-mono">{v.sent}</span></div>
                              <div className="flex justify-between text-muted-foreground"><span>Delivered</span><span className="font-mono text-emerald-400">{v.delivered} ({v.deliveryRate}%)</span></div>
                              <div className="flex justify-between text-muted-foreground"><span>Read</span><span className="font-mono text-amber-400">{v.read} ({v.readRate}%)</span></div>
                            </div>
                            <Progress value={v.readRate} className="mt-2 h-1.5" />
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Criteria: <span className="text-violet-400">{abResults.winnerCriteria.replace("_", " ")}</span>
                        {abResults.testEndAt && (
                          <> · Test ends {new Date(abResults.testEndAt).toLocaleString()}</>
                        )}
                      </p>
                    </div>
                  ) : selectedCampaign.status === "draft" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full gap-2 border-violet-500/30 text-violet-400 hover:bg-violet-500/10"
                      onClick={() => setAbTestOpen(true)}
                    >
                      <Split className="w-4 h-4" />
                      Set Up A/B Test
                    </Button>
                  )}
</CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* Create Campaign Dialog */}
      {/* A/B Test Dialog */}
      <Dialog open={abTestOpen} onOpenChange={setAbTestOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="w-4 h-4 text-violet-400" />
              Set Up A/B Test
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Split this campaign's recipients between two message templates. The winner is selected automatically based on your chosen metric.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Variant A Template</Label>
                <Select value={abVariantA} onValueChange={setAbVariantA}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    {templates.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Variant B Template</Label>
                <Select value={abVariantB} onValueChange={setAbVariantB}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    {templates.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Split Ratio (% to Variant A)</Label>
                <Input type="number" min={10} max={90} value={abSplit} onChange={e => setAbSplit(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Winner Criteria</Label>
                <Select value={abCriteria} onValueChange={(v) => setAbCriteria(v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read_rate">Read Rate</SelectItem>
                    <SelectItem value="delivery_rate">Delivery Rate</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Test Duration (hours)</Label>
              <Input type="number" min={1} max={168} value={abDuration} onChange={e => setAbDuration(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAbTestOpen(false)}>Cancel</Button>
            <Button
              className="bg-violet-600 hover:bg-violet-700"
              disabled={!abVariantA || !abVariantB || createAbTest.isPending}
              onClick={() => createAbTest.mutate({
                campaignId: selectedId!,
                tenantId: "demo-tenant-1",
                variantATemplateId: abVariantA,
                variantBTemplateId: abVariantB,
                splitRatio: parseInt(abSplit),
                winnerCriteria: abCriteria,
                testDurationHours: parseInt(abDuration),
              })}
            >
              {createAbTest.isPending ? "Creating…" : "Create A/B Test"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Megaphone className="w-4 h-4 text-primary" />
              Create Broadcast Campaign
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Campaign Name</Label>
              <Input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. July Flash Sale, Payment Reminder"
              />
            </div>
            <div className="space-y-2">
              <Label>Contact Segment</Label>
              <Select value={newSegment} onValueChange={setNewSegment}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(segmentLabels).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Recipients will be pulled from your Twenty CRM contacts matching this segment
              </p>
            </div>
            <div className="space-y-2">
              <Label>Message Template (optional)</Label>
              <Select value={newTemplateId} onValueChange={setNewTemplateId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a template…" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map(t => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} <span className="text-muted-foreground ml-1">({t.category})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Variable substitution preview */}
            {newTemplateId && (() => {
              const tpl = templates.find(t => t.id === newTemplateId);
              if (!tpl) return null;
              const vars = (tpl.bodyText.match(/\{\{[^}]+\}\}/g) ?? []).map(v => v.slice(2, -2));
              if (vars.length === 0) return null;
              return (
                <div className="bg-muted/20 rounded-lg p-3 border border-border/30">
                  <p className="text-xs font-semibold text-muted-foreground mb-2">Variables to substitute per recipient:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {vars.map(v => (
                      <Badge key={v} variant="outline" className="text-xs font-mono text-primary border-primary/30">
                        {`{{${v}}}`}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Values will be auto-filled from contact data (name, order number, amount, etc.)
                  </p>
                </div>
              );
            })()}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={() => createCampaign.mutate({
                tenantId: "demo-tenant-1",
                name: newName,
                templateId: newTemplateId || undefined,
                segment: newSegment as "all" | "new_contacts" | "recent_orders" | "overdue_invoices" | "shipped_orders" | "vip_customers" | "custom",
              })}
              disabled={createCampaign.isPending || !newName.trim()}
            >
              {createCampaign.isPending ? "Creating…" : "Create Campaign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>

      {/* Send Preview Modal */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-emerald-400" />
              Preview Before Sending
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Review how the message will appear after variable substitution before sending to{" "}
              <strong>{previewCampaign?.totalRecipients ?? 0}</strong> contacts.
            </p>
            <div className="bg-[#0a1628] rounded-xl p-4 border border-border/30">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
                  <MessageCircle className="w-4 h-4 text-emerald-400" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-foreground">{previewCampaign?.name ?? "Campaign"}</p>
                  <p className="text-xs text-muted-foreground">WhatsApp Business</p>
                </div>
              </div>
              <div className="bg-[#1a2a1a] rounded-lg rounded-tl-none px-3 py-2.5 max-w-[85%] border border-emerald-900/30">
                <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{previewRendered}</p>
                <p className="text-[10px] text-muted-foreground text-right mt-1.5">
                  {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ✓✓
                </p>
              </div>
            </div>
            {(previewCampaign?.totalRecipients ?? 0) === 0 && (
              <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                <span className="text-amber-400 text-sm">⚠</span>
                <p className="text-xs text-amber-300">No recipients loaded yet. The campaign will build the recipient list on send.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>Cancel</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700 gap-1.5" onClick={confirmSend}>
              <Send className="w-3.5 h-3.5" />
              Confirm & Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
