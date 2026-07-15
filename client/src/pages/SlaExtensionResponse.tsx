import { useState, useEffect } from "react";
import { useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Clock4, CheckCircle2, XCircle, ShieldCheck, AlertCircle } from "lucide-react";

interface ExtensionData {
  valid: boolean;
  expired?: boolean;
  alreadyResponded?: boolean;
  extension?: {
    id: string;
    escrowId: string;
    extensionHours: number;
    reason: string | null;
    status: string;
    requestedAt: string;
    merchantName: string | null;
    orderId: string | null;
    currentDeadline: string | null;
    newDeadline: string | null;
  };
}

export default function SlaExtensionResponse() {
  const [, params] = useRoute("/sla-extension/:token");
  const token = params?.token ?? "";

  const [data, setData] = useState<ExtensionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [responding, setResponding] = useState(false);
  const [responded, setResponded] = useState<"approved" | "rejected" | null>(null);

  useEffect(() => {
    if (!token || loaded) return;
    setLoading(true);
    fetch(`/api/sla-extension/${token}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoaded(true); })
      .catch(() => { setData({ valid: false }); setLoaded(true); })
      .finally(() => setLoading(false));
  }, [token]);

  const handleRespond = async (action: "approve" | "reject") => {
    setResponding(true);
    try {
      const res = await fetch(`/api/sla-extension/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Request failed");
      }
      setResponded(action === "approve" ? "approved" : "rejected");
      toast.success(action === "approve" ? "Extension approved" : "Extension rejected");
    } catch (err: any) {
      toast.error(err.message ?? "Something went wrong. Please try again.");
    } finally {
      setResponding(false);
    }
  };

  if (loading || !loaded) {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-muted-foreground">Loading extension request…</p>
        </div>
      </div>
    );
  }

  if (!data?.valid) {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-background border rounded-xl p-8 text-center shadow-sm">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <h1 className="text-xl font-semibold mb-2">
            {data?.expired ? "This link has expired" : data?.alreadyResponded ? "Already responded" : "Invalid link"}
          </h1>
          <p className="text-muted-foreground text-sm">
            {data?.expired
              ? "This SLA extension request link has expired."
              : data?.alreadyResponded
              ? "You have already responded to this extension request."
              : "This link is invalid. Please contact the merchant for assistance."}
          </p>
        </div>
      </div>
    );
  }

  if (responded) {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-background border rounded-xl p-8 text-center shadow-sm">
          {responded === "approved" ? (
            <>
              <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-4" />
              <h1 className="text-xl font-semibold mb-2">Extension Approved</h1>
              <p className="text-muted-foreground text-sm">
                You have approved the delivery extension. The merchant now has additional time to complete your order.
                {data.extension?.newDeadline && (
                  <span className="block mt-2 font-medium text-foreground">
                    New deadline: {new Date(data.extension.newDeadline).toLocaleString()}
                  </span>
                )}
              </p>
            </>
          ) : (
            <>
              <XCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
              <h1 className="text-xl font-semibold mb-2">Extension Rejected</h1>
              <p className="text-muted-foreground text-sm">
                You have rejected the extension request. The original delivery deadline remains in effect.
                If the order is not delivered on time, your payment will be automatically refunded.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  const ext = data.extension!;

  return (
    <div className="min-h-screen bg-muted/30 py-8 px-4">
      <div className="max-w-lg mx-auto space-y-6">
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Clock4 className="h-6 w-6 text-amber-500" />
            <span className="font-semibold text-lg">Delivery Extension Request</span>
          </div>
          <p className="text-sm text-muted-foreground">
            The merchant has requested additional time to deliver your order. Please review and respond.
          </p>
        </div>

        {/* Extension details card */}
        <div className="bg-background border rounded-xl p-5 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Extension Details</h2>
            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">Pending Your Response</Badge>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            {ext.orderId && (
              <div>
                <p className="text-muted-foreground text-xs">Order ID</p>
                <p className="font-medium">{ext.orderId}</p>
              </div>
            )}
            {ext.merchantName && (
              <div>
                <p className="text-muted-foreground text-xs">Merchant</p>
                <p className="font-medium">{ext.merchantName}</p>
              </div>
            )}
            <div>
              <p className="text-muted-foreground text-xs">Extension Requested</p>
              <p className="font-medium text-amber-600">{ext.extensionHours} hours</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Requested On</p>
              <p className="font-medium">{new Date(ext.requestedAt).toLocaleDateString()}</p>
            </div>
            {ext.currentDeadline && (
              <div>
                <p className="text-muted-foreground text-xs">Current Deadline</p>
                <p className="font-medium">{new Date(ext.currentDeadline).toLocaleString()}</p>
              </div>
            )}
            {ext.newDeadline && (
              <div>
                <p className="text-muted-foreground text-xs">New Deadline (if approved)</p>
                <p className="font-medium text-green-600">{new Date(ext.newDeadline).toLocaleString()}</p>
              </div>
            )}
          </div>

          {ext.reason && (
            <div className="bg-muted/50 rounded-lg p-3">
              <p className="text-xs text-muted-foreground mb-1">Merchant's reason</p>
              <p className="text-sm">{ext.reason}</p>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="bg-background border rounded-xl p-5 shadow-sm space-y-3">
          <h3 className="font-semibold text-sm">Your Decision</h3>
          <p className="text-xs text-muted-foreground">
            If you approve, the merchant gets {ext.extensionHours} more hours to deliver. If you reject, the original deadline stands and you may be eligible for a refund if delivery is missed.
          </p>
          <div className="flex gap-3">
            <Button
              className="flex-1 bg-green-600 hover:bg-green-500 text-white gap-2"
              disabled={responding}
              onClick={() => handleRespond("approve")}
            >
              <CheckCircle2 className="h-4 w-4" />
              {responding ? "Processing…" : "Approve Extension"}
            </Button>
            <Button
              variant="outline"
              className="flex-1 text-red-600 border-red-200 hover:bg-red-50 gap-2"
              disabled={responding}
              onClick={() => handleRespond("reject")}
            >
              <XCircle className="h-4 w-4" />
              {responding ? "Processing…" : "Reject"}
            </Button>
          </div>
        </div>

        <div className="text-center text-xs text-muted-foreground space-y-1 pb-4">
          <div className="flex items-center justify-center gap-1">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>Secured by WhatsApp Commerce Platform</span>
          </div>
          <p>Your payment is held safely in escrow and will only be released when you confirm delivery.</p>
        </div>
      </div>
    </div>
  );
}
