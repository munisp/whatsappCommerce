/**
 * MerchantGeoSettings — tenant self-service for local discovery:
 * shop location, service radius, discoverability toggle, and sponsored
 * placements (location-aware promotions shown to customers searching within
 * the chosen area, always labeled "Sponsored" and capped per results page).
 */
import { useEffect, useState } from "react";
import { TenantPortalLayout } from "@/components/TenantPortalLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";
import { Loader2, MapPin, Megaphone, Navigation, Pause, Play } from "lucide-react";

const toCents = (major: string) => Math.round(Number(major || "0") * 100);

function StatusChip({ status }: { status: string }) {
  const variant =
    status === "active" ? "default" :
    status === "paused" ? "secondary" :
    status === "exhausted" ? "destructive" : "outline";
  return <Badge variant={variant as any} className="capitalize">{status}</Badge>;
}

export default function MerchantGeoSettings() {
  const utils = trpc.useUtils();
  const location = trpc.geo.merchant.getLocation.useQuery();
  const listings = trpc.geo.merchant.listSponsoredListings.useQuery();

  // ── Shop location form ──────────────────────────────────────────────────
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [addressLine, setAddressLine] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [radiusKm, setRadiusKm] = useState(5);
  const [discoverable, setDiscoverable] = useState(false);
  const [gpsBusy, setGpsBusy] = useState(false);

  useEffect(() => {
    const loc = location.data as any;
    if (loc) {
      setLat(String(loc.latitude ?? ""));
      setLng(String(loc.longitude ?? ""));
      setAddressLine(loc.addressLine ?? "");
      setCity(loc.city ?? "");
      setCountry(loc.country ?? "");
      setRadiusKm(Number(loc.serviceRadiusKm ?? 5));
      setDiscoverable(Boolean(loc.discoverable));
    }
  }, [location.data]);

  const setLocation = trpc.geo.merchant.setLocation.useMutation({
    onSuccess: () => {
      toast.success("Shop location saved");
      utils.geo.merchant.getLocation.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const setDiscoverableMut = trpc.geo.merchant.setDiscoverable.useMutation({
    onSuccess: (r) => {
      toast.success(r.discoverable ? "Your business is now visible to nearby customers" : "Your business is hidden from nearby search");
      utils.geo.merchant.getLocation.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const useMyLocation = () => {
    if (!("geolocation" in navigator)) {
      toast.error("Your browser doesn't support location access — enter coordinates manually");
      return;
    }
    setGpsBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(7));
        setLng(pos.coords.longitude.toFixed(7));
        setGpsBusy(false);
      },
      () => {
        toast.error("Couldn't get your location — enter coordinates manually");
        setGpsBusy(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const saveLocation = () => {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
      toast.error("Enter a valid latitude and longitude");
      return;
    }
    setLocation.mutate({
      latitude: la,
      longitude: ln,
      addressLine: addressLine || undefined,
      city: city || undefined,
      country: country || undefined,
      serviceRadiusKm: radiusKm,
    });
  };

  const toggleDiscoverable = (on: boolean) => {
    setDiscoverable(on);
    setDiscoverableMut.mutate({ discoverable: on, serviceRadiusKm: radiusKm });
  };

  // ── Sponsored placement form ────────────────────────────────────────────
  const [spName, setSpName] = useState("");
  const [spCategories, setSpCategories] = useState("");
  const [spRadius, setSpRadius] = useState(5);
  const [spBid, setSpBid] = useState("");
  const [spBudget, setSpBudget] = useState("");

  const invalidateListings = () => utils.geo.merchant.listSponsoredListings.invalidate();
  const createListing = trpc.geo.merchant.createSponsoredListing.useMutation({
    onSuccess: () => {
      toast.success("Sponsored placement is live");
      setSpName(""); setSpCategories(""); setSpBid(""); setSpBudget("");
      invalidateListings();
    },
    onError: (e) => toast.error(e.message),
  });
  const pauseListing = trpc.geo.merchant.pauseSponsoredListing.useMutation({
    onSuccess: () => { toast.success("Placement paused"); invalidateListings(); },
    onError: (e) => toast.error(e.message),
  });
  const resumeListing = trpc.geo.merchant.resumeSponsoredListing.useMutation({
    onSuccess: () => { toast.success("Placement live again"); invalidateListings(); },
    onError: (e) => toast.error(e.message),
  });

  const submitListing = () => {
    const la = Number(lat);
    const ln = Number(lng);
    if (!spName.trim()) return toast.error("Give your placement a name");
    if (!Number.isFinite(la) || !Number.isFinite(ln)) {
      return toast.error("Save your shop location first — placements are centered on it");
    }
    const bidCents = toCents(spBid);
    const dailyBudgetCents = toCents(spBudget);
    if (dailyBudgetCents <= 0) return toast.error("Enter a daily budget greater than zero");
    createListing.mutate({
      name: spName.trim(),
      categories: spCategories.split(",").map((c) => c.trim()).filter(Boolean),
      centerLat: la,
      centerLng: ln,
      radiusKm: spRadius,
      bidCents,
      dailyBudgetCents,
    });
  };

  return (
    <TenantPortalLayout>
      <div className="max-w-3xl mx-auto space-y-6 p-4">
        <header>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MapPin className="w-6 h-6 text-primary" /> Local discovery
          </h1>
          <p className="text-muted-foreground text-sm">
            Help customers near you find your shop when they search by location.
          </p>
        </header>

        {/* 1. Shop location */}
        <Card>
          <CardHeader>
            <CardTitle>Shop location</CardTitle>
            <CardDescription>
              Where customers can find you. This is the centre of your delivery area.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="lat">Latitude</Label>
                <Input id="lat" placeholder="6.5244" value={lat} onChange={(e) => setLat(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="lng">Longitude</Label>
                <Input id="lng" placeholder="3.3792" value={lng} onChange={(e) => setLng(e.target.value)} />
              </div>
            </div>
            <Button variant="outline" onClick={useMyLocation} disabled={gpsBusy}>
              {gpsBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Navigation className="w-4 h-4 mr-2" />}
              Use my current location
            </Button>
            <div className="grid gap-3">
              <div className="space-y-1">
                <Label htmlFor="addr">Address</Label>
                <Input id="addr" placeholder="12 Market Street" value={addressLine} onChange={(e) => setAddressLine(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="city">City</Label>
                  <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="country">Country</Label>
                  <Input id="country" value={country} onChange={(e) => setCountry(e.target.value)} />
                </div>
              </div>
            </div>
            <Button onClick={saveLocation} disabled={setLocation.isPending}>
              {setLocation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save location
            </Button>
          </CardContent>
        </Card>

        {/* 2. Service radius */}
        <Card>
          <CardHeader>
            <CardTitle>Service radius</CardTitle>
            <CardDescription>
              How far from your shop you'll serve customers: {radiusKm} km.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Slider
              min={1} max={50} step={1}
              value={[radiusKm]}
              onValueChange={([v]) => setRadiusKm(v)}
            />
            <div className="flex justify-between text-xs text-muted-foreground mt-1">
              <span>1 km</span><span>50 km</span>
            </div>
          </CardContent>
        </Card>

        {/* 3. Discoverability */}
        <Card>
          <CardContent className="py-5 flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">Show my business to nearby customers</p>
              <p className="text-sm text-muted-foreground">
                When on, customers searching within your service radius can find your shop.
              </p>
            </div>
            <Switch
              checked={discoverable}
              onCheckedChange={toggleDiscoverable}
              disabled={setDiscoverableMut.isPending}
              aria-label="Show my business to nearby customers"
            />
          </CardContent>
        </Card>

        {/* 4. Sponsored placement */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Megaphone className="w-5 h-5" /> Sponsored placement
            </CardTitle>
            <CardDescription>
              Appear at the top of nearby searches. Placements are location-aware:
              they're only shown to customers searching within the area you choose,
              always labeled “Sponsored”, and only a limited number appear on each
              results page. You set a daily budget — you never spend more than that.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3">
              <div className="space-y-1">
                <Label htmlFor="spName">Placement name</Label>
                <Input id="spName" placeholder="Weekend promo" value={spName} onChange={(e) => setSpName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="spCats">Categories (comma-separated, optional)</Label>
                <Input id="spCats" placeholder="groceries, drinks" value={spCategories} onChange={(e) => setSpCategories(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Area radius: {spRadius} km (centred on your shop location)</Label>
                <Slider min={1} max={50} step={1} value={[spRadius]} onValueChange={([v]) => setSpRadius(v)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="spBid">Bid per placement (e.g. 0.50)</Label>
                  <Input id="spBid" inputMode="decimal" value={spBid} onChange={(e) => setSpBid(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="spBudget">Daily budget (e.g. 10.00)</Label>
                  <Input id="spBudget" inputMode="decimal" value={spBudget} onChange={(e) => setSpBudget(e.target.value)} />
                </div>
              </div>
            </div>
            <Button onClick={submitListing} disabled={createListing.isPending}>
              {createListing.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Start sponsored placement
            </Button>

            {(listings.data ?? []).length > 0 && (
              <div className="divide-y rounded-md border mt-4">
                {(listings.data as any[]).map((l) => (
                  <div key={l.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{l.name}</span>
                        <StatusChip status={l.status} />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {Number(l.radiusKm)} km · bid {(l.bidCents / 100).toFixed(2)} ·
                        budget {(l.dailyBudgetCents / 100).toFixed(2)}/day ·
                        spent today {(l.spentTodayCents / 100).toFixed(2)}
                      </p>
                    </div>
                    {l.status === "active" && (
                      <Button size="sm" variant="outline" onClick={() => pauseListing.mutate({ id: l.id })} disabled={pauseListing.isPending}>
                        <Pause className="w-4 h-4 mr-1" /> Pause
                      </Button>
                    )}
                    {l.status === "paused" && (
                      <Button size="sm" variant="outline" onClick={() => resumeListing.mutate({ id: l.id })} disabled={resumeListing.isPending}>
                        <Play className="w-4 h-4 mr-1" /> Resume
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </TenantPortalLayout>
  );
}
