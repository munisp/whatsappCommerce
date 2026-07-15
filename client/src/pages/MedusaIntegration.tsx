import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckCircle2, XCircle, AlertCircle } from "lucide-react";

export default function MedusaIntegration() {
  const { data: config } = trpc.medusa.isConfigured.useQuery();
  const { data: products } = trpc.medusa.listProducts.useQuery({ limit: 20 });
  const { data: orders } = trpc.medusa.listOrders.useQuery({ limit: 20 });
  const { data: regions } = trpc.medusa.listRegions.useQuery();

  const isConnected = config?.configured && !!config?.url;
  const statusIcon = isConnected
    ? <CheckCircle2 className="w-5 h-5 text-green-500" />
    : <AlertCircle className="w-5 h-5 text-yellow-500" />;
  const statusText = isConnected ? "Connected" : "Not Configured";
  const statusColor = isConnected ? "bg-green-100 text-green-800" : "bg-yellow-100 text-yellow-800";

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Medusa Commerce Integration</h1>
            <p className="text-gray-500 text-sm mt-1">Headless commerce engine — products, orders, inventory, pricing</p>
          </div>
          <div className="flex items-center gap-2">
            {statusIcon}
            <Badge className={statusColor}>{statusText}</Badge>
          </div>
        </div>

        {!isConnected && (
          <Card className="border-yellow-200 bg-yellow-50">
            <CardContent className="pt-4">
              <p className="font-semibold text-yellow-800 mb-1">Configure Medusa Connection</p>
              <p className="text-sm text-yellow-700">Add <code className="bg-yellow-100 px-1 rounded">MEDUSA_API_URL</code> and <code className="bg-yellow-100 px-1 rounded">MEDUSA_API_KEY</code> to your environment secrets to connect to a Medusa v2 instance.</p>
              <p className="text-xs text-yellow-600 mt-2">Self-host: <code>npx create-medusa-app@latest</code> or use Medusa Cloud. Then set the API URL and admin API key here.</p>
            </CardContent>
          </Card>
        )}

        <Tabs defaultValue="products">
          <TabsList>
            <TabsTrigger value="products">Products</TabsTrigger>
            <TabsTrigger value="orders">Orders</TabsTrigger>
            <TabsTrigger value="regions">Regions</TabsTrigger>
          </TabsList>

          <TabsContent value="products" className="pt-4 space-y-3">
            {(products?.products ?? []).length === 0 ? (
              <p className="text-center text-gray-400 py-8">{!isConnected ? "Connect Medusa to sync products." : "Add products in your Medusa admin."}</p>
            ) : (
              (products?.products ?? []).map((p) => (
                <Card key={p.id}><CardContent className="pt-4"><div className="flex items-center justify-between"><div><p className="font-semibold">{p.title}</p><p className="text-sm text-gray-500">{p.description ?? "No description"}</p></div><Badge>{p.status}</Badge></div></CardContent></Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="orders" className="pt-4 space-y-3">
            {(orders?.orders ?? []).length === 0 ? (
              <p className="text-center text-gray-400 py-8">{!isConnected ? "Connect Medusa to sync orders." : "Orders will appear here."}</p>
            ) : (
              (orders?.orders ?? []).map((o) => (
                <Card key={o.id}><CardContent className="pt-4"><div className="flex items-center justify-between"><div><p className="font-semibold">Order #{o.display_id}</p><p className="text-sm text-gray-500">{o.currency_code.toUpperCase()} {o.total} | {o.payment_status}</p></div><Badge>{o.status}</Badge></div></CardContent></Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="regions" className="pt-4 space-y-3">
            {(regions?.regions ?? []).length === 0 ? (
              <p className="text-center text-gray-400 py-8">{!isConnected ? "Connect Medusa to view regions." : "Add regions in Medusa admin."}</p>
            ) : (
              (regions?.regions ?? []).map((r) => (
                <Card key={r.id}><CardContent className="pt-4"><div className="flex items-center justify-between"><div><p className="font-semibold">{r.name}</p><p className="text-sm text-gray-500">Currency: {r.currency_code}</p></div></div></CardContent></Card>
              ))
            )}
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
