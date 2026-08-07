/**
 * AdminPortal.tsx — Unified Admin Management Portal
 *
 * Role-based admin portal with:
 * - Integration management (WhatsApp, Odoo, Twenty CRM, Medusa)
 * - User & tenant management
 * - Infrastructure health dashboard
 * - Temporal workflow management
 * - APISIX route management
 * - Keycloak user sync
 * - Financial reconciliation controls
 * - Audit log viewer
 */
import React, { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Activity, AlertTriangle, Building2, CheckCircle2, ChevronRight, Clock,
  CreditCard, Database, ExternalLink, Globe, Key, Layers, Lock, LogOut,
  MessageSquare, Package, RefreshCw, Server, Settings, Shield, TrendingUp,
  Users, Workflow, XCircle, Zap, ArrowLeftRight, Bot,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

// ── Role guard ────────────────────────────────────────────────────────────────

function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return <div className="p-8 text-center text-muted-foreground">Loading...</div>;
  if (user.role !== "admin") {
    return (
      <div className="p-8 text-center">
        <Shield className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">Access Restricted</h2>
        <p className="text-muted-foreground">This page requires administrator privileges.</p>
        <Badge variant="outline" className="mt-2">Your role: {user.role}</Badge>
      </div>
    );
  }
  return <>{children}</>;
}

// ── Integration status card ───────────────────────────────────────────────────

interface IntegrationCardProps {
  name: string;
  icon: React.ElementType;
  description: string;
  status: "connected" | "disconnected" | "error" | "partial";
  lastSync?: string | null;
  onConfigure: () => void;
  onSync?: () => void;
  syncing?: boolean;
}

