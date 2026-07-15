import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  CheckCircle2, XCircle, Clock, RefreshCw, Loader2, Zap,
  ShoppingBag, Users, BarChart3, Phone, CreditCard, MessageSquare,
  Globe, Radio, AlertCircle, Activity,
} from "lucide-react";

const TYPE_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  medusa:         { label: "Medusa Commerce",    icon: ShoppingBag,   color: "text-purple-500" },
  twenty_crm:     { label: "Twenty CRM",         icon: Users,         color: "text-blue-500" },
  odoo_erp:       { label: "Odoo ERP",           icon: BarChart3,     color: "text-orange-500" },
  africas_talking:{ label: "Africa's Talking",   icon: Phone,         color: "text-emerald-500" },
  telegram:       { label: "Telegram Bot",       icon: Globe,         color: "text-sky-500" },
  paystack:       { label: "Paystack",           icon: CreditCard,    color: "text-teal-500" },
  stripe:         { label: "Stripe",             icon: CreditCard,    color: "text-violet-500" },
  mtn_momo:       { label: "MTN MoMo",           icon: CreditCard,    color: "text-yellow-500" },
  mpesa:          { label: "M-Pesa",             icon: CreditCard,    color: "text-green-600" },
  whatsapp:       { label: "WhatsApp Business",  icon: MessageSquare, color: "text-green-500" },
  ussd:           { label: "USSD Gateway",       icon: Radio,         color: "text-amber-500" },
};

const STATUS_CONFIG: Record<string, { label: string; icon: React.ElementType; badge: string }> = {
  active:          { label: "Active",          icon: CheckCircle2, badge: "bg-emerald-500/15 text-emerald-600 border-emerald-200" },
  not_configured:  { label: "Not Configured",  icon: Clock,        badge: "bg-slate-500/10 text-slate-500 border-slate-200" },
  pending:         { label: "Pending",         icon: Loader2,      badge: "bg-amber-500/15 text-amber-600 border-amber-200" },
  error:           { label: "Error",           icon: XCircle,      badge: "bg-red-500/15 text-red-600 border-red-200" },
  disabled:        { label: "Disabled",        icon: AlertCircle,  badge: "bg-slate-300/30 text-slate-400 border-slate-200" },
};

type Integration = {
  id: string;
  integrationType: string;
  status: string;
  lastHealthCheck: number | null;
  lastHealthStatus: boolean | null;
  lastHealthLatencyMs: number | null;
  lastHealthError: string | null;
  config: Record<string, unknown>;
};

