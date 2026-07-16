import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { CheckCircle, XCircle, Zap, Settings, ClipboardList, Activity, RefreshCw, MessageSquare, Smartphone, ShoppingCart } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

// ─── Status indicator ─────────────────────────────────────────────────────────
function ServiceBadge({ online }: { online: boolean }) {
  return online
    ? <Badge className="bg-emerald-600 text-white gap-1"><CheckCircle className="w-3 h-3" />Online</Badge>
    : <Badge variant="destructive" className="gap-1"><XCircle className="w-3 h-3" />Offline</Badge>;
}

// ─── PO status badge ──────────────────────────────────────────────────────────
function POStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    approved: "bg-emerald-100 text-emerald-800",
    rejected: "bg-red-100 text-red-800",
    sent: "bg-blue-100 text-blue-800",
  };
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${map[status] ?? "bg-gray-100 text-gray-700"}`}>{status}</span>;
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function HermesDashboard() {
  const { user } = useAuth();
  const tenantId = user?.tenantId ?? "";

  // Config state
  const [hermesUrl, setHermesUrl] = useState("");
  const [hermesKey, setHermesKey] = useState("");
  const [notifyPhone, setNotifyPhone] = useState("");
  const [autoApprove, setAutoApprove] = useState(0);
  const [active, setActive] = useState(true);
  const [wooUrl, setWooUrl] = useState("");
  const [wooKey, setWooKey] = useState("");
  const [wooSecret, setWooSecret] = useState("");

  // Queries
  const configQ = trpc.hermes.getConfig.useQuery({ tenantId }, { enabled: !!tenantId });
  useEffect(() => {
    const d = configQ.data;
    if (!d) return;
    setHermesUrl(d.hermesAgentUrl ?? "");
    setHermesKey(d.hermesApiKey ?? "");
    setNotifyPhone(d.notifyPhone ?? "");
    setAutoApprove(d.autoApproveBelow ?? 0);
    setActive(d.active);
    setWooUrl(d.woocommerceApiUrl ?? "");
    setWooKey(d.woocommerceKey ?? "");
    setWooSecret(d.woocommerceSecret ?? "");
  }, [configQ.data]);
  const statusQ = trpc.hermes.getStatus.useQuery(undefined, { refetchInterval: 30000 });
  const eventLogQ = trpc.hermes.getEventLog.useQuery({ tenantId, limit: 50, offset: 0 }, { enabled: !!tenantId });
  const poQueueQ = trpc.hermes.getPOQueue.useQuery({ tenantId }, { enabled: !!tenantId });

  // Mutations
  const saveConfig = trpc.hermes.saveConfig.useMutation({
    onSuccess: () => { toast.success("Hermes config saved"); configQ.refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const approvePO = trpc.hermes.approvePO.useMutation({
    onSuccess: () => { toast.success("PO approved — supplier email queued"); poQueueQ.refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const rejectPO = trpc.hermes.rejectPO.useMutation({
    onSuccess: () => { toast.success("PO rejected"); poQueueQ.refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const fireEvent = trpc.hermes.fireEvent.useMutation({
    onSuccess: (d) => toast.success(`Test event fired: ${d.eventId}`),
    onError: (e) => toast.error(e.message),
  });

  // Onboarding tour state
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStep, setTourStep] = useState(0);
  const completeTour = trpc.hermes.completeTour.useMutation({
    onSuccess: () => { configQ.refetch(); setTourOpen(false); },
    onError: (e) => toast.error(e.message),
  });
  // Show tour if config loaded and tourCompleted is false
  useEffect(() => {
    if (configQ.data && !configQ.data.tourCompleted) {
      setTourOpen(true);
    }
  }, [configQ.data]);
  const handleCompleteTour = () => {
    if (tenantId) completeTour.mutate({ tenantId });
    else setTourOpen(false);
  };

  const handleSave = () => {
    if (!tenantId) return;
    saveConfig.mutate({
      tenantId,
      hermesAgentUrl: hermesUrl || undefined,
      hermesApiKey: hermesKey || undefined,
      notifyPhone: notifyPhone || undefined,
      autoApproveBelow: autoApprove,
      active,
      woocommerceApiUrl: wooUrl || undefined,
      woocommerceKey: wooKey || undefined,
      woocommerceSecret: wooSecret || undefined,
    });
  };

  const TOUR_STEPS = [
    {
      icon: <MessageSquare className="h-8 w-8 text-emerald-400" />,
      title: "Welcome to Hermes Agent",
      desc: "Hermes is your AI-powered procurement assistant. It monitors inventory, generates Purchase Orders automatically, and lets you approve them directly from WhatsApp.",
    },
    {
      icon: <ShoppingCart className="h-8 w-8 text-blue-400" />,
      title: "Connect WooCommerce",
      desc: "Go to the Configuration tab and enter your WooCommerce API URL, Consumer Key, and Consumer Secret. Hermes will sync your product catalog and inventory levels automatically.",
    },
    {
      icon: <Smartphone className="h-8 w-8 text-purple-400" />,
      title: "Set Your Notify Phone",
      desc: "Enter your WhatsApp number in the Notify Phone field. When Hermes generates a PO, you'll receive a WhatsApp message with the details and APPROVE/REJECT reply instructions.",
    },
    {
      icon: <CheckCircle className="h-8 w-8 text-green-400" />,
      title: "Send the Setup Command",
      desc: "From your WhatsApp, send the message: hermes setup — to the platform number. This activates Hermes for your account and confirms the connection.",
    },
  ];

  return (
    <>
      {/* Onboarding Tour Modal */}
      <Dialog open={tourOpen} onOpenChange={setTourOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 text-lg">
              {TOUR_STEPS[tourStep]?.icon}
              {TOUR_STEPS[tourStep]?.title}
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground mt-2 leading-relaxed">
              {TOUR_STEPS[tourStep]?.desc}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between mt-4">
            <div className="flex gap-1.5">
              {TOUR_STEPS.map((_, i) => (
                <div key={i} className={`h-1.5 w-6 rounded-full transition-colors ${i === tourStep ? "bg-emerald-400" : "bg-muted"}`} />
              ))}
            </div>
            <div className="flex gap-2">
              {tourStep > 0 && (
                <Button variant="outline" size="sm" onClick={() => setTourStep(s => s - 1)}>Back</Button>
              )}
              {tourStep < TOUR_STEPS.length - 1 ? (
                <Button size="sm" onClick={() => setTourStep(s => s + 1)}>Next</Button>
              ) : (
                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={handleCompleteTour}>
                  Get Started
                </Button>
              )}
            </div>
          </div>
          <button
            className="absolute top-3 right-3 text-muted-foreground hover:text-foreground text-xs underline"
            onClick={handleCompleteTour}
          >
            Skip tour
          </button>
        </DialogContent>
      </Dialog>
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Zap className="w-6 h-6 text-violet-500" /> Hermes Agent Integration
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Autonomous inventory intelligence — PO generation, supplier email, WooCommerce sync
          </p>
        </div>
        <div className="flex items-center gap-3">
          {statusQ.isLoading ? <Skeleton className="h-6 w-24" /> : (
            <div className="flex gap-2">
              <span className="text-xs text-muted-foreground">Bridge:</span>
              <ServiceBadge online={statusQ.data?.bridge?.online ?? false} />
              <span className="text-xs text-muted-foreground ml-2">Skills:</span>
              <ServiceBadge online={statusQ.data?.skills?.online ?? false} />
            </div>
          )}
          <Button variant="outline" size="sm" onClick={() => statusQ.refetch()}>
            <RefreshCw className="w-3 h-3 mr-1" /> Refresh
          </Button>
        </div>
      </div>

      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config"><Settings className="w-3 h-3 mr-1" />Configuration</TabsTrigger>
          <TabsTrigger value="po">
            PO Queue
            {(poQueueQ.data?.length ?? 0) > 0 && (
              <span className="ml-1.5 bg-yellow-500 text-white text-xs rounded-full px-1.5">{poQueueQ.data?.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="events"><Activity className="w-3 h-3 mr-1" />Event Log</TabsTrigger>
          <TabsTrigger value="test"><ClipboardList className="w-3 h-3 mr-1" />Test</TabsTrigger>
        </TabsList>

        {/* ── Config tab ── */}
        <TabsContent value="config" className="space-y-4 pt-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Hermes Agent Connection</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Hermes Agent URL</Label>
                <Input placeholder="https://hermes.yourdomain.com" value={hermesUrl} onChange={e => setHermesUrl(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>API Key</Label>
                <Input type="password" placeholder="hms_..." value={hermesKey} onChange={e => setHermesKey(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Merchant Notify Phone (WhatsApp)</Label>
                <Input placeholder="+2348012345678" value={notifyPhone} onChange={e => setNotifyPhone(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Auto-approve POs below (₦)</Label>
                <Input type="number" min={0} value={autoApprove} onChange={e => setAutoApprove(Number(e.target.value))} />
                <p className="text-xs text-muted-foreground">POs below this amount are approved automatically without WhatsApp confirmation</p>
              </div>
              <div className="flex items-center gap-3 col-span-2">
                <Switch checked={active} onCheckedChange={setActive} />
                <Label>Integration active</Label>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">WooCommerce Sync (optional)</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label>WooCommerce API URL</Label>
                <Input placeholder="https://shop.example.com" value={wooUrl} onChange={e => setWooUrl(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Consumer Key</Label>
                <Input placeholder="ck_..." value={wooKey} onChange={e => setWooKey(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Consumer Secret</Label>
                <Input type="password" placeholder="cs_..." value={wooSecret} onChange={e => setWooSecret(e.target.value)} />
              </div>
            </CardContent>
          </Card>

          <Button onClick={handleSave} disabled={saveConfig.isPending}>
            {saveConfig.isPending ? "Saving…" : "Save Configuration"}
          </Button>
        </TabsContent>

        {/* ── PO Queue tab ── */}
        <TabsContent value="po" className="pt-4">
          {poQueueQ.isLoading ? (
            <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
          ) : !poQueueQ.data?.length ? (
            <div className="text-center py-12 text-muted-foreground">No pending purchase orders</div>
          ) : (
            <div className="space-y-3">
              {poQueueQ.data.map(po => (
                <Card key={po.poId}>
                  <CardContent className="pt-4 flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{po.productName}</span>
                        <span className="text-xs text-muted-foreground">SKU: {po.sku}</span>
                        <POStatusBadge status={po.status} />
                      </div>
                      <div className="text-sm text-muted-foreground mt-1">
                        Supplier: {po.supplierName} ({po.supplierEmail}) · Qty: {po.quantity} · {po.currency} {(po.totalCost / 100).toLocaleString()}
                      </div>
                      {po.note && <p className="text-xs mt-1 text-muted-foreground italic">{po.note}</p>}
                    </div>
                    {po.status === "pending" && (
                      <div className="flex gap-2 shrink-0">
                        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white"
                          disabled={approvePO.isPending}
                          onClick={() => approvePO.mutate({ poId: po.poId, approvalToken: po.approvalToken })}>
                          Approve
                        </Button>
                        <Button size="sm" variant="destructive"
                          disabled={rejectPO.isPending}
                          onClick={() => rejectPO.mutate({ poId: po.poId, approvalToken: po.approvalToken })}>
                          Reject
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Event Log tab ── */}
        <TabsContent value="events" className="pt-4">
          {eventLogQ.isLoading ? (
            <div className="space-y-2">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : !eventLogQ.data?.events.length ? (
            <div className="text-center py-12 text-muted-foreground">No events yet — fire a test event to get started</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b text-muted-foreground text-xs">
                  <th className="text-left py-2 pr-4">Time</th>
                  <th className="text-left py-2 pr-4">Event Type</th>
                  <th className="text-left py-2 pr-4">Skills</th>
                  <th className="text-left py-2 pr-4">Duration</th>
                  <th className="text-left py-2">Status</th>
                </tr></thead>
                <tbody>
                  {eventLogQ.data.events.map(ev => (
                    <tr key={ev.id} className="border-b hover:bg-muted/30">
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{new Date(ev.createdAt).toLocaleString()}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{ev.eventType}</td>
                      <td className="py-2 pr-4 text-xs">{ev.skillsTriggered ?? "—"}</td>
                      <td className="py-2 pr-4 text-xs">{ev.durationMs != null ? `${ev.durationMs}ms` : "—"}</td>
                      <td className="py-2">
                        {ev.success
                          ? <Badge className="bg-emerald-100 text-emerald-800 text-xs">OK</Badge>
                          : <Badge variant="destructive" className="text-xs">Error</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-muted-foreground mt-2">Showing {eventLogQ.data.events.length} of {eventLogQ.data.total} events</p>
            </div>
          )}
        </TabsContent>

        {/* ── Test tab ── */}
        <TabsContent value="test" className="pt-4 space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Fire Test Event</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Manually fire a platform event to the Hermes bridge to verify the integration end-to-end.
              </p>
              <div className="flex gap-2 flex-wrap">
                {["inventory.low_stock", "order.confirmed", "fraud.flagged", "inventory.reorder_triggered"].map(et => (
                  <Button key={et} variant="outline" size="sm"
                    disabled={fireEvent.isPending || !tenantId}
                    onClick={() => fireEvent.mutate({
                      tenantId,
                      eventType: et,
                      payload: { test: true, eventType: et, ts: Date.now() },
                    })}>
                    {et}
                  </Button>
                ))}
              </div>
              {fireEvent.isPending && <p className="text-sm text-muted-foreground">Firing event…</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Architecture Overview</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                {[
                  { lang: "TypeScript", role: "tRPC Bridge", color: "bg-blue-100 text-blue-800", desc: "Config, PO approval, event log" },
                  { lang: "Go", role: "Event Gateway", color: "bg-cyan-100 text-cyan-800", desc: "Kafka consumer → Hermes Cloud API" },
                  { lang: "Rust", role: "Message Router", color: "bg-orange-100 text-orange-800", desc: "Fan-out, circuit breaker, DLQ" },
                  { lang: "Python", role: "Skills Executor", color: "bg-yellow-100 text-yellow-800", desc: "PO gen, supplier email, WooCommerce sync" },
                ].map(s => (
                  <div key={s.lang} className="border rounded p-3 space-y-1">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${s.color}`}>{s.lang}</span>
                    <p className="font-medium mt-1">{s.role}</p>
                    <p className="text-muted-foreground">{s.desc}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
    </>
  );
}
