import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { Bot, MessageSquare, Users, AlertTriangle } from "lucide-react";
import { useState, useEffect } from "react";
import { useConversationsWS } from "@/hooks/useConversationsWS";
import { Button } from "@/components/ui/button";
import { Wifi, WifiOff, Radio, X } from "lucide-react";


const statusColors: Record<string, string> = {
  open: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  resolved: "bg-green-500/20 text-green-400 border-green-500/30",
  pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  snoozed: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  bot_active: "bg-primary/20 text-primary border-primary/30",
  human_active: "bg-purple-500/20 text-purple-400 border-purple-500/30",
};

export default function Conversations() {
  const { activeTenantId: DEMO_TENANT } = useActiveTenant();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const { data: stats } = trpc.conversation.stats.useQuery({ tenantId: DEMO_TENANT });
  const { data: convList, isLoading, refetch } = trpc.conversation.list.useQuery({
    tenantId: DEMO_TENANT,
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 50,
  });

  const { wsState, events, clearEvents } = useConversationsWS(DEMO_TENANT);

  // Refetch conversation list when a WS event arrives
  useEffect(() => {
    if (events.length > 0) {
      refetch();
    }
  }, [events.length]);

  const { data: deliveryMetrics } = trpc.deliveryReceipts.getMetrics.useQuery(
    { tenantId: DEMO_TENANT, days: 7 },
    { enabled: !!DEMO_TENANT }
  );
  const wsConnected = wsState === "connected";
  const wsConnecting = wsState === "connecting";

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Conversations</h1>
            <p className="text-muted-foreground mt-1">Live WhatsApp conversation monitor</p>
          </div>
          {/* WebSocket live indicator */}
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
            wsConnected ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
            : wsConnecting ? "bg-blue-500/10 border-blue-500/30 text-blue-400"
            : "bg-red-500/10 border-red-500/30 text-red-400"
          }`}>
            {wsConnected ? (
              <><span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" /><Wifi className="w-3.5 h-3.5" />Live</>
            ) : wsConnecting ? (
              <><span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" /><Radio className="w-3.5 h-3.5" />Connecting…</>
            ) : (
              <><WifiOff className="w-3.5 h-3.5" />Disconnected</>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: "Total", value: stats?.total ?? 0, icon: MessageSquare, color: "text-foreground" },
            { label: "Bot Active", value: stats?.botActive ?? 0, icon: Bot, color: "text-primary" },
            { label: "Human Active", value: stats?.humanActive ?? 0, icon: Users, color: "text-purple-400" },
            { label: "Escalated", value: stats?.escalated ?? 0, icon: AlertTriangle, color: "text-yellow-400" },
          ].map((s) => (
            <Card key={s.label} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">{s.label}</p>
                    <p className={`text-2xl font-bold mt-1 ${s.color}`}>{s.value}</p>
                  </div>
                  <s.icon className={`w-8 h-8 ${s.color} opacity-60`} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-48 bg-card border-border"><SelectValue placeholder="Filter by status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="bot_active">Bot Active</SelectItem>
              <SelectItem value="human_active">Human Active</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Real-time event feed */}
        {events.length > 0 && (
          <Card className="border-emerald-500/20 bg-emerald-500/5">
            <CardHeader className="pb-2 pt-3 px-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-xs font-medium text-emerald-400 flex items-center gap-2">
                  <Radio className="w-3.5 h-3.5 animate-pulse" />
                  Live Events ({events.length})
                </CardTitle>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={clearEvents}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-3 space-y-1 max-h-32 overflow-y-auto">
              {events.slice(0, 8).map((evt, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                  <span className="font-mono text-emerald-400">{evt.type.replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground/60">conv {(evt.conversationId ?? "").slice(0, 8)}</span>
                  <span className="ml-auto">{new Date(evt.timestamp).toLocaleTimeString()}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Live Conversations</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Flow Step</TableHead>
                  <TableHead>Last Intent</TableHead>
                  <TableHead>Messages</TableHead>
                  <TableHead>AI</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">Loading conversations...</TableCell></TableRow>
                ) : convList?.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No conversations found</TableCell></TableRow>
                ) : convList?.map((c) => (
                  <TableRow key={c.id} className="border-border hover:bg-accent/30">
                    <TableCell className="font-mono text-xs">{c.id.slice(0, 8)}...</TableCell>
                    <TableCell><Badge variant="outline" className={statusColors[c.status] ?? ""}>{c.status}</Badge></TableCell>
                    <TableCell className="text-muted-foreground text-xs">{c.channel}</TableCell>
                    <TableCell className="font-mono text-xs">{c.currentFlowStep ?? "—"}</TableCell>
                    <TableCell className="text-xs">{c.lastIntent ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{c.messageCount}</TableCell>
                    <TableCell><Badge variant="outline" className={c.aiHandled ? "bg-primary/20 text-primary border-primary/30" : "bg-muted text-muted-foreground"}>{c.aiHandled ? "AI" : "Human"}</Badge></TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatDistanceToNow(new Date(c.updatedAt), { addSuffix: true })}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        {/* Delivery Metrics */}
        {deliveryMetrics && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-primary" />
                Message Delivery Metrics (Last 7 Days)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-400">{deliveryMetrics.deliveryRate}%</div>
                  <div className="text-xs text-muted-foreground mt-1">Delivery Rate</div>
                  <div className="text-xs text-muted-foreground">{deliveryMetrics.delivered + deliveryMetrics.read} / {deliveryMetrics.total} msgs</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-blue-400">{deliveryMetrics.readRate}%</div>
                  <div className="text-xs text-muted-foreground mt-1">Read Rate</div>
                  <div className="text-xs text-muted-foreground">{deliveryMetrics.read} read</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-red-400">{deliveryMetrics.failureRate}%</div>
                  <div className="text-xs text-muted-foreground mt-1">Failure Rate</div>
                  <div className="text-xs text-muted-foreground">{deliveryMetrics.failed} failed</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold">{deliveryMetrics.total}</div>
                  <div className="text-xs text-muted-foreground mt-1">Total Messages</div>
                  <div className="text-xs text-muted-foreground">{deliveryMetrics.sent} sent</div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
