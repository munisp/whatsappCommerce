import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  Database, CheckCircle, XCircle, Upload, RefreshCw,
  ExternalLink, Info, Zap, Tag, BarChart3, Settings,
} from "lucide-react";

export default function LabelStudioPipe() {
  const [form, setForm] = useState({ labelStudioUrl: "", apiToken: "", projectId: "", projectName: "", autoExport: false });
  const [testing, setTesting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [testResult, setTestResult] = useState<{ connected: boolean; error?: string; projectCount?: number; projects?: { id: number; title: string }[] } | null>(null);

  const { data: configData, refetch: refetchConfig } = trpc.labelStudio.getConfig.useQuery();
  // Populate form when config loads
  const [formInitialized, setFormInitialized] = useState(false);
  if (configData?.config && !formInitialized) {
    const c = configData.config;
    setForm({
      labelStudioUrl: c.labelStudioUrl ?? "",
      apiToken: c.apiToken ?? "",
      projectId: c.projectId ? String(c.projectId) : "",
      projectName: c.projectName ?? "",
      autoExport: c.autoExport ?? false,
    });
    setFormInitialized(true);
  }
  const { data: statsData } = trpc.labelStudio.stats.useQuery();
  const saveConfigMutation = trpc.labelStudio.saveConfig.useMutation();
  const testConnectionMutation = trpc.labelStudio.testConnection.useMutation();
  const exportSessionsMutation = trpc.labelStudio.exportSessions.useMutation();
  const exportCorrectionsMutation = trpc.viCorrections.exportToLabelStudio.useMutation();
  const { data: corrStats } = trpc.viCorrections.stats.useQuery();

  const cfg = configData?.config;
  const stats = statsData as { config: { isConnected?: boolean; exportedCount?: number; lastExportedAt?: Date | null } | null; totalSessions?: number; completedSessions?: number; totalCorrections?: number; exportedCorrections?: number; pendingExport?: number } | undefined;

  const handleSave = async () => {
    try {
      await saveConfigMutation.mutateAsync({
        labelStudioUrl: form.labelStudioUrl || undefined,
        apiToken: form.apiToken || undefined,
        projectId: form.projectId ? parseInt(form.projectId) : undefined,
        projectName: form.projectName || undefined,
        autoExport: form.autoExport,
      });
      toast.success("Label Studio config saved");
      refetchConfig();
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : "Save failed"); }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await testConnectionMutation.mutateAsync();
      setTestResult(result as typeof testResult);
      if ((result as { connected: boolean }).connected) toast.success("Connected to Label Studio!");
      else toast.error((result as { error?: string }).error ?? "Connection failed");
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : "Test failed"); }
    finally { setTesting(false); }
  };

  const handleExportSessions = async () => {
    setExporting(true);
    try {
      const result = await exportSessionsMutation.mutateAsync({ limit: 50 });
      const r = result as { exported: number; message?: string; error?: string };
      if (r.error) toast.error(r.error);
      else toast.success(r.message ?? `Exported ${r.exported} sessions`);
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : "Export failed"); }
    finally { setExporting(false); }
  };

  const handleExportCorrections = async () => {
    try {
      const result = await exportCorrectionsMutation.mutateAsync();
      const r = result as { exported: number; message?: string; error?: string };
      if (r.error) toast.error(r.error);
      else toast.success(r.message ?? `Exported ${r.exported} corrections`);
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : "Export failed"); }
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6 max-w-5xl">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Database className="w-6 h-6 text-violet-600" /> Label Studio Annotation Pipe
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Export visual inventory scan sessions and human corrections to Label Studio for AI model training
          </p>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Scan Sessions", value: stats?.completedSessions ?? 0, sub: "completed", icon: <BarChart3 className="w-4 h-4 text-violet-500" /> },
            { label: "Total Corrections", value: corrStats?.total ?? 0, sub: "ground-truth labels", icon: <Tag className="w-4 h-4 text-emerald-500" /> },
            { label: "Pending Export", value: corrStats?.pending ?? 0, sub: "not yet exported", icon: <Upload className="w-4 h-4 text-amber-500" /> },
            { label: "Exported Tasks", value: stats?.config?.exportedCount ?? 0, sub: "to Label Studio", icon: <CheckCircle className="w-4 h-4 text-blue-500" /> },
          ].map(s => (
            <Card key={s.label}>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 mb-1">{s.icon}<span className="text-xs text-muted-foreground">{s.label}</span></div>
                <p className="text-2xl font-bold">{s.value}</p>
                <p className="text-xs text-muted-foreground">{s.sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Connection config */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2"><Settings className="w-4 h-4" /> Connection Config</CardTitle>
                {cfg?.isConnected ? (
                  <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-xs"><CheckCircle className="w-3 h-3 mr-1" /> Connected</Badge>
                ) : (
                  <Badge variant="outline" className="text-xs text-muted-foreground"><XCircle className="w-3 h-3 mr-1" /> Not connected</Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="text-xs">Label Studio URL</Label>
                <Input placeholder="http://label-studio:8080" value={form.labelStudioUrl} onChange={e => setForm(p => ({ ...p, labelStudioUrl: e.target.value }))} className="mt-1 text-sm" />
              </div>
              <div>
                <Label className="text-xs">API Token</Label>
                <Input type="password" placeholder="Token from Account → Access Token" value={form.apiToken} onChange={e => setForm(p => ({ ...p, apiToken: e.target.value }))} className="mt-1 text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Project ID</Label>
                  <Input type="number" placeholder="1" value={form.projectId} onChange={e => setForm(p => ({ ...p, projectId: e.target.value }))} className="mt-1 text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Project Name</Label>
                  <Input placeholder="Nigerian FMCG" value={form.projectName} onChange={e => setForm(p => ({ ...p, projectName: e.target.value }))} className="mt-1 text-sm" />
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <div>
                  <p className="text-xs font-medium">Auto-export new sessions</p>
                  <p className="text-xs text-muted-foreground">Pipe new scans automatically</p>
                </div>
                <Switch checked={form.autoExport} onCheckedChange={v => setForm(p => ({ ...p, autoExport: v }))} />
              </div>
              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={handleSave} disabled={saveConfigMutation.isPending} className="flex-1 gap-1">
                  {saveConfigMutation.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : null} Save
                </Button>
                <Button size="sm" variant="outline" onClick={handleTest} disabled={testing} className="flex-1 gap-1">
                  {testing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />} Test
                </Button>
              </div>
              {testResult && (
                <div className={`text-xs p-2 rounded border ${testResult.connected ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-red-50 border-red-200 text-red-700"}`}>
                  {testResult.connected ? `✓ Connected — ${testResult.projectCount} projects found` : `✗ ${testResult.error}`}
                  {testResult.projects && testResult.projects.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {testResult.projects.slice(0, 5).map(p => <div key={p.id}>#{p.id} {p.title}</div>)}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Export actions */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2"><Upload className="w-4 h-4 text-violet-600" /> Export Scan Sessions</CardTitle>
                <CardDescription className="text-xs">Push completed scan sessions as annotation tasks to Label Studio. Each task includes the shelf image and YOLO bounding box predictions as pre-annotations.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={handleExportSessions} disabled={exporting || !cfg?.isConnected} className="w-full gap-1">
                  {exporting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  Export Sessions to Label Studio
                </Button>
                {!cfg?.isConnected && <p className="text-xs text-muted-foreground mt-2 text-center">Configure and test connection first</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2"><Tag className="w-4 h-4 text-emerald-600" /> Export Ground-Truth Corrections</CardTitle>
                <CardDescription className="text-xs">Push human-verified count corrections as ground-truth annotations. These feed directly into the active learning loop for model fine-tuning.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm">{corrStats?.pending ?? 0} corrections pending export</span>
                  {(corrStats?.pending ?? 0) > 0 && <Badge className="bg-amber-100 text-amber-700 text-xs">Pending</Badge>}
                </div>
                <Button onClick={handleExportCorrections} disabled={exportCorrectionsMutation.isPending || !cfg?.isConnected || (corrStats?.pending ?? 0) === 0} variant="outline" className="w-full gap-1">
                  {exportCorrectionsMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Tag className="w-4 h-4" />}
                  Export {corrStats?.pending ?? 0} Corrections
                </Button>
              </CardContent>
            </Card>

            {/* How it works */}
            <Card className="bg-violet-50/50 dark:bg-violet-950/20 border-violet-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs flex items-center gap-1"><Info className="w-3.5 h-3.5" /> Active Learning Loop</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground space-y-1">
                {["1. Operators scan shelves → sessions saved to S3", "2. Corrections made inline in Scan History", "3. Export corrections here as ground-truth labels", "4. Label Studio project accumulates training data", "5. Fine-tune YOLO/VLM on Nigerian FMCG dataset", "6. Deploy improved model → higher accuracy"].map((s, i) => (
                  <p key={i}>{s}</p>
                ))}
                <a href="https://labelstud.io/guide/get_started.html" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-violet-600 hover:underline mt-2">
                  <ExternalLink className="w-3 h-3" /> Label Studio docs
                </a>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
