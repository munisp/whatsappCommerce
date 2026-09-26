import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Bike, LogOut, MapPin, Package, Power, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

const TOKEN_KEY = "driverToken";

type AuthStep = "choose" | "signup" | "login" | "otp";

/**
 * Public, standalone driver app — no Keycloak account, no tenant. A driver signs up once (name/phone/
 * email), verifies by email OTP (server/routers/drivers.ts — see its own header comment for why email,
 * not WhatsApp/SMS), then this same page IS their ongoing session: go online, share location, see and
 * update assigned deliveries. Session token lives in localStorage only (a per-device convenience, never
 * read back by the server except as the bearer of the identity proof itself).
 */
export default function DriverApp() {
  const [token, setToken] = useState<string | null>(() => {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  });

  const meQuery = trpc.drivers.me.useQuery({ token: token ?? "" }, { enabled: !!token, retry: false });

  useEffect(() => {
    if (token && meQuery.isError) {
      // Session expired or invalid — drop it and fall back to the auth flow.
      try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
      setToken(null);
    }
  }, [token, meQuery.isError]);

  function handleAuthed(newToken: string) {
    try { localStorage.setItem(TOKEN_KEY, newToken); } catch { /* ignore */ }
    setToken(newToken);
  }

  function handleLogout() {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    setToken(null);
  }

  if (token && meQuery.data) {
    return <DriverDashboard token={token} driver={meQuery.data} onLogout={handleLogout} />;
  }
  if (token && meQuery.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Loading your account…
      </div>
    );
  }
  return <DriverAuth onAuthed={handleAuthed} />;
}

