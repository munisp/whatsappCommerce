import { useState, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Bell, Check, CheckCheck, Package, Lock, AlertTriangle, DollarSign, Truck, RotateCcw, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type NotifType = "escrow_held" | "delivery_confirmed" | "escrow_settled" | "escrow_refunded" | "dispute_opened" | "dispute_resolved" | "withdrawal_processed" | "shipment_update" | "system";

const NOTIF_ICONS: Record<NotifType, React.ElementType> = {
  escrow_held: Lock,
  delivery_confirmed: Package,
  escrow_settled: DollarSign,
  escrow_refunded: RotateCcw,
  dispute_opened: AlertTriangle,
  dispute_resolved: CheckCheck,
  withdrawal_processed: DollarSign,
  shipment_update: Truck,
  system: Info,
};

const NOTIF_COLORS: Record<NotifType, string> = {
  escrow_held: "text-blue-400",
  delivery_confirmed: "text-green-400",
  escrow_settled: "text-emerald-400",
  escrow_refunded: "text-orange-400",
  dispute_opened: "text-red-400",
  dispute_resolved: "text-green-400",
  withdrawal_processed: "text-emerald-400",
  shipment_update: "text-sky-400",
  system: "text-muted-foreground",
};

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

export default function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();

  const { data: unreadData } = trpc.notifications.getUnreadCount.useQuery(undefined, {
    refetchInterval: 30000, // poll every 30s for new notifications
  });
  const { data: listData, isLoading } = trpc.notifications.list.useQuery(
    { limit: 30, unreadOnly: false },
    { enabled: open }
  );

  const markRead = trpc.notifications.markRead.useMutation({
    onSuccess: () => {
      utils.notifications.getUnreadCount.invalidate();
      utils.notifications.list.invalidate();
    },
  });

  const markAllRead = trpc.notifications.markAllRead.useMutation({
    onSuccess: () => {
      utils.notifications.getUnreadCount.invalidate();
      utils.notifications.list.invalidate();
    },
  });

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const unreadCount = unreadData?.count ?? 0;
  const notifications = listData?.items ?? [];

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell trigger */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative h-9 w-9 flex items-center justify-center rounded-lg hover:bg-accent/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4 text-muted-foreground" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 h-4 w-4 flex items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white leading-none">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          className="absolute right-0 top-11 z-50 w-80 rounded-xl border border-border bg-card shadow-xl"
          style={{ animation: "fadeInDown 150ms cubic-bezier(0.23,1,0.32,1)" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">Notifications</span>
              {unreadCount > 0 && (
                <Badge variant="secondary" className="text-[10px] h-4 px-1.5">{unreadCount} new</Badge>
              )}
            </div>
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => markAllRead.mutate()}
                disabled={markAllRead.isPending}
              >
                <CheckCheck className="h-3 w-3 mr-1" />
                Mark all read
              </Button>
            )}
          </div>

          {/* List */}
          <ScrollArea className="max-h-[420px]">
            {isLoading ? (
              <div className="flex items-center justify-center py-10 text-muted-foreground text-sm">
                Loading…
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
                <Bell className="h-8 w-8 opacity-30" />
                <span className="text-sm">No notifications yet</span>
              </div>
            ) : (
              <div className="py-1">
                {notifications.map((n, idx) => {
                  const Icon = NOTIF_ICONS[n.type as NotifType] ?? Info;
                  const color = NOTIF_COLORS[n.type as NotifType] ?? "text-muted-foreground";
                  return (
                    <div key={n.id}>
                      <button
                        className={cn(
                          "w-full text-left px-4 py-3 flex gap-3 hover:bg-accent/40 transition-colors",
                          !n.read && "bg-accent/20"
                        )}
                        onClick={() => {
                          if (!n.read) markRead.mutate({ id: n.id });
                        }}
                      >
                        <div className={cn("mt-0.5 shrink-0", color)}>
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className={cn("text-xs font-medium leading-snug", !n.read && "text-foreground", n.read && "text-muted-foreground")}>
                              {n.title}
                            </p>
                            {!n.read && (
                              <span className="mt-1 h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5 leading-snug line-clamp-2">{n.body}</p>
                          <p className="text-[10px] text-muted-foreground/60 mt-1">{formatRelativeTime(n.createdAt)}</p>
                        </div>
                      </button>
                      {idx < notifications.length - 1 && <Separator className="opacity-30" />}
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </div>
      )}

      <style>{`
        @keyframes fadeInDown {
          from { opacity: 0; transform: translateY(-6px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
