import { useCallback, useEffect, useRef, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Activity, Database, HardDrive, KeyRound, Loader2, RefreshCw, Wallet,
} from "lucide-react";

interface ComponentCheck {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

interface ReadinessReport {
  ok: boolean;
  components: {
    db: ComponentCheck;
    redis: ComponentCheck;
    keycloak: ComponentCheck;
    tigerbeetle: ComponentCheck;
  };
  ts?: number;
}

const POLL_MS = 30_000;

const COMPONENT_META: Array<{
  key: keyof ReadinessReport["components"];
  label: string;
  description: string;
  icon: React.ElementType;
}> = [
  { key: "db", label: "PostgreSQL", description: "SELECT 1 through the Drizzle pool", icon: Database },
  { key: "redis", label: "Redis", description: "PING through the shared client", icon: HardDrive },
  { key: "keycloak", label: "Keycloak", description: "JWKS fetch (2s timeout)", icon: KeyRound },
  { key: "tigerbeetle", label: "TigerBeetle", description: "Ledger-bridge /health probe", icon: Wallet },
];

export default function HealthStatus() {
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    try {
      const res = await fetch("/health/ready", { headers: { accept: "application/json" } });
      setHttpStatus(res.status);
      const body = (await res.json()) as ReadinessReport;
      setReport(body);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setReport(null);
      setHttpStatus(null);
    } finally {
      setLoading(false);
      setLastChecked(Date.now());
    }
  }, []);

  useEffect(() => {
    check();
    timer.current = setInterval(check, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [check]);

  const overallOk = error == null && (report?.ok ?? false) && httpStatus === 200;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Activity className="w-6 h-6 text-primary" />
              System Health
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Deep readiness probe (<code className="text-xs">GET /health/ready</code>) — live checks
              against every hard dependency. Auto-refreshes every 30s.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {lastChecked && (
              <span className="text-xs text-muted-foreground">
                Last checked {new Date(lastChecked).toLocaleTimeString()}
              </span>
            )}
            <Button variant="outline" size="sm" className="gap-1.5" onClick={check}>
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Check now
            </Button>
          </div>
        </div>

        {/* Overall banner */}
        <div
          className={`rounded-lg border p-4 flex items-center gap-3 ${
            loading
              ? "border-border/50 bg-card/50"
              : overallOk
                ? "border-emerald-500/30 bg-emerald-500/10"
                : "border-red-500/40 bg-red-500/10"
          }`}
        >
          <span
            className={`inline-block w-3 h-3 rounded-full ${
              loading ? "bg-muted-foreground animate-pulse" : overallOk ? "bg-emerald-500" : "bg-red-500"
            }`}
          />
          <div>
            <p className={`font-semibold ${overallOk ? "text-emerald-300" : loading ? "text-foreground" : "text-red-300"}`}>
              {loading
                ? "Probing dependencies…"
                : error
                  ? "Readiness endpoint unreachable"
                  : overallOk
                    ? "All systems operational"
                    : "Degraded — one or more dependencies are failing"}
            </p>
            {!loading && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {error
                  ? error
                  : `HTTP ${httpStatus} · in production a failure returns 503 so the load balancer drains this instance`}
              </p>
            )}
          </div>
        </div>

        {/* Component cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {COMPONENT_META.map(({ key, label, description, icon: Icon }) => {
            const c = report?.components?.[key];
            const state: "ok" | "fail" | "unknown" = loading ? "unknown" : c ? (c.ok ? "ok" : "fail") : "fail";
            return (
              <Card
                key={key}
                className={`border-border/50 bg-card/50 ${
                  state === "fail" ? "border-red-500/40" : state === "ok" ? "border-emerald-500/20" : ""
                }`}
              >
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <Icon className="w-4 h-4 text-muted-foreground" />
                      {label}
                    </span>
                    <Badge
                      variant="outline"
                      className={`text-[10px] uppercase ${
                        state === "ok"
                          ? "text-emerald-400 border-emerald-500/30"
                          : state === "fail"
                            ? "text-red-400 border-red-500/40"
                            : "text-muted-foreground"
                      }`}
                    >
                      {state === "unknown" ? "…" : state}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1">
                  <p className="text-xs text-muted-foreground">{description}</p>
                  <p className="text-lg font-bold text-foreground">
                    {c ? `${c.latencyMs} ms` : "—"}
                  </p>
                  {c?.error && (
                    <p className="text-[11px] text-red-400 break-all">error: {c.error}</p>
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
