/**
 * KybReview — platform-admin review queue for KYB applications
 * (server/routers/kyc.ts: listAll / getApplication / review, all
 * adminProcedure). onboarding.activate hard-requires an approved KYB
 * application (server/services/kycGate.ts); this is the only place that
 * decision can be made — tenants submit via the onboarding wizard's KYB
 * Verification step, but can't approve their own application.
 */
import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { AlertTriangle, Building2, CheckCircle2, FileText, Loader2, ShieldCheck, XCircle } from "lucide-react";

const STATUS_META: Record<string, { label: string; className: string }> = {
  not_started: { label: "Not started", className: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30" },
  pending: { label: "Pending review", className: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  approved: { label: "Approved", className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  rejected: { label: "Rejected", className: "bg-red-500/15 text-red-300 border-red-500/30" },
  resubmit_required: { label: "Resubmission required", className: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
};

const STATUS_FILTERS = ["pending", "approved", "rejected", "resubmit_required", "not_started", "all"] as const;

function ApplicationDetail({ applicationId, onDecided }: { applicationId: string; onDecided: () => void }) {
  const utils = trpc.useUtils();
  const { data: app, isLoading } = trpc.kyc.getApplication.useQuery({ applicationId });
  const [decision, setDecision] = useState<"approved" | "rejected" | "resubmit_required">("approved");
  const [notes, setNotes] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [waive, setWaive] = useState(false);

  const review = trpc.kyc.review.useMutation({
    onSuccess: () => {
      toast.success(`Application ${decision.replace("_", " ")}`);
      utils.kyc.listAll.invalidate();
      onDecided();
    },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading || !app) {
    return <div className="space-y-3 py-4">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-6" />)}</div>;
  }

  const pendingDocs = app.documents.filter((d) => !d.processedAt);
  const statusMeta = STATUS_META[app.status] ?? STATUS_META.not_started;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className={statusMeta.className}>{statusMeta.label}</Badge>
        <span className="text-xs text-muted-foreground">tenant: {app.tenantId}</span>
      </div>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div><p className="text-xs text-muted-foreground">Applicant</p><p className="font-medium">{app.applicantName || "—"}</p></div>
        <div><p className="text-xs text-muted-foreground">Email</p><p className="font-medium">{app.applicantEmail || "—"}</p></div>
        <div><p className="text-xs text-muted-foreground">Phone</p><p className="font-medium">{app.applicantPhone || "—"}</p></div>
        <div><p className="text-xs text-muted-foreground">Business</p><p className="font-medium">{app.businessName || "—"}</p></div>
        <div><p className="text-xs text-muted-foreground">Registration #</p><p className="font-medium">{app.businessRegistrationNumber || "—"}</p></div>
        <div><p className="text-xs text-muted-foreground">Country</p><p className="font-medium">{app.businessCountry || "—"}</p></div>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold">Documents</h4>
        {app.documents.length === 0 && <p className="text-sm text-muted-foreground">No documents uploaded.</p>}
        {app.documents.map((d) => (
          <a
            key={d.id}
            href={d.fileUrl ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-lg border p-2.5 text-sm hover:bg-accent transition-colors"
          >
            <FileText className="w-4 h-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 capitalize">{d.documentType.replace(/_/g, " ")}</span>
            {d.processedAt ? (
              <Badge variant="outline" className="text-[10px] bg-emerald-500/15 text-emerald-300 border-emerald-500/30">verified</Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] bg-amber-500/15 text-amber-300 border-amber-500/30">pending</Badge>
            )}
          </a>
        ))}
      </div>

      {app.reviewNotes && (
        <div className="text-xs text-muted-foreground border-t pt-2">
          <span className="font-medium">Previous review notes:</span> {app.reviewNotes}
        </div>
      )}

      <div className="space-y-3 border-t pt-4">
        <h4 className="text-sm font-semibold">Decision</h4>
        <Select value={decision} onValueChange={(v) => setDecision(v as typeof decision)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="approved">Approve</SelectItem>
            <SelectItem value="resubmit_required">Request resubmission</SelectItem>
            <SelectItem value="rejected">Reject</SelectItem>
          </SelectContent>
        </Select>

        {decision === "rejected" && (
          <div className="space-y-1.5">
            <Label htmlFor="kyb-rejreason">Rejection reason</Label>
            <Textarea id="kyb-rejreason" rows={2} value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} />
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="kyb-notes">Notes (optional)</Label>
          <Textarea id="kyb-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        {decision === "approved" && pendingDocs.length > 0 && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{pendingDocs.length} document(s) not yet verified</AlertTitle>
            <AlertDescription>
              The OCR/VLM pipeline hasn't finished processing{" "}
              {pendingDocs.map((d) => d.documentType.replace(/_/g, " ")).join(", ")}. Approving now requires an
              explicit waiver.
              <div className="flex items-center gap-2 mt-2">
                <Checkbox id="kyb-waive" checked={waive} onCheckedChange={(v) => setWaive(v === true)} />
                <Label htmlFor="kyb-waive" className="text-sm font-normal cursor-pointer">
                  I've reviewed the documents manually and waive automated verification
                </Label>
              </div>
            </AlertDescription>
          </Alert>
        )}

        <Button
          disabled={
            review.isPending ||
            (decision === "rejected" && !rejectionReason.trim()) ||
            (decision === "approved" && pendingDocs.length > 0 && !waive)
          }
          onClick={() =>
            review.mutate({
              applicationId,
              decision,
              notes: notes.trim() || undefined,
              rejectionReason: decision === "rejected" ? rejectionReason.trim() : undefined,
              waivePendingDocuments: waive,
            })
          }
        >
          {review.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
          Submit decision
        </Button>
      </div>
    </div>
  );
}

export default function KybReview() {
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("pending");
  const [openId, setOpenId] = useState<string | null>(null);

  const { data: apps, isLoading } = trpc.kyc.listAll.useQuery({
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 100,
  });

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6 max-w-4xl mx-auto">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-primary" />
            KYB Review
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Approve or reject tenant KYB applications — required before a tenant can activate (onboarding.activate).
          </p>
        </div>

        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((s) => (
              <SelectItem key={s} value={s}>{s === "all" ? "All statuses" : (STATUS_META[s] ?? { label: s }).label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isLoading ? (
          <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
        ) : !apps || apps.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">No applications with this status.</p>
        ) : (
          <div className="space-y-2">
            {apps.map((app) => {
              const meta = STATUS_META[app.status] ?? STATUS_META.not_started;
              return (
                <Card key={app.id} className="hover:border-primary/40 transition-colors cursor-pointer" onClick={() => setOpenId(app.id)}>
                  <CardContent className="p-4 flex items-center gap-3">
                    <Building2 className="w-5 h-5 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{app.businessName || "(no business name yet)"}</p>
                      <p className="text-xs text-muted-foreground truncate">tenant {app.tenantId}</p>
                    </div>
                    <Badge variant="outline" className={meta.className}>{meta.label}</Badge>
                    {app.status === "approved" ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    ) : app.status === "rejected" ? (
                      <XCircle className="w-4 h-4 text-red-400" />
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={!!openId} onOpenChange={(open) => !open && setOpenId(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>KYB Application</DialogTitle>
            <DialogDescription>Review business details, documents, and record a decision.</DialogDescription>
          </DialogHeader>
          {openId && <ApplicationDetail applicationId={openId} onDecided={() => setOpenId(null)} />}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
