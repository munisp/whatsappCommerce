import { useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Plus, Play, Pause, Archive, Trash2, ArrowUp, ArrowDown, GitBranch,
  Clock, MessageSquare, LogOut, Split, Loader2, Route, Users,
} from "lucide-react";

const TENANT_ID = "demo-tenant-1";

const statusColors: Record<string, string> = {
  draft: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  paused: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  archived: "bg-red-500/15 text-red-400 border-red-500/30",
};

type StepType = "send_template" | "wait" | "wait_for_reply" | "condition" | "exit";

type Step = {
  id: string;
  type: StepType;
  templateName?: string;
  durationMinutes?: number;
  timeoutMinutes?: number;
  onReplyStepId?: string;
  onTimeoutStepId?: string;
  condition?: { kind: "has_tag"; tag: string } | { kind: "last_order_within_days"; days: number };
  onTrueStepId?: string;
  onFalseStepId?: string;
};

type Journey = {
  id: string;
  name: string;
  status: string;
  steps: Step[];
  createdAt: string | Date;
};

let stepSeq = 1;
const newStepId = () => `step-${Date.now().toString(36)}-${stepSeq++}`;

function defaultStep(type: StepType): Step {
  const id = newStepId();
  switch (type) {
    case "send_template": return { id, type, templateName: "" };
    case "wait": return { id, type, durationMinutes: 1440 };
    case "wait_for_reply": return { id, type, timeoutMinutes: 1440, onReplyStepId: "", onTimeoutStepId: "" };
    case "condition": return { id, type, condition: { kind: "has_tag", tag: "vip" }, onTrueStepId: "", onFalseStepId: "" };
    case "exit": return { id, type };
  }
}

function stepSummary(s: Step): string {
  switch (s.type) {
    case "send_template": return `Send template "${s.templateName || "?"}"`;
    case "wait": return `Wait ${(s.durationMinutes ?? 0) >= 1440 ? `${Math.round((s.durationMinutes ?? 0) / 1440)}d` : `${s.durationMinutes}m`}`;
    case "wait_for_reply": return `Wait for reply (timeout ${s.timeoutMinutes}m)`;
    case "condition":
      return s.condition?.kind === "has_tag"
        ? `If customer has tag "${s.condition.tag}"`
        : `If ordered within ${(s.condition as any)?.days ?? "?"} days`;
    case "exit": return "Exit journey";
  }
}

const stepIcon: Record<StepType, React.ReactNode> = {
  send_template: <MessageSquare className="w-4 h-4 text-emerald-400" />,
  wait: <Clock className="w-4 h-4 text-blue-400" />,
  wait_for_reply: <GitBranch className="w-4 h-4 text-amber-400" />,
  condition: <Split className="w-4 h-4 text-purple-400" />,
  exit: <LogOut className="w-4 h-4 text-red-400" />,
};

