// === W55 ui-b ===
/**
 * Cashflow — read-only cash-flow forecast dashboard (W33 `cashflow` router).
 * Summary cards (starting balance, inflow, outflow, net, shortfall date) plus
 * the per-line projection table and recent cron snapshots. Honest "No data
 * yet" empty state when the tenant has no financial rows.
 */
import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { useActiveTenant } from "@/contexts/TenantContext";
import { TrendingUp, TrendingDown, Wallet, AlertTriangle, CalendarDays } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { formatCents, formatDate } from "@/lib/b2bLogic";

export default function Cashflow() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const [horizon, setHorizon] = useState<"30" | "60" | "90">("30");

  const forecastQ = trpc.cashflow.forecast.useQuery(
    { tenantId, horizonDays: Number(horizon) as 30 | 60 | 90 },
    { enabled: !!tenantId },
  );
  const snapshotsQ = trpc.cashflow.snapshots.useQuery({ tenantId, limit: 10 }, { enabled: !!tenantId });

  const f = forecastQ.data;
  const empty = !f || f.empty;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Cash-flow Forecast</h1>
            <p className="text-muted-foreground text-sm mt-1">Projection from real scheduled payments, bills, invoices & wallet history</p>
          </div>
          <Select value={horizon} onValueChange={(v) => setHorizon(v as "30" | "60" | "90")}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="30">30 days</SelectItem>
              <SelectItem value="60">60 days</SelectItem>
              <SelectItem value="90">90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {forecastQ.isLoading ? (
          <p className="text-muted-foreground text-sm text-center py-10">Computing forecast…</p>
        ) : empty ? (
          <Card>
            <CardContent className="p-10 text-center">
              <CalendarDays className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
              <p className="font-medium">No data yet</p>
              <p className="text-sm text-muted-foreground mt-1">Once you have wallet activity, bills or invoices, the forecast appears here.</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <Card><CardContent className="p-4 flex flex-col gap-1">
                <Wallet className="h-4 w-4 text-muted-foreground" />
                <p className="text-xl font-bold">{formatCents(f.startingBalanceCents, f.currency)}</p>
                <p className="text-xs text-muted-foreground">Starting balance</p>
              </CardContent></Card>
              <Card><CardContent className="p-4 flex flex-col gap-1">
                <TrendingUp className="h-4 w-4 text-green-500" />
                <p className="text-xl font-bold text-green-500">{formatCents(f.inflowCents, f.currency)}</p>
                <p className="text-xs text-muted-foreground">Expected inflow</p>
              </CardContent></Card>
              <Card><CardContent className="p-4 flex flex-col gap-1">
                <TrendingDown className="h-4 w-4 text-red-500" />
                <p className="text-xl font-bold text-red-500">{formatCents(f.outflowCents, f.currency)}</p>
                <p className="text-xs text-muted-foreground">Expected outflow</p>
              </CardContent></Card>
              <Card><CardContent className="p-4 flex flex-col gap-1">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                <p className={`text-xl font-bold ${f.netCents < 0 ? "text-red-500" : ""}`}>{formatCents(f.netCents, f.currency)}</p>
                <p className="text-xs text-muted-foreground">Net ({f.horizonDays}d)</p>
              </CardContent></Card>
              <Card><CardContent className="p-4 flex flex-col gap-1">
                <AlertTriangle className={`h-4 w-4 ${f.shortfallAt ? "text-red-500" : "text-muted-foreground"}`} />
                <p className={`text-xl font-bold ${f.shortfallAt ? "text-red-500" : ""}`}>{f.shortfallAt ? formatDate(f.shortfallAt) : "None"}</p>
                <p className="text-xs text-muted-foreground">Projected shortfall</p>
              </CardContent></Card>
            </div>

            {!!f.skippedCurrencies?.length && (
              <p className="text-xs text-muted-foreground">Skipped currencies (never mixed into {f.currency} totals): {f.skippedCurrencies.join(", ")}</p>
            )}

            <Card>
              <CardHeader><CardTitle className="text-base">Projection lines ({f.horizonDays} days)</CardTitle></CardHeader>
              <CardContent className="p-0">
                {!f.lines.length ? (
                  <p className="text-muted-foreground text-sm text-center py-8">No projected movements in this horizon.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>Date</TableHead><TableHead>Kind</TableHead><TableHead>Note</TableHead><TableHead className="text-right">Amount</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {f.lines.map((l, i) => (
                        <TableRow key={`${l.sourceId}-${i}`}>
                          <TableCell>{formatDate(l.date)}</TableCell>
                          <TableCell><Badge variant={l.direction === "inflow" ? "default" : "secondary"} className="capitalize">{l.kind.replace(/_/g, " ")}</Badge></TableCell>
                          <TableCell className="text-xs text-muted-foreground">{l.note ?? "—"}</TableCell>
                          <TableCell className={`text-right font-medium ${l.direction === "inflow" ? "text-green-500" : "text-red-500"}`}>
                            {l.direction === "inflow" ? "+" : "−"}{formatCents(l.amountCents, f.currency)}
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

        {(snapshotsQ.data?.length ?? 0) > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">Recent snapshots (weekly cron)</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>Generated</TableHead><TableHead>Horizon</TableHead><TableHead className="text-right">Inflow</TableHead><TableHead className="text-right">Outflow</TableHead><TableHead className="text-right">Net</TableHead><TableHead>Shortfall</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {snapshotsQ.data!.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>{formatDate(s.generatedAt)}</TableCell>
                      <TableCell>{s.horizonDays}d</TableCell>
                      <TableCell className="text-right text-green-500">{formatCents(s.inflowCents, s.currency)}</TableCell>
                      <TableCell className="text-right text-red-500">{formatCents(s.outflowCents, s.currency)}</TableCell>
                      <TableCell className="text-right font-medium">{formatCents(s.netCents, s.currency)}</TableCell>
                      <TableCell>{s.shortfallAt ? formatDate(s.shortfallAt) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
// === END W55 ui-b ===
