import { useRoute, Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft, CheckCircle2, Clock, XCircle, Info,
  ShoppingCart, CreditCard, Package, Building2, Users,
  MessageSquare, Truck,
} from "lucide-react";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  confirmed: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  processing: "bg-purple-500/10 text-purple-600 border-purple-500/20",
  shipped: "bg-indigo-500/10 text-indigo-600 border-indigo-500/20",
  delivered: "bg-green-500/10 text-green-600 border-green-500/20",
  cancelled: "bg-red-500/10 text-red-600 border-red-500/20",
  refunded: "bg-gray-500/10 text-gray-600 border-gray-500/20",
};

const PAYMENT_STATUS_COLORS: Record<string, string> = {
  unpaid: "bg-red-500/10 text-red-600 border-red-500/20",
  paid: "bg-green-500/10 text-green-600 border-green-500/20",
  partial: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  refunded: "bg-gray-500/10 text-gray-600 border-gray-500/20",
};

function TimelineIcon({ status, system }: { status: string; system: string }) {
  const cls = "w-5 h-5";
  if (status === "failed") return <XCircle className={`${cls} text-red-500`} />;
  if (status === "pending") return <Clock className={`${cls} text-yellow-500`} />;
  if (system === "WhatsApp Platform") return <MessageSquare className={`${cls} text-green-500`} />;
  if (system === "Payment Gateway") return <CreditCard className={`${cls} text-blue-500`} />;
  if (system === "Medusa Commerce") return <Package className={`${cls} text-purple-500`} />;
  if (system === "Odoo ERP") return <Building2 className={`${cls} text-orange-500`} />;
  if (system === "Twenty CRM") return <Users className={`${cls} text-cyan-500`} />;
  return <CheckCircle2 className={`${cls} text-green-500`} />;
}

function TimelineDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    success: "bg-green-500 ring-green-500/20",
    pending: "bg-yellow-500 ring-yellow-500/20",
    failed: "bg-red-500 ring-red-500/20",
    info: "bg-blue-500 ring-blue-500/20",
  };
  return (
    <div className={`w-3 h-3 rounded-full ring-4 ${colors[status] ?? colors.info} flex-shrink-0`} />
  );
}

