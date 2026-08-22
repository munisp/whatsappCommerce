/**
 * W27 — Wholesale marketplace portal page.
 * Tabs: My Listings (wholesaler mgmt: publish, tiers, activate/pause),
 * Browse (marketplace search + tiered quote + place order, incl.
 * trade-credit checkout with live credit-score preview), Orders (supplier
 * and buyer order books).
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Search, Package } from "lucide-react";
import { toast } from "sonner";

const TENANT_ID = "default";

function fmt(cents: number, currency = "NGN") {
  return `${currency} ${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

const statusColor = (s: string) =>
  s === "active" || s === "confirmed" || s === "paid" || s === "fulfilled"
    ? "bg-green-100 text-green-800"
    : s === "pending" || s === "draft"
      ? "bg-yellow-100 text-yellow-800"
      : s === "cancelled" || s === "paused"
        ? "bg-red-100 text-red-800"
        : "bg-gray-100 text-gray-700";

export default function WholesaleMarketplace() {
  const [listingForm, setListingForm] = useState({
    title: "", description: "", category: "", moq: "1",
    tiers: [{ minQty: "1", maxQty: "", unitPriceCents: "" }],
    activate: true,
  });
  const [searchQ, setSearchQ] = useState("");
  const [orderQtys, setOrderQtys] = useState<Record<string, string>>({});
  const [payModes, setPayModes] = useState<Record<string, "pay_now" | "trade_credit">>({});
  const [orderRole, setOrderRole] = useState<"supplier" | "buyer">("supplier");

  const { data: myListings, refetch: refetchMine } = trpc.wholesale.listMyListings.useQuery({ tenantId: TENANT_ID });
  const { data: market, refetch: refetchMarket } = trpc.wholesale.browseMarketplace.useQuery(
    searchQ.trim() ? { query: searchQ.trim() } : {},
  );
  const { data: orders, refetch: refetchOrders } = trpc.wholesale.listOrders.useQuery({ tenantId: TENANT_ID, role: orderRole });
  const { data: scorePreview } = trpc.wholesale.creditScorePreview.useQuery(
    { tenantId: TENANT_ID, supplierTenantId: TENANT_ID },
  );

  const createListing = trpc.wholesale.createListing.useMutation({
    onSuccess: () => { toast.success("Listing published"); refetchMine(); refetchMarket(); },
    onError: (e) => toast.error(e.message),
  });
  const updateListing = trpc.wholesale.updateListing.useMutation({
    onSuccess: () => { toast.success("Listing updated"); refetchMine(); refetchMarket(); },
    onError: (e) => toast.error(e.message),
  });
  const placeOrder = trpc.wholesale.placeOrder.useMutation({
    onSuccess: (r) => { toast.success(`Order placed — ${fmt(r.order.totalCents, r.order.currency)}`); refetchOrders(); },
    onError: (e) => toast.error(e.message),
  });
  const updateStatus = trpc.wholesale.updateOrderStatus.useMutation({
    onSuccess: () => { toast.success("Order updated"); refetchOrders(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Wholesale Marketplace</h1>
        <p className="text-gray-500 text-sm mt-1">Bulk listings with MOQ + tiered pricing; trade-credit checkout</p>
      </div>

      <Tabs defaultValue="browse">
        <TabsList>
          <TabsTrigger value="browse">Browse</TabsTrigger>
          <TabsTrigger value="mine">My Listings</TabsTrigger>
          <TabsTrigger value="orders">Orders</TabsTrigger>
        </TabsList>

        {/* ── Browse + order ─────────────────────────────────────────── */}
        <TabsContent value="browse" className="space-y-4">
          <div className="flex gap-2">
            <Input placeholder="Search wholesale listings…" value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)} />
            <Button variant="outline" onClick={() => refetchMarket()}><Search className="h-4 w-4" /></Button>
          </div>
          {scorePreview && (
            <p className="text-xs text-gray-500">
              Your platform credit score: <b>{scorePreview.score}</b>/1000
              {scorePreview.score >= 300 ? " — trade-credit checkout available" : " — below trade-credit threshold (300)"}
            </p>
          )}
          {(market ?? []).map((m) => (
            <Card key={m.id}>
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">{m.title}</p>
                    <p className="text-sm text-gray-500">MOQ {m.moq} · {m.category ?? "General"}</p>
                  </div>
                  <Package className="h-5 w-5 text-gray-400" />
                </div>
                <div className="text-sm">
                  {m.tiers.map((t, i) => (
                    <span key={i} className="mr-3">
                      {t.minQty}+{t.maxQty != null ? `–${t.maxQty}` : ""}: <b>{fmt(t.unitPriceCents, m.currency)}</b>/unit
                    </span>
                  ))}
                </div>
                <div className="flex gap-2 items-center">
                  <Input className="w-28" placeholder="Qty" value={orderQtys[m.id] ?? ""}
                    onChange={(e) => setOrderQtys({ ...orderQtys, [m.id]: e.target.value })} />
                  <Select value={payModes[m.id] ?? "pay_now"}
                    onValueChange={(v) => setPayModes({ ...payModes, [m.id]: v as "pay_now" | "trade_credit" })}>
                    <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pay_now">Pay now</SelectItem>
                      <SelectItem value="trade_credit">Trade credit</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button size="sm" disabled={placeOrder.isPending}
                    onClick={() => placeOrder.mutate({
                      tenantId: TENANT_ID,
                      listingId: m.id,
                      quantity: parseInt(orderQtys[m.id] ?? "0", 10) || 0,
                      paymentMode: payModes[m.id] ?? "pay_now",
                    })}>
                    Order
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
          {(market ?? []).length === 0 && <p className="text-gray-400 text-sm text-center py-8">No active wholesale listings.</p>}
        </TabsContent>

        {/* ── My listings (wholesaler mgmt) ──────────────────────────── */}
        <TabsContent value="mine" className="space-y-4">
          <Card>
            <CardContent className="pt-4 space-y-2">
              <p className="font-semibold flex items-center gap-2"><Plus className="h-4 w-4" /> New listing</p>
              <Input placeholder="Title" value={listingForm.title}
                onChange={(e) => setListingForm({ ...listingForm, title: e.target.value })} />
              <Input placeholder="Category" value={listingForm.category}
                onChange={(e) => setListingForm({ ...listingForm, category: e.target.value })} />
              <div className="flex gap-2">
                <Input className="w-28" placeholder="MOQ" value={listingForm.moq}
                  onChange={(e) => setListingForm({ ...listingForm, moq: e.target.value })} />
              </div>
              {listingForm.tiers.map((t, i) => (
                <div key={i} className="flex gap-2">
                  <Input className="w-24" placeholder="Min qty" value={t.minQty}
                    onChange={(e) => {
                      const tiers = [...listingForm.tiers];
                      tiers[i] = { ...t, minQty: e.target.value };
                      setListingForm({ ...listingForm, tiers });
                    }} />
                  <Input className="w-24" placeholder="Max qty (∞)" value={t.maxQty}
                    onChange={(e) => {
                      const tiers = [...listingForm.tiers];
                      tiers[i] = { ...t, maxQty: e.target.value };
                      setListingForm({ ...listingForm, tiers });
                    }} />
                  <Input className="w-32" placeholder="Unit price (cents)" value={t.unitPriceCents}
                    onChange={(e) => {
                      const tiers = [...listingForm.tiers];
                      tiers[i] = { ...t, unitPriceCents: e.target.value };
                      setListingForm({ ...listingForm, tiers });
                    }} />
                </div>
              ))}
              <div className="flex gap-2">
                <Button variant="outline" size="sm"
                  onClick={() => setListingForm({ ...listingForm, tiers: [...listingForm.tiers, { minQty: "", maxQty: "", unitPriceCents: "" }] })}>
                  + Tier
                </Button>
                <Button size="sm" disabled={createListing.isPending}
                  onClick={() => createListing.mutate({
                    tenantId: TENANT_ID,
                    title: listingForm.title,
                    description: listingForm.description || undefined,
                    category: listingForm.category || undefined,
                    moq: parseInt(listingForm.moq, 10) || 1,
                    activate: listingForm.activate,
                    tiers: listingForm.tiers
                      .filter((t) => t.minQty && t.unitPriceCents)
                      .map((t) => ({
                        minQty: parseInt(t.minQty, 10),
                        maxQty: t.maxQty ? parseInt(t.maxQty, 10) : null,
                        unitPriceCents: parseInt(t.unitPriceCents, 10),
                      })),
                  })}>
                  Publish
                </Button>
              </div>
            </CardContent>
          </Card>
          {(myListings ?? []).map((row) => (
            <Card key={row.listing.id}>
              <CardContent className="pt-4 flex items-center justify-between">
                <div>
                  <p className="font-semibold">{row.listing.title}</p>
                  <p className="text-sm text-gray-500">MOQ {row.listing.moq} · {row.tiers.length} tier(s)</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={statusColor(row.listing.status)}>{row.listing.status}</Badge>
                  <Button size="sm" variant="outline" disabled={updateListing.isPending}
                    onClick={() => updateListing.mutate({
                      tenantId: TENANT_ID, listingId: row.listing.id,
                      status: row.listing.status === "active" ? "paused" : "active",
                    })}>
                    {row.listing.status === "active" ? "Pause" : "Activate"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
          {(myListings ?? []).length === 0 && <p className="text-gray-400 text-sm text-center py-8">No listings yet.</p>}
        </TabsContent>

        {/* ── Orders ─────────────────────────────────────────────────── */}
        <TabsContent value="orders" className="space-y-4">
          <Select value={orderRole} onValueChange={(v) => setOrderRole(v as "supplier" | "buyer")}>
            <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="supplier">As wholesaler (sales)</SelectItem>
              <SelectItem value="buyer">As retailer (purchases)</SelectItem>
            </SelectContent>
          </Select>
          {(orders ?? []).map((o) => (
            <Card key={o.id}>
              <CardContent className="pt-4 flex items-center justify-between">
                <div>
                  <p className="font-semibold">{o.quantity} units · {fmt(o.totalCents, o.currency)}</p>
                  <p className="text-sm text-gray-500">
                    {o.paymentMode === "trade_credit" ? `Trade credit (score ${o.creditScore ?? "?"})` : "Pay now"}
                    {" · "}{new Date(o.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={statusColor(o.status)}>{o.status}</Badge>
                  {orderRole === "supplier" && o.status === "pending" && (
                    <Button size="sm" variant="outline" disabled={updateStatus.isPending}
                      onClick={() => updateStatus.mutate({ tenantId: TENANT_ID, orderId: o.id, status: "confirmed" })}>
                      Confirm
                    </Button>
                  )}
                  {orderRole === "supplier" && o.status === "confirmed" && (
                    <Button size="sm" variant="outline" disabled={updateStatus.isPending}
                      onClick={() => updateStatus.mutate({ tenantId: TENANT_ID, orderId: o.id, status: "fulfilled" })}>
                      Fulfill
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
          {(orders ?? []).length === 0 && <p className="text-gray-400 text-sm text-center py-8">No orders yet.</p>}
        </TabsContent>
      </Tabs>
    </div>
  );
}
