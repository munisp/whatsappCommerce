/**
 * IntegrationsSettings — tenant-admin management of the Medusa / Twenty /
 * Odoo integrations backed by the transactional outbox (integrations router).
 *
 * Per-system card: enabled toggle, url + apiKey (masked on read,
 * replace-on-write), live testConnection, syncStatus badges
 * (pending/delivered/failed/dead), resync. Below: paginated outbox events
 * table with system/status/direction filters.
 *
 * Plus a Meta Catalog card (tenantConfig.getMetaCatalog/setMetaCatalog/
 * syncMetaCatalogNow/metaCatalogSyncStatus) and a Visual Search toggle
 * (getVisualSearch/setVisualSearch).
 */
import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useActiveTenant } from "@/contexts/TenantContext";
import {
  Camera, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Plug, RefreshCw, ShoppingBag, XCircle,
} from "lucide-react";
import { useEffect } from "react";

type System = "medusa" | "twenty" | "odoo";
const SYSTEMS: System[] = ["medusa", "twenty", "odoo"];
const SYSTEM_LABELS: Record<System, string> = {
  medusa: "Medusa",
  twenty: "Twenty CRM",
  odoo: "Odoo ERP",
};
const SYSTEM_DESCRIPTIONS: Record<System, string> = {
  medusa: "Products, orders and customers sync with the Medusa commerce engine.",
  twenty: "Customer 360 sync into the Twenty CRM.",
  odoo: "ERP sync of products, orders and customers with Odoo.",
};

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  delivered: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  failed: "bg-red-500/15 text-red-400 border-red-500/30",
  dead: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

const PAGE_SIZE = 25;

