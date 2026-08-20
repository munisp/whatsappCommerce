/**
 * DiscoverNearby — public customer discovery page. Share your location (or
 * type it in) to find shops near you that deliver, browse by category, and
 * jump straight into a shop's menu or WhatsApp chat.
 *
 * Privacy: your location is only used to search — it is never stored.
 */
import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import {
  Loader2, MapPin, MessageCircle, Navigation, Search, Store,
} from "lucide-react";

type GeoState =
  | { status: "pending" }
  | { status: "granted"; lat: number; lng: number }
  | { status: "denied" };

interface DiscoverItem {
  tenantId: string;
  businessName: string;
  category: string | null;
  distanceKm: number;
  sponsored: boolean;
  openNow: boolean | null;
}

const DEFAULT_RADIUS = 5;

export default function DiscoverNearby() {
  const [geo, setGeo] = useState<GeoState>({ status: "pending" });
  const [manualLat, setManualLat] = useState("");
  const [manualLng, setManualLng] = useState("");
  const [radiusKm, setRadiusKm] = useState<number>(DEFAULT_RADIUS);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<DiscoverItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  // Ask for the customer's location on mount (one-shot).
  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setGeo({ status: "denied" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setGeo({ status: "granted", lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setGeo({ status: "denied" }),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  }, []);

  const coords = useMemo(() => {
    if (geo.status === "granted") return { lat: geo.lat, lng: geo.lng };
    if (geo.status === "denied") {
      const lat = Number(manualLat);
      const lng = Number(manualLng);
      if (Number.isFinite(lat) && Number.isFinite(lng) && manualLat.trim() && manualLng.trim() &&
          Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        return { lat, lng };
      }
    }
    return null;
  }, [geo, manualLat, manualLng]);

  const categories = trpc.geo.listCategories.useQuery();

  const discover = trpc.geo.discover.useQuery(
    {
      lat: coords?.lat ?? 0,
      lng: coords?.lng ?? 0,
      radiusKm,
      category: category ?? undefined,
      query: search || undefined,
      cursor,
    },
    { enabled: coords != null, placeholderData: (prev: any) => prev } as any,
  );

  // Accumulate pages; reset when the search inputs change.
  const [seenKey, setSeenKey] = useState("");
  const pageKey = JSON.stringify([coords?.lat, coords?.lng, radiusKm, category, search]);
  useEffect(() => {
    if (pageKey !== seenKey) {
      setItems([]);
      setCursor(undefined);
      setSeenKey(pageKey);
    }
  }, [pageKey, seenKey]);
  useEffect(() => {
    const data = discover.data as any;
    if (!data) return;
    setItems((prev) => (cursor ? [...prev, ...data.items] : data.items));
  }, [discover.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = discover.data as any;
  const quickOptions: number[] = data?.radiusQuickOptions ?? [1, 2, 5, 10, 25, 50];

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MapPin className="w-6 h-6 text-primary" /> Shops near you
          </h1>
          <p className="text-muted-foreground text-sm">
            Find local businesses that deliver to you. Your location is only used
            for this search — it is never stored.
          </p>
        </header>

        {geo.status === "pending" && (
          <Card><CardContent className="py-6 flex items-center gap-3 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" /> Finding your location…
          </CardContent></Card>
        )}

        {geo.status === "denied" && (
          <Card>
            <CardContent className="py-6 space-y-3">
              <p className="text-sm font-medium flex items-center gap-2">
                <Navigation className="w-4 h-4" /> We couldn't access your location
              </p>
              <p className="text-sm text-muted-foreground">
                You can allow location access in your browser settings, or enter
                your coordinates below. Tip: search “latitude longitude of
                &lt;your landmark&gt;” online and paste the numbers here.
              </p>
              <div className="flex gap-2">
                <Input placeholder="Latitude (e.g. 6.5244)" value={manualLat} onChange={(e) => setManualLat(e.target.value)} />
                <Input placeholder="Longitude (e.g. 3.3792)" value={manualLng} onChange={(e) => setManualLng(e.target.value)} />
              </div>
            </CardContent>
          </Card>
        )}

        {coords && (
          <>
            <div className="flex gap-2">
              <Input
                placeholder="Search shops or products…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") setSearch(query.trim()); }}
              />
              <Button onClick={() => setSearch(query.trim())} aria-label="Search">
                <Search className="w-4 h-4" />
              </Button>
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-xs text-muted-foreground">Within</span>
                {quickOptions.map((km) => (
                  <Button
                    key={km}
                    size="sm"
                    variant={radiusKm === km ? "default" : "outline"}
                    onClick={() => setRadiusKm(km)}
                  >
                    {km} km
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge
                  variant={category === null ? "default" : "outline"}
                  className="cursor-pointer"
                  onClick={() => setCategory(null)}
                >
                  All
                </Badge>
                {(categories.data ?? []).map((c: any) => (
                  <Badge
                    key={c.id}
                    variant={category === c.name ? "default" : "outline"}
                    className="cursor-pointer"
                    onClick={() => setCategory(category === c.name ? null : c.name)}
                  >
                    {c.name}
                  </Badge>
                ))}
              </div>
            </div>

            {discover.isLoading && items.length === 0 && (
              <div className="flex justify-center py-10 text-muted-foreground">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            )}

            {!discover.isLoading && items.length === 0 && (
              <Card><CardContent className="py-10 text-center text-muted-foreground">
                <Store className="w-8 h-8 mx-auto mb-2 opacity-50" />
                No shops found nearby yet — try a wider distance.
              </CardContent></Card>
            )}

            <div className="space-y-3">
              {items.map((item) => (
                <Card key={`${item.tenantId}-${item.sponsored}`}>
                  <CardContent className="py-4 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold truncate">{item.businessName}</span>
                        {item.sponsored && (
                          <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
                            Sponsored
                          </Badge>
                        )}
                        {item.openNow !== null && (
                          <span className={`text-xs ${item.openNow ? "text-green-600" : "text-muted-foreground"}`}>
                            {item.openNow ? "Open now" : "Closed"}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {item.category ?? "Shop"} · {item.distanceKm.toFixed(1)} km away
                      </div>
                    </div>
                    {/* Assumption: no dedicated public per-tenant storefront route
                        exists yet — the in-app menu builder accepts a tenant
                        param and is the closest "view shop / message" target. */}
                    <Link href={`/menu-builder?tenant=${item.tenantId}`}>
                      <Button size="sm" variant="outline" className="shrink-0">
                        <MessageCircle className="w-4 h-4 mr-1" /> View shop
                      </Button>
                    </Link>
                  </CardContent>
                </Card>
              ))}
            </div>

            {data?.nextCursor && (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  disabled={discover.isFetching}
                  onClick={() => setCursor(data.nextCursor)}
                >
                  {discover.isFetching && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
