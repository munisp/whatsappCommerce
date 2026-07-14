import { trpc } from "@/lib/trpc";
import {
  CircleDollarSign, Lock, PackageCheck, Send, CheckCircle, RotateCcw,
  Truck, Package, Navigation, AlertTriangle, CheckCircle2, Info, Loader2
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

type TimelineVariant = "default" | "success" | "warning" | "error" | "info";
type TimelineEventType = "escrow_state" | "logistics" | "dispute";

interface TimelineEvent {
  id: string;
  timestamp: Date;
  type: TimelineEventType;
  state?: string;
  title: string;
  description: string;
  icon: string;
  variant: TimelineVariant;
}

const ICON_MAP: Record<string, React.ElementType> = {
  "circle-dollar-sign": CircleDollarSign,
  "lock": Lock,
  "package-check": PackageCheck,
  "send": Send,
  "check-circle": CheckCircle,
  "rotate-ccw": RotateCcw,
  "truck": Truck,
  "package": Package,
  "navigation": Navigation,
  "alert-triangle": AlertTriangle,
  "check-circle-2": CheckCircle2,
};

const VARIANT_STYLES: Record<TimelineVariant, { dot: string; icon: string; badge: string }> = {
  default: { dot: "bg-muted-foreground/40 border-muted-foreground/20", icon: "text-muted-foreground", badge: "bg-muted text-muted-foreground" },
  info: { dot: "bg-blue-500/20 border-blue-500/40", icon: "text-blue-400", badge: "bg-blue-500/10 text-blue-400" },
  success: { dot: "bg-emerald-500/20 border-emerald-500/40", icon: "text-emerald-400", badge: "bg-emerald-500/10 text-emerald-400" },
  warning: { dot: "bg-orange-500/20 border-orange-500/40", icon: "text-orange-400", badge: "bg-orange-500/10 text-orange-400" },
  error: { dot: "bg-red-500/20 border-red-500/40", icon: "text-red-400", badge: "bg-red-500/10 text-red-400" },
};

const TYPE_LABELS: Record<TimelineEventType, string> = {
  escrow_state: "Escrow",
  logistics: "Logistics",
  dispute: "Dispute",
};

function formatDateTime(date: Date): string {
  return new Date(date).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

interface EscrowTimelineProps {
  escrowId: string;
  className?: string;
}

export default function EscrowTimeline({ escrowId, className }: EscrowTimelineProps) {
  const { data: events, isLoading, error } = trpc.escrow.getTimeline.useQuery({ escrowId });

  if (isLoading) {
    return (
      <div className={cn("flex items-center justify-center py-10", className)}>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !events) {
    return (
      <div className={cn("text-sm text-muted-foreground py-6 text-center", className)}>
        Could not load timeline.
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className={cn("text-sm text-muted-foreground py-6 text-center", className)}>
        No timeline events yet.
      </div>
    );
  }

  return (
    <div className={cn("relative", className)}>
      {/* Vertical line */}
      <div className="absolute left-5 top-6 bottom-6 w-px bg-border" />

      <ol className="space-y-0">
        {events.map((event, idx) => {
          const Icon = ICON_MAP[event.icon] ?? Info;
          const styles = VARIANT_STYLES[event.variant];
          const isLast = idx === events.length - 1;

          return (
            <li key={event.id} className="relative flex gap-4 pb-6 last:pb-0">
              {/* Dot + icon */}
              <div className={cn(
                "relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2",
                styles.dot
              )}>
                <Icon className={cn("h-4 w-4", styles.icon)} />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 pt-1.5">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-foreground">{event.title}</span>
                  <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded-full", styles.badge)}>
                    {TYPE_LABELS[event.type]}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{event.description}</p>
                <p className="text-[11px] text-muted-foreground/50 mt-1.5">
                  {formatDateTime(event.timestamp)}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

