import { useState, useMemo } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  Play, CheckCircle2, XCircle, Clock, AlertTriangle, RefreshCw,
  ArrowRight, Shield, Database, Webhook, CreditCard, Zap, FileText,
  ChevronDown, ChevronRight,
} from "lucide-react";
import { Download } from "lucide-react";

type SimStep = {
  id: string;
  stage: string;
  provider: string;
  status: "pending" | "success" | "failed" | "skipped";
  timestamp: number;
  durationMs: number;
  payload: Record<string, unknown>;
  response: Record<string, unknown>;
  notes: string;
};

function StageIcon({ stage }: { stage: string }) {
  const map: Record<string, React.ElementType> = {
    initiate: CreditCard,
    buyer_payment: Zap,
    webhook_sent: Webhook,
    webhook_received: Webhook,
    signature_verify: Shield,
    verify_payment: CheckCircle2,
    update_order: Database,
    reconcile: FileText,
  };
  const Icon = map[stage] ?? ArrowRight;
  return <Icon className="w-4 h-4" />;
}

function StepStatusIcon({ status }: { status: string }) {
  if (status === "success") return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
  if (status === "failed") return <XCircle className="w-4 h-4 text-red-400" />;
  if (status === "skipped") return <Clock className="w-4 h-4 text-white/30" />;
  return <Clock className="w-4 h-4 text-amber-400 animate-pulse" />;
}

