import { useMemo, useState } from "react";
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
import { Banknote, Package, Plus, Trash2 } from "lucide-react";

const COD_COLUMNS: Array<{ key: string; label: string }> = [
  { key: "cod_pending", label: "COD Pending" },
  { key: "rider_assigned", label: "Rider Assigned" },
  { key: "out_for_delivery", label: "Out for Delivery" },
  { key: "delivered_pending_cash", label: "Awaiting Cash" },
  { key: "cash_collected", label: "Cash Collected" },
  { key: "settled", label: "Settled" },
  { key: "delivery_failed", label: "Delivery Failed" },
  { key: "refused", label: "Refused" },
  { key: "returned", label: "Returned" },
];

const columnColors: Record<string, string> = {
  cod_pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  rider_assigned: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  out_for_delivery: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  delivered_pending_cash: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  cash_collected: "bg-green-500/20 text-green-400 border-green-500/30",
  settled: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  delivery_failed: "bg-red-500/20 text-red-400 border-red-500/30",
  refused: "bg-red-500/20 text-red-400 border-red-500/30",
  returned: "bg-purple-500/20 text-purple-400 border-purple-500/30",
};

const NEXT_ACTIONS: Record<string, Array<{ to: string; label: string }>> = {
  cod_pending: [{ to: "rider_assigned", label: "Assign rider" }],
  rider_assigned: [
    { to: "out_for_delivery", label: "Out for delivery" },
    { to: "delivery_failed", label: "Delivery failed" },
  ],
  out_for_delivery: [
    { to: "delivered_pending_cash", label: "Delivered" },
    { to: "delivery_failed", label: "Delivery failed" },
    { to: "refused", label: "Refused" },
  ],
  delivered_pending_cash: [{ to: "returned", label: "Returned" }],
  cash_collected: [{ to: "settled", label: "Settle" }],
  delivery_failed: [
    { to: "rider_assigned", label: "Retry" },
    { to: "returned", label: "Returned" },
  ],
  refused: [{ to: "returned", label: "Returned" }],
};

