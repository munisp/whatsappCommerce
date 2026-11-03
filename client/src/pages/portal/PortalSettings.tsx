import { useState } from "react";
import { TenantPortalLayout } from "@/components/TenantPortalLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { CreditCard, Settings, Zap } from "lucide-react";

export default function PortalSettings() {
  const { data: tenant, refetch: refetchTenant } = trpc.tenantPortal.getMyTenant.useQuery();
  const { data: gateways, refetch: refetchGw } = trpc.tenantPortal.getMyGatewayConfig.useQuery();
  const updateTenant = trpc.tenantPortal.updateMyTenant.useMutation({
    onSuccess: () => { toast.success("Settings saved"); refetchTenant(); },
    onError: (e) => toast.error(e.message),
  });
  const configureGw = trpc.paymentGateway.configure.useMutation({
    onSuccess: () => { toast.success("Gateway configured"); refetchGw(); },
    onError: (e) => toast.error(e.message),
  });

  const [tenantForm, setTenantForm] = useState({ name: "", defaultCurrency: "NGN", aiEnabled: true });
  const [gwForm, setGwForm] = useState({ provider: "paystack" as const, publicKey: "", secretKey: "", webhookSecret: "", callbackUrl: "" });

  if (tenant && tenantForm.name === "") {
    setTenantForm({ name: tenant.name, defaultCurrency: tenant.defaultCurrency, aiEnabled: tenant.aiEnabled });
  }

  return (
    <TenantPortalLayout>
      <div className="space-y-6 max-w-2xl">
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>

        {/* Store settings */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-foreground flex items-center gap-2">
              <Settings className="h-4 w-4 text-slate-400" /> Store Settings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div><label className="text-xs text-slate-400">Store Name</label>
              <Input value={tenantForm.name} onChange={e => setTenantForm(f => ({ ...f, name: e.target.value }))}
                className="bg-muted border-border text-foreground mt-1" /></div>
            <div><label className="text-xs text-slate-400">Default Currency</label>
              <Input value={tenantForm.defaultCurrency} onChange={e => setTenantForm(f => ({ ...f, defaultCurrency: e.target.value }))}
                className="bg-muted border-border text-foreground mt-1" maxLength={3} /></div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-foreground">AI Agent</p>
                <p className="text-xs text-slate-400">Enable AI-powered conversation handling</p>
              </div>
              <Switch checked={tenantForm.aiEnabled} onCheckedChange={v => setTenantForm(f => ({ ...f, aiEnabled: v }))} />
            </div>
            <Button className="bg-emerald-600 hover:bg-emerald-500" disabled={updateTenant.isPending}
              onClick={() => updateTenant.mutate(tenantForm)}>
              {updateTenant.isPending ? "Saving…" : "Save Settings"}
            </Button>
          </CardContent>
        </Card>

        {/* Payment gateways */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-foreground flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-slate-400" /> Payment Gateways
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {(gateways ?? []).map(gw => (
              <div key={gw.id} className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <div>
                  <p className="text-sm font-medium text-foreground capitalize">{gw.provider}</p>
                  <p className="text-xs text-slate-400">{gw.publicKey ? `pk: ${gw.publicKey.slice(0, 12)}…` : "Not configured"}</p>
                </div>
                <Badge className={gw.isActive ? "bg-emerald-600/20 text-emerald-400 border-emerald-600/30" : "bg-muted/20 text-slate-400"}>
                  {gw.isActive ? "Active" : "Inactive"}
                </Badge>
              </div>
            ))}
            <div className="border-t border-border pt-4 space-y-3">
              <p className="text-xs text-slate-400 font-medium">Add / Update Gateway</p>
              <div className="grid grid-cols-2 gap-2">
                {["paystack","flutterwave","mojaloop"].map(p => (
                  <Button key={p} size="sm" variant="outline"
                    className={`border-border text-foreground hover:bg-muted capitalize ${gwForm.provider === p ? "border-emerald-500 text-emerald-400" : ""}`}
                    onClick={() => setGwForm(f => ({ ...f, provider: p as any }))}>
                    {p}
                  </Button>
                ))}
              </div>
              <Input placeholder="Public Key" value={gwForm.publicKey} onChange={e => setGwForm(f => ({ ...f, publicKey: e.target.value }))}
                className="bg-muted border-border text-foreground" />
              <Input placeholder="Secret Key" type="password" value={gwForm.secretKey} onChange={e => setGwForm(f => ({ ...f, secretKey: e.target.value }))}
                className="bg-muted border-border text-foreground" />
              <Input placeholder="Webhook Secret" value={gwForm.webhookSecret} onChange={e => setGwForm(f => ({ ...f, webhookSecret: e.target.value }))}
                className="bg-muted border-border text-foreground" />
              <Input placeholder="Callback URL (optional)" value={gwForm.callbackUrl} onChange={e => setGwForm(f => ({ ...f, callbackUrl: e.target.value }))}
                className="bg-muted border-border text-foreground" />
              <Button className="w-full bg-emerald-600 hover:bg-emerald-500" disabled={configureGw.isPending}
                onClick={() => tenant && configureGw.mutate({ tenantId: tenant.id, ...gwForm })}>
                <Zap className="h-4 w-4 mr-2" />
                {configureGw.isPending ? "Saving…" : `Configure ${gwForm.provider}`}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </TenantPortalLayout>
  );
}
