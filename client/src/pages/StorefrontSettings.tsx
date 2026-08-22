/**
 * StorefrontSettings — merchant self-service for the public storefront:
 * slug (shareable /shop/:slug URL), theme color, hero text, visibility
 * toggle, location publication opt-in (requires approved KYB), and the
 * default storefront language.
 */
import { useEffect, useState } from "react";
import { TenantPortalLayout } from "@/components/TenantPortalLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { ExternalLink, Globe, Loader2, Store } from "lucide-react";

export default function StorefrontSettings() {
  const utils = trpc.useUtils();
  const settings = trpc.storefront.merchant.getSettings.useQuery();

  const [slug, setSlug] = useState("");
  const [heroText, setHeroText] = useState("");
  const [themeColor, setThemeColor] = useState("#075E54");
  const [isVisible, setIsVisible] = useState(false);
  const [showLocation, setShowLocation] = useState(false);
  const [defaultLocale, setDefaultLocale] = useState("en");

  useEffect(() => {
    const d = settings.data as any;
    if (!d) return;
    setSlug(d.storefront?.slug ?? d.defaultSlug ?? "");
    setHeroText(d.storefront?.heroText ?? "");
    setThemeColor(d.storefront?.themeColor ?? "#075E54");
    setIsVisible(Boolean(d.storefront?.isVisible));
    setShowLocation(Boolean(d.storefront?.showLocation));
    setDefaultLocale(d.storefront?.defaultLocale ?? "en");
  }, [settings.data]);

  const save = trpc.storefront.merchant.upsertSettings.useMutation({
    onSuccess: () => {
      toast.success("Storefront settings saved");
      utils.storefront.merchant.getSettings.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const locales = (settings.data as any)?.supportedLocales ?? [];
  const shopPath = slug ? `/shop/${slug}` : null;

  return (
    <TenantPortalLayout>
      <div className="max-w-2xl space-y-6 p-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Store className="h-6 w-6" /> Online storefront
          </h1>
          <p className="text-muted-foreground">
            Your public web shop, synced with your WhatsApp catalog. Share the link anywhere.
          </p>
        </div>

        {settings.isLoading ? (
          <Loader2 className="h-6 w-6 animate-spin" />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Storefront settings</CardTitle>
              <CardDescription>
                {shopPath && (
                  <a
                    href={shopPath}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary underline"
                  >
                    {shopPath} <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="sf-slug">Shop link (slug)</Label>
                <Input
                  id="sf-slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  placeholder="my-shop"
                />
                <p className="text-xs text-muted-foreground">
                  Lowercase letters, digits and hyphens. Must be unique across all shops.
                </p>
              </div>

              <div className="space-y-1">
                <Label htmlFor="sf-hero">Hero text</Label>
                <Input
                  id="sf-hero"
                  value={heroText}
                  onChange={(e) => setHeroText(e.target.value)}
                  maxLength={280}
                  placeholder="Fresh groceries delivered same day in Kano"
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="sf-theme">Theme color</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="sf-theme"
                    value={themeColor}
                    onChange={(e) => setThemeColor(e.target.value)}
                    className="w-32"
                  />
                  <span
                    className="h-8 w-8 rounded border"
                    style={{ backgroundColor: /^#[0-9a-fA-F]{6}$/.test(themeColor) ? themeColor : "#075E54" }}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="sf-locale" className="flex items-center gap-1">
                  <Globe className="h-4 w-4" /> Default language
                </Label>
                <select
                  id="sf-locale"
                  className="w-full rounded border bg-background p-2"
                  value={defaultLocale}
                  onChange={(e) => setDefaultLocale(e.target.value)}
                >
                  {locales.map((l: any) => (
                    <option key={l.code} value={l.code}>{l.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label>Published (visible to anyone with the link)</Label>
                </div>
                <Switch checked={isVisible} onCheckedChange={setIsVisible} />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label>Show business location on the storefront</Label>
                  {(settings.data as any)?.kybApproved === false && showLocation && (
                    <p className="text-xs text-amber-600">
                      Location is only published after your business verification (KYB) is approved.
                    </p>
                  )}
                </div>
                <Switch checked={showLocation} onCheckedChange={setShowLocation} />
              </div>

              <Button
                className="w-full"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({ slug, heroText: heroText || null, themeColor, isVisible, showLocation, defaultLocale })
                }
              >
                {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save settings
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </TenantPortalLayout>
  );
}
