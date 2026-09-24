// === W47 merchant ===
/**
 * ONB-M-3: this wizard was previously fake end-to-end (toast-only WhatsApp
 * "verification", toast-only products/zones, hardcoded checklist, toast-only
 * go-live). Every step now persists through the real APIs:
 *   WhatsApp  → onboarding.updateStep { step: "whatsapp" } (conflict-checked)
 *   Products  → product.create (per product, honest partial-failure surface)
 *   Zones     → tenantConfig.getCommerceConfig / setCommerceConfig
 *   SLA       → sla.updateConfig (already real)
 *   Go Live   → onboarding.validate THEN onboarding.activate (KYB + validation
 *               enforced server-side); failures surface the server's message.
 * The review checklist is derived from onboarding.getStatus — nothing is
 * hardcoded "done".
 */
import { useState, useEffect } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  CheckCircle2,
  MessageSquare,
  Package,
  MapPin,
  Clock,
  Rocket,
  ChevronRight,
  ChevronLeft,
  Phone,
  Plus,
  Trash2,
  AlertCircle,
  XCircle,
} from "lucide-react";
import { Save, RefreshCw } from "lucide-react";

// ─── Step definitions ─────────────────────────────────────────────────────────
const STEPS = [
  { id: "whatsapp", label: "WhatsApp", icon: MessageSquare, description: "Connect your business number" },
  { id: "products", label: "Products", icon: Package, description: "Add your first products" },
  { id: "delivery", label: "Delivery Zones", icon: MapPin, description: "Set your coverage areas" },
  { id: "sla", label: "Escrow SLA", icon: Clock, description: "Configure release deadlines" },
  { id: "review", label: "Go Live", icon: Rocket, description: "Review and launch" },
];

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "Unknown error");
}

