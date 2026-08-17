/**
 * ManufacturerCredit — manufacturer credit program portal (route
 * /manufacturer-credit).
 *
 * Left: program list + create/edit drawer (caps, tenors, fee, scoring
 * overrides, lifecycle status). Right: the selected program's book
 * dashboard — utilization gauge vs programCap, top-5 concentration bar
 * list, aging-bucket summary, per-account tape table, and a CSV tape
 * export (manufacturerPrograms.programTape format='csv').
 */
import { useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { LimitGauge } from "@/components/b2b/LimitGauge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useActiveTenant } from "@/contexts/TenantContext";
import { formatNaira } from "@/lib/b2bLogic";
import { trpc } from "@/lib/trpc";
import { Download, Factory, Loader2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

const STATUS_TONE: Record<string, string> = {
  draft: "text-muted-foreground border-border",
  active: "text-emerald-400 border-emerald-500/40",
  suspended: "text-amber-400 border-amber-500/40",
};

const BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;

interface ProgramForm {
  name: string;
  maxExposure: string; // naira strings in the form; converted to integer cents
  programCap: string;
  concentrationCapBps: string;
  allowedTenorDays: string; // comma separated
  feeBps: string;
  weightOnTime: string;
  weightVolume: string;
  weightTenure: string;
}
const EMPTY_FORM: ProgramForm = {
  name: "",
  maxExposure: "",
  programCap: "",
  concentrationCapBps: "10000",
  allowedTenorDays: "30",
  feeBps: "0",
  weightOnTime: "",
  weightVolume: "",
  weightTenure: "",
};

function nairaToCents(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round(n * 100);
}

function parseTenors(s: string): number[] {
  return s
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x > 0);
}

function parseWeights(f: ProgramForm): { onTime?: number; volume?: number; tenure?: number } | undefined {
  const out: Record<string, number> = {};
  for (const [field, key] of [
    [f.weightOnTime, "onTime"],
    [f.weightVolume, "volume"],
    [f.weightTenure, "tenure"],
  ] as const) {
    if (field.trim() === "") continue;
    const v = Number(field);
    if (!Number.isFinite(v) || v < 0 || v > 1) return undefined;
    out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export default function ManufacturerCredit() {
  const { activeTenantId } = useActiveTenant();
  const tenantId = activeTenantId ?? "";
  const utils = trpc.useUtils();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProgramForm>(EMPTY_FORM);

  const listQ = trpc.manufacturerPrograms.list.useQuery(
    { tenantId },
    { enabled: tenantId.length > 0 },
  );
  const programs = useMemo(() => listQ.data ?? [], [listQ.data]);
  const selected = programs.find((p) => p.id === selectedId) ?? programs[0] ?? null;

  const bookQ = trpc.manufacturerPrograms.programBook.useQuery(
    { tenantId, programId: selected?.id ?? "" },
    { enabled: tenantId.length > 0 && !!selected },
  );
  const tapeQ = trpc.manufacturerPrograms.programTape.useQuery(
    { tenantId, programId: selected?.id ?? "", format: "json" },
    { enabled: tenantId.length > 0 && !!selected },
  );

  const invalidate = async () => {
    await utils.manufacturerPrograms.list.invalidate();
    await utils.manufacturerPrograms.programBook.invalidate();
    await utils.manufacturerPrograms.programTape.invalidate();
  };

  const createM = trpc.manufacturerPrograms.create.useMutation({
    onSuccess: async (p) => {
      toast.success(`Program "${p.name}" created`);
      setDrawerOpen(false);
      setSelectedId(p.id);
      await invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const updateM = trpc.manufacturerPrograms.update.useMutation({
    onSuccess: async () => {
      toast.success("Program updated");
      setDrawerOpen(false);
      await invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const statusM = trpc.manufacturerPrograms.setStatus.useMutation({
    onSuccess: async (p) => {
      toast.success(`Status → ${p.status}`);
      await invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const exportTape = async () => {
    if (!selected) return;
    try {
      const doc = await utils.manufacturerPrograms.programTape.fetch({
        tenantId,
        programId: selected.id,
        format: "csv",
      });
      if (doc.format !== "csv") return;
      const blob = new Blob([doc.content], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Tape exported");
    } catch (e: any) {
      toast.error(e?.message ?? "Export failed");
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDrawerOpen(true);
  };
  const openEdit = (p: (typeof programs)[number]) => {
    setEditingId(p.id);
    const w = (p.scoringWeights ?? {}) as Record<string, number>;
    setForm({
      name: p.name,
      maxExposure: String(p.maxExposureCents / 100),
      programCap: String(p.programCapCents / 100),
      concentrationCapBps: String(p.concentrationCapBps),
      allowedTenorDays: (p.allowedTenorDays ?? []).join(", "),
      feeBps: String(p.feeBps),
      weightOnTime: w.onTime != null ? String(w.onTime) : "",
      weightVolume: w.volume != null ? String(w.volume) : "",
      weightTenure: w.tenure != null ? String(w.tenure) : "",
    });
    setDrawerOpen(true);
  };

  const submitForm = () => {
    const maxExposureCents = nairaToCents(form.maxExposure);
    const programCapCents = nairaToCents(form.programCap);
    const concentrationCapBps = Number(form.concentrationCapBps);
    const feeBps = Number(form.feeBps);
    if (!form.name.trim()) return toast.error("Name is required");
    if (!Number.isInteger(maxExposureCents)) return toast.error("Per-buyer exposure must be a valid amount");
    if (!Number.isInteger(programCapCents)) return toast.error("Program cap must be a valid amount");
    const weights = parseWeights(form);
    if (weights === undefined && (form.weightOnTime || form.weightVolume || form.weightTenure)) {
      return toast.error("Scoring weights must be numbers between 0 and 1");
    }
    const payload = {
      name: form.name.trim(),
      maxExposureCents,
      programCapCents,
      concentrationCapBps,
      allowedTenorDays: parseTenors(form.allowedTenorDays),
      feeBps,
      scoringWeights: weights ?? null,
    };
    if (editingId) updateM.mutate({ tenantId, programId: editingId, ...payload });
    else createM.mutate({ tenantId, ...payload });
  };

  const book = bookQ.data;
  const tape = tapeQ.data?.format === "json" ? tapeQ.data : null;
  const bucketCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of tape?.rows ?? []) counts[r.bucket] = (counts[r.bucket] ?? 0) + 1;
    return counts;
  }, [tape?.rows]);

  const saving = createM.isPending || updateM.isPending;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <Factory className="h-6 w-6" /> Manufacturer Credit Programs
            </h1>
            <p className="text-sm text-muted-foreground">
              Brand-funded credit programs for your merchant buyers — caps, concentration, and book monitoring.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={exportTape} disabled={!selected}>
              <Download className="h-4 w-4 mr-1" /> Export tape (CSV)
            </Button>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1" /> New program
            </Button>
          </div>
        </div>

        {listQ.isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : programs.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              No programs yet — create one to start extending brand-funded terms to your buyers.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
            {/* Program list */}
            <div className="space-y-2">
              {programs.map((p) => (
                <Card
                  key={p.id}
                  className={`cursor-pointer transition-colors ${selected?.id === p.id ? "border-primary" : "hover:border-muted-foreground/40"}`}
                  onClick={() => setSelectedId(p.id)}
                >
                  <CardHeader className="py-3 px-4">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">{p.name}</CardTitle>
                      <Badge variant="outline" className={STATUS_TONE[p.status] ?? ""}>{p.status}</Badge>
                    </div>
                    <CardDescription className="text-xs">
                      Cap {formatNaira(p.programCapCents)} · per-buyer {formatNaira(p.maxExposureCents)} · fee {p.feeBps}bps
                    </CardDescription>
                  </CardHeader>
                </Card>
              ))}
            </div>

            {/* Book dashboard */}
            {selected && (
              <div className="space-y-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0">
                    <div>
                      <CardTitle className="text-base">{selected.name} — book</CardTitle>
                      <CardDescription>
                        Tenors {(selected.allowedTenorDays ?? []).join("/") || "—"}d · concentration cap {selected.concentrationCapBps}bps
                      </CardDescription>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => openEdit(selected)}>
                        <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                      </Button>
                      {selected.status !== "active" ? (
                        <Button
                          size="sm"
                          onClick={() => statusM.mutate({ tenantId, programId: selected.id, status: "active" })}
                          disabled={statusM.isPending}
                        >
                          Activate
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => statusM.mutate({ tenantId, programId: selected.id, status: "suspended" })}
                          disabled={statusM.isPending}
                        >
                          Suspend
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {bookQ.isLoading || !book ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <>
                        <div>
                          <div className="flex justify-between text-xs text-muted-foreground mb-1">
                            <span>Utilization vs program cap</span>
                            <span>{(book.utilizationBps / 100).toFixed(1)}% · remaining {formatNaira(book.remainingCapacityCents)}</span>
                          </div>
                          <LimitGauge used={book.totalOutstandingCents} limit={book.programCapCents} />
                        </div>
                        <div className="grid gap-4 md:grid-cols-2">
                          <div>
                            <h3 className="text-xs font-medium text-muted-foreground mb-2">Top-5 concentration</h3>
                            {book.concentration.length === 0 ? (
                              <p className="text-xs text-muted-foreground">No exposure yet.</p>
                            ) : (
                              <div className="space-y-1.5">
                                {book.concentration.slice(0, 5).map((c) => (
                                  <div key={c.buyerTenantId} className="space-y-0.5">
                                    <div className="flex justify-between text-xs">
                                      <span className="font-mono">{c.buyerTenantId.slice(0, 8)}…</span>
                                      <span>{formatNaira(c.outstandingCents)} · {(c.shareBps / 100).toFixed(1)}%</span>
                                    </div>
                                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                                      <div
                                        className={`h-full rounded-full ${c.shareBps > book.concentrationCapBps ? "bg-red-500" : "bg-primary"}`}
                                        style={{ width: `${Math.min(100, c.shareBps / 100)}%` }}
                                      />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          <div>
                            <h3 className="text-xs font-medium text-muted-foreground mb-2">Aging buckets</h3>
                            <div className="grid grid-cols-5 gap-1 text-center">
                              {BUCKETS.map((b) => (
                                <div key={b} className="rounded border border-border py-2">
                                  <div className="text-lg font-semibold">{bucketCounts[b] ?? 0}</div>
                                  <div className="text-[10px] text-muted-foreground">{b}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Accounts ({tape?.rows.length ?? 0})</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {(tape?.rows.length ?? 0) === 0 ? (
                      <p className="text-sm text-muted-foreground py-4 text-center">No accounts assigned to this program yet.</p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Buyer</TableHead>
                            <TableHead className="text-right">Limit</TableHead>
                            <TableHead className="text-right">Outstanding</TableHead>
                            <TableHead className="text-right">Score</TableHead>
                            <TableHead>Bucket</TableHead>
                            <TableHead>Mandate</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {tape!.rows.map((r) => (
                            <TableRow key={r.accountId}>
                              <TableCell className="font-mono text-xs">{r.buyerTenantId.slice(0, 8)}…</TableCell>
                              <TableCell className="text-right">{formatNaira(r.limitCents)}</TableCell>
                              <TableCell className="text-right">{formatNaira(r.outstandingCents)}</TableCell>
                              <TableCell className="text-right">{r.score ?? "—"}</TableCell>
                              <TableCell>
                                <Badge variant="outline" className={r.bucket === "current" ? "text-emerald-400 border-emerald-500/40" : r.bucket === "90+" ? "text-red-400 border-red-500/40" : "text-amber-400 border-amber-500/40"}>
                                  {r.bucket}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-xs">{r.mandateStatus}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        )}

        {/* Create/edit drawer */}
        <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{editingId ? "Edit program" : "New credit program"}</DialogTitle>
              <DialogDescription>Caps are enforced on every buyer draw under this program.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-2">
              <div className="grid gap-1.5">
                <Label htmlFor="mc-name">Name</Label>
                <Input id="mc-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-exp">Per-buyer exposure (₦)</Label>
                  <Input id="mc-exp" inputMode="decimal" value={form.maxExposure} onChange={(e) => setForm({ ...form, maxExposure: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-cap">Program cap (₦)</Label>
                  <Input id="mc-cap" inputMode="decimal" value={form.programCap} onChange={(e) => setForm({ ...form, programCap: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-conc">Concentration cap (bps)</Label>
                  <Input id="mc-conc" inputMode="numeric" value={form.concentrationCapBps} onChange={(e) => setForm({ ...form, concentrationCapBps: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="mc-fee">Default fee (bps)</Label>
                  <Input id="mc-fee" inputMode="numeric" value={form.feeBps} onChange={(e) => setForm({ ...form, feeBps: e.target.value })} />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mc-tenor">Allowed tenors (days, comma separated)</Label>
                <Input id="mc-tenor" value={form.allowedTenorDays} onChange={(e) => setForm({ ...form, allowedTenorDays: e.target.value })} />
              </div>
              <div>
                <Label>Scoring weight overrides (optional, 0–1 each)</Label>
                <div className="grid grid-cols-3 gap-3 mt-1.5">
                  <Input placeholder="onTime 0.5" inputMode="decimal" value={form.weightOnTime} onChange={(e) => setForm({ ...form, weightOnTime: e.target.value })} />
                  <Input placeholder="volume 0.3" inputMode="decimal" value={form.weightVolume} onChange={(e) => setForm({ ...form, weightVolume: e.target.value })} />
                  <Input placeholder="tenure 0.2" inputMode="decimal" value={form.weightTenure} onChange={(e) => setForm({ ...form, weightTenure: e.target.value })} />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDrawerOpen(false)}>Cancel</Button>
              <Button onClick={submitForm} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                {editingId ? "Save changes" : "Create program"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
