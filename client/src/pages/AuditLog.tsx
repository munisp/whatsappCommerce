import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollText, RefreshCw, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { Download } from "lucide-react";
import { useState } from "react";
import { format } from "date-fns";

const EVENT_TYPES = [
  "all", "nlp_message", "order_created", "payment_initiated", "payment_confirmed",
  "escalation", "handoff", "session_reset", "tool_call",
];

const INTENT_COLORS: Record<string, string> = {
  nlp_message: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  order_created: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  payment_initiated: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  payment_confirmed: "bg-green-500/20 text-green-400 border-green-500/30",
  escalation: "bg-red-500/20 text-red-400 border-red-500/30",
  handoff: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  session_reset: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  tool_call: "bg-violet-500/20 text-violet-400 border-violet-500/30",
};

const PAGE_SIZE = 25;

export default function AuditLog() {
  const [tenantId, setTenantId] = useState("");
  const [eventType, setEventType] = useState("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [offset, setOffset] = useState(0);

  const { data, isLoading, refetch } = trpc.agent.listAuditLog.useQuery({
    tenantId: tenantId || undefined,
    eventType: eventType === "all" ? undefined : eventType,
    limit: PAGE_SIZE,
    offset,
  });

  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const handleSearch = () => {
    setSearch(searchInput);
    setOffset(0);
  };

  const handleExportCsv = () => {
    const rows = filteredEvents;
    if (rows.length === 0) return;
    const headers = ["Time", "Tenant", "Event Type", "Intent", "Confidence", "Model", "Escalated", "Conversation ID"];
    const csvRows = rows.map(e => [
      new Date(e.createdAt).toISOString(),
      e.tenantId ?? "",
      e.eventType ?? "",
      e.intentType ?? "",
      e.confidence != null ? (parseFloat(e.confidence) * 100).toFixed(1) + "%" : "",
      e.model ?? "",
      e.escalated ? "Yes" : "No",
      e.conversationId ?? "",
    ]);
    const csvContent = [headers, ...csvRows]
      .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredEvents = search
    ? events.filter(e =>
        e.intentType?.toLowerCase().includes(search.toLowerCase()) ||
        e.tenantId?.toLowerCase().includes(search.toLowerCase()) ||
        e.conversationId?.toLowerCase().includes(search.toLowerCase())
      )
    : events;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <ScrollText className="w-6 h-6 text-primary" />
              Agent Audit Log
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Full history of NLP events, intents, and agent interactions across all tenants
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
            <RefreshCw className="w-4 h-4" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={filteredEvents.length === 0} className="gap-2">
            <Download className="w-4 h-4" /> Export CSV
          </Button>
        </div>

        {/* Filters */}
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-muted-foreground mb-1 block">Tenant ID</label>
                <Input
                  placeholder="Filter by tenant…"
                  value={tenantId}
                  onChange={e => { setTenantId(e.target.value); setOffset(0); }}
                  className="h-8 text-sm"
                />
              </div>
              <div className="w-48">
                <label className="text-xs text-muted-foreground mb-1 block">Event Type</label>
                <Select value={eventType} onValueChange={v => { setEventType(v); setOffset(0); }}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {EVENT_TYPES.map(t => (
                      <SelectItem key={t} value={t} className="capitalize">{t === "all" ? "All Events" : t.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-muted-foreground mb-1 block">Search</label>
                <div className="flex gap-2">
                  <Input
                    placeholder="intent, tenant, conversation…"
                    value={searchInput}
                    onChange={e => setSearchInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleSearch()}
                    className="h-8 text-sm"
                  />
                  <Button size="sm" variant="outline" className="h-8 px-3" onClick={handleSearch}>
                    <Search className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stats bar */}
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span>{total} total events</span>
          {eventType !== "all" && <Badge variant="outline" className="capitalize">{eventType.replace(/_/g, " ")}</Badge>}
          {tenantId && <Badge variant="outline" className="font-mono text-xs">{tenantId}</Badge>}
        </div>

        {/* Table */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Events</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-3">
                {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-12" />)}
              </div>
            ) : filteredEvents.length === 0 ? (
              <div className="text-center text-muted-foreground py-16">
                <ScrollText className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm">No events found</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="text-left px-4 py-3">Time</th>
                      <th className="text-left px-4 py-3">Tenant</th>
                      <th className="text-left px-4 py-3">Event Type</th>
                      <th className="text-left px-4 py-3">Intent</th>
                      <th className="text-left px-4 py-3">Confidence</th>
                      <th className="text-left px-4 py-3">Model</th>
                      <th className="text-left px-4 py-3">Escalated</th>
                      <th className="text-left px-4 py-3">Conversation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEvents.map(event => {
                      const conf = event.confidence ? parseFloat(event.confidence) : null;
                      const confPct = conf != null ? Math.round(conf * 100) : null;
                      return (
                        <tr key={event.id} className="border-b border-border/50 hover:bg-accent/20">
                          <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                            {format(new Date(event.createdAt), "MMM d, HH:mm:ss")}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-muted-foreground max-w-[120px] truncate">
                            {event.tenantId ?? "—"}
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="outline" className={`text-xs ${INTENT_COLORS[event.eventType] ?? "bg-muted text-muted-foreground"}`}>
                              {event.eventType?.replace(/_/g, " ")}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-xs capitalize">
                            {event.intentType?.replace(/_/g, " ") ?? "—"}
                          </td>
                          <td className="px-4 py-3">
                            {confPct != null ? (
                              <div className="flex items-center gap-2">
                                <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full ${confPct >= 80 ? "bg-green-500" : confPct >= 50 ? "bg-amber-500" : "bg-red-500"}`}
                                    style={{ width: `${confPct}%` }}
                                  />
                                </div>
                                <span className="text-xs text-muted-foreground">{confPct}%</span>
                              </div>
                            ) : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">{event.model ?? "—"}</td>
                          <td className="px-4 py-3">
                            {event.escalated ? (
                              <Badge variant="outline" className="text-xs bg-red-500/20 text-red-400 border-red-500/30">Yes</Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">No</span>
                            )}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-muted-foreground max-w-[100px] truncate">
                            {event.conversationId?.slice(0, 8) ?? "—"}
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

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Page {currentPage} of {totalPages} · {total} events
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0}
                className="gap-1"
              >
                <ChevronLeft className="w-4 h-4" /> Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= total}
                className="gap-1"
              >
                Next <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
