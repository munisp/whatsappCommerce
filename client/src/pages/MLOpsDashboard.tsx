import { useState, useMemo } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
  Activity, AlertTriangle, CheckCircle2, Clock, Database, RefreshCw,
  TrendingUp, TrendingDown, Zap, BarChart3, GitBranch, Play, Cpu,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, BarChart, Bar, ReferenceLine,
} from "recharts";

const RUN_COLORS = ["#60a5fa", "#34d399", "#fbbf24", "#f472b6", "#a78bfa"];

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    FINISHED: { label: "Finished", cls: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
    RUNNING: { label: "Running", cls: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
    FAILED: { label: "Failed", cls: "bg-red-500/20 text-red-400 border-red-500/30" },
    SCHEDULED: { label: "Scheduled", cls: "bg-amber-500/20 text-amber-400 border-amber-500/30" },
    UNKNOWN: { label: "Unknown", cls: "bg-white/10 text-white/40 border-white/20" },
  };
  const s = map[status] ?? map.UNKNOWN;
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${s.cls}`}>{s.label}</span>;
}

function DriftAlertBadge({ level }: { level: string }) {
  if (level === "healthy") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"><CheckCircle2 className="w-3 h-3" /> Healthy</span>;
  if (level === "warning") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/20 text-amber-400 border border-amber-500/30"><AlertTriangle className="w-3 h-3" /> Warning</span>;
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/20 text-red-400 border border-red-500/30"><AlertTriangle className="w-3 h-3" /> Critical</span>;
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatTs(ts: number) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

export default function MLOpsDashboard() {
  const [selectedExperiment, setSelectedExperiment] = useState<string>("");
  const [driftDays, setDriftDays] = useState(14);
  const [retrainingModel, setRetrainingModel] = useState<string | null>(null);
  const [selectedMetric, setSelectedMetric] = useState<string>("");
  const [hpoMode, setHpoMode] = useState(false);
  const [showCreateAbTest, setShowCreateAbTest] = useState(false);
  const [abForm, setAbForm] = useState({
    modelName: "fraud_detection",
    championVersion: "v1",
    challengerVersion: "v2",
    trafficSplitPct: 20,
    notes: "",
  });

  const experimentsQ = trpc.mlOps.getExperiments.useQuery();
  const trainingStatusQ = trpc.mlOps.getTrainingStatus.useQuery();
  const driftQ = trpc.mlOps.getDriftMetrics.useQuery({ days: driftDays });
  const abQ = trpc.mlOps.getAbComparison.useQuery();
  const allRunsQ = trpc.mlOps.getAllRuns.useQuery();
  const pipelineQ = trpc.mlOps.getDataPipelineStatus.useQuery();
  const driftAlertsQ = trpc.mlOps.getDriftAlerts.useQuery();
  const abTestsQ = trpc.mlAbTest.list.useQuery();
  const snapshotsQ = trpc.datasetSnapshot.list.useQuery();
  const metricHistoryQ = trpc.mlOps.getMetricHistory.useQuery(
    { experimentId: selectedExperiment },
    { enabled: !!selectedExperiment }
  );
  const availableMetrics = metricHistoryQ.data?.metrics ?? [];
  const activeMetric = selectedMetric && availableMetrics.includes(selectedMetric)
    ? selectedMetric
    : availableMetrics[0] ?? "";

  const runsForExp = trpc.mlOps.getMlflowRuns.useQuery(
    { experimentId: selectedExperiment },
    { enabled: !!selectedExperiment }
  );

  const triggerRetrain = trpc.mlOps.triggerRetraining.useMutation({
    onSuccess: (data) => {
      toast.success(data.message);
      setRetrainingModel(null);
    },
    onError: (err) => {
      toast.error(`Retraining failed: ${err.message}`);
      setRetrainingModel(null);
    },
  });

  const createAbTest = trpc.mlAbTest.create.useMutation({
    onSuccess: () => { toast.success("A/B test created"); setShowCreateAbTest(false); abTestsQ.refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const concludeAbTest = trpc.mlAbTest.conclude.useMutation({
    onSuccess: () => { toast.success("A/B test concluded"); abTestsQ.refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const driftChartData = useMemo(() =>
    (driftQ.data?.series ?? []).map(d => ({
      date: d.label,
      PSI: parseFloat(d.psi.toFixed(4)),
      "KL Divergence": parseFloat(d.klDivergence.toFixed(4)),
      "KS Statistic": parseFloat(d.ksStatistic.toFixed(4)),
    })),
    [driftQ.data]
  );

  const handleTriggerRetrain = (modelName: string) => {
    setRetrainingModel(modelName);
    triggerRetrain.mutate({ modelName, reason: hpoMode ? "HPO sweep from ML Ops dashboard" : "Manual trigger from ML Ops dashboard" });
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">ML Ops Dashboard</h1>
            <p className="text-white/50 text-sm mt-1">Continuous training, drift monitoring, and model A/B comparison</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch id="hpo-mode" checked={hpoMode} onCheckedChange={setHpoMode} />
              <Label htmlFor="hpo-mode" className="text-white/60 text-sm cursor-pointer">
                <Zap className="w-3.5 h-3.5 inline mr-1 text-amber-400" />HPO Mode
              </Label>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { experimentsQ.refetch(); trainingStatusQ.refetch(); driftQ.refetch(); allRunsQ.refetch(); driftAlertsQ.refetch(); abTestsQ.refetch(); snapshotsQ.refetch(); }}
              className="border-white/20 text-white/70 hover:text-white"
            >
              <RefreshCw className="w-4 h-4 mr-2" /> Refresh
            </Button>
          </div>
        </div>

        {/* Training Status Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {trainingStatusQ.isLoading && [0, 1].map(i => (
            <Card key={i} className="bg-[#0f1923] border-white/10 animate-pulse">
              <CardContent className="p-5 h-32" />
            </Card>
          ))}
          {(trainingStatusQ.data ?? []).map(exp => (
            <Card key={exp.experimentId} className="bg-[#0f1923] border-white/10 hover:border-white/20 transition-all">
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 rounded-lg bg-violet-500/20 flex items-center justify-center">
                      <Cpu className="w-5 h-5 text-violet-400" />
                    </div>
                    <div>
                      <p className="text-white font-medium text-sm capitalize">{exp.experimentName.replace(/_/g, " ")}</p>
                      <p className="text-white/40 text-xs">{exp.latestRunName}</p>
                    </div>
                  </div>
                  <StatusBadge status={exp.status} />
                </div>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-white/40 text-xs">Runs</p>
                    <p className="text-white font-semibold">{exp.totalRuns}</p>
                  </div>
                  <div>
                    <p className="text-white/40 text-xs">Passed</p>
                    <p className="text-emerald-400 font-semibold">{exp.finishedRuns}</p>
                  </div>
                  <div>
                    <p className="text-white/40 text-xs">Failed</p>
                    <p className="text-red-400 font-semibold">{exp.failedRuns}</p>
                  </div>
                </div>
                {Object.entries(exp.metrics).length > 0 && (
                  <div className="mt-3 pt-3 border-t border-white/5 flex flex-wrap gap-2">
                    {Object.entries(exp.metrics).slice(0, 3).map(([k, v]) => (
                      <span key={k} className="text-xs bg-white/5 rounded px-2 py-0.5 text-white/60">
                        {k}: <span className="text-white/90">{typeof v === "number" ? v.toFixed(4) : v}</span>
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-white/30 text-xs flex items-center gap-1">
                    <Clock className="w-3 h-3" /> {formatDuration(exp.durationMs)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className={`h-7 text-xs ${hpoMode ? "border-amber-500/30 text-amber-400 hover:bg-amber-500/10" : "border-violet-500/30 text-violet-400 hover:bg-violet-500/10"}`}
                    disabled={retrainingModel === exp.experimentName}
                    onClick={() => handleTriggerRetrain(exp.experimentName)}
                  >
                    {retrainingModel === exp.experimentName ? (
                      <><RefreshCw className="w-3 h-3 mr-1 animate-spin" /> Queuing…</>
                    ) : hpoMode ? (
                      <><Zap className="w-3 h-3 mr-1" /> HPO Sweep</>
                    ) : (
                      <><Play className="w-3 h-3 mr-1" /> Retrain</>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}

          {/* Data Pipeline Status */}
          <Card className="bg-[#0f1923] border-white/10">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-9 h-9 rounded-lg bg-teal-500/20 flex items-center justify-center">
                  <Database className="w-5 h-5 text-teal-400" />
                </div>
                <div>
                  <p className="text-white font-medium text-sm">Data Pipeline</p>
                  <p className="text-white/40 text-xs">PostgreSQL → Feature Store</p>
                </div>
              </div>
              {pipelineQ.data && (
                <>
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <span className="text-white/50">New transactions (7d)</span>
                    <span className="text-white font-medium">{pipelineQ.data.newTransactionsSinceLastTrain.toLocaleString()} / {pipelineQ.data.thresholdToRetrain.toLocaleString()}</span>
                  </div>
                  <Progress value={pipelineQ.data.percentToThreshold} className="h-2 bg-white/10" />
                  <p className="text-white/30 text-xs mt-2">
                    {pipelineQ.data.percentToThreshold}% to retraining threshold
                  </p>
                  {pipelineQ.data.lastPipelineRun && (
                    <p className="text-white/30 text-xs mt-1 flex items-center gap-1">
                      <Clock className="w-3 h-3" /> Last run: {new Date(pipelineQ.data.lastPipelineRun).toLocaleString()}
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="drift" className="space-y-4">
          <TabsList className="bg-[#0f1923] border border-white/10">
            <TabsTrigger value="drift" className="data-[state=active]:bg-white/10">Drift Monitoring</TabsTrigger>
            <TabsTrigger value="runs" className="data-[state=active]:bg-white/10">Run History</TabsTrigger>
            <TabsTrigger value="ab" className="data-[state=active]:bg-white/10">A/B Comparison</TabsTrigger>
            <TabsTrigger value="curves" className="data-[state=active]:bg-white/10">Metric Curves</TabsTrigger>
            <TabsTrigger value="abtests" className="data-[state=active]:bg-white/10">A/B Tests</TabsTrigger>
            <TabsTrigger value="alerts" className="data-[state=active]:bg-white/10">Drift Alerts</TabsTrigger>
            <TabsTrigger value="snapshots" className="data-[state=active]:bg-white/10">Snapshots</TabsTrigger>
          </TabsList>

          {/* Drift Monitoring Tab */}
          <TabsContent value="drift" className="space-y-4">
            <Card className="bg-[#0f1923] border-white/10">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-white text-base flex items-center gap-2">
                    <Activity className="w-4 h-4 text-amber-400" /> Feature Drift Metrics
                  </CardTitle>
                  <div className="flex items-center gap-3">
                    {driftQ.data && <DriftAlertBadge level={driftQ.data.summary.alertLevel} />}
                    <Select value={driftDays.toString()} onValueChange={v => setDriftDays(parseInt(v))}>
                      <SelectTrigger className="w-24 h-8 bg-white/5 border-white/10 text-white text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="7">7 days</SelectItem>
                        <SelectItem value="14">14 days</SelectItem>
                        <SelectItem value="30">30 days</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {driftQ.data && (
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <div className="bg-white/5 rounded-lg p-3 text-center">
                      <p className="text-white/40 text-xs mb-1">PSI (latest)</p>
                      <p className={`text-lg font-bold ${driftQ.data.summary.currentPsi > 0.2 ? "text-red-400" : driftQ.data.summary.currentPsi > 0.1 ? "text-amber-400" : "text-emerald-400"}`}>
                        {driftQ.data.summary.currentPsi.toFixed(4)}
                      </p>
                      <p className="text-white/30 text-xs mt-1">threshold: 0.2</p>
                    </div>
                    <div className="bg-white/5 rounded-lg p-3 text-center">
                      <p className="text-white/40 text-xs mb-1">KL Divergence</p>
                      <p className="text-lg font-bold text-blue-400">{driftQ.data.summary.currentKlDivergence.toFixed(4)}</p>
                      <p className="text-white/30 text-xs mt-1">lower is better</p>
                    </div>
                    <div className="bg-white/5 rounded-lg p-3 text-center">
                      <p className="text-white/40 text-xs mb-1">KS Statistic</p>
                      <p className="text-lg font-bold text-purple-400">{driftQ.data.summary.currentKsStatistic.toFixed(4)}</p>
                      <p className="text-white/30 text-xs mt-1">distribution shift</p>
                    </div>
                  </div>
                )}
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={driftChartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="date" tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 11 }} tickLine={false} />
                    <YAxis tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 11 }} tickLine={false} axisLine={false} />
                    <Tooltip
                      contentStyle={{ background: "#0f1923", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}
                      labelStyle={{ color: "rgba(255,255,255,0.7)" }}
                    />
                    <Legend wrapperStyle={{ color: "rgba(255,255,255,0.5)", fontSize: 12 }} />
                    <ReferenceLine y={0.2} stroke="rgba(239,68,68,0.5)" strokeDasharray="4 4" label={{ value: "PSI threshold", fill: "rgba(239,68,68,0.6)", fontSize: 10 }} />
                    <Line type="monotone" dataKey="PSI" stroke="#f59e0b" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="KL Divergence" stroke="#60a5fa" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="KS Statistic" stroke="#a78bfa" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
                {driftQ.data?.summary.retrainRecommended && (
                  <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-red-400 text-sm">
                      <AlertTriangle className="w-4 h-4" />
                      PSI exceeds threshold — retraining recommended
                    </div>
                    <Button size="sm" className="bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30" onClick={() => handleTriggerRetrain("fraud_detection")}>
                      <Zap className="w-3 h-3 mr-1" /> Trigger Retrain
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Run History Tab */}
          <TabsContent value="runs" className="space-y-4">
            <Card className="bg-[#0f1923] border-white/10">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-white text-base flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-blue-400" /> MLflow Run History
                  </CardTitle>
                  <Select value={selectedExperiment} onValueChange={setSelectedExperiment}>
                    <SelectTrigger className="w-48 h-8 bg-white/5 border-white/10 text-white text-xs">
                      <SelectValue placeholder="All experiments" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">All experiments</SelectItem>
                      {(experimentsQ.data ?? []).map(e => (
                        <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10">
                        <th className="text-left text-white/40 font-medium py-2 pr-4">Run</th>
                        <th className="text-left text-white/40 font-medium py-2 pr-4">Experiment</th>
                        <th className="text-left text-white/40 font-medium py-2 pr-4">Status</th>
                        <th className="text-left text-white/40 font-medium py-2 pr-4">Duration</th>
                        <th className="text-left text-white/40 font-medium py-2 pr-4">Key Metrics</th>
                        <th className="text-left text-white/40 font-medium py-2">Started</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(selectedExperiment ? runsForExp.data : allRunsQ.data)?.map(run => (
                        <tr key={run.runId} className="border-b border-white/5 hover:bg-white/3 transition-colors">
                          <td className="py-3 pr-4">
                            <div>
                              <p className="text-white font-medium">{run.runName}</p>
                              <p className="text-white/30 text-xs font-mono">{run.runId.slice(0, 12)}…</p>
                            </div>
                          </td>
                          <td className="py-3 pr-4 text-white/60 text-xs capitalize">
                            {"experimentName" in run ? (run as Record<string, unknown>).experimentName as string : selectedExperiment}
                          </td>
                          <td className="py-3 pr-4"><StatusBadge status={run.status} /></td>
                          <td className="py-3 pr-4 text-white/60 text-xs">{formatDuration(run.endTime - run.startTime)}</td>
                          <td className="py-3 pr-4">
                            <div className="flex flex-wrap gap-1">
                              {Object.entries(run.metrics).slice(0, 3).map(([k, v]) => (
                                <span key={k} className="text-xs bg-white/5 rounded px-1.5 py-0.5 text-white/60">
                                  {k}: <span className="text-white/90">{typeof v === "number" ? v.toFixed(4) : v}</span>
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="py-3 text-white/40 text-xs">{formatTs(run.startTime)}</td>
                        </tr>
                      ))}
                      {!allRunsQ.isLoading && !allRunsQ.data?.length && !selectedExperiment && (
                        <tr><td colSpan={6} className="py-8 text-center text-white/30">No runs found</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Loss curve chart for selected experiment */}
                {selectedExperiment && runsForExp.data && runsForExp.data.length > 0 && (
                  <div className="mt-6">
                    <p className="text-white/50 text-xs mb-3 font-medium uppercase tracking-wider">Training Loss Curve</p>
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart
                        data={runsForExp.data[0]?.metricHistory?.train_loss?.map(p => ({ step: p.step, loss: parseFloat(p.value.toFixed(6)) })) ?? []}
                        margin={{ top: 5, right: 20, left: 0, bottom: 5 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="step" tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 11 }} tickLine={false} label={{ value: "Epoch", position: "insideBottom", fill: "rgba(255,255,255,0.3)", fontSize: 11 }} />
                        <YAxis tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 11 }} tickLine={false} axisLine={false} />
                        <Tooltip contentStyle={{ background: "#0f1923", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }} />
                        <Line type="monotone" dataKey="loss" stroke="#60a5fa" strokeWidth={2} dot={{ r: 4, fill: "#60a5fa" }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* A/B Comparison Tab */}
          <TabsContent value="ab" className="space-y-4">
            {(abQ.data ?? []).map(comp => (
              <Card key={comp.experimentName} className="bg-[#0f1923] border-white/10">
                <CardHeader className="pb-2">
                  <CardTitle className="text-white text-base flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-purple-400" />
                    <span className="capitalize">{comp.experimentName.replace(/_/g, " ")}</span>
                    <span className="ml-auto">
                      {comp.winner === "challenger"
                        ? <span className="text-xs text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">Challenger wins</span>
                        : <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">Champion holds</span>
                      }
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Champion */}
                    <div className={`rounded-xl p-4 border ${comp.winner === "champion" ? "border-emerald-500/30 bg-emerald-500/5" : "border-white/10 bg-white/3"}`}>
                      <div className="flex items-center gap-2 mb-3">
                        <TrendingUp className="w-4 h-4 text-emerald-400" />
                        <span className="text-white font-medium text-sm">Champion</span>
                        <span className="text-white/40 text-xs font-mono">{comp.champion.runName}</span>
                        {comp.winner === "champion" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 ml-auto" />}
                      </div>
                      <div className="space-y-2">
                        {Object.entries(comp.champion.metrics).map(([k, v]) => (
                          <div key={k} className="flex items-center justify-between">
                            <span className="text-white/50 text-xs">{k}</span>
                            <span className="text-white text-sm font-mono">{typeof v === "number" ? v.toFixed(4) : v}</span>
                          </div>
                        ))}
                      </div>
                      <p className="text-white/30 text-xs mt-3">{formatTs(comp.champion.startTime)}</p>
                    </div>

                    {/* Challenger */}
                    {comp.challenger ? (
                      <div className={`rounded-xl p-4 border ${comp.winner === "challenger" ? "border-amber-500/30 bg-amber-500/5" : "border-white/10 bg-white/3"}`}>
                        <div className="flex items-center gap-2 mb-3">
                          <TrendingDown className="w-4 h-4 text-amber-400" />
                          <span className="text-white font-medium text-sm">Challenger</span>
                          <span className="text-white/40 text-xs font-mono">{comp.challenger.runName}</span>
                          {comp.winner === "challenger" && <CheckCircle2 className="w-3.5 h-3.5 text-amber-400 ml-auto" />}
                        </div>
                        <div className="space-y-2">
                          {Object.entries(comp.challenger.metrics).map(([k, v]) => (
                            <div key={k} className="flex items-center justify-between">
                              <span className="text-white/50 text-xs">{k}</span>
                              <span className="text-white text-sm font-mono">{typeof v === "number" ? v.toFixed(4) : v}</span>
                            </div>
                          ))}
                        </div>
                        <p className="text-white/30 text-xs mt-3">{formatTs(comp.challenger.startTime)}</p>
                      </div>
                    ) : (
                      <div className="rounded-xl p-4 border border-white/10 bg-white/3 flex items-center justify-center">
                        <p className="text-white/30 text-sm">No challenger run yet</p>
                      </div>
                    )}
                  </div>

                  {/* Metric comparison bar chart */}
                  {comp.challenger && (
                    <div className="mt-4">
                      <p className="text-white/40 text-xs mb-2 uppercase tracking-wider">Metric Comparison</p>
                      <ResponsiveContainer width="100%" height={160}>
                        <BarChart
                          data={Object.keys(comp.champion.metrics).map(k => ({
                            metric: k,
                            Champion: parseFloat(((comp.champion.metrics[k] ?? 0) as number).toFixed(4)),
                            Challenger: parseFloat(((comp.challenger!.metrics[k] ?? 0) as number).toFixed(4)),
                          }))}
                          margin={{ top: 5, right: 20, left: 0, bottom: 5 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                          <XAxis dataKey="metric" tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }} tickLine={false} />
                          <YAxis domain={[0, 1]} tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }} tickLine={false} axisLine={false} />
                          <Tooltip contentStyle={{ background: "#0f1923", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }} />
                          <Legend wrapperStyle={{ color: "rgba(255,255,255,0.5)", fontSize: 11 }} />
                          <Bar dataKey="Champion" fill="#34d399" radius={[3, 3, 0, 0]} />
                          <Bar dataKey="Challenger" fill="#fbbf24" radius={[3, 3, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
            {abQ.isLoading && (
              <Card className="bg-[#0f1923] border-white/10 animate-pulse"><CardContent className="p-5 h-48" /></Card>
            )}
            {!abQ.isLoading && !abQ.data?.length && (
              <Card className="bg-[#0f1923] border-white/10">
                <CardContent className="p-8 text-center text-white/30">No A/B comparisons available yet</CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── Metric Curves Tab ─────────────────────────────────────────── */}
          <TabsContent value="curves" className="space-y-4">
            <Card className="bg-[#0f1923] border-white/10">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <CardTitle className="text-white text-base flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-blue-400" /> Training Metric Curves
                  </CardTitle>
                  <div className="flex items-center gap-3">
                    <Select
                      value={selectedExperiment}
                      onValueChange={v => { setSelectedExperiment(v); setSelectedMetric(""); }}
                    >
                      <SelectTrigger className="w-48 h-8 bg-white/5 border-white/10 text-white text-xs">
                        <SelectValue placeholder="Select experiment…" />
                      </SelectTrigger>
                      <SelectContent>
                        {(experimentsQ.data ?? []).map(e => (
                          <SelectItem key={e.id} value={e.id}>{e.name.replace(/_/g, " ")}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {availableMetrics.length > 0 && (
                      <Select value={activeMetric} onValueChange={setSelectedMetric}>
                        <SelectTrigger className="w-40 h-8 bg-white/5 border-white/10 text-white text-xs">
                          <SelectValue placeholder="Select metric…" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableMetrics.map(m => (
                            <SelectItem key={m} value={m}>{m}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {!selectedExperiment && (
                  <div className="flex items-center justify-center h-48 text-white/30 text-sm">
                    Select an experiment above to view metric curves
                  </div>
                )}
                {selectedExperiment && metricHistoryQ.isLoading && (
                  <div className="flex items-center justify-center h-48">
                    <RefreshCw className="w-5 h-5 text-white/30 animate-spin" />
                  </div>
                )}
                {selectedExperiment && metricHistoryQ.data && activeMetric && (
                  <>
                    <div className="flex flex-wrap gap-3 mb-4">
                      {(metricHistoryQ.data.runNames ?? []).map((name, i) => (
                        <span key={name} className="flex items-center gap-1.5 text-xs text-white/60">
                          <span className="w-3 h-0.5 rounded-full inline-block" style={{ background: RUN_COLORS[i % RUN_COLORS.length] }} />
                          {name}
                        </span>
                      ))}
                    </div>
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart
                        data={metricHistoryQ.data.charts[activeMetric] ?? []}
                        margin={{ top: 5, right: 20, left: 0, bottom: 20 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis
                          dataKey="step"
                          tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 11 }}
                          tickLine={false}
                          label={{ value: "Step / Epoch", position: "insideBottom", offset: -10, fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                        />
                        <YAxis
                          tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 11 }}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={(v: number) => v.toFixed(4)}
                        />
                        <Tooltip
                          contentStyle={{ background: "#0f1923", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}
                          labelStyle={{ color: "rgba(255,255,255,0.7)" }}
                          formatter={(v: number) => v.toFixed(6)}
                        />
                        {(metricHistoryQ.data.runNames ?? []).map((name, i) => (
                          <Line
                            key={name}
                            type="monotone"
                            dataKey={name}
                            stroke={RUN_COLORS[i % RUN_COLORS.length]}
                            strokeWidth={2}
                            dot={false}
                            connectNulls
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                    {availableMetrics.filter(m => m !== activeMetric).length > 0 && (
                      <div className="mt-6">
                        <p className="text-white/40 text-xs uppercase tracking-wider mb-3">Other Metrics — click to expand</p>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                          {availableMetrics.filter(m => m !== activeMetric).map(metric => (
                            <button
                              key={metric}
                              onClick={() => setSelectedMetric(metric)}
                              className="bg-white/5 hover:bg-white/10 rounded-xl p-3 text-left transition-colors border border-white/5 hover:border-white/15"
                            >
                              <p className="text-white/50 text-xs mb-2 truncate">{metric}</p>
                              <ResponsiveContainer width="100%" height={50}>
                                <LineChart data={metricHistoryQ.data!.charts[metric] ?? []}>
                                  <Line
                                    type="monotone"
                                    dataKey={(metricHistoryQ.data?.runNames ?? [])[0] ?? ""}
                                    stroke={RUN_COLORS[0]}
                                    strokeWidth={1.5}
                                    dot={false}
                                    connectNulls
                                  />
                                </LineChart>
                              </ResponsiveContainer>
                              {(() => {
                                const pts = metricHistoryQ.data!.charts[metric] ?? [];
                                const last = pts[pts.length - 1];
                                const runName = (metricHistoryQ.data?.runNames ?? [])[0];
                                const val = last && runName ? (last[runName] as number) : null;
                                return val != null ? (
                                  <p className="text-white text-xs font-mono mt-1">{val.toFixed(4)}</p>
                                ) : null;
                              })()}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
                {selectedExperiment && metricHistoryQ.data && availableMetrics.length === 0 && (
                  <div className="flex items-center justify-center h-48 text-white/30 text-sm">
                    No metric history found for this experiment
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        {/* DB-backed A/B Tests Tab */}
          <TabsContent value="abtests" className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-white/50 text-sm">Manage live A/B tests between model versions. Select a winner to conclude.</p>
              <Button size="sm" onClick={() => setShowCreateAbTest(true)} className="bg-blue-600 hover:bg-blue-700 text-white">
                <Play className="w-3.5 h-3.5 mr-1.5" /> New A/B Test
              </Button>
            </div>
            {abTestsQ.isLoading && <Card className="bg-[#0f1923] border-white/10 animate-pulse"><CardContent className="p-5 h-32" /></Card>}
            {!abTestsQ.isLoading && !(abTestsQ.data ?? []).length && (
              <Card className="bg-[#0f1923] border-white/10"><CardContent className="p-8 text-center text-white/30">No A/B tests yet. Create one to compare model versions.</CardContent></Card>
            )}
            {(abTestsQ.data ?? []).map(test => (
              <Card key={test.id} className="bg-[#0f1923] border-white/10">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <CardTitle className="text-white text-sm flex items-center gap-2">
                      <GitBranch className="w-4 h-4 text-blue-400" />
                      {test.modelName}
                      <span className="text-white/40 text-xs font-mono">{test.id.slice(0, 8)}</span>
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${test.status === "running" ? "bg-blue-500/20 text-blue-400 border-blue-500/30" : "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"}`}>{test.status}</span>
                      {test.status === "running" && (
                        <div className="flex gap-1.5">
                          <Button size="sm" variant="outline" className="h-6 text-xs border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
                            onClick={() => concludeAbTest.mutate({ id: test.id, winner: "champion" })}>Champion Wins</Button>
                          <Button size="sm" variant="outline" className="h-6 text-xs border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                            onClick={() => concludeAbTest.mutate({ id: test.id, winner: "challenger" })}>Challenger Wins</Button>
                        </div>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div><p className="text-white/40 text-xs">Champion</p><p className="text-white font-mono">{test.championVersion}</p></div>
                    <div><p className="text-white/40 text-xs">Challenger</p><p className="text-white font-mono">{test.challengerVersion}</p></div>
                    <div><p className="text-white/40 text-xs">Traffic Split</p><p className="text-white">{test.trafficSplitPct}% challenger</p></div>
                    <div><p className="text-white/40 text-xs">Winner</p><p className="text-white">{test.winner ?? "—"}</p></div>
                  </div>
                  {test.notes && <p className="text-white/30 text-xs mt-2">{test.notes}</p>}
                  <p className="text-white/20 text-xs mt-2">Started: {formatTs(new Date(test.startedAt).getTime())}</p>
                </CardContent>
              </Card>
            ))}
          </TabsContent>

          {/* Drift Alerts Tab */}
          <TabsContent value="alerts" className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              {[
                { label: "Critical", val: driftAlertsQ.data?.critical ?? 0, cls: "text-red-400" },
                { label: "Warning", val: driftAlertsQ.data?.warning ?? 0, cls: "text-amber-400" },
                { label: "Healthy", val: (driftAlertsQ.data?.total ?? 0) - (driftAlertsQ.data?.critical ?? 0) - (driftAlertsQ.data?.warning ?? 0), cls: "text-emerald-400" },
              ].map(s => (
                <Card key={s.label} className="bg-[#0f1923] border-white/10">
                  <CardContent className="p-4 text-center">
                    <p className={`text-3xl font-bold ${s.cls}`}>{s.val}</p>
                    <p className="text-white/40 text-xs mt-1">{s.label}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            {driftAlertsQ.isLoading && <Card className="bg-[#0f1923] border-white/10 animate-pulse"><CardContent className="p-5 h-32" /></Card>}
            {!driftAlertsQ.isLoading && !(driftAlertsQ.data?.alerts ?? []).length && (
              <Card className="bg-[#0f1923] border-white/10"><CardContent className="p-8 text-center text-white/30">No drift alerts. All features are within acceptable bounds.</CardContent></Card>
            )}
            <div className="space-y-2">
              {(driftAlertsQ.data?.alerts ?? []).map((a, i) => (
                <Card key={i} className={`border ${a.isDrifted ? (a.psi > 0.2 ? "border-red-500/30 bg-red-500/5" : "border-amber-500/30 bg-amber-500/5") : "bg-[#0f1923] border-white/10"}`}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        {a.isDrifted ? <AlertTriangle className="w-4 h-4 text-amber-400" /> : <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                        <span className="text-white text-sm font-medium">{a.model}</span>
                        <span className="text-white/40 text-xs">·</span>
                        <span className="text-white/60 text-xs font-mono">{a.feature}</span>
                      </div>
                      <div className="flex items-center gap-4 text-xs">
                        <span className="text-white/40">PSI: <span className={`font-mono font-bold ${a.psi > 0.2 ? "text-red-400" : a.psi > 0.1 ? "text-amber-400" : "text-emerald-400"}`}>{a.psi.toFixed(4)}</span></span>
                        <span className="text-white/40">Threshold: <span className="font-mono text-white/60">{a.threshold.toFixed(4)}</span></span>
                        <DriftAlertBadge level={a.isDrifted ? (a.psi > 0.2 ? "critical" : "warning") : "healthy"} />
                      </div>
                    </div>
                    <p className="text-white/20 text-xs mt-1">{a.computedAt ? new Date(a.computedAt).toLocaleString() : ""}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          {/* Dataset Snapshots Tab */}
          <TabsContent value="snapshots" className="space-y-4">
            <p className="text-white/50 text-sm">Timestamped audit trail of dataset state before each training run.</p>
            {snapshotsQ.isLoading && <Card className="bg-[#0f1923] border-white/10 animate-pulse"><CardContent className="p-5 h-32" /></Card>}
            {!snapshotsQ.isLoading && !(snapshotsQ.data ?? []).length && (
              <Card className="bg-[#0f1923] border-white/10"><CardContent className="p-8 text-center text-white/30">No snapshots yet. Use the Product Image Collector to create one.</CardContent></Card>
            )}
            <div className="space-y-2">
              {(snapshotsQ.data ?? []).map(snap => (
                <Card key={snap.id} className="bg-[#0f1923] border-white/10">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div>
                        <p className="text-white text-sm font-medium">{snap.label ?? `Snapshot ${snap.id.slice(0, 8)}`}</p>
                        <p className="text-white/40 text-xs mt-0.5">{new Date(snap.createdAt).toLocaleString()}</p>
                      </div>
                      <div className="flex items-center gap-4 text-xs">
                        <span className="text-white/40">Images: <span className="text-white font-mono">{snap.totalImages}</span></span>
                        <span className="text-white/40">Bbox: <span className="text-white font-mono">{snap.bboxImages}</span></span>
                        <span className="text-white/40">Quality: <span className="text-white font-mono">{snap.qualityImages}</span></span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Create A/B Test Dialog */}
      <Dialog open={showCreateAbTest} onOpenChange={setShowCreateAbTest}>
        <DialogContent className="bg-[#0f1923] border-white/10 text-white">
          <DialogHeader><DialogTitle>Create A/B Test</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            {([
              { label: "Model Name", key: "modelName" as const },
              { label: "Champion Version", key: "championVersion" as const },
              { label: "Challenger Version", key: "challengerVersion" as const },
            ]).map(f => (
              <div key={f.key}>
                <Label className="text-white/60 text-xs">{f.label}</Label>
                <Input className="bg-white/5 border-white/10 text-white mt-1" value={abForm[f.key]}
                  onChange={e => setAbForm(p => ({ ...p, [f.key]: e.target.value }))} />
              </div>
            ))}
            <div>
              <Label className="text-white/60 text-xs">Traffic Split % (challenger)</Label>
              <Input type="number" min={5} max={50} className="bg-white/5 border-white/10 text-white mt-1"
                value={abForm.trafficSplitPct} onChange={e => setAbForm(p => ({ ...p, trafficSplitPct: parseInt(e.target.value) || 20 }))} />
            </div>
            <div>
              <Label className="text-white/60 text-xs">Notes (optional)</Label>
              <Input className="bg-white/5 border-white/10 text-white mt-1" value={abForm.notes}
                onChange={e => setAbForm(p => ({ ...p, notes: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateAbTest(false)}>Cancel</Button>
            <Button className="bg-blue-600 hover:bg-blue-700 text-white" onClick={() => createAbTest.mutate(abForm)} disabled={createAbTest.isPending}>
              {createAbTest.isPending ? "Creating…" : "Create Test"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
