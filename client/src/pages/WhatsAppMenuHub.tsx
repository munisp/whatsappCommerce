import DashboardLayout from "@/components/DashboardLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MenuBuilderContent } from "@/pages/MenuBuilder";
import { WaMenuBuilderContent } from "@/pages/WaMenuBuilder";

// Two separate systems that both answer "what does a buyer see when they
// message this store": interactive WhatsApp buttons/lists (menu/menuItem
// tables, pushed via the Cloud API) vs. the plain numbered text menu
// (tenantConfig.waMenu). Same identical page title in both source files
// made them look like duplicates — they aren't, so this groups them as
// tabs of one destination instead of two confusingly-named nav items.
export default function WhatsAppMenuHub() {
  return (
    <DashboardLayout>
      <div className="p-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">WhatsApp Menu</h1>
          <p className="text-sm text-muted-foreground mt-1">
            What buyers see when they message your WhatsApp number — interactive buttons/lists, or a plain text menu
          </p>
        </div>
        <Tabs defaultValue="interactive">
          <TabsList>
            <TabsTrigger value="interactive">Interactive Menu</TabsTrigger>
            <TabsTrigger value="text">Text Menu</TabsTrigger>
          </TabsList>
          <TabsContent value="interactive" className="pt-4">
            <MenuBuilderContent />
          </TabsContent>
          <TabsContent value="text" className="pt-4">
            <WaMenuBuilderContent />
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