// ─── Step 1: WhatsApp Setup (REAL: onboarding.updateStep whatsapp) ───────────
function WhatsAppStep({ tenantId, onNext }: { tenantId: string; onNext: () => void }) {
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [wabaId, setWabaId] = useState("");
  const updateStep = trpc.onboarding.updateStep.useMutation();

  const handleSave = async () => {
    if (!phoneNumberId.trim() || !accessToken.trim()) {
      toast.error("Enter both the Phone Number ID and the Access Token from your Meta Business Manager.");
      return;
    }
    try {
      await updateStep.mutateAsync({
        tenantId,
        step: "whatsapp",
        data: {
          phoneNumberId: phoneNumberId.trim(),
          accessToken: accessToken.trim(),
          ...(wabaId.trim() ? { wabaId: wabaId.trim() } : {}),
        },
      });
      toast.success("WhatsApp credentials saved — they will be verified live when you go live.");
      onNext();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1">Connect your WhatsApp Business number</h2>
        <p className="text-sm text-muted-foreground">
          Customers will send orders to this number. You need a WhatsApp Business API (Cloud API) account.
        </p>
      </div>
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex gap-3">
        <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
        <div className="text-sm text-amber-800">
          <p className="font-medium">Where to find these</p>
          <p>
            Meta Business Manager → WhatsApp → API Setup: copy the <b>Phone number ID</b> and a permanent
            <b> access token</b>. Credentials are encrypted at rest and verified live against the Meta Graph API
            during the go-live check — nothing is "connected" until that check passes.
          </p>
        </div>
      </div>
      <div className="space-y-4">
        <div>
          <label className="text-sm font-medium mb-1.5 block">Phone Number ID *</label>
          <div className="relative">
            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="e.g. 123456789012345"
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium mb-1.5 block">Access Token *</label>
          <Input
            type="password"
            placeholder="Permanent access token"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
          />
        </div>
        <div>
          <label className="text-sm font-medium mb-1.5 block">WhatsApp Business Account ID (optional)</label>
          <Input
            placeholder="WABA ID (enables template management)"
            value={wabaId}
            onChange={(e) => setWabaId(e.target.value)}
          />
        </div>
      </div>
      <div className="flex gap-3">
        <Button onClick={handleSave} disabled={updateStep.isPending} className="flex-1">
          {updateStep.isPending ? "Saving…" : <>Save & Continue <ChevronRight className="h-4 w-4 ml-1" /></>}
        </Button>
      </div>
      {!updateStep.isPending && (
        <Button variant="ghost" className="text-sm text-muted-foreground" onClick={onNext}>
          Skip for now — I'll set this up later
        </Button>
      )}
    </div>
  );
}

// ─── Step 2: Products (REAL: product.create) ──────────────────────────────────
function ProductsStep({ tenantId, onNext, onBack }: { tenantId: string; onNext: () => void; onBack: () => void }) {
  const [products, setProducts] = useState([{ name: "", price: "", description: "" }]);
  const [saving, setSaving] = useState(false);
  const createProduct = trpc.product.create.useMutation();

  const addProduct = () => setProducts((p) => [...p, { name: "", price: "", description: "" }]);
  const removeProduct = (i: number) => setProducts((p) => p.filter((_, idx) => idx !== i));
  const updateProduct = (i: number, field: string, value: string) =>
    setProducts((p) => p.map((item, idx) => (idx === i ? { ...item, [field]: value } : item)));

  const handleNext = async () => {
    const valid = products.filter((p) => p.name.trim() && p.price.trim());
    if (valid.length === 0) {
      toast.error("Add at least one product with a name and price to continue.");
      return;
    }
    setSaving(true);
    const failures: string[] = [];
    let created = 0;
    for (const p of valid) {
      try {
        await createProduct.mutateAsync({
          tenantId,
          sku: `ONB-${Date.now().toString(36)}-${created + 1}`,
          name: p.name.trim(),
          description: p.description.trim() || undefined,
          price: String(Number(p.price) || 0),
          currency: "NGN",
        });
        created++;
      } catch (e) {
        failures.push(`${p.name.trim()}: ${errMsg(e)}`);
      }
    }
    setSaving(false);
    if (failures.length) {
      toast.error(`${failures.length} product(s) failed to save — ${failures[0]}`);
      if (created === 0) return; // honest dead-end: do NOT advance on total failure
    }
    toast.success(`${created} product(s) saved. You can add more from the Products page.`);
    onNext();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1">Add your first products</h2>
        <p className="text-sm text-muted-foreground">
          These will appear in your WhatsApp catalogue. You can add more later from the Products page.
        </p>
      </div>
      <div className="space-y-3">
        {products.map((product, i) => (
          <div key={i} className="border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">Product {i + 1}</span>
              {products.length > 1 && (
                <Button variant="ghost" size="sm" onClick={() => removeProduct(i)} className="h-7 w-7 p-0 text-destructive">
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium mb-1 block">Product Name *</label>
                <Input
                  placeholder="e.g. Ankara Fabric"
                  value={product.name}
                  onChange={(e) => updateProduct(i, "name", e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Price (₦) *</label>
                <Input
                  placeholder="e.g. 5000"
                  type="number"
                  value={product.price}
                  onChange={(e) => updateProduct(i, "price", e.target.value)}
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Description (optional)</label>
              <Textarea
                placeholder="Brief description of the product..."
                value={product.description}
                onChange={(e) => updateProduct(i, "description", e.target.value)}
                rows={2}
              />
            </div>
          </div>
        ))}
        <Button variant="outline" className="w-full" onClick={addProduct}>
          <Plus className="h-4 w-4 mr-2" /> Add Another Product
        </Button>
      </div>
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack}><ChevronLeft className="h-4 w-4 mr-1" />Back</Button>
        <Button onClick={handleNext} disabled={saving} className="flex-1">
          {saving ? "Saving…" : <>Save Products <ChevronRight className="h-4 w-4 ml-1" /></>}
        </Button>
      </div>
    </div>
  );
}

// ─── Step 3: Delivery Zones (REAL: tenantConfig.setCommerceConfig) ────────────
function DeliveryZonesStep({ tenantId, onNext, onBack }: { tenantId: string; onNext: () => void; onBack: () => void }) {
  const [zones, setZones] = useState([{ name: "", fee: "", eta: "" }]);
  const commerceConfig = trpc.tenantConfig.getCommerceConfig.useQuery({ tenantId });
  const setCommerceConfig = trpc.tenantConfig.setCommerceConfig.useMutation();

  const addZone = () => setZones((z) => [...z, { name: "", fee: "", eta: "" }]);
  const removeZone = (i: number) => setZones((z) => z.filter((_, idx) => idx !== i));
  const updateZone = (i: number, field: string, value: string) =>
    setZones((z) => z.map((item, idx) => (idx === i ? { ...item, [field]: value } : item)));

  const handleNext = async () => {
    const valid = zones.filter((z) => z.name.trim());
    if (valid.length === 0) {
      toast.error("Add at least one delivery zone to continue.");
      return;
    }
    try {
      const existing = commerceConfig.data ?? { currency: "NGN", pickupEnabled: true, deliveryZones: [] };
      const newZones = valid.map((z) => ({
        name: z.name.trim(),
        fee: Number(z.fee) || 0,
        currency: "NGN",
        ...(z.eta.trim() ? { estimatedDays: Number(z.eta) || 0 } : {}),
      }));
      await setCommerceConfig.mutateAsync({
        tenantId,
        config: {
          currency: existing.currency ?? "NGN",
          pickupEnabled: existing.pickupEnabled ?? true,
          deliveryZones: [...(existing.deliveryZones ?? []), ...newZones],
        },
      });
      toast.success(`${newZones.length} delivery zone(s) saved.`);
      onNext();
    } catch (e) {
      toast.error(`Could not save delivery zones: ${errMsg(e)}`);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1">Set your delivery zones</h2>
        <p className="text-sm text-muted-foreground">
          Define the areas you deliver to, the delivery fee, and estimated delivery time.
        </p>
      </div>
      <div className="space-y-3">
        {zones.map((zone, i) => (
          <div key={i} className="border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">Zone {i + 1}</span>
              {zones.length > 1 && (
                <Button variant="ghost" size="sm" onClick={() => removeZone(i)} className="h-7 w-7 p-0 text-destructive">
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-1">
                <label className="text-xs font-medium mb-1 block">Zone Name *</label>
                <Input
                  placeholder="e.g. Lagos Island"
                  value={zone.name}
                  onChange={(e) => updateZone(i, "name", e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Delivery Fee (₦)</label>
                <Input
                  placeholder="e.g. 1500"
                  type="number"
                  value={zone.fee}
                  onChange={(e) => updateZone(i, "fee", e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">ETA (days)</label>
                <Input
                  placeholder="e.g. 2"
                  type="number"
                  value={zone.eta}
                  onChange={(e) => updateZone(i, "eta", e.target.value)}
                />
              </div>
            </div>
          </div>
        ))}
        <Button variant="outline" className="w-full" onClick={addZone}>
          <Plus className="h-4 w-4 mr-2" /> Add Another Zone
        </Button>
      </div>
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack}><ChevronLeft className="h-4 w-4 mr-1" />Back</Button>
        <Button onClick={handleNext} disabled={setCommerceConfig.isPending} className="flex-1">
          {setCommerceConfig.isPending ? "Saving…" : <>Save Zones <ChevronRight className="h-4 w-4 ml-1" /></>}
        </Button>
      </div>
    </div>
  );
}

// ─── Step 4: SLA Config (already real: sla.updateConfig) ──────────────────────
function SlaConfigStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [releaseHours, setReleaseHours] = useState(72);
  const [warningHours, setWarningHours] = useState(24);
  const [autoRelease, setAutoRelease] = useState(true);
  const updateSla = trpc.sla.updateConfig.useMutation();

  const handleNext = async () => {
    try {
      await updateSla.mutateAsync({ releaseDeadlineHours: releaseHours, warningHours, autoReleaseEnabled: autoRelease });
      toast.success(`SLA configured — escrow will auto-release after ${releaseHours}h.`);
      onNext();
    } catch (e) {
      toast.error(`Could not save SLA settings: ${errMsg(e)}. You can update this later in the Escrow Dashboard.`);
      onNext();
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1">Configure escrow release deadline</h2>
        <p className="text-sm text-muted-foreground">
          After delivery is confirmed, funds are held in escrow for the buyer to raise a dispute. After this window, funds are automatically released to you.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="border rounded-lg p-4 space-y-2">
          <label className="text-sm font-medium block">Auto-release deadline</label>
          <p className="text-xs text-muted-foreground">Hours after delivery before funds release automatically</p>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={720}
              value={releaseHours}
              onChange={(e) => setReleaseHours(Number(e.target.value))}
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">hours ({Math.round(releaseHours / 24)} days)</span>
          </div>
        </div>
        <div className="border rounded-lg p-4 space-y-2">
          <label className="text-sm font-medium block">Warning alert threshold</label>
          <p className="text-xs text-muted-foreground">Hours before deadline to send you a warning notification</p>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={168}
              value={warningHours}
              onChange={(e) => setWarningHours(Number(e.target.value))}
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">hours</span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 border rounded-lg p-4">
        <input
          type="checkbox"
          id="autoRelease"
          checked={autoRelease}
          onChange={(e) => setAutoRelease(e.target.checked)}
          className="h-4 w-4"
        />
        <div>
          <label htmlFor="autoRelease" className="text-sm font-medium cursor-pointer">Enable automatic release</label>
          <p className="text-xs text-muted-foreground">Funds will be released automatically when the deadline passes without a dispute</p>
        </div>
      </div>
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack}><ChevronLeft className="h-4 w-4 mr-1" />Back</Button>
        <Button onClick={handleNext} disabled={updateSla.isPending} className="flex-1">
          {updateSla.isPending ? "Saving..." : <>Save SLA Settings <ChevronRight className="h-4 w-4 ml-1" /></>}
        </Button>
      </div>
    </div>
  );
}

// ─── Step 5: Review & Go Live (REAL: getStatus checklist + validate + activate)
function ReviewStep({ tenantId, onComplete, onBack }: { tenantId: string; onComplete: () => void; onBack: () => void }) {
  const status = trpc.onboarding.getStatus.useQuery({ tenantId }, { enabled: !!tenantId });
  const validate = trpc.onboarding.validate.useMutation();
  const activate = trpc.onboarding.activate.useMutation();
  const [busy, setBusy] = useState(false);

  const s = status.data;
  const checklistItems = [
    { label: "WhatsApp Business number configured", done: !!s?.whatsappConfigured },
    { label: "Payout bank details captured", done: !!s?.payoutConfigured },
    { label: "Live connection validation passed", done: !!s?.validationPassed },
    { label: "Business verification (KYB) approved", done: s?.tenantStatus === "active" || s?.status === "live" },
  ];

  const handleGoLive = async () => {
    if (!tenantId) {
      toast.error("No business is linked to this account yet.");
      return;
    }
    setBusy(true);
    try {
      // Honest two-phase go-live: run the LIVE validation first, then the
      // gated activate (KYB enforced server-side). Failures surface the
      // server's real reason — no toast-only success.
      const report = await validate.mutateAsync({ tenantId });
      if (!report.passed) {
        toast.error(`Validation failed: ${(report as any).reasons?.join("; ") || "connection checks failed"}. Fix the issues and try again.`);
        return;
      }
      await activate.mutateAsync({ tenantId });
      toast.success("You're live! Customers can now place orders on your WhatsApp number.");
      onComplete();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
      status.refetch();
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1">You're ready to go live!</h2>
        <p className="text-sm text-muted-foreground">
          Review your setup below. Go-live runs a live connection check and requires approved business verification (KYB).
        </p>
      </div>
      <div className="border rounded-lg divide-y">
        {checklistItems.map((item, i) => (
          <div key={i} className="flex items-center gap-3 p-3">
            {item.done ? (
              <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
            ) : (
              <XCircle className="h-5 w-5 text-muted-foreground shrink-0" />
            )}
            <span className="text-sm">{item.label}</span>
            <Badge variant={item.done ? "secondary" : "outline"} className="ml-auto text-xs">
              {item.done ? "Done" : "Pending"}
            </Badge>
          </div>
        ))}
      </div>
      <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
        <p className="font-medium">What happens when you go live?</p>
        <ul className="mt-1 space-y-1 list-disc list-inside text-green-700">
          <li>We verify your WhatsApp credentials live against the Meta Graph API</li>
          <li>Your approved KYB status is confirmed (a legal go-live requirement)</li>
          <li>Only then does your store open for customer orders — payments are held in escrow until delivery</li>
        </ul>
      </div>
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack}><ChevronLeft className="h-4 w-4 mr-1" />Back</Button>
        <Button onClick={handleGoLive} disabled={busy} className="flex-1 bg-green-600 hover:bg-green-700">
          <Rocket className="h-4 w-4 mr-2" /> {busy ? "Checking…" : "Go Live Now"}
        </Button>
      </div>
    </div>
  );
}

// ─── Main Wizard ──────────────────────────────────────────────────────────────
export default function OnboardingWizard({ onComplete }: { onComplete?: () => void }) {
  const [currentStep, setCurrentStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");

  // Load saved progress on mount (tenantId comes from the session server-side)
  const { data: savedProgress } = trpc.onboardingProgress.getProgress.useQuery();
  const tenantId = savedProgress?.tenantId ?? "";

  // Restore progress when data loads
  useEffect(() => {
    if (savedProgress && !savedProgress.isCompleted && savedProgress.completedSteps.length > 0) {
      setCurrentStep(savedProgress.currentStep);
      setCompletedSteps(new Set(savedProgress.completedSteps as number[]));
    }
  }, [savedProgress?.tenantId]);

  const saveProgressMutation = trpc.onboardingProgress.saveProgress.useMutation();

  const handleSaveAndContinueLater = async () => {
    setSaveStatus("saving");
    try {
      await saveProgressMutation.mutateAsync({
        currentStep,
        completedSteps: Array.from(completedSteps),
        stepData: {},
        isCompleted: false,
      });
      setSaveStatus("saved");
      toast.success("Progress saved! You can resume anytime from your dashboard.");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch {
      setSaveStatus("idle");
      toast.error("Failed to save progress");
    }
  };

  const markComplete = (step: number) => {
    setCompletedSteps((prev) => new Set([...Array.from(prev), step]));
  };

  const goNext = () => {
    markComplete(currentStep);
    setCurrentStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const goBack = () => setCurrentStep((s) => Math.max(s - 1, 0));

  const handleComplete = () => {
    markComplete(currentStep);
    saveProgressMutation.mutateAsync({
      currentStep: STEPS.length - 1,
      completedSteps: Array.from(new Set([...Array.from(completedSteps), currentStep])),
      stepData: {},
      isCompleted: true,
    }).catch(() => {});
    onComplete?.();
  };

  const progressPct = ((completedSteps.size) / STEPS.length) * 100;

  return (
    <DashboardLayout>
    <div className="min-h-screen bg-muted/30 flex items-start justify-center pt-8 pb-16 px-4">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold">Set up your store</h1>
          <p className="text-muted-foreground mt-1">Complete these steps to start accepting orders on WhatsApp</p>
          <div className="mt-4">
            <Progress value={progressPct} className="h-2" />
            <p className="text-xs text-muted-foreground mt-1">{completedSteps.size} of {STEPS.length} steps completed</p>
          </div>
        </div>

        {/* Step indicators */}
        <div className="flex items-center justify-between mb-8 px-2">
          {STEPS.map((step, i) => {
            const Icon = step.icon;
            const isDone = completedSteps.has(i);
            const isActive = currentStep === i;
            return (
              <div key={step.id} className="flex flex-col items-center gap-1 flex-1">
                <button
                  onClick={() => isDone && setCurrentStep(i)}
                  className={`h-10 w-10 rounded-full flex items-center justify-center border-2 transition-colors ${
                    isDone
                      ? "bg-green-500 border-green-500 text-white cursor-pointer"
                      : isActive
                      ? "bg-primary border-primary text-primary-foreground"
                      : "bg-background border-muted-foreground/30 text-muted-foreground"
                  }`}
                >
                  {isDone ? <CheckCircle2 className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
                </button>
                <span className={`text-xs font-medium hidden sm:block ${isActive ? "text-foreground" : "text-muted-foreground"}`}>
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>

        {/* Step content */}
        <div className="bg-background border rounded-xl p-6 shadow-sm">
          {!tenantId && savedProgress === undefined ? (
            <p className="text-sm text-muted-foreground">Loading your business…</p>
          ) : !tenantId ? (
            <p className="text-sm text-muted-foreground">No business is linked to this account yet — create one first.</p>
          ) : (
            <>
              {currentStep === 0 && <WhatsAppStep tenantId={tenantId} onNext={goNext} />}
              {currentStep === 1 && <ProductsStep tenantId={tenantId} onNext={goNext} onBack={goBack} />}
              {currentStep === 2 && <DeliveryZonesStep tenantId={tenantId} onNext={goNext} onBack={goBack} />}
              {currentStep === 3 && <SlaConfigStep onNext={goNext} onBack={goBack} />}
              {currentStep === 4 && <ReviewStep tenantId={tenantId} onComplete={handleComplete} onBack={goBack} />}
            </>
          )}
        </div>

        {/* Save and Continue Later */}
        {currentStep < STEPS.length - 1 && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSaveAndContinueLater}
              disabled={saveStatus === "saving"}
              className="text-muted-foreground hover:text-foreground gap-2"
            >
              {saveStatus === "saving" ? (
                <><RefreshCw className="h-3.5 w-3.5 animate-spin" />Saving…</>
              ) : saveStatus === "saved" ? (
                <><CheckCircle2 className="h-3.5 w-3.5 text-green-500" />Progress saved</>
              ) : (
                <><Save className="h-3.5 w-3.5" />Save and continue later</>
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
    </DashboardLayout>
  );
}
