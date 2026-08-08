import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { useActiveTenant } from "@/contexts/TenantContext";
import { toast } from "sonner";
import { Gauge, Loader2, Pencil } from "lucide-react";

/** Aggregate the counter rows into the two headline metrics. */
function sumCounters(counters: Array<{ metric: string; count: number }>, prefixes: string[]): number {
  return counters
    .filter((c) => prefixes.includes(c.metric))
    .reduce((s, c) => s + c.count, 0);
}

/**
 * Current-period usage vs plan limits (metering.getUsage/getPlan/setPlan —
 * all admin-only). Rendered on the platform dashboard for admins.
 */
export default function UsagePlanWidget() {
  const { activeTenantId } = useActiveTenant();
  const tenantId = activeTenantId;
  const utils = trpc.useUtils();

  const { data: usage, isLoading: usageLoading } = trpc.metering.getUsage.useQuery({ tenantId });
  const { data: planData, isLoading: planLoading } = trpc.metering.getPlan.useQuery({ tenantId });

  const [editOpen, setEditOpen] = useState(false);
  const [tier, setTier] = useState("");
  const [msgLimit, setMsgLimit] = useState("");
  const [orderLimit, setOrderLimit] = useState("");

  const plan = planData?.plan;
  useEffect(() => {
    if (plan) {
      setTier(plan.tier);
      setMsgLimit(String(plan.limits.messagesPerMonth));
      setOrderLimit(String(plan.limits.ordersPerMonth));
    }
  }, [plan]);

  const setPlan = trpc.metering.setPlan.useMutation({
    onSuccess: () => {
      toast.success("Plan updated");
      setEditOpen(false);
      utils.metering.getPlan.invalidate({ tenantId });
    },
    onError: (e) => toast.error(e.message),
  });

  if (usageLoading || planLoading) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="p-6 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading usage…
        </CardContent>
      </Card>
    );
  }

  const counters = usage?.counters ?? [];
  const messagesUsed = sumCounters(counters, ["messages", "messages_in", "messages_out"]);
  const ordersUsed = sumCounters(counters, ["orders_created", "orders"]);
  const msgMax = plan?.limits.messagesPerMonth ?? 0;
  const ordMax = plan?.limits.ordersPerMonth ?? 0;

  const pct = (used: number, max: number) => (max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0);
  const barColor = (p: number) =>
    p >= 100 ? "[&>div]:bg-red-500" : p >= 80 ? "[&>div]:bg-amber-500" : "";

  const rows = [
    { label: "Messages", used: messagesUsed, max: msgMax },
    { label: "Orders", used: ordersUsed, max: ordMax },
  ];

  return (
    <Card className="bg-card border-border">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Gauge className="w-4 h-4" />
          Usage vs Plan — {usage?.period ?? "current period"}
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] uppercase">{plan?.tier ?? "—"}</Badge>
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setEditOpen(true)}>
            <Pencil className="w-3 h-3" />
            Edit plan
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.map((r) => (
          <div key={r.label} className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-foreground font-medium">{r.label}</span>
              <span className="text-muted-foreground">
                {r.used.toLocaleString()} / {r.max > 0 ? r.max.toLocaleString() : "unlimited"} ({pct(r.used, r.max)}%)
              </span>
            </div>
            <Progress value={pct(r.used, r.max)} className={`h-2 ${barColor(pct(r.used, r.max))}`} />
          </div>
        ))}
        <p className="text-[11px] text-muted-foreground">
          80% of the message limit warns the tenant admin; 110% gates inbound processing.
        </p>

        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit plan — {tenantId}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label>Tier name</Label>
                <Input value={tier} onChange={(e) => setTier(e.target.value)} placeholder="starter" maxLength={40} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Messages / month</Label>
                  <Input type="number" min={0} value={msgLimit} onChange={(e) => setMsgLimit(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Orders / month</Label>
                  <Input type="number" min={0} value={orderLimit} onChange={(e) => setOrderLimit(e.target.value)} />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button
                disabled={setPlan.isPending || !tier.trim()}
                onClick={() =>
                  setPlan.mutate({
                    tenantId,
                    tier: tier.trim(),
                    limits: {
                      messagesPerMonth: Math.max(0, Math.floor(Number(msgLimit) || 0)),
                      ordersPerMonth: Math.max(0, Math.floor(Number(orderLimit) || 0)),
                    },
                  })
                }
              >
                {setPlan.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save plan"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
