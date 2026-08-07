import React, { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshCw, CheckCircle2, XCircle, AlertCircle, Clock, Activity } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

// ── Service status card ───────────────────────────────────────────────────────

interface ServiceCardProps {
  name: string;
  status: { online: boolean; latencyMs?: number; error?: string; details?: unknown } | undefined;
  description: string;
  icon?: string;
}

function ServiceCard({ name, status, description, icon }: ServiceCardProps) {
  const online = status?.online ?? false;
  const latency = status?.latencyMs;
  const error = status?.error;

  return (
    <Card className={`border-2 ${online ? "border-green-200 bg-green-50/30" : "border-red-200 bg-red-50/30"}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            {icon && <span className="text-lg">{icon}</span>}
            {name}
          </CardTitle>
          {online ? (
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          ) : (
            <XCircle className="h-5 w-5 text-red-500" />
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-xs text-muted-foreground mb-2">{description}</p>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={online ? "default" : "destructive"} className="text-xs">
            {online ? "Online" : "Offline"}
          </Badge>
          {latency !== undefined && (
            <Badge variant="outline" className="text-xs flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {latency}ms
            </Badge>
          )}
          {error && (
            <span className="text-xs text-red-600 truncate max-w-[200px]" title={error}>
              {error}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── WAF Events table ──────────────────────────────────────────────────────────

function WafEventsTab() {
  const { data, isLoading, refetch } = trpc.infra.listWafEvents.useQuery({
    sinceHours: 24,
    limit: 50,
  });

  const severityColor = (s: string) => {
    switch (s) {
      case "critical": return "bg-red-600 text-white";
      case "high": return "bg-orange-500 text-white";
      case "medium": return "bg-yellow-500 text-black";
      case "low": return "bg-blue-500 text-white";
      default: return "bg-gray-400 text-white";
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">WAF Security Events (last 24h)</h3>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>
      {isLoading ? (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      ) : (data?.events?.length ?? 0) === 0 ? (
        <div className="text-center py-8 text-muted-foreground">No WAF events in the last 24 hours</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 px-3">Severity</th>
                <th className="text-left py-2 px-3">Attack Type</th>
                <th className="text-left py-2 px-3">Source IP</th>
                <th className="text-left py-2 px-3">URI</th>
                <th className="text-left py-2 px-3">Blocked</th>
                <th className="text-left py-2 px-3">Time</th>
              </tr>
            </thead>
            <tbody>
              {data?.events?.map((ev: any) => (
                <tr key={ev.id} className="border-b hover:bg-muted/30">
                  <td className="py-2 px-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${severityColor(ev.severity)}`}>
                      {ev.severity}
                    </span>
                  </td>
                  <td className="py-2 px-3">{ev.attackType ?? "—"}</td>
                  <td className="py-2 px-3 font-mono text-xs">{ev.sourceIp ?? "—"}</td>
                  <td className="py-2 px-3 max-w-[200px] truncate" title={ev.requestUri ?? ""}>{ev.requestUri ?? "—"}</td>
                  <td className="py-2 px-3">
                    <Badge variant={ev.blocked ? "destructive" : "outline"} className="text-xs">
                      {ev.blocked ? "Blocked" : "Allowed"}
                    </Badge>
                  </td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">
                    {ev.detectedAt ? formatDistanceToNow(new Date(ev.detectedAt), { addSuffix: true }) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Temporal Workflows tab ────────────────────────────────────────────────────

function TemporalTab() {
  const { data, isLoading, refetch } = trpc.temporal.listRuns.useQuery({
    sinceHours: 24,
    limit: 50,
  });
  const health = trpc.temporal.health.useQuery();

  const statusColor = (s: string) => {
    switch (s) {
      case "completed": return "bg-green-500 text-white";
      case "running": return "bg-blue-500 text-white";
      case "failed": return "bg-red-500 text-white";
      case "cancelled": return "bg-gray-400 text-white";
      default: return "bg-yellow-500 text-black";
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Temporal Workflow Runs (last 24h)</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Temporal: {health.data?.online ? "🟢 Online" : "🔴 Offline"}{" "}
            {health.data?.latencyMs !== undefined && `(${health.data.latencyMs}ms)`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>
      {isLoading ? (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      ) : (data?.runs?.length ?? 0) === 0 ? (
        <div className="text-center py-8 text-muted-foreground">No workflow runs in the last 24 hours</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 px-3">Type</th>
                <th className="text-left py-2 px-3">Status</th>
                <th className="text-left py-2 px-3">Tenant</th>
                <th className="text-left py-2 px-3">Duration</th>
                <th className="text-left py-2 px-3">Started</th>
              </tr>
            </thead>
            <tbody>
              {data?.runs?.map((run: any) => (
                <tr key={run.id} className="border-b hover:bg-muted/30">
                  <td className="py-2 px-3 font-mono text-xs">{run.workflowType}</td>
                  <td className="py-2 px-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(run.status)}`}>
                      {run.status}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-xs">{run.tenantId ?? "—"}</td>
                  <td className="py-2 px-3 text-xs">
                    {run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : "—"}
                  </td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">
                    {run.startedAt ? formatDistanceToNow(new Date(run.startedAt), { addSuffix: true }) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Fluvio Events tab ─────────────────────────────────────────────────────────

function FluvioTab() {
  const { data, isLoading, refetch } = trpc.infra.listFluvioEvents.useQuery({ limit: 50 });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Fluvio Event Stream</h3>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>
      {isLoading ? (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      ) : (data?.events?.length ?? 0) === 0 ? (
        <div className="text-center py-8 text-muted-foreground">No Fluvio events recorded</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 px-3">Topic</th>
                <th className="text-left py-2 px-3">Event Type</th>
                <th className="text-left py-2 px-3">Offset</th>
                <th className="text-left py-2 px-3">Processed</th>
                <th className="text-left py-2 px-3">Received</th>
              </tr>
            </thead>
            <tbody>
              {data?.events?.map((ev: any) => (
                <tr key={ev.id} className="border-b hover:bg-muted/30">
                  <td className="py-2 px-3 font-mono text-xs">{ev.topic}</td>
                  <td className="py-2 px-3 text-xs">{ev.eventType ?? "—"}</td>
                  <td className="py-2 px-3 text-xs">{ev.offset}</td>
                  <td className="py-2 px-3">
                    <Badge variant={ev.processed ? "default" : "outline"} className="text-xs">
                      {ev.processed ? "Yes" : "No"}
                    </Badge>
                  </td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">
                    {ev.receivedAt ? formatDistanceToNow(new Date(ev.receivedAt), { addSuffix: true }) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Lakehouse tab ─────────────────────────────────────────────────────────────

function LakehouseTab() {
  const { data, isLoading, refetch } = trpc.infra.listLakehouseRuns.useQuery({ limit: 30 });
  const trigger = trpc.infra.triggerLakehousePipeline.useMutation({
    onSuccess: () => refetch(),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Lakehouse Pipeline Runs</h3>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => trigger.mutate({ pipelineType: "full" })}
            disabled={trigger.isPending}
          >
            {trigger.isPending ? "Triggering..." : "Run Full Pipeline"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-1" /> Refresh
          </Button>
        </div>
      </div>
      {isLoading ? (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      ) : (data?.runs?.length ?? 0) === 0 ? (
        <div className="text-center py-8 text-muted-foreground">No pipeline runs yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 px-3">Type</th>
                <th className="text-left py-2 px-3">Stage</th>
                <th className="text-left py-2 px-3">Status</th>
                <th className="text-left py-2 px-3">Records</th>
                <th className="text-left py-2 px-3">Duration</th>
                <th className="text-left py-2 px-3">Started</th>
              </tr>
            </thead>
            <tbody>
              {data?.runs?.map((run: any) => (
                <tr key={run.id} className="border-b hover:bg-muted/30">
                  <td className="py-2 px-3 font-mono text-xs">{run.pipelineType}</td>
                  <td className="py-2 px-3 text-xs">{run.stage}</td>
                  <td className="py-2 px-3">
                    <Badge
                      variant={run.status === "completed" ? "default" : run.status === "failed" ? "destructive" : "outline"}
                      className="text-xs"
                    >
                      {run.status}
                    </Badge>
                  </td>
                  <td className="py-2 px-3 text-xs">{run.recordsLoaded ?? 0}</td>
                  <td className="py-2 px-3 text-xs">
                    {run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : "—"}
                  </td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">
                    {run.startedAt ? formatDistanceToNow(new Date(run.startedAt), { addSuffix: true }) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main InfraHealth page ─────────────────────────────────────────────────────

const SERVICE_META: Record<string, { description: string; icon: string }> = {
  postgres:    { description: "Primary relational database (PostgreSQL)", icon: "🐘" },
  redis:       { description: "Cache & session store (Redis)", icon: "🔴" },
  kafka:       { description: "Event streaming (Kafka)", icon: "📨" },
  tigerBeetle: { description: "Financial ledger (TigerBeetle via ledger-bridge)", icon: "🐯" },
  mojaloop:    { description: "Interbank payment rails (Mojaloop)", icon: "💸" },
  apisix:      { description: "API Gateway (Apache APISIX)", icon: "🔀" },
  keycloak:    { description: "Identity & access management (Keycloak)", icon: "🔐" },
  openappsec:  { description: "WAF & threat detection (OpenAppSec)", icon: "🛡️" },
  permify:     { description: "Fine-grained authorization (Permify ReBAC)", icon: "🔑" },
  opensearch:  { description: "Search & analytics (OpenSearch)", icon: "🔍" },
  fluvio:      { description: "Real-time event streaming (Fluvio)", icon: "🌊" },
  dapr:        { description: "Distributed app runtime (Dapr sidecar)", icon: "⚙️" },
  temporal:    { description: "Durable workflow orchestration (Temporal)", icon: "⏱️" },
  mlStack:     { description: "ML inference server (CPU-optimized)", icon: "🤖" },
  reconWorker: { description: "Financial reconciliation worker (Rust)", icon: "⚖️" },
};

export default function InfraHealth() {
  const [tab, setTab] = useState("overview");
  const { data, isLoading, refetch, dataUpdatedAt } = trpc.infra.infraHealth.useQuery(undefined, {
    refetchInterval: 30_000,
  });

  const services = data?.services ?? {};
  const onlineCount = Object.values(services).filter((s: any) => s?.online).length;
  const totalCount = Object.keys(SERVICE_META).length;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="h-6 w-6" />
            Infrastructure Health
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {onlineCount}/{totalCount} services online
            {dataUpdatedAt ? ` · Updated ${formatDistanceToNow(dataUpdatedAt, { addSuffix: true })}` : ""}
          </p>
        </div>
        <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Overall status bar */}
      <div className={`rounded-lg p-4 ${onlineCount === totalCount ? "bg-green-50 border border-green-200" : onlineCount > totalCount / 2 ? "bg-yellow-50 border border-yellow-200" : "bg-red-50 border border-red-200"}`}>
        <div className="flex items-center gap-2">
          {onlineCount === totalCount ? (
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          ) : (
            <AlertCircle className="h-5 w-5 text-yellow-500" />
          )}
          <span className="font-medium">
            {onlineCount === totalCount
              ? "All systems operational"
              : `${totalCount - onlineCount} service(s) degraded`}
          </span>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="waf">WAF Events</TabsTrigger>
          <TabsTrigger value="temporal">Temporal</TabsTrigger>
          <TabsTrigger value="fluvio">Fluvio</TabsTrigger>
          <TabsTrigger value="lakehouse">Lakehouse</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {Object.keys(SERVICE_META).map((name) => (
                <div key={name} className="h-24 rounded-lg bg-muted animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {Object.entries(SERVICE_META).map(([name, meta]) => (
                <ServiceCard
                  key={name}
                  name={name.charAt(0).toUpperCase() + name.slice(1).replace(/([A-Z])/g, " $1")}
                  status={(services as any)[name]}
                  description={meta.description}
                  icon={meta.icon}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="waf" className="mt-4">
          <WafEventsTab />
        </TabsContent>

        <TabsContent value="temporal" className="mt-4">
          <TemporalTab />
        </TabsContent>

        <TabsContent value="fluvio" className="mt-4">
          <FluvioTab />
        </TabsContent>

        <TabsContent value="lakehouse" className="mt-4">
          <LakehouseTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
