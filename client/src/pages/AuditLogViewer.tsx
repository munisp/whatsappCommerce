import { useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Download, Loader2, ScrollText, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

interface AuditRow {
  id: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  tenantId: string | null;
  summary: string | null;
  before: unknown;
  after: unknown;
  createdAt: string | Date;
}

function toIsoStart(date: string): string | undefined {
  return date ? new Date(`${date}T00:00:00`).toISOString() : undefined;
}
function toIsoEnd(date: string): string | undefined {
  return date ? new Date(`${date}T23:59:59.999`).toISOString() : undefined;
}

function downloadCsv(filename: string, rows: AuditRow[]) {
  const header = ["createdAt", "actorId", "actorRole", "action", "entityType", "entityId", "tenantId", "summary"];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    header.join(","),
    ...rows.map((r) =>
      [r.createdAt, r.actorId, r.actorRole, r.action, r.entityType, r.entityId, r.tenantId, r.summary]
        .map(esc)
        .join(","),
    ),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AuditLogViewer() {
  const { user } = useAuth();
  const [action, setAction] = useState<string>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const queryInput = useMemo(
    () => ({
      action: action === "all" ? undefined : action,
      from: toIsoStart(from),
      to: toIsoEnd(to),
      limit: 500,
    }),
    [action, from, to],
  );

  const { data, isLoading, error, refetch, isFetching } = trpc.audit.export.useQuery(queryInput, {
    retry: false,
  });
  const rows = (data?.rows ?? []) as AuditRow[];

  // Action filter options are derived from what the trail actually contains.
  const actionOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.action))).sort(),
    [rows],
  );

  const forbidden = (error as any)?.data?.code === "FORBIDDEN" || (user && user.role !== "admin");

  const handleExport = () => {
    if (rows.length === 0) {
      toast.error("Nothing to export — the current filter returned no rows");
      return;
    }
    downloadCsv(`audit-log-${new Date().toISOString().slice(0, 10)}.csv`, rows);
    toast.success(`Exported ${rows.length} audit rows`);
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <ScrollText className="w-6 h-6 text-primary" />
              Audit Logs
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Forensic trail of admin and money-movement actions (audit.export, admin-only).
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={handleExport}
            disabled={isLoading || rows.length === 0}
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV ({rows.length})
          </Button>
        </div>

        {forbidden ? (
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardContent className="p-8 text-center space-y-2">
              <ShieldAlert className="w-10 h-10 mx-auto text-amber-400" />
              <p className="font-semibold text-foreground">Admin access required</p>
              <p className="text-sm text-muted-foreground">
                The audit trail is restricted to platform administrators.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Filters */}
            <Card className="border-border/50 bg-card/50">
              <CardContent className="p-4 flex flex-wrap items-end gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Action</Label>
                  <Select value={action} onValueChange={setAction}>
                    <SelectTrigger className="w-[220px]">
                      <SelectValue placeholder="All actions" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All actions</SelectItem>
                      {actionOptions.map((a) => (
                        <SelectItem key={a} value={a}>{a}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">From</Label>
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[160px]" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">To</Label>
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[160px]" />
                </div>
                <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
                  {isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Apply"}
                </Button>
                {data && (
                  <span className="text-xs text-muted-foreground ml-auto">
                    {data.count} row{data.count === 1 ? "" : "s"} · exported at{" "}
                    {new Date(data.exportedAt).toLocaleTimeString()}
                  </span>
                )}
              </CardContent>
            </Card>

            {/* Table */}
            <Card className="border-border/50 bg-card/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Trail
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="p-4 space-y-3">
                    {[1, 2, 3, 4].map((i) => (
                      <div key={i} className="h-10 bg-muted/30 rounded animate-pulse" />
                    ))}
                  </div>
                ) : error ? (
                  <div className="p-8 text-center text-red-400 text-sm">
                    Failed to load audit trail: {error.message}
                  </div>
                ) : rows.length === 0 ? (
                  <div className="p-12 text-center text-muted-foreground">
                    <ScrollText className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="font-medium">No audit entries match these filters</p>
                    <p className="text-xs mt-1">Widen the date range or clear the action filter.</p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[170px]">Timestamp</TableHead>
                        <TableHead>Actor</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead>Entity</TableHead>
                        <TableHead>Details</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {new Date(r.createdAt).toLocaleString()}
                          </TableCell>
                          <TableCell>
                            <div className="text-xs">
                              <span className="text-foreground">{r.actorId ?? "system"}</span>
                              {r.actorRole && (
                                <Badge variant="outline" className="ml-1.5 text-[10px]">{r.actorRole}</Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-[10px] font-mono">{r.action}</Badge>
                          </TableCell>
                          <TableCell className="text-xs">
                            <span className="text-foreground">{r.entityType}</span>
                            {r.entityId && (
                              <span className="text-muted-foreground"> · {r.entityId.slice(0, 12)}{r.entityId.length > 12 ? "…" : ""}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[320px]">
                            <span className="line-clamp-2">{r.summary ?? "—"}</span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
