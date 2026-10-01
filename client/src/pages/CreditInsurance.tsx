// === W57 risk-shield ===
// Credit insurance + first-loss provision fund page (W55 CreditFacilities/
// BuyerCredit precedent): policies list, deterministic quote + bind, claims
// list/file, and the provision fund balance + ledger. Lazy-routed at
// /credit-insurance in the client app, tenant portal and platform admin.
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { useActiveTenant } from "@/contexts/TenantContext";
import { ShieldCheck, Plus, FileText, Landmark } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

function fmtMoney(cents: number) {
  return `₦${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const claimColors: Record<string, string> = {
  filed: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  under_review: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  paid: "bg-green-500/20 text-green-400 border-green-500/30",
  rejected: "bg-red-500/20 text-red-400 border-red-500/30",
};

export default function CreditInsurance() {
  const utils = trpc.useUtils();
  const { activeTenantId: tenantId } = useActiveTenant();

  const policiesQ = trpc.creditInsurance.policies.useQuery({ tenantId }, { enabled: !!tenantId });
  const claimsQ = trpc.creditInsurance.claims.useQuery({ tenantId }, { enabled: !!tenantId });
  const fundQ = trpc.creditInsurance.provisionFund.useQuery({ tenantId }, { enabled: !!tenantId });

  const [bindOpen, setBindOpen] = useState(false);
  const [facilityRef, setFacilityRef] = useState("");
  const [principal, setPrincipal] = useState("");
  const [grade, setGrade] = useState<"A" | "B" | "C" | "D" | "E">("C");
  const principalCents = Math.round(Number(principal || "0") * 100);

  const quoteQ = trpc.creditInsurance.quote.useQuery(
    { tenantId, principalCents, grade },
    { enabled: !!tenantId && principalCents > 0 },
  );

  const [claimOpen, setClaimOpen] = useState(false);
  const [claimPolicyId, setClaimPolicyId] = useState("");
  const [defaultRef, setDefaultRef] = useState("");

  const bindMut = trpc.creditInsurance.bind.useMutation({
    onSuccess: () => {
      toast.success("Policy bound");
      setBindOpen(false);
      utils.creditInsurance.policies.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const fileMut = trpc.creditInsurance.fileClaim.useMutation({
    onSuccess: (r: any) => {
      toast.success(`Claim filed (${r.claim?.status ?? "filed"})`);
      setClaimOpen(false);
      utils.creditInsurance.claims.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldCheck className="h-6 w-6" /> Credit insurance
          </h1>
          <Button onClick={() => setBindOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Bind policy
          </Button>
        </div>

        <Card>
          <CardHeader><CardTitle>Policies</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Facility</TableHead>
                  <TableHead>Principal</TableHead>
                  <TableHead>Premium</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(policiesQ.data ?? []).map((p: any) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">{p.facilityRef}</TableCell>
                    <TableCell>{fmtMoney(p.principalCents)}</TableCell>
                    <TableCell>{fmtMoney(p.premiumCents)}</TableCell>
                    <TableCell>{p.grade}</TableCell>
                    <TableCell><Badge variant="outline">{p.status}</Badge></TableCell>
                    <TableCell>
                      {p.status === "bound" && (
                        <Button size="sm" variant="outline" onClick={() => { setClaimPolicyId(p.id); setClaimOpen(true); }}>
                          <FileText className="h-3 w-3 mr-1" /> File claim
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {!policiesQ.isLoading && (policiesQ.data ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-muted-foreground">No policies yet.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Claims</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Default ref</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Payout</TableHead>
                  <TableHead>Filed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(claimsQ.data ?? []).map((c: any) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-xs">{c.defaultRef}</TableCell>
                    <TableCell><Badge variant="outline" className={claimColors[c.status] ?? ""}>{c.status}</Badge></TableCell>
                    <TableCell>{c.payoutCents != null ? fmtMoney(c.payoutCents) : "—"}</TableCell>
                    <TableCell>{new Date(c.createdAt).toLocaleDateString()}</TableCell>
                  </TableRow>
                ))}
                {!claimsQ.isLoading && (claimsQ.data ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={4} className="text-muted-foreground">No claims yet.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Landmark className="h-5 w-5" /> First-loss provision fund
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-sm">
              Balance: <span className="font-semibold">{fmtMoney(fundQ.data?.balanceCents ?? 0)}</span>
              {" · "}accrual rate: {((fundQ.data?.accrualBps ?? 0) / 100).toFixed(2)}% of fee accruals
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Ref</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(fundQ.data?.ledger ?? []).map((l: any) => (
                  <TableRow key={l.id}>
                    <TableCell><Badge variant="outline">{l.kind}</Badge></TableCell>
                    <TableCell>{l.kind === "draw" ? "−" : "+"}{fmtMoney(l.amountCents)}</TableCell>
                    <TableCell className="font-mono text-xs">{l.ref}</TableCell>
                    <TableCell>{new Date(l.createdAt).toLocaleDateString()}</TableCell>
                  </TableRow>
                ))}
                {(fundQ.data?.ledger ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={4} className="text-muted-foreground">No fund activity yet.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Dialog open={bindOpen} onOpenChange={setBindOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Bind credit-insurance policy</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Facility reference</Label>
                <Input value={facilityRef} onChange={(e) => setFacilityRef(e.target.value)} placeholder="credit account id" />
              </div>
              <div>
                <Label>Principal (₦)</Label>
                <Input value={principal} onChange={(e) => setPrincipal(e.target.value)} inputMode="decimal" />
              </div>
              <div>
                <Label>Grade</Label>
                <Select value={grade} onValueChange={(v) => setGrade(v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["A", "B", "C", "D", "E"].map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {quoteQ.data && principalCents > 0 && (
                <div className="text-sm text-muted-foreground">
                  Premium: {fmtMoney(quoteQ.data.premiumCents)} ({quoteQ.data.premiumBps} bps)
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                disabled={!facilityRef.trim() || principalCents <= 0 || bindMut.isPending}
                onClick={() => bindMut.mutate({ tenantId, facilityRef: facilityRef.trim(), principalCents, grade })}
              >
                Bind
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={claimOpen} onOpenChange={setClaimOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>File insurance claim</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Default reference</Label>
                <Input value={defaultRef} onChange={(e) => setDefaultRef(e.target.value)} placeholder="default registry / ledger ref" />
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={!defaultRef.trim() || fileMut.isPending}
                onClick={() => fileMut.mutate({ tenantId, policyId: claimPolicyId, defaultRef: defaultRef.trim() })}
              >
                File claim
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
// === END W57 risk-shield ===
