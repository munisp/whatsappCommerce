import { useRoute } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Package, Truck, CheckCircle2, AlertCircle, Clock } from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  pending: "Order received",
  confirmed: "Payment confirmed",
  processing: "Being prepared",
  shipped: "On the way",
  delivered: "Delivered",
  cancelled: "Cancelled",
  refunded: "Refunded",
  created: "Shipment created",
  picked_up: "Picked up",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  failed: "Delivery failed",
  returned: "Returned",
};

function statusColor(status: string): string {
  if (status === "delivered") return "bg-green-100 text-green-800";
  if (["failed", "cancelled", "returned"].includes(status)) return "bg-red-100 text-red-800";
  return "bg-blue-100 text-blue-800";
}

/** Public buyer tracking page — no auth, token in the URL is the capability. */
export default function TrackOrder() {
  const [, params] = useRoute("/track/:token");
  const token = params?.token ?? "";
  const query = trpc.tracking.getByToken.useQuery(
    { token },
    { enabled: token.length > 10, retry: false },
  );

  return (
    <div className="min-h-screen bg-muted/40 flex items-start justify-center p-4 pt-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Package className="h-5 w-5" />
            Order Tracking
          </CardTitle>
        </CardHeader>
        <CardContent>
          {query.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4 animate-spin" /> Loading your order…
            </div>
          )}

          {query.error && (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="h-4 w-4" />
              This tracking link is invalid or has expired. Please contact the store on WhatsApp.
            </div>
          )}

          {query.data && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{query.data.orderNumber}</div>
                  {query.data.customerFirstName && (
                    <div className="text-sm text-muted-foreground">Hi {query.data.customerFirstName}!</div>
                  )}
                </div>
                <Badge className={statusColor(query.data.status)}>
                  {STATUS_LABELS[query.data.status] ?? query.data.status}
                </Badge>
              </div>

              <div>
                <div className="text-sm font-medium mb-1">Items</div>
                <ul className="text-sm space-y-1">
                  {query.data.items.map((i, idx) => (
                    <li key={idx} className="flex justify-between">
                      <span>{i.qty} × {i.name}</span>
                      <span className="text-muted-foreground">{i.price}</span>
                    </li>
                  ))}
                </ul>
                <div className="border-t mt-2 pt-2 text-sm space-y-1">
                  {query.data.deliveryFee != null && (
                    <>
                      <div className="flex justify-between text-muted-foreground">
                        <span>Subtotal</span><span>{String(query.data.subtotal)}</span>
                      </div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>Delivery fee</span><span>{String(query.data.deliveryFee)}</span>
                      </div>
                    </>
                  )}
                  <div className="flex justify-between font-semibold">
                    <span>Total</span>
                    <span>{query.data.totalAmount} {query.data.currency}</span>
                  </div>
                </div>
              </div>

              {query.data.shipment && (
                <div>
                  <div className="text-sm font-medium mb-1 flex items-center gap-1">
                    <Truck className="h-4 w-4" /> Delivery
                  </div>
                  <div className="text-sm text-muted-foreground mb-2">
                    {query.data.shipment.carrierName ?? "Carrier"}
                    {query.data.shipment.trackingId ? ` · ${query.data.shipment.trackingId}` : ""}
                  </div>
                  <ol className="text-sm space-y-1">
                    {query.data.shipment.history.map((h, idx) => (
                      <li key={idx} className="flex items-center gap-2">
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" />
                        <span>{STATUS_LABELS[h.status] ?? h.status}</span>
                        {h.at && (
                          <span className="text-muted-foreground text-xs">
                            {new Date(h.at).toLocaleString()}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              <div className="text-xs text-muted-foreground">
                Payment: {query.data.paymentStatus} · Ordered {new Date(query.data.createdAt).toLocaleDateString()}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