function money(n: number, currency = "NGN") {
  return `${currency === "NGN" ? "₦" : `${currency} `}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function CodBoard() {
  const { activeTenantId } = useActiveTenant();
  const tenantId = activeTenantId;
  const utils = trpc.useUtils();
  const { data: board, isLoading } = trpc.cod.board.useQuery({ tenantId });
  const { data: recon } = trpc.cod.codReconciliation.useQuery({ tenantId, windowDays: 14 });
  const { data: productList } = trpc.product.list.useQuery({ tenantId });

  const invalidate = () => {
    utils.cod.board.invalidate();
    utils.cod.codReconciliation.invalidate();
  };
  const onError = (e: any) => toast.error(e?.message ?? "Action failed");

  const transitionMut = trpc.cod.transition.useMutation({ onSuccess: invalidate, onError });
  const confirmMut = trpc.cod.codConfirmCollection.useMutation({
    onSuccess: (r) => {
      invalidate();
      if (r.applied === false) toast.info("Already recorded (idempotent replay)");
    },
    onError,
  });
  const settleMut = trpc.cod.settle.useMutation({ onSuccess: invalidate, onError });
  const offlineMut = trpc.cod.createOfflineOrder.useMutation({
    onSuccess: (r) => {
      invalidate();
      toast.success(`Offline order ${r.orderNumber} created`);
      setForm({ customerName: "", customerPhone: "", paymentMethod: "cash", amountPaid: "", note: "", items: [] });
    },
    onError,
  });

  // ── Offline capture form state ─────────────────────────────────────────
  const [form, setForm] = useState<{
    customerName: string;
    customerPhone: string;
    paymentMethod: "cod" | "cash" | "transfer";
    amountPaid: string;
    note: string;
    items: Array<{ productId: string; qty: number }>;
  }>({ customerName: "", customerPhone: "", paymentMethod: "cash", amountPaid: "", note: "", items: [] });

  const products = (productList ?? []) as any[];
  const formTotal = useMemo(
    () =>
      form.items.reduce((s, it) => {
        const p = products.find((pp) => pp.id === it.productId);
        return s + (p ? Number(p.price) * it.qty : 0);
      }, 0),
    [form.items, products],
  );

  const submitOffline = () => {
    if (!form.customerName.trim() || !form.customerPhone.trim() || form.items.length === 0) {
      toast.error("Name, phone and at least one item are required");
      return;
    }
    offlineMut.mutate({
      tenantId,
      customerName: form.customerName,
      customerPhone: form.customerPhone,
      paymentMethod: form.paymentMethod,
      amountPaid: form.amountPaid ? Number(form.amountPaid) : undefined,
      note: form.note || undefined,
      items: form.items.map((i) => ({ productId: i.productId, qty: i.qty })),
    });
  };

  const confirmCash = (order: any) => {
    const remaining = order.paymentSummary?.remaining ?? Number(order.totalAmount);
    const raw = window.prompt(
      `Cash collected for ${order.orderNumber} (remaining ${money(remaining, order.currency)}):`,
      String(remaining),
    );
    if (raw == null) return;
    const amount = Number(raw);
    if (!(amount > 0)) return toast.error("Amount must be positive");
    confirmMut.mutate({ orderId: order.id, amount });
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">COD & Offline Sales</h1>
          <p className="text-muted-foreground mt-1">
            Cash-on-delivery flow, settlement reconciliation and offline order capture
          </p>
        </div>

        {/* Kanban-ish board */}
        {isLoading ? (
          <p className="text-muted-foreground">Loading COD board…</p>
        ) : (
          <div className="flex gap-4 overflow-x-auto pb-2">
            {COD_COLUMNS.map((col) => {
              const cards = (board?.columns as any)?.[col.key] ?? [];
              return (
                <div key={col.key} className="min-w-[240px] w-60 shrink-0">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-foreground">{col.label}</span>
                    <Badge variant="outline" className={columnColors[col.key]}>{cards.length}</Badge>
                  </div>
                  <div className="space-y-2">
                    {cards.map((o: any) => (
                      <Card key={o.id} className="bg-card/60">
                        <CardContent className="p-3 space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">{o.orderNumber}</span>
                            <span className="text-sm">{money(Number(o.totalAmount), o.currency)}</span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Paid {money(o.paymentSummary?.totalPaid ?? 0, o.currency)} ·{" "}
                            {o.paymentSummary?.status ?? "unpaid"}
                            {(o.paymentSummary?.remaining ?? 0) > 0 &&
                              ` · due ${money(o.paymentSummary.remaining, o.currency)}`}
                          </div>
                          <div className="flex flex-wrap gap-1 pt-1">
                            {(NEXT_ACTIONS[o.codState] ?? []).map((a) => (
                              <Button
                                key={a.to}
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-xs"
                                onClick={() =>
                                  transitionMut.mutate({
                                    orderId: o.id,
                                    to: a.to as any,
                                    reason: a.to === "delivery_failed" ? window.prompt("Failure reason?") ?? "unspecified" : undefined,
                                  })
                                }
                              >
                                {a.label}
                              </Button>
                            ))}
                            {o.codState === "delivered_pending_cash" && (
                              <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => confirmCash(o)}>
                                <Banknote className="h-3 w-3 mr-1" /> Confirm cash
                              </Button>
                            )}
                            {o.codState === "cash_collected" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-xs"
                                onClick={() => settleMut.mutate({ orderId: o.id })}
                              >
                                Settle
                              </Button>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                    {cards.length === 0 && <p className="text-xs text-muted-foreground">—</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Reconciliation */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Settlement reconciliation (14 days)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Expected</TableHead>
                  <TableHead className="text-right">Collected</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(recon?.days ?? []).filter((d: any) => d.expected !== 0 || d.collected !== 0).map((d: any) => (
                  <TableRow key={d.date}>
                    <TableCell>{d.date}</TableCell>
                    <TableCell className="text-right">{money(d.expected)}</TableCell>
                    <TableCell className="text-right">{money(d.collected)}</TableCell>
                    <TableCell className={`text-right ${d.variance !== 0 ? "text-red-400" : ""}`}>
                      {money(d.variance)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {recon?.totals && (
              <p className="text-sm text-muted-foreground">
                Totals — expected {money(recon.totals.expected)}, collected {money(recon.totals.collected)}, variance{" "}
                <span className={recon.totals.variance !== 0 ? "text-red-400" : ""}>{money(recon.totals.variance)}</span>
              </p>
            )}
            {(recon?.unsettled?.length ?? 0) > 0 && (
              <div>
                <h3 className="text-sm font-medium mb-2">Unsettled aging</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Collected</TableHead>
                      <TableHead className="text-right">Age (h)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recon!.unsettled.map((u: any) => (
                      <TableRow key={u.orderId}>
                        <TableCell>{u.orderNumber}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={columnColors[u.codState]}>{u.codState}</Badge>
                        </TableCell>
                        <TableCell className="text-right">{money(u.totalAmount)}</TableCell>
                        <TableCell className="text-right">{money(u.collectedAmount)}</TableCell>
                        <TableCell className="text-right">{u.ageHours}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Offline order capture */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Package className="h-5 w-5" /> Record offline sale
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label>Customer name</Label>
                <Input
                  value={form.customerName}
                  onChange={(e) => setForm({ ...form, customerName: e.target.value })}
                  placeholder="Walk-in customer"
                />
              </div>
              <div>
                <Label>Phone</Label>
                <Input
                  value={form.customerPhone}
                  onChange={(e) => setForm({ ...form, customerPhone: e.target.value })}
                  placeholder="234…"
                />
              </div>
              <div>
                <Label>Payment method</Label>
                <Select
                  value={form.paymentMethod}
                  onValueChange={(v) => setForm({ ...form, paymentMethod: v as any })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">Cash (paid now)</SelectItem>
                    <SelectItem value="transfer">Transfer</SelectItem>
                    <SelectItem value="cod">COD (collect later)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Items</Label>
              {form.items.map((it, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Select
                    value={it.productId}
                    onValueChange={(v) => {
                      const items = [...form.items];
                      items[idx] = { ...items[idx], productId: v };
                      setForm({ ...form, items });
                    }}
                  >
                    <SelectTrigger className="w-64"><SelectValue placeholder="Product" /></SelectTrigger>
                    <SelectContent>
                      {products.map((p: any) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} — {money(Number(p.price))} ({p.stockQuantity ?? 0} in stock)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    min={1}
                    className="w-20"
                    value={it.qty}
                    onChange={(e) => {
                      const items = [...form.items];
                      items[idx] = { ...items[idx], qty: Math.max(1, Number(e.target.value) || 1) };
                      setForm({ ...form, items });
                    }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setForm({ ...form, items: form.items.filter((_, i) => i !== idx) })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setForm({ ...form, items: [...form.items, { productId: "", qty: 1 }] })}
              >
                <Plus className="h-4 w-4 mr-1" /> Add item
              </Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Amount paid (optional — partial allowed)</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.amountPaid}
                  onChange={(e) => setForm({ ...form, amountPaid: e.target.value })}
                  placeholder={form.paymentMethod === "cod" ? "0 (deposit optional)" : String(formTotal)}
                />
              </div>
              <div>
                <Label>Note</Label>
                <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Total: {money(formTotal)}</span>
              <Button onClick={submitOffline} disabled={offlineMut.isPending}>
                Record sale
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
