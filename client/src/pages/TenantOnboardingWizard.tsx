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
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { Separator } from "@/components/ui/separator";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { useActiveTenant } from "@/contexts/TenantContext";
import {
  AlertTriangle, Check, CheckCircle2, ChevronLeft, ChevronRight, ChevronsUpDown,
  Loader2, Rocket, ShieldCheck, Upload, X, XCircle,
} from "lucide-react";

// Same list used by the platform-admin-initiated onboarding
// (client/src/pages/TenantOnboarding.tsx) — kept in sync for consistency,
// since both flows feed the same businessType field into KYC (server/routers/kyc.ts).
const BUSINESS_TYPES = [
  "Food & Beverage", "Fashion & Apparel", "Electronics", "Health & Beauty",
  "Home & Garden", "Sports & Outdoors", "Books & Education", "Services",
  "Agriculture", "Automotive", "Jewelry", "Toys & Games", "Other",
] as const;
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
  { id: "kyb", label: "KYB Verification" },
  { id: "activate", label: "Activate" },
] as const;

// server/routers/kyc.ts's uploadDocument document types — the two most
// directly relevant to a business (as opposed to individual) KYB. Personal-ID
// types (national_id, passport, …) exist for KYC and aren't collected here.
const KYB_DOCUMENT_TYPES = [
  { type: "business_registration" as const, label: "Business registration document" },
  { type: "directors_id" as const, label: "Director's ID" },
];