function IntegrationCard({ integration, onPing }: { integration: Integration; onPing: (id: string) => void }) {
  const meta = TYPE_META[integration.integrationType] ?? { label: integration.integrationType, icon: Activity, color: "text-muted-foreground" };
  const statusCfg = STATUS_CONFIG[integration.status] ?? STATUS_CONFIG.not_configured;
  const Icon = meta.icon;
  const StatusIcon = statusCfg.icon;

  return (
    <div className="border rounded-xl p-4 space-y-3 bg-card">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center">
            <Icon className={`w-5 h-5 ${meta.color}`} />
          </div>
          <div>
            <p className="font-medium text-sm">{meta.label}</p>
            <p className="text-xs text-muted-foreground capitalize">{integration.integrationType.replace(/_/g, " ")}</p>
          </div>
        </div>
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${statusCfg.badge}`}>
          <StatusIcon className="w-3 h-3" />
          {statusCfg.label}
        </span>
      </div>

      {integration.lastHealthCheck && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          <div className="flex items-center justify-between">
            <span>Last checked</span>
            <span>{new Date(integration.lastHealthCheck).toLocaleString()}</span>
          </div>
          {integration.lastHealthLatencyMs != null && (
            <div className="flex items-center justify-between">
              <span>Latency</span>
              <span className={integration.lastHealthLatencyMs > 1000 ? "text-amber-500" : "text-emerald-500"}>
                {integration.lastHealthLatencyMs}ms
              </span>
            </div>
          )}
          {integration.lastHealthError && (
            <div className="flex items-start gap-1 text-red-500 mt-1">
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
              <span className="break-all">{integration.lastHealthError}</span>
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => onPing(integration.id)}>
          <RefreshCw className="w-3 h-3 mr-1" /> Ping
        </Button>
        {integration.status === "not_configured" && (
          <a href="/onboarding">
            <Button size="sm" variant="outline" className="text-xs h-7">
              <Zap className="w-3 h-3 mr-1" /> Configure
            </Button>
          </a>
        )}
      </div>
    </div>
  );
}

export default function IntegrationHealth() {
  const utils = trpc.useUtils();
  const [pinging, setPinging] = useState<string | null>(null);

  const { data: integrations, isLoading } = trpc.provisioning.listIntegrations.useQuery(undefined, {
    refetchInterval: 30_000,
  });
  const { data: jobs } = trpc.provisioning.listProvisioningJobs.useQuery(undefined, {
    refetchInterval: 15_000,
  });
  const pingMutation = trpc.provisioning.pingIntegration.useMutation({
    onSuccess: () => utils.provisioning.listIntegrations.invalidate(),
  });

  const handlePing = async (id: string) => {
    setPinging(id);
    await pingMutation.mutateAsync({ integrationId: id }).catch(() => null);
    setPinging(null);
  };

  // Group by status
  const active = (integrations ?? []).filter(i => i.status === "active");
  const issues = (integrations ?? []).filter(i => i.status === "error" || i.status === "pending");
  const unconfigured = (integrations ?? []).filter(i => i.status === "not_configured" || i.status === "disabled");

  const totalActive = active.length;
  const totalIssues = issues.length;

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Integration Health</h1>
            <p className="text-muted-foreground text-sm mt-1">Real-time status of all connected services</p>
          </div>
          <div className="flex gap-2">
            <a href="/onboarding">
              <Button variant="outline" size="sm">
                <Zap className="w-4 h-4 mr-1" /> Setup Wizard
              </Button>
            </a>
            <Button size="sm" onClick={() => utils.provisioning.listIntegrations.invalidate()} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              <RefreshCw className="w-4 h-4 mr-1" /> Refresh All
            </Button>
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-4">
          <div className="border rounded-xl p-4 bg-card">
            <div className="flex items-center gap-2 text-emerald-600">
              <CheckCircle2 className="w-5 h-5" />
              <span className="font-semibold text-2xl">{totalActive}</span>
            </div>
            <p className="text-sm text-muted-foreground mt-1">Active integrations</p>
          </div>
          <div className="border rounded-xl p-4 bg-card">
            <div className="flex items-center gap-2 text-red-500">
              <AlertCircle className="w-5 h-5" />
              <span className="font-semibold text-2xl">{totalIssues}</span>
            </div>
            <p className="text-sm text-muted-foreground mt-1">Needs attention</p>
          </div>
          <div className="border rounded-xl p-4 bg-card">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="w-5 h-5" />
              <span className="font-semibold text-2xl">{unconfigured.length}</span>
            </div>
            <p className="text-sm text-muted-foreground mt-1">Not configured</p>
          </div>
        </div>

        {/* Integration grid */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading integrations…
          </div>
        ) : (integrations ?? []).length === 0 ? (
          <div className="border rounded-xl p-8 text-center space-y-3">
            <Activity className="w-10 h-10 text-muted-foreground mx-auto" />
            <p className="font-medium">No integrations configured yet</p>
            <p className="text-sm text-muted-foreground">Run the setup wizard to connect your services.</p>
            <a href="/onboarding">
              <Button className="bg-emerald-600 hover:bg-emerald-700 text-white">
                <Zap className="w-4 h-4 mr-2" /> Start Setup Wizard
              </Button>
            </a>
          </div>
        ) : (
          <div className="space-y-4">
            {issues.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-red-500 mb-2 flex items-center gap-1"><AlertCircle className="w-4 h-4" /> Needs Attention ({issues.length})</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {issues.map(i => <IntegrationCard key={i.id} integration={i as unknown as Integration} onPing={handlePing} />)}
                </div>
              </div>
            )}
            {active.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-emerald-600 mb-2 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Active ({active.length})</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {active.map(i => <IntegrationCard key={i.id} integration={i as unknown as Integration} onPing={handlePing} />)}
                </div>
              </div>
            )}
            {unconfigured.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-1"><Clock className="w-4 h-4" /> Not Configured ({unconfigured.length})</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {unconfigured.map(i => <IntegrationCard key={i.id} integration={i as unknown as Integration} onPing={handlePing} />)}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Provisioning job history */}
        {jobs && jobs.length > 0 && (
          <div>
            <Separator />
            <h2 className="text-sm font-semibold mt-4 mb-2 flex items-center gap-1"><Activity className="w-4 h-4" /> Provisioning Job History</h2>
            <div className="border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Job</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Status</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Started</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => {
                    const duration = job.completedAt && job.startedAt
                      ? `${((job.completedAt.getTime() - job.startedAt.getTime()) / 1000).toFixed(1)}s`
                      : job.startedAt ? "Running…" : "—";
                    return (
                      <tr key={job.id} className="border-t hover:bg-muted/30">
                        <td className="px-4 py-2 font-mono text-xs">{job.stepName}</td>
                        <td className="px-4 py-2">
                          <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${STATUS_CONFIG[job.status]?.badge ?? ""}`}>
                            {job.status}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {job.startedAt ? job.startedAt.toLocaleString() : "—"}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{duration}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
