import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { ShieldCheck, ShieldOff, Download, UserX, Loader2, CheckCircle2, XCircle } from "lucide-react";

const TENANT_ID = "demo-tenant-1";

type ConsentRow = {
  id: string;
  phone: string;
  channel: string;
  scope: string | null;
  granted: boolean;
  grantedAt: string | Date | null;
  source: string | null;
  withdrawnAt: string | Date | null;
  updatedAt: string | Date;
};

const fmt = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleString() : "—");

export default function Consents() {
  const [phone, setPhone] = useState("");

  const { data: rows, refetch, isLoading } = trpc.consents.list.useQuery({ tenantId: TENANT_ID, limit: 500 });
  const consents = (rows ?? []) as ConsentRow[];

  const { data: statsData } = trpc.consents.stats.useQuery({ tenantId: TENANT_ID });
  const stats = statsData ?? { scopes: [] as any[], totals: { granted: 0, withdrawn: 0, denied: 0 } };

  const withdrawMut = trpc.consents.recordWithdrawal.useMutation({
    onSuccess: () => { toast.success("Withdrawal recorded — future sends to this contact are blocked"); setPhone(""); refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const utils = trpc.useUtils();

  const exportCsv = async () => {
    try {
      const data = await utils.consents.exportCsv.fetch({ tenantId: TENANT_ID });
      const csv = [data.headers.join(","), ...data.rows.map((r: any) => data.headers.map((h: string) => JSON.stringify(r[h] ?? "")).join(","))].join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `consents-${TENANT_ID}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error(e?.message ?? "export failed");
    }
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><ShieldCheck className="w-6 h-6" /> Consent Management</h1>
            <p className="text-sm text-muted-foreground">NDPR/GDPR-grade opt-in states per channel and scope. Withdrawn contacts are hard-blocked from broadcasts and journeys.</p>
          </div>
          <Button variant="outline" onClick={exportCsv}><Download className="w-4 h-4 mr-1" /> Export CSV</Button>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-400" /> Active opt-ins</CardTitle></CardHeader>
            <CardContent className="text-2xl font-bold text-emerald-400">{stats.totals.granted}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><ShieldOff className="w-4 h-4 text-amber-400" /> Withdrawn</CardTitle></CardHeader>
            <CardContent className="text-2xl font-bold text-amber-400">{stats.totals.withdrawn}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><XCircle className="w-4 h-4 text-red-400" /> Denied</CardTitle></CardHeader>
            <CardContent className="text-2xl font-bold text-red-400">{stats.totals.denied}</CardContent>
          </Card>
        </div>

        {stats.scopes.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-sm">Opt-in rates by scope</CardTitle></CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              {stats.scopes.map((s: any) => (
                <div key={s.scope} className="rounded-md border border-border/60 px-3 py-2 text-xs">
                  <div className="font-medium">{s.scope}</div>
                  <div className="text-muted-foreground">{s.active}/{s.total} active · grant {s.grantRate}% · withdrawal {s.withdrawalRate}%</div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-sm">Consent states ({consents.length})</CardTitle>
              <div className="flex gap-2">
                <Input className="h-8 w-56 text-xs" placeholder="+23480… phone to withdraw" value={phone} onChange={(e) => setPhone(e.target.value)} />
                <Button size="sm" variant="outline" className="text-amber-400" disabled={!phone || withdrawMut.isPending}
                  onClick={() => withdrawMut.mutate({ tenantId: TENANT_ID, phone })}>
                  {withdrawMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserX className="w-3 h-3 mr-1" />} Record withdrawal
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Phone</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Granted at</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Withdrawn at</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {consents.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-mono text-xs">{c.phone}</TableCell>
                      <TableCell className="text-xs">{c.channel}</TableCell>
                      <TableCell className="text-xs">{c.scope ?? "marketing"}</TableCell>
                      <TableCell>
                        {c.withdrawnAt ? (
                          <Badge variant="outline" className="bg-amber-500/15 text-amber-400 border-amber-500/30">withdrawn</Badge>
                        ) : c.granted ? (
                          <Badge variant="outline" className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">granted</Badge>
                        ) : (
                          <Badge variant="outline" className="bg-red-500/15 text-red-400 border-red-500/30">denied</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{fmt(c.grantedAt)}</TableCell>
                      <TableCell className="text-xs">{c.source ?? "—"}</TableCell>
                      <TableCell className="text-xs">{fmt(c.withdrawnAt)}</TableCell>
                      <TableCell>
                        {!c.withdrawnAt && c.granted && (
                          <Button size="sm" variant="ghost" className="h-7 text-xs text-amber-400"
                            onClick={() => withdrawMut.mutate({ tenantId: TENANT_ID, phone: c.phone })}>
                            Withdraw
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {consents.length === 0 && (
                    <TableRow><TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-8">No consent records yet.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
