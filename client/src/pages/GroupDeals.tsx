/**
 * W27 — Group buying portal page: merchant deal management with LIVE
 * progress bars (polled), participant list, cancel; plus a customer-style
 * join-by-link preview using the public procedures.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Users, Clock, Plus } from "lucide-react";
import { toast } from "sonner";

const TENANT_ID = "default";

function fmt(cents: number, currency = "NGN") {
  return `${currency} ${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="w-full bg-gray-200 rounded h-3">
      <div className="bg-green-500 h-3 rounded transition-all" style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  );
}

const statusColor = (s: string) =>
  s === "confirmed" || s === "fulfilled"
    ? "bg-green-100 text-green-800"
    : s === "open"
      ? "bg-blue-100 text-blue-800"
      : s === "expired" || s === "cancelled"
        ? "bg-red-100 text-red-800"
        : "bg-gray-100 text-gray-700";

export default function GroupDeals() {
  const [form, setForm] = useState({
    title: "", unitPriceCents: "", retailPriceCents: "", thresholdQty: "", deadlineHours: "72",
  });
  const [selectedDeal, setSelectedDeal] = useState<string | null>(null);
  const [joinPhone, setJoinPhone] = useState("");
  const [joinQty, setJoinQty] = useState("1");

  // Live progress: poll every 5s while the page is open.
  const { data: deals, refetch } = trpc.groupBuy.listDeals.useQuery(
    { tenantId: TENANT_ID },
    { refetchInterval: 5000 },
  );
  const { data: detail } = trpc.groupBuy.dealDetail.useQuery(
    { tenantId: TENANT_ID, dealId: selectedDeal! },
    { enabled: !!selectedDeal, refetchInterval: 5000 },
  );

  const createDeal = trpc.groupBuy.createDeal.useMutation({
    onSuccess: () => { toast.success("Deal opened"); refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const cancelDeal = trpc.groupBuy.cancelDeal.useMutation({
    onSuccess: () => { toast.success("Deal cancelled — holds refunded/voided"); refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const sweep = trpc.groupBuy.sweep.useMutation({
    onSuccess: (r) => { toast.success(`Sweep: ${r.confirmed} confirmed, ${r.expired} expired`); refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const joinDeal = trpc.groupBuy.joinDeal.useMutation({
    onSuccess: () => { toast.success("Joined deal (hold placed)"); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Group Deals</h1>
          <p className="text-gray-500 text-sm mt-1">Bulk discount unlocked at the quantity threshold before the deadline</p>
        </div>
        <Button variant="outline" onClick={() => sweep.mutate({ tenantId: TENANT_ID })} disabled={sweep.isPending}>
          Run deadline sweep
        </Button>
      </div>

      <Card>
        <CardContent className="pt-4 space-y-2">
          <p className="font-semibold flex items-center gap-2"><Plus className="h-4 w-4" /> Open a group deal</p>
          <Input placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <div className="flex gap-2 flex-wrap">
            <Input className="w-40" placeholder="Bulk price (cents)" value={form.unitPriceCents}
              onChange={(e) => setForm({ ...form, unitPriceCents: e.target.value })} />
            <Input className="w-40" placeholder="Retail price (cents)" value={form.retailPriceCents}
              onChange={(e) => setForm({ ...form, retailPriceCents: e.target.value })} />
            <Input className="w-32" placeholder="Threshold qty" value={form.thresholdQty}
              onChange={(e) => setForm({ ...form, thresholdQty: e.target.value })} />
            <Input className="w-32" placeholder="Hours" value={form.deadlineHours}
              onChange={(e) => setForm({ ...form, deadlineHours: e.target.value })} />
          </div>
          <Button size="sm" disabled={createDeal.isPending}
            onClick={() => createDeal.mutate({
              tenantId: TENANT_ID,
              title: form.title,
              unitPriceCents: parseInt(form.unitPriceCents, 10) || 0,
              retailPriceCents: form.retailPriceCents ? parseInt(form.retailPriceCents, 10) : undefined,
              thresholdQty: parseInt(form.thresholdQty, 10) || 0,
              deadline: new Date(Date.now() + (parseInt(form.deadlineHours, 10) || 72) * 3600_000),
            })}>
            Open deal
          </Button>
        </CardContent>
      </Card>

      {(deals ?? []).map((d) => {
        const pct = d.thresholdQty > 0 ? Math.min(100, Math.round((d.currentQty / d.thresholdQty) * 100)) : 100;
        return (
          <Card key={d.id} className="cursor-pointer" onClick={() => setSelectedDeal(d.id)}>
            <CardContent className="pt-4 space-y-2">
              <div className="flex items-center justify-between">
                <p className="font-semibold">{d.title}</p>
                <Badge className={statusColor(d.status)}>{d.status}</Badge>
              </div>
              <ProgressBar percent={pct} />
              <p className="text-sm text-gray-500">
                {d.currentQty}/{d.thresholdQty} units ({pct}%) · {fmt(d.unitPriceCents, d.currency)}/unit
                {d.retailPriceCents ? ` (retail ${fmt(d.retailPriceCents, d.currency)})` : ""}
              </p>
              <p className="text-xs text-gray-400 flex items-center gap-1">
                <Clock className="h-3 w-3" /> Deadline {new Date(d.deadline).toLocaleString()} ·
                Share: <code>join {d.id.slice(0, 8)} &lt;qty&gt;</code>
              </p>
              {d.status === "open" && (
                <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" variant="outline" disabled={cancelDeal.isPending}
                    onClick={() => cancelDeal.mutate({ tenantId: TENANT_ID, dealId: d.id })}>
                    Cancel deal
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
      {(deals ?? []).length === 0 && <p className="text-gray-400 text-sm text-center py-8">No deals yet.</p>}

      {detail && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <p className="font-semibold flex items-center gap-2">
              <Users className="h-4 w-4" /> {detail.deal.title} — participants ({detail.participants.length})
            </p>
            {detail.progress && <ProgressBar percent={detail.progress.percent} />}
            {detail.participants.map((p) => (
              <div key={p.id} className="flex items-center justify-between text-sm border-b py-1">
                <span>{p.customerPhone} · {p.quantity} unit(s) · {fmt(p.amountCents, p.currency)}</span>
                <Badge className={statusColor(p.status)}>{p.status}</Badge>
              </div>
            ))}
            {detail.deal.status === "open" && (
              <div className="flex gap-2 items-center pt-2">
                <Input className="w-40" placeholder="+234… phone" value={joinPhone}
                  onChange={(e) => setJoinPhone(e.target.value)} />
                <Input className="w-24" placeholder="Qty" value={joinQty}
                  onChange={(e) => setJoinQty(e.target.value)} />
                <Button size="sm" disabled={joinDeal.isPending}
                  onClick={() => joinDeal.mutate({
                    dealId: detail.deal.id, customerPhone: joinPhone, quantity: parseInt(joinQty, 10) || 1,
                  })}>
                  Test join (public)
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
