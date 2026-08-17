import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, ShieldCheck, XCircle, AlertTriangle } from "lucide-react";

/**
 * SOC2 compliance dashboard.
 *
 * Server-types seam: the `compliance.*` endpoints below are delivered by a
 * parallel wave (Coder X registers them on the app router). They are not yet
 * present on the generated AppRouter type, so calls go through a narrowly
 * cast `complianceApi` handle. The runtime contract is FIXED (see shapes
 * below); once the server lands and types regenerate, the cast can be
 * dropped without touching the JSX.
 */
const complianceApi = (trpc as any).compliance;

type AuditChainResult = { ok: boolean; rowsChecked: number; firstBrokenId: string | null };
type AccessReviewRow = {
  userId: string;
  name: string;
  phone: string;
  role: string;
  lastLoginAt: string | null;
  activeSessions: number;
};
type RetentionPolicyRow = { entity: string; retentionDays: number; legalHold: boolean; updatedAt: string };
type IncidentStatusResult = {
  open: number;
  investigating: number;
  mitigated: number;
  resolved: number;
  recent: Array<{ id: string; title: string; severity: string; status: string; openedAt: string }>;
};
type AnomalyAlertRow = {
  id: string;
  signal: string;
  score: number;
  status: "open" | "acknowledged" | "dismissed";
  createdAt: string;
  windowBucket: string;
  detail?: Record<string, unknown> | null;
};
type AnomalyScanResult = {
  baselineBuilding: boolean;
  baselineEvents: number;
  windowEvents: number;
  alertsCreated: number;
};

const anomalyStatusColors: Record<string, string> = {
  open: "bg-red-500/20 text-red-400 border-red-500/30",
  acknowledged: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  dismissed: "bg-blue-500/20 text-blue-400 border-blue-500/30",
};

const severityColors: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400 border-red-500/30",
  high: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  medium: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  low: "bg-blue-500/20 text-blue-400 border-blue-500/30",
};

const statusColors: Record<string, string> = {
  open: "bg-red-500/20 text-red-400 border-red-500/30",
  investigating: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  mitigated: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  resolved: "bg-green-500/20 text-green-400 border-green-500/30",
};

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