function DriverAuth({ onAuthed }: { onAuthed: (token: string) => void }) {
  const [step, setStep] = useState<AuthStep>("choose");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [purpose, setPurpose] = useState<"signup" | "login">("signup");

  const signup = trpc.drivers.signup.useMutation({
    onSuccess: () => { setPurpose("signup"); setStep("otp"); toast.success("Check your email for a code"); },
    onError: (e) => toast.error(e.message),
  });
  const requestLogin = trpc.drivers.requestLoginOtp.useMutation({
    onSuccess: () => { setPurpose("login"); setStep("otp"); toast.success("If that email is registered, a code is on its way"); },
    onError: (e) => toast.error(e.message),
  });
  const verify = trpc.drivers.verifyOtp.useMutation({
    onSuccess: (result) => onAuthed(result.token),
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="min-h-screen bg-muted/40 flex items-start justify-center p-4 pt-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Bike className="h-5 w-5" /> Driver App
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === "choose" && (
            <div className="space-y-2">
              <Button className="w-full" onClick={() => setStep("signup")}>New driver — sign up</Button>
              <Button variant="outline" className="w-full" onClick={() => setStep("login")}>I already have an account</Button>
            </div>
          )}

          {step === "signup" && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="d-name">Full name</Label>
                <Input id="d-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-phone">Phone</Label>
                <Input id="d-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 0801 234 5678" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-email">Email</Label>
                <Input id="d-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <Button
                className="w-full"
                disabled={!name.trim() || !phone.trim() || !email.trim() || signup.isPending}
                onClick={() => signup.mutate({ name, phone, email })}
              >
                Send code to my email
              </Button>
              <Button variant="ghost" size="sm" className="w-full" onClick={() => setStep("choose")}>Back</Button>
            </div>
          )}

          {step === "login" && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="d-login-email">Email</Label>
                <Input id="d-login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <Button
                className="w-full"
                disabled={!email.trim() || requestLogin.isPending}
                onClick={() => requestLogin.mutate({ email })}
              >
                Send login code
              </Button>
              <Button variant="ghost" size="sm" className="w-full" onClick={() => setStep("choose")}>Back</Button>
            </div>
          )}

          {step === "otp" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Enter the code we emailed to {email}.</p>
              <Input
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                className="text-center text-lg tracking-widest font-mono"
                inputMode="numeric"
              />
              <Button
                className="w-full"
                disabled={otp.length < 4 || verify.isPending}
                onClick={() => verify.mutate({ email, otp, purpose })}
              >
                Verify
              </Button>
              <Button variant="ghost" size="sm" className="w-full" onClick={() => setStep("choose")}>Start over</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type DriverProfile = { id: string; name: string; status: string };

function DriverDashboard({ token, driver, onLogout }: { token: string; driver: DriverProfile; onLogout: () => void }) {
  const utils = trpc.useUtils();
  const isOnline = driver.status === "online";
  const watchIdRef = useRef<number | null>(null);

  const goOnline = trpc.drivers.goOnline.useMutation({ onSuccess: () => utils.drivers.me.invalidate() });
  const goOffline = trpc.drivers.goOffline.useMutation({ onSuccess: () => utils.drivers.me.invalidate() });
  const updateLocation = trpc.drivers.updateLocation.useMutation();
  const deliveriesQuery = trpc.drivers.myDeliveries.useQuery({ token }, { refetchInterval: 15000 });
  const updateStatus = trpc.drivers.updateDeliveryStatus.useMutation({
    onSuccess: () => { toast.success("Updated"); utils.drivers.myDeliveries.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  // Push location every time it changes while online; stop watching the moment we go offline.
  useEffect(() => {
    if (!isOnline || !("geolocation" in navigator)) {
      if (watchIdRef.current != null) { navigator.geolocation.clearWatch(watchIdRef.current); watchIdRef.current = null; }
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => updateLocation.mutate({ token, lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => toast.error(`Location error: ${err.message}`),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
    );
    watchIdRef.current = id;
    return () => navigator.geolocation.clearWatch(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, token]);

  const NEXT_STATUS: Record<string, "picked_up" | "in_transit" | "delivered" | null> = {
    booked: "picked_up",
    picked_up: "in_transit",
    in_transit: "delivered",
    delivered: null,
  };

  return (
    <div className="min-h-screen bg-muted/40 p-4 pb-10 space-y-4 max-w-sm mx-auto">
      <div className="flex items-center justify-between pt-4">
        <div>
          <div className="font-semibold">{driver.name}</div>
          <div className="text-xs text-muted-foreground">Driver</div>
        </div>
        <Button variant="ghost" size="icon" onClick={onLogout}><LogOut className="h-4 w-4" /></Button>
      </div>

      <Card>
        <CardContent className="p-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Power className={`h-5 w-5 ${isOnline ? "text-green-600" : "text-muted-foreground"}`} />
            <div>
              <div className="font-medium">{isOnline ? "Online" : "Offline"}</div>
              <div className="text-xs text-muted-foreground">{isOnline ? "Sharing your location" : "Not receiving deliveries"}</div>
            </div>
          </div>
          <Button
            variant={isOnline ? "outline" : "default"}
            disabled={goOnline.isPending || goOffline.isPending}
            onClick={() => (isOnline ? goOffline.mutate({ token }) : goOnline.mutate({ token }))}
          >
            {isOnline ? "Go offline" : "Go online"}
          </Button>
        </CardContent>
      </Card>

      <div>
        <div className="text-sm font-medium mb-2 flex items-center gap-1">
          <Package className="h-4 w-4" /> My deliveries
        </div>
        {!deliveriesQuery.data?.length ? (
          <p className="text-sm text-muted-foreground">No deliveries assigned yet.</p>
        ) : (
          <div className="space-y-2">
            {deliveriesQuery.data.map((d) => {
              const next = NEXT_STATUS[d.status] ?? null;
              return (
                <Card key={d.id}>
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline">{d.status.replace("_", " ")}</Badge>
                      {d.feeCents != null && <span className="text-xs text-muted-foreground">{d.currency} {(d.feeCents / 100).toLocaleString()}</span>}
                    </div>
                    {d.dropoffAddress && (
                      <div className="text-xs text-muted-foreground flex items-start gap-1">
                        <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
                        <span>{(d.dropoffAddress as { raw?: string })?.raw ?? "Delivery address on file"}</span>
                      </div>
                    )}
                    {next && (
                      <Button
                        size="sm"
                        className="w-full"
                        disabled={updateStatus.isPending}
                        onClick={() => updateStatus.mutate({ token, deliveryId: d.id, status: next })}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                        Mark as {next.replace("_", " ")}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
