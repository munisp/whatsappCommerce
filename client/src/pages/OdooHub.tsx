import DashboardLayout from "@/components/DashboardLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OdooERPContent } from "@/pages/OdooERP";
import { OdooMedusaBridgeContent } from "@/pages/OdooMedusaBridge";

// Direct Odoo connection + orders/invoices, and the narrower Odoo→Medusa
// stock mapping, were two separate "Odoo-adjacent" nav items split across
// different groups (Integrations vs. Commerce & Catalog). Both live under
// Odoo here since neither is a daily merchant workflow.
export default function OdooHub() {
  return (
    <DashboardLayout>
      <div className="p-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Odoo</h1>
          <p className="text-sm text-muted-foreground mt-1">
            ERP connection, synced orders/invoices, and the Medusa inventory bridge
          </p>
        </div>
        <Tabs defaultValue="connection">
          <TabsList>
            <TabsTrigger value="connection">Connection & Orders</TabsTrigger>
            <TabsTrigger value="bridge">Medusa Bridge</TabsTrigger>
          </TabsList>
          <TabsContent value="connection" className="pt-4">
            <OdooERPContent />
          </TabsContent>
          <TabsContent value="bridge" className="pt-4">
            <OdooMedusaBridgeContent />
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
