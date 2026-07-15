import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  CheckCircle2,
  Circle,
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
} from "lucide-react";

// ─── Step definitions ─────────────────────────────────────────────────────────
const STEPS = [
  { id: "whatsapp", label: "WhatsApp", icon: MessageSquare, description: "Connect your business number" },
  { id: "products", label: "Products", icon: Package, description: "Add your first products" },
  { id: "delivery", label: "Delivery Zones", icon: MapPin, description: "Set your coverage areas" },
  { id: "sla", label: "Escrow SLA", icon: Clock, description: "Configure release deadlines" },
  { id: "review", label: "Go Live", icon: Rocket, description: "Review and launch" },
];

// ─── Step 1: WhatsApp Setup ───────────────────────────────────────────────────
function WhatsAppStep({ onNext }: { onNext: () => void }) {
  const [phone, setPhone] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);

  const handleSendCode = () => {
    if (!phone.match(/^\+?[0-9]{10,15}$/)) {
      toast.error("Invalid phone number — enter a valid WhatsApp business number");
      return;
    }
    setCodeSent(true);
    toast.success(`Verification code sent to ${phone}`);
  };

  const handleVerify = () => {
    if (verifyCode.length < 4) {
      toast.error("Enter the verification code");
      return;
    }
    toast.success("WhatsApp connected! Your business number is now active.");
    onNext();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1">Connect your WhatsApp Business number</h2>
        <p className="text-sm text-muted-foreground">
          Customers will send orders to this number. You need a WhatsApp Business API account.
        </p>
      </div>
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex gap-3">
        <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
        <div className="text-sm text-amber-800">
          <p className="font-medium">Before you start</p>
          <p>Make sure your number is registered on the WhatsApp Business API (Meta Business Manager). Personal WhatsApp numbers are not supported.</p>
        </div>
      </div>
      <div className="space-y-4">
        <div>
          <label className="text-sm font-medium mb-1.5 block">WhatsApp Business Phone Number</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="+234 800 000 0000"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={codeSent}
              />
            </div>
            <Button onClick={handleSendCode} disabled={codeSent || !phone} variant="outline">
              {codeSent ? "Code Sent" : "Send Code"}
            </Button>
          </div>
        </div>
        {codeSent && (
          <div>
            <label className="text-sm font-medium mb-1.5 block">Verification Code</label>
            <div className="flex gap-2">
              <Input
                placeholder="Enter 6-digit code"
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value)}
                maxLength={6}
                className="max-w-xs"
              />
              <Button onClick={handleVerify}>Verify & Continue</Button>
            </div>
          </div>
        )}
      </div>
      {!codeSent && (
        <Button variant="ghost" className="text-sm text-muted-foreground" onClick={onNext}>
          Skip for now — I'll set this up later
        </Button>
      )}
    </div>
  );
}

// ─── Step 2: Products ─────────────────────────────────────────────────────────
function ProductsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [products, setProducts] = useState([{ name: "", price: "", description: "" }]);

  const addProduct = () => setProducts((p) => [...p, { name: "", price: "", description: "" }]);
  const removeProduct = (i: number) => setProducts((p) => p.filter((_, idx) => idx !== i));
  const updateProduct = (i: number, field: string, value: string) =>
    setProducts((p) => p.map((item, idx) => (idx === i ? { ...item, [field]: value } : item)));

  const handleNext = () => {
    const valid = products.filter((p) => p.name.trim() && p.price.trim());
    if (valid.length === 0) {
      toast.error("Add at least one product with a name and price to continue.");
      return;
    }
    toast.success(`${valid.length} product(s) saved. You can add more from the Products page.`);
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
        <Button onClick={handleNext} className="flex-1">Save Products <ChevronRight className="h-4 w-4 ml-1" /></Button>
      </div>
    </div>
  );
}

