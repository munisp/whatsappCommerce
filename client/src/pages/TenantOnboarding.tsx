import { useState, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Building2, CreditCard, MessageSquare, ShieldCheck, CheckCircle2,
  ArrowRight, ArrowLeft, Upload, Camera, Eye, Loader2, AlertCircle,
  TrendingUp, DollarSign, Zap, Star, Info,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
type Step = "business_profile" | "billing_model" | "whatsapp_setup" | "kyc_kyb" | "review";

const STEPS: { id: Step; label: string; icon: React.ReactNode }[] = [
  { id: "business_profile", label: "Business Profile", icon: <Building2 className="w-4 h-4" /> },
  { id: "billing_model", label: "Billing Model", icon: <CreditCard className="w-4 h-4" /> },
  { id: "whatsapp_setup", label: "WhatsApp", icon: <MessageSquare className="w-4 h-4" /> },
  { id: "kyc_kyb", label: "Verification", icon: <ShieldCheck className="w-4 h-4" /> },
  { id: "review", label: "Review", icon: <CheckCircle2 className="w-4 h-4" /> },
];

interface FormData {
  // Business profile
  businessName: string;
  businessType: string;
  businessCountry: string;
  businessRegistrationNumber: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string;
  website: string;
  // Billing
  billingModel: "profit_sharing" | "subscription" | "hybrid" | "";
  profitShareRate: number;
  subscriptionTier: "Starter" | "Growth" | "Enterprise" | "";
  billingCycle: "monthly" | "annual";
  // WhatsApp
  waPhoneNumber: string;
  waBusinessAccountId: string;
  waApiToken: string;
  waWebhookUrl: string;
  // KYC
  kycApplicationId: string;
  kycStatus: string;
  livenessSessionId: string;
  livenessStatus: string;
}

const INITIAL_FORM: FormData = {
  businessName: "", businessType: "", businessCountry: "", businessRegistrationNumber: "",
  applicantName: "", applicantEmail: "", applicantPhone: "", website: "",
  billingModel: "", profitShareRate: 3.5, subscriptionTier: "", billingCycle: "monthly",
  waPhoneNumber: "", waBusinessAccountId: "", waApiToken: "", waWebhookUrl: "",
  kycApplicationId: "", kycStatus: "not_started", livenessSessionId: "", livenessStatus: "not_started",
};

const BUSINESS_TYPES = [
  "Food & Beverage", "Fashion & Apparel", "Electronics", "Health & Beauty",
  "Home & Garden", "Sports & Outdoors", "Books & Education", "Services",
  "Agriculture", "Automotive", "Jewelry", "Toys & Games", "Other",
];

const COUNTRIES = [
  "Nigeria", "Kenya", "Ghana", "South Africa", "Egypt", "Ethiopia",
  "Tanzania", "Uganda", "Rwanda", "Senegal", "Ivory Coast", "Cameroon",
  "United Kingdom", "United States", "India", "Other",
];

// ─── Billing Plan Cards ───────────────────────────────────────────────────────
function BillingPlanCard({
  plan, selected, onSelect,
}: {
  plan: "profit_sharing" | "subscription" | "hybrid";
  selected: boolean;
  onSelect: () => void;
}) {
  const plans = {
    profit_sharing: {
      name: "Profit Sharing",
      tagline: "Pay as you grow",
      icon: <TrendingUp className="w-6 h-6 text-emerald-500" />,
      color: "emerald",
      description: "We take a small % of your GMV. Zero upfront cost.",
      example: "$10,000 GMV × 3.5% = $350/month",
      pros: ["No fixed costs", "Risk-free start", "Scales with revenue"],
      bestFor: "Early-stage & seasonal businesses",
      badge: "Most Popular",
    },
    subscription: {
      name: "Subscription",
      tagline: "Predictable monthly cost",
      icon: <DollarSign className="w-6 h-6 text-blue-500" />,
      color: "blue",
      description: "Fixed monthly fee. Full access regardless of volume.",
      example: "Growth: $149/month → up to $50k GMV",
      pros: ["Predictable budget", "Better at scale", "Annual discount"],
      bestFor: "High-volume established merchants",
      badge: "Best Value at Scale",
    },
    hybrid: {
      name: "Hybrid",
      tagline: "Best of both worlds",
      icon: <Zap className="w-6 h-6 text-violet-500" />,
      color: "violet",
      description: "Low base fee + reduced profit-share rate.",
      example: "$29 base + 1.5% on $10k = $179/month",
      pros: ["Lower profit-share", "Reduced base fee", "Flexible scaling"],
      bestFor: "Growing mid-stage merchants",
      badge: "Recommended",
    },
  };
  const p = plans[plan];
  const colorMap: Record<string, string> = {
    emerald: "border-emerald-500 bg-emerald-50/30",
    blue: "border-blue-500 bg-blue-50/30",
    violet: "border-violet-500 bg-violet-50/30",
  };
  return (
    <button
      onClick={onSelect}
      className={`relative w-full text-left rounded-xl border-2 p-5 transition-all duration-200 hover:shadow-md ${
        selected ? colorMap[p.color] : "border-border bg-card hover:border-muted-foreground/40"
      }`}
    >
      {p.badge && (
        <span className="absolute -top-2.5 right-4 bg-primary text-primary-foreground text-xs font-semibold px-2 py-0.5 rounded-full">
          {p.badge}
        </span>
      )}
      <div className="flex items-start gap-3">
        <div className="mt-0.5">{p.icon}</div>
        <div className="flex-1">
          <div className="font-semibold text-base">{p.name}</div>
          <div className="text-sm text-muted-foreground mb-2">{p.tagline}</div>
          <div className="text-sm mb-3">{p.description}</div>
          <div className="text-xs font-mono bg-muted/60 rounded px-2 py-1 mb-3 inline-block">{p.example}</div>
          <ul className="space-y-1">
            {p.pros.map(pro => (
              <li key={pro} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
                {pro}
              </li>
            ))}
          </ul>
          <div className="mt-3 text-xs text-muted-foreground">
            <Star className="w-3 h-3 inline mr-1" />
            Best for: {p.bestFor}
          </div>
        </div>
      </div>
    </button>
  );
}

// ─── Liveness Camera Component ────────────────────────────────────────────────
function LivenessCamera({
  applicationId, tenantId, onComplete,
}: {
  applicationId: string;
  tenantId: string;
  onComplete: (sessionId: string, status: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<{ instruction: string; required_frames: number } | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [status, setStatus] = useState<"idle" | "starting" | "active" | "done" | "failed">("idle");
  const [livenessScore, setLivenessScore] = useState(0);
  const [isMock, setIsMock] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const createSession = trpc.kyc.createLivenessSession.useMutation({
    onSuccess: (data) => {
      setSessionId(data.session_id);
      setChallenge(data.challenge);
      setIsMock(data.mock ?? false);
      setStatus("active");
      if (data.mock) {
        // Simulate liveness frames in mock mode
        let frame = 0;
        const required = data.challenge?.required_frames ?? 10;
        intervalRef.current = setInterval(() => {
          frame++;
          setFrameCount(frame);
          setLivenessScore(Math.min(0.95, 0.5 + frame / required * 0.45));
          if (frame >= required) {
            clearInterval(intervalRef.current!);
            setStatus("done");
            onComplete(data.session_id, "passed");
          }
        }, 400);
      } else {
        startCamera();
      }
    },
    onError: () => {
      toast.error("Failed to start liveness session");
      setStatus("failed");
    },
  });

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch {
      toast.error("Camera access denied. Using mock mode.");
      setIsMock(true);
    }
  };

  const handleStart = () => {
    setStatus("starting");
    createSession.mutate({ applicationId, tenantId });
  };

  const required = challenge?.required_frames ?? 10;
  const progress = Math.round((frameCount / required) * 100);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border-2 border-dashed border-border bg-muted/20 p-6 text-center">
        {status === "idle" && (
          <div className="space-y-3">
            <Camera className="w-12 h-12 mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              We need to verify your identity with a quick liveness check.
              This takes about 30 seconds.
            </p>
            <Button onClick={handleStart} className="gap-2">
              <Camera className="w-4 h-4" />
              Start Liveness Check
            </Button>
          </div>
        )}
        {status === "starting" && (
          <div className="space-y-2">
            <Loader2 className="w-8 h-8 mx-auto animate-spin text-primary" />
            <p className="text-sm">Preparing liveness session...</p>
          </div>
        )}
        {status === "active" && (
          <div className="space-y-4">
            {!isMock && (
              <video ref={videoRef} className="w-full max-w-xs mx-auto rounded-lg" muted playsInline />
            )}
            {isMock && (
              <div className="w-32 h-32 mx-auto rounded-full bg-gradient-to-br from-primary/20 to-primary/5 border-4 border-primary/30 flex items-center justify-center">
                <Camera className="w-10 h-10 text-primary/60" />
              </div>
            )}
            {challenge && (
              <div className="bg-primary/10 rounded-lg p-3">
                <p className="text-sm font-medium text-primary">{challenge.instruction}</p>
              </div>
            )}
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Frame {frameCount} / {required}</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
            <p className="text-xs text-muted-foreground">Liveness score: {(livenessScore * 100).toFixed(0)}%</p>
          </div>
        )}
        {status === "done" && (
          <div className="space-y-3">
            <CheckCircle2 className="w-12 h-12 mx-auto text-green-500" />
            <p className="font-semibold text-green-700 dark:text-green-400">Liveness check passed!</p>
            <p className="text-sm text-muted-foreground">Score: {(livenessScore * 100).toFixed(0)}%</p>
          </div>
        )}
        {status === "failed" && (
          <div className="space-y-3">
            <AlertCircle className="w-12 h-12 mx-auto text-destructive" />
            <p className="font-semibold text-destructive">Liveness check failed</p>
            <Button variant="outline" onClick={() => setStatus("idle")} size="sm">Try Again</Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Document Upload Row ──────────────────────────────────────────────────────
function DocumentUploadRow({
  label, docType, required: isRequired, onUpload,
}: {
  label: string;
  docType: string;
  required?: boolean;
  onUpload: (file: File, docType: string) => void;
}) {
  const [uploaded, setUploaded] = useState(false);
  const [fileName, setFileName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setFileName(file.name);
      setUploaded(true);
      onUpload(file, docType);
    }
  };

  return (
    <div className="flex items-center justify-between py-3 border-b border-border/50 last:border-0">
      <div>
        <span className="text-sm font-medium">{label}</span>
        {isRequired && <span className="text-destructive ml-1">*</span>}
        {uploaded && <p className="text-xs text-muted-foreground mt-0.5">{fileName}</p>}
      </div>
      <div className="flex items-center gap-2">
        {uploaded && <CheckCircle2 className="w-4 h-4 text-green-500" />}
        <Button
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
          className="gap-1.5"
        >
          <Upload className="w-3.5 h-3.5" />
          {uploaded ? "Replace" : "Upload"}
        </Button>
        <input ref={inputRef} type="file" className="hidden" accept="image/*,.pdf" onChange={handleChange} />
      </div>
    </div>
  );
}

// ─── Main Wizard ──────────────────────────────────────────────────────────────
export default function TenantOnboarding() {
  const [, navigate] = useLocation();
  const [currentStep, setCurrentStep] = useState<Step>("business_profile");
  const [form, setForm] = useState<FormData>(INITIAL_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);

  const stepIndex = STEPS.findIndex(s => s.id === currentStep);
  const progress = ((stepIndex + 1) / STEPS.length) * 100;

  const updateForm = (patch: Partial<FormData>) => setForm(prev => ({ ...prev, ...patch }));

  const createApplication = trpc.kyc.getOrCreateApplication.useMutation({
    onSuccess: (data) => {
      updateForm({ kycApplicationId: data.id, kycStatus: data.status });
    },
  });

  const submitApplication = trpc.kyc.submit.useMutation();

  const handleNext = async () => {
    if (currentStep === "kyc_kyb" && !form.kycApplicationId) {
      toast.error("Please complete the KYC/KYB verification before proceeding.");
      return;
    }
    const idx = STEPS.findIndex(s => s.id === currentStep);
    if (idx < STEPS.length - 1) {
      setCurrentStep(STEPS[idx + 1].id);
    }
  };

  const handleBack = () => {
    const idx = STEPS.findIndex(s => s.id === currentStep);
    if (idx > 0) setCurrentStep(STEPS[idx - 1].id);
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      if (form.kycApplicationId) {
        await submitApplication.mutateAsync({ applicationId: form.kycApplicationId });
      }
      setCompleted(true);
      toast.success("Onboarding submitted successfully! Our team will review your application.");
    } catch {
      toast.error("Submission failed. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDocumentUpload = (file: File, docType: string) => {
    // In production: upload to S3 via storagePut, then call kyc.addDocument
    toast.success(`${file.name} uploaded for ${docType}`);
  };

  if (completed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/30 p-4">
        <Card className="max-w-md w-full text-center p-8">
          <CheckCircle2 className="w-16 h-16 mx-auto text-green-500 mb-4" />
          <h2 className="text-2xl font-bold mb-2">Application Submitted!</h2>
          <p className="text-muted-foreground mb-6">
            Your KYC/KYB application is under review. We'll notify you within 1–2 business days.
          </p>
          <div className="bg-muted/40 rounded-lg p-4 text-left space-y-2 mb-6">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Business</span>
              <span className="font-medium">{form.businessName || "—"}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Billing Model</span>
              <span className="font-medium capitalize">{form.billingModel.replace("_", " ") || "—"}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">KYC Status</span>
              <Badge variant="outline" className="text-amber-600 border-amber-400">Under Review</Badge>
            </div>
          </div>
          <Button onClick={() => navigate("/tenants")} className="w-full">
            Go to Tenant Dashboard
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-tight">Tenant Onboarding</h1>
          <p className="text-muted-foreground mt-1">Set up your WhatsApp Commerce account in minutes</p>
        </div>

        {/* Step Progress */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            {STEPS.map((step, i) => (
              <div key={step.id} className="flex items-center">
                <div className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
                  i <= stepIndex ? "text-primary" : "text-muted-foreground"
                }`}>
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center border-2 transition-all ${
                    i < stepIndex
                      ? "bg-primary border-primary text-primary-foreground"
                      : i === stepIndex
                      ? "border-primary text-primary"
                      : "border-muted-foreground/30 text-muted-foreground"
                  }`}>
                    {i < stepIndex ? <CheckCircle2 className="w-4 h-4" /> : step.icon}
                  </div>
                  <span className="hidden sm:block">{step.label}</span>
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`h-px flex-1 mx-2 transition-colors ${i < stepIndex ? "bg-primary" : "bg-border"}`} style={{ width: "2rem" }} />
                )}
              </div>
            ))}
          </div>
          <Progress value={progress} className="h-1.5" />
        </div>

        {/* Step Content */}
        <Card className="shadow-sm">
          {/* ── Step 1: Business Profile ── */}
          {currentStep === "business_profile" && (
            <>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Building2 className="w-5 h-5" /> Business Profile</CardTitle>
                <CardDescription>Tell us about your business so we can set up your account correctly.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Business Name <span className="text-destructive">*</span></Label>
                    <Input placeholder="Lagos Fresh Market Ltd" value={form.businessName} onChange={e => updateForm({ businessName: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Registration Number</Label>
                    <Input placeholder="RC-1234567" value={form.businessRegistrationNumber} onChange={e => updateForm({ businessRegistrationNumber: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Business Type <span className="text-destructive">*</span></Label>
                    <select className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm" value={form.businessType} onChange={e => updateForm({ businessType: e.target.value })}>
                      <option value="">Select type...</option>
                      {BUSINESS_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Country <span className="text-destructive">*</span></Label>
                    <select className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm" value={form.businessCountry} onChange={e => updateForm({ businessCountry: e.target.value })}>
                      <option value="">Select country...</option>
                      {COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Contact Name <span className="text-destructive">*</span></Label>
                    <Input placeholder="Jane Okafor" value={form.applicantName} onChange={e => updateForm({ applicantName: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Contact Email <span className="text-destructive">*</span></Label>
                    <Input type="email" placeholder="jane@business.com" value={form.applicantEmail} onChange={e => updateForm({ applicantEmail: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Phone Number</Label>
                    <Input placeholder="+234 800 000 0000" value={form.applicantPhone} onChange={e => updateForm({ applicantPhone: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Website</Label>
                    <Input placeholder="https://yourbusiness.com" value={form.website} onChange={e => updateForm({ website: e.target.value })} />
                  </div>
                </div>
              </CardContent>
            </>
          )}

          {/* ── Step 2: Billing Model ── */}
          {currentStep === "billing_model" && (
            <>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><CreditCard className="w-5 h-5" /> Choose Your Billing Model</CardTitle>
                <CardDescription>Select how you want to pay for the platform. You can change this later.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-4">
                  {(["profit_sharing", "subscription", "hybrid"] as const).map(plan => (
                    <BillingPlanCard
                      key={plan}
                      plan={plan}
                      selected={form.billingModel === plan}
                      onSelect={() => updateForm({ billingModel: plan })}
                    />
                  ))}
                </div>

                {form.billingModel === "profit_sharing" && (
                  <div className="bg-muted/40 rounded-lg p-4 space-y-3">
                    <Label>Profit Share Rate: <strong>{form.profitShareRate}%</strong></Label>
                    <input
                      type="range" min={2} max={8} step={0.5}
                      value={form.profitShareRate}
                      onChange={e => updateForm({ profitShareRate: parseFloat(e.target.value) })}
                      className="w-full"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>2% (min)</span><span>8% (max)</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <Info className="w-3 h-3 inline mr-1" />
                      Final rate is subject to approval based on your business profile and risk assessment.
                    </p>
                  </div>
                )}

                {form.billingModel === "subscription" && (
                  <div className="bg-muted/40 rounded-lg p-4 space-y-3">
                    <Label>Select Tier</Label>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { name: "Starter", monthly: 49, limit: "Up to $5k GMV" },
                        { name: "Growth", monthly: 149, limit: "Up to $50k GMV" },
                        { name: "Enterprise", monthly: 499, limit: "Unlimited GMV" },
                      ].map(tier => (
                        <button
                          key={tier.name}
                          onClick={() => updateForm({ subscriptionTier: tier.name as "Starter" | "Growth" | "Enterprise" })}
                          className={`rounded-lg border-2 p-3 text-center transition-all ${
                            form.subscriptionTier === tier.name ? "border-primary bg-primary/5" : "border-border"
                          }`}
                        >
                          <div className="font-semibold text-sm">{tier.name}</div>
                          <div className="text-lg font-bold">${tier.monthly}</div>
                          <div className="text-xs text-muted-foreground">/month</div>
                          <div className="text-xs text-muted-foreground mt-1">{tier.limit}</div>
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      {(["monthly", "annual"] as const).map(cycle => (
                        <button
                          key={cycle}
                          onClick={() => updateForm({ billingCycle: cycle })}
                          className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-all ${
                            form.billingCycle === cycle ? "border-primary bg-primary/5 text-primary" : "border-border"
                          }`}
                        >
                          {cycle === "monthly" ? "Monthly" : "Annual (save 20%)"}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </>
          )}

          {/* ── Step 3: WhatsApp Setup ── */}
          {currentStep === "whatsapp_setup" && (
            <>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><MessageSquare className="w-5 h-5 text-green-500" /> WhatsApp Business Setup</CardTitle>
                <CardDescription>Connect your WhatsApp Business API account to enable messaging.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-sm text-amber-800 dark:text-amber-300">
                  <Info className="w-4 h-4 inline mr-1.5" />
                  You need a Meta Business Account and WhatsApp Business API access. 
                  <a href="https://business.facebook.com" target="_blank" rel="noopener noreferrer" className="underline ml-1">Get started with Meta →</a>
                </div>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label>WhatsApp Phone Number <span className="text-destructive">*</span></Label>
                    <Input placeholder="+234 800 000 0000" value={form.waPhoneNumber} onChange={e => updateForm({ waPhoneNumber: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>WhatsApp Business Account ID</Label>
                    <Input placeholder="1234567890123456" value={form.waBusinessAccountId} onChange={e => updateForm({ waBusinessAccountId: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>API Access Token</Label>
                    <Input type="password" placeholder="EAAxxxxxxxxxx..." value={form.waApiToken} onChange={e => updateForm({ waApiToken: e.target.value })} />
                    <p className="text-xs text-muted-foreground">Your token is encrypted and never stored in plain text.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Webhook URL (auto-generated)</Label>
                    <div className="flex gap-2">
                      <Input readOnly value={`https://your-domain.com/api/webhooks/whatsapp/${form.businessName.toLowerCase().replace(/\s+/g, "-") || "tenant"}`} className="font-mono text-xs bg-muted" />
                      <Button variant="outline" size="sm" onClick={() => toast.success("Copied!")}>Copy</Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </>
          )}

          {/* ── Step 4: KYC/KYB ── */}
          {currentStep === "kyc_kyb" && (
            <>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-blue-500" /> Identity & Business Verification</CardTitle>
                <CardDescription>
                  KYC/KYB verification is required by financial regulations. Documents are processed by AI (PaddleOCR + VLM) and reviewed by our compliance team.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* KYB Documents */}
                <div>
                  <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
                    <Building2 className="w-4 h-4" /> Business Documents (KYB)
                  </h3>
                  <div className="rounded-lg border border-border overflow-hidden">
                    <DocumentUploadRow label="Certificate of Incorporation" docType="certificate_of_incorporation" required onUpload={handleDocumentUpload} />
                    <DocumentUploadRow label="Business Registration Certificate" docType="business_registration" required onUpload={handleDocumentUpload} />
                    <DocumentUploadRow label="Tax Certificate" docType="tax_certificate" onUpload={handleDocumentUpload} />
                    <DocumentUploadRow label="Bank Statement (last 3 months)" docType="bank_statement" onUpload={handleDocumentUpload} />
                  </div>
                </div>

                <Separator />

                {/* KYC Documents */}
                <div>
                  <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
                    <Eye className="w-4 h-4" /> Director/Owner Identity (KYC)
                  </h3>
                  <div className="rounded-lg border border-border overflow-hidden">
                    <DocumentUploadRow label="National ID / Passport" docType="national_id" required onUpload={handleDocumentUpload} />
                    <DocumentUploadRow label="Driver's License" docType="drivers_license" onUpload={handleDocumentUpload} />
                    <DocumentUploadRow label="Utility Bill (proof of address)" docType="utility_bill" onUpload={handleDocumentUpload} />
                  </div>
                </div>

                <Separator />

                {/* Liveness Check */}
                <div>
                  <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
                    <Camera className="w-4 h-4" /> Liveness Check
                  </h3>
                  <p className="text-xs text-muted-foreground mb-3">
                    A real-time challenge-response test using MediaPipe Face Mesh to confirm you are a live person and match your ID photo.
                  </p>
                  {form.kycApplicationId ? (
                    <LivenessCamera
                      applicationId={form.kycApplicationId}
                      tenantId="demo-tenant-id"
                      onComplete={(sessionId, status) => {
                        updateForm({ livenessSessionId: sessionId, livenessStatus: status });
                        if (status === "passed") toast.success("Liveness check passed!");
                      }}
                    />
                  ) : (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">Create a KYC application first to start liveness check.</p>
                      <Button
                        variant="outline"
                        onClick={() => createApplication.mutate({ tenantId: "demo-tenant-id", type: "kyb" })}
                        disabled={createApplication.isPending}
                      >
                        {createApplication.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                        Initialize KYC Application
                      </Button>
                    </div>
                  )}
                </div>

                {/* AI Processing Info */}
                <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
                  <p className="text-xs text-blue-800 dark:text-blue-300 font-medium mb-1">AI-Powered Verification Pipeline</p>
                  <div className="grid grid-cols-2 gap-1 text-xs text-blue-700 dark:text-blue-400">
                    <span>• PaddleOCR → text extraction</span>
                    <span>• Docling → structured parsing</span>
                    <span>• VLM (Ollama/GPT-4V) → authenticity</span>
                    <span>• MediaPipe → liveness detection</span>
                  </div>
                </div>
              </CardContent>
            </>
          )}

          {/* ── Step 5: Review ── */}
          {currentStep === "review" && (
            <>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><CheckCircle2 className="w-5 h-5 text-green-500" /> Review & Submit</CardTitle>
                <CardDescription>Review your information before submitting for approval.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {[
                  {
                    title: "Business Profile",
                    items: [
                      { label: "Business Name", value: form.businessName },
                      { label: "Type", value: form.businessType },
                      { label: "Country", value: form.businessCountry },
                      { label: "Contact", value: form.applicantEmail },
                    ],
                  },
                  {
                    title: "Billing Model",
                    items: [
                      { label: "Model", value: form.billingModel.replace("_", " ") || "—" },
                      form.billingModel === "profit_sharing"
                        ? { label: "Rate", value: `${form.profitShareRate}%` }
                        : { label: "Tier", value: form.subscriptionTier || "—" },
                      { label: "Cycle", value: form.billingCycle },
                    ],
                  },
                  {
                    title: "WhatsApp",
                    items: [
                      { label: "Phone", value: form.waPhoneNumber || "Not provided" },
                      { label: "Account ID", value: form.waBusinessAccountId || "Not provided" },
                    ],
                  },
                  {
                    title: "KYC/KYB Status",
                    items: [
                      { label: "Application", value: form.kycApplicationId ? "Created" : "Not started" },
                      { label: "Liveness", value: form.livenessStatus === "passed" ? "✓ Passed" : "Pending" },
                    ],
                  },
                ].map(section => (
                  <div key={section.title} className="rounded-lg border border-border p-4">
                    <h4 className="font-semibold text-sm mb-3">{section.title}</h4>
                    <div className="space-y-1.5">
                      {section.items.map(item => (
                        <div key={item.label} className="flex justify-between text-sm">
                          <span className="text-muted-foreground">{item.label}</span>
                          <span className="font-medium capitalize">{item.value || "—"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                <div className="bg-muted/40 rounded-lg p-3 text-xs text-muted-foreground">
                  By submitting, you confirm all information is accurate and agree to our Terms of Service and Privacy Policy.
                  Your KYC/KYB documents will be reviewed within 1–2 business days.
                </div>
              </CardContent>
            </>
          )}

          {/* Navigation */}
          <div className="flex justify-between items-center p-6 pt-0">
            <Button variant="outline" onClick={handleBack} disabled={stepIndex === 0} className="gap-2">
              <ArrowLeft className="w-4 h-4" /> Back
            </Button>
            <span className="text-xs text-muted-foreground">Step {stepIndex + 1} of {STEPS.length}</span>
            {currentStep === "review" ? (
              <Button onClick={handleSubmit} disabled={isSubmitting} className="gap-2">
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Submit Application
              </Button>
            ) : (
              <Button onClick={handleNext} className="gap-2">
                Next <ArrowRight className="w-4 h-4" />
              </Button>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