function StepList({ steps, editable, onChange }: { steps: Step[]; editable: boolean; onChange?: (s: Step[]) => void }) {
  const move = (i: number, dir: -1 | 1) => {
    const next = [...steps];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange?.(next);
  };
  const remove = (i: number) => onChange?.(steps.filter((_, k) => k !== i));
  const patch = (i: number, p: Partial<Step>) => onChange?.(steps.map((s, k) => (k === i ? { ...s, ...p } : s)));

  return (
    <div className="space-y-2">
      {steps.map((s, i) => (
        <div key={s.id} className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-5">{i + 1}.</span>
            {stepIcon[s.type]}
            <span className="text-sm font-medium flex-1">{stepSummary(s)}</span>
            <Badge variant="outline" className="text-[10px]">{s.type}</Badge>
            {editable && (
              <div className="flex gap-1">
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="w-3 h-3" /></Button>
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => move(i, 1)} disabled={i === steps.length - 1}><ArrowDown className="w-3 h-3" /></Button>
                <Button size="icon" variant="ghost" className="h-6 w-6 text-red-400" onClick={() => remove(i)}><Trash2 className="w-3 h-3" /></Button>
              </div>
            )}
          </div>
          {/* Branch indicators */}
          {s.type === "wait_for_reply" && (
            <div className="pl-7 text-xs text-muted-foreground space-y-0.5">
              <div>↳ on reply → <span className="text-emerald-400">{s.onReplyStepId || "(unset)"}</span></div>
              <div>↳ on timeout → <span className="text-amber-400">{s.onTimeoutStepId || "(unset)"}</span></div>
            </div>
          )}
          {s.type === "condition" && (
            <div className="pl-7 text-xs text-muted-foreground space-y-0.5">
              <div>↳ true → <span className="text-emerald-400">{s.onTrueStepId || "(unset)"}</span></div>
              <div>↳ false → <span className="text-amber-400">{s.onFalseStepId || "(unset)"}</span></div>
            </div>
          )}
          {editable && s.type === "send_template" && (
            <div className="pl-7">
              <Input className="h-7 text-xs" placeholder="template name" value={s.templateName ?? ""}
                onChange={(e) => patch(i, { templateName: e.target.value })} />
            </div>
          )}
          {editable && s.type === "wait" && (
            <div className="pl-7 flex items-center gap-2">
              <Input className="h-7 text-xs w-28" type="number" value={s.durationMinutes ?? 0}
                onChange={(e) => patch(i, { durationMinutes: Number(e.target.value) })} />
              <span className="text-xs text-muted-foreground">minutes</span>
            </div>
          )}
          {editable && (s.type === "wait_for_reply" || s.type === "condition") && (
            <div className="pl-7 grid grid-cols-2 gap-2">
              {s.type === "wait_for_reply" && (
                <>
                  <Input className="h-7 text-xs" type="number" placeholder="timeout (min)" value={s.timeoutMinutes ?? 0}
                    onChange={(e) => patch(i, { timeoutMinutes: Number(e.target.value) })} />
                  <div className="flex gap-1">
                    <Input className="h-7 text-xs" placeholder="on reply → step id" value={s.onReplyStepId ?? ""}
                      onChange={(e) => patch(i, { onReplyStepId: e.target.value })} />
                    <Input className="h-7 text-xs" placeholder="on timeout → step id" value={s.onTimeoutStepId ?? ""}
                      onChange={(e) => patch(i, { onTimeoutStepId: e.target.value })} />
                  </div>
                </>
              )}
              {s.type === "condition" && (
                <>
                  <Select
                    value={s.condition?.kind ?? "has_tag"}
                    onValueChange={(v) => patch(i, { condition: v === "has_tag" ? { kind: "has_tag", tag: "vip" } : { kind: "last_order_within_days", days: 30 } })}
                  >
                    <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="has_tag">has tag</SelectItem>
                      <SelectItem value="last_order_within_days">last order within days</SelectItem>
                    </SelectContent>
                  </Select>
                  {s.condition?.kind === "has_tag" ? (
                    <Input className="h-7 text-xs" placeholder="tag" value={s.condition.tag}
                      onChange={(e) => patch(i, { condition: { kind: "has_tag", tag: e.target.value } })} />
                  ) : (
                    <Input className="h-7 text-xs" type="number" value={(s.condition as any)?.days ?? 30}
                      onChange={(e) => patch(i, { condition: { kind: "last_order_within_days", days: Number(e.target.value) } })} />
                  )}
                  <Input className="h-7 text-xs" placeholder="true → step id" value={s.onTrueStepId ?? ""}
                    onChange={(e) => patch(i, { onTrueStepId: e.target.value })} />
                  <Input className="h-7 text-xs" placeholder="false → step id" value={s.onFalseStepId ?? ""}
                    onChange={(e) => patch(i, { onFalseStepId: e.target.value })} />
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function Journeys() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Journey | null>(null);
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<Step[]>([defaultStep("send_template"), defaultStep("exit")]);
  const [addType, setAddType] = useState<StepType>("send_template");

  const { data: journeysData, refetch, isLoading } = trpc.journeys.list.useQuery({ tenantId: TENANT_ID });
  const journeys = (journeysData ?? []) as Journey[];

  const { data: detail } = trpc.journeys.get.useQuery(
    { journeyId: selectedId ?? "" },
    { enabled: !!selectedId },
  );
  const runs = (detail?.runs ?? []) as any[];

  const invalidate = () => { refetch(); };
  const createMut = trpc.journeys.create.useMutation({
    onSuccess: () => { toast.success("Journey created (draft)"); setEditorOpen(false); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const updateMut = trpc.journeys.update.useMutation({
    onSuccess: () => { toast.success("Journey updated"); setEditorOpen(false); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const statusMut = trpc.journeys.setStatus.useMutation({
    onSuccess: () => { toast.success("Status updated"); invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const openCreate = () => {
    setEditing(null);
    setName("");
    setSteps([defaultStep("send_template"), defaultStep("exit")]);
    setEditorOpen(true);
  };
  const openEdit = (j: Journey) => {
    setEditing(j);
    setName(j.name);
    setSteps(j.steps ?? []);
    setEditorOpen(true);
  };
  const save = () => {
    if (!name.trim()) { toast.error("Name required"); return; }
    if (editing) updateMut.mutate({ journeyId: editing.id, name, steps: steps as any });
    else createMut.mutate({ tenantId: TENANT_ID, name, steps: steps as any });
  };

  const stats = useMemo(() => ({
    total: journeys.length,
    active: journeys.filter((j) => j.status === "active").length,
    draft: journeys.filter((j) => j.status === "draft").length,
  }), [journeys]);

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><Route className="w-6 h-6" /> Broadcast Journeys</h1>
            <p className="text-sm text-muted-foreground">Multi-step messaging journeys over the broadcast/template infrastructure — consent-gated and frequency-cap aware.</p>
          </div>
          <Button onClick={openCreate}><Plus className="w-4 h-4 mr-1" /> New Journey</Button>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Total</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{stats.total}</CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Active</CardTitle></CardHeader><CardContent className="text-2xl font-bold text-emerald-400">{stats.active}</CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Drafts</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{stats.draft}</CardContent></Card>
        </div>

        {isLoading && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}

        <div className="grid gap-3">
          {journeys.map((j) => (
            <Card key={j.id} className={selectedId === j.id ? "border-primary/60" : ""}>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="flex-1 cursor-pointer" onClick={() => setSelectedId(selectedId === j.id ? null : j.id)}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{j.name}</span>
                    <Badge variant="outline" className={statusColors[j.status]}>{j.status}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">{(j.steps ?? []).length} steps</div>
                </div>
                {j.status !== "active" && j.status !== "archived" && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => openEdit(j)}>Edit</Button>
                    <Button size="sm" variant="outline" className="text-emerald-400" disabled={statusMut.isPending}
                      onClick={() => statusMut.mutate({ journeyId: j.id, status: "active" })}>
                      <Play className="w-3 h-3 mr-1" /> Activate
                    </Button>
                  </>
                )}
                {j.status === "active" && (
                  <Button size="sm" variant="outline" className="text-amber-400" disabled={statusMut.isPending}
                    onClick={() => statusMut.mutate({ journeyId: j.id, status: "paused" })}>
                    <Pause className="w-3 h-3 mr-1" /> Pause
                  </Button>
                )}
                {j.status === "paused" && (
                  <Button size="sm" variant="outline" className="text-red-400" disabled={statusMut.isPending}
                    onClick={() => statusMut.mutate({ journeyId: j.id, status: "archived" })}>
                    <Archive className="w-3 h-3 mr-1" /> Archive
                  </Button>
                )}
              </CardContent>
              {selectedId === j.id && (
                <CardContent className="pt-0 px-4 pb-4 space-y-4">
                  <StepList steps={j.steps ?? []} editable={false} />
                  <div>
                    <div className="text-sm font-medium flex items-center gap-2 mb-2"><Users className="w-4 h-4" /> Recent runs ({runs.length})</div>
                    <div className="space-y-1">
                      {runs.slice(0, 20).map((r: any) => (
                        <div key={r.id} className="text-xs flex items-center gap-2 text-muted-foreground">
                          <Badge variant="outline" className="text-[10px]">{r.state}</Badge>
                          <span>customer {String(r.customerId).slice(0, 12)}</span>
                          <span>step {r.currentStep}</span>
                          {r.context?.exitReason && <span className="text-amber-400">({r.context.exitReason})</span>}
                          {r.nextRunAt && <span>next: {new Date(r.nextRunAt).toLocaleString()}</span>}
                        </div>
                      ))}
                      {runs.length === 0 && <div className="text-xs text-muted-foreground">No runs yet — enroll customers to start.</div>}
                    </div>
                  </div>
                </CardContent>
              )}
            </Card>
          ))}
          {!isLoading && journeys.length === 0 && (
            <Card><CardContent className="p-8 text-center text-muted-foreground text-sm">No journeys yet. Create one to automate multi-step broadcasts.</CardContent></Card>
          )}
        </div>

        <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
            <DialogHeader><DialogTitle>{editing ? "Edit journey" : "New journey"}</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Win-back sequence" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Steps (ordered, max 20)</Label>
                  <div className="flex gap-2">
                    <Select value={addType} onValueChange={(v) => setAddType(v as StepType)}>
                      <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="send_template">Send template</SelectItem>
                        <SelectItem value="wait">Wait</SelectItem>
                        <SelectItem value="wait_for_reply">Wait for reply</SelectItem>
                        <SelectItem value="condition">Condition</SelectItem>
                        <SelectItem value="exit">Exit</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button size="sm" variant="outline" onClick={() => steps.length < 20 && setSteps([...steps, defaultStep(addType)])}>
                      <Plus className="w-3 h-3 mr-1" /> Add
                    </Button>
                  </div>
                </div>
                <StepList steps={steps} editable onChange={setSteps} />
                <p className="text-[11px] text-muted-foreground mt-2">
                  Branch steps reference other steps by id (shown as step-N badges are positional; ids are validated on save — orphan branches and waits over 30 days are rejected).
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditorOpen(false)}>Cancel</Button>
              <Button onClick={save} disabled={createMut.isPending || updateMut.isPending}>
                {(createMut.isPending || updateMut.isPending) && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                {editing ? "Save changes" : "Create journey"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
