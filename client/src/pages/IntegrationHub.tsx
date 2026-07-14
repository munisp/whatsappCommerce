import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";
import {
  Users, Package, Smartphone, ArrowRight, CheckCircle2,
  XCircle, AlertCircle, Zap, Globe, Database, MessageSquare
} from "lucide-react";

function IntegrationCard({
  name, description, icon: Icon, iconBg, iconColor,
  status, stats, href, features
}: {
  name: string; description: string; icon: React.ElementType;
  iconBg: string; iconColor: string;
  status: "connected" | "disconnected" | "error";
  stats: { label: string; value: string | number }[];
  href: string; features: string[];
}) {
  const statusMap = {
    connected: { icon: CheckCircle2, color: "text-green-400", label: "Connected", bg: "bg-green-500/10 border-green-500/20" },
    disconnected: { icon: AlertCircle, color: "text-zinc-400", label: "Not Connected", bg: "bg-zinc-500/10 border-zinc-500/20" },
    error: { icon: XCircle, color: "text-red-400", label: "Error", bg: "bg-red-500/10 border-red-500/20" },
  };
  const s = statusMap[status];
  const StatusIcon = s.icon;

  return (
    <Card className="bg-card border-border hover:border-primary/30 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-12 h-12 rounded-xl ${iconBg} border flex items-center justify-center`}>
              <Icon className={`w-6 h-6 ${iconColor}`} />
            </div>
            <div>
              <CardTitle className="text-base">{name}</CardTitle>
              <div className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border mt-1 ${s.bg} ${s.color}`}>
                <StatusIcon className="w-3 h-3" />
                {s.label}
              </div>
            </div>
          </div>
        </div>
        <CardDescription className="text-sm mt-2">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-2">
          {stats.map(stat => (
            <div key={stat.label} className="bg-muted/50 rounded-lg p-2 text-center">
              <div className="font-bold text-sm">{stat.value}</div>
              <div className="text-[10px] text-muted-foreground">{stat.label}</div>
            </div>
          ))}
        </div>
        {/* Features */}
        <div className="space-y-1">
          {features.map(f => (
            <div key={f} className="flex items-center gap-2 text-xs text-muted-foreground">
              <Zap className="w-3 h-3 text-primary shrink-0" />
              {f}
            </div>
          ))}
        </div>
        <Link href={href}>
          <Button className="w-full gap-2 bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20" variant="outline">
            {status === "disconnected" ? "Configure" : "Manage"} <ArrowRight className="w-4 h-4" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

export default function IntegrationHub() {
  const { data: twentyCfg } = trpc.twenty.getConfig.useQuery();
  const { data: odooCfg } = trpc.odoo.getConfig.useQuery();
  const { data: menus = [] } = trpc.menu.list.useQuery();
  const { data: contacts } = trpc.twenty.listContacts.useQuery({ limit: 50, offset: 0 });
  const { data: deals } = trpc.twenty.listDeals.useQuery({ limit: 50, offset: 0 });
  const { data: products } = trpc.odoo.listProducts.useQuery({ limit: 50, offset: 0 });
  const { data: orders } = trpc.odoo.listOrders.useQuery({ limit: 50, offset: 0 });

  const publishedMenus = menus.filter(m => m.status === "published").length;
  const pushedMenus = menus.filter(m => m.pushStatus === "success").length;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">Integration Hub</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Connect Twenty CRM and Odoo ERP to power your WhatsApp commerce experience
          </p>
        </div>

        {/* Summary bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Active Integrations", value: [twentyCfg?.status === "connected", odooCfg?.status === "connected"].filter(Boolean).length + "/2", icon: Globe, color: "text-primary" },
            { label: "Synced Records", value: (contacts?.contacts?.length ?? 0) + (products?.products?.length ?? 0), icon: Database, color: "text-blue-400" },
            { label: "WhatsApp Menus", value: menus.length, icon: Smartphone, color: "text-green-400" },
            { label: "Pushed to WA", value: pushedMenus, icon: MessageSquare, color: "text-primary" },
          ].map(k => (
            <Card key={k.label} className="bg-card border-border">
              <CardContent className="p-4 flex items-center gap-3">
                <k.icon className={`w-8 h-8 ${k.color}`} />
                <div>
                  <div className="text-xl font-bold">{k.value}</div>
                  <div className="text-xs text-muted-foreground">{k.label}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Integration cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <IntegrationCard
            name="Twenty CRM"
            description="Open-source CRM for managing contacts, deals, and pipeline. Sync contacts to WhatsApp and send messages directly from deal cards."
            icon={Users}
            iconBg="bg-violet-500/20"
            iconColor="text-violet-400"
            status={(twentyCfg?.status as "connected" | "disconnected" | "error") ?? "disconnected"}
            stats={[
              { label: "Contacts", value: contacts?.contacts?.length ?? 0 },
              { label: "Deals", value: deals?.deals?.length ?? 0 },
              { label: "WA Sent", value: contacts?.contacts?.filter(c => c.lastWhatsappAt).length ?? 0 },
            ]}
            href="/twenty-crm"
            features={[
              "Sync contacts & deal pipeline",
              "Send WhatsApp from contact cards",
              "Auto-populate menus from deals",
              "Deal stage tracking",
            ]}
          />
          <IntegrationCard
            name="Odoo ERP"
            description="Full-featured ERP for inventory, sales orders, and invoicing. Push product catalogs to WhatsApp menus and send order/invoice notifications."
            icon={Package}
            iconBg="bg-orange-500/20"
            iconColor="text-orange-400"
            status={(odooCfg?.status as "connected" | "disconnected" | "error") ?? "disconnected"}
            stats={[
              { label: "Products", value: products?.products?.length ?? 0 },
              { label: "Orders", value: orders?.orders?.length ?? 0 },
              { label: "Categories", value: Array.from(new Set(products?.products?.map(p => p.category).filter(Boolean))).length },
            ]}
            href="/odoo-erp"
            features={[
              "Sync products, orders & invoices",
              "Send order status via WhatsApp",
              "Invoice payment reminders",
              "Auto-populate menus from inventory",
            ]}
          />
          <IntegrationCard
            name="WhatsApp Menu Builder"
            description="Visual menu builder that pulls live data from Odoo inventory and Twenty CRM. Build, preview, and push interactive menus to WhatsApp in one click."
            icon={Smartphone}
            iconBg="bg-primary/20"
            iconColor="text-primary"
            status={menus.length > 0 ? "connected" : "disconnected"}
            stats={[
              { label: "Menus", value: menus.length },
              { label: "Published", value: publishedMenus },
              { label: "Pushed", value: pushedMenus },
            ]}
            href="/menu-builder"
            features={[
              "Visual tree editor with phone preview",
              "Auto-populate from Odoo & Twenty",
              "Push interactive lists to WhatsApp",
              "Section, quick reply & URL types",
            ]}
          />
        </div>

        {/* How it works */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base">How It Works</CardTitle>
            <CardDescription>End-to-end data flow from your business systems to WhatsApp</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col md:flex-row items-center gap-4">
              {[
                { step: "1", title: "Connect", desc: "Link Odoo ERP and Twenty CRM via API keys", icon: Globe, color: "bg-blue-500/20 border-blue-500/30 text-blue-400" },
                { step: "2", title: "Sync", desc: "Pull products, inventory, contacts, and deals", icon: Database, color: "bg-orange-500/20 border-orange-500/30 text-orange-400" },
                { step: "3", title: "Build", desc: "Auto-populate menus from live business data", icon: Zap, color: "bg-yellow-500/20 border-yellow-500/30 text-yellow-400" },
                { step: "4", title: "Push", desc: "Send interactive menus to WhatsApp customers", icon: MessageSquare, color: "bg-primary/20 border-primary/30 text-primary" },
              ].map((s, i) => (
                <div key={s.step} className="flex items-center gap-4 flex-1">
                  <div className={`w-12 h-12 rounded-xl border ${s.color} flex items-center justify-center shrink-0`}>
                    <s.icon className="w-5 h-5" />
                  </div>
                  <div className="flex-1">
                    <div className="font-semibold text-sm">{s.step}. {s.title}</div>
                    <div className="text-xs text-muted-foreground">{s.desc}</div>
                  </div>
                  {i < 3 && <ArrowRight className="w-4 h-4 text-muted-foreground hidden md:block shrink-0" />}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
