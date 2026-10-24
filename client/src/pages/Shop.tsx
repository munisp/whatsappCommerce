/**
 * Shop — public shareable storefront (/shop/:slug).
 *
 * Renders the merchant's branding (theme color + hero text), the catalog
 * synced from the WhatsApp catalog products, prices, a WhatsApp
 * click-to-chat order CTA, and — only when the merchant opted in and is
 * KYB-approved — the business location. This page is PUBLIC (no auth): the
 * server returns a PII-scrubbed view only (see server/routers/storefront.ts
 * and services/storefront.ts).
 */
import { useState } from "react";
import { useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, MapPin, MessageCircle, Share2, ShoppingBag, Sparkles, Store } from "lucide-react";

interface StorefrontProduct {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  price: string;
  currency: string;
  imageUrl: string | null;
  inStock: boolean;
}

// === W64 intelligence (R1) ===
/**
 * Tap-to-expand "Customers also bought" strip for a storefront product card.
 * Calls the public recs.forProduct co-purchase endpoint; graceful empty
 * state (renders nothing when there are no pairs yet). Recs are
 * telemetry-grade and fail-open — the card is unaffected on any error.
 */
function RecsStrip({ tenantId, productId }: { tenantId: string; productId: string }) {
  const recsQ = trpc.recs.forProduct.useQuery(
    { tenantId, productId, limit: 4 },
    { retry: false, staleTime: 60_000 },
  );
  const recs = recsQ.data?.recommendations ?? [];
  if (recsQ.isLoading) {
    return (
      <div className="px-4 pb-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Finding related items…
      </div>
    );
  }
  if (recs.length === 0) return null; // empty-state: no co-purchase pairs yet
  return (
    <div className="px-4 pb-4 border-t pt-3 space-y-2">
      <p className="text-xs font-medium flex items-center gap-1 text-muted-foreground">
        <Sparkles className="h-3 w-3" /> Customers also bought
      </p>
      <div className="grid grid-cols-2 gap-2">
        {recs.map((r) => (
          <div key={r.productId} className="flex items-center gap-2 rounded border p-2">
            {r.imageUrl && (
              <img
                src={r.imageUrl}
                alt={r.name}
                width={32}
                height={32}
                loading="lazy"
                decoding="async"
                className="h-8 w-8 rounded object-cover flex-shrink-0"
              />
            )}
            <div className="min-w-0">
              <p className="text-xs font-medium truncate">{r.name}</p>
              <p className="text-xs text-muted-foreground">
                {r.currency} {Number(r.price).toLocaleString()}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
// === END W64 intelligence (R1) ===

export default function Shop() {
  const params = useParams<{ slug: string }>();
  const slug = (params.slug ?? "").toLowerCase();
  const query = trpc.storefront.getBySlug.useQuery(
    { slug },
    { enabled: slug.length > 0, retry: false },
  );
  // === W64 intelligence (R1): tap-to-expand recs strip state ===
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);

  if (query.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 p-6 text-center">
        <Store className="h-10 w-10 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Storefront not found</h1>
        <p className="text-muted-foreground max-w-md">
          This shop link is invalid or the shop is not published yet.
        </p>
      </div>
    );
  }

  const shop = query.data;
  const theme = shop.themeColor || "#075E54";
  const catalog = (shop.catalog ?? []) as StorefrontProduct[];
  const chatUrl = shop.whatsappPhoneNumberId
    ? `https://wa.me/${shop.whatsappPhoneNumberId}?text=${encodeURIComponent(
        `Hello ${shop.businessName}! I'd like to place an order from your online shop.`,
      )}`
    : null;

  // === W55 pwa (MOB-6): Web Share API with wa.me fallback ===
  // Mirrors the shareDeal pack shape (blurb + link, server/services/shareDeal.ts)
  // for the storefront: a one-line blurb plus the shop URL. navigator.share is
  // progressive enhancement — desktop browsers without it fall back to a
  // wa.me share link (same channel the chat share pack targets).
  const shopUrl = typeof window !== "undefined" ? window.location.href : "";
  const shareText = `${shop.businessName} — order on WhatsApp Commerce: ${shopUrl}`;
  const waShareUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
  const canNativeShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";
  const handleShare = async () => {
    try {
      await navigator.share({ title: shop.businessName, text: shareText, url: shopUrl });
    } catch {
      /* user dismissed the share sheet or share failed — no-op */
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Hero / branding */}
      <header className="text-white" style={{ backgroundColor: theme }}>
        <div className="max-w-3xl mx-auto px-4 py-10">
          <h1 className="text-3xl font-bold">{shop.businessName}</h1>
          {shop.heroText && <p className="mt-2 text-white/90">{shop.heroText}</p>}
          {chatUrl && (
            <Button asChild className="mt-4 bg-white text-black hover:bg-white/90">
              <a href={chatUrl} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="mr-2 h-4 w-4" />
                Order on WhatsApp
              </a>
            </Button>
          )}
          {/* W55 pwa (MOB-6): native share sheet where available, wa.me otherwise */}
          {canNativeShare ? (
            <Button
              type="button"
              onClick={handleShare}
              variant="outline"
              className="mt-4 ml-2 border-white text-white hover:bg-white/10 bg-transparent"
            >
              <Share2 className="mr-2 h-4 w-4" />
              Share shop
            </Button>
          ) : (
            <Button asChild variant="outline" className="mt-4 ml-2 border-white text-white hover:bg-white/10 bg-transparent">
              <a href={waShareUrl} target="_blank" rel="noopener noreferrer">
                <Share2 className="mr-2 h-4 w-4" />
                Share on WhatsApp
              </a>
            </Button>
          )}
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        {shop.location && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MapPin className="h-4 w-4" />
            <span>
              {[shop.location.label, shop.location.city, shop.location.country]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        )}

        <section>
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
            <ShoppingBag className="h-5 w-5" /> Products
            {/* W28: badge the synced Medusa catalog (view-model flag only). */}
            {(shop as { catalogSource?: string }).catalogSource === "medusa" && (
              <Badge variant="secondary">Medusa catalog</Badge>
            )}
          </h2>
          {catalog.length === 0 ? (
            <p className="text-muted-foreground">No products listed yet — check back soon.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {catalog.map((p) => (
                <Card
                  key={p.id}
                  className={`${p.inStock ? "" : "opacity-60"} cursor-pointer`}
                  onClick={() => setExpandedProductId((cur) => (cur === p.id ? null : p.id))}
                >
                  <CardContent className="p-4 flex gap-3">
                    {p.imageUrl && (
                      <img
                        src={p.imageUrl}
                        alt={p.name}
                        width={64}
                        height={64}
                        loading="lazy"
                        decoding="async"
                        className="h-16 w-16 rounded object-cover flex-shrink-0"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-medium truncate">{p.name}</h3>
                        {!p.inStock && <Badge variant="outline">Out of stock</Badge>}
                      </div>
                      {p.description && (
                        <p className="text-sm text-muted-foreground line-clamp-2">{p.description}</p>
                      )}
                      <p className="mt-1 font-semibold">
                        {p.currency} {Number(p.price).toLocaleString()}
                      </p>
                    </div>
                  </CardContent>
                  {/* === W64 intelligence (R1): tap-to-expand co-purchase recs === */}
                  {expandedProductId === p.id && (shop as { tenantId?: string }).tenantId && (
                    <RecsStrip tenantId={(shop as { tenantId: string }).tenantId} productId={p.id} />
                  )}
                  {/* === END W64 intelligence (R1) === */}
                </Card>
              ))}
            </div>
          )}
        </section>

        {chatUrl && (
          <section className="pb-8">
            <Button asChild size="lg" className="w-full" style={{ backgroundColor: theme }}>
              <a href={chatUrl} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="mr-2 h-5 w-5" />
                Chat with {shop.businessName} on WhatsApp to order
              </a>
            </Button>
          </section>
        )}
      </main>
    </div>
  );
}
