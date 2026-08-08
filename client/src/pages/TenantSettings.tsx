/**
 * TenantSettings — tenant-facing configuration hub over the tenantConfig
 * router: branding, custom domains, commerce (currency / pickup / delivery
 * zones / fee overrides), inventory source, and CRM (custom fields +
 * pipeline stages). Each section loads its own config and saves through the
 * matching set* mutation; backend zod errors surface via toasts.
 */
import { useEffect, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useActiveTenant } from "@/contexts/TenantContext";
import {
  ArrowDown, ArrowUp, Globe, HelpCircle, Loader2, Palette, Plus, Save, Settings2, ShoppingCart, Tag, Trash2, Users, Warehouse,
} from "lucide-react";
import type {
  BrandingConfig, CommerceConfig, CrmCustomField, DeliveryZone, InventoryConfig,
} from "@shared/tenantConfig";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FIELD_TYPES = ["text", "number", "date", "select", "boolean"] as const;

// ─── Branding ────────────────────────────────────────────────────────────────

function BrandingSection({ tenantId }: { tenantId: string }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.tenantConfig.getBrandingConfig.useQuery({ tenantId });
  const [form, setForm] = useState<BrandingConfig | null>(null);
  useEffect(() => {
    if (data) setForm({ ...data });
  }, [data]);

  const save = trpc.tenantConfig.setBrandingConfig.useMutation({
    onSuccess: () => {
      toast.success("Branding saved");
      utils.tenantConfig.getBrandingConfig.invalidate({ tenantId });
      utils.tenant.tenantTheme.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading || !form) return <SectionLoading />;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Branding</CardTitle>
        <CardDescription>Name, logo and primary color used in the storefront and menu greeting.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 max-w-lg">
        <div className="space-y-1.5">
          <Label htmlFor="ts-bname">Brand name</Label>
          <Input
            id="ts-bname"
            value={form.name}
            maxLength={120}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ts-logo">Logo URL</Label>
          <Input
            id="ts-logo"
            value={form.logoUrl ?? ""}
            placeholder="https://cdn.example.com/logo.png (empty = none)"
            onChange={(e) => setForm({ ...form, logoUrl: e.target.value === "" ? null : e.target.value })}
          />
          {form.logoUrl && (
            <img src={form.logoUrl} alt="logo preview" className="h-10 mt-2 rounded border bg-white/5 object-contain" />
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ts-color">Primary color</Label>
          <div className="flex items-center gap-3">
            <input
              id="ts-color"
              type="color"
              value={HEX_RE.test(form.primaryColor) ? form.primaryColor : "#8A5A2B"}
              onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
              className="h-9 w-14 rounded border bg-transparent cursor-pointer"
            />
            <Input
              value={form.primaryColor}
              maxLength={7}
              className={`w-28 font-mono ${HEX_RE.test(form.primaryColor) ? "" : "border-destructive"}`}
              onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
            />
            {!HEX_RE.test(form.primaryColor) && (
              <span className="text-xs text-destructive">hex color like #8A5A2B</span>
            )}
          </div>
        </div>
        <Button
          onClick={() => save.mutate({ tenantId, config: form })}
          disabled={save.isPending || !form.name.trim() || !HEX_RE.test(form.primaryColor)}
        >
          {save.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
          Save branding
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Domains ─────────────────────────────────────────────────────────────────

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function DomainsSection({ tenantId }: { tenantId: string }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.tenantConfig.getDomains.useQuery({ tenantId });
  const [domains, setDomains] = useState<string[] | null>(null);
  const [newDomain, setNewDomain] = useState("");
  useEffect(() => {
    if (data) setDomains([...data]);
  }, [data]);

  const save = trpc.tenantConfig.setDomains.useMutation({
    onSuccess: () => {
      toast.success("Domains saved");
      utils.tenantConfig.getDomains.invalidate({ tenantId });
    },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading || !domains) return <SectionLoading />;

  const candidate = newDomain.trim().toLowerCase();
  const candidateValid = HOST_RE.test(candidate);
  const addDomain = () => {
    if (!candidateValid) return;
    if (domains.includes(candidate)) {
      toast.error(`"${candidate}" is already in the list`);
      return;
    }
    setDomains([...domains, candidate]);
    setNewDomain("");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Custom domains</CardTitle>
        <CardDescription>
          Hosts that resolve to this tenant's storefront (exact Host-header match).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 max-w-xl">
        <div className="flex gap-2">
          <Input
            value={newDomain}
            placeholder="shop.example.com"
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addDomain()}
            className={candidate && !candidateValid ? "border-destructive" : ""}
          />
          <Button variant="outline" onClick={addDomain} disabled={!candidateValid || domains.length >= 20}>
            <Plus className="w-4 h-4 mr-1" /> Add
          </Button>
        </div>
        {candidate && !candidateValid && (
          <p className="text-xs text-destructive">Enter a plain hostname (no protocol, port or path).</p>
        )}
        {domains.length === 0 ? (
          <p className="text-sm text-muted-foreground">No custom domains — the platform subdomain is used.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {domains.map((d) => (
              <Badge key={d} variant="secondary" className="flex items-center gap-1.5 py-1.5">
                <Globe className="w-3 h-3" />
                {d}
                <button
                  onClick={() => setDomains(domains.filter((x) => x !== d))}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${d}`}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <Button onClick={() => save.mutate({ tenantId, domains })} disabled={save.isPending}>
          {save.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
          Save domains
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Commerce ────────────────────────────────────────────────────────────────

function CommerceSection({ tenantId }: { tenantId: string }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.tenantConfig.getCommerceConfig.useQuery({ tenantId });
  const [form, setForm] = useState<CommerceConfig | null>(null);
  useEffect(() => {
    if (data) setForm(JSON.parse(JSON.stringify(data)) as CommerceConfig);
  }, [data]);

  const save = trpc.tenantConfig.setCommerceConfig.useMutation({
    onSuccess: () => {
      toast.success("Commerce settings saved");
      utils.tenantConfig.getCommerceConfig.invalidate({ tenantId });
    },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading || !form) return <SectionLoading />;

  const currencyValid = /^[A-Z]{3}$/.test(form.currency);
  const setZone = (idx: number, patch: Partial<DeliveryZone>) =>
    setForm({ ...form, deliveryZones: form.deliveryZones.map((z, i) => (i === idx ? { ...z, ...patch } : z)) });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Commerce</CardTitle>
        <CardDescription>Currency, pickup, delivery zones and platform fee overrides.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-3xl">
          <div className="space-y-1.5">
            <Label htmlFor="ts-currency">Currency (ISO)</Label>
            <Input
              id="ts-currency"
              value={form.currency}
              maxLength={3}
              className={`font-mono uppercase ${currencyValid ? "" : "border-destructive"}`}
              onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ts-feerate">Platform fee rate (0–0.5)</Label>
            <Input
              id="ts-feerate"
              type="number" step="0.001" min="0" max="0.5"
              value={form.feeOverrides?.platformFeeRate ?? ""}
              placeholder="default"
              onChange={(e) =>
                setForm({
                  ...form,
                  feeOverrides: {
                    ...form.feeOverrides,
                    platformFeeRate: e.target.value === "" ? undefined : Number(e.target.value),
                  },
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ts-feeflat">Flat delivery fee</Label>
            <Input
              id="ts-feeflat"
              type="number" step="0.01" min="0"
              value={form.feeOverrides?.deliveryFeeFlat ?? ""}
              placeholder="default"
              onChange={(e) =>
                setForm({
                  ...form,
                  feeOverrides: {
                    ...form.feeOverrides,
                    deliveryFeeFlat: e.target.value === "" ? undefined : Number(e.target.value),
                  },
                })
              }
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Switch
            id="ts-pickup"
            checked={form.pickupEnabled}
            onCheckedChange={(v) => setForm({ ...form, pickupEnabled: v })}
          />
          <Label htmlFor="ts-pickup">Pickup enabled (buyers can collect orders themselves)</Label>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Delivery zones</h3>
            <Button
              variant="outline" size="sm"
              disabled={form.deliveryZones.length >= 50}
              onClick={() =>
                setForm({
                  ...form,
                  deliveryZones: [...form.deliveryZones, { name: "", fee: 0 }],
                })
              }
            >
              <Plus className="w-4 h-4 mr-1" /> Add zone
            </Button>
          </div>
          {form.deliveryZones.length === 0 && (
            <p className="text-sm text-muted-foreground">No delivery zones configured.</p>
          )}
          {form.deliveryZones.map((zone, idx) => (
            <div key={idx} className="grid grid-cols-1 md:grid-cols-[1fr_120px_110px_120px_40px] gap-2 items-center">
              <Input
                value={zone.name}
                placeholder="Zone name"
                maxLength={80}
                className={zone.name.trim() === "" ? "border-destructive" : ""}
                onChange={(e) => setZone(idx, { name: e.target.value })}
              />
              <Input
                type="number" min="0" step="0.01"
                value={zone.fee}
                placeholder="Fee"
                onChange={(e) => setZone(idx, { fee: Number(e.target.value) })}
              />
              <Input
                value={zone.currency ?? ""}
                placeholder={form.currency}
                maxLength={3}
                className="font-mono uppercase"
                onChange={(e) =>
                  setZone(idx, { currency: e.target.value === "" ? undefined : e.target.value.toUpperCase() })
                }
              />
              <Input
                type="number" min="0" max="60"
                value={zone.estimatedDays ?? ""}
                placeholder="Est. days"
                onChange={(e) =>
                  setZone(idx, { estimatedDays: e.target.value === "" ? undefined : Number(e.target.value) })
                }
              />
              <Button
                variant="ghost" size="icon" className="text-destructive"
                onClick={() =>
                  setForm({ ...form, deliveryZones: form.deliveryZones.filter((_, i) => i !== idx) })
                }
                aria-label="Remove zone"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>

        <Button
          onClick={() => save.mutate({ tenantId, config: form })}
          disabled={
            save.isPending ||
            !currencyValid ||
            form.deliveryZones.some((z) => z.name.trim() === "")
          }
        >
          {save.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
          Save commerce settings
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Inventory ───────────────────────────────────────────────────────────────

function InventorySection({ tenantId }: { tenantId: string }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.tenantConfig.getInventoryConfig.useQuery({ tenantId });
  const [form, setForm] = useState<InventoryConfig | null>(null);
  useEffect(() => {
    if (data) setForm({ ...data });
  }, [data]);

  const save = trpc.tenantConfig.setInventoryConfig.useMutation({
    onSuccess: () => {
      toast.success("Inventory settings saved");
      utils.tenantConfig.getInventoryConfig.invalidate({ tenantId });
    },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading || !form) return <SectionLoading />;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Inventory</CardTitle>
        <CardDescription>Where stock levels come from and when low-stock alerts fire.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 max-w-lg">
        <div className="space-y-1.5">
          <Label>Stock source</Label>
          <Select
            value={form.source}
            onValueChange={(v) => setForm({ ...form, source: v as InventoryConfig["source"] })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Local (this platform)</SelectItem>
              <SelectItem value="medusa">Medusa</SelectItem>
              <SelectItem value="odoo">Odoo</SelectItem>
            </SelectContent>
          </Select>
          {form.source !== "local" && (
            <p className="text-[11px] text-muted-foreground">
              Requires the {form.source === "medusa" ? "Medusa" : "Odoo"} integration to be enabled in
              Integration Settings.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ts-threshold">Low-stock threshold</Label>
          <Input
            id="ts-threshold"
            type="number" min="0" max="100000"
            value={form.lowStockThreshold}
            onChange={(e) => setForm({ ...form, lowStockThreshold: Number(e.target.value) })}
          />
        </div>
        <Button
          onClick={() => save.mutate({ tenantId, config: form })}
          disabled={save.isPending || !Number.isInteger(form.lowStockThreshold) || form.lowStockThreshold < 0}
        >
          {save.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
          Save inventory settings
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── CRM ─────────────────────────────────────────────────────────────────────

function CrmSection({ tenantId }: { tenantId: string }) {
  const utils = trpc.useUtils();
  const { data: crm, isLoading } = trpc.tenantConfig.getCrmConfig.useQuery({ tenantId });

  const [stages, setStages] = useState<string[] | null>(null);
  const [newStage, setNewStage] = useState("");
  useEffect(() => {
    if (crm) setStages([...crm.pipelineStages]);
  }, [crm]);

  const invalidate = () => utils.tenantConfig.getCrmConfig.invalidate({ tenantId });

  const saveStages = trpc.tenantConfig.setPipelineStages.useMutation({
    onSuccess: () => {
      toast.success("Pipeline stages saved");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const addField = trpc.tenantConfig.addCustomField.useMutation({
    onSuccess: () => {
      toast.success("Custom field added");
      setFieldDialogOpen(false);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const updateField = trpc.tenantConfig.updateCustomField.useMutation({
    onSuccess: () => {
      toast.success("Custom field updated");
      setFieldDialogOpen(false);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const removeField = trpc.tenantConfig.removeCustomField.useMutation({
    onSuccess: () => {
      toast.success("Custom field removed");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const [fieldDialogOpen, setFieldDialogOpen] = useState(false);
  const [editingFieldKey, setEditingFieldKey] = useState<string | null>(null);
  const [fieldForm, setFieldForm] = useState<CrmCustomField>({
    key: "", label: "", type: "text", required: false, options: [],
  });
  const [optionsText, setOptionsText] = useState("");

  if (isLoading || !crm || !stages) return <SectionLoading />;

  const stageCandidate = newStage.trim().toLowerCase();
  const stageValid = /^[a-z0-9][a-z0-9_-]*$/.test(stageCandidate) && stageCandidate.length <= 40;
  const moveStage = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= stages.length) return;
    const next = [...stages];
    [next[idx], next[target]] = [next[target], next[idx]];
    setStages(next);
  };

  const openAddField = () => {
    setEditingFieldKey(null);
    setFieldForm({ key: "", label: "", type: "text", required: false, options: [] });
    setOptionsText("");
    setFieldDialogOpen(true);
  };
  const openEditField = (f: CrmCustomField) => {
    setEditingFieldKey(f.key);
    setFieldForm({ ...f });
    setOptionsText((f.options ?? []).join(", "));
    setFieldDialogOpen(true);
  };
  const saveField = () => {
    const options = optionsText.split(",").map((o) => o.trim()).filter(Boolean);
    const field: CrmCustomField = {
      ...fieldForm,
      key: fieldForm.key.trim(),
      label: fieldForm.label.trim(),
      options: fieldForm.type === "select" ? options : undefined,
    };
    if (editingFieldKey) {
      const { key: _key, ...patch } = field;
      updateField.mutate({ tenantId, key: editingFieldKey, patch });
    } else {
      addField.mutate({ tenantId, field });
    }
  };
  const fieldBusy = addField.isPending || updateField.isPending;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Custom fields</CardTitle>
            <CardDescription>Extra attributes captured on CRM contacts.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={openAddField} disabled={crm.customFields.length >= 50}>
            <Plus className="w-4 h-4 mr-1" /> Add field
          </Button>
        </CardHeader>
        <CardContent>
          {crm.customFields.length === 0 ? (
            <p className="text-sm text-muted-foreground">No custom fields defined.</p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Label</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Required</TableHead>
                    <TableHead>Options</TableHead>
                    <TableHead className="w-[90px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {crm.customFields.map((f) => (
                    <TableRow key={f.key}>
                      <TableCell className="font-mono text-xs">{f.key}</TableCell>
                      <TableCell>{f.label}</TableCell>
                      <TableCell><Badge variant="secondary">{f.type}</Badge></TableCell>
                      <TableCell>{f.required ? "Yes" : "No"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                        {(f.options ?? []).join(", ") || "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="sm" onClick={() => openEditField(f)}>Edit</Button>
                          <Button
                            variant="ghost" size="icon" className="text-destructive"
                            disabled={removeField.isPending}
                            onClick={() => removeField.mutate({ tenantId, key: f.key })}
                            aria-label={`Remove ${f.key}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pipeline stages</CardTitle>
          <CardDescription>Ordered deal stages (2–20, lowercase, unique).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 max-w-xl">
          {stages.map((stage, idx) => (
            <div key={stage} className="flex items-center gap-2 rounded-lg border p-2.5">
              <span className="text-xs text-muted-foreground w-6 text-center font-mono">{idx + 1}</span>
              <span className="flex-1 text-sm font-medium">{stage}</span>
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={idx === 0} onClick={() => moveStage(idx, -1)} aria-label="Move up">
                <ArrowUp className="w-3.5 h-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={idx === stages.length - 1} onClick={() => moveStage(idx, 1)} aria-label="Move down">
                <ArrowDown className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                disabled={stages.length <= 2}
                onClick={() => setStages(stages.filter((s) => s !== stage))}
                aria-label={`Remove ${stage}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Input
              value={newStage}
              placeholder="new_stage"
              onChange={(e) => setNewStage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && stageValid && !stages.includes(stageCandidate)) {
                  setStages([...stages, stageCandidate]);
                  setNewStage("");
                }
              }}
            />
            <Button
              variant="outline"
              disabled={!stageValid || stages.includes(stageCandidate) || stages.length >= 20}
              onClick={() => {
                setStages([...stages, stageCandidate]);
                setNewStage("");
              }}
            >
              <Plus className="w-4 h-4 mr-1" /> Add
            </Button>
          </div>
          <Button
            onClick={() => saveStages.mutate({ tenantId, stages })}
            disabled={saveStages.isPending || stages.length < 2}
          >
            {saveStages.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
            Save stages
          </Button>
        </CardContent>
      </Card>

      {/* Custom field dialog */}
      <Dialog open={fieldDialogOpen} onOpenChange={setFieldDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingFieldKey ? "Edit custom field" : "Add custom field"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cf-key">Key</Label>
              <Input
                id="cf-key"
                value={fieldForm.key}
                disabled={!!editingFieldKey}
                placeholder="customer_tier"
                onChange={(e) => setFieldForm({ ...fieldForm, key: e.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">lowercase snake_case, stable identifier</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cf-label">Label</Label>
              <Input
                id="cf-label"
                value={fieldForm.label}
                maxLength={80}
                placeholder="Customer tier"
                onChange={(e) => setFieldForm({ ...fieldForm, label: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3 items-end">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select
                  value={fieldForm.type}
                  onValueChange={(v) => setFieldForm({ ...fieldForm, type: v as CrmCustomField["type"] })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FIELD_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2 pb-2">
                <Switch
                  id="cf-required"
                  checked={fieldForm.required}
                  onCheckedChange={(v) => setFieldForm({ ...fieldForm, required: v })}
                />
                <Label htmlFor="cf-required">Required</Label>
              </div>
            </div>
            {fieldForm.type === "select" && (
              <div className="space-y-1.5">
                <Label htmlFor="cf-options">Options (comma-separated)</Label>
                <Input
                  id="cf-options"
                  value={optionsText}
                  placeholder="gold, silver, bronze"
                  onChange={(e) => setOptionsText(e.target.value)}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFieldDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={saveField}
              disabled={
                fieldBusy ||
                !fieldForm.label.trim() ||
                (!editingFieldKey && !/^[a-z0-9][a-z0-9_]*$/.test(fieldForm.key.trim())) ||
                (fieldForm.type === "select" && optionsText.split(",").map((o) => o.trim()).filter(Boolean).length === 0)
              }
            >
              {fieldBusy && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              {editingFieldKey ? "Update field" : "Add field"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


// ─── FAQ knowledge base ──────────────────────────────────────────────────────

interface FaqEntryForm { q: string; a: string }

function FaqSection({ tenantId }: { tenantId: string }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.tenantConfig.getFaq.useQuery({ tenantId });
  const [entries, setEntries] = useState<FaqEntryForm[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data) setEntries(data.map((e) => ({ q: e.q, a: e.a })));
  }, [data]);

  const save = trpc.tenantConfig.setFaq.useMutation({
    onSuccess: () => {
      toast.success("FAQ saved");
      setDirty(false);
      utils.tenantConfig.getFaq.invalidate({ tenantId });
    },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading) return <SectionLoading />;

  const setEntry = (idx: number, patch: Partial<FaqEntryForm>) => {
    setEntries(entries.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
    setDirty(true);
  };

  const duplicates = new Set(
    entries
      .map((e) => e.q.trim().toLowerCase())
      .filter((q, i, arr) => q !== "" && arr.indexOf(q) !== i),
  );

  const handleSave = () => {
    const cleaned = entries
      .map((e) => ({ q: e.q.trim(), a: e.a.trim() }))
      .filter((e) => e.q !== "" || e.a !== "");
    if (cleaned.some((e) => e.q === "" || e.a === "")) {
      toast.error("Every FAQ entry needs both a question and an answer");
      return;
    }
    if (duplicates.size > 0) {
      toast.error(`Duplicate question${duplicates.size > 1 ? "s" : ""}: ${Array.from(duplicates).map((q) => `"${q}"`).join(", ")}`);
      return;
    }
    save.mutate({ tenantId, faq: cleaned });
  };

  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader>
        <CardTitle className="text-base">FAQ Knowledge Base</CardTitle>
        <CardDescription>
          Question/answer pairs the chat agent uses to answer buyers. Max 100 entries; questions
          must be unique (case-insensitive). Saved as a full replace.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {entries.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <HelpCircle className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No FAQ entries yet</p>
            <p className="text-xs mt-1">Add common buyer questions (delivery time, payment, returns) so the agent can answer them.</p>
          </div>
        )}
        {entries.map((e, idx) => (
          <div key={idx} className="rounded-lg border border-border/50 p-3 space-y-2">
            <div className="flex items-start gap-2">
              <div className="flex-1 space-y-2">
                <Input
                  placeholder="Question (e.g. How long does delivery take?)"
                  value={e.q}
                  maxLength={500}
                  onChange={(ev) => setEntry(idx, { q: ev.target.value })}
                  className={duplicates.has(e.q.trim().toLowerCase()) && e.q.trim() !== "" ? "border-red-500/60" : ""}
                />
                <Textarea
                  placeholder="Answer"
                  value={e.a}
                  maxLength={2000}
                  rows={2}
                  onChange={(ev) => setEntry(idx, { a: ev.target.value })}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-400 hover:text-red-300"
                onClick={() => { setEntries(entries.filter((_, i) => i !== idx)); setDirty(true); }}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={entries.length >= 100}
            onClick={() => { setEntries([...entries, { q: "", a: "" }]); setDirty(true); }}
          >
            <Plus className="w-3.5 h-3.5" />
            Add entry ({entries.length}/100)
          </Button>
          <Button size="sm" className="gap-1.5" onClick={handleSave} disabled={!dirty || save.isPending}>
            {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save FAQ
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Promo codes ─────────────────────────────────────────────────────────────

interface PromoRow {
  code: string;
  type: "percent" | "fixed";
  value: number;
  minTotal?: number;
  expiresAt?: string;
  maxUses?: number;
  usedCount: number;
}

interface PromoFormState {
  code: string;
  type: "percent" | "fixed";
  value: string;
  minTotal: string;
  expiresAt: string; // datetime-local
  maxUses: string;
}

const EMPTY_PROMO_FORM: PromoFormState = {
  code: "", type: "percent", value: "", minTotal: "", expiresAt: "", maxUses: "",
};

function promoFormToPayload(form: PromoFormState) {
  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
  return {
    code: form.code.trim(),
    type: form.type,
    value: Number(form.value),
    minTotal: num(form.minTotal),
    expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined,
    maxUses: num(form.maxUses) != null ? Math.floor(Number(form.maxUses)) : undefined,
  };
}

function PromosSection({ tenantId }: { tenantId: string }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.promos.list.useQuery({ tenantId });
  const promos = (data?.promos ?? []) as PromoRow[];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [form, setForm] = useState<PromoFormState>(EMPTY_PROMO_FORM);

  const invalidate = () => utils.promos.list.invalidate({ tenantId });

  const create = trpc.promos.create.useMutation({
    onSuccess: () => {
      toast.success("Promo created");
      setDialogOpen(false);
      setForm(EMPTY_PROMO_FORM);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.promos.update.useMutation({
    onSuccess: () => {
      toast.success("Promo updated");
      setDialogOpen(false);
      setEditingCode(null);
      setForm(EMPTY_PROMO_FORM);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.promos.delete.useMutation({
    onSuccess: () => { toast.success("Promo deleted"); invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading) return <SectionLoading />;

  const openCreate = () => {
    setEditingCode(null);
    setForm(EMPTY_PROMO_FORM);
    setDialogOpen(true);
  };
  const openEdit = (p: PromoRow) => {
    setEditingCode(p.code);
    setForm({
      code: p.code,
      type: p.type,
      value: String(p.value),
      minTotal: p.minTotal != null ? String(p.minTotal) : "",
      // datetime-local needs local time without seconds/Z
      expiresAt: p.expiresAt ? new Date(p.expiresAt).toISOString().slice(0, 16) : "",
      maxUses: p.maxUses != null ? String(p.maxUses) : "",
    });
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!form.code.trim() || form.value.trim() === "" || !Number.isFinite(Number(form.value))) {
      toast.error("Code and a numeric value are required");
      return;
    }
    if (form.type === "percent" && Number(form.value) > 100) {
      toast.error("Percent promo value must be ≤ 100");
      return;
    }
    const payload = promoFormToPayload(form);
    if (editingCode) {
      const { code: _code, ...patch } = payload;
      update.mutate({ tenantId, code: editingCode, patch });
    } else {
      create.mutate({ tenantId, promo: payload });
    }
  };

  const pending = create.isPending || update.isPending;

  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">Promo Codes</CardTitle>
          <CardDescription>
            Discount codes validated at checkout. Fixed values and minimum totals are in naira (₦).
          </CardDescription>
        </div>
        <Button size="sm" className="gap-1.5" onClick={openCreate}>
          <Plus className="w-3.5 h-3.5" />
          New promo
        </Button>
      </CardHeader>
      <CardContent>
        {promos.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Tag className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No promo codes yet</p>
            <p className="text-xs mt-1">Create one to offer percent or fixed-amount discounts.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Discount</TableHead>
                <TableHead>Min. total</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Uses</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {promos.map((p) => {
                const expired = p.expiresAt ? new Date(p.expiresAt).getTime() < Date.now() : false;
                const exhausted = p.maxUses != null && p.usedCount >= p.maxUses;
                return (
                  <TableRow key={p.code}>
                    <TableCell className="font-mono text-sm">
                      {p.code}
                      {(expired || exhausted) && (
                        <Badge variant="outline" className="ml-2 text-[10px] text-amber-400 border-amber-500/30">
                          {expired ? "expired" : "exhausted"}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {p.type === "percent" ? `${p.value}%` : `₦${p.value.toLocaleString()}`}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {p.minTotal != null ? `₦${p.minTotal.toLocaleString()}` : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {p.expiresAt ? new Date(p.expiresAt).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {p.usedCount}{p.maxUses != null ? ` / ${p.maxUses}` : ""}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>Edit</Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-400 hover:text-red-300"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate({ tenantId, code: p.code })}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingCode ? `Edit promo ${editingCode}` : "New promo code"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label>Code</Label>
                <Input
                  value={form.code}
                  disabled={!!editingCode}
                  placeholder="WELCOME10"
                  onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                />
                <p className="text-[11px] text-muted-foreground">Alphanumeric with - or _, 2–32 chars. Unique per tenant.</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Type</Label>
                  <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as "percent" | "fixed" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="percent">Percent off</SelectItem>
                      <SelectItem value="fixed">Fixed amount off (₦)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{form.type === "percent" ? "Percent (0–100)" : "Amount (₦)"}</Label>
                  <Input type="number" min={0} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Min. order total (₦, optional)</Label>
                  <Input type="number" min={0} value={form.minTotal} onChange={(e) => setForm({ ...form, minTotal: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>Max uses (optional)</Label>
                  <Input type="number" min={1} value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Expires at (optional)</Label>
                <Input type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSubmit} disabled={pending}>
                {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : editingCode ? "Save changes" : "Create promo"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function SectionLoading() {
  return (
    <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
      <Loader2 className="w-5 h-5 animate-spin" /> Loading…
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function TenantSettings() {
  const { activeTenantId } = useActiveTenant();
  const tenantId = activeTenantId;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Settings2 className="w-6 h-6 text-primary" />
            Tenant Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Branding, domains, commerce, inventory and CRM configuration for the active tenant.
          </p>
        </div>

        <Tabs defaultValue="branding">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="branding" className="gap-1.5"><Palette className="w-3.5 h-3.5" /> Branding</TabsTrigger>
            <TabsTrigger value="domains" className="gap-1.5"><Globe className="w-3.5 h-3.5" /> Domains</TabsTrigger>
            <TabsTrigger value="commerce" className="gap-1.5"><ShoppingCart className="w-3.5 h-3.5" /> Commerce</TabsTrigger>
            <TabsTrigger value="inventory" className="gap-1.5"><Warehouse className="w-3.5 h-3.5" /> Inventory</TabsTrigger>
            <TabsTrigger value="crm" className="gap-1.5"><Users className="w-3.5 h-3.5" /> CRM</TabsTrigger>
            <TabsTrigger value="faq" className="gap-1.5"><HelpCircle className="w-3.5 h-3.5" /> FAQ</TabsTrigger>
            <TabsTrigger value="promos" className="gap-1.5"><Tag className="w-3.5 h-3.5" /> Promos</TabsTrigger>
          </TabsList>
          <TabsContent value="branding" className="mt-4"><BrandingSection tenantId={tenantId} /></TabsContent>
          <TabsContent value="domains" className="mt-4"><DomainsSection tenantId={tenantId} /></TabsContent>
          <TabsContent value="commerce" className="mt-4"><CommerceSection tenantId={tenantId} /></TabsContent>
          <TabsContent value="inventory" className="mt-4"><InventorySection tenantId={tenantId} /></TabsContent>
          <TabsContent value="crm" className="mt-4"><CrmSection tenantId={tenantId} /></TabsContent>
          <TabsContent value="faq" className="mt-4"><FaqSection tenantId={tenantId} /></TabsContent>
          <TabsContent value="promos" className="mt-4"><PromosSection tenantId={tenantId} /></TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
