import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { trpc } from "@/lib/trpc";
import { useActiveTenant } from "@/contexts/TenantContext";
import {
  estimateEtaMinutes,
  extractShipmentCoords,
  formatEta,
  isActiveShipment,
  maskDeliveryPin,
  shipmentStatusColor,
  type EtaZone,
  type LatLng,
} from "@/lib/opsLogistics";
import { MapPin, MapPinOff, RefreshCw, Truck, Loader2 } from "lucide-react";

/** Center on Nigeria when no shipment carries coordinates. */
const DEFAULT_CENTER: [number, number] = [8.6753, 9.082];
const DEFAULT_ZOOM = 5.5;

type ShipmentRow = {
  id: string;
  orderId: string;
  status: string;
  carrierName: string | null;
  trackingId: string | null;
  deliveryPin: string | null;
  recipientName: string | null;
  recipientAddress: unknown;
  senderAddress: unknown;
  metadata: unknown;
  createdAt: string | Date;
};

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

export default function LiveLogisticsMap() {
  const { activeTenantId } = useActiveTenant();
  const tenantId = activeTenantId;

  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const [mapReady, setMapReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading, refetch, isFetching, dataUpdatedAt } =
    trpc.logistics.listShipments.useQuery(
      { tenantId, limit: 200 },
      { refetchInterval: 30_000 },
    );
  const shipments = (data?.items ?? []) as unknown as ShipmentRow[];

  // Tenant delivery zones feed the ETA mirror (settings.commerce.deliveryZones).
  const { data: commerce } = trpc.tenantConfig.getCommerceConfig.useQuery({ tenantId });
  const zones = useMemo<EtaZone[]>(
    () =>
      ((commerce as any)?.deliveryZones ?? []).map((z: any) => ({
        name: String(z?.name ?? ""),
        etaMinutes: typeof z?.etaMinutes === "number" ? z.etaMinutes : undefined,
      })),
    [commerce],
  );

  const enriched = useMemo(
    () =>
      shipments.map((s) => {
        const coords = extractShipmentCoords(s);
        const zoneName =
          (s.recipientAddress as any)?.zone ??
          (s.recipientAddress as any)?.zoneName ??
          null;
        const eta = estimateEtaMinutes({ status: s.status, zoneName, zones });
        return { ...s, coords, eta };
      }),
    [shipments, zones],
  );

  const activeShipments = enriched.filter((s) => isActiveShipment(s.status));
  const withCoords = enriched.filter((s) => s.coords != null);

  // ── Map lifecycle ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: OSM_STYLE,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: {},
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.on("load", () => setMapReady(true));
    mapRef.current = map;
    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current.clear();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ── Marker sync ────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const seen = new Set<string>();
    for (const s of withCoords) {
      const coords = s.coords as LatLng;
      seen.add(s.id);
      const color = shipmentStatusColor(s.status);
      const popupHtml = `
        <div style="font-family:system-ui;font-size:12px;line-height:1.5;color:#111">
          <strong>Order ${escapeHtml(s.orderId.slice(0, 8))}…</strong><br/>
          Status: <span style="color:${color};font-weight:600">${escapeHtml(s.status)}</span><br/>
          ${s.carrierName ? `Carrier: ${escapeHtml(s.carrierName)}<br/>` : ""}
          ${formatEta(s.eta) ? `ETA: ${formatEta(s.eta)}<br/>` : ""}
          ${maskDeliveryPin(s.deliveryPin) ? `Delivery PIN: ${maskDeliveryPin(s.deliveryPin)}` : ""}
        </div>`;

      const existing = markersRef.current.get(s.id);
      if (existing) {
        existing.setLngLat([coords.lng, coords.lat]);
        existing.setPopup(new maplibregl.Popup({ offset: 18 }).setHTML(popupHtml));
        const el = existing.getElement();
        el.style.backgroundColor = color;
      } else {
        const el = document.createElement("div");
        el.style.cssText = `width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);cursor:pointer;`;
        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([coords.lng, coords.lat])
          .setPopup(new maplibregl.Popup({ offset: 18 }).setHTML(popupHtml))
          .addTo(map);
        markersRef.current.set(s.id, marker);
      }
    }
    // Remove markers for shipments that disappeared or lost coordinates.
    markersRef.current.forEach((marker, id) => {
      if (!seen.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    });
  }, [withCoords, mapReady]);

  // ── Focus marker from the side list ────────────────────────────────────────
  useEffect(() => {
    if (!selectedId) return;
    const map = mapRef.current;
    const marker = markersRef.current.get(selectedId);
    const target = enriched.find((s) => s.id === selectedId);
    if (map && marker && target?.coords) {
      map.flyTo({ center: [target.coords.lng, target.coords.lat], zoom: Math.max(map.getZoom(), 12) });
      marker.togglePopup();
    }
  }, [selectedId, enriched]);

  return (
    <DashboardLayout>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <MapPin className="w-6 h-6 text-primary" />
              Live Logistics Map
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Shipments with coordinates, polled every 30s. Colors reflect status; ETAs come from
              the delivery-zone ETA engine.
            </p>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => refetch()}>
            {isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </Button>
        </div>

        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-12 lg:col-span-8">
            <Card className="border-border/50 bg-card/50 overflow-hidden">
              <div ref={mapContainer} className="h-[560px] w-full" data-testid="logistics-map" />
            </Card>
            {!isLoading && shipments.length > 0 && withCoords.length === 0 && (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <MapPinOff className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                <p className="text-xs text-amber-300">
                  No shipments with coordinates yet — markers appear as soon as a shipment's
                  recipient/sender address carries lat/lng. The list on the right still tracks every
                  shipment with status and ETA.
                </p>
              </div>
            )}
          </div>

          <div className="col-span-12 lg:col-span-4">
            <Card className="border-border/50 bg-card/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                  <Truck className="w-4 h-4" />
                  Active Shipments ({activeShipments.length})
                </CardTitle>
                <p className="text-[11px] text-muted-foreground/70">
                  Updated {new Date(dataUpdatedAt).toLocaleTimeString()}
                </p>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[480px]">
                  {isLoading ? (
                    <div className="p-4 space-y-3">
                      {[1, 2, 3].map((i) => (
                        <div key={i} className="h-16 bg-muted/30 rounded-lg animate-pulse" />
                      ))}
                    </div>
                  ) : activeShipments.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">
                      <Truck className="w-10 h-10 mx-auto mb-3 opacity-30" />
                      <p className="font-medium">No active shipments</p>
                      <p className="text-xs mt-1">
                        {shipments.length > 0
                          ? "All shipments are in a terminal state (delivered / failed / returned)."
                          : "Create a shipment from the Logistics page to see it here."}
                      </p>
                    </div>
                  ) : (
                    <div className="divide-y divide-border/30">
                      {activeShipments.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => setSelectedId(s.id)}
                          className={`w-full text-left px-4 py-3 transition-colors hover:bg-muted/30 ${
                            selectedId === s.id ? "bg-primary/10 border-l-2 border-primary" : ""
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-medium text-sm text-foreground">
                              Order {s.orderId.slice(0, 8)}…
                            </span>
                            <Badge
                              variant="outline"
                              className="text-[10px] gap-1"
                              style={{ color: shipmentStatusColor(s.status), borderColor: `${shipmentStatusColor(s.status)}55` }}
                            >
                              <span
                                className="inline-block w-1.5 h-1.5 rounded-full"
                                style={{ background: shipmentStatusColor(s.status) }}
                              />
                              {s.status.replace(/_/g, " ")}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            <span className="truncate">{s.recipientName ?? "—"}</span>
                            {formatEta(s.eta) && <span>ETA {formatEta(s.eta)}</span>}
                            {s.coords == null && <span className="text-amber-400/80">no coords</span>}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}
