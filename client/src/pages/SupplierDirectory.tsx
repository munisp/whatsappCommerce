/**
 * SupplierDirectory — browse supplier tenants on the supply-chain credit
 * network (route /suppliers). Cards show categories, MOQ, lead time, terms
 * chips and the viewer's credit position; CTAs request credit or start a PO
 * (PoBuilderDrawer). Suppliers can also edit their own directory profile
 * (upsertSupplierProfile) from the header.
 */
import { useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { PoBuilderDrawer } from "@/components/b2b/PoBuilderDrawer";
import { SupplierCard } from "@/components/b2b/SupplierCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActiveTenant } from "@/contexts/TenantContext";
import { useB2bUtils, useMySupplierProfile, useRequestCreditAccount, useSuppliers, useUpsertSupplierProfile } from "@/lib/b2b";
import type { SupplierSummary } from "@/lib/b2bLogic";
import { Building2, Loader2, RefreshCw, Search, Store } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";

function MyProfileDialog({
  tenantId,
  open,
  onOpenChange,
}: {
  tenantId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = useB2bUtils();
  const { data: existing } = useMySupplierProfile(tenantId, { enabled: open });
  const [form, setForm] = useState({ categories: "", moq: "", leadTimeDays: "", termsDays: "" });

  // Prefill from the existing supplier profile each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setForm({
      categories: (existing?.categories ?? []).join(", "),
      moq: existing?.moqCents != null ? String(existing.moqCents / 100) : "",
      leadTimeDays: existing?.leadTimeDays != null ? String(existing.leadTimeDays) : "",
      termsDays: (existing?.termsOffered ?? []).join(", "),
    });
  }, [open, existing]);

  const save = useUpsertSupplierProfile({
    onSuccess: () => {
      toast.success("Supplier profile saved");
      utils.procurement.listSuppliers.invalidate();
      utils.procurement.getMySupplierProfile.invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const categories = form.categories.split(",").map((c) => c.trim()).filter(Boolean);
  const termsDays = form.termsDays.split(",").map((t) => Number(t.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 90);
  const moq = Number(form.moq);
  const leadTimeDays = Number(form.leadTimeDays);
  const valid = categories.length > 0 && Number.isFinite(moq) && moq >= 0 && Number.isInteger(leadTimeDays) && leadTimeDays >= 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>My supplier profile</DialogTitle>
          <DialogDescription>
            How your business appears to buyers in the supplier directory.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sp-categories">Categories (comma-separated)</Label>
            <Input
              id="sp-categories"
              placeholder="Beverages, Staples, Toiletries"
              value={form.categories}
              onChange={(e) => setForm((f) => ({ ...f, categories: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sp-moq">Minimum order (₦)</Label>
              <Input
                id="sp-moq" type="number" min={0}
                value={form.moq}
                onChange={(e) => setForm((f) => ({ ...f, moq: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sp-lead">Lead time (days)</Label>
              <Input
                id="sp-lead" type="number" min={0}
                value={form.leadTimeDays}
                onChange={(e) => setForm((f) => ({ ...f, leadTimeDays: e.target.value }))}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sp-terms">Terms offered (days, comma-separated)</Label>
            <Input
              id="sp-terms"
              placeholder="7, 14, 30"
              value={form.termsDays}
              onChange={(e) => setForm((f) => ({ ...f, termsDays: e.target.value }))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={!valid || save.isPending}
            onClick={() => save.mutate({
              tenantId,
              categories,
              moq,
              leadTimeDays,
              termsDays,
            })}
          >
            {save.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            Save profile
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SupplierDirectory() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const utils = useB2bUtils();
  const { data: suppliers, isLoading, error, refetch, isFetching } = useSuppliers(tenantId);
  const [search, setSearch] = useState("");
  const [poSupplier, setPoSupplier] = useState<SupplierSummary | null>(null);
  const [poOpen, setPoOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const requestCredit = useRequestCreditAccount({
    onSuccess: () => {
      toast.success("Credit request sent — the supplier will review it");
      utils.tradeCredit.myAccounts.invalidate();
      utils.procurement.listSuppliers.invalidate();
    },
    // A facility (any status) already exists for this pair — say so plainly;
    // anything else is a real failure worth surfacing.
    onError: (e) =>
      toast.error(e.message.includes("already exists")
        ? "A credit facility already exists with this supplier — see your Credit Accounts page."
        : e.message),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return suppliers ?? [];
    return (suppliers ?? []).filter((s) =>
      s.businessName.toLowerCase().includes(q) || s.categories.some((c) => c.toLowerCase().includes(q)),
    );
  }, [suppliers, search]);

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Store className="w-6 h-6 text-primary" /> Supplier Directory
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Wholesale suppliers on the network — order on credit or pay now.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setProfileOpen(true)}>
              <Building2 className="w-4 h-4" /> My supplier profile
            </Button>
            <Button variant="ghost" size="icon" onClick={() => refetch()} disabled={isFetching} aria-label="Refresh suppliers">
              {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search suppliers or categories…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-16 justify-center">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading suppliers…
          </div>
        ) : error ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <p className="text-sm font-medium">Supplier directory unavailable</p>
              <p className="text-xs text-muted-foreground max-w-md">{error.message}</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
            </CardContent>
          </Card>
        ) : filtered.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
              <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
                <Store className="h-7 w-7 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium">{search ? "No suppliers match your search" : "No suppliers yet"}</p>
                <p className="text-sm text-muted-foreground mt-1 max-w-md">
                  {search
                    ? "Try a different name or category."
                    : "When suppliers join the network and publish their profiles, they will appear here."}
                </p>
              </div>
              {search && (
                <Button variant="outline" size="sm" onClick={() => setSearch("")}>Clear search</Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map((s) => (
              <SupplierCard
                key={s.supplierTenantId}
                supplier={s}
                requestingCredit={requestCredit.isPending}
                onRequestCredit={(sup) => requestCredit.mutate({ tenantId, supplierTenantId: sup.supplierTenantId })}
                onStartPo={(sup) => { setPoSupplier(sup); setPoOpen(true); }}
              />
            ))}
          </div>
        )}
      </div>

      <PoBuilderDrawer tenantId={tenantId} supplier={poSupplier} open={poOpen} onOpenChange={setPoOpen} />
      <MyProfileDialog tenantId={tenantId} open={profileOpen} onOpenChange={setProfileOpen} />
    </DashboardLayout>
  );
}
