import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Activity, CheckCircle, Server, XCircle } from "lucide-react";
import { Database, Shield, Search, Zap, GitBranch, Globe } from "lucide-react";
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
  const { data: layerHealth, isLoading: layerLoading } = trpc.hermes.layerHealth.useQuery(
    undefined,
    { refetchInterval: 30_000, retry: false },
  );
  const { data: infraHealth, isLoading: infraLoading } = trpc.infra.infraHealth.useQuery(
    undefined,
    { refetchInterval: 30_000, retry: false },
  );
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
      {/* Hermes Agent Layer health — live polling every 30s */}
      <div className="mt-2">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Hermes Agent Layer</h2>
          {layerHealth && (
            <span className="text-xs text-muted-foreground font-mono">
              Last checked {new Date(layerHealth.checkedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Hermes Skills */}
          {(() => {
            const svc = layerHealth?.skills;
            const online = layerLoading ? null : (svc?.online ?? false);
            const dotColor = layerLoading ? "bg-gray-500" : online ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]" : "bg-red-400";
            const badgeClass = layerLoading ? "bg-gray-500/20 text-gray-400 border-gray-500/30" : online ? "bg-green-500/20 text-green-400 border-green-500/30" : "bg-red-500/20 text-red-400 border-red-500/30";
            const statusLabel = layerLoading ? "checking…" : online ? "online" : "offline";
            return (
              <Card className="border-purple-500/20 bg-purple-500/5">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className={`h-2 w-2 rounded-full flex-shrink-0 ${dotColor}`} />
                      <span className="font-medium text-sm">Hermes Skills</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className={`text-xs ${badgeClass}`}>{statusLabel}</Badge>
                      <Badge variant="outline" className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-xs">Python</Badge>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mb-1">FastAPI skills executor — PO generation, supplier email, WooCommerce sync</p>
                  <code className="text-xs text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded font-mono">http://hermes-skills:8097/health</code>
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {online ? <CheckCircle className="h-3 w-3 text-green-400" /> : <XCircle className="h-3 w-3 text-red-400" />}
                      <span className="text-xs text-muted-foreground">Endpoints: /skills/generate-po, /skills/po-approved, /skills/woo-sync</span>
                    </div>
                    {svc?.latencyMs != null && <span className="text-xs text-muted-foreground font-mono">{svc.latencyMs}ms</span>}
                  </div>
                </CardContent>
              </Card>
            );
          })()}
          {/* Hermes Bridge */}
          {(() => {
            const svc = layerHealth?.bridge;
            const online = layerLoading ? null : (svc?.online ?? false);
            const dotColor = layerLoading ? "bg-gray-500" : online ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]" : "bg-red-400";
            const badgeClass = layerLoading ? "bg-gray-500/20 text-gray-400 border-gray-500/30" : online ? "bg-green-500/20 text-green-400 border-green-500/30" : "bg-red-500/20 text-red-400 border-red-500/30";
            const statusLabel = layerLoading ? "checking…" : online ? "online" : "offline";
            return (
              <Card className="border-cyan-500/20 bg-cyan-500/5">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className={`h-2 w-2 rounded-full flex-shrink-0 ${dotColor}`} />
                      <span className="font-medium text-sm">Hermes Bridge</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className={`text-xs ${badgeClass}`}>{statusLabel}</Badge>
                      <Badge variant="outline" className="bg-cyan-500/20 text-cyan-400 border-cyan-500/30 text-xs">Go</Badge>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mb-1">Kafka consumer — forwards platform inventory/order events to Hermes Cloud API</p>
                  <code className="text-xs text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded font-mono">http://hermes-bridge:8096/health</code>
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {online ? <CheckCircle className="h-3 w-3 text-green-400" /> : <XCircle className="h-3 w-3 text-red-400" />}
                      <span className="text-xs text-muted-foreground">Kafka topic: hermes.platform.events → Hermes Cloud API</span>
                    </div>
                    {svc?.latencyMs != null && <span className="text-xs text-muted-foreground font-mono">{svc.latencyMs}ms</span>}
                  </div>
                </CardContent>
              </Card>
            );
          })()}
          {/* Hermes Router */}
          {(() => {
            const svc = layerHealth?.router;
            const online = layerLoading ? null : (svc?.online ?? false);
            const dotColor = layerLoading ? "bg-gray-500" : online ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]" : "bg-red-400";
            const badgeClass = layerLoading ? "bg-gray-500/20 text-gray-400 border-gray-500/30" : online ? "bg-green-500/20 text-green-400 border-green-500/30" : "bg-red-500/20 text-red-400 border-red-500/30";
            const statusLabel = layerLoading ? "checking…" : online ? "online" : "offline";
            return (
              <Card className="border-orange-500/20 bg-orange-500/5">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className={`h-2 w-2 rounded-full flex-shrink-0 ${dotColor}`} />
                      <span className="font-medium text-sm">Hermes Router</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className={`text-xs ${badgeClass}`}>{statusLabel}</Badge>
                      <Badge variant="outline" className="bg-orange-500/20 text-orange-400 border-orange-500/30 text-xs">Rust</Badge>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mb-1">Circuit breaker, exponential-backoff retry, dead-letter queue on hermes.events.dlq</p>
                  <code className="text-xs text-orange-400 bg-orange-500/10 px-2 py-0.5 rounded font-mono">Redis heartbeat: hermes:router:heartbeat</code>
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {online ? <CheckCircle className="h-3 w-3 text-green-400" /> : <XCircle className="h-3 w-3 text-red-400" />}
                      <span className="text-xs text-muted-foreground">DLQ: hermes.events.dlq | Retry: 3× with jitter backoff</span>
                    </div>
                    {svc?.latencyMs != null && <span className="text-xs text-muted-foreground font-mono">{svc.latencyMs}ms</span>}
                  </div>
                </CardContent>
              </Card>
            );
          })()}
        </div>
        {/* PO Approval WhatsApp Flow */}
        <div className="mt-4">
          <Card className="border-green-500/20 bg-green-500/5">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-semibold text-green-400 flex items-center gap-2">
                <CheckCircle className="h-4 w-4" />
                PO Approval via WhatsApp
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className="text-xs text-muted-foreground mb-3">
                Merchants can approve or reject Hermes-generated Purchase Orders directly from WhatsApp by replying to the notification message.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-green-500/10 rounded p-3">
                  <p className="text-xs font-mono text-green-400 mb-1">APPROVE PO-XXXX</p>
                  <p className="text-xs text-muted-foreground">Marks PO as approved, triggers supplier email via hermes-skills, sends WhatsApp confirmation.</p>
                </div>
                <div className="bg-red-500/10 rounded p-3">
                  <p className="text-xs font-mono text-red-400 mb-1">REJECT PO-XXXX</p>
                  <p className="text-xs text-muted-foreground">Marks PO as rejected, no supplier email sent, sends WhatsApp confirmation.</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Infrastructure Health Grid (12 services, live polling every 30s) ── */}
      <div className="mt-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Infrastructure Layer</h2>
          {infraHealth && (
            <span className="text-xs text-muted-foreground font-mono">
              Last checked {new Date(infraHealth.checkedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {INFRA_SERVICES.map((svc) => {
            const raw = infraHealth?.services?.[svc.key as keyof typeof infraHealth.services];
            const online = infraLoading ? null : (raw?.online ?? false);
            const latency = raw?.latencyMs;
            const err = raw?.error;
            const dotColor = infraLoading ? "bg-gray-500" : online ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]" : "bg-red-400";
            const badgeClass = infraLoading
              ? "bg-gray-500/20 text-gray-400 border-gray-500/30"
              : online
              ? "bg-green-500/20 text-green-400 border-green-500/30"
              : "bg-red-500/20 text-red-400 border-red-500/30";
            const statusLabel = infraLoading ? "checking..." : online ? "online" : err === "not_configured" ? "not configured" : "offline";
            const langBadgeClass: Record<string, string> = {
              Go: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
              Rust: "bg-orange-500/20 text-orange-400 border-orange-500/30",
              Python: "bg-blue-500/20 text-blue-400 border-blue-500/30",
              TS: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
            };
            return (
              <Card key={svc.key} className="bg-card border-border">
                <CardContent className="p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <div className={`h-2 w-2 rounded-full flex-shrink-0 ${dotColor}`} />
                      <span className="font-semibold text-sm">{svc.label}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Badge variant="outline" className={`text-xs ${badgeClass}`}>{statusLabel}</Badge>
                      <Badge variant="outline" className={`text-xs ${langBadgeClass[svc.lang] ?? ""}`}>{svc.lang}</Badge>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">{svc.desc}</p>
                  {latency != null && (
                    <p className="text-xs text-muted-foreground font-mono mt-1">{latency}ms</p>
                  )}
                  {err && err !== "not_configured" && (
                    <p className="text-xs text-red-400 mt-1 truncate" title={err}>{err}</p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

    </DashboardLayout>
  );
}

const INFRA_SERVICES: Array<{
  key: string;
  label: string;
  lang: string;
  desc: string;
  color: string;
}> = [
  { key: "postgres",    label: "PostgreSQL",   lang: "TS",     desc: "Primary relational database — Drizzle ORM, connection pooling",               color: "blue" },
  { key: "redis",       label: "Redis",        lang: "TS",     desc: "Session cache, rate-limiting, pub/sub, Hermes router heartbeat",               color: "red" },
  { key: "kafka",       label: "Kafka",        lang: "Go",     desc: "Event streaming — order/payment/inventory/hermes topics",                      color: "cyan" },
  { key: "tigerBeetle", label: "TigerBeetle",  lang: "Rust",   desc: "Double-entry financial ledger — reserve/commit/void via ledger-bridge:8095",   color: "orange" },
  { key: "mojaloop",    label: "Mojaloop",     lang: "Go",     desc: "Open-loop mobile-money transfers — FSP callbacks, quote, transfer",            color: "green" },
  { key: "apisix",      label: "APISIX",       lang: "Go",     desc: "API gateway — route management, rate limiting, JWT plugin",                    color: "purple" },
  { key: "keycloak",    label: "Keycloak",     lang: "Go",     desc: "Identity provider — JWKS RS256 token validation, SSO",                         color: "yellow" },
  { key: "openappsec",  label: "OpenAppSec",   lang: "Python", desc: "WAF — ML-based threat detection, policy enforcement",                          color: "pink" },
  { key: "permify",     label: "Permify",      lang: "Python", desc: "Fine-grained authorization — RBAC/ABAC permission checks",                     color: "indigo" },
  { key: "opensearch",  label: "OpenSearch",   lang: "Python", desc: "Full-text search — products, orders, conversations, audit logs",                color: "teal" },
  { key: "fluvio",      label: "Fluvio",       lang: "Rust",   desc: "Streaming event consumer — wacommerce.* topics → Node webhook",                color: "amber" },
  { key: "dapr",        label: "Dapr",         lang: "Go",     desc: "Sidecar runtime — pub/sub, state store, service invocation",                   color: "violet" },
];
