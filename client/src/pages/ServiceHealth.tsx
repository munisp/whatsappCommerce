import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Activity, CheckCircle, Server, XCircle } from "lucide-react";
import { useState, useEffect } from "react";

// Mini sparkline component using SVG
function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (!values.length) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const w = 80; const h = 24;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1 || 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const SERVICES = [
  { name: "API Gateway", lang: "Go", port: 8080, desc: "APISIX-style reverse proxy, rate limiting, JWT validation" },
  { name: "Webhook Ingestor", lang: "Go", port: 8081, desc: "Chatwoot webhook verification, event parsing, Kafka producer" },
  { name: "WhatsApp Webhook", lang: "TypeScript", port: 3000, desc: "Meta Business API webhook — GET verification + POST message/media ingestion at /api/webhooks/whatsapp" },
  { name: "Conversation Orchestrator", lang: "Go", port: 8082, desc: "Session resolution, intent routing, menu engine, handoff manager" },
  { name: "Commerce Engine", lang: "Go", port: 8083, desc: "Catalog, cart, checkout, orders, inventory projections" },
  { name: "Payment Orchestrator", lang: "Go", port: 8084, desc: "Mojaloop/Stripe integration, idempotent payment workflows" },
  { name: "AI Agent", lang: "Python", port: 8090, desc: "LangGraph orchestrator, NLU, guardrails, tool registry" },
  { name: "Event Processor", lang: "Rust", port: 8091, desc: "Kafka consumer, exactly-once semantics, event routing" },
  { name: "Ledger Bridge", lang: "Rust", port: 8095, desc: "TigerBeetle two-phase financial accounting bridge" },
  { name: "Recon Worker", lang: "Rust", port: 8096, desc: "Periodic financial reconciliation, discrepancy detection" },
  { name: "Admin Dashboard", lang: "TypeScript", port: 3000, desc: "React 19 + tRPC + Tailwind 4 operator console" },
];

const langColors: Record<string, string> = {
  Go: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  Rust: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  Python: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  TypeScript: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
};

export default function ServiceHealth() {
  const { data: health } = trpc.agent.health.useQuery();
  // Simulate latency history per service (last 8 checks)
  const [latencyHistory, setLatencyHistory] = useState<Record<string, number[]>>({});

  useEffect(() => {
    if (!health) return;
    setLatencyHistory(prev => {
      const next = { ...prev };
      for (const h of health) {
        if (h.latencyMs != null) {
          const existing = prev[h.serviceName] ?? [];
          next[h.serviceName] = [...existing.slice(-7), h.latencyMs];
        }
      }
      return next;
    });
  }, [health]);

  const healthMap = new Map((health ?? []).map((h) => [h.serviceName, h]));

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Service Health</h1>
          <p className="text-muted-foreground mt-1">Real-time status of all platform microservices</p>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Total Services", value: SERVICES.length, icon: Server, color: "text-foreground" },
            { label: "Healthy", value: (health ?? []).filter((h) => h.status === "healthy").length, icon: CheckCircle, color: "text-green-400" },
            { label: "Issues", value: (health ?? []).filter((h) => h.status !== "healthy").length, icon: XCircle, color: "text-red-400" },
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

        {/* Service Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {SERVICES.map((svc) => {
            const h = healthMap.get(svc.name);
            const status = h?.status ?? "unknown";
            return (
              <Card key={svc.name} className="bg-card border-border">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-3 h-3 rounded-full flex-shrink-0 mt-0.5 ${
                        status === "healthy" ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]" :
                        status === "degraded" ? "bg-yellow-400" :
                        status === "down" ? "bg-red-400" : "bg-gray-500"
                      }`} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold text-sm">{svc.name}</h3>
                          <Badge variant="outline" className={`text-xs ${langColors[svc.lang] ?? ""}`}>{svc.lang}</Badge>
                          <span className="text-xs text-muted-foreground font-mono">:{svc.port}</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 truncate">{svc.desc}</p>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <Badge variant="outline" className={
                        status === "healthy" ? "bg-green-500/20 text-green-400 border-green-500/30" :
                        status === "degraded" ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" :
                        status === "down" ? "bg-red-500/20 text-red-400 border-red-500/30" :
                        "bg-gray-500/20 text-gray-400 border-gray-500/30"
                      }>{status}</Badge>
                      {h?.latencyMs && <span className="text-xs text-muted-foreground font-mono">{h.latencyMs}ms</span>}
                      {latencyHistory[svc.name] && latencyHistory[svc.name].length > 1 && (
                        <Sparkline
                          values={latencyHistory[svc.name]}
                          color={status === "healthy" ? "#4ade80" : status === "degraded" ? "#facc15" : "#f87171"}
                        />
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      {/* WhatsApp Webhook integration status */}
      <div className="mt-2">
        <h2 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wider">WhatsApp Integration</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="border-green-500/20 bg-green-500/5">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]" />
                  <span className="font-medium text-sm">Webhook Verify (GET)</span>
                </div>
                <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">active</Badge>
              </div>
              <p className="text-xs text-muted-foreground mb-1">Meta hub.challenge verification endpoint</p>
              <code className="text-xs text-green-400 bg-green-500/10 px-2 py-0.5 rounded font-mono">GET /api/webhooks/whatsapp</code>
              <p className="text-xs text-muted-foreground mt-2">Validates <span className="font-mono">hub.verify_token</span> against <span className="font-mono">WHATSAPP_VERIFY_TOKEN</span> env var and returns the challenge.</p>
            </CardContent>
          </Card>
          <Card className="border-green-500/20 bg-green-500/5">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]" />
                  <span className="font-medium text-sm">Message Ingestion (POST)</span>
                </div>
                <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">active</Badge>
              </div>
              <p className="text-xs text-muted-foreground mb-1">Incoming messages &amp; media from Meta</p>
              <code className="text-xs text-green-400 bg-green-500/10 px-2 py-0.5 rounded font-mono">POST /api/webhooks/whatsapp</code>
              <p className="text-xs text-muted-foreground mt-2">Routes text through NLP engine; stores image/document/video refs in <span className="font-mono text-xs">whatsapp_media_files</span>.</p>
            </CardContent>
          </Card>
        </div>
      </div>
      </div>
    </DashboardLayout>
  );
}
