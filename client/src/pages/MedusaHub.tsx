import DashboardLayout from "@/components/DashboardLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MedusaIntegrationContent } from "@/pages/MedusaIntegration";
import { MedusaOnboardingContent } from "@/pages/MedusaOnboarding";

// Overview (read: browse synced products/orders/regions) and Add Products
// (write: draft and push new products to Medusa) are the read/write halves
// of the same Medusa connection — were two separate nav items.
export default function MedusaHub() {
  return (
    <DashboardLayout>
      <div className="p-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Medusa</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Headless commerce engine — browse synced state or add new products
          </p>
        </div>
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="add">Add Products</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="pt-4">
            <MedusaIntegrationContent />
          </TabsContent>
          <TabsContent value="add" className="pt-4">
            <MedusaOnboardingContent />
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
