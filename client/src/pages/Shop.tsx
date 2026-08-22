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
import { useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, MapPin, MessageCircle, ShoppingBag, Store } from "lucide-react";

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

export default function Shop() {
  const params = useParams<{ slug: string }>();
  const slug = (params.slug ?? "").toLowerCase();
  const query = trpc.storefront.getBySlug.useQuery(
    { slug },
    { enabled: slug.length > 0, retry: false },
  );

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
                <Card key={p.id} className={p.inStock ? "" : "opacity-60"}>
                  <CardContent className="p-4 flex gap-3">
                    {p.imageUrl && (
                      <img
                        src={p.imageUrl}
                        alt={p.name}
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
