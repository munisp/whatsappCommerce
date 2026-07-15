import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  Plus, Trash2, Bell, BellOff, Clock, AlertTriangle, Info,
  History, CheckCircle2, XCircle, Wand2,
} from "lucide-react";

const RULE_TYPE_COLORS: Record<string, string> = {
  reconciliation_discrepancy: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  low_stock: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  failed_payments: "bg-red-500/10 text-red-400 border-red-500/20",
  model_drift: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  escalation_count: "bg-rose-500/10 text-rose-400 border-rose-500/20",
};

type RuleTypeMeta = {
  value: string;
  label: string;
  unit: string;
  defaultThreshold: number;
  description: string;
};

type AlertRuleRow = {
  id: string;
  name: string;
  ruleType: string;
  threshold: number;
  windowHours: number;
  isEnabled: boolean;
  notifyOwnerOnTrigger: boolean;
  heartbeatTaskUid: string | null;
  lastTriggeredAt: Date | null;
  label: string;
  unit: string;
};

function CreateRuleDialog({
  open,
  onClose,
  meta,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  meta: RuleTypeMeta[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [ruleType, setRuleType] = useState<string>(meta[0]?.value ?? "");
  const [threshold, setThreshold] = useState<string>("");
  const [windowHours, setWindowHours] = useState<string>("24");
  const [notifyOwner, setNotifyOwner] = useState(true);

  const selectedMeta = meta.find((m) => m.value === ruleType);
  const utils = trpc.useUtils();
  const createMutation = trpc.alertRules.create.useMutation({
    onSuccess: () => {
      toast.success("Alert rule created");
      utils.alertRules.list.invalidate();
      onCreated();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const handleSubmit = () => {
    if (!name.trim()) { toast.error("Name is required"); return; }
    if (!ruleType) { toast.error("Rule type is required"); return; }
    const t = parseFloat(threshold || String(selectedMeta?.defaultThreshold ?? 5));
    if (isNaN(t) || t <= 0) { toast.error("Threshold must be a positive number"); return; }
    createMutation.mutate({
      name: name.trim(),
      ruleType: ruleType as "reconciliation_discrepancy" | "low_stock" | "failed_payments" | "model_drift" | "escalation_count",
      threshold: t,
      windowHours: parseInt(windowHours) || 24,
      notifyOwnerOnTrigger: notifyOwner,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md bg-zinc-900 border-zinc-700">
        <DialogHeader>
          <DialogTitle className="text-white">Create Alert Rule</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-zinc-300">Rule Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Nightly Reconciliation Alert"
              className="bg-zinc-800 border-zinc-600 text-white"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-zinc-300">Rule Type</Label>
            <Select value={ruleType} onValueChange={(v) => { setRuleType(v); setThreshold(""); }}>
              <SelectTrigger className="bg-zinc-800 border-zinc-600 text-white">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent className="bg-zinc-800 border-zinc-700">
                {meta.map((m) => (
                  <SelectItem key={m.value} value={m.value} className="text-white">
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedMeta && (
              <p className="text-xs text-zinc-500 flex gap-1.5 items-start mt-1">
                <Info className="w-3 h-3 mt-0.5 shrink-0" />
                {selectedMeta.description}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-zinc-300">
                Threshold {selectedMeta ? `(${selectedMeta.unit})` : ""}
              </Label>
              <Input
                type="number"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                placeholder={String(selectedMeta?.defaultThreshold ?? 5)}
                className="bg-zinc-800 border-zinc-600 text-white"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-zinc-300">Window (hours)</Label>
              <Input
                type="number"
                value={windowHours}
                onChange={(e) => setWindowHours(e.target.value)}
                className="bg-zinc-800 border-zinc-600 text-white"
              />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-zinc-700 p-3">
            <div>
              <p className="text-sm text-zinc-300">Notify owner on trigger</p>
              <p className="text-xs text-zinc-500">Send a push notification when this rule fires</p>
            </div>
            <Switch checked={notifyOwner} onCheckedChange={setNotifyOwner} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="border-zinc-600 text-zinc-300">
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={createMutation.isPending}
            className="bg-emerald-600 hover:bg-emerald-500 text-white"
          >
            {createMutation.isPending ? "Creating…" : "Create Rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditThresholdDialog({
  rule,
  onClose,
}: {
  rule: AlertRuleRow;
  onClose: () => void;
}) {
  const [threshold, setThreshold] = useState(String(rule.threshold));
  const [windowHours, setWindowHours] = useState(String(rule.windowHours));
  const utils = trpc.useUtils();
  const updateMutation = trpc.alertRules.update.useMutation({
    onSuccess: () => {
      toast.success("Rule updated");
      utils.alertRules.list.invalidate();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm bg-zinc-900 border-zinc-700">
        <DialogHeader>
          <DialogTitle className="text-white">Edit Threshold — {rule.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-zinc-300">Threshold ({rule.unit})</Label>
            <Input
              type="number"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              className="bg-zinc-800 border-zinc-600 text-white"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-zinc-300">Window (hours)</Label>
            <Input
              type="number"
              value={windowHours}
              onChange={(e) => setWindowHours(e.target.value)}
              className="bg-zinc-800 border-zinc-600 text-white"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="border-zinc-600 text-zinc-300">
            Cancel
          </Button>
          <Button
            onClick={() =>
              updateMutation.mutate({
                id: rule.id,
                threshold: parseFloat(threshold),
                windowHours: parseInt(windowHours),
              })
            }
            disabled={updateMutation.isPending}
            className="bg-blue-600 hover:bg-blue-500 text-white"
          >
            {updateMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AlertRules() {
  const [showCreate, setShowCreate] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRuleRow | null>(null);
  const [activeTab, setActiveTab] = useState("rules");
  const [historyDays, setHistoryDays] = useState(30);

  const { data: rules, isLoading } = trpc.alertRules.list.useQuery();
  const { data: meta = [] } = trpc.alertRules.getRuleTypeMeta.useQuery();
  const utils = trpc.useUtils();

  const { data: eventsData, isLoading: eventsLoading } = trpc.alertRules.listEvents.useQuery(
    { days: historyDays, limit: 100 },
    { enabled: activeTab === "history" }
  );

  const seedMutation = trpc.alertRules.seedDefaults.useMutation({
    onSuccess: (res) => {
      if (res.seeded) {
        toast.success(`Seeded ${res.count} default alert rules`);
        utils.alertRules.list.invalidate();
      } else {
        toast.info("Default rules already exist — no changes made");
      }
    },
    onError: (e) => toast.error(e.message),
  });

  // Auto-seed defaults when the page loads and no rules exist yet
  useEffect(() => {
    if (rules !== undefined && rules.length === 0) {
      seedMutation.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules]);

  const toggleMutation = trpc.alertRules.toggle.useMutation({
    onSuccess: () => utils.alertRules.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  const deleteMutation = trpc.alertRules.delete.useMutation({
    onSuccess: () => {
      toast.success("Rule deleted");
      utils.alertRules.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <DashboardLayout>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Alert Rules</h1>
            <p className="text-zinc-400 text-sm mt-1">
              Configure thresholds for automated monitoring alerts. Rules are evaluated by
              registered heartbeat jobs and trigger owner notifications when exceeded.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => seedMutation.mutate()}
              disabled={seedMutation.isPending}
              className="border-zinc-600 text-zinc-300 hover:text-white gap-2 text-xs"
            >
              <Wand2 className="w-3.5 h-3.5" />
              Seed Defaults
            </Button>
            <Button
              onClick={() => setShowCreate(true)}
              className="bg-emerald-600 hover:bg-emerald-500 text-white gap-2"
            >
              <Plus className="w-4 h-4" />
              New Rule
            </Button>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="bg-zinc-800 border border-zinc-700">
            <TabsTrigger value="rules" className="data-[state=active]:bg-zinc-700 text-zinc-300">
              Rules ({rules?.length ?? 0})
            </TabsTrigger>
            <TabsTrigger value="history" className="data-[state=active]:bg-zinc-700 text-zinc-300">
              <History className="w-3.5 h-3.5 mr-1.5" />
              History
            </TabsTrigger>
          </TabsList>

          {/* ── Rules tab ─────────────────────────────────────────────── */}
          <TabsContent value="rules" className="space-y-4 mt-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {meta.map((m) => (
                <Card key={m.value} className="bg-zinc-900 border-zinc-700">
                  <CardContent className="p-3">
                    <Badge className={`text-xs mb-2 ${RULE_TYPE_COLORS[m.value] ?? ""}`}>
                      {m.label}
                    </Badge>
                    <p className="text-xs text-zinc-500 leading-relaxed">{m.description}</p>
                    <p className="text-xs text-zinc-400 mt-1.5">
                      Default: <span className="text-white font-medium">{m.defaultThreshold} {m.unit}</span>
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card className="bg-zinc-900 border-zinc-700">
              <CardHeader className="pb-3">
                <CardTitle className="text-white text-base">Configured Rules</CardTitle>
                <CardDescription className="text-zinc-400">
                  {rules?.length ?? 0} rule{rules?.length !== 1 ? "s" : ""} configured
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="space-y-3">
                    {[1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-16 w-full bg-zinc-800" />
                    ))}
                  </div>
                ) : !rules?.length ? (
                  <div className="text-center py-12 text-zinc-500">
                    <AlertTriangle className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">No alert rules configured yet.</p>
                    <p className="text-xs mt-1">Click "Seed Defaults" to auto-create the standard rule set.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {rules.map((rule) => (
                      <div
                        key={rule.id}
                        className="flex items-center gap-4 rounded-lg border border-zinc-700 bg-zinc-800/50 p-4 transition-colors hover:bg-zinc-800"
                      >
                        <Switch
                          checked={rule.isEnabled}
                          onCheckedChange={(v) => toggleMutation.mutate({ id: rule.id, isEnabled: v })}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-white font-medium text-sm truncate">{rule.name}</span>
                            <Badge className={`text-xs ${RULE_TYPE_COLORS[rule.ruleType] ?? ""}`}>
                              {rule.label}
                            </Badge>
                            {!rule.isEnabled && (
                              <Badge className="text-xs bg-zinc-700 text-zinc-400">Disabled</Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-zinc-500 flex-wrap">
                            <span className="flex items-center gap-1">
                              <AlertTriangle className="w-3 h-3" />
                              Threshold: <span className="text-zinc-300">{rule.threshold} {rule.unit}</span>
                            </span>
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              Window: <span className="text-zinc-300">{rule.windowHours}h</span>
                            </span>
                            {rule.notifyOwnerOnTrigger ? (
                              <span className="flex items-center gap-1 text-emerald-400">
                                <Bell className="w-3 h-3" /> Notify owner
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-zinc-600">
                                <BellOff className="w-3 h-3" /> Silent
                              </span>
                            )}
                            {rule.heartbeatTaskUid && (
                              <span className="text-blue-400 font-mono truncate max-w-[140px]">
                                UID: {rule.heartbeatTaskUid}
                              </span>
                            )}
                          </div>
                          {rule.lastTriggeredAt && (
                            <p className="text-xs text-amber-400 mt-0.5">
                              Last triggered: {new Date(rule.lastTriggeredAt).toLocaleString()}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-zinc-600 text-zinc-300 hover:text-white h-8 text-xs"
                            onClick={() => setEditingRule(rule as AlertRuleRow)}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-red-800 text-red-400 hover:text-red-300 hover:border-red-600 h-8"
                            onClick={() => {
                              if (confirm(`Delete rule "${rule.name}"?`)) {
                                deleteMutation.mutate({ id: rule.id });
                              }
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── History tab ────────────────────────────────────────────── */}
          <TabsContent value="history" className="mt-4">
            <Card className="bg-zinc-900 border-zinc-700">
              <CardHeader className="pb-3 flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-white text-base">Trigger History</CardTitle>
                  <CardDescription className="text-zinc-400">
                    {eventsData?.total ?? 0} events in the last {historyDays} days
                  </CardDescription>
                </div>
                <Select
                  value={String(historyDays)}
                  onValueChange={(v) => setHistoryDays(parseInt(v))}
                >
                  <SelectTrigger className="w-32 bg-zinc-800 border-zinc-600 text-zinc-300 h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-zinc-800 border-zinc-700">
                    <SelectItem value="7" className="text-white text-xs">Last 7 days</SelectItem>
                    <SelectItem value="30" className="text-white text-xs">Last 30 days</SelectItem>
                    <SelectItem value="90" className="text-white text-xs">Last 90 days</SelectItem>
                  </SelectContent>
                </Select>
              </CardHeader>
              <CardContent>
                {eventsLoading ? (
                  <div className="space-y-3">
                    {[1, 2, 3, 4].map((i) => (
                      <Skeleton key={i} className="h-14 w-full bg-zinc-800" />
                    ))}
                  </div>
                ) : !eventsData?.events.length ? (
                  <div className="text-center py-12 text-zinc-500">
                    <History className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">No trigger events recorded yet.</p>
                    <p className="text-xs mt-1">
                      Events are written each time a heartbeat job evaluates a rule.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {eventsData.events.map((evt) => (
                      <div
                        key={evt.id}
                        className="flex items-center gap-4 rounded-lg border border-zinc-700 bg-zinc-800/40 p-3"
                      >
                       {evt.notificationSent ? (
                          <XCircle className="w-4 h-4 text-red-400 shrink-0" />
                        ) : (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-white text-sm font-medium">{evt.ruleName}</span>
                            <Badge className={`text-xs ${RULE_TYPE_COLORS[evt.ruleType] ?? ""}`}>
                              {evt.ruleType.replace(/_/g, " ")}
                            </Badge>
                            {evt.notificationSent && (
                              <Badge className="text-xs bg-red-500/10 text-red-400 border-red-500/20">
                                Alert sent
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-xs text-zinc-500">
                            <span>
                              Actual: <span className="text-zinc-300 font-medium">{evt.actualValue.toFixed(2)}</span>
                            </span>
                            <span>
                              Threshold: <span className="text-zinc-300">{evt.threshold}</span>
                            </span>
                            <span>
                              Window: <span className="text-zinc-300">{evt.windowHours}h</span>
                            </span>
                          </div>
                        </div>
                        <span className="text-xs text-zinc-500 shrink-0">
                          {new Date(evt.triggeredAt).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Dialogs */}
        {showCreate && (
          <CreateRuleDialog
            open={showCreate}
            onClose={() => setShowCreate(false)}
            meta={meta}
            onCreated={() => {}}
          />
        )}
        {editingRule && (
          <EditThresholdDialog rule={editingRule} onClose={() => setEditingRule(null)} />
        )}
      </div>
    </DashboardLayout>
  );
}
