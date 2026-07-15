import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, ShoppingCart, FileText, TrendingUp, Plus } from "lucide-react";
import { toast } from "sonner";

const TENANT_ID = "default";

export default function B2BPortal() {
  const [rfqOpen, setRfqOpen] = useState(false);
  const [poOpen, setPoOpen] = useState(false);
  const [rfqForm, setRfqForm] = useState({ buyerPhone: "", buyerName: "", quantity: "1", productId: "", notes: "" });
  const [poForm, setPoForm] = useState({ buyerPhone: "", totalAmount: "", currency: "NGN", paymentTermsDays: 30 });

  const { data: priceTiers } = trpc.b2b.listPriceTiers.useQuery({ tenantId: TENANT_ID });
  const { data: rfqs, refetch: refetchRfqs } = trpc.b2b.listRfqs.useQuery({ tenantId: TENANT_ID });
  const { data: pos, refetch: refetchPos } = trpc.b2b.listPurchaseOrders.useQuery({ tenantId: TENANT_ID });
  const { data: stats } = trpc.b2b.b2bStats.useQuery({ tenantId: TENANT_ID });

  const submitRfq = trpc.b2b.submitRfq.useMutation({
    onSuccess: () => { toast.success("RFQ submitted"); setRfqOpen(false); refetchRfqs(); },
    onError: (e) => toast.error(e.message),
  });
  const createPo = trpc.b2b.createPurchaseOrder.useMutation({
    onSuccess: () => { toast.success("Purchase order created"); setPoOpen(false); refetchPos(); },
    onError: (e) => toast.error(e.message),
  });

  const statusColor = (s: string) => {
    if (s === "approved" || s === "accepted" || s === "fulfilled") return "bg-green-100 text-green-800";
    if (s === "submitted" || s === "quoted") return "bg-yellow-100 text-yellow-800";
    if (s === "rejected" || s === "cancelled") return "bg-red-100 text-red-800";
    return "bg-gray-100 text-gray-700";
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">B2B Commerce Portal</h1>
          <p className="text-gray-500 text-sm mt-1">Wholesale pricing, RFQs, and purchase orders</p>
        </div>

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Price Tiers", value: (priceTiers ?? []).length, icon: TrendingUp, color: "text-blue-600" },
              { label: "Open RFQs", value: stats.rfq?.pending ?? 0, icon: FileText, color: "text-yellow-600" },
              { label: "Purchase Orders", value: stats.purchaseOrders?.total ?? 0, icon: ShoppingCart, color: "text-purple-600" },
              { label: "Fulfilled POs", value: stats.purchaseOrders?.fulfilled ?? 0, icon: Building2, color: "text-green-600" },
            ].map(({ label, value, icon: Icon, color }) => (
              <Card key={label}>
                <CardContent className="pt-4">
                  <div className="flex items-center gap-3">
                    <Icon className={`w-8 h-8 ${color}`} />
                    <div><p className="text-2xl font-bold">{value}</p><p className="text-xs text-gray-500">{label}</p></div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <Tabs defaultValue="price-tiers">
          <TabsList>
            <TabsTrigger value="price-tiers">Price Tiers</TabsTrigger>
            <TabsTrigger value="rfqs">RFQs</TabsTrigger>
            <TabsTrigger value="purchase-orders">Purchase Orders</TabsTrigger>
          </TabsList>

          <TabsContent value="price-tiers" className="space-y-3 pt-4">
            {(priceTiers ?? []).map((tier) => (
              <Card key={tier.id}>
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold">Product: {tier.productId}</p>
                      <p className="text-sm text-gray-500">Buyer: {tier.buyerType} | Min qty: {tier.minQuantity} | Price: {tier.currency} {tier.unitPrice}</p>
                      {tier.discountPercent && <p className="text-xs text-green-600">{tier.discountPercent}% discount</p>}
                    </div>
                    <Badge className="bg-blue-100 text-blue-800">{tier.buyerType}</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
            {(priceTiers ?? []).length === 0 && <p className="text-gray-400 text-sm text-center py-8">No price tiers configured yet.</p>}
          </TabsContent>

          <TabsContent value="rfqs" className="space-y-3 pt-4">
            <div className="flex justify-end">
              <Dialog open={rfqOpen} onOpenChange={setRfqOpen}>
                <DialogTrigger asChild>
                  <Button size="sm"><Plus className="w-4 h-4 mr-1" />New RFQ</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Submit Request for Quotation</DialogTitle></DialogHeader>
                  <div className="space-y-3 pt-2">
                    <Input placeholder="Your Phone Number" value={rfqForm.buyerPhone} onChange={e => setRfqForm(f => ({ ...f, buyerPhone: e.target.value }))} />
                    <Input placeholder="Your Name (optional)" value={rfqForm.buyerName} onChange={e => setRfqForm(f => ({ ...f, buyerName: e.target.value }))} />
                    <Input placeholder="Product ID" value={rfqForm.productId} onChange={e => setRfqForm(f => ({ ...f, productId: e.target.value }))} />
                    <Input placeholder="Quantity" type="number" value={rfqForm.quantity} onChange={e => setRfqForm(f => ({ ...f, quantity: e.target.value }))} />
                    <Input placeholder="Notes (optional)" value={rfqForm.notes} onChange={e => setRfqForm(f => ({ ...f, notes: e.target.value }))} />
                    <Button className="w-full" onClick={() => submitRfq.mutate({
                      tenantId: TENANT_ID,
                      buyerPhone: rfqForm.buyerPhone,
                      buyerName: rfqForm.buyerName || undefined,
                      items: [{ productId: rfqForm.productId, productName: rfqForm.productId, quantity: parseInt(rfqForm.quantity) || 1 }],
                      notes: rfqForm.notes || undefined,
                    })} disabled={submitRfq.isPending}>
                      {submitRfq.isPending ? "Submitting..." : "Submit RFQ"}
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            {(rfqs ?? []).map((rfq) => (
              <Card key={rfq.id}>
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold">RFQ from {rfq.buyerName ?? rfq.buyerPhone}</p>
                      <p className="text-sm text-gray-500">{rfq.buyerType} | {new Date(rfq.createdAt).toLocaleDateString()}</p>
                      {rfq.quotedPrice && <p className="text-sm text-green-600">Quoted: {rfq.currency} {rfq.quotedPrice}</p>}
                    </div>
                    <Badge className={statusColor(rfq.status)}>{rfq.status}</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
            {(rfqs ?? []).length === 0 && <p className="text-gray-400 text-sm text-center py-8">No RFQs yet.</p>}
          </TabsContent>

          <TabsContent value="purchase-orders" className="space-y-3 pt-4">
            <div className="flex justify-end">
              <Dialog open={poOpen} onOpenChange={setPoOpen}>
                <DialogTrigger asChild>
                  <Button size="sm"><Plus className="w-4 h-4 mr-1" />New PO</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Create Purchase Order</DialogTitle></DialogHeader>
                  <div className="space-y-3 pt-2">
                    <Input placeholder="Buyer Phone" value={poForm.buyerPhone} onChange={e => setPoForm(f => ({ ...f, buyerPhone: e.target.value }))} />
                    <Input placeholder="Total Amount" type="number" value={poForm.totalAmount} onChange={e => setPoForm(f => ({ ...f, totalAmount: e.target.value }))} />
                    <Select value={poForm.currency} onValueChange={v => setPoForm(f => ({ ...f, currency: v }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NGN">NGN</SelectItem>
                        <SelectItem value="USD">USD</SelectItem>
                        <SelectItem value="GHS">GHS</SelectItem>
                        <SelectItem value="KES">KES</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button className="w-full" onClick={() => createPo.mutate({
                      tenantId: TENANT_ID,
                      buyerPhone: poForm.buyerPhone,
                      items: [],
                      totalAmount: poForm.totalAmount,
                      currency: poForm.currency,
                      paymentTermsDays: poForm.paymentTermsDays,
                    })} disabled={createPo.isPending}>
                      {createPo.isPending ? "Creating..." : "Create PO"}
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            {(pos ?? []).map((po) => (
              <Card key={po.id}>
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold">PO #{po.poNumber}</p>
                      <p className="text-sm text-gray-500">{po.buyerPhone} | {po.currency} {po.totalAmount}</p>
                      <p className="text-xs text-gray-400">Terms: {po.paymentTermsDays} days | {new Date(po.createdAt).toLocaleDateString()}</p>
                    </div>
                    <Badge className={statusColor(po.status)}>{po.status}</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
            {(pos ?? []).length === 0 && <p className="text-gray-400 text-sm text-center py-8">No purchase orders yet.</p>}
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
