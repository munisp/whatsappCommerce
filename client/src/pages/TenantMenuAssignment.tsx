import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Building2, Menu, CheckCircle2, AlertCircle, Link2, Unlink,
  Globe, Phone, Users, RefreshCw, ChevronRight
} from "lucide-react";

const PLAN_COLORS: Record<string, string> = {
  starter: "bg-slate-500/20 text-slate-300 border-slate-500/30",
  growth: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  enterprise: "bg-purple-500/20 text-purple-300 border-purple-500/30",
};

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  trial: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  suspended: "bg-red-500/20 text-red-300 border-red-500/30",
  churned: "bg-slate-500/20 text-slate-300 border-slate-500/30",
};

type Tenant = { id: string; name: string; slug: string; plan: string; status: string; whatsappPhone?: string | null; activeMenuId?: string | null };
type WhatsAppMenu = { id: string; name: string; status: string; itemCount?: number };

function AssignMenuDialog({ tenant, menus, onClose, onAssigned }: {
  tenant: Tenant;
  menus: WhatsAppMenu[];
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [selectedMenuId, setSelectedMenuId] = useState(tenant.activeMenuId ?? "");
  const utils = trpc.useUtils();

  const assign = trpc.menu.assignToTenant.useMutation({
    onSuccess: () => {
      toast.success(`Menu assigned to ${tenant.name}`);
      utils.tenant.list.invalidate();
      utils.menu.getAssignments.invalidate();
      onAssigned();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const unassign = trpc.menu.unassignFromTenant.useMutation({
    onSuccess: () => {
      toast.success(`Menu unassigned from ${tenant.name}`);
      utils.tenant.list.invalidate();
      utils.menu.getAssignments.invalidate();
      onAssigned();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const publishedMenus = menus.filter(m => m.status === "published");

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg bg-[#0f1923] border-white/10 text-white">
        <DialogHeader>
          <DialogTitle className="text-white flex items-center gap-2">
            <Menu className="w-5 h-5 text-emerald-400" />
            Assign WhatsApp Menu
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="bg-white/5 rounded-xl p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center">
                <Building2 className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <div className="text-white font-medium">{tenant.name}</div>
                <div className="text-white/40 text-xs">{tenant.whatsappPhone ?? "No phone configured"}</div>
              </div>
              <div className="ml-auto flex gap-2">
                <Badge className={`text-[10px] border ${PLAN_COLORS[tenant.plan] ?? ""}`}>{tenant.plan}</Badge>
                <Badge className={`text-[10px] border ${STATUS_COLORS[tenant.status] ?? ""}`}>{tenant.status}</Badge>
              </div>
            </div>
          </div>

          <div>
            <label className="text-white/60 text-xs block mb-2">Select Published Menu</label>
            {publishedMenus.length === 0 ? (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-amber-300 text-sm">
                No published menus available. Go to Menu Builder and publish a menu first.
              </div>
            ) : (
              <Select value={selectedMenuId} onValueChange={setSelectedMenuId}>
                <SelectTrigger className="bg-white/5 border-white/10 text-white">
                  <SelectValue placeholder="Choose a menu..." />
                </SelectTrigger>
                <SelectContent className="bg-[#1a2535] border-white/10">
                  {publishedMenus.map(m => (
                    <SelectItem key={m.id} value={m.id} className="text-white">
                      <div className="flex items-center gap-2">
                        <Menu className="w-3.5 h-3.5 text-emerald-400" />
                        {m.name}
                        {m.itemCount !== undefined && (
                          <span className="text-white/40 text-xs">({m.itemCount} items)</span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {tenant.activeMenuId && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-emerald-300 text-sm">
                <CheckCircle2 className="w-4 h-4" />
                Currently assigned: <span className="font-medium">{menus.find(m => m.id === tenant.activeMenuId)?.name ?? tenant.activeMenuId}</span>
              </div>
              <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-300 gap-1 text-xs"
                onClick={() => unassign.mutate({ tenantId: tenant.id })}
                disabled={unassign.isPending}>
                <Unlink className="w-3 h-3" />
                {unassign.isPending ? "Removing..." : "Remove"}
              </Button>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="border-white/10 text-white/70">Cancel</Button>
          <Button
            onClick={() => assign.mutate({ tenantId: tenant.id, menuId: selectedMenuId })}
            disabled={!selectedMenuId || assign.isPending || publishedMenus.length === 0}
            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5">
            <Link2 className="w-4 h-4" />
            {assign.isPending ? "Assigning..." : "Assign Menu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TenantMenuAssignment() {
  const [assignTarget, setAssignTarget] = useState<Tenant | null>(null);
  const utils = trpc.useUtils();

  const { data: tenantData, isLoading: tenantsLoading } = trpc.tenant.list.useQuery({ limit: 100 });
  const { data: menuData, isLoading: menusLoading } = trpc.menu.list.useQuery();
  const { data: assignments } = trpc.menu.getAssignments.useQuery();

  const tenants = (Array.isArray(tenantData) ? tenantData : []) as Tenant[];
  const menus = (Array.isArray(menuData) ? menuData : []) as WhatsAppMenu[];
  const assignmentMap = new Map((assignments ?? []).map((a: { tenantId: string; menuId: string }) => [a.tenantId, a.menuId]));

  const tenantsWithMenus: Tenant[] = tenants.map(t => ({ ...t, activeMenuId: (assignmentMap.get(t.id) ?? null) as string | null }));
  const assignedCount = tenantsWithMenus.filter(t => t.activeMenuId).length;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Tenant Menu Assignment</h1>
            <p className="text-white/50 text-sm mt-1">
              Assign a WhatsApp interactive menu to each tenant's phone number
            </p>
          </div>
          <Button variant="outline" size="sm" className="border-white/10 text-white/70 gap-1.5"
            onClick={() => { utils.tenant.list.invalidate(); utils.menu.list.invalidate(); utils.menu.getAssignments.invalidate(); }}>
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: "Total Tenants", value: tenants.length, icon: Building2, color: "text-emerald-400" },
            { label: "Menu Assigned", value: assignedCount, icon: CheckCircle2, color: "text-blue-400" },
            { label: "No Menu", value: tenants.length - assignedCount, icon: AlertCircle, color: "text-amber-400" },
            { label: "Published Menus", value: menus.filter(m => m.status === "published").length, icon: Menu, color: "text-purple-400" },
          ].map(stat => (
            <Card key={stat.label} className="bg-[#0f1923] border-white/10">
              <CardContent className="p-4 flex items-center gap-3">
                <stat.icon className={`w-8 h-8 ${stat.color} opacity-80`} />
                <div>
                  <div className="text-2xl font-bold text-white">{stat.value}</div>
                  <div className="text-xs text-white/40">{stat.label}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Tenant list */}
        {tenantsLoading || menusLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-20 bg-white/5 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : tenants.length === 0 ? (
          <div className="text-center py-20 text-white/30">
            <Building2 className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No tenants found. Create tenants in the Tenants page first.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {tenantsWithMenus.map(tenant => {
              const assignedMenu = menus.find(m => m.id === tenant.activeMenuId);
              return (
                <Card key={tenant.id} className="bg-[#0f1923] border-white/10 hover:border-white/20 transition-all">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-4">
                      {/* Tenant info */}
                      <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                        <Building2 className="w-5 h-5 text-emerald-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-white font-medium">{tenant.name}</span>
                          <Badge className={`text-[10px] border ${PLAN_COLORS[tenant.plan] ?? ""}`}>{tenant.plan}</Badge>
                          <Badge className={`text-[10px] border ${STATUS_COLORS[tenant.status] ?? ""}`}>{tenant.status}</Badge>
                        </div>
                        <div className="flex items-center gap-3 mt-1">
                          {tenant.whatsappPhone ? (
                            <span className="flex items-center gap-1 text-xs text-white/40">
                              <Phone className="w-3 h-3" /> {tenant.whatsappPhone}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-xs text-white/30">
                              <Phone className="w-3 h-3" /> No phone configured
                            </span>
                          )}
                          <span className="flex items-center gap-1 text-xs text-white/40">
                            <Globe className="w-3 h-3" /> {tenant.slug}
                          </span>
                        </div>
                      </div>

                      {/* Arrow */}
                      <ChevronRight className="w-4 h-4 text-white/20 flex-shrink-0" />

                      {/* Menu assignment status */}
                      <div className="flex-1 min-w-0">
                        {assignedMenu ? (
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center">
                              <Menu className="w-4 h-4 text-emerald-400" />
                            </div>
                            <div>
                              <div className="text-white text-sm font-medium">{assignedMenu.name}</div>
                              <div className="flex items-center gap-1 text-xs text-emerald-400">
                                <CheckCircle2 className="w-3 h-3" /> Active menu
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-white/30">
                            <AlertCircle className="w-4 h-4 text-amber-400/60" />
                            <span className="text-sm text-white/40">No menu assigned</span>
                          </div>
                        )}
                      </div>

                      {/* Action */}
                      <Button
                        size="sm"
                        variant={assignedMenu ? "outline" : "default"}
                        className={assignedMenu
                          ? "border-white/10 text-white/70 hover:text-white gap-1.5"
                          : "bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"}
                        onClick={() => setAssignTarget(tenant)}>
                        <Link2 className="w-3.5 h-3.5" />
                        {assignedMenu ? "Change Menu" : "Assign Menu"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {assignTarget && (
        <AssignMenuDialog
          tenant={assignTarget}
          menus={menus}
          onClose={() => setAssignTarget(null)}
          onAssigned={() => setAssignTarget(null)}
        />
      )}
    </DashboardLayout>
  );
}
