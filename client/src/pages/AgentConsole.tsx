import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { trpc } from "@/lib/trpc";
import { Activity, AlertTriangle, Bot, Clock, Cpu, Zap } from "lucide-react";


const INTENT_TYPES = [
  { label: "Browse / Search", value: 38, color: "bg-primary" },
  { label: "Add to Cart", value: 22, color: "bg-blue-500" },
  { label: "Checkout", value: 18, color: "bg-green-500" },
  { label: "Order Status", value: 12, color: "bg-yellow-500" },
  { label: "Support", value: 7, color: "bg-orange-500" },
  { label: "Handoff", value: 3, color: "bg-red-500" },
];

export default function AgentConsole() {
  const { activeTenantId: DEMO_TENANT } = useActiveTenant();
  const { data: stats } = trpc.agent.stats.useQuery({ tenantId: DEMO_TENANT });
  const { data: health } = trpc.agent.health.useQuery();

  const escalationRate = stats && stats.total > 0
    ? ((stats.escalated / stats.total) * 100).toFixed(1)
    : "0.0";

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">AI Agent Console</h1>
          <p className="text-muted-foreground mt-1">LangGraph orchestrator performance, intent distribution, and guardrail events</p>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: "Total Interactions", value: stats?.total?.toLocaleString() ?? "0", icon: Bot, color: "text-primary" },
            { label: "Escalations", value: stats?.escalated?.toLocaleString() ?? "0", icon: AlertTriangle, color: "text-yellow-400" },
            { label: "Avg Latency", value: `${stats?.avgLatency ?? 0}ms`, icon: Clock, color: "text-blue-400" },
            { label: "Escalation Rate", value: `${escalationRate}%`, icon: Activity, color: "text-orange-400" },
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

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Intent Distribution */}
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Zap className="w-4 h-4 text-primary" />
                Intent Distribution
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {INTENT_TYPES.map((intent) => (
                <div key={intent.label} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-foreground">{intent.label}</span>
                    <span className="text-muted-foreground font-mono">{intent.value}%</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-1.5">
                    <div className={`${intent.color} h-1.5 rounded-full transition-all duration-700`} style={{ width: `${intent.value}%` }} />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Service Health */}
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Cpu className="w-4 h-4 text-primary" />
                Service Health
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {health && health.length > 0 ? health.map((svc) => (
                <div key={svc.serviceName} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${
                      svc.status === "healthy" ? "bg-green-400" :
                      svc.status === "degraded" ? "bg-yellow-400" :
                      svc.status === "down" ? "bg-red-400" : "bg-gray-400"
                    }`} />
                    <span className="text-sm font-medium">{svc.serviceName}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {svc.latencyMs && <span className="text-xs text-muted-foreground font-mono">{svc.latencyMs}ms</span>}
                    <Badge variant="outline" className={
                      svc.status === "healthy" ? "bg-green-500/20 text-green-400 border-green-500/30" :
                      svc.status === "degraded" ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" :
                      "bg-red-500/20 text-red-400 border-red-500/30"
                    }>{svc.status}</Badge>
                  </div>
                </div>
              )) : (
                <div className="text-center text-muted-foreground py-8">
                  <Cpu className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">No health data yet</p>
                  <p className="text-xs mt-1">Services will appear once health checks run</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Agent Architecture Info */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Bot className="w-4 h-4 text-primary" />
              Agent Architecture
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { title: "Orchestrator", desc: "LangGraph state machine with intent routing, tool dispatch, and memory management", status: "active", lang: "Python" },
                { title: "Guardrails", desc: "PII redaction, injection detection, sentiment escalation, topic boundary enforcement", status: "active", lang: "Python" },
                { title: "Commerce Tools", desc: "Product search, cart management, checkout, order status via Go Commerce Engine", status: "active", lang: "Python → Go" },
              ].map((item) => (
                <div key={item.title} className="p-4 rounded-lg bg-accent/30 border border-border space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-sm">{item.title}</h3>
                    <Badge variant="outline" className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">{item.status}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{item.desc}</p>
                  <Badge variant="outline" className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-xs font-mono">{item.lang}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
