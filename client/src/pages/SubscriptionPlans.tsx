// === W55 ui-a ===
/**
 * W55 (Coder UI-A): SubscriptionPlans — merchant surface for the W44
 * subscriptionPlans router: plan CRUD (create/archive; product-linked,
 * day/week/month interval, integer-cents price) plus the subscriber list
 * (customer_subscriptions via the additive tenant-scoped listSubscribers
 * query). Subscribe/pause/resume/cancel stay chat-side by design.
 */
import { useState } from "react";
import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

function fmt(cents: number, currency = "NGN") {
  return `${currency} ${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string | Date | null | undefined) {
  return d ? new Date(d).toLocaleDateString() : "—";
}

export default function SubscriptionPlans() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const utils = trpc.useUtils();

  const [productId, setProductId] = useState("");
  const [name, setName] = useState("");
  const [interval, setInterval] = useState<"day" | "week" | "month">("month");
  const [priceMajor, setPriceMajor] = useState("1000");
  const [subPlanId, setSubPlanId] = useState<string>("all");
  const [subStatus, setSubStatus] = useState<string>("all");

  const { data: plans } = trpc.subscriptionPlans.listPlans.useQuery({ tenantId });
  const { data: subscribers } = trpc.subscriptionPlans.listSubscribers.useQuery({
    tenantId,
    planId: subPlanId === "all" ? undefined : subPlanId,
    status: subStatus === "all" ? undefined : (subStatus as any),
    limit: 200,
  });

  const onError = (e: any) => toast.error(e?.message ?? "Failed");
  const invalidate = () => {
    utils.subscriptionPlans.listPlans.invalidate();
    utils.subscriptionPlans.listSubscribers.invalidate();
  };
  const createMut = trpc.subscriptionPlans.createPlan.useMutation({
    onSuccess: () => { toast.success("Plan created"); setName(""); invalidate(); }, onError,
  });
  const archiveMut = trpc.subscriptionPlans.archivePlan.useMutation({
    onSuccess: () => { toast.success("Plan archived"); invalidate(); }, onError,
  });

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-bold">Subscription Plans</h1>

        <Card>
          <CardHeader><CardTitle>Create plan</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-4">
            <div className="min-w-56"><Label>Product ID</Label><Input value={productId} onChange={(e) => setProductId(e.target.value)} placeholder="catalog product id" /></div>
            <div className="min-w-56"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly staples box" /></div>
            <div>
              <Label>Interval</Label>
              <Select value={interval} onValueChange={(v) => setInterval(v as typeof interval)}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">Day</SelectItem>
                  <SelectItem value="week">Week</SelectItem>
                  <SelectItem value="month">Month</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>Price (major units)</Label><Input value={priceMajor} onChange={(e) => setPriceMajor(e.target.value)} inputMode="decimal" /></div>
            <Button
              disabled={createMut.isPending || !productId.trim() || !name.trim() || !(parseFloat(priceMajor) > 0)}
              onClick={() => createMut.mutate({
                tenantId,
                productId: productId.trim(),
                name: name.trim(),
                interval,
                priceCents: Math.round(parseFloat(priceMajor || "0") * 100),
              })}
            >Create</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Plans</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Product</TableHead><TableHead>Interval</TableHead><TableHead>Price</TableHead><TableHead>Status</TableHead><TableHead>Created</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {(plans ?? []).map((p: any) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="font-mono">{p.productId}</TableCell>
                    <TableCell>{p.interval}</TableCell>
                    <TableCell>{fmt(p.priceCents)}</TableCell>
                    <TableCell><Badge variant={p.status === "active" ? "default" : "secondary"}>{p.status}</Badge></TableCell>
                    <TableCell>{fmtDate(p.createdAt)}</TableCell>
                    <TableCell>
                      {p.status === "active" && (
                        <Button size="sm" variant="destructive" disabled={archiveMut.isPending}
                          onClick={() => archiveMut.mutate({ tenantId, planId: p.id })}>Archive</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {(plans ?? []).length === 0 && <TableRow><TableCell colSpan={7}>No subscription plans yet.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Subscribers</CardTitle>
            <div className="flex gap-3">
              <Select value={subPlanId} onValueChange={setSubPlanId}>
                <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All plans</SelectItem>
                  {(plans ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={subStatus} onValueChange={setSubStatus}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="past_due">Past due</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Customer</TableHead><TableHead>Plan</TableHead><TableHead>Status</TableHead><TableHead>Next billing</TableHead><TableHead>Last billed period</TableHead><TableHead>Since</TableHead></TableRow></TableHeader>
              <TableBody>
                {(subscribers ?? []).map((s: any) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono">{s.customerId}</TableCell>
                    <TableCell>{s.planName}</TableCell>
                    <TableCell><Badge variant={s.status === "active" ? "default" : s.status === "past_due" ? "destructive" : "secondary"}>{s.status}</Badge></TableCell>
                    <TableCell>{fmtDate(s.nextBillingAt)}</TableCell>
                    <TableCell>{s.lastBilledPeriod ?? "—"}</TableCell>
                    <TableCell>{fmtDate(s.createdAt)}</TableCell>
                  </TableRow>
                ))}
                {(subscribers ?? []).length === 0 && <TableRow><TableCell colSpan={6}>No subscribers found.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
// === END W55 ui-a ===