function IntegrationBadge({ label, active, color }: { label: string; active: boolean; color: string }) {
  return (
    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium ${
      active ? color : "bg-muted/40 text-muted-foreground border-border"
    }`}>
      <div className={`w-1.5 h-1.5 rounded-full ${active ? "bg-current" : "bg-muted-foreground/40"}`} />
      {label}
    </div>
  );
}

export default function OrderTimeline() {
  const [, params] = useRoute("/orders/:orderNumber");
  const orderNumber = params?.orderNumber ?? "";

  const { data, isLoading, error } = trpc.nlp.getOrderTimeline.useQuery(
    { orderNumber },
    { enabled: !!orderNumber }
  );

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <Link href="/orders">
          <Button variant="ghost" size="sm" className="mb-4">
            <ArrowLeft className="w-4 h-4 mr-2" /> Back to Orders
          </Button>
        </Link>
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center">
          <XCircle className="w-8 h-8 text-red-500 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">
            {error?.message ?? "Order not found"}
          </p>
        </div>
      </div>
    );
  }

  const { order, items, payments, timeline, integrations } = data;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      {/* Back button */}
      <Link href="/orders">
        <Button variant="ghost" size="sm">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Orders
        </Button>
      </Link>

      {/* Order header */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold text-card-foreground">{order.orderNumber}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Created {new Date(order.createdAt).toLocaleString()}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={STATUS_COLORS[order.status] ?? ""}>
              {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
            </Badge>
            <Badge variant="outline" className={PAYMENT_STATUS_COLORS[order.paymentStatus ?? "unpaid"] ?? ""}>
              {order.paymentStatus ?? "unpaid"}
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-6 text-sm">
          <div>
            <span className="text-muted-foreground">Total</span>
            <p className="font-semibold text-card-foreground">
              {order.currency} {Number(order.totalAmount).toLocaleString()}
            </p>
          </div>
          {order.erpOrderId && (
            <div>
              <span className="text-muted-foreground">Medusa ID</span>
              <p className="font-mono text-xs text-card-foreground">{order.erpOrderId}</p>
            </div>
          )}
          {!!order.shippingAddress && (
          <div>
            <span className="text-muted-foreground">Delivery</span>
            <p className="text-card-foreground text-xs">
              {String(
                typeof order.shippingAddress === "object" && order.shippingAddress !== null
                  ? ((order.shippingAddress as Record<string, unknown>).raw ?? JSON.stringify(order.shippingAddress))
                  : order.shippingAddress
              )}
            </p>
          </div>
        )}
        </div>

        {/* Integration badges */}
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <span className="text-xs text-muted-foreground mr-1">Integrations:</span>
          <IntegrationBadge label="Medusa" active={integrations.hasMedusa} color="bg-purple-500/10 text-purple-600 border-purple-500/20" />
          <IntegrationBadge label="Odoo ERP" active={integrations.hasOdoo} color="bg-orange-500/10 text-orange-600 border-orange-500/20" />
          <IntegrationBadge label="Twenty CRM" active={integrations.hasTwenty} color="bg-cyan-500/10 text-cyan-600 border-cyan-500/20" />
        </div>
      </div>

      {/* Order items */}
      {items.length > 0 && (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b bg-muted/30 flex items-center gap-2">
            <ShoppingCart className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">Order Items</span>
          </div>
          <div className="divide-y">
            {items.map((item) => (
              <div key={item.id} className="px-5 py-3 flex items-center justify-between text-sm">
                <div>
                  <p className="font-medium text-card-foreground">{item.productName}</p>
                  <p className="text-muted-foreground text-xs">Qty: {item.quantity}</p>
                </div>
                <p className="font-medium text-card-foreground">
                  {item.currency} {(Number(item.unitPrice) * item.quantity).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Payments */}
      {payments.length > 0 && (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b bg-muted/30 flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">Payments</span>
          </div>
          <div className="divide-y">
            {payments.map((p) => (
              <div key={p.id} className="px-5 py-3 flex items-center justify-between text-sm">
                <div>
                  <p className="font-medium text-card-foreground">{p.provider}</p>
                  <p className="text-muted-foreground text-xs">
                    {p.providerTxId ?? p.providerRef ?? "—"} · {new Date(p.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-medium text-card-foreground">{p.currency} {Number(p.amount).toLocaleString()}</p>
                  <Badge variant="outline" className={`text-xs ${
                    p.status === "success" ? "text-green-600 border-green-500/20"
                    : p.status === "failed" ? "text-red-600 border-red-500/20"
                    : "text-yellow-600 border-yellow-500/20"
                  }`}>
                    {p.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Timeline */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-5 py-3 border-b bg-muted/30 flex items-center gap-2">
          <Truck className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium">Order Timeline</span>
        </div>
        <div className="p-5">
          {timeline.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No timeline events yet.</p>
          ) : (
            <ol className="relative space-y-0">
              {timeline.map((event, idx) => (
                <li key={event.id} className="flex gap-4">
                  {/* Connector line + dot */}
                  <div className="flex flex-col items-center">
                    <TimelineDot status={event.status} />
                    {idx < timeline.length - 1 && (
                      <div className="w-px flex-1 bg-border my-1" />
                    )}
                  </div>
                  {/* Content */}
                  <div className="pb-6 min-w-0 flex-1">
                    <div className="flex items-start gap-2 flex-wrap">
                      <TimelineIcon status={event.status} system={event.system} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-card-foreground">{event.event}</span>
                          <Badge variant="outline" className="text-xs font-normal">
                            {event.system}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{event.detail}</p>
                        <p className="text-xs text-muted-foreground/60 mt-0.5">
                          {new Date(event.timestamp).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
