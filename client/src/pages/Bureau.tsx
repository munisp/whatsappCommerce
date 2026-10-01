// === W56 credit ===
// Bureau surface for the W56 bureau router: consent-first credit-report
// pulls (the exact BUREAU_CONSENT_TEXT is shown behind the consent
// checkbox), pull history and repayment report-back outbox status.
import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { Landmark } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const statusColors: Record<string, string> = {
  ok: "bg-green-500/20 text-green-400 border-green-500/30",
  sent: "bg-green-500/20 text-green-400 border-green-500/30",
  pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  error: "bg-red-500/20 text-red-400 border-red-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
};

export default function Bureau() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const utils = trpc.useUtils();

  const { data: consentText } = trpc.bureau.consentText.useQuery({ locale: "en" });
  const { data: outbox } = trpc.bureau.reportStatus.useQuery({ tenantId });

  const [subjectId, setSubjectId] = useState("");
  const [phone, setPhone] = useState("");
  const [consentChecked, setConsentChecked] = useState(false);
  const [historyFor, setHistoryFor] = useState<string | null>(null);

  const { data: history } = trpc.bureau.history.useQuery(
    { tenantId, subjectType: "buyer", subjectId: historyFor ?? "" },
    { enabled: !!historyFor },
  );

  const pullMut = trpc.bureau.pull.useMutation({
    onSuccess: (r) => {
      if (r.ok) toast.success(`Bureau report pulled via ${r.provider}`);
      else toast.warning(`Pull failed open: ${r.error ?? "provider unavailable"}`);
      utils.bureau.history.invalidate();
      setHistoryFor(subjectId.trim());
    },
    onError: (e) => toast.error(e.message),
  });

  const consentMut = trpc.bureau.recordConsent.useMutation({
    onError: (e) => toast.error(e.message),
  });

  const sweepMut = trpc.bureau.sweepNow.useMutation({
    onSuccess: (r) => {
      toast.success(`Report sweep: ${r.sent} sent, ${r.failed} failed, ${r.skippedNoProvider} skipped`);
      utils.bureau.reportStatus.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const requestPull = async () => {
    const sid = subjectId.trim();
    if (!sid) return;
    if (!consentChecked) {
      toast.error("Consent is required before a bureau pull");
      return;
    }
    // Record the consent artefact FIRST (portal channel), then pull.
    await consentMut.mutateAsync({ tenantId, subjectType: "buyer", subjectId: sid, channel: "portal", locale: "en" });
    pullMut.mutate({ tenantId, subjectType: "buyer", subjectId: sid, phone: phone.trim() || undefined });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-3">
          <Landmark className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-semibold">Credit Bureau</h1>
          <Badge variant="outline">consent-first</Badge>
        </div>

        {/* Request a pull */}
        <Card>
          <CardHeader><CardTitle>Request credit report</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <Label>Customer id / subject ref</Label>
                <Input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} placeholder="customer id" />
              </div>
              <div>
                <Label>Phone (optional)</Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+2348012345678" />
              </div>
            </div>
            <div className="rounded-md border p-3 text-sm text-muted-foreground whitespace-pre-wrap">
              {consentText?.text ?? "Loading consent text…"}
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="bureau-consent" checked={consentChecked} onCheckedChange={(v) => setConsentChecked(v === true)} />
              <Label htmlFor="bureau-consent">The customer has given the consent above (recorded before the pull).</Label>
            </div>
            <div className="flex gap-2">
              <Button onClick={requestPull} disabled={!consentChecked || pullMut.isPending || consentMut.isPending}>
                Request pull
              </Button>
              <Button variant="outline" onClick={() => subjectId.trim() && setHistoryFor(subjectId.trim())}>
                View history
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Pull history */}
        {historyFor && (
          <Card>
            <CardHeader><CardTitle>Pull history — {historyFor}</CardTitle></CardHeader>
            <CardContent>
              {!history?.length ? (
                <p className="text-sm text-muted-foreground">No pulls recorded for this subject.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Score</TableHead>
                      <TableHead>Ref</TableHead>
                      <TableHead>When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>{p.provider}</TableCell>
                        <TableCell><Badge className={statusColors[p.status] ?? ""}>{p.status}</Badge></TableCell>
                        <TableCell>{(p.report as any)?.score ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{p.rawRef ?? "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatDistanceToNow(new Date(p.createdAt), { addSuffix: true })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}

        {/* Report-back outbox */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Repayment report-back</CardTitle>
            <Button size="sm" variant="outline" onClick={() => sweepMut.mutate({ tenantId })} disabled={sweepMut.isPending}>
              Run sweep now
            </Button>
          </CardHeader>
          <CardContent>
            {!outbox?.length ? (
              <p className="text-sm text-muted-foreground">No report-back events queued.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subject</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>Reported</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {outbox.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.subjectId}</TableCell>
                      <TableCell>{r.eventType}</TableCell>
                      <TableCell><Badge className={statusColors[r.status] ?? ""}>{r.status}</Badge></TableCell>
                      <TableCell>{r.attempts}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.reportedAt ? formatDistanceToNow(new Date(r.reportedAt), { addSuffix: true }) : "—"}
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
