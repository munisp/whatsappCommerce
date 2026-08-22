/**
 * MedusaStorefrontSettings — W28 merchant self-service for the Medusa ↔
 * storefront integration: connect a Medusa store (per-tenant mapping),
 * test the connection, run a full catalog backfill, and toggle which catalog
 * the public storefront renders (platform-native vs synced Medusa).
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
import { ArrowDownToLine, Loader2, Plug, RefreshCw, Store } from "lucide-react";

export default function MedusaStorefrontSettings() {
  const utils = trpc.useUtils();
  const mappingQuery = trpc.medusa.getMapping.useQuery();

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [storeId, setStoreId] = useState("");
  const [salesChannelId, setSalesChannelId] = useState("");

  useEffect(() => {
    const m = (mappingQuery.data as any)?.mapping;
    if (!m) return;
    setBaseUrl(m.baseUrl ?? "");
    setStoreId(m.medusaStoreId ?? "");
    setSalesChannelId(m.medusaSalesChannelId ?? "");
  }, [mappingQuery.data]);

  const mapping = (mappingQuery.data as any)?.mapping ?? null;
  const invalidate = () => utils.medusa.getMapping.invalidate();

  const connect = trpc.medusa.upsertMapping.useMutation({
    onSuccess: () => {
      toast.success("Medusa store connected");
      setApiKey("");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const test = trpc.medusa.testMapping.useMutation({
    onSuccess: (r) => {
      if (r.ok) toast.success("Connection OK");
      else toast.error(`Connection failed: ${r.error ?? "unknown error"}`);
    },
    onError: (e) => toast.error(e.message),
  });

  const backfill = trpc.medusa.backfillCatalog.useMutation({
    onSuccess: (r) => {
      toast.success(`Backfill complete: ${r.created} created, ${r.updated} updated`);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const setSource = trpc.medusa.setCatalogSource.useMutation({
    onSuccess: (r) => {
      toast.success(`Storefront catalog source: ${r.catalogSource}`);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const pending = connect.isPending || test.isPending || backfill.isPending || setSource.isPending;

  return (
    <TenantPortalLayout>
      <div className="max-w-2xl space-y-6 p-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Plug className="h-6 w-6" /> Medusa storefront
          </h1>
          <p className="text-muted-foreground">
            Connect your Medusa store, sync its catalog, and choose which catalog your public shop shows.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Connection</CardTitle>
            <CardDescription>
              Your own Medusa instance. The admin API key is encrypted at rest and never shown again.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="medusa-base-url">Medusa base URL</Label>
              <Input
                id="medusa-base-url"
                placeholder="https://medusa.example.com"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="medusa-api-key">Admin API key{mapping ? " (leave blank to keep current)" : ""}</Label>
              <Input
                id="medusa-api-key"
                type="password"
                placeholder={mapping ? "••••••••" : "sk_…"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="medusa-store-id">Store ID (optional)</Label>
                <Input id="medusa-store-id" value={storeId} onChange={(e) => setStoreId(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="medusa-channel-id">Sales channel ID (optional)</Label>
                <Input id="medusa-channel-id" value={salesChannelId} onChange={(e) => setSalesChannelId(e.target.value)} />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={pending || !baseUrl || (!mapping && !apiKey)}
                onClick={() =>
                  connect.mutate({
                    baseUrl,
                    ...(apiKey ? { apiKey } : {}),
                    medusaStoreId: storeId || undefined,
                    medusaSalesChannelId: salesChannelId || undefined,
                  })
                }
              >
                {connect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {mapping ? "Update connection" : "Connect store"}
              </Button>
              <Button variant="outline" disabled={pending || !mapping} onClick={() => test.mutate()}>
                {test.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Test connection
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Catalog sync</CardTitle>
            <CardDescription>
              Pull the full Medusa catalog now (webhooks keep it in sync afterwards). Synced products
              never overwrite your own platform products.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button variant="outline" disabled={pending || !mapping} onClick={() => backfill.mutate()}>
              {backfill.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowDownToLine className="mr-2 h-4 w-4" />}
              Backfill catalog from Medusa
            </Button>
            {mapping?.lastBackfillAt && (
              <p className="text-sm text-muted-foreground">
                Last backfill: {new Date(mapping.lastBackfillAt).toLocaleString()}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Store className="h-5 w-5" /> Storefront catalog source
            </CardTitle>
            <CardDescription>
              Choose which catalog your public shop page renders.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">
                {mapping?.catalogSource === "medusa" ? "Medusa catalog" : "Platform catalog"}
              </p>
              <p className="text-sm text-muted-foreground">
                {mapping?.catalogSource === "medusa"
                  ? "Visitors see the synced Medusa catalog."
                  : "Visitors see your native WhatsApp catalog products."}
              </p>
            </div>
            <Switch
              disabled={pending || !mapping}
              checked={mapping?.catalogSource === "medusa"}
              onCheckedChange={(on) => setSource.mutate({ source: on ? "medusa" : "platform" })}
              aria-label="Use Medusa catalog"
            />
          </CardContent>
        </Card>
      </div>
    </TenantPortalLayout>
  );
}
