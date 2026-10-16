// === W56 credit ===
// Credit-scores surface for the W56 creditScoring router: tenant-scoped
// score cards with factor breakdown, grade badges and a recompute-now
// action (read-only advisory — nothing here blocks any credit flow).
import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { Gauge, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const gradeColors: Record<string, string> = {
  A: "bg-green-500/20 text-green-400 border-green-500/30",
  B: "bg-lime-500/20 text-lime-400 border-lime-500/30",
  C: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  D: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  E: "bg-red-500/20 text-red-400 border-red-500/30",
};

const FACTOR_LABELS: Record<string, string> = {
  orderHistory: "Order history",
  orderVolume: "Order volume",
  repaymentTimeliness: "Repayment timeliness",
  disputeHistory: "Dispute record",
  kycStatus: "KYC/KYB status",
  tenure: "Tenure",
};

export default function CreditScores() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const utils = trpc.useUtils();

  const { data: scores, isLoading } = trpc.creditScoring.list.useQuery({ tenantId });
  const [subjectType, setSubjectType] = useState<"buyer" | "merchant">("buyer");
  const [subjectId, setSubjectId] = useState("");
  const [lookup, setLookup] = useState<{ subjectType: "buyer" | "merchant"; subjectId: string } | null>(null);

  const { data: detail } = trpc.creditScoring.getSubject.useQuery(
    { tenantId, subjectType: lookup?.subjectType ?? "buyer", subjectId: lookup?.subjectId ?? "" },
    { enabled: !!lookup?.subjectId },
  );

  const recomputeMut = trpc.creditScoring.recompute.useMutation({
    onSuccess: () => {
      toast.success("Score recomputed");
      utils.creditScoring.list.invalidate();
      utils.creditScoring.getSubject.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-3">
          <Gauge className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-semibold">Credit Scores</h1>
          <Badge variant="outline">advisory</Badge>
        </div>

        {/* Subject lookup + recompute */}
        <Card>
          <CardHeader><CardTitle>Subject lookup</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label>Type</Label>
                <select
                  className="flex h-9 rounded-md border bg-background px-3 text-sm"
                  value={subjectType}
                  onChange={(e) => setSubjectType(e.target.value as "buyer" | "merchant")}
                >
                  <option value="buyer">Buyer</option>
                  <option value="merchant">Merchant</option>
                </select>
              </div>
              <div className="min-w-56">
                <Label>Customer id / phone / tenant id</Label>
                <Input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} placeholder="+2348012345678" />
              </div>
              <Button
                variant="outline"
                onClick={() => subjectId.trim() && setLookup({ subjectType, subjectId: subjectId.trim() })}
              >
                View score
              </Button>
              <Button
                variant="outline"
                disabled={!lookup?.subjectId || recomputeMut.isPending}
                onClick={() => lookup && recomputeMut.mutate({ tenantId, subjectType: lookup.subjectType, subjectId: lookup.subjectId })}
              >
                <RefreshCw className="mr-2 h-4 w-4" /> Recompute now
              </Button>
            </div>

            {detail && (
              <div className="rounded-md border p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <span className="text-3xl font-bold">{detail.score}</span>
                  <Badge className={gradeColors[detail.grade] ?? ""}>{detail.grade}</Badge>
                  <span className="text-sm text-muted-foreground">
                    computed {formatDistanceToNow(new Date(detail.computedAt), { addSuffix: true })} · {detail.version}
                  </span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {Object.entries((detail.factors ?? {}) as Record<string, any>)
                    .filter(([k]) => FACTOR_LABELS[k])
                    .map(([k, f]) => (
                      <div key={k} className="rounded border p-2 text-sm">
                        <div className="text-muted-foreground">{FACTOR_LABELS[k]}</div>
                        <div className="font-medium">{f.points}/{f.weight}</div>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Score book */}
        <Card>
          <CardHeader><CardTitle>Score book</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : !scores?.length ? (
              <p className="text-sm text-muted-foreground">No scores computed yet — scores appear after the first computation or the scheduled refresh sweep.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subject</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Score</TableHead>
                    <TableHead>Grade</TableHead>
                    <TableHead>Computed</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scores.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">{s.subjectId}</TableCell>
                      <TableCell>{s.subjectType}</TableCell>
                      <TableCell className="font-semibold">{s.score}</TableCell>
                      <TableCell><Badge className={gradeColors[s.grade] ?? ""}>{s.grade}</Badge></TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDistanceToNow(new Date(s.computedAt), { addSuffix: true })}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm" variant="ghost"
                          disabled={recomputeMut.isPending}
                          onClick={() => recomputeMut.mutate({ tenantId, subjectType: s.subjectType as "buyer" | "merchant", subjectId: s.subjectId })}
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
