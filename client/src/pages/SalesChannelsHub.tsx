import DashboardLayout from "@/components/DashboardLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarketplacePortalContent } from "@/pages/MarketplacePortal";
import { B2BPortalContent } from "@/pages/B2BPortal";
import { ServiceCommercePageContent } from "@/pages/ServiceCommercePage";

// Three alternative ways to sell beyond the default retail catalog —
// multi-seller marketplace, wholesale/B2B, and appointments/subscriptions/
// digital goods. Each was a thin standalone page; grouped as siblings here
// instead of three more top-level nav items.
export default function SalesChannelsHub() {
  return (
    <DashboardLayout>
      <div className="p-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Sales Channels</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Alternative ways to sell beyond the default retail catalog
          </p>
        </div>
        <Tabs defaultValue="marketplace">
          <TabsList>
            <TabsTrigger value="marketplace">Marketplace</TabsTrigger>
            <TabsTrigger value="b2b">B2B</TabsTrigger>
            <TabsTrigger value="services">Services</TabsTrigger>
          </TabsList>
          <TabsContent value="marketplace" className="pt-4">
            <MarketplacePortalContent />
          </TabsContent>
          <TabsContent value="b2b" className="pt-4">
            <B2BPortalContent />
          </TabsContent>
          <TabsContent value="services" className="pt-4">
            <ServiceCommercePageContent />
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
