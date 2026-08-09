/**
 * LimitGauge — credit-limit utilization bar (used vs limit) with muted tones:
 * <70% neutral, 70–89% amber, ≥90% red. Purely presentational; math lives in
 * b2bLogic.limitGauge (unit-tested).
 */
import { formatNaira, limitGauge } from "@/lib/b2bLogic";

const TONE_BAR: Record<string, string> = {
  ok: "bg-emerald-500/60",
  warn: "bg-amber-500/60",
  danger: "bg-red-500/60",
};
const TONE_TEXT: Record<string, string> = {
  ok: "text-emerald-400",
  warn: "text-amber-400",
  danger: "text-red-400",
};

export function LimitGauge({ used, limit, compact = false }: { used: number; limit: number; compact?: boolean }) {
  const g = limitGauge(used, limit);
  return (
    <div className="space-y-1">
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${TONE_BAR[g.tone]}`}
          style={{ width: `${Math.max(g.pct, g.pct > 0 ? 3 : 0)}%` }}
          role="progressbar"
          aria-valuenow={g.pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      <div className={`flex items-center justify-between ${compact ? "text-[11px]" : "text-xs"} text-muted-foreground`}>
        <span>
          {formatNaira(g.used)} of {formatNaira(g.limit)}
        </span>
        <span className={TONE_TEXT[g.tone]}>{g.pct}% used</span>
      </div>
    </div>
  );
}
