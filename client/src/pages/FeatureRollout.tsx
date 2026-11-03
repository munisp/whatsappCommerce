import { useMemo, useState } from "react";
import { Search, Store } from "lucide-react";
import { toast } from "sonner";
import { AdminGuard } from "@/components/AdminGuard";
import DashboardLayout, { TENANT_NAV_GROUPS } from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { ALWAYS_ON_FEATURES, featureVisible, type RolloutState } from "@shared/featureRollout";

const STAGES: { value: RolloutState; label: string }[] = [
  { value: "off", label: "Hidden" },
  { value: "selected", label: "Selected shops" },
  { value: "all", label: "All shops" },
];

function StagePicker({ value, disabled, onChange }: { value: RolloutState; disabled?: boolean; onChange: (state: RolloutState) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border overflow-hidden" role="group" aria-label="Rollout stage">
      {STAGES.map((stage) => (
        <button
          key={stage.value}
          type="button"
          disabled={disabled}
          aria-pressed={value === stage.value}
          onClick={() => onChange(stage.value)}
          className={`px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${value === stage.value ? "bg-primary text-primary-foreground" : "bg-transparent text-muted-foreground hover:bg-muted"}`}
        >
          {stage.label}
        </button>
      ))}
    </div>
  );
}

function FeatureRolloutPage() {
  const utils = trpc.useUtils();
  const overview = trpc.featureRollout.overview.useQuery();
  const refresh = () => utils.featureRollout.overview.invalidate();
  const setState = trpc.featureRollout.setState.useMutation({ onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const setOverride = trpc.featureRollout.setShopOverride.useMutation({ onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const [search, setSearch] = useState("");
  const [previewShop, setPreviewShop] = useState("none");
  const [shopsFor, setShopsFor] = useState<{ path: string; label: string } | null>(null);

  const states = useMemo(() => new Map((overview.data?.rollouts ?? []).map((row) => [row.featureKey, row.state as RolloutState])), [overview.data]);
  const overrides = useMemo(() => new Map((overview.data?.overrides ?? []).map((row) => [`${row.tenantId}|${row.featureKey}`, row.enabled])), [overview.data]);
  const shops = overview.data?.shops ?? [];
  const stateOf = (path: string): RolloutState => states.get(path) ?? "all";
  const shopCount = (path: string) => {
    const state = stateOf(path);
    return shops.filter((shop) => featureVisible(path, state, overrides.get(`${shop.id}|${path}`))).length;
  };

  const groups = useMemo(() => {
    const term = search.trim().toLowerCase();
    return TENANT_NAV_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      items: group.items.filter((item) => !item.adminOnly && (!term || item.label.toLowerCase().includes(term) || group.label.toLowerCase().includes(term))),
    })).filter((group) => group.items.length > 0);
  }, [search]);

  const allItems = TENANT_NAV_GROUPS.flatMap((group) => group.items.filter((item) => !item.adminOnly));
  const counts = { off: 0, selected: 0, all: 0 } as Record<RolloutState, number>;
  for (const item of allItems) counts[ALWAYS_ON_FEATURES.includes(item.path) ? "all" : stateOf(item.path)] += 1;

  const setGroup = (label: string, paths: string[], state: RolloutState) => {
    const stage = STAGES.find((s) => s.value === state)!.label;
    if (window.confirm(`Set all ${paths.length} features in ${label} to "${stage}"? Shops see this straight away.`)) {
      setState.mutate({ keys: paths, state });
    }
  };

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold">Feature Rollout</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Choose which features shops see on their dashboard. Changes reach shops within about a minute, and a feature that comes back from Hidden gets a "New" badge for 14 days.
        </p>
        <p className="text-xs text-muted-foreground mt-2 max-w-2xl">
          This only changes the dashboard. It doesn't turn off the WhatsApp bot, background jobs or the feature's API.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Badge variant="secondary">{counts.all} all shops</Badge>
        <Badge variant="secondary">{counts.selected} selected shops</Badge>
        <Badge variant="secondary">{counts.off} hidden</Badge>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search features" className="pl-8" />
        </div>
        <Select value={previewShop} onValueChange={setPreviewShop}>
          <SelectTrigger className="w-[220px]" aria-label="See what a shop sees"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">See what a shop sees…</SelectItem>
            {shops.map((shop) => <SelectItem key={shop.id} value={shop.id}>{shop.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {overview.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {overview.error && <p className="text-sm text-destructive">{overview.error.message}</p>}

      {overview.data && groups.map((group) => {
        const changeable = group.items.map((item) => item.path).filter((path) => !ALWAYS_ON_FEATURES.includes(path));
        return (
          <Card key={group.id}>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 py-3">
              <CardTitle className="text-sm">{group.label}</CardTitle>
              {changeable.length > 0 && (
                <div className="flex gap-1.5">
                  <Button variant="ghost" size="sm" disabled={setState.isPending} onClick={() => setGroup(group.label, changeable, "off")}>Hide all</Button>
                  <Button variant="ghost" size="sm" disabled={setState.isPending} onClick={() => setGroup(group.label, changeable, "all")}>Show to all</Button>
                </div>
              )}
            </CardHeader>
            <CardContent className="divide-y divide-border p-0">
              {group.items.map((item) => {
                const locked = ALWAYS_ON_FEATURES.includes(item.path);
                const state = stateOf(item.path);
                const seen = previewShop !== "none" && featureVisible(item.path, state, overrides.get(`${previewShop}|${item.path}`));
                return (
                  <div key={item.path} data-feature={item.path} className="flex flex-wrap items-center gap-3 px-6 py-2.5">
                    <div className="flex-1 min-w-[180px]">
                      <span className="text-sm font-medium">{item.label}</span>
                      {previewShop !== "none" && <Badge variant={seen ? "default" : "outline"} className="ml-2">{seen ? "Shop sees this" : "Hidden from shop"}</Badge>}
                    </div>
                    {locked ? (
                      <span className="text-xs text-muted-foreground">Always on</span>
                    ) : (
                      <>
                        <Button variant="ghost" size="sm" className="gap-1.5 text-xs" disabled={state === "off"} onClick={() => setShopsFor({ path: item.path, label: item.label })}>
                          <Store className="h-3.5 w-3.5" />{shopCount(item.path)} of {shops.length} shops
                        </Button>
                        <StagePicker value={state} disabled={setState.isPending} onChange={(next) => setState.mutate({ keys: [item.path], state: next })} />
                      </>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        );
      })}

      <Dialog open={!!shopsFor} onOpenChange={(open) => !open && setShopsFor(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{shopsFor?.label}</DialogTitle>
            <DialogDescription>
              {shopsFor && stateOf(shopsFor.path) === "selected" ? "Turn it on for the shops that should get it." : "Every shop has this. Turn it off for any shop that shouldn't."}
            </DialogDescription>
          </DialogHeader>
          <div className="divide-y divide-border">
            {shopsFor && shops.map((shop) => {
              const state = stateOf(shopsFor.path);
              const on = featureVisible(shopsFor.path, state, overrides.get(`${shop.id}|${shopsFor.path}`));
              return (
                <label key={shop.id} className="flex items-center justify-between gap-3 py-2 text-sm cursor-pointer">
                  <span>{shop.name} {shop.status !== "active" && <span className="text-xs text-muted-foreground">({shop.status})</span>}</span>
                  <Switch
                    checked={on}
                    disabled={setOverride.isPending}
                    aria-label={`${shopsFor.label} for ${shop.name}`}
                    onCheckedChange={(next) => {
                      // Store only the exception to the current stage.
                      const enabled = state === "selected" ? (next ? true : null) : next ? null : false;
                      setOverride.mutate({ tenantId: shop.id, key: shopsFor.path, enabled });
                    }}
                  />
                </label>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function FeatureRollout() {
  return (
    <DashboardLayout>
      <AdminGuard>
        <FeatureRolloutPage />
      </AdminGuard>
    </DashboardLayout>
  );
}