function SystemCard({ tenantId, system }: { tenantId: string; system: System }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.integrations.getConfig.useQuery({ tenantId, system });
  const { data: statusData, refetch: refetchStatus } = trpc.integrations.syncStatus.useQuery({
    tenantId,
    system,
  });

  const config = data?.config;
  const [url, setUrl] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const setConfig = trpc.integrations.setConfig.useMutation({
    onSuccess: () => {
      toast.success(`${SYSTEM_LABELS[system]} config saved`);
      setApiKey("");
      utils.integrations.getConfig.invalidate({ tenantId, system });
    },
    onError: (e) => toast.error(e.message),
  });

  const testConnection = trpc.integrations.testConnection.useMutation({
    onSuccess: (res) => {
      if (res.ok) {
        const uid = (res.detail as { uid?: number } | undefined)?.uid;
        setTestResult({ ok: true, message: uid != null ? `Connection OK (uid ${uid})` : "Connection OK" });
      } else {
        setTestResult({ ok: false, message: `${res.error}${res.status ? ` (HTTP ${res.status})` : ""}` });
      }
    },
    onError: (e) => setTestResult({ ok: false, message: e.message }),
  });

  const resync = trpc.integrations.resync.useMutation({
    onSuccess: (res) => {
      toast.success(
        `Re-sync enqueued: ${res.enqueued} events${res.skipped.length ? ` (skipped: ${res.skipped.join(", ")})` : ""}`,
      );
      refetchStatus();
      utils.integrations.listEvents.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const counts = statusData?.counts ?? {};
  const enabled = config?.enabled === true;
  // Local edits win over the fetched value until saved.
  const urlValue = url ?? config?.url ?? "";

  const save = (patch: { enabled?: boolean }) => {
    const payload: {
      tenantId: string;
      system: System;
      url?: string;
      apiKey?: string;
      enabled?: boolean;
    } = { tenantId, system, ...patch };
    // Only send secrets/URLs the operator actually changed — reads are masked.
    if (url !== null && url !== (config?.url ?? "")) payload.url = url;
    if (apiKey) payload.apiKey = apiKey;
    setConfig.mutate(payload);
  };

  const busy = setConfig.isPending || testConnection.isPending || resync.isPending;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Plug className="w-4 h-4 text-primary" />
            {SYSTEM_LABELS[system]}
            {enabled ? (
              <Badge variant="outline" className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
                Enabled
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">Disabled</Badge>
            )}
          </CardTitle>
          <CardDescription>{SYSTEM_DESCRIPTIONS[system]}</CardDescription>
        </div>
        <Switch
          checked={enabled}
          disabled={busy || isLoading || (!enabled && !urlValue)}
          onCheckedChange={(v) => save({ enabled: v })}
          aria-label={`Enable ${system}`}
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Base URL</Label>
            <Input
              value={urlValue}
              placeholder="https://…"
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>API key</Label>
            <Input
              type="password"
              value={apiKey}
              placeholder={config?.apiKey ? `Stored: ${config.apiKey} — type to replace` : "Not set"}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            onClick={() => save({})}
            disabled={busy || (url === null && !apiKey)}
          >
            {setConfig.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Save
          </Button>
          <Button
            size="sm" variant="outline"
            onClick={() => {
              setTestResult(null);
              testConnection.mutate({ tenantId, system });
            }}
            disabled={busy || !config?.url}
          >
            {testConnection.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Test connection
          </Button>
          <Button
            size="sm" variant="outline"
            onClick={() => resync.mutate({ tenantId, system })}
            disabled={busy || !enabled}
          >
            {resync.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
            Full re-sync
          </Button>
          {testResult && (
            <span
              className={`flex items-center gap-1.5 text-xs ${testResult.ok ? "text-emerald-400" : "text-red-400"}`}
            >
              {testResult.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
              {testResult.message}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-muted-foreground">Outbox:</span>
          {(["pending", "delivered", "failed", "dead"] as const).map((s) => (
            <Badge key={s} variant="outline" className={STATUS_STYLES[s]}>
              {s}: {(counts as Record<string, number>)[s] ?? 0}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Meta Catalog + Visual Search (tenantConfig router) ─────────────────────

type MetaCatalogStatus = {
  lastRunAt: string | null;
  lastAction: string | null;
  synced: number;
  failed: number;
  lastError: string | null;
} | null;

function MetaCatalogCard({ tenantId }: { tenantId: string }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.tenantConfig.getMetaCatalog.useQuery({ tenantId });
  const { data: statusData } = trpc.tenantConfig.metaCatalogSyncStatus.useQuery({ tenantId });
  const status = (statusData ?? null) as MetaCatalogStatus;

  const [catalogId, setCatalogId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (data) {
      setCatalogId(data.catalogId ?? "");
      setEnabled(data.enabled);
    }
  }, [data]);

  const invalidate = () => {
    utils.tenantConfig.getMetaCatalog.invalidate({ tenantId });
    utils.tenantConfig.metaCatalogSyncStatus.invalidate({ tenantId });
  };

  const save = trpc.tenantConfig.setMetaCatalog.useMutation({
    onSuccess: () => {
      toast.success("Meta catalog settings saved");
      setAccessToken("");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const syncNow = trpc.tenantConfig.syncMetaCatalogNow.useMutation({
    onSuccess: (r) => {
      if (r.lastError) {
        toast.error(`Sync finished with errors: ${r.lastError}`);
      } else {
        toast.success(`Catalog synced — ${r.synced} item${r.synced === 1 ? "" : "s"}`);
      }
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const canSave = catalogId.trim().length > 0 && !save.isPending;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <ShoppingBag className="w-4 h-4" /> Meta Product Catalog
          </CardTitle>
          <CardDescription>
            Push the product catalog to Meta for WhatsApp product messages and Commerce surfaces.
          </CardDescription>
        </div>
        {data && (
          <div className="flex items-center gap-2">
            <Label htmlFor="meta-catalog-enabled" className="text-sm text-muted-foreground">Enabled</Label>
            <Switch id="meta-catalog-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Catalog ID</Label>
                <Input value={catalogId} onChange={(e) => setCatalogId(e.target.value)} placeholder="1234567890" />
              </div>
              <div className="space-y-1.5">
                <Label>Access token</Label>
                <Input
                  type="password"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  placeholder={data?.hasAccessToken ? "•••••••• (stored — leave blank to keep)" : "System user access token"}
                />
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                disabled={!canSave}
                onClick={() => save.mutate({
                  tenantId,
                  catalogId: catalogId.trim(),
                  accessToken: accessToken.trim() || undefined,
                  enabled,
                })}
              >
                {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={syncNow.isPending || !data?.catalogId}
                onClick={() => syncNow.mutate({ tenantId })}
              >
                {syncNow.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Sync now
              </Button>
              {!data?.catalogId && (
                <p className="text-xs text-muted-foreground">Save a catalog ID before syncing.</p>
              )}
            </div>
            <div className="rounded-lg border p-3 text-sm space-y-1">
              <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Last sync</p>
              {status?.lastRunAt ? (
                <>
                  <p>
                    {new Date(status.lastRunAt).toLocaleString()}
                    {status.lastAction && <span className="text-muted-foreground"> — {status.lastAction}</span>}
                  </p>
                  <p className="text-muted-foreground">
                    {status.synced} synced{status.failed > 0 && <span className="text-red-400">, {status.failed} failed</span>}
                  </p>
                  {status.lastError && <p className="text-red-400 text-xs">Error: {status.lastError}</p>}
                </>
              ) : (
                <p className="text-muted-foreground">No sync has run yet.</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function VisualSearchCard({ tenantId }: { tenantId: string }) {
  const { data, isLoading } = trpc.tenantConfig.getVisualSearch.useQuery({ tenantId });
  const utils = trpc.useUtils();
  const setFlag = trpc.tenantConfig.setVisualSearch.useMutation({
    onSuccess: (r) => {
      toast.success(`Visual search ${r.enabled ? "enabled" : "disabled"}`);
      utils.tenantConfig.getVisualSearch.invalidate({ tenantId });
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 p-6">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
            <Camera className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">Visual product search</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Let customers send a photo on WhatsApp to find matching products.
            </p>
          </div>
        </div>
        {isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        ) : (
          <Switch
            checked={data?.enabled ?? true}
            disabled={setFlag.isPending}
            onCheckedChange={(v) => setFlag.mutate({ tenantId, enabled: v })}
          />
        )}
      </CardContent>
    </Card>
  );
}

export default function IntegrationsSettings() {
  const { activeTenantId } = useActiveTenant();
  const tenantId = activeTenantId;

  const [systemFilter, setSystemFilter] = useState<"all" | System>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "delivered" | "failed" | "dead">("all");
  const [directionFilter, setDirectionFilter] = useState<"all" | "out" | "in">("all");
  const [offset, setOffset] = useState(0);

  const { data: eventsData, isLoading: eventsLoading } = trpc.integrations.listEvents.useQuery({
    tenantId,
    system: systemFilter === "all" ? undefined : systemFilter,
    status: statusFilter === "all" ? undefined : statusFilter,
    direction: directionFilter === "all" ? undefined : directionFilter,
    limit: PAGE_SIZE,
    offset,
  });
  const events = eventsData?.events ?? [];

  const setFilter = (fn: () => void) => {
    setOffset(0);
    fn();
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Plug className="w-6 h-6 text-primary" />
            Integration Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Connect Medusa, Twenty CRM and Odoo. Secrets are write-only; deliveries flow through the
            transactional outbox below.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4">
          {SYSTEMS.map((s) => (
            <SystemCard key={s} tenantId={tenantId} system={s} />
          ))}
          <MetaCatalogCard tenantId={tenantId} />
          <VisualSearchCard tenantId={tenantId} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Integration events</CardTitle>
            <CardDescription>Newest outbox/inbox events first.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2 flex-wrap">
              <Select value={systemFilter} onValueChange={(v) => setFilter(() => setSystemFilter(v as typeof systemFilter))}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All systems</SelectItem>
                  {SYSTEMS.map((s) => (
                    <SelectItem key={s} value={s}>{SYSTEM_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={(v) => setFilter(() => setStatusFilter(v as typeof statusFilter))}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="delivered">Delivered</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="dead">Dead</SelectItem>
                </SelectContent>
              </Select>
              <Select value={directionFilter} onValueChange={(v) => setFilter(() => setDirectionFilter(v as typeof directionFilter))}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Both directions</SelectItem>
                  <SelectItem value="out">Outbound</SelectItem>
                  <SelectItem value="in">Inbound</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>System</TableHead>
                    <TableHead>Dir</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead>Last error</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {eventsLoading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading events…
                      </TableCell>
                    </TableRow>
                  ) : events.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                        No events match the current filters.
                      </TableCell>
                    </TableRow>
                  ) : (
                    events.map((ev) => (
                      <TableRow key={ev.id}>
                        <TableCell className="font-medium">{ev.system}</TableCell>
                        <TableCell>{ev.direction === "out" ? "→ out" : "← in"}</TableCell>
                        <TableCell>
                          {ev.entity}
                          {ev.entityId ? <span className="text-muted-foreground text-xs"> · {ev.entityId.slice(0, 8)}</span> : null}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={STATUS_STYLES[ev.status] ?? ""}>{ev.status}</Badge>
                        </TableCell>
                        <TableCell className="text-right">{ev.attempts}</TableCell>
                        <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground" title={ev.lastError ?? ""}>
                          {ev.lastError ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(ev.createdAt).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Offset {offset}</p>
              <div className="flex gap-2">
                <Button
                  variant="outline" size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                >
                  <ChevronLeft className="w-4 h-4 mr-1" /> Prev
                </Button>
                <Button
                  variant="outline" size="sm"
                  disabled={events.length < PAGE_SIZE}
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                >
                  Next <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
