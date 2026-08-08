/**
 * TenantOnboardingWizard — tenant-facing provisioning wizard over the
 * onboarding router state machine (draft → configuring → validating →
 * live|failed).
 *
 * Steps: Business → WhatsApp credentials → Use-case selection → Integrations
 * → Branding → Review & Validate → Activate. Progress comes from
 * onboarding.getStatus (completedSteps + status); validation shows per-check
 * pass/fail from onboarding.validate; activate is blocked until validation
 * passes; failures display reasons with a retry path (retryValidation).
 */
import { useEffect, useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { useActiveTenant } from "@/contexts/TenantContext";
import {
  AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Rocket,
  ShieldCheck, XCircle,
} from "lucide-react";
import {
  DEFAULT_WA_MENU,
  sortUseCasesByOrder,
  WA_USE_CASE_IDS,
  type WaMenuUseCase,
} from "@shared/waMenu";
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from "@shared/tenantConfig";

const STEPS = [
  { id: "business", label: "Business" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "useCases", label: "Use cases" },
  { id: "integrations", label: "Integrations" },
  { id: "branding", label: "Branding" },
  { id: "review", label: "Review & Validate" },
  { id: "activate", label: "Activate" },
] as const;

type WizardStepId = (typeof STEPS)[number]["id"];

const STATUS_META: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30" },
  configuring: { label: "Configuring", className: "bg-blue-500/15 text-blue-300 border-blue-500/30" },
  validating: { label: "Validating", className: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  live: { label: "Live", className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  failed: { label: "Failed", className: "bg-red-500/15 text-red-300 border-red-500/30" },
};

const PROVIDER_LABELS: Record<IntegrationProvider, string> = {
  medusa: "Medusa (commerce engine)",
  twenty: "Twenty CRM",
  odoo: "Odoo ERP",
};

interface ValidationCheck {
  check: string;
  ok: boolean;
  detail?: string;
}

export default function TenantOnboardingWizard() {
  const { user } = useAuth();
  const { activeTenantId, setActiveTenantId } = useActiveTenant();
  const tenantId = activeTenantId;
  const utils = trpc.useUtils();

  const {
    data: status,
    isLoading,
    error: statusError,
    refetch: refetchStatus,
  } = trpc.onboarding.getStatus.useQuery({ tenantId }, { enabled: !!tenantId, retry: false });

  const [stepIdx, setStepIdx] = useState(0);
  const step: WizardStepId = STEPS[stepIdx].id;

  // ── Step forms ────────────────────────────────────────────────────────────
  const [provision, setProvision] = useState({ name: "", slug: "", plan: "starter", businessType: "" });
  const [waCreds, setWaCreds] = useState({ phoneNumberId: "", accessToken: "" });
  const [greeting, setGreeting] = useState(DEFAULT_WA_MENU.greeting);
  const [useCases, setUseCases] = useState<WaMenuUseCase[]>(DEFAULT_WA_MENU.useCases);
  const [integrationForms, setIntegrationForms] = useState<
    Record<IntegrationProvider, { url: string; apiKey: string; enabled: boolean }>
  >({
    medusa: { url: "", apiKey: "", enabled: false },
    twenty: { url: "", apiKey: "", enabled: false },
    odoo: { url: "", apiKey: "", enabled: false },
  });
  const [branding, setBranding] = useState({ name: "", logoUrl: "", primaryColor: "#8A5A2B" });
  const [checks, setChecks] = useState<ValidationCheck[] | null>(null);

  // Seed forms from the live config once loaded.
  const { data: savedMenu } = trpc.tenantConfig.getWaMenuConfig.useQuery(
    { tenantId },
    { enabled: !!tenantId },
  );
  useEffect(() => {
    if (savedMenu) {
      setGreeting(savedMenu.greeting);
      setUseCases(savedMenu.useCases);
    }
  }, [savedMenu]);
  const { data: savedBranding } = trpc.tenantConfig.getBrandingConfig.useQuery(
    { tenantId },
    { enabled: !!tenantId },
  );
  useEffect(() => {
    if (savedBranding) {
      setBranding({
        name: savedBranding.name,
        logoUrl: savedBranding.logoUrl ?? "",
        primaryColor: savedBranding.primaryColor,
      });
    }
  }, [savedBranding]);

  const completedSteps = useMemo(() => new Set(status?.completedSteps ?? []), [status]);
  const onboardingStatus = status?.status ?? "draft";
  const isLive = onboardingStatus === "live";

  // ── Mutations ─────────────────────────────────────────────────────────────
  const onMutationError = (e: { message: string }) => toast.error(e.message);

  const startMutation = trpc.onboarding.start.useMutation({
    onSuccess: (data) => {
      toast.success(`Tenant "${provision.name}" provisioned (${data.slug})`);
      setActiveTenantId(data.tenantId);
    },
    onError: onMutationError,
  });

  const updateStepMutation = trpc.onboarding.updateStep.useMutation({
    onSuccess: () => {
      utils.onboarding.getStatus.invalidate({ tenantId });
    },
    onError: onMutationError,
  });

  const validateMutation = trpc.onboarding.validate.useMutation({
    onSuccess: (data) => {
      setChecks(data.checks as ValidationCheck[]);
      if (data.passed) toast.success("Validation passed — you can activate now");
      else toast.error("Validation failed — see failing checks below");
      utils.onboarding.getStatus.invalidate({ tenantId });
    },
    onError: (e) => {
      setChecks(null);
      onMutationError(e);
    },
  });

  const retryMutation = trpc.onboarding.retryValidation.useMutation({
    onSuccess: () => {
      toast.success("Back to configuring — fix the issues and validate again");
      setChecks(null);
      utils.onboarding.getStatus.invalidate({ tenantId });
    },
    onError: onMutationError,
  });

  const activateMutation = trpc.onboarding.activate.useMutation({
    onSuccess: () => {
      toast.success("Tenant is live!");
      utils.onboarding.getStatus.invalidate({ tenantId });
    },
    onError: onMutationError,
  });

  const busy =
    updateStepMutation.isPending ||
    validateMutation.isPending ||
    activateMutation.isPending ||
    retryMutation.isPending ||
    startMutation.isPending;

  // ── Step save handlers ────────────────────────────────────────────────────
  const saveWhatsapp = () =>
    updateStepMutation.mutate(
      { tenantId, step: "whatsapp", data: { ...waCreds } },
      { onSuccess: () => setStepIdx((i) => i + 1) },
    );

  const saveUseCases = () =>
    updateStepMutation.mutate(
      {
        tenantId,
        step: "useCases",
        data: { greeting, useCases, fallback: savedMenu?.fallback ?? "nlp" },
      },
      { onSuccess: () => setStepIdx((i) => i + 1) },
    );

  const saveIntegrations = async () => {
    // Persist each provider the operator filled in, sequentially, so a zod
    // failure names the provider cleanly.
    for (const provider of INTEGRATION_PROVIDERS) {
      const form = integrationForms[provider];
      if (!form.url && !form.apiKey) continue;
      try {
        await updateStepMutation.mutateAsync({
          tenantId,
          step: "integrations",
          data: { provider, creds: { url: form.url, apiKey: form.apiKey, enabled: form.enabled } },
        });
      } catch (e: any) {
        toast.error(`${provider}: ${e.message}`);
        return;
      }
    }
    setStepIdx((i) => i + 1);
  };

  const saveBranding = () =>
    updateStepMutation.mutate(
      {
        tenantId,
        step: "branding",
        data: {
          name: branding.name,
          logoUrl: branding.logoUrl.trim() === "" ? null : branding.logoUrl.trim(),
          primaryColor: branding.primaryColor,
        },
      },
      { onSuccess: () => setStepIdx((i) => i + 1) },
    );

  const runValidate = () => validateMutation.mutate({ tenantId });
  const canActivate = onboardingStatus === "validating" && status?.validationPassed === true;

  const statusMeta = STATUS_META[onboardingStatus] ?? STATUS_META.draft;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6 max-w-5xl mx-auto">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Rocket className="w-6 h-6 text-primary" />
              Tenant Onboarding
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {status ? `Provisioning "${status.tenantId}" — configure, validate, go live.` : "Configure, validate and activate the tenant."}
            </p>
          </div>
          <Badge variant="outline" className={statusMeta.className}>{statusMeta.label}</Badge>
        </div>

        {/* Stepper */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1">
          {STEPS.map((s, i) => {
            const done =
              (s.id === "business" && !!status) ||
              (s.id !== "business" && s.id !== "review" && s.id !== "activate" && completedSteps.has(s.id)) ||
              (s.id === "review" && status?.validationPassed === true) ||
              (s.id === "activate" && isLive);
            const active = i === stepIdx;
            return (
              <div key={s.id} className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => setStepIdx(i)}
                  className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                    active
                      ? "border-primary text-primary"
                      : done
                        ? "border-emerald-500/40 text-emerald-300"
                        : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {done ? <CheckCircle2 className="w-3.5 h-3.5" /> : <span className="font-mono">{i + 1}</span>}
                  {s.label}
                </button>
                {i < STEPS.length - 1 && <ChevronRight className="w-3 h-3 text-muted-foreground" />}
              </div>
            );
          })}
        </div>

        {statusError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Could not load onboarding status</AlertTitle>
            <AlertDescription>{statusError.message}</AlertDescription>
          </Alert>
        )}
        {isLive && (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>This tenant is live</AlertTitle>
            <AlertDescription>
              Configuration is frozen in the wizard — use the tenant settings pages to make changes.
            </AlertDescription>
          </Alert>
        )}

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-16 justify-center">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading onboarding state…
          </div>
        ) : (
          <Card>
            {/* ── Business ─────────────────────────────────────────────── */}
            {step === "business" && (
              <>
                <CardHeader>
                  <CardTitle className="text-base">Business</CardTitle>
                  <CardDescription>
                    The wizard configures the currently selected tenant (switch it in the sidebar).
                    Platform admins can also provision a brand-new tenant here.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {status && (
                    <div className="rounded-lg border p-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground text-xs">Tenant</p>
                        <p className="font-medium">{status.tenantId}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-xs">Tenant status</p>
                        <p className="font-medium capitalize">{status.tenantStatus}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-xs">Onboarding</p>
                        <p className="font-medium capitalize">{onboardingStatus}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-xs">WhatsApp creds</p>
                        <p className="font-medium">{status.whatsappConfigured ? "Configured" : "Missing"}</p>
                      </div>
                    </div>
                  )}
                  {user?.role === "admin" && (
                    <>
                      <Separator />
                      <div className="space-y-4">
                        <h3 className="text-sm font-semibold">Provision a new tenant</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="space-y-1.5">
                            <Label htmlFor="ob-name">Business name</Label>
                            <Input
                              id="ob-name"
                              value={provision.name}
                              onChange={(e) => setProvision((p) => ({ ...p, name: e.target.value }))}
                              placeholder="Ada's Provisions"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="ob-slug">Slug (optional)</Label>
                            <Input
                              id="ob-slug"
                              value={provision.slug}
                              onChange={(e) => setProvision((p) => ({ ...p, slug: e.target.value }))}
                              placeholder="adas-provisions"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label>Plan</Label>
                            <Select
                              value={provision.plan}
                              onValueChange={(v) => setProvision((p) => ({ ...p, plan: v }))}
                            >
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="starter">Starter</SelectItem>
                                <SelectItem value="growth">Growth</SelectItem>
                                <SelectItem value="enterprise">Enterprise</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="ob-btype">Business type (optional)</Label>
                            <Input
                              id="ob-btype"
                              value={provision.businessType}
                              onChange={(e) => setProvision((p) => ({ ...p, businessType: e.target.value }))}
                              placeholder="Food & Beverage"
                            />
                          </div>
                        </div>
                        <Button
                          variant="secondary"
                          disabled={!provision.name.trim() || busy}
                          onClick={() =>
                            startMutation.mutate({
                              name: provision.name.trim(),
                              slug: provision.slug.trim() || undefined,
                              plan: provision.plan as "starter" | "growth" | "enterprise",
                              businessType: provision.businessType.trim() || undefined,
                            })
                          }
                        >
                          {startMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                          Provision tenant
                        </Button>
                      </div>
                    </>
                  )}
                </CardContent>
              </>
            )}

            {/* ── WhatsApp creds ───────────────────────────────────────── */}
            {step === "whatsapp" && (
              <>
                <CardHeader>
                  <CardTitle className="text-base">WhatsApp Business credentials</CardTitle>
                  <CardDescription>
                    From the Meta developer console: the phone number ID and a permanent access token.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 max-w-lg">
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-pnid">Phone number ID</Label>
                    <Input
                      id="ob-pnid"
                      value={waCreds.phoneNumberId}
                      onChange={(e) => setWaCreds((c) => ({ ...c, phoneNumberId: e.target.value }))}
                      placeholder="123456789012345"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-token">Access token</Label>
                    <Input
                      id="ob-token"
                      type="password"
                      value={waCreds.accessToken}
                      onChange={(e) => setWaCreds((c) => ({ ...c, accessToken: e.target.value }))}
                      placeholder="EAA…"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Stored in the tenant settings vault; never displayed back.
                    </p>
                  </div>
                  <Button
                    onClick={saveWhatsapp}
                    disabled={busy || isLive || !waCreds.phoneNumberId.trim() || !waCreds.accessToken}
                  >
                    {updateStepMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                    Save & continue
                  </Button>
                </CardContent>
              </>
            )}

            {/* ── Use cases ────────────────────────────────────────────── */}
            {step === "useCases" && (
              <>
                <CardHeader>
                  <CardTitle className="text-base">Use-case selection</CardTitle>
                  <CardDescription>
                    Which buyer flows the WhatsApp menu offers. Fine-tune order and custom replies
                    later in the WA Menu Builder.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 max-w-2xl">
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-greeting">Greeting</Label>
                    <Textarea
                      id="ob-greeting"
                      rows={2}
                      value={greeting}
                      onChange={(e) => setGreeting(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    {sortUseCasesByOrder(useCases).map((uc) => (
                      <div key={uc.id} className="flex items-center justify-between rounded-lg border p-3">
                        <div>
                          <p className="text-sm font-medium">{uc.label}</p>
                          <p className="text-[11px] text-muted-foreground font-mono">{uc.id}</p>
                        </div>
                        <Switch
                          checked={uc.enabled}
                          onCheckedChange={(v) =>
                            setUseCases((list) => list.map((u) => (u.id === uc.id ? { ...u, enabled: v } : u)))
                          }
                        />
                      </div>
                    ))}
                  </div>
                  <Button onClick={saveUseCases} disabled={busy || isLive || !greeting.trim()}>
                    {updateStepMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                    Save & continue
                  </Button>
                </CardContent>
              </>
            )}

            {/* ── Integrations ─────────────────────────────────────────── */}
            {step === "integrations" && (
              <>
                <CardHeader>
                  <CardTitle className="text-base">Integrations</CardTitle>
                  <CardDescription>
                    Connect external systems. Leave a system empty to skip it — only enabled
                    integrations are validated before activation.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 max-w-2xl">
                  {INTEGRATION_PROVIDERS.map((provider) => {
                    const form = integrationForms[provider];
                    return (
                      <div key={provider} className="rounded-lg border p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium">{PROVIDER_LABELS[provider]}</p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            Enabled
                            <Switch
                              checked={form.enabled}
                              onCheckedChange={(v) =>
                                setIntegrationForms((f) => ({ ...f, [provider]: { ...f[provider], enabled: v } }))
                              }
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <Input
                            placeholder="https://…"
                            value={form.url}
                            onChange={(e) =>
                              setIntegrationForms((f) => ({ ...f, [provider]: { ...f[provider], url: e.target.value } }))
                            }
                          />
                          <Input
                            type="password"
                            placeholder="API key"
                            value={form.apiKey}
                            onChange={(e) =>
                              setIntegrationForms((f) => ({
                                ...f,
                                [provider]: { ...f[provider], apiKey: e.target.value },
                              }))
                            }
                          />
                        </div>
                      </div>
                    );
                  })}
                  <div className="flex gap-2">
                    <Button onClick={saveIntegrations} disabled={busy || isLive}>
                      {updateStepMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                      Save & continue
                    </Button>
                    <Button variant="ghost" onClick={() => setStepIdx((i) => i + 1)} disabled={busy}>
                      Skip for now
                    </Button>
                  </div>
                </CardContent>
              </>
            )}

            {/* ── Branding ─────────────────────────────────────────────── */}
            {step === "branding" && (
              <>
                <CardHeader>
                  <CardTitle className="text-base">Branding</CardTitle>
                  <CardDescription>
                    Shown in the buyer-facing menu greeting and the admin shell.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 max-w-lg">
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-bname">Brand name</Label>
                    <Input
                      id="ob-bname"
                      value={branding.name}
                      onChange={(e) => setBranding((b) => ({ ...b, name: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-logo">Logo URL (optional)</Label>
                    <Input
                      id="ob-logo"
                      value={branding.logoUrl}
                      onChange={(e) => setBranding((b) => ({ ...b, logoUrl: e.target.value }))}
                      placeholder="https://cdn.example.com/logo.png"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-color">Primary color</Label>
                    <div className="flex items-center gap-3">
                      <input
                        id="ob-color"
                        type="color"
                        value={branding.primaryColor}
                        onChange={(e) => setBranding((b) => ({ ...b, primaryColor: e.target.value }))}
                        className="h-9 w-14 rounded border bg-transparent cursor-pointer"
                      />
                      <Input
                        value={branding.primaryColor}
                        onChange={(e) => setBranding((b) => ({ ...b, primaryColor: e.target.value }))}
                        className="w-28 font-mono"
                        maxLength={7}
                      />
                    </div>
                  </div>
                  <Button
                    onClick={saveBranding}
                    disabled={
                      busy ||
                      isLive ||
                      !branding.name.trim() ||
                      !/^#[0-9a-fA-F]{6}$/.test(branding.primaryColor)
                    }
                  >
                    {updateStepMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                    Save & continue
                  </Button>
                </CardContent>
              </>
            )}

            {/* ── Review & Validate ────────────────────────────────────── */}
            {step === "review" && (
              <>
                <CardHeader>
                  <CardTitle className="text-base">Review & validate</CardTitle>
                  <CardDescription>
                    Runs live checks: WhatsApp Graph API credentials plus a connection test per
                    enabled integration.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 max-w-2xl">
                  <div className="rounded-lg border p-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    {(["whatsapp", "useCases", "integrations", "branding"] as const).map((s) => (
                      <div key={s} className="flex items-center gap-2">
                        {completedSteps.has(s) ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <XCircle className="w-4 h-4 text-muted-foreground" />
                        )}
                        <span className="capitalize">{s === "useCases" ? "Use cases" : s}</span>
                      </div>
                    ))}
                  </div>

                  {onboardingStatus === "failed" && (status?.reasons?.length ?? 0) > 0 && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>Last validation failed</AlertTitle>
                      <AlertDescription>
                        <ul className="list-disc pl-4">
                          {status!.reasons.map((r, i) => <li key={i}>{r}</li>)}
                        </ul>
                      </AlertDescription>
                    </Alert>
                  )}

                  {checks && (
                    <div className="space-y-2">
                      {checks.map((c, i) => (
                        <div
                          key={i}
                          className={`flex items-start gap-3 rounded-lg border p-3 ${
                            c.ok ? "border-emerald-500/30" : "border-red-500/40"
                          }`}
                        >
                          {c.ok ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5" />
                          ) : (
                            <XCircle className="w-4 h-4 text-red-400 mt-0.5" />
                          )}
                          <div>
                            <p className="text-sm font-medium capitalize">{c.check}</p>
                            {c.detail && <p className="text-xs text-muted-foreground">{c.detail}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-2 flex-wrap">
                    <Button onClick={runValidate} disabled={busy || isLive}>
                      {validateMutation.isPending ? (
                        <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                      ) : (
                        <ShieldCheck className="w-4 h-4 mr-1" />
                      )}
                      {onboardingStatus === "failed" ? "Re-run validation" : "Run validation"}
                    </Button>
                    {onboardingStatus === "failed" && (
                      <Button variant="outline" onClick={() => retryMutation.mutate({ tenantId })} disabled={busy}>
                        Back to editing (retry)
                      </Button>
                    )}
                  </div>
                  {status?.validatedAt && (
                    <p className="text-xs text-muted-foreground">
                      Last validated at {new Date(status.validatedAt).toLocaleString()}
                    </p>
                  )}
                </CardContent>
              </>
            )}

            {/* ── Activate ─────────────────────────────────────────────── */}
            {step === "activate" && (
              <>
                <CardHeader>
                  <CardTitle className="text-base">Activate</CardTitle>
                  <CardDescription>
                    Flips the tenant live: the WhatsApp bot starts serving buyers with the
                    configured menu and integrations.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 max-w-lg">
                  {!canActivate && !isLive && (
                    <Alert>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>Validation required</AlertTitle>
                      <AlertDescription>
                        Activation is blocked until validation passes (current status: {onboardingStatus}).
                        Go to the review step and run validation.
                      </AlertDescription>
                    </Alert>
                  )}
                  {isLive ? (
                    <div className="flex items-center gap-2 text-emerald-300">
                      <CheckCircle2 className="w-5 h-5" /> Tenant is live.
                    </div>
                  ) : (
                    <Button
                      size="lg"
                      onClick={() => activateMutation.mutate({ tenantId })}
                      disabled={!canActivate || busy}
                    >
                      {activateMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                      Activate tenant
                    </Button>
                  )}
                </CardContent>
              </>
            )}
          </Card>
        )}

        {/* Footer nav */}
        <div className="flex justify-between">
          <Button
            variant="outline"
            onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
            disabled={stepIdx === 0}
          >
            <ChevronLeft className="w-4 h-4 mr-1" /> Back
          </Button>
          <Button
            variant="outline"
            onClick={() => setStepIdx((i) => Math.min(STEPS.length - 1, i + 1))}
            disabled={stepIdx === STEPS.length - 1}
          >
            Next <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      </div>
    </DashboardLayout>
  );
}