const KYB_STATUS_META: Record<string, { label: string; className: string }> = {
  not_started: { label: "Not started", className: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30" },
  pending: { label: "Pending review", className: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  approved: { label: "Approved", className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  rejected: { label: "Rejected", className: "bg-red-500/15 text-red-300 border-red-500/30" },
  resubmit_required: { label: "Resubmission required", className: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
};

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
  const { user, refresh } = useAuth();
  const [, navigate] = useLocation();
  const { activeTenantId, setActiveTenantId } = useActiveTenant();
  // A brand-new self-service user has no tenant yet, so users.tenantId is the
  // source of truth — NOT activeTenantId, which is a cross-page, localStorage
  // -backed default that has nothing to do with them and previously caused
  // this page to try to load a tenant they don't own (rejected by
  // assertTenantAccess) with no way to actually create one. createdTenantId
  // covers the gap right after startMutation succeeds but before the
  // session (and therefore user.tenantId) has refreshed. Platform admins,
  // who are tenant-less by design, fall back to the shared picker so they
  // can configure a specific tenant they manage.
  const [createdTenantId, setCreatedTenantId] = useState<string | null>(null);
  const tenantId = createdTenantId || user?.tenantId || (user?.role === "admin" ? activeTenantId : "");
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
  const [businessTypeOpen, setBusinessTypeOpen] = useState(false);
  const [businessTypeOther, setBusinessTypeOther] = useState("");
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
  const logoInputRef = useRef<HTMLInputElement>(null);
  const uploadLogoMutation = trpc.tenantConfig.uploadLogo.useMutation({
    onSuccess: (data) => setBranding((b) => ({ ...b, logoUrl: data.url })),
    onError: (e) => toast.error(`Logo upload failed: ${e.message}`),
  });
  const handleLogoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image file");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Logo must be under 5MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => uploadLogoMutation.mutate({ tenantId, imageBase64: reader.result as string });
    reader.onerror = () => toast.error("Could not read the selected file");
    reader.readAsDataURL(file);
  };

  // ── KYB (server/services/kycGate.ts) ────────────────────────────────────
  // onboarding.activate hard-requires an admin-approved KYB application.
  // getOrCreateApplication returns any existing draft/pending one (idempotent),
  // so this only ever creates one the first time a tenant reaches this step.
  const [kybAppId, setKybAppId] = useState<string | null>(null);
  const getOrCreateKyb = trpc.kyc.getOrCreateApplication.useMutation({
    onSuccess: (app) => setKybAppId(app.id),
    onError: (e) => toast.error(`Could not start KYB verification: ${e.message}`),
  });
  useEffect(() => {
    if (tenantId && !kybAppId && !getOrCreateKyb.isPending) {
      getOrCreateKyb.mutate({ tenantId, type: "kyb" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const { data: kybApp, refetch: refetchKyb } = trpc.kyc.getApplication.useQuery(
    { applicationId: kybAppId ?? "" },
    { enabled: !!kybAppId },
  );
  const kybApproved = kybApp?.status === "approved";

  const [kybForm, setKybForm] = useState({
    applicantName: "", applicantEmail: "", applicantPhone: "",
    businessName: "", businessRegistrationNumber: "", businessCountry: "", businessType: "",
  });
  useEffect(() => {
    if (!kybApp) return;
    setKybForm({
      applicantName: kybApp.applicantName ?? user?.name ?? "",
      applicantEmail: kybApp.applicantEmail ?? user?.email ?? "",
      applicantPhone: kybApp.applicantPhone ?? "",
      businessName: kybApp.businessName ?? provision.name ?? "",
      businessRegistrationNumber: kybApp.businessRegistrationNumber ?? "",
      businessCountry: kybApp.businessCountry ?? "",
      businessType: kybApp.businessType ?? provision.businessType ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kybApp?.id]);

  const saveKybMutation = trpc.kyc.updateApplication.useMutation({
    onSuccess: () => { toast.success("KYB details saved"); refetchKyb(); },
    onError: (e) => toast.error(e.message),
  });
  const uploadKybDocMutation = trpc.kyc.uploadDocument.useMutation({
    onSuccess: () => { toast.success("Document uploaded"); refetchKyb(); },
    onError: (e) => toast.error(`Upload failed: ${e.message}`),
  });
  const submitKybMutation = trpc.kyc.submit.useMutation({
    onSuccess: () => { toast.success("Submitted for review"); refetchKyb(); },
    onError: (e) => toast.error(e.message),
  });

  const kybDocInputRefs = {
    business_registration: useRef<HTMLInputElement>(null),
    directors_id: useRef<HTMLInputElement>(null),
  };
  const handleKybDocChange = (
    documentType: "business_registration" | "directors_id",
  ) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !kybAppId) return;
    if (file.size > 10 * 1024 * 1024) { toast.error("File must be under 10MB"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      uploadKybDocMutation.mutate({
        applicationId: kybAppId,
        documentType,
        fileBase64: base64,
        mimeType: file.type || "application/octet-stream",
        fileName: file.name,
      });
    };
    reader.onerror = () => toast.error("Could not read the selected file");
    reader.readAsDataURL(file);
  };
  const kybDocsPresent = new Set((kybApp?.documents ?? []).map((d) => d.documentType));
  const kybCanSubmit =
    !!kybAppId &&
    kybForm.applicantName.trim() !== "" &&
    kybForm.businessName.trim() !== "" &&
    kybDocsPresent.has("business_registration") &&
    kybApp?.status !== "pending" && kybApp?.status !== "approved";

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
      setCreatedTenantId(data.tenantId);
      setActiveTenantId(data.tenantId);
      // users.tenantId only updates server-side for non-admin callers — refresh
      // the cached session so the rest of the app (sidebar, nav, etc.) picks it
      // up too, not just this page's local createdTenantId fallback.
      refresh();
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
      navigate("/portal");
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
  const canActivate = onboardingStatus === "validating" && status?.validationPassed === true && kybApproved;

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
              (s.id !== "business" && s.id !== "review" && s.id !== "kyb" && s.id !== "activate" && completedSteps.has(s.id)) ||
              (s.id === "review" && status?.validationPassed === true) ||
              (s.id === "kyb" && kybApproved) ||
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
                    {tenantId
                      ? "Configure, validate and activate your business."
                      : "Create your business to get started — this becomes your tenant."}
                    {user?.role === "admin" && " Platform admins can also provision a tenant on a business's behalf below."}
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
                  {(!tenantId || user?.role === "admin") && (
                    <>
                      {status && <Separator />}
                      <div className="space-y-4">
                        <h3 className="text-sm font-semibold">
                          {tenantId ? "Provision a new tenant" : "Create your business"}
                        </h3>
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
                            <Popover open={businessTypeOpen} onOpenChange={setBusinessTypeOpen}>
                              <PopoverTrigger asChild>
                                <Button
                                  id="ob-btype"
                                  variant="outline"
                                  role="combobox"
                                  aria-expanded={businessTypeOpen}
                                  className="w-full justify-between font-normal"
                                >
                                  {provision.businessType || "Select business type…"}
                                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
                                <Command>
                                  <CommandInput placeholder="Search business type…" />
                                  <CommandList>
                                    <CommandEmpty>No match found.</CommandEmpty>
                                    <CommandGroup>
                                      {BUSINESS_TYPES.map((t) => (
                                        <CommandItem
                                          key={t}
                                          value={t}
                                          onSelect={() => {
                                            setProvision((p) => ({ ...p, businessType: t }));
                                            setBusinessTypeOpen(false);
                                          }}
                                        >
                                          <Check
                                            className={cn(
                                              "mr-2 h-4 w-4",
                                              provision.businessType === t ? "opacity-100" : "opacity-0",
                                            )}
                                          />
                                          {t}
                                        </CommandItem>
                                      ))}
                                    </CommandGroup>
                                  </CommandList>
                                </Command>
                              </PopoverContent>
                            </Popover>
                            {provision.businessType === "Other" && (
                              <Input
                                className="mt-2"
                                value={businessTypeOther}
                                onChange={(e) => setBusinessTypeOther(e.target.value)}
                                placeholder="Describe your business type"
                              />
                            )}
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
                              businessType:
                                (provision.businessType === "Other"
                                  ? businessTypeOther.trim()
                                  : provision.businessType.trim()) || undefined,
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
                    <Label htmlFor="ob-logo">Logo (optional)</Label>
                    <div className="flex items-center gap-3">
                      {branding.logoUrl ? (
                        <img
                          src={branding.logoUrl}
                          alt="Logo preview"
                          className="h-12 w-12 rounded-lg object-contain border bg-muted/30"
                        />
                      ) : (
                        <div className="h-12 w-12 rounded-lg border border-dashed flex items-center justify-center text-muted-foreground">
                          <Upload className="h-4 w-4" />
                        </div>
                      )}
                      <Button
                        id="ob-logo"
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={uploadLogoMutation.isPending || !tenantId}
                        onClick={() => logoInputRef.current?.click()}
                      >
                        {uploadLogoMutation.isPending ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Upload className="w-3.5 h-3.5" />
                        )}
                        {branding.logoUrl ? "Replace" : "Upload"}
                      </Button>
                      {branding.logoUrl && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setBranding((b) => ({ ...b, logoUrl: "" }))}
                        >
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      <input
                        ref={logoInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handleLogoFileChange}
                      />
                    </div>
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

            {/* ── KYB Verification ─────────────────────────────────────── */}
            {step === "kyb" && (
              <>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    KYB Verification
                    {kybApp && (
                      <Badge variant="outline" className={(KYB_STATUS_META[kybApp.status] ?? KYB_STATUS_META.not_started).className}>
                        {(KYB_STATUS_META[kybApp.status] ?? KYB_STATUS_META.not_started).label}
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription>
                    A platform admin must approve this before the tenant can go live —
                    fill in your business details, upload the required documents, then submit for review.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6 max-w-2xl">
                  {kybApp?.status === "rejected" && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>Application rejected</AlertTitle>
                      <AlertDescription>{kybApp.rejectionReason || "See reviewer notes and resubmit."}</AlertDescription>
                    </Alert>
                  )}
                  {kybApp?.status === "resubmit_required" && (
                    <Alert>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>Resubmission required</AlertTitle>
                      <AlertDescription>{kybApp.reviewNotes || "The reviewer requested changes — update the details below and resubmit."}</AlertDescription>
                    </Alert>
                  )}
                  {kybApp?.status === "pending" && (
                    <Alert>
                      <Loader2 className="h-4 w-4" />
                      <AlertTitle>Submitted — awaiting review</AlertTitle>
                      <AlertDescription>A platform admin will review your application. You can still update details below if needed.</AlertDescription>
                    </Alert>
                  )}
                  {kybApp?.status === "approved" && (
                    <Alert>
                      <CheckCircle2 className="h-4 w-4" />
                      <AlertTitle>Approved</AlertTitle>
                      <AlertDescription>KYB verification is complete — you can proceed to Activate.</AlertDescription>
                    </Alert>
                  )}

                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold">Applicant</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label htmlFor="kyb-aname">Full name</Label>
                        <Input
                          id="kyb-aname"
                          value={kybForm.applicantName}
                          onChange={(e) => setKybForm((f) => ({ ...f, applicantName: e.target.value }))}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="kyb-aemail">Email</Label>
                        <Input
                          id="kyb-aemail"
                          type="email"
                          value={kybForm.applicantEmail}
                          onChange={(e) => setKybForm((f) => ({ ...f, applicantEmail: e.target.value }))}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="kyb-aphone">Phone</Label>
                        <Input
                          id="kyb-aphone"
                          value={kybForm.applicantPhone}
                          onChange={(e) => setKybForm((f) => ({ ...f, applicantPhone: e.target.value }))}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold">Business</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label htmlFor="kyb-bname">Registered business name</Label>
                        <Input
                          id="kyb-bname"
                          value={kybForm.businessName}
                          onChange={(e) => setKybForm((f) => ({ ...f, businessName: e.target.value }))}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="kyb-breg">Registration number</Label>
                        <Input
                          id="kyb-breg"
                          value={kybForm.businessRegistrationNumber}
                          onChange={(e) => setKybForm((f) => ({ ...f, businessRegistrationNumber: e.target.value }))}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="kyb-bcountry">Country</Label>
                        <Input
                          id="kyb-bcountry"
                          value={kybForm.businessCountry}
                          onChange={(e) => setKybForm((f) => ({ ...f, businessCountry: e.target.value }))}
                          placeholder="Nigeria"
                        />
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={saveKybMutation.isPending || !kybAppId}
                      onClick={() => kybAppId && saveKybMutation.mutate({ applicationId: kybAppId, ...kybForm })}
                    >
                      {saveKybMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                      Save details
                    </Button>
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold">Documents</h3>
                    {KYB_DOCUMENT_TYPES.map(({ type, label }) => {
                      const present = kybDocsPresent.has(type);
                      const ref = kybDocInputRefs[type];
                      return (
                        <div key={type} className="flex items-center gap-3 rounded-lg border p-3">
                          {present ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                          ) : (
                            <XCircle className="w-4 h-4 text-muted-foreground shrink-0" />
                          )}
                          <span className="text-sm flex-1">{label}</span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            disabled={uploadKybDocMutation.isPending || !kybAppId}
                            onClick={() => ref.current?.click()}
                          >
                            <Upload className="w-3.5 h-3.5" />
                            {present ? "Replace" : "Upload"}
                          </Button>
                          <input
                            ref={ref}
                            type="file"
                            accept="image/*,.pdf"
                            className="hidden"
                            onChange={handleKybDocChange(type)}
                          />
                        </div>
                      );
                    })}
                  </div>

                  <Button
                    disabled={!kybCanSubmit || submitKybMutation.isPending}
                    onClick={() => kybAppId && submitKybMutation.mutate({ applicationId: kybAppId })}
                  >
                    {submitKybMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                    Submit for review
                  </Button>
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
                  {!canActivate && !isLive && onboardingStatus !== "validating" && (
                    <Alert>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>Validation required</AlertTitle>
                      <AlertDescription>
                        Activation is blocked until validation passes (current status: {onboardingStatus}).
                        Go to the review step and run validation.
                      </AlertDescription>
                    </Alert>
                  )}
                  {!canActivate && !isLive && onboardingStatus === "validating" && !kybApproved && (
                    <Alert>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>KYB verification required</AlertTitle>
                      <AlertDescription>
                        {kybApp?.status === "pending"
                          ? "Your KYB application is submitted and awaiting admin review."
                          : "Complete and submit KYB verification before activating."}{" "}
                        Go to the KYB Verification step.
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