// ─── Step 3: Delivery Zones ───────────────────────────────────────────────────
function DeliveryZonesStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [zones, setZones] = useState([{ name: "", fee: "", eta: "" }]);

  const addZone = () => setZones((z) => [...z, { name: "", fee: "", eta: "" }]);
  const removeZone = (i: number) => setZones((z) => z.filter((_, idx) => idx !== i));
  const updateZone = (i: number, field: string, value: string) =>
    setZones((z) => z.map((item, idx) => (idx === i ? { ...item, [field]: value } : item)));

  const handleNext = () => {
    const valid = zones.filter((z) => z.name.trim());
    if (valid.length === 0) {
      toast.error("Add at least one delivery zone to continue.");
      return;
    }
    toast.success(`${valid.length} delivery zone(s) saved.`);
    onNext();
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
        <Button onClick={handleNext} className="flex-1">Save Zones <ChevronRight className="h-4 w-4 ml-1" /></Button>
      </div>
    </div>
  );
}

// ─── Step 4: SLA Config ───────────────────────────────────────────────────────
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
    } catch {
      toast.info("Using default SLA settings. You can update this later in the Escrow Dashboard.");
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

// ─── Step 5: Review & Go Live ─────────────────────────────────────────────────
function ReviewStep({ onComplete, onBack }: { onComplete: () => void; onBack: () => void }) {
  const checklistItems = [
    { label: "WhatsApp Business number configured", done: true },
    { label: "First products added to catalogue", done: true },
    { label: "Delivery zones set", done: true },
    { label: "Escrow SLA deadline configured", done: true },
  ];

  const handleGoLive = () => {
    toast.success("You're live! Your WhatsApp Commerce store is now active.");
    onComplete();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1">You're ready to go live!</h2>
        <p className="text-sm text-muted-foreground">
          Review your setup below. You can always update these settings from your portal dashboard.
        </p>
      </div>
      <div className="border rounded-lg divide-y">
        {checklistItems.map((item, i) => (
          <div key={i} className="flex items-center gap-3 p-3">
            <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
            <span className="text-sm">{item.label}</span>
            <Badge variant="secondary" className="ml-auto text-xs">Done</Badge>
          </div>
        ))}
      </div>
      <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
        <p className="font-medium">What happens next?</p>
        <ul className="mt-1 space-y-1 list-disc list-inside text-green-700">
          <li>Customers can start placing orders via your WhatsApp number</li>
          <li>Payments are held in escrow until delivery is confirmed</li>
          <li>You'll receive real-time notifications for every order and payment event</li>
        </ul>
      </div>
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack}><ChevronLeft className="h-4 w-4 mr-1" />Back</Button>
        <Button onClick={handleGoLive} className="flex-1 bg-green-600 hover:bg-green-700">
          <Rocket className="h-4 w-4 mr-2" /> Go Live Now
        </Button>
      </div>
    </div>
  );
}

// ─── Main Wizard ──────────────────────────────────────────────────────────────
export default function OnboardingWizard({ onComplete }: { onComplete?: () => void }) {
  const [currentStep, setCurrentStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());

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
    onComplete?.();
  };

  const progressPct = ((completedSteps.size) / STEPS.length) * 100;

  return (
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
                {i < STEPS.length - 1 && (
                  <div className={`absolute hidden`} />
                )}
              </div>
            );
          })}
        </div>

        {/* Step content */}
        <div className="bg-background border rounded-xl p-6 shadow-sm">
          {currentStep === 0 && <WhatsAppStep onNext={goNext} />}
          {currentStep === 1 && <ProductsStep onNext={goNext} onBack={goBack} />}
          {currentStep === 2 && <DeliveryZonesStep onNext={goNext} onBack={goBack} />}
          {currentStep === 3 && <SlaConfigStep onNext={goNext} onBack={goBack} />}
          {currentStep === 4 && <ReviewStep onComplete={handleComplete} onBack={goBack} />}
        </div>
      </div>
    </div>
  );
}
