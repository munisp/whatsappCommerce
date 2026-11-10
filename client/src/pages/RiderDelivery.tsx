/**
 * The rider's handover page (/deliver/:token): opened from the link the shop sends its own rider. No account —
 * the signed link is the key, and only works for this one order. The rider checks the customer's delivery PIN,
 * takes a photo (required when the shop asks for one) and marks the order delivered.
 */
import { useRef, useState } from "react";
import { useRoute } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Camera, CheckCircle2, AlertCircle, MapPin, Package, Loader2 } from "lucide-react";
import { shrinkPhoto as shrink } from "@/lib/shrinkPhoto";

export default function RiderDelivery() {
  const [, params] = useRoute("/deliver/:token");
  const token = params?.token ?? "";
  const view = trpc.rider.view.useQuery({ token }, { enabled: token.length > 10, retry: false });
  const confirm = trpc.rider.confirm.useMutation();
  const [pin, setPin] = useState("");
  const [cash, setCash] = useState<string | null>(null);
  const [photo, setPhoto] = useState<{ dataUrl: string; type: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-muted/40 p-4 pb-10 max-w-sm mx-auto space-y-4">{children}</div>
  );

  if (view.isLoading) return shell(<div className="pt-20 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>);
  if (view.error || !view.data) {
    return shell(<Card className="mt-10"><CardContent className="p-6 text-center space-y-2">
      <AlertCircle className="h-8 w-8 mx-auto text-destructive" />
      <p className="font-medium">This delivery link isn't valid</p>
      <p className="text-sm text-muted-foreground">Ask the shop to send you a new one.</p>
    </CardContent></Card>);
  }
  const d = view.data;
  if (d.delivered || confirm.isSuccess) {
    return shell(<Card className="mt-10"><CardContent className="p-6 text-center space-y-2">
      <CheckCircle2 className="h-10 w-10 mx-auto text-green-600" />
      <p className="text-lg font-semibold">Delivered</p>
      <p className="text-sm text-muted-foreground">Order {d.orderNumber} is marked delivered. {d.shop} and the customer have been told.</p>
    </CardContent></Card>);
  }
  if (d.cancelled) {
    return shell(<Card className="mt-10"><CardContent className="p-6 text-center space-y-2">
      <AlertCircle className="h-8 w-8 mx-auto text-destructive" />
      <p className="font-medium">This order was cancelled</p>
      <p className="text-sm text-muted-foreground">Don't hand it over. Call {d.shop}.</p>
    </CardContent></Card>);
  }

  const cashValue = cash ?? (d.cashDue != null ? String(d.cashDue) : "");
  const cashOk = d.cashDue == null || Number(cashValue) > 0;
  const canSubmit = (!d.needsPin || pin.trim().length >= 4) && (!d.photoRequired || !!photo) && cashOk && !confirm.isPending;
  return shell(<>
    <div className="pt-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{d.shop} · delivery</div>
      <div className="text-xl font-semibold">Order {d.orderNumber}</div>
    </div>
    <Card><CardContent className="p-4 space-y-3">
      {d.address && <div className="flex gap-2 text-sm"><MapPin className="h-4 w-4 mt-0.5 shrink-0" /><span>{d.address}</span></div>}
      {d.items.length > 0 && <div className="flex gap-2 text-sm"><Package className="h-4 w-4 mt-0.5 shrink-0" />
        <span>{d.items.map((i) => `${i.quantity} × ${i.name}`).join(", ")}</span></div>}
    </CardContent></Card>

    <Card><CardContent className="p-4 space-y-4">
      {d.cashDue != null && <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3">
        <div className="text-sm font-semibold">Collect ₦{d.cashDue.toLocaleString()} in cash</div>
        <label htmlFor="rider-cash" className="text-xs text-muted-foreground">Cash you collected (₦)</label>
        <Input id="rider-cash" inputMode="decimal" value={cashValue} onChange={(e) => setCash(e.target.value.replace(/[^\d.]/g, ""))} />
        <p className="text-xs text-muted-foreground">If you got less, enter what you got. The shop is told about any difference.</p>
      </div>}
      {d.needsPin && <div className="space-y-1">
        <label htmlFor="rider-pin" className="text-sm font-medium">Customer's delivery PIN</label>
        <Input id="rider-pin" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} placeholder="Ask the customer for it" />
        <p className="text-xs text-muted-foreground">It's in their payment receipt on WhatsApp.</p>
      </div>}

      <div className="space-y-2">
        <div className="text-sm font-medium">Photo of the delivery{d.photoRequired ? "" : " (optional)"}</div>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" aria-label="Take a photo of the delivery"
          onChange={async (e) => { const f = e.target.files?.[0]; if (f) setPhoto(await shrink(f)); }} />
        {photo
          ? <button type="button" className="block w-full" onClick={() => fileRef.current?.click()}>
              <img src={photo.dataUrl} alt="Delivery photo" className="w-full rounded-md border" />
              <span className="text-xs text-muted-foreground">Tap to retake</span>
            </button>
          : <Button type="button" variant="outline" className="w-full" onClick={() => fileRef.current?.click()}>
              <Camera className="h-4 w-4 mr-2" /> Take photo
            </Button>}
      </div>

      {confirm.error && <p role="alert" className="text-sm text-destructive">{confirm.error.message}</p>}
      <Button className="w-full" size="lg" disabled={!canSubmit}
        onClick={() => confirm.mutate({ token, pin: pin || undefined, photoBase64: photo?.dataUrl, photoMimeType: photo?.type, cashCollected: d.cashDue != null ? Number(cashValue) : undefined })}>
        {confirm.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
        Mark delivered
      </Button>
    </CardContent></Card>
  </>);
}
