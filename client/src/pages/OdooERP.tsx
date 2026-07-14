import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Package, ShoppingBag, FileText, RefreshCw, Settings,
  MessageSquare, Send, Loader2, CheckCircle2, AlertCircle,
  DollarSign, BarChart3, Phone, TrendingUp
} from "lucide-react";

const ORDER_STATE_COLORS: Record<string, string> = {
  draft: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  sent: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  sale: "bg-green-500/20 text-green-400 border-green-500/30",
  done: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  cancel: "bg-red-500/20 text-red-400 border-red-500/30",
};
const INVOICE_STATE_COLORS: Record<string, string> = {
  draft: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  posted: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  cancel: "bg-red-500/20 text-red-400 border-red-500/30",
  paid: "bg-green-500/20 text-green-400 border-green-500/30",
};

function StateBadge({ state, map }: { state?: string | null; map: Record<string, string> }) {
  const cls = map[state ?? ""] ?? "bg-muted text-muted-foreground border-border";
  return <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${cls}`}>{state ?? "—"}</span>;
}

function StatusDot({ status }: { status: string }) {
  const map: Record<string, string> = { connected: "bg-green-400", disconnected: "bg-zinc-500", error: "bg-red-400" };
  return <span className={`inline-block w-2 h-2 rounded-full ${map[status] ?? "bg-zinc-500"}`} />;
}

export default function OdooERP() {
  const [configOpen, setConfigOpen] = useState(false);
  const [form, setForm] = useState({ baseUrl: "https://mycompany.odoo.com", database: "mydb", username: "admin", apiKey: "", syncProducts: true, syncOrders: true, syncInvoices: true, whatsappEnabled: true });
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTarget, setSendTarget] = useState<{ type: "order" | "invoice"; id: string; name: string; phone: string } | null>(null);
  const [sendMsg, setSendMsg] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const { data: templatesData } = trpc.template.list.useQuery({ limit: 50 });
  const templates = templatesData?.templates ?? [];

  const { data: config, refetch: refetchConfig } = trpc.odoo.getConfig.useQuery();
  const { data: productsData, refetch: refetchProducts } = trpc.odoo.listProducts.useQuery({ limit: 50, offset: 0 });
  const { data: ordersData, refetch: refetchOrders } = trpc.odoo.listOrders.useQuery({ limit: 50, offset: 0 });
  const { data: invoicesData, refetch: refetchInvoices } = trpc.odoo.listInvoices.useQuery({ limit: 50, offset: 0 });

  const saveConfig = trpc.odoo.saveConfig.useMutation({
    onSuccess: () => { toast.success("Odoo ERP configuration saved"); refetchConfig(); setConfigOpen(false); },
    onError: (e) => toast.error(e.message),
  });
  const testConn = trpc.odoo.testConnection.useMutation({
    onSuccess: (d) => { toast[d.success ? "success" : "error"](d.success ? "Connection successful!" : "Connection failed"); refetchConfig(); },
    onError: (e) => toast.error(e.message),
  });
  const syncAll = trpc.odoo.syncAll.useMutation({
    onSuccess: (d) => {
      toast.success(`Synced: ${d.productsSynced} products, ${d.ordersSynced} orders, ${d.invoicesSynced} invoices`);
      refetchProducts(); refetchOrders(); refetchInvoices(); refetchConfig();
    },
    onError: (e) => toast.error(e.message),
  });
  const sendWhatsApp = trpc.odoo.sendWhatsApp.useMutation({
    onSuccess: () => { toast.success("WhatsApp notification sent!"); setSendOpen(false); setSendMsg(""); refetchOrders(); refetchInvoices(); },
    onError: (e) => toast.error(e.message),
  });

  const products = productsData?.products ?? [];
  const orders = ordersData?.orders ?? [];
  const invoices = invoicesData?.invoices ?? [];
  const status = config?.status ?? "disconnected";

  const totalRevenue = orders.filter(o => o.state === "sale" || o.state === "done").reduce((s, o) => s + Number(o.amountTotal ?? 0), 0);
  const unpaidInvoices = invoices.filter(i => i.state === "posted" && Number(i.amountResidual ?? 0) > 0);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-orange-500/20 border border-orange-500/30 flex items-center justify-center">
              <Package className="w-5 h-5 text-orange-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Odoo ERP</h1>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <StatusDot status={status} />
                <span className="capitalize">{status}</span>
                {config?.lastSyncAt && <span>· Last sync: {new Date(config.lastSyncAt).toLocaleString()}</span>}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => syncAll.mutate()} disabled={syncAll.isPending || status === "disconnected"} className="gap-2 border-border">
              {syncAll.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Sync Now
            </Button>
            <Dialog open={configOpen} onOpenChange={setConfigOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2 border-border"><Settings className="w-4 h-4" /> Configure</Button>
              </DialogTrigger>
              <DialogContent className="bg-card border-border max-w-md">
                <DialogHeader><DialogTitle>Odoo ERP Connection</DialogTitle></DialogHeader>
                <div className="space-y-4 pt-2">
                  {[
                    { key: "baseUrl", label: "Odoo URL", placeholder: "https://mycompany.odoo.com" },
                    { key: "database", label: "Database Name", placeholder: "mydb" },
                    { key: "username", label: "Username", placeholder: "admin" },
                    { key: "apiKey", label: "API Key", placeholder: "your-odoo-api-key", type: "password" },
                  ].map(f => (
                    <div key={f.key} className="space-y-1.5">
                      <Label>{f.label}</Label>
                      <Input type={f.type} value={form[f.key as keyof typeof form] as string} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))} placeholder={f.placeholder} className="bg-background border-border" />
                    </div>
                  ))}
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    {[{ key: "syncProducts", label: "Sync Products" }, { key: "syncOrders", label: "Sync Orders" }, { key: "syncInvoices", label: "Sync Invoices" }, { key: "whatsappEnabled", label: "WhatsApp Enabled" }].map(({ key, label }) => (
                      <div key={key} className="flex items-center gap-2">
                        <Switch checked={form[key as keyof typeof form] as boolean} onCheckedChange={v => setForm(p => ({ ...p, [key]: v }))} />
                        <Label className="text-sm">{label}</Label>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2 pt-2">
                    <Button variant="outline" size="sm" className="border-border gap-2" onClick={() => testConn.mutate({ baseUrl: form.baseUrl, database: form.database, username: form.username, apiKey: form.apiKey })} disabled={testConn.isPending}>
                      {testConn.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />} Test
                    </Button>
                    <Button size="sm" className="flex-1 bg-primary text-primary-foreground" onClick={() => saveConfig.mutate(form)} disabled={saveConfig.isPending}>
                      {saveConfig.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null} Save
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Products", value: products.length, icon: Package, color: "text-orange-400" },
            { label: "Sales Orders", value: orders.length, icon: ShoppingBag, color: "text-blue-400" },
            { label: "Invoices", value: invoices.length, icon: FileText, color: "text-purple-400" },
            { label: "Unpaid", value: `$${unpaidInvoices.reduce((s, i) => s + Number(i.amountResidual ?? 0), 0).toLocaleString()}`, icon: AlertCircle, color: "text-red-400" },
          ].map(kpi => (
            <Card key={kpi.label} className="bg-card border-border">
              <CardContent className="p-4 flex items-center gap-3">
                <kpi.icon className={`w-8 h-8 ${kpi.color}`} />
                <div>
                  <div className="text-xl font-bold">{kpi.value}</div>
                  <div className="text-xs text-muted-foreground">{kpi.label}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Tabs defaultValue="products">
          <TabsList className="bg-muted border border-border">
            <TabsTrigger value="products">Products ({products.length})</TabsTrigger>
            <TabsTrigger value="orders">Orders ({orders.length})</TabsTrigger>
            <TabsTrigger value="invoices">Invoices ({invoices.length})</TabsTrigger>
          </TabsList>

          {/* Products */}
          <TabsContent value="products" className="mt-4">
            <Card className="bg-card border-border">
              <CardHeader className="pb-3"><CardTitle className="text-base">Synced Inventory</CardTitle><CardDescription>Products from Odoo inventory</CardDescription></CardHeader>
              <CardContent className="p-0">
                {products.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground"><Package className="w-10 h-10 mx-auto mb-3 opacity-30" /><p>No products synced yet.</p></div>
                ) : (
                  <div className="divide-y divide-border">
                    {products.map(p => (
                      <div key={p.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/40 transition-colors">
                        <div className="w-9 h-9 rounded-lg bg-orange-500/20 border border-orange-500/30 flex items-center justify-center shrink-0">
                          <Package className="w-4 h-4 text-orange-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{p.name}</div>
                          <div className="text-xs text-muted-foreground">{p.internalRef && `SKU: ${p.internalRef} · `}{p.category}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-semibold text-sm">{p.currency ?? "USD"} {Number(p.price ?? 0).toFixed(2)}</div>
                          <div className={`text-xs ${Number(p.stockQty ?? 0) > 0 ? "text-green-400" : "text-red-400"}`}>
                            {Number(p.stockQty ?? 0) > 0 ? `${p.stockQty} in stock` : "Out of stock"}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Orders */}
          <TabsContent value="orders" className="mt-4">
            <Card className="bg-card border-border">
              <CardHeader className="pb-3"><CardTitle className="text-base">Sales Orders</CardTitle><CardDescription>Orders from Odoo with WhatsApp notification</CardDescription></CardHeader>
              <CardContent className="p-0">
                {orders.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground"><ShoppingBag className="w-10 h-10 mx-auto mb-3 opacity-30" /><p>No orders synced yet.</p></div>
                ) : (
                  <div className="divide-y divide-border">
                    {orders.map(o => (
                      <div key={o.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/40 transition-colors">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-semibold">{o.name}</span>
                            <StateBadge state={o.state} map={ORDER_STATE_COLORS} />
                            {o.whatsappSent && <span className="text-xs text-primary">✓ Notified</span>}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">{o.partnerName} {o.partnerPhone && `· ${o.partnerPhone}`}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-semibold text-sm">{o.currency ?? "USD"} {Number(o.amountTotal ?? 0).toLocaleString()}</div>
                          {o.dateOrder && <div className="text-xs text-muted-foreground">{new Date(o.dateOrder).toLocaleDateString()}</div>}
                        </div>
                        {o.partnerPhone && (
                          <Button size="sm" variant="outline" className="h-7 px-2 gap-1 border-primary/40 text-primary hover:bg-primary/10 shrink-0"
                            onClick={() => { setSendTarget({ type: "order", id: o.id, name: o.name, phone: o.partnerPhone! }); setSendMsg(`Hi ${o.partnerName}, your order ${o.name} (${o.currency ?? "USD"} ${Number(o.amountTotal ?? 0).toFixed(2)}) is ${o.state}. Thank you! 🛍️`); setSendOpen(true); }}>
                            <MessageSquare className="w-3 h-3" /> Notify
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Invoices */}
          <TabsContent value="invoices" className="mt-4">
            <Card className="bg-card border-border">
              <CardHeader className="pb-3"><CardTitle className="text-base">Invoices</CardTitle><CardDescription>Invoices from Odoo with WhatsApp payment reminders</CardDescription></CardHeader>
              <CardContent className="p-0">
                {invoices.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground"><FileText className="w-10 h-10 mx-auto mb-3 opacity-30" /><p>No invoices synced yet.</p></div>
                ) : (
                  <div className="divide-y divide-border">
                    {invoices.map(inv => (
                      <div key={inv.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/40 transition-colors">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-semibold">{inv.name}</span>
                            <StateBadge state={inv.state} map={INVOICE_STATE_COLORS} />
                            {inv.whatsappSent && <span className="text-xs text-primary">✓ Reminded</span>}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">{inv.partnerName} {inv.dueDate && `· Due: ${new Date(inv.dueDate).toLocaleDateString()}`}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-semibold text-sm">{inv.currency ?? "USD"} {Number(inv.amountTotal ?? 0).toFixed(2)}</div>
                          {Number(inv.amountResidual ?? 0) > 0 && (
                            <div className="text-xs text-red-400">Balance: {Number(inv.amountResidual).toFixed(2)}</div>
                          )}
                        </div>
                        {inv.partnerPhone && (
                          <Button size="sm" variant="outline" className="h-7 px-2 gap-1 border-primary/40 text-primary hover:bg-primary/10 shrink-0"
                            onClick={() => { setSendTarget({ type: "invoice", id: inv.id, name: inv.name, phone: inv.partnerPhone! }); setSendMsg(`Hi ${inv.partnerName}, invoice ${inv.name} of ${inv.currency ?? "USD"} ${Number(inv.amountTotal ?? 0).toFixed(2)} is due${inv.dueDate ? ` on ${new Date(inv.dueDate).toLocaleDateString()}` : ""}. Please make payment at your earliest convenience. 🙏`); setSendOpen(true); }}>
                            <MessageSquare className="w-3 h-3" /> Remind
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* WhatsApp Send Dialog */}
      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent className="bg-card border-border max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-primary" />
              Send WhatsApp — {sendTarget?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
              <Phone className="w-4 h-4" />{sendTarget?.phone}
            </div>
            {templates.length > 0 && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground font-medium">Use Template (optional)</label>
                <select
                  className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  value={selectedTemplateId}
                  onChange={e => {
                    setSelectedTemplateId(e.target.value);
                    const t = templates.find((tmpl: { id: string; bodyText: string }) => tmpl.id === e.target.value);
                    if (t) setSendMsg(t.bodyText
                      .replace(/\{\{customer_name\}\}/g, sendTarget?.name ?? "Customer")
                      .replace(/\{\{order_number\}\}/g, sendTarget?.name ?? "")
                      .replace(/\{\{store_name\}\}/g, "My Store")
                      .replace(/\{\{amount\}\}/g, "")
                      .replace(/\{\{currency\}\}/g, "USD"));
                  }}
                >
                  <option value="">— Select a template —</option>
                  {templates.map((t: { id: string; name: string; category: string }) => <option key={t.id} value={t.id}>{t.name} ({t.category})</option>)}
                </select>
              </div>
            )}
            <textarea className="w-full bg-background border border-border rounded-lg p-3 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary" rows={5} value={sendMsg} onChange={e => setSendMsg(e.target.value)} />
            <Button className="w-full bg-primary text-primary-foreground gap-2" disabled={!sendMsg.trim() || sendWhatsApp.isPending}
              onClick={() => sendTarget && sendWhatsApp.mutate({ type: sendTarget.type, recordId: sendTarget.id, message: sendMsg })}>
              {sendWhatsApp.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send Message
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