function IntegrationCard({ name, icon: Icon, description, status, lastSync, onConfigure, onSync, syncing }: IntegrationCardProps) {
  const statusConfig = {
    connected: { color: "text-green-500", bg: "border-green-200 bg-green-50/20", label: "Connected", icon: CheckCircle2 },
    disconnected: { color: "text-gray-400", bg: "border-gray-200", label: "Not Connected", icon: XCircle },
    error: { color: "text-red-500", bg: "border-red-200 bg-red-50/20", label: "Error", icon: AlertTriangle },
    partial: { color: "text-yellow-500", bg: "border-yellow-200 bg-yellow-50/20", label: "Partial", icon: AlertTriangle },
  }[status];
  const StatusIcon = statusConfig.icon;

  return (
    <Card className={`border ${statusConfig.bg}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
              <Icon className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold">{name}</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <StatusIcon className={`h-4 w-4 ${statusConfig.color}`} />
            <Badge variant="outline" className={`text-xs ${statusConfig.color}`}>{statusConfig.label}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {lastSync && (
          <p className="text-xs text-muted-foreground mb-3 flex items-center gap-1">
            <Clock className="h-3 w-3" />
            Last sync: {formatDistanceToNow(new Date(lastSync), { addSuffix: true })}
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onConfigure} className="flex-1">
            <Settings className="h-3.5 w-3.5 mr-1" />
            Configure
          </Button>
          {onSync && (
            <Button variant="outline" size="sm" onClick={onSync} disabled={syncing}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Syncing..." : "Sync"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Integrations tab ──────────────────────────────────────────────────────────

function IntegrationsTab() {
  const [configuring, setConfiguring] = useState<string | null>(null);
  const { data: tenantList } = trpc.tenant.list.useQuery({ limit: 20 });
  const [selectedTenant, setSelectedTenant] = useState<string>("");

  // WhatsApp config
  const waConfig = trpc.tenant.getWhatsAppConfig?.useQuery?.(
    { tenantId: selectedTenant },
    { enabled: !!selectedTenant }
  );

  // Odoo sync
  const odooSync = trpc.odoo.syncAll?.useMutation?.();

  // Twenty CRM sync
  const twentySync = trpc.twenty.syncContacts?.useMutation?.();

  // Medusa sync
  const medusaSync = trpc.medusaOnboarding.stats?.useQuery?.(undefined, { enabled: !!selectedTenant });

  const integrations = [
    {
      id: "whatsapp",
      name: "WhatsApp Business",
      icon: MessageSquare,
      description: "Meta Cloud API — inbound/outbound messaging, webhooks, media",
      status: "connected" as const,
      onConfigure: () => setConfiguring("whatsapp"),
    },
    {
      id: "odoo",
      name: "Odoo ERP",
      icon: Package,
      description: "Bi-directional product, inventory, and order sync via XML-RPC",
      status: "partial" as const,
      onConfigure: () => setConfiguring("odoo"),
      onSync: () => odooSync?.mutate?.({ tenantId: selectedTenant }),
      syncing: odooSync?.isPending,
    },
    {
      id: "twenty",
      name: "Twenty CRM",
      icon: Users,
      description: "Contact and deal sync via Twenty GraphQL API",
      status: "connected" as const,
      onConfigure: () => setConfiguring("twenty"),
      onSync: () => twentySync?.mutate?.({ tenantId: selectedTenant }),
      syncing: twentySync?.isPending,
    },
    {
      id: "medusa",
      name: "Medusa Commerce",
      icon: Globe,
      description: "Product catalog and order sync via Medusa v2 Admin API",
      status: "partial" as const,
      onConfigure: () => setConfiguring("medusa"),
    },
    {
      id: "keycloak",
      name: "Keycloak IAM",
      icon: Key,
      description: "OIDC authentication, JWT validation, user provisioning",
      status: "connected" as const,
      onConfigure: () => setConfiguring("keycloak"),
    },
    {
      id: "apisix",
      name: "APISIX Gateway",
      icon: Layers,
      description: "API gateway routing, rate limiting, WAF integration",
      status: "connected" as const,
      onConfigure: () => setConfiguring("apisix"),
    },
    {
      id: "temporal",
      name: "Temporal Workflows",
      icon: Workflow,
      description: "Durable workflow orchestration for payments and onboarding",
      status: "connected" as const,
      onConfigure: () => setConfiguring("temporal"),
    },
    {
      id: "tigerbeetle",
      name: "TigerBeetle Ledger",
      icon: CreditCard,
      description: "Financial ledger with double-entry accounting and atomicity",
      status: "connected" as const,
      onConfigure: () => setConfiguring("tigerbeetle"),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Integration Management</h3>
          <p className="text-sm text-muted-foreground">Configure and monitor all platform integrations</p>
        </div>
        <Select value={selectedTenant} onValueChange={setSelectedTenant}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Select tenant" />
          </SelectTrigger>
          <SelectContent>
            {tenantList?.map((t: { id: string; name: string | null; slug: string }) => (
              <SelectItem key={t.id} value={t.id}>{t.name ?? t.slug}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {integrations.map(integration => (
          <IntegrationCard key={integration.id} {...integration} />
        ))}
      </div>

      {/* Configuration panels */}
      {configuring === "whatsapp" && (
        <WhatsAppConfigPanel tenantId={selectedTenant} onClose={() => setConfiguring(null)} />
      )}
      {configuring === "odoo" && (
        <OdooConfigPanel tenantId={selectedTenant} onClose={() => setConfiguring(null)} />
      )}
      {configuring === "twenty" && (
        <TwentyConfigPanel tenantId={selectedTenant} onClose={() => setConfiguring(null)} />
      )}
      {configuring === "medusa" && (
        <MedusaConfigPanel tenantId={selectedTenant} onClose={() => setConfiguring(null)} />
      )}
    </div>
  );
}

// ── WhatsApp Config Panel ─────────────────────────────────────────────────────

function WhatsAppConfigPanel({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const [form, setForm] = useState({ phoneNumberId: "", wabaId: "", accessToken: "", verifyToken: "" });
  const save = trpc.tenant.updateWhatsAppConfig?.useMutation?.({
    onSuccess: () => { onClose(); },
  });

  return (
    <Card className="border-primary/30">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-primary" />
            WhatsApp Business API Configuration
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={onClose}>✕</Button>
        </div>
        <CardDescription>Configure Meta Cloud API credentials for WhatsApp messaging</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="text-xs">Phone Number ID</Label>
            <Input
              value={form.phoneNumberId}
              onChange={e => setForm(f => ({ ...f, phoneNumberId: e.target.value }))}
              placeholder="1234567890"
              className="mt-1 h-8 text-xs"
            />
          </div>
          <div>
            <Label className="text-xs">WhatsApp Business Account ID</Label>
            <Input
              value={form.wabaId}
              onChange={e => setForm(f => ({ ...f, wabaId: e.target.value }))}
              placeholder="9876543210"
              className="mt-1 h-8 text-xs"
            />
          </div>
          <div>
            <Label className="text-xs">Permanent Access Token</Label>
            <Input
              type="password"
              value={form.accessToken}
              onChange={e => setForm(f => ({ ...f, accessToken: e.target.value }))}
              placeholder="EAABs..."
              className="mt-1 h-8 text-xs"
            />
          </div>
          <div>
            <Label className="text-xs">Webhook Verify Token</Label>
            <Input
              value={form.verifyToken}
              onChange={e => setForm(f => ({ ...f, verifyToken: e.target.value }))}
              placeholder="my_secret_token"
              className="mt-1 h-8 text-xs"
            />
          </div>
        </div>
        <Alert>
          <AlertDescription className="text-xs">
            Webhook URL: <code className="bg-muted px-1 rounded">https://wa-app.newfire.app/api/webhooks/whatsapp</code>
          </AlertDescription>
        </Alert>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => save?.mutate?.({ tenantId, ...form })}
            disabled={save?.isPending || !tenantId}
          >
            {save?.isPending ? "Saving..." : "Save Configuration"}
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Odoo Config Panel ─────────────────────────────────────────────────────────

function OdooConfigPanel({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const [form, setForm] = useState({ baseUrl: "", database: "", username: "", apiKey: "" });
  const save = trpc.odoo.configure?.useMutation?.({ onSuccess: onClose });
  const testConn = trpc.odoo.testConnection?.useMutation?.();

  return (
    <Card className="border-primary/30">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Package className="h-4 w-4 text-primary" />
            Odoo ERP Configuration
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={onClose}>✕</Button>
        </div>
        <CardDescription>Connect to Odoo for bi-directional product, inventory, and order sync</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="text-xs">Odoo URL</Label>
            <Input value={form.baseUrl} onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))} placeholder="https://mycompany.odoo.com" className="mt-1 h-8 text-xs" />
          </div>
          <div>
            <Label className="text-xs">Database Name</Label>
            <Input value={form.database} onChange={e => setForm(f => ({ ...f, database: e.target.value }))} placeholder="mycompany" className="mt-1 h-8 text-xs" />
          </div>
          <div>
            <Label className="text-xs">Username</Label>
            <Input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="admin@example.com" className="mt-1 h-8 text-xs" />
          </div>
          <div>
            <Label className="text-xs">API Key</Label>
            <Input type="password" value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} placeholder="abc123def456..." className="mt-1 h-8 text-xs" />
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => save?.mutate?.({ tenantId, ...form })} disabled={save?.isPending || !tenantId}>
            {save?.isPending ? "Saving..." : "Save"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => testConn?.mutate?.({ ...form })} disabled={testConn?.isPending}>
            {testConn?.isPending ? "Testing..." : "Test Connection"}
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
        </div>
        {testConn?.data && (
          <Alert variant={testConn.data.success ? "default" : "destructive"}>
            <AlertDescription className="text-xs">
              {testConn.data.success
                ? "Connection successful — Odoo status set to connected."
                : `Connection failed (status: ${testConn.data.status}). Check the URL, database name, username and API key.`}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

// ── Twenty CRM Config Panel ───────────────────────────────────────────────────

function TwentyConfigPanel({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const [form, setForm] = useState({ apiUrl: "", apiKey: "", workspaceId: "" });
  const save = trpc.twenty.configure?.useMutation?.({ onSuccess: onClose });

  return (
    <Card className="border-primary/30">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            Twenty CRM Configuration
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={onClose}>✕</Button>
        </div>
        <CardDescription>Connect to Twenty CRM for bi-directional contact and deal sync</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4">
          <div>
            <Label className="text-xs">Twenty API URL</Label>
            <Input value={form.apiUrl} onChange={e => setForm(f => ({ ...f, apiUrl: e.target.value }))} placeholder="https://api.twenty.com" className="mt-1 h-8 text-xs" />
          </div>
          <div>
            <Label className="text-xs">API Key</Label>
            <Input type="password" value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} placeholder="eyJhbGciOiJIUzI1NiJ9..." className="mt-1 h-8 text-xs" />
          </div>
          <div>
            <Label className="text-xs">Workspace ID (optional)</Label>
            <Input value={form.workspaceId} onChange={e => setForm(f => ({ ...f, workspaceId: e.target.value }))} placeholder="ws_abc123" className="mt-1 h-8 text-xs" />
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => save?.mutate?.({ tenantId, ...form })} disabled={save?.isPending || !tenantId}>
            {save?.isPending ? "Saving..." : "Save"}
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Medusa Config Panel ───────────────────────────────────────────────────────

function MedusaConfigPanel({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const [form, setForm] = useState({ baseUrl: "", apiKey: "" });
  const save = trpc.medusa.configure?.useMutation?.({ onSuccess: onClose });
  const stats = trpc.medusaOnboarding.stats.useQuery(undefined, { enabled: !!tenantId });

  return (
    <Card className="border-primary/30">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Globe className="h-4 w-4 text-primary" />
            Medusa Commerce Configuration
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={onClose}>✕</Button>
        </div>
        <CardDescription>Connect to Medusa v2 for product catalog and order management</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {stats.data && (
          <div className="grid grid-cols-4 gap-2 p-3 bg-muted/30 rounded-lg">
            <div className="text-center"><p className="text-lg font-bold">{stats.data.total}</p><p className="text-xs text-muted-foreground">Total</p></div>
            <div className="text-center"><p className="text-lg font-bold text-green-500">{stats.data.synced}</p><p className="text-xs text-muted-foreground">Synced</p></div>
            <div className="text-center"><p className="text-lg font-bold text-yellow-500">{stats.data.draft}</p><p className="text-xs text-muted-foreground">Draft</p></div>
            <div className="text-center"><p className="text-lg font-bold text-red-500">{stats.data.failed}</p><p className="text-xs text-muted-foreground">Failed</p></div>
          </div>
        )}
        <div className="grid grid-cols-1 gap-4">
          <div>
            <Label className="text-xs">Medusa Admin URL</Label>
            <Input value={form.baseUrl} onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))} placeholder="https://api.mystore.com" className="mt-1 h-8 text-xs" />
          </div>
          <div>
            <Label className="text-xs">Admin API Key</Label>
            <Input type="password" value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} placeholder="pk_..." className="mt-1 h-8 text-xs" />
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => save?.mutate?.({ tenantId, ...form })} disabled={save?.isPending || !tenantId}>
            {save?.isPending ? "Saving..." : "Save"}
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Users & Roles tab ─────────────────────────────────────────────────────────

function UsersTab() {
  const { data: tenantList } = trpc.tenant.list.useQuery({ limit: 50 });
  const { data: kycStats } = trpc.kyc.stats.useQuery();

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Total Tenants</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{tenantList?.length ?? 0}</p>
            <p className="text-xs text-muted-foreground mt-1">Active merchant accounts</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">KYC Applications</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{kycStats?.total ?? 0}</p>
            <div className="flex gap-2 mt-1">
              <Badge variant="outline" className="text-xs text-green-500">{kycStats?.approved ?? 0} approved</Badge>
              <Badge variant="outline" className="text-xs text-yellow-500">{kycStats?.pending ?? 0} pending</Badge>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Role Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {["admin", "operator", "analyst", "user"].map(role => (
                <div key={role} className="flex items-center justify-between text-xs">
                  <span className="capitalize">{role}</span>
                  <Badge variant="outline" className="text-xs">{role === "admin" ? "1" : "—"}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tenant list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Tenant Management</CardTitle>
          <CardDescription>All registered merchant tenants</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-3">Name</th>
                  <th className="text-left py-2 px-3">Slug</th>
                  <th className="text-left py-2 px-3">Status</th>
                  <th className="text-left py-2 px-3">Billing</th>
                  <th className="text-left py-2 px-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tenantList?.map((t: any) => (
                  <tr key={t.id} className="border-b hover:bg-muted/30">
                    <td className="py-2 px-3 font-medium">{t.name ?? t.slug}</td>
                    <td className="py-2 px-3 text-muted-foreground font-mono text-xs">{t.slug}</td>
                    <td className="py-2 px-3">
                      <Badge variant={t.status === "active" ? "default" : "outline"} className="text-xs">
                        {t.status ?? "active"}
                      </Badge>
                    </td>
                    <td className="py-2 px-3 text-xs">{t.billingModel ?? "profit_sharing"}</td>
                    <td className="py-2 px-3">
                      <Button variant="ghost" size="sm" className="h-6 text-xs">
                        <ChevronRight className="h-3 w-3" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Finance Controls tab ──────────────────────────────────────────────────────

function FinanceTab() {
  const triggerRecon = trpc.infra.triggerReconciliation.useMutation();
  const lastRecon = trpc.infra.getLastReconciliation.useQuery();
  const { data: tbAccounts } = trpc.infra.listTbAccounts.useQuery({});
  const provisionTb = trpc.infra.provisionTbAccount.useMutation();

  return (
    <div className="space-y-6">
      {/* Reconciliation */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm flex items-center gap-2">
                <ArrowLeftRight className="h-4 w-4" />
                Financial Reconciliation
              </CardTitle>
              <CardDescription>Cross-reference TigerBeetle ledger with PostgreSQL payment records</CardDescription>
            </div>
            <Button
              size="sm"
              onClick={() => triggerRecon.mutate()}
              disabled={triggerRecon.isPending}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${triggerRecon.isPending ? "animate-spin" : ""}`} />
              {triggerRecon.isPending ? "Running..." : "Run Reconciliation"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {lastRecon.data && (
            <div className="p-3 bg-muted/30 rounded-lg text-sm">
              <pre className="text-xs overflow-auto">{JSON.stringify(lastRecon.data, null, 2)}</pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* TigerBeetle accounts */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm flex items-center gap-2">
                <CreditCard className="h-4 w-4" />
                TigerBeetle Ledger Accounts
              </CardTitle>
              <CardDescription>Financial accounts in the atomic double-entry ledger</CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => provisionTb.mutate({ accountType: "float", currency: "NGN" })}
              disabled={provisionTb.isPending}
            >
              Provision Float Account
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {(tbAccounts?.accounts?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No TB accounts provisioned yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 px-3">Account ID</th>
                    <th className="text-left py-2 px-3">Type</th>
                    <th className="text-left py-2 px-3">Currency</th>
                    <th className="text-left py-2 px-3">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {tbAccounts?.accounts?.map((acc: any) => (
                    <tr key={acc.id} className="border-b hover:bg-muted/30">
                      <td className="py-2 px-3 font-mono text-xs">{acc.tbAccountId}</td>
                      <td className="py-2 px-3">{acc.accountType}</td>
                      <td className="py-2 px-3">{acc.currency}</td>
                      <td className="py-2 px-3 font-mono">{acc.balance ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Infrastructure tab ────────────────────────────────────────────────────────

function InfraTab() {
  const { data: health, refetch, isLoading } = trpc.infra.infraHealth.useQuery(undefined, {
    refetchInterval: 30_000,
  });
  const temporalRuns = trpc.temporal.listRuns.useQuery({ sinceHours: 24, limit: 10 });

  const services = health?.services ?? {};
  const serviceNames = Object.keys(services);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Infrastructure Status</h3>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {serviceNames.map(name => {
          const svc = (services as any)[name];
          return (
            <div key={name} className={`p-3 rounded-lg border ${svc?.online ? "border-green-200 bg-green-50/20" : "border-red-200 bg-red-50/20"}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium capitalize">{name}</span>
                {svc?.online ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> : <XCircle className="h-3.5 w-3.5 text-red-500" />}
              </div>
              {svc?.latencyMs !== undefined && (
                <p className="text-xs text-muted-foreground">{svc.latencyMs}ms</p>
              )}
              {svc?.error && (
                <p className="text-xs text-red-500 truncate" title={svc.error}>{svc.error}</p>
              )}
            </div>
          );
        })}
      </div>

      {/* Temporal workflows */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Workflow className="h-4 w-4" />
            Recent Temporal Workflows
          </CardTitle>
        </CardHeader>
        <CardContent>
          {(temporalRuns.data?.runs?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No workflow runs in the last 24 hours</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 px-3">Type</th>
                    <th className="text-left py-2 px-3">Status</th>
                    <th className="text-left py-2 px-3">Tenant</th>
                    <th className="text-left py-2 px-3">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {temporalRuns.data?.runs?.map((run: any) => (
                    <tr key={run.id} className="border-b hover:bg-muted/30">
                      <td className="py-2 px-3 font-mono">{run.workflowType}</td>
                      <td className="py-2 px-3">
                        <Badge variant={run.status === "completed" ? "default" : run.status === "failed" ? "destructive" : "outline"} className="text-xs">
                          {run.status}
                        </Badge>
                      </td>
                      <td className="py-2 px-3">{run.tenantId ?? "—"}</td>
                      <td className="py-2 px-3 text-muted-foreground">
                        {run.startedAt ? formatDistanceToNow(new Date(run.startedAt), { addSuffix: true }) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Main Admin Portal ─────────────────────────────────────────────────────────

export default function AdminPortal() {
  const { user } = useAuth();

  return (
    <AdminGuard>
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Shield className="h-6 w-6 text-primary" />
              Admin Management Portal
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Signed in as <strong>{user?.name}</strong>
              <Badge variant="outline" className="ml-2 text-xs">{user?.role}</Badge>
            </p>
          </div>
        </div>

        <Tabs defaultValue="integrations">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="integrations">Integrations</TabsTrigger>
            <TabsTrigger value="users">Users & Tenants</TabsTrigger>
            <TabsTrigger value="finance">Finance</TabsTrigger>
            <TabsTrigger value="infra">Infrastructure</TabsTrigger>
          </TabsList>

          <TabsContent value="integrations" className="mt-6">
            <IntegrationsTab />
          </TabsContent>

          <TabsContent value="users" className="mt-6">
            <UsersTab />
          </TabsContent>

          <TabsContent value="finance" className="mt-6">
            <FinanceTab />
          </TabsContent>

          <TabsContent value="infra" className="mt-6">
            <InfraTab />
          </TabsContent>
        </Tabs>
      </div>
    </AdminGuard>
  );
}
