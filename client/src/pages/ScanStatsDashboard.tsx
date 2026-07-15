import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart2, MapPin, TrendingUp, AlertTriangle, CheckCircle, Camera } from "lucide-react";

function AccuracyBar({ pct }: { pct: number }) {
  const color = pct >= 85 ? "bg-green-500" : pct >= 65 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-muted rounded-full h-2">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="text-xs font-mono w-12 text-right">{pct.toFixed(1)}%</span>
    </div>
  );
}

export default function ScanStatsDashboard() {
  const [days, setDays] = useState(30);
  const { data: stats, isLoading, refetch } = trpc.visualInventory.scanStats.useQuery({ days });

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <BarChart2 className="h-6 w-6 text-primary" />
              Scan Accuracy Dashboard
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              AI detection accuracy vs operator corrections — identifies products and locations needing more training data
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={String(days)} onValueChange={v => setDays(Number(v))}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="14">Last 14 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="60">Last 60 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Refresh</Button>
          </div>
        </div>

        {isLoading && (
          <div className="text-center py-12 text-muted-foreground">Loading statistics…</div>
        )}

        {stats && (
          <>
            {/* Summary KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Camera className="h-4 w-4 text-blue-500" />
                    <span className="text-xs text-muted-foreground">Total Scans</span>
                  </div>
                  <div className="text-3xl font-bold">{stats.totalScans}</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2 mb-1">
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    <span className="text-xs text-muted-foreground">Applied to Inventory</span>
                  </div>
                  <div className="text-3xl font-bold">{stats.appliedSessions}</div>
                  <div className="text-xs text-muted-foreground">
                    {stats.totalScans > 0 ? ((stats.appliedSessions / stats.totalScans) * 100).toFixed(0) : 0}% of scans
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2 mb-1">
                    <AlertTriangle className="h-4 w-4 text-yellow-500" />
                    <span className="text-xs text-muted-foreground">Corrections Made</span>
                  </div>
                  <div className="text-3xl font-bold">{stats.totalCorrections}</div>
                  <div className="text-xs text-muted-foreground">operator count fixes</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2 mb-1">
                    <TrendingUp className="h-4 w-4 text-purple-500" />
                    <span className="text-xs text-muted-foreground">Locations Scanned</span>
                  </div>
                  <div className="text-3xl font-bold">{stats.locationStats.length}</div>
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Per-location accuracy */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-blue-500" />
                    Accuracy by Location
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {stats.locationStats.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground text-sm">
                      No scan data yet. Start scanning with a location name set.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {stats.locationStats
                        .sort((a, b) => (a.accuracyPct ?? 100) - (b.accuracyPct ?? 100))
                        .map((loc) => (
                          <div key={loc.location}>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-sm font-medium truncate max-w-[180px]">{loc.location}</span>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <span>{loc.scans} scan{loc.scans !== 1 ? "s" : ""}</span>
                                <span>·</span>
                                <span>{loc.corrections} correction{loc.corrections !== 1 ? "s" : ""}</span>
                                {loc.accuracyPct === null && (
                                  <Badge variant="secondary" className="text-xs">No data</Badge>
                                )}
                              </div>
                            </div>
                            {loc.accuracyPct !== null && (
                              <AccuracyBar pct={loc.accuracyPct} />
                            )}
                          </div>
                        ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Per-product accuracy heatmap */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-yellow-500" />
                    Products Needing More Training Data
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {stats.productAccuracy.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground text-sm">
                      No corrections recorded yet. Use "Correct this count" in scan history to build accuracy data.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {stats.productAccuracy.slice(0, 10).map((p) => (
                        <div key={p.label}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium truncate max-w-[180px]">{p.label}</span>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>AI: {p.aiCount}</span>
                              <span>→</span>
                              <span>Actual: {p.correctedCount}</span>
                              <Badge
                                variant={p.accuracyPct >= 85 ? "default" : p.accuracyPct >= 65 ? "secondary" : "destructive"}
                                className="text-xs"
                              >
                                {p.accuracyPct.toFixed(0)}%
                              </Badge>
                            </div>
                          </div>
                          <AccuracyBar pct={p.accuracyPct} />
                        </div>
                      ))}
                      {stats.productAccuracy.length > 10 && (
                        <p className="text-xs text-muted-foreground text-center pt-2">
                          + {stats.productAccuracy.length - 10} more products
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Daily scan trend */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-green-500" />
                  Daily Scan Activity (last {days} days)
                </CardTitle>
              </CardHeader>
              <CardContent>
                {stats.dailyTrend.length === 0 ? (
                  <div className="text-center py-6 text-muted-foreground text-sm">No scan activity in this period.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-2 font-medium text-muted-foreground">Date</th>
                          <th className="text-right py-2 font-medium text-muted-foreground">Scans</th>
                          <th className="text-right py-2 font-medium text-muted-foreground">Corrections</th>
                          <th className="text-left py-2 font-medium text-muted-foreground pl-4">Activity</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.dailyTrend.slice(-14).map((d) => {
                          const maxScans = Math.max(...stats.dailyTrend.map(x => x.scans), 1);
                          return (
                            <tr key={d.date} className="border-b last:border-0">
                              <td className="py-2 font-mono text-xs">{d.date}</td>
                              <td className="py-2 text-right">{d.scans}</td>
                              <td className="py-2 text-right text-yellow-600">{d.corrections}</td>
                              <td className="py-2 pl-4">
                                <div className="flex gap-1">
                                  <div
                                    className="h-4 bg-blue-500 rounded-sm"
                                    style={{ width: `${(d.scans / maxScans) * 120}px` }}
                                    title={`${d.scans} scans`}
                                  />
                                  {d.corrections > 0 && (
                                    <div
                                      className="h-4 bg-yellow-500 rounded-sm"
                                      style={{ width: `${(d.corrections / maxScans) * 60}px` }}
                                      title={`${d.corrections} corrections`}
                                    />
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Training readiness */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Fine-tuning Readiness</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <div className="flex justify-between text-sm mb-1">
                      <span>Corrections collected</span>
                      <span className="font-mono">{stats.totalCorrections} / 50 threshold</span>
                    </div>
                    <div className="bg-muted rounded-full h-3">
                      <div
                        className={`h-3 rounded-full ${stats.totalCorrections >= 50 ? "bg-green-500" : "bg-blue-500"}`}
                        style={{ width: `${Math.min(100, (stats.totalCorrections / 50) * 100)}%` }}
                      />
                    </div>
                  </div>
                  <Badge variant={stats.totalCorrections >= 50 ? "default" : "secondary"} className="whitespace-nowrap">
                    {stats.totalCorrections >= 50 ? "✓ Ready to fine-tune" : `${50 - stats.totalCorrections} more needed`}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  The weekly heartbeat job runs every Sunday at 03:00 UTC and automatically triggers YOLO fine-tuning when ≥50 corrections have accumulated.
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
