import DashboardLayout from "@/components/DashboardLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InventorySyncContent } from "@/pages/InventorySync";
import { VisualInventoryContent } from "@/pages/VisualInventory";
import { ProductImageCollectorContent } from "@/pages/ProductImageCollector";
import { FmcgTaxonomyContent } from "@/pages/FmcgTaxonomy";

// Odoo-synced stock counts, AI shelf-photo counting, the training photos
// that feed that AI, and the product reference data that feeds its
// autocomplete — four pages that were previously four separate top-level
// nav items despite all converging on the same inventory data.
export default function InventoryHub() {
  return (
    <DashboardLayout>
      <div className="p-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Inventory</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Stock levels, AI-assisted counting, and the training data behind it
          </p>
        </div>
        <Tabs defaultValue="sync">
          <TabsList>
            <TabsTrigger value="sync">Stock Sync</TabsTrigger>
            <TabsTrigger value="visual">Visual Count</TabsTrigger>
            <TabsTrigger value="training">Photo Training</TabsTrigger>
            <TabsTrigger value="taxonomy">Taxonomy</TabsTrigger>
          </TabsList>
          <TabsContent value="sync" className="pt-4">
            <InventorySyncContent />
          </TabsContent>
          <TabsContent value="visual" className="pt-4">
            <VisualInventoryContent />
          </TabsContent>
          <TabsContent value="training" className="pt-4">
            <ProductImageCollectorContent />
          </TabsContent>
          <TabsContent value="taxonomy" className="pt-4">
            <FmcgTaxonomyContent />
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
