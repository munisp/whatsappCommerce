import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Bot, Building2, Globe, MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useLocation, useParams } from "wouter";

export default function TenantDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { data: tenant, refetch } = trpc.tenant.get.useQuery({ id: id! });
  const { data: dash } = trpc.analytics.tenantDashboard.useQuery({ tenantId: id! });
  const [form, setForm] = useState({ name: "", plan: "starter" as any, status: "trial" as any, aiEnabled: true, aiModel: "gpt-4o-mini", whatsappPhoneNumberId: "", chatwootAccountId: "" });

  useEffect(() => {
    if (tenant) setForm({ name: tenant.name, plan: tenant.plan, status: tenant.status, aiEnabled: tenant.aiEnabled, aiModel: tenant.aiModel ?? "gpt-4o-mini", whatsappPhoneNumberId: tenant.whatsappPhoneNumberId ?? "", chatwootAccountId: tenant.chatwootAccountId ?? "" });
  }, [tenant]);

  const updateMutation = trpc.tenant.update.useMutation({
    onSuccess: () => { toast.success("Tenant updated"); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  if (!tenant) return <DashboardLayout><div className="p-6 text-muted-foreground">Loading...</div></DashboardLayout>;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/tenants")} className="gap-2"><ArrowLeft className="w-4 h-4" />Back</Button>
          <div>
            <h1 className="text-2xl font-bold">{tenant.name}</h1>
            <p className="text-muted-foreground text-sm font-mono">{tenant.slug}</p>
          </div>
        </div>

        {/* Metrics */}
        {dash && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Conversations", value: dash.conversations.total, icon: MessageSquare, color: "text-blue-400" },
              { label: "Orders", value: dash.orders.total, icon: Building2, color: "text-green-400" },
              { label: "Revenue", value: `$${dash.orders.revenue.toLocaleString()}`, icon: Globe, color: "text-primary" },
              { label: "AI Interactions", value: dash.agent.total, icon: Bot, color: "text-yellow-400" },
            ].map((m) => (
              <Card key={m.label} className="bg-card border-border">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs text-muted-foreground">{m.label}</p>
                      <p className={`text-xl font-bold mt-1 ${m.color}`}>{m.value}</p>
                    </div>
                    <m.icon className={`w-6 h-6 ${m.color} opacity-50`} />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Edit Form */}
        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-sm font-medium">Tenant Configuration</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="bg-input border-border" />
              </div>
              <div className="space-y-1">
                <Label>Plan</Label>
                <Select value={form.plan} onValueChange={(v) => setForm({ ...form, plan: v as any })}>
                  <SelectTrigger className="bg-input border-border"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="starter">Starter</SelectItem>
                    <SelectItem value="growth">Growth</SelectItem>
                    <SelectItem value="enterprise">Enterprise</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as any })}>
                  <SelectTrigger className="bg-input border-border"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="trial">Trial</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="suspended">Suspended</SelectItem>
                    <SelectItem value="churned">Churned</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>AI Model</Label>
                <Select value={form.aiModel} onValueChange={(v) => setForm({ ...form, aiModel: v })}>
                  <SelectTrigger className="bg-input border-border"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gpt-4o-mini">GPT-4o Mini</SelectItem>
                    <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                    <SelectItem value="claude-3-haiku">Claude 3 Haiku</SelectItem>
                    <SelectItem value="gemini-1.5-flash">Gemini 1.5 Flash</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>WhatsApp Phone Number ID</Label>
                <Input value={form.whatsappPhoneNumberId} onChange={(e) => setForm({ ...form, whatsappPhoneNumberId: e.target.value })} placeholder="1234567890" className="bg-input border-border font-mono" />
              </div>
              <div className="space-y-1">
                <Label>Chatwoot Account ID</Label>
                <Input value={form.chatwootAccountId} onChange={(e) => setForm({ ...form, chatwootAccountId: e.target.value })} placeholder="1" className="bg-input border-border font-mono" />
              </div>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <Switch checked={form.aiEnabled} onCheckedChange={(v) => setForm({ ...form, aiEnabled: v })} />
              <Label>AI Agent Enabled</Label>
            </div>
            <Button className="bg-primary text-primary-foreground" onClick={() => updateMutation.mutate({ id: id!, ...form })} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

