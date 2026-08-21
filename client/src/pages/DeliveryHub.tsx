/**
 * W27: Delivery aggregation hub — courier configuration, quote tester and
 * dispatch management (book / advance / sync).
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
import { Bike, PackageCheck, RefreshCw } from "lucide-react";

const NEXT: Record<string, Array<{ to: "picked_up" | "in_transit" | "delivered" | "failed" | "cancelled"; label: string }>> = {
  booked: [{ to: "picked_up", label: "Picked up" }, { to: "cancelled", label: "Cancel" }],
  picked_up: [{ to: "in_transit", label: "In transit" }, { to: "failed", label: "Failed" }],
  in_transit: [{ to: "delivered", label: "Delivered" }, { to: "failed", label: "Failed" }],
};

function naira(cents: number) {
  return `₦${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function DeliveryHub() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const utils = trpc.useUtils();
  const { data: adapters } = trpc.deliveryAggregation.listAdapters.useQuery({ tenantId });
  const { data: configs } = trpc.deliveryAggregation.listConfigs.useQuery({ tenantId });
  const { data: deliveries, isLoading } = trpc.deliveryAggregation.list.useQuery({ tenantId });
  const { data: orderList } = trpc.order.list.useQuery({ tenantId, limit: 50 });

  const invalidate = () => {
    utils.deliveryAggregation.listConfigs.invalidate();
    utils.deliveryAggregation.list.invalidate();
  };
  const onError = (e: any) => toast.error(e?.message ?? "Action failed");

  const configureMut = trpc.deliveryAggregation.configureCourier.useMutation({
    onSuccess: () => { invalidate(); toast.success("Courier saved"); }, onError,
  });
  const bookMut = trpc.deliveryAggregation.book.useMutation({
    onSuccess: () => { invalidate(); toast.success("Dispatch booked"); }, onError,
  });
  const advanceMut = trpc.deliveryAggregation.advance.useMutation({ onSuccess: invalidate, onError });
  const syncMut = trpc.deliveryAggregation.sync.useMutation({ onSuccess: invalidate, onError });

  const [courier, setCourier] = useState("local_dispatch");
  const [priority, setPriority] = useState("0");
  const [bookOrderId, setBookOrderId] = useState("");
  const [quoteAddress, setQuoteAddress] = useState("");
  const [quoteLat, setQuoteLat] = useState("");
  const [quoteLng, setQuoteLng] = useState("");
  const [quoteResult, setQuoteResult] = useState<any>(null);

  const quoteQuery = trpc.deliveryAggregation.quote.useQuery(
    {
      tenantId,
      ...(quoteAddress ? { dropoffAddress: quoteAddress } : {}),
      ...(quoteLat && quoteLng ? { dropoffLat: Number(quoteLat), dropoffLng: Number(quoteLng) } : {}),
    },
    { enabled: false },
  );

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold flex items-center gap-2"><Bike className="h-6 w-6" /> Delivery</h1>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Couriers</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Label>Courier adapter</Label>
              <Select value={courier} onValueChange={setCourier}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(adapters ?? []).map((a) => <SelectItem key={a.id} value={a.id}>{a.displayName}</SelectItem>)}
                </SelectContent>
              </Select>
              <Label>Priority (higher wins)</Label>
              <Input value={priority} onChange={(e) => setPriority(e.target.value)} type="number" />
              <Button onClick={() => configureMut.mutate({ tenantId, courier, enabled: true, priority: Number(priority) || 0 })}>
                Enable courier
              </Button>
              <div className="pt-2 space-y-1">
                {(configs ?? []).map((c: any) => (
                  <div key={c.id} className="flex items-center justify-between text-sm">
                    <span>{c.courier} · priority {c.priority}</span>
                    <Badge variant={c.enabled ? "default" : "outline"}>{c.enabled ? "enabled" : "disabled"}</Badge>
                  </div>
                ))}
                {(configs ?? []).length === 0 && (
                  <p className="text-sm text-muted-foreground">No couriers configured — the built-in local moto dispatch is used by default.</p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Quote tester</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Label>Dropoff address</Label>
              <Input value={quoteAddress} onChange={(e) => setQuoteAddress(e.target.value)} placeholder="12 Allen Avenue, Ikeja" />
              <div className="grid grid-cols-2 gap-2">
                <div><Label>Lat (optional)</Label><Input value={quoteLat} onChange={(e) => setQuoteLat(e.target.value)} placeholder="6.5244" /></div>
                <div><Label>Lng (optional)</Label><Input value={quoteLng} onChange={(e) => setQuoteLng(e.target.value)} placeholder="3.3792" /></div>
              </div>
              <Button
                variant="secondary"
                onClick={async () => {
                  const r = await quoteQuery.refetch();
                  setQuoteResult(r.data ?? null);
                }}
              >
                Get quote
              </Button>
              {quoteResult && (
                <div className="text-sm space-y-1">
                  <p><b>{quoteResult.label}</b> — {naira(quoteResult.feeCents)} · ETA ~{quoteResult.etaMinutes} min</p>
                  <p className="text-muted-foreground">courier: {quoteResult.courier} · source: {quoteResult.source}{quoteResult.distanceKm != null ? ` · ${quoteResult.distanceKm} km` : ""}</p>
                  {(quoteResult.quotes ?? []).length > 1 && (
                    <ul className="pt-1">
                      {quoteResult.quotes.map((q: any) => (
                        <li key={q.quoteId}>{q.courier}: {naira(q.feeCents)} · {q.etaMinutes} min</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><PackageCheck className="h-5 w-5" /> Dispatches</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Label>Book dispatch for order</Label>
                <Select value={bookOrderId} onValueChange={setBookOrderId}>
                  <SelectTrigger><SelectValue placeholder="Select order…" /></SelectTrigger>
                  <SelectContent>
                    {(((orderList as any) ?? []) as any[]).map((o: any) => (
                      <SelectItem key={o.id} value={o.id}>{o.orderNumber} — {o.status}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button disabled={!bookOrderId || bookMut.isPending} onClick={() => bookMut.mutate({ tenantId, orderId: bookOrderId })}>
                Book
              </Button>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead><TableHead>Courier</TableHead><TableHead>Fee</TableHead>
                  <TableHead>Status</TableHead><TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(deliveries ?? []).map((d: any) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-mono text-xs">{d.orderId.slice(0, 8)}…</TableCell>
                    <TableCell>{d.courier}</TableCell>
                    <TableCell>{naira(d.feeCents)}</TableCell>
                    <TableCell><Badge>{d.status}</Badge></TableCell>
                    <TableCell className="space-x-1">
                      {(NEXT[d.status] ?? []).map((a) => (
                        <Button key={a.to} size="sm" variant="outline"
                          onClick={() => advanceMut.mutate({ tenantId, deliveryId: d.id, status: a.to })}>
                          {a.label}
                        </Button>
                      ))}
                      {["booked", "picked_up", "in_transit"].includes(d.status) && (
                        <Button size="sm" variant="ghost" onClick={() => syncMut.mutate({ tenantId, deliveryId: d.id })}>
                          <RefreshCw className="h-3 w-3" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {!isLoading && (deliveries ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-muted-foreground">No dispatches yet — book one above.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