function StepCard({ step, index }: { step: SimStep; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const stageLabel: Record<string, string> = {
    initiate: "Payment Initiation",
    buyer_payment: "Buyer Completes Payment",
    webhook_sent: "Webhook Delivery",
    webhook_received: "Webhook Received",
    signature_verify: "Signature Verification",
    verify_payment: "Payment Verification API",
    update_order: "Order Status Update",
    reconcile: "Reconciliation Check",
  };

  const borderColor = step.status === "success" ? "border-emerald-500/20" : step.status === "failed" ? "border-red-500/20" : "border-white/10";
  const bgColor = step.status === "success" ? "bg-emerald-500/5" : step.status === "failed" ? "bg-red-500/5" : "bg-white/3";

  return (
    <div className={`rounded-xl border ${borderColor} ${bgColor} overflow-hidden transition-all`}>
      <div
        className="flex items-center gap-3 p-4 cursor-pointer select-none"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-white/50 text-xs font-mono">
          {index + 1}
        </div>
        <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-white/60">
          <StageIcon stage={step.stage} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white text-sm font-medium">{stageLabel[step.stage] ?? step.stage}</p>
          <p className="text-white/40 text-xs truncate">{step.notes}</p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-white/30 text-xs">{step.durationMs}ms</span>
          <StepStatusIcon status={step.status} />
          {expanded ? <ChevronDown className="w-3.5 h-3.5 text-white/30" /> : <ChevronRight className="w-3.5 h-3.5 text-white/30" />}
        </div>
      </div>
      {expanded && (
        <div className="border-t border-white/5 p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <p className="text-white/40 text-xs uppercase tracking-wider mb-2">Request Payload</p>
            <pre className="text-xs text-white/70 bg-black/30 rounded-lg p-3 overflow-auto max-h-40 font-mono">
              {JSON.stringify(step.payload, null, 2)}
            </pre>
          </div>
          <div>
            <p className="text-white/40 text-xs uppercase tracking-wider mb-2">Response</p>
            <pre className="text-xs text-white/70 bg-black/30 rounded-lg p-3 overflow-auto max-h-40 font-mono">
              {JSON.stringify(step.response, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReconciliationSim() {
  const [provider, setProvider] = useState<"paystack" | "flutterwave" | "mojaloop">("paystack");
  const [amount, setAmount] = useState("5000");
  const [currency, setCurrency] = useState("NGN");
  const [injectFailure, setInjectFailure] = useState(false);
  const [webhookSecret, setWebhookSecret] = useState("test_webhook_secret");
  const [lastResult, setLastResult] = useState<{
    simulationId: string;
    steps: SimStep[];
    summary: { totalSteps: number; successSteps: number; failedSteps: number; reconciled: boolean; durationMs: number };
  } | null>(null);

  const [tenantId] = useState("t1");

  const simulate = trpc.reconciliation.simulate.useMutation({
    onSuccess: (data) => {
      setLastResult(data as typeof lastResult);
      toast.success(`Simulation complete: ${data.summary.successSteps}/${data.summary.totalSteps} steps passed`);
    },
    onError: (err) => toast.error(`Simulation failed: ${err.message}`),
  });

  const auditQ = trpc.reconciliation.getAuditTrail.useQuery(
    { simulationId: lastResult?.simulationId ?? "" },
    { enabled: !!lastResult?.simulationId }
  );

  const verifyQ = trpc.reconciliation.verifyReconciliation.useQuery(
    { tenantId, days: 7 },
    { enabled: true }
  );

  const handleSimulate = () => {
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { toast.error("Enter a valid amount"); return; }
    simulate.mutate({ provider, amount: amt, currency, injectFailure, webhookSecret });
  };

  const providerColors: Record<string, string> = {
    paystack: "text-emerald-400",
    flutterwave: "text-amber-400",
    mojaloop: "text-blue-400",
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-white">Payment Reconciliation Simulator</h1>
          <p className="text-white/50 text-sm mt-1">
            End-to-end simulation of Mojaloop, Paystack, and Flutterwave payment flows with webhook reconciliation
          </p>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Config Panel */}
          <div className="xl:col-span-1 space-y-4">
            <Card className="bg-[#0f1923] border-white/10">
              <CardHeader className="pb-3">
                <CardTitle className="text-white text-base">Simulation Parameters</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label className="text-white/60 text-xs mb-1.5 block">Payment Provider</Label>
                  <Select value={provider} onValueChange={v => setProvider(v as typeof provider)}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="paystack">Paystack (Nigeria)</SelectItem>
                      <SelectItem value="flutterwave">Flutterwave (Pan-Africa)</SelectItem>
                      <SelectItem value="mojaloop">Mojaloop (Interbank FSPIOP)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-white/60 text-xs mb-1.5 block">Amount</Label>
                    <Input
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                      className="bg-white/5 border-white/10 text-white"
                      placeholder="5000"
                    />
                  </div>
                  <div>
                    <Label className="text-white/60 text-xs mb-1.5 block">Currency</Label>
                    <Select value={currency} onValueChange={setCurrency}>
                      <SelectTrigger className="bg-white/5 border-white/10 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NGN">NGN</SelectItem>
                        <SelectItem value="KES">KES</SelectItem>
                        <SelectItem value="GHS">GHS</SelectItem>
                        <SelectItem value="ZAR">ZAR</SelectItem>
                        <SelectItem value="USD">USD</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div>
                  <Label className="text-white/60 text-xs mb-1.5 block">Webhook Secret</Label>
                  <Input
                    value={webhookSecret}
                    onChange={e => setWebhookSecret(e.target.value)}
                    className="bg-white/5 border-white/10 text-white font-mono text-sm"
                    placeholder="test_webhook_secret"
                  />
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                  <div>
                    <p className="text-white text-sm font-medium">Inject Failure</p>
                    <p className="text-white/40 text-xs">Simulate card decline / transfer failure</p>
                  </div>
                  <Switch
                    checked={injectFailure}
                    onCheckedChange={setInjectFailure}
                    className="data-[state=checked]:bg-red-500"
                  />
                </div>

                <Button
                  className="w-full bg-teal-600 hover:bg-teal-500 text-white"
                  onClick={handleSimulate}
                  disabled={simulate.isPending}
                >
                  {simulate.isPending ? (
                    <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Running…</>
                  ) : (
                    <><Play className="w-4 h-4 mr-2" /> Run Simulation</>
                  )}
                </Button>
              </CardContent>
            </Card>

            {/* Summary */}
            {lastResult && (
              <Card className="bg-[#0f1923] border-white/10">
                <CardContent className="p-4 space-y-3">
                  <p className="text-white/50 text-xs uppercase tracking-wider font-medium">Last Simulation</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-white/5 rounded-lg p-3 text-center">
                      <p className="text-white/40 text-xs">Steps</p>
                      <p className="text-white text-xl font-bold">{lastResult.summary.totalSteps}</p>
                    </div>
                    <div className="bg-white/5 rounded-lg p-3 text-center">
                      <p className="text-white/40 text-xs">Duration</p>
                      <p className="text-white text-xl font-bold">{lastResult.summary.durationMs}ms</p>
                    </div>
                    <div className={`rounded-lg p-3 text-center ${lastResult.summary.successSteps === lastResult.summary.totalSteps ? "bg-emerald-500/10" : "bg-amber-500/10"}`}>
                      <p className="text-white/40 text-xs">Passed</p>
                      <p className="text-emerald-400 text-xl font-bold">{lastResult.summary.successSteps}</p>
                    </div>
                    <div className={`rounded-lg p-3 text-center ${lastResult.summary.failedSteps > 0 ? "bg-red-500/10" : "bg-white/5"}`}>
                      <p className="text-white/40 text-xs">Failed</p>
                      <p className={`text-xl font-bold ${lastResult.summary.failedSteps > 0 ? "text-red-400" : "text-white/40"}`}>{lastResult.summary.failedSteps}</p>
                    </div>
                  </div>
                  <div className={`flex items-center gap-2 p-2 rounded-lg ${lastResult.summary.reconciled ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                    {lastResult.summary.reconciled ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                    <span className="text-sm font-medium">{lastResult.summary.reconciled ? "Reconciled" : "Reconciliation Failed"}</span>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Steps Panel */}
          <div className="xl:col-span-2">
            <Tabs defaultValue="steps" className="space-y-4">
              <TabsList className="bg-[#0f1923] border border-white/10">
                <TabsTrigger value="steps" className="data-[state=active]:bg-white/10">Flow Steps</TabsTrigger>
                <TabsTrigger value="audit" className="data-[state=active]:bg-white/10">Audit Trail</TabsTrigger>
                <TabsTrigger value="verify" className="data-[state=active]:bg-white/10">DB Verification</TabsTrigger>
              </TabsList>

              <TabsContent value="steps">
                {!lastResult && !simulate.isPending && (
                  <Card className="bg-[#0f1923] border-white/10">
                    <CardContent className="p-12 text-center">
                      <div className="w-16 h-16 rounded-2xl bg-teal-500/10 flex items-center justify-center mx-auto mb-4">
                        <Play className="w-8 h-8 text-teal-400" />
                      </div>
                      <p className="text-white/50 text-sm">Configure parameters and click <strong className="text-white">Run Simulation</strong> to start</p>
                      <p className="text-white/30 text-xs mt-2">The simulation will walk through each stage of the payment flow with real webhook payloads and signature verification</p>
                    </CardContent>
                  </Card>
                )}
                {simulate.isPending && (
                  <Card className="bg-[#0f1923] border-white/10">
                    <CardContent className="p-12 text-center">
                      <RefreshCw className="w-8 h-8 text-teal-400 animate-spin mx-auto mb-4" />
                      <p className="text-white/60 text-sm">Running end-to-end payment simulation…</p>
                    </CardContent>
                  </Card>
                )}
                {lastResult && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 mb-3">
                      <span className={`text-sm font-medium ${providerColors[provider]}`}>{provider.charAt(0).toUpperCase() + provider.slice(1)}</span>
                      <ArrowRight className="w-4 h-4 text-white/30" />
                      <span className="text-white/50 text-sm">{currency} {parseFloat(amount).toLocaleString()}</span>
                      {injectFailure && <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full border border-red-500/20">Failure injected</span>}
                    </div>
                    {lastResult.steps.map((step, i) => (
                      <StepCard key={step.id} step={step} index={i} />
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="audit">
                <Card className="bg-[#0f1923] border-white/10">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-white text-base">Audit Trail</CardTitle>
                      {auditQ.data?.audit && auditQ.data.audit.length > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-white/20 text-white/60 h-7 text-xs gap-1.5"
                          onClick={() => {
                            const rows = auditQ.data!.audit;
                            const header = "id,stage,provider,amount,currency,reference,reconciled,discrepancy,createdAt";
                            const lines = rows.map((e: any) =>
                              [e.id, e.stage, e.provider, e.amount, e.currency, e.reference, e.reconciled, e.discrepancy ?? "", e.createdAt].join(",")
                            );
                            const csv = [header, ...lines].join("\n");
                            const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url; a.download = `audit-trail-${Date.now()}.csv`;
                            document.body.appendChild(a); a.click();
                            document.body.removeChild(a); URL.revokeObjectURL(url);
                          }}
                        >
                          <Download className="w-3 h-3" /> Export CSV
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    {!lastResult && <p className="text-white/30 text-sm text-center py-8">Run a simulation first</p>}
                    {auditQ.data?.audit.map(entry => (
                      <div key={entry.id} className="flex items-center gap-4 py-3 border-b border-white/5 last:border-0">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${entry.reconciled ? "bg-emerald-400" : "bg-red-400"}`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-white text-sm">{entry.stage} — <span className="text-white/60">{entry.provider}</span></p>
                          <p className="text-white/40 text-xs">{entry.currency} {entry.amount} · ref: {entry.reference?.slice(0, 20)}</p>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className={`text-xs font-medium ${entry.reconciled ? "text-emerald-400" : "text-red-400"}`}>
                            {entry.reconciled ? "Reconciled" : "Discrepancy"}
                          </p>
                          {entry.discrepancy && <p className="text-red-400 text-xs">{entry.discrepancy}</p>}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="verify">
                <Card className="bg-[#0f1923] border-white/10">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-white text-base">DB Transaction Verification (7 days)</CardTitle>
                      <Button size="sm" variant="outline" className="border-white/20 text-white/60 h-7 text-xs" onClick={() => verifyQ.refetch()}>
                        <RefreshCw className="w-3 h-3 mr-1" /> Refresh
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {verifyQ.data && (
                      <>
                        <div className="grid grid-cols-3 gap-3 mb-4">
                          <div className="bg-white/5 rounded-lg p-3 text-center">
                            <p className="text-white/40 text-xs">Total</p>
                            <p className="text-white text-xl font-bold">{verifyQ.data.summary.total}</p>
                          </div>
                          <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                            <p className="text-white/40 text-xs">Reconciled</p>
                            <p className="text-emerald-400 text-xl font-bold">{verifyQ.data.summary.reconciled}</p>
                          </div>
                          <div className={`rounded-lg p-3 text-center ${verifyQ.data.summary.unreconciled > 0 ? "bg-red-500/10" : "bg-white/5"}`}>
                            <p className="text-white/40 text-xs">Unreconciled</p>
                            <p className={`text-xl font-bold ${verifyQ.data.summary.unreconciled > 0 ? "text-red-400" : "text-white/40"}`}>{verifyQ.data.summary.unreconciled}</p>
                          </div>
                        </div>
                        {verifyQ.data.summary.discrepancies.length > 0 && (
                          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                            <p className="text-red-400 text-sm font-medium mb-2 flex items-center gap-1">
                              <AlertTriangle className="w-4 h-4" /> Discrepancies Found
                            </p>
                            {verifyQ.data.summary.discrepancies.map(d => (
                              <div key={d.id} className="text-xs text-white/60 py-1 border-b border-white/5 last:border-0">
                                {d.provider} · {d.amount} · {d.age} old · {d.issue}
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-white/10">
                                <th className="text-left text-white/40 font-medium py-2 pr-3">Provider</th>
                                <th className="text-left text-white/40 font-medium py-2 pr-3">Amount</th>
                                <th className="text-left text-white/40 font-medium py-2 pr-3">Status</th>
                                <th className="text-left text-white/40 font-medium py-2 pr-3">Reference</th>
                                <th className="text-left text-white/40 font-medium py-2">Created</th>
                              </tr>
                            </thead>
                            <tbody>
                              {verifyQ.data.transactions.slice(0, 20).map(tx => (
                                <tr key={tx.id} className="border-b border-white/5 hover:bg-white/3">
                                  <td className="py-2 pr-3 text-white/70 capitalize">{tx.provider}</td>
                                  <td className="py-2 pr-3 text-white">{tx.currency} {tx.amount}</td>
                                  <td className="py-2 pr-3">
                                    <span className={`text-xs px-2 py-0.5 rounded-full ${tx.status === "success" ? "bg-emerald-500/20 text-emerald-400" : tx.status === "failed" ? "bg-red-500/20 text-red-400" : "bg-amber-500/20 text-amber-400"}`}>
                                      {tx.status}
                                    </span>
                                  </td>
                                  <td className="py-2 pr-3 text-white/40 text-xs font-mono">{tx.reference?.slice(0, 16) ?? "—"}</td>
                                  <td className="py-2 text-white/40 text-xs">{new Date(tx.createdAt).toLocaleDateString()}</td>
                                </tr>
                              ))}
                              {verifyQ.data.transactions.length === 0 && (
                                <tr><td colSpan={5} className="py-8 text-center text-white/30">No transactions in the last 7 days</td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