export default function Compliance() {
  const auditChain = complianceApi.verifyAuditChain.useQuery(undefined, {
    retry: false,
    refetchInterval: 60_000,
  }) as { data?: AuditChainResult; isLoading: boolean; isError: boolean };
  const accessReview = complianceApi.accessReview.useQuery(undefined, { retry: false }) as {
    data?: AccessReviewRow[];
    isLoading: boolean;
    isError: boolean;
  };
  const retention = complianceApi.retentionPolicies.useQuery(undefined, { retry: false }) as {
    data?: RetentionPolicyRow[];
    isLoading: boolean;
    isError: boolean;
  };
  const incidents = complianceApi.incidentStatus.useQuery(undefined, {
    retry: false,
    refetchInterval: 60_000,
  }) as { data?: IncidentStatusResult; isLoading: boolean; isError: boolean };
  const anomalyAlertsQuery = complianceApi.anomalyAlerts.useQuery(undefined, {
    retry: false,
    refetchInterval: 60_000,
  }) as { data?: AnomalyAlertRow[]; isLoading: boolean; isError: boolean; refetch: () => void };
  const anomalyScan = complianceApi.anomalyScan.useMutation({
    onSuccess: () => anomalyAlertsQuery.refetch(),
  }) as { mutate: (input?: Record<string, never>) => void; isPending: boolean; data?: AnomalyScanResult };
  const updateAnomalyAlert = complianceApi.updateAnomalyAlert.useMutation({
    onSuccess: () => anomalyAlertsQuery.refetch(),
  }) as { mutate: (input: { alertId: string; status: "acknowledged" | "dismissed" }) => void; isPending: boolean };

  const chain = auditChain.data;
  const incidentData = incidents.data;

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-semibold">SOC2 Compliance</h1>
            <p className="text-sm text-muted-foreground">
              Audit-chain integrity, access review, retention policies, and incident status.
            </p>
          </div>
        </div>

        {/* Audit-chain integrity */}
        <Card>
          <CardHeader>
            <CardTitle>Audit-Chain Integrity</CardTitle>
          </CardHeader>
          <CardContent>
            {auditChain.isLoading ? (
              <p className="text-sm text-muted-foreground">Verifying hash chain…</p>
            ) : auditChain.isError || !chain ? (
              <div className="flex items-center gap-2 text-yellow-400">
                <AlertTriangle className="h-5 w-5" />
                <span>Verification unavailable (compliance endpoint not reachable).</span>
              </div>
            ) : chain.ok ? (
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-6 w-6 text-green-400" />
                <div>
                  <p className="font-medium text-green-400">Chain intact</p>
                  <p className="text-sm text-muted-foreground">{chain.rowsChecked} rows verified</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <XCircle className="h-6 w-6 text-red-400" />
                <div>
                  <p className="font-medium text-red-400">Chain broken</p>
                  <p className="text-sm text-muted-foreground">
                    {chain.rowsChecked} rows checked; first broken row: {chain.firstBrokenId ?? "unknown"}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Incident status rollup */}
        <Card>
          <CardHeader>
            <CardTitle>Incident Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {incidents.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading incidents…</p>
            ) : incidents.isError || !incidentData ? (
              <p className="text-sm text-yellow-400">Incident status unavailable.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  {(["open", "investigating", "mitigated", "resolved"] as const).map((k) => (
                    <div key={k} className="rounded-md border border-border p-3 text-center">
                      <p className="text-2xl font-semibold">{incidentData[k]}</p>
                      <Badge className={statusColors[k]}>{k}</Badge>
                    </div>
                  ))}
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-medium text-muted-foreground">Recent incidents</h3>
                  {incidentData.recent.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No incidents recorded.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Title</TableHead>
                          <TableHead>Severity</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Opened</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {incidentData.recent.map((inc) => (
                          <TableRow key={inc.id}>
                            <TableCell className="font-medium">{inc.title}</TableCell>
                            <TableCell>
                              <Badge className={severityColors[inc.severity] ?? ""}>{inc.severity}</Badge>
                            </TableCell>
                            <TableCell>
                              <Badge className={statusColors[inc.status] ?? ""}>{inc.status}</Badge>
                            </TableCell>
                            <TableCell>{fmtDate(inc.openedAt)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Access review */}
        <Card>
          <CardHeader>
            <CardTitle>Access Review</CardTitle>
          </CardHeader>
          <CardContent>
            {accessReview.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading access review…</p>
            ) : accessReview.isError || !accessReview.data ? (
              <p className="text-sm text-yellow-400">Access review unavailable.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Last login</TableHead>
                    <TableHead>Active sessions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accessReview.data.map((u) => (
                    <TableRow key={u.userId}>
                      <TableCell className="font-medium">{u.name}</TableCell>
                      <TableCell>{u.phone}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{u.role}</Badge>
                      </TableCell>
                      <TableCell>{fmtDate(u.lastLoginAt)}</TableCell>
                      <TableCell>{u.activeSessions}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* W20: anomaly detection over the audit stream */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Anomaly Detection</span>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50"
                disabled={anomalyScan.isPending}
                onClick={() => anomalyScan.mutate({})}
              >
                {anomalyScan.isPending ? "Scanning…" : "Run scan"}
              </button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {anomalyScan.data?.baselineBuilding && (
              <p className="text-sm text-muted-foreground">
                Baseline building ({anomalyScan.data.baselineEvents} events collected) — alerts activate once enough history exists.
              </p>
            )}
            {anomalyAlertsQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading anomaly alerts…</p>
            ) : anomalyAlertsQuery.isError || !anomalyAlertsQuery.data ? (
              <p className="text-sm text-yellow-400">Anomaly alerts unavailable.</p>
            ) : anomalyAlertsQuery.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">No anomaly alerts.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Signal</TableHead>
                    <TableHead>Score</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {anomalyAlertsQuery.data.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium">{a.signal}</TableCell>
                      <TableCell>{a.score.toFixed(2)}</TableCell>
                      <TableCell>
                        <Badge className={anomalyStatusColors[a.status] ?? ""}>{a.status}</Badge>
                      </TableCell>
                      <TableCell>{fmtDate(a.createdAt)}</TableCell>
                      <TableCell className="space-x-2">
                        {a.status === "open" && (
                          <>
                            <button
                              type="button"
                              className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent"
                              onClick={() => updateAnomalyAlert.mutate({ alertId: a.id, status: "acknowledged" })}
                            >
                              Ack
                            </button>
                            <button
                              type="button"
                              className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent"
                              onClick={() => updateAnomalyAlert.mutate({ alertId: a.id, status: "dismissed" })}
                            >
                              Dismiss
                            </button>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Retention policies */}        <Card>
          <CardHeader>
            <CardTitle>Retention Policies</CardTitle>
          </CardHeader>
          <CardContent>
            {retention.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading retention policies…</p>
            ) : retention.isError || !retention.data ? (
              <p className="text-sm text-yellow-400">Retention policies unavailable.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Entity</TableHead>
                    <TableHead>Retention (days)</TableHead>
                    <TableHead>Legal hold</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {retention.data.map((p) => (
                    <TableRow key={p.entity}>
                      <TableCell className="font-medium">{p.entity}</TableCell>
                      <TableCell>{p.retentionDays}</TableCell>
                      <TableCell>
                        {p.legalHold ? (
                          <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30">legal hold</Badge>
                        ) : (
                          <Badge variant="outline">no</Badge>
                        )}
                      </TableCell>
                      <TableCell>{fmtDate(p.updatedAt)}</TableCell>
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
