import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RefreshCw, XCircle, CheckCircle2, AlertCircle, Clock, Skull } from "lucide-react";
import { toast } from "sonner";

type EventStatus = "received" | "processed" | "failed" | "retried" | "dead" | "all";

const STATUS_CONFIG: Record<string, { color: string; icon: React.ElementType }> = {
  received: { color: "bg-blue-100 text-blue-800", icon: Clock },
  processed: { color: "bg-green-100 text-green-800", icon: CheckCircle2 },
  failed: { color: "bg-red-100 text-red-800", icon: AlertCircle },
  retried: { color: "bg-yellow-100 text-yellow-800", icon: RefreshCw },
  dead: { color: "bg-gray-200 text-gray-700", icon: Skull },
};

export default function WebhookDLQ() {
  const [filter, setFilter] = useState<EventStatus>("all");
  const utils = trpc.useUtils();

  const { data: stats } = trpc.webhookDlq.stats.useQuery(undefined, { refetchInterval: 15000 });
  const { data: events, refetch } = trpc.webhookDlq.listEvents.useQuery(
    { status: filter, limit: 100 },
    { refetchInterval: 30000 }
  );

  const retryEvent = trpc.webhookDlq.retryEvent.useMutation({
    onSuccess: () => { toast.success("Event queued for retry"); utils.webhookDlq.listEvents.invalidate(); utils.webhookDlq.stats.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const dismissEvent = trpc.webhookDlq.dismissEvent.useMutation({
    onSuccess: () => { toast.success("Event dismissed"); utils.webhookDlq.listEvents.invalidate(); utils.webhookDlq.stats.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Webhook Dead-Letter Queue</h1>
            <p className="text-gray-500 text-sm mt-1">Monitor, retry, and dismiss failed WhatsApp webhook events</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="w-4 h-4 mr-1" />Refresh
          </Button>
        </div>

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {(["received", "processed", "failed", "retried", "dead"] as const).map((s) => {
              const cfg = STATUS_CONFIG[s];
              const Icon = cfg.icon;
              return (
                <Card key={s} className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setFilter(s)}>
                  <CardContent className="pt-3 pb-3">
                    <div className="flex items-center gap-2">
                      <Icon className="w-5 h-5 text-gray-500" />
                      <div>
                        <p className="text-xl font-bold">{stats[s]}</p>
                        <p className="text-xs text-gray-500 capitalize">{s}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-3">
          <Select value={filter} onValueChange={(v) => setFilter(v as EventStatus)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Events</SelectItem>
              <SelectItem value="received">Received</SelectItem>
              <SelectItem value="processed">Processed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="retried">Retried</SelectItem>
              <SelectItem value="dead">Dead</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-sm text-gray-500">{(events ?? []).length} events</span>
        </div>

        <div className="space-y-2">
          {(events ?? []).length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <CheckCircle2 className="w-10 h-10 mx-auto mb-2 text-green-400" />
              <p>No events in this category.</p>
            </div>
          )}
          {(events ?? []).map((event) => {
            const cfg = STATUS_CONFIG[event.status] ?? STATUS_CONFIG.received;
            const Icon = cfg.icon;
            return (
              <Card key={event.id} className="border-l-4" style={{ borderLeftColor: event.status === "dead" ? "#6b7280" : event.status === "failed" ? "#ef4444" : event.status === "processed" ? "#22c55e" : "#3b82f6" }}>
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge className={cfg.color}>
                          <Icon className="w-3 h-3 mr-1" />{event.status}
                        </Badge>
                        <span className="text-xs text-gray-500">{event.messageType ?? "unknown"}</span>
                        <span className="text-xs text-gray-400">{new Date(event.createdAt).toLocaleString()}</span>
                      </div>
                      <p className="text-sm font-medium truncate">
                        {event.waPhoneNumber ? `From: ${event.waPhoneNumber}` : `ID: ${event.id.slice(0, 8)}...`}
                      </p>
                      {event.lastError && (
                        <p className="text-xs text-red-600 mt-1 truncate">Error: {event.lastError}</p>
                      )}
                      <p className="text-xs text-gray-400">Retries: {event.retryCount}</p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {(event.status === "failed" || event.status === "dead") && (
                        <Button size="sm" variant="outline" onClick={() => retryEvent.mutate({ id: event.id })} disabled={retryEvent.isPending}>
                          <RefreshCw className="w-3 h-3 mr-1" />Retry
                        </Button>
                      )}
                      {event.status !== "dead" && event.status !== "processed" && (
                        <Button size="sm" variant="outline" className="text-gray-500" onClick={() => dismissEvent.mutate({ id: event.id })} disabled={dismissEvent.isPending}>
                          <XCircle className="w-3 h-3 mr-1" />Dismiss
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </DashboardLayout>
  );
}
