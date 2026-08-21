// === W28 odoo-sync (Coder A) ===
// Tenant portal Odoo ERP settings: connect (url/db/username/api key), test
// connection, sync mode (push | batch | ondemand), account mapping, enable
// toggle, and the reconciliation queue (failed outbox rows + retry).
import { useEffect, useState } from "react";
import { TenantPortalLayout } from "@/components/TenantPortalLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type SyncMode = "push" | "batch" | "ondemand";

export default function PortalOdooSettings() {
  const utils = trpc.useUtils();
  const { data } = trpc.odooSync.getConfig.useQuery();
  const { data: outbox } = trpc.odooSync.outbox.list.useQuery({});

  const [url, setUrl] = useState("");
  const [db, setDb] = useState("");
  const [username, setUsername] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [syncMode, setSyncMode] = useState<SyncMode>("ondemand");
  const [mapping, setMapping] = useState("{}");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (data?.config) {
      setUrl(data.config.url ?? "");
      setDb(data.config.db ?? "");
      setUsername(data.config.username ?? "");
      setSyncMode((data.config.syncMode as SyncMode) ?? "ondemand");
      setMapping(JSON.stringify(data.config.accountMapping ?? {}, null, 2));
    }
  }, [data]);

  const invalidate = () => {
    utils.odooSync.getConfig.invalidate();
    utils.odooSync.outbox.list.invalidate();
  };

  const save = trpc.odooSync.saveConfig.useMutation({
    onSuccess: () => { setNotice("Saved."); setApiKey(""); invalidate(); },
    onError: (e) => setNotice(`Save failed: ${e.message}`),
  });
  const test = trpc.odooSync.testConnection.useMutation({
    onSuccess: (r) => { setNotice(r.ok ? `Connection OK (uid ${r.uid}).` : `Connection failed: ${r.error}`); invalidate(); },
    onError: (e) => setNotice(`Test failed: ${e.message}`),
  });
  const setEnabled = trpc.odooSync.setEnabled.useMutation({ onSuccess: invalidate });
  const syncNow = trpc.odooSync.syncNow.useMutation({
    onSuccess: (r) => { setNotice(`Sync run: ${r.worker.sent} sent, ${r.stats.failed} failed.`); invalidate(); },
    onError: (e) => setNotice(`Sync failed: ${e.message}`),
  });
  const retry = trpc.odooSync.outbox.retry.useMutation({ onSuccess: invalidate });
  const retryAll = trpc.odooSync.outbox.retryAllFailed.useMutation({ onSuccess: invalidate });

  const cfg = data?.config ?? null;
  const stats = data?.stats;

  const onSave = () => {
    let accountMapping: Record<string, unknown> | undefined;
    try {
      accountMapping = mapping.trim() ? JSON.parse(mapping) : {};
    } catch {
      setNotice("Account mapping is not valid JSON.");
      return;
    }
    save.mutate({
      url, db,
      username: username || undefined,
      ...(apiKey ? { apiKey } : {}),
      syncMode,
      accountMapping,
    });
  };

  return (
    <TenantPortalLayout>
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Odoo ERP Sync</h1>
          {cfg && (
            <Badge variant={cfg.enabled ? "default" : "secondary"}>
              {cfg.enabled ? "Enabled" : "Disabled"}
            </Badge>
          )}
        </div>

        {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

        <Card>
          <CardHeader><CardTitle>Connection</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <label className="block text-sm">Odoo URL
              <input className="mt-1 w-full rounded border bg-background p-2" value={url}
                onChange={(e) => setUrl(e.target.value)} placeholder="https://mycompany.odoo.com (or mock://odoo)" />
            </label>
            <label className="block text-sm">Database
              <input className="mt-1 w-full rounded border bg-background p-2" value={db}
                onChange={(e) => setDb(e.target.value)} placeholder="mycompany" />
            </label>
            <label className="block text-sm">Username
              <input className="mt-1 w-full rounded border bg-background p-2" value={username}
                onChange={(e) => setUsername(e.target.value)} placeholder="api@example.com" />
            </label>
            <label className="block text-sm">API key {cfg?.hasApiKey ? "(saved — leave blank to keep)" : ""}
              <input className="mt-1 w-full rounded border bg-background p-2" type="password" value={apiKey}
                onChange={(e) => setApiKey(e.target.value)} placeholder="••••••••" />
            </label>
            <label className="block text-sm">Sync mode
              <select className="mt-1 w-full rounded border bg-background p-2" value={syncMode}
                onChange={(e) => setSyncMode(e.target.value as SyncMode)}>
                <option value="push">Push on event (immediate)</option>
                <option value="batch">Batch (nightly summary)</option>
                <option value="ondemand">On demand (manual sync)</option>
              </select>
            </label>
            <label className="block text-sm">Account mapping (JSON)
              <textarea className="mt-1 w-full rounded border bg-background p-2 font-mono text-xs" rows={4}
                value={mapping} onChange={(e) => setMapping(e.target.value)} />
            </label>
            <div className="flex gap-2">
              <Button onClick={onSave} disabled={save.isPending}>Save</Button>
              <Button variant="outline" onClick={() => test.mutate(undefined)} disabled={test.isPending || !cfg}>
                Test connection
              </Button>
              {cfg && (
                <Button variant={cfg.enabled ? "destructive" : "default"}
                  onClick={() => setEnabled.mutate({ enabled: !cfg.enabled })}>
                  {cfg.enabled ? "Disable" : "Enable"}
                </Button>
              )}
            </div>
            {cfg?.lastTestedAt && (
              <p className="text-xs text-muted-foreground">
                Last test: {cfg.lastTestOk ? "OK" : `failed — ${cfg.lastTestError ?? "unknown"}`}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Sync queue</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {stats && (
              <div className="flex gap-4 text-sm">
                <span>Pending: <b>{stats.pending + stats.sending}</b></span>
                <span>Synced: <b>{stats.sent}</b></span>
                <span className={stats.failed > 0 ? "text-red-500" : ""}>Failed: <b>{stats.failed}</b></span>
              </div>
            )}
            <div className="flex gap-2">
              <Button onClick={() => syncNow.mutate()} disabled={syncNow.isPending || !cfg?.enabled}>Sync now</Button>
              <Button variant="outline" onClick={() => retryAll.mutate()} disabled={retryAll.isPending}>
                Retry all failed
              </Button>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th>Entity</th><th>Status</th><th>Attempts</th><th>Odoo ref</th><th>Last error</th><th></th>
                </tr>
              </thead>
              <tbody>
                {(outbox?.rows ?? []).map((r: any) => (
                  <tr key={r.id} className="border-t">
                    <td>{r.entityType} · {String(r.entityId).slice(0, 8)}</td>
                    <td><Badge variant={r.status === "failed" ? "destructive" : r.status === "sent" ? "default" : "secondary"}>{r.status}</Badge></td>
                    <td>{r.attempts}/{r.maxAttempts}</td>
                    <td className="font-mono text-xs">{r.odooRef ?? "—"}</td>
                    <td className="max-w-[240px] truncate text-xs">{r.lastError ?? ""}</td>
                    <td>{r.status === "failed" && (
                      <Button size="sm" variant="outline" onClick={() => retry.mutate({ id: r.id })}>Retry</Button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </TenantPortalLayout>
  );
}
