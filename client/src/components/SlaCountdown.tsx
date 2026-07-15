import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Clock, AlertTriangle, CheckCircle2, Timer } from "lucide-react";

type SlaStatus = "ok" | "warning" | "overdue" | "no_deadline";

interface CountdownState {
  hours: number;
  minutes: number;
  seconds: number;
  totalSeconds: number;
  isExpired: boolean;
}

function computeCountdown(slaDeadline: string | Date | null | undefined): CountdownState {
  if (!slaDeadline) return { hours: 0, minutes: 0, seconds: 0, totalSeconds: 0, isExpired: false };
  const diff = Math.max(0, new Date(slaDeadline).getTime() - Date.now());
  const totalSeconds = Math.floor(diff / 1000);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    totalSeconds,
    isExpired: diff === 0,
  };
}

function computeStatus(slaDeadline: string | Date | null | undefined, warningHours = 24): SlaStatus {
  if (!slaDeadline) return "no_deadline";
  const now = Date.now();
  const deadlineMs = new Date(slaDeadline).getTime();
  const warningMs = warningHours * 60 * 60 * 1000;
  if (now >= deadlineMs) return "overdue";
  if (now >= deadlineMs - warningMs) return "warning";
  return "ok";
}

interface SlaCountdownProps {
  slaDeadline: string | Date | null | undefined;
  warningHours?: number;
  /** compact: shows only badge + time; full: shows full card */
  variant?: "compact" | "full";
  label?: string;
}

export function SlaCountdown({ slaDeadline, warningHours = 24, variant = "compact", label }: SlaCountdownProps) {
  const [countdown, setCountdown] = useState<CountdownState>(() => computeCountdown(slaDeadline));
  const [status, setStatus] = useState<SlaStatus>(() => computeStatus(slaDeadline, warningHours));

  useEffect(() => {
    if (!slaDeadline) return;
    const interval = setInterval(() => {
      setCountdown(computeCountdown(slaDeadline));
      setStatus(computeStatus(slaDeadline, warningHours));
    }, 1000);
    return () => clearInterval(interval);
  }, [slaDeadline, warningHours]);

  if (status === "no_deadline") {
    return (
      <Badge variant="outline" className="text-muted-foreground gap-1">
        <Timer className="h-3 w-3" /> No deadline set
      </Badge>
    );
  }

  const statusConfig = {
    ok: {
      color: "text-green-600",
      bg: "bg-green-50 border-green-200",
      badgeClass: "bg-green-100 text-green-700 border-green-200",
      icon: CheckCircle2,
      label: "On track",
    },
    warning: {
      color: "text-amber-600",
      bg: "bg-amber-50 border-amber-200",
      badgeClass: "bg-amber-100 text-amber-700 border-amber-200",
      icon: AlertTriangle,
      label: "Deadline approaching",
    },
    overdue: {
      color: "text-red-600",
      bg: "bg-red-50 border-red-200",
      badgeClass: "bg-red-100 text-red-700 border-red-200",
      icon: AlertTriangle,
      label: "Overdue",
    },
    no_deadline: {
      color: "text-muted-foreground",
      bg: "bg-muted/30",
      badgeClass: "",
      icon: Timer,
      label: "No deadline",
    },
  };

  const cfg = statusConfig[status];
  const Icon = cfg.icon;

  const timeStr = countdown.isExpired
    ? "Expired"
    : `${String(countdown.hours).padStart(2, "0")}:${String(countdown.minutes).padStart(2, "0")}:${String(countdown.seconds).padStart(2, "0")}`;

  if (variant === "compact") {
    return (
      <span className={`inline-flex items-center gap-1.5 text-sm font-mono font-medium ${cfg.color}`}>
        <Clock className="h-3.5 w-3.5" />
        {timeStr}
        {status !== "ok" && (
          <Badge variant="outline" className={`text-xs ml-1 ${cfg.badgeClass}`}>
            {cfg.label}
          </Badge>
        )}
      </span>
    );
  }

  // Full card variant
  return (
    <div className={`rounded-lg border p-4 ${cfg.bg}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 ${cfg.color}`} />
          <span className={`text-sm font-medium ${cfg.color}`}>{label ?? "Escrow Release Deadline"}</span>
        </div>
        <Badge variant="outline" className={cfg.badgeClass}>{cfg.label}</Badge>
      </div>
      <div className={`text-3xl font-mono font-bold tracking-wider ${cfg.color}`}>
        {timeStr}
      </div>
      {slaDeadline && (
        <p className="text-xs text-muted-foreground mt-1">
          Deadline: {new Date(slaDeadline).toLocaleString()}
        </p>
      )}
    </div>
  );
}

export default SlaCountdown;

