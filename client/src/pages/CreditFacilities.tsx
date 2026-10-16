// === W55 ui-c ===
// Platform-admin lender facility servicing for the W14 creditFacilities
// router (ORPHAN-BE-11): facilities list with utilization, create,
// account assignment, covenant check, loan-book tape (JSON/CSV) and the
// monthly email preview.
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { Landmark, Plus, ShieldCheck, FileDown, Mail, Link2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

function fmtMoney(cents: number, currency: string) {
  return `${currency} ${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const statusColors: Record<string, string> = {
  active: "bg-green-500/20 text-green-400 border-green-500/30",
  suspended: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  closed: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

export default function CreditFacilities() {
  const utils = trpc.useUtils();
  const { data: facilities, isLoading } = trpc.creditFacilities.listFacilities.useQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = facilities?.find((f) => f.id === selectedId) ?? null;

  const [createOpen, setCreateOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignAccountId, setAssignAccountId] = useState("");
  const [tape, setTape] = useState<any>(null);
  const [tapeLoading, setTapeLoading] = useState(false);

  const { data: covenant, refetch: runCovenant, isFetching: covenantLoading } =
    trpc.creditFacilities.covenantCheck.useQuery(
      { facilityId: selectedId ?? "" },
      { enabled: false },
    );
  const { data: emailPreview, refetch: runEmailPreview, isFetching: emailLoading } =
    trpc.creditFacilities.tapeEmailPreview.useQuery(
      { facilityId: selectedId ?? "" },
      { enabled: false },
    );

  const createMut = trpc.creditFacilities.createFacility.useMutation({
    onSuccess: () => {
      toast.success("Facility created");
      setCreateOpen(false);
      utils.creditFacilities.listFacilities.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const assignMut = trpc.creditFacilities.assignAccount.useMutation({
    onSuccess: () => {
      toast.success("Account assigned to facility");
      setAssignOpen(false);
      setAssignAccountId("");
      utils.creditFacilities.listFacilities.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const [form, setForm] = useState({
    lenderName: "",
    facilityRef: "",
    commitmentNaira: "",
    currency: "NGN",
    advanceRateBps: "8000",
  });

  const submitCreate = () => {
    const commitmentCents = Math.round(Number(form.commitmentNaira) * 100);
    if (!form.lenderName.trim() || !form.facilityRef.trim() || !Number.isFinite(commitmentCents) || commitmentCents < 0) {
      toast.error("Fill lender, reference and a valid commitment amount");
      return;
    }
    createMut.mutate({
      lenderName: form.lenderName.trim(),
      facilityRef: form.facilityRef.trim(),
      commitmentCents,
      currency: form.currency,
      advanceRateBps: Number(form.advanceRateBps) || 8000,
    });
  };

  const viewTapeJson = async () => {
    setTapeLoading(true);
    try {
      const data = await utils.creditFacilities.generateTape.fetch({ facilityId: selectedId ?? undefined, format: "json" });
      setTape(data);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to generate tape");
    } finally {
      setTapeLoading(false);
    }
  };

  const downloadTape = async () => {
    setTapeLoading(true);
    try {
      const data = await utils.creditFacilities.generateTape.fetch({ facilityId: selectedId ?? undefined, format: "csv" });
      if (data.format === "csv") {
        const blob = new Blob([data.content], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = data.filename;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to generate tape");
    } finally {
      setTapeLoading(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Lender Facilities</h1>
            <p className="text-muted-foreground mt-1">Warehouse lines, utilization, covenants and loan-book tapes</p>
          </div>
          <Button onClick={() => setCreateOpen(true)} className="gap-1">
            <Plus className="w-4 h-4" /> New facility
          </Button>
        </div>

        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Facilities</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Lender</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Commitment</TableHead>
                  <TableHead>Outstanding</TableHead>
                  <TableHead>Utilization</TableHead>
                  <TableHead>Available to advance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
                ) : !facilities?.length ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    <div className="flex flex-col items-center gap-2">
                      <Landmark className="w-8 h-8 opacity-40" />
                      No lender facilities yet
                    </div>
                  </TableCell></TableRow>
                ) : facilities.map((f) => (
                  <TableRow key={f.id}
                    className={`border-border hover:bg-accent/30 cursor-pointer ${selectedId === f.id ? "bg-accent/40" : ""}`}
                    onClick={() => setSelectedId(f.id)}>
                    <TableCell className="font-medium">{f.lenderName}</TableCell>
                    <TableCell className="font-mono text-xs">{f.facilityRef}</TableCell>
                    <TableCell className="font-mono">{fmtMoney(f.commitmentCents, f.currency)}</TableCell>
                    <TableCell className="font-mono">{fmtMoney(f.utilization.outstandingCents, f.currency)}</TableCell>
                    <TableCell className="text-sm">{(f.utilization.utilizationBps / 100).toFixed(1)}% · {f.utilization.accountCount} accts</TableCell>
                    <TableCell className="font-mono">{fmtMoney(f.utilization.availableToAdvanceCents, f.currency)}</TableCell>
                    <TableCell><Badge variant="outline" className={statusColors[f.status] ?? ""}>{f.status}</Badge></TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"
                        onClick={(e) => { e.stopPropagation(); setSelectedId(f.id); setAssignOpen(true); }}>
                        <Link2 className="w-3 h-3" /> Assign account
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {selected && (
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Servicing — {selected.lenderName} ({selected.facilityRef})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="covenants">
                <TabsList>
                  <TabsTrigger value="covenants"><ShieldCheck className="w-3.5 h-3.5 mr-1" />Covenants</TabsTrigger>
                  <TabsTrigger value="tape"><FileDown className="w-3.5 h-3.5 mr-1" />Loan-book tape</TabsTrigger>
                  <TabsTrigger value="email"><Mail className="w-3.5 h-3.5 mr-1" />Email preview</TabsTrigger>
                </TabsList>
                <TabsContent value="covenants" className="space-y-3 pt-3">
                  <Button size="sm" onClick={() => runCovenant()} disabled={covenantLoading}>
                    {covenantLoading ? "Checking..." : "Run covenant check"}
                  </Button>
                  {covenant && (
                    <pre className="text-xs bg-muted/40 rounded-md p-3 overflow-auto max-h-72">{JSON.stringify(covenant, null, 2)}</pre>
                  )}
                </TabsContent>
                <TabsContent value="tape" className="space-y-3 pt-3">
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={viewTapeJson} disabled={tapeLoading}>
                      {tapeLoading ? "Generating..." : "View JSON tape"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={downloadTape} disabled={tapeLoading}>
                      {tapeLoading ? "Generating..." : "Download CSV"}
                    </Button>
                  </div>
                  {tape && tape.format === "json" && (
                    <pre className="text-xs bg-muted/40 rounded-md p-3 overflow-auto max-h-72">{JSON.stringify(tape.summary, null, 2)}{"\n"}{tape.rows?.length ?? 0} rows</pre>
                  )}
                </TabsContent>
                <TabsContent value="email" className="space-y-3 pt-3">
                  <Button size="sm" onClick={() => runEmailPreview()} disabled={emailLoading}>
                    {emailLoading ? "Loading..." : "Load monthly email preview"}
                  </Button>
                  {emailPreview && (
                    <pre className="text-xs bg-muted/40 rounded-md p-3 overflow-auto max-h-72 whitespace-pre-wrap">{emailPreview.text}</pre>
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        )}

        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>New lender facility</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Lender name</Label>
                  <Input value={form.lenderName} onChange={(e) => setForm({ ...form, lenderName: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Facility reference</Label>
                  <Input value={form.facilityRef} onChange={(e) => setForm({ ...form, facilityRef: e.target.value })} placeholder="e.g. WL-2025-001" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Commitment (NGN)</Label>
                  <Input type="number" min="0" step="0.01" value={form.commitmentNaira}
                    onChange={(e) => setForm({ ...form, commitmentNaira: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Advance rate (bps)</Label>
                  <Input type="number" min={0} max={10000} value={form.advanceRateBps}
                    onChange={(e) => setForm({ ...form, advanceRateBps: e.target.value })} />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>Close</Button>
              <Button onClick={submitCreate} disabled={createMut.isPending}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Assign credit account</DialogTitle></DialogHeader>
            <div className="space-y-2">
              <Label>Credit account ID</Label>
              <Input value={assignAccountId} onChange={(e) => setAssignAccountId(e.target.value)} placeholder="credit account id" />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAssignOpen(false)}>Close</Button>
              <Button disabled={assignMut.isPending || !assignAccountId.trim() || !selectedId}
                onClick={() => assignMut.mutate({ accountId: assignAccountId.trim(), facilityId: selectedId! })}>
                Assign
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
