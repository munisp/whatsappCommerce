import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  CheckCircle2, Circle, ArrowRight, ArrowLeft, Building2, MessageSquare,
  Users, BarChart3, ShoppingBag, Radio, CreditCard, Layers, Rocket, Zap,
  Globe, Phone, Package, ChevronRight, AlertCircle, Loader2,
} from "lucide-react";

// ── Step definitions ──────────────────────────────────────────────────────────
const STEPS = [
  { id: "welcome",          label: "Welcome",       icon: Rocket },
  { id: "business_profile", label: "Business",      icon: Building2 },
  { id: "whatsapp_setup",   label: "WhatsApp",      icon: MessageSquare },
  { id: "crm_setup",        label: "CRM",           icon: Users },
  { id: "erp_setup",        label: "ERP",           icon: BarChart3 },
  { id: "ecommerce_setup",  label: "eCommerce",     icon: ShoppingBag },
  { id: "channels_setup",   label: "Channels",      icon: Radio },
  { id: "payments_setup",   label: "Payments",      icon: CreditCard },
  { id: "billing_model",    label: "Billing",       icon: Layers },
  { id: "review",           label: "Review",        icon: CheckCircle2 },
] as const;

type StepId = typeof STEPS[number]["id"];

// ── Colour helpers ────────────────────────────────────────────────────────────
const STATUS_COLOR: Record<string, string> = {
  active: "bg-emerald-500",
  not_configured: "bg-slate-400",
  pending: "bg-amber-400",
  error: "bg-red-500",
  disabled: "bg-slate-300",
};

// ── Sub-forms ─────────────────────────────────────────────────────────────────
function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-col items-center text-center gap-6 py-8">
      <div className="w-20 h-20 rounded-full bg-emerald-500/10 flex items-center justify-center">
        <Zap className="w-10 h-10 text-emerald-500" />
      </div>
      <div>
        <h2 className="text-2xl font-bold text-foreground">Welcome to WhatsApp Commerce</h2>
        <p className="text-muted-foreground mt-2 max-w-md">
          This wizard will connect your business to WhatsApp, CRM (Twenty), ERP (Odoo), and eCommerce (Medusa) in one unified flow. Each step takes 1–2 minutes.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 w-full max-w-sm text-left">
        {[
          { icon: MessageSquare, label: "WhatsApp Business API" },
          { icon: Users, label: "Twenty CRM" },
          { icon: BarChart3, label: "Odoo ERP" },
          { icon: ShoppingBag, label: "Medusa Commerce" },
          { icon: Radio, label: "USSD & SMS Channels" },
          { icon: CreditCard, label: "Mobile Money & Cards" },
        ].map(({ icon: Icon, label }) => (
          <div key={label} className="flex items-center gap-2 text-sm text-muted-foreground">
            <Icon className="w-4 h-4 text-emerald-500 shrink-0" />
            <span>{label}</span>
          </div>
        ))}
      </div>
      <Button onClick={onNext} className="bg-emerald-600 hover:bg-emerald-700 text-white px-8">
        Get Started <ArrowRight className="ml-2 w-4 h-4" />
      </Button>
    </div>
  );
}

function BusinessProfileStep({ onNext, onBack }: { onNext: (data: Record<string, unknown>) => void; onBack: () => void }) {
  const [form, setForm] = useState({ businessName: "", businessType: "", country: "Nigeria", phone: "", email: "", website: "" });
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));
  const TYPES = ["Food & Beverage", "Fashion & Apparel", "Electronics", "Health & Beauty", "Home & Garden", "Agriculture", "Services", "Other"];
  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-lg">Business Profile</h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label>Business Name *</Label>
          <Input value={form.businessName} onChange={e => set("businessName", e.target.value)} placeholder="Acme Stores Ltd" className="mt-1" />
        </div>
        <div>
          <Label>Business Type *</Label>
          <select value={form.businessType} onChange={e => set("businessType", e.target.value)} className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm">
            <option value="">Select type…</option>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <Label>Country</Label>
          <Input value={form.country} onChange={e => set("country", e.target.value)} className="mt-1" />
        </div>
        <div>
          <Label>Phone</Label>
          <Input value={form.phone} onChange={e => set("phone", e.target.value)} placeholder="+234 800 000 0000" className="mt-1" />
        </div>
        <div>
          <Label>Email</Label>
          <Input value={form.email} onChange={e => set("email", e.target.value)} placeholder="hello@acme.com" className="mt-1" />
        </div>
        <div className="col-span-2">
          <Label>Website (optional)</Label>
          <Input value={form.website} onChange={e => set("website", e.target.value)} placeholder="https://acme.com" className="mt-1" />
        </div>
      </div>
      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={onBack}><ArrowLeft className="mr-1 w-4 h-4" />Back</Button>
        <Button onClick={() => onNext(form)} disabled={!form.businessName || !form.businessType} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          Continue <ArrowRight className="ml-1 w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function WhatsAppSetupStep({ onNext, onBack }: { onNext: (data: Record<string, unknown>) => void; onBack: () => void }) {
  const [form, setForm] = useState({ phoneNumberId: "", businessAccountId: "", accessToken: "", verifyToken: "" });
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));
  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-lg">WhatsApp Business API</h3>
      <p className="text-sm text-muted-foreground">Connect your Meta Business account. Find these values in <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener noreferrer" className="text-emerald-500 underline">Meta Developer Portal</a>.</p>
      <div className="space-y-3">
        <div><Label>Phone Number ID *</Label><Input value={form.phoneNumberId} onChange={e => set("phoneNumberId", e.target.value)} placeholder="123456789012345" className="mt-1 font-mono text-sm" /></div>
        <div><Label>Business Account ID *</Label><Input value={form.businessAccountId} onChange={e => set("businessAccountId", e.target.value)} placeholder="987654321098765" className="mt-1 font-mono text-sm" /></div>
        <div><Label>Permanent Access Token *</Label><Input value={form.accessToken} onChange={e => set("accessToken", e.target.value)} type="password" placeholder="EAAxxxxxxxx…" className="mt-1 font-mono text-sm" /></div>
        <div><Label>Webhook Verify Token (custom string)</Label><Input value={form.verifyToken} onChange={e => set("verifyToken", e.target.value)} placeholder="my_secret_token_123" className="mt-1 font-mono text-sm" /></div>
      </div>
      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={onBack}><ArrowLeft className="mr-1 w-4 h-4" />Back</Button>
        <Button onClick={() => onNext(form)} disabled={!form.phoneNumberId || !form.businessAccountId || !form.accessToken} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          Continue <ArrowRight className="ml-1 w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function CrmSetupStep({ onNext, onBack }: { onNext: (data: Record<string, unknown>) => void; onBack: () => void }) {
  const [form, setForm] = useState({ baseUrl: "", apiKey: "" });
  const [skip, setSkip] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const provision = trpc.provisioning.provisionTwentyCrm.useMutation();
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    const r = await provision.mutateAsync({ baseUrl: form.baseUrl, apiKey: form.apiKey }).catch(e => ({ success: false, error: String(e) }));
    setTesting(false);
    setTestResult({ ok: r.success, msg: r.success ? `Connected (${(r as { latencyMs?: number }).latencyMs ?? 0}ms)` : (r as { error?: string }).error ?? "Connection failed" });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">Twenty CRM</h3>
        <Badge variant="outline" className="text-xs">Open Source</Badge>
      </div>
      <p className="text-sm text-muted-foreground">Connect your <a href="https://twenty.com" target="_blank" rel="noopener noreferrer" className="text-emerald-500 underline">Twenty CRM</a> instance for unified customer relationship management. Self-host or use Twenty Cloud.</p>
      {!skip ? (
        <div className="space-y-3">
          <div><Label>Twenty Base URL *</Label><Input value={form.baseUrl} onChange={e => set("baseUrl", e.target.value)} placeholder="https://crm.yourdomain.com" className="mt-1" /></div>
          <div><Label>API Key *</Label><Input value={form.apiKey} onChange={e => set("apiKey", e.target.value)} type="password" placeholder="eyJhbGci…" className="mt-1 font-mono text-sm" /></div>
          {testResult && (
            <div className={`flex items-center gap-2 text-sm p-2 rounded ${testResult.ok ? "bg-emerald-500/10 text-emerald-600" : "bg-red-500/10 text-red-600"}`}>
              {testResult.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              {testResult.msg}
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleTest} disabled={!form.baseUrl || !form.apiKey || testing}>
              {testing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null} Test Connection
            </Button>
          </div>
        </div>
      ) : (
        <div className="p-3 bg-amber-500/10 rounded text-sm text-amber-700">CRM setup skipped — you can configure it later from the Integrations dashboard.</div>
      )}
      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={onBack}><ArrowLeft className="mr-1 w-4 h-4" />Back</Button>
        <Button variant="ghost" size="sm" onClick={() => { setSkip(!skip); }}>
          {skip ? "Configure CRM" : "Skip for now"}
        </Button>
        <Button onClick={() => onNext(skip ? { skipped: true } : form)} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          Continue <ArrowRight className="ml-1 w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function ErpSetupStep({ onNext, onBack }: { onNext: (data: Record<string, unknown>) => void; onBack: () => void }) {
  const [form, setForm] = useState({ baseUrl: "", database: "", username: "", apiKey: "" });
  const [skip, setSkip] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const provision = trpc.provisioning.provisionOdooErp.useMutation();
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    const r = await provision.mutateAsync(form).catch(e => ({ success: false, error: String(e) }));
    setTesting(false);
    setTestResult({ ok: r.success, msg: r.success ? `Connected (${(r as { latencyMs?: number }).latencyMs ?? 0}ms)` : (r as { error?: string }).error ?? "Connection failed" });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">Odoo ERP</h3>
        <Badge variant="outline" className="text-xs">Open Source</Badge>
      </div>
      <p className="text-sm text-muted-foreground">Connect your <a href="https://odoo.com" target="_blank" rel="noopener noreferrer" className="text-emerald-500 underline">Odoo</a> instance for inventory, accounting, and supply chain management.</p>
      {!skip ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Label>Odoo Base URL *</Label><Input value={form.baseUrl} onChange={e => set("baseUrl", e.target.value)} placeholder="https://erp.yourdomain.com" className="mt-1" /></div>
          <div><Label>Database *</Label><Input value={form.database} onChange={e => set("database", e.target.value)} placeholder="mycompany" className="mt-1" /></div>
          <div><Label>Username *</Label><Input value={form.username} onChange={e => set("username", e.target.value)} placeholder="admin" className="mt-1" /></div>
          <div className="col-span-2"><Label>API Key *</Label><Input value={form.apiKey} onChange={e => set("apiKey", e.target.value)} type="password" placeholder="Odoo API key from Settings → Technical → API Keys" className="mt-1 font-mono text-sm" /></div>
          {testResult && (
            <div className={`col-span-2 flex items-center gap-2 text-sm p-2 rounded ${testResult.ok ? "bg-emerald-500/10 text-emerald-600" : "bg-red-500/10 text-red-600"}`}>
              {testResult.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              {testResult.msg}
            </div>
          )}
          <div className="col-span-2">
            <Button variant="outline" size="sm" onClick={handleTest} disabled={!form.baseUrl || !form.database || !form.username || !form.apiKey || testing}>
              {testing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null} Test Connection
            </Button>
          </div>
        </div>
      ) : (
        <div className="p-3 bg-amber-500/10 rounded text-sm text-amber-700">ERP setup skipped — configure later from the Integrations dashboard.</div>
      )}
      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={onBack}><ArrowLeft className="mr-1 w-4 h-4" />Back</Button>
        <Button variant="ghost" size="sm" onClick={() => setSkip(!skip)}>{skip ? "Configure ERP" : "Skip for now"}</Button>
        <Button onClick={() => onNext(skip ? { skipped: true } : form)} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          Continue <ArrowRight className="ml-1 w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function EcommerceSetupStep({ onNext, onBack }: { onNext: (data: Record<string, unknown>) => void; onBack: () => void }) {
  const [form, setForm] = useState({ baseUrl: "", adminApiKey: "", publishableKey: "" });
  const [skip, setSkip] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const provision = trpc.provisioning.provisionMedusa.useMutation();
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    const r = await provision.mutateAsync(form).catch(e => ({ success: false, error: String(e) }));
    setTesting(false);
    setTestResult({ ok: r.success, msg: r.success ? `Connected (${(r as { latencyMs?: number }).latencyMs ?? 0}ms)` : (r as { error?: string }).error ?? "Connection failed" });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">Medusa Commerce</h3>
        <Badge variant="outline" className="text-xs">Open Source</Badge>
      </div>
      <p className="text-sm text-muted-foreground">Connect your <a href="https://medusajs.com" target="_blank" rel="noopener noreferrer" className="text-emerald-500 underline">Medusa v2</a> instance for product catalog, orders, price lists, promotions, and fulfillment. See <code className="text-xs bg-muted px-1 rounded">medusa-setup.md</code> in the project root for self-hosting instructions.</p>
      {!skip ? (
        <div className="space-y-3">
          <div><Label>Medusa Base URL *</Label><Input value={form.baseUrl} onChange={e => set("baseUrl", e.target.value)} placeholder="https://commerce.yourdomain.com" className="mt-1" /></div>
          <div><Label>Admin API Key *</Label><Input value={form.adminApiKey} onChange={e => set("adminApiKey", e.target.value)} type="password" placeholder="sk_admin_…" className="mt-1 font-mono text-sm" /></div>
          <div><Label>Publishable (Storefront) Key *</Label><Input value={form.publishableKey} onChange={e => set("publishableKey", e.target.value)} placeholder="pk_…" className="mt-1 font-mono text-sm" /></div>
          {testResult && (
            <div className={`flex items-center gap-2 text-sm p-2 rounded ${testResult.ok ? "bg-emerald-500/10 text-emerald-600" : "bg-red-500/10 text-red-600"}`}>
              {testResult.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              {testResult.msg}
            </div>
          )}
          <Button variant="outline" size="sm" onClick={handleTest} disabled={!form.baseUrl || !form.adminApiKey || !form.publishableKey || testing}>
            {testing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null} Test Connection
          </Button>
        </div>
      ) : (
        <div className="p-3 bg-amber-500/10 rounded text-sm text-amber-700">eCommerce setup skipped — the platform uses its native product tables. Configure Medusa later from the Integrations dashboard.</div>
      )}
      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={onBack}><ArrowLeft className="mr-1 w-4 h-4" />Back</Button>
        <Button variant="ghost" size="sm" onClick={() => setSkip(!skip)}>{skip ? "Configure Medusa" : "Skip for now"}</Button>
        <Button onClick={() => onNext(skip ? { skipped: true } : form)} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          Continue <ArrowRight className="ml-1 w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function ChannelsSetupStep({ onNext, onBack }: { onNext: (data: Record<string, unknown>) => void; onBack: () => void }) {
  const [atEnabled, setAtEnabled] = useState(false);
  const [atForm, setAtForm] = useState({ apiKey: "", username: "sandbox", shortcode: "" });
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const setAt = (k: string, v: string) => setAtForm(f => ({ ...f, [k]: v }));

  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-lg">Additional Channels</h3>
      <p className="text-sm text-muted-foreground">Enable additional messaging channels beyond WhatsApp. All channels route through the same NLP engine.</p>

      {/* Africa's Talking */}
      <div className="border rounded-lg p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Phone className="w-4 h-4 text-emerald-500" />
            <span className="font-medium text-sm">Africa's Talking (USSD + SMS)</span>
          </div>
          <button onClick={() => setAtEnabled(!atEnabled)} className={`w-10 h-5 rounded-full transition-colors ${atEnabled ? "bg-emerald-500" : "bg-muted"} relative`}>
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${atEnabled ? "translate-x-5" : "translate-x-0.5"}`} />
          </button>
        </div>
        {atEnabled && (
          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="col-span-2"><Label className="text-xs">API Key</Label><Input value={atForm.apiKey} onChange={e => setAt("apiKey", e.target.value)} placeholder="atsk_…" className="mt-1 text-xs font-mono" /></div>
            <div><Label className="text-xs">Username</Label><Input value={atForm.username} onChange={e => setAt("username", e.target.value)} className="mt-1 text-xs" /></div>
            <div><Label className="text-xs">USSD Shortcode</Label><Input value={atForm.shortcode} onChange={e => setAt("shortcode", e.target.value)} placeholder="*384*123#" className="mt-1 text-xs" /></div>
          </div>
        )}
      </div>

      {/* Telegram */}
      <div className="border rounded-lg p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-blue-500" />
            <span className="font-medium text-sm">Telegram Bot</span>
          </div>
          <button onClick={() => setTelegramEnabled(!telegramEnabled)} className={`w-10 h-5 rounded-full transition-colors ${telegramEnabled ? "bg-emerald-500" : "bg-muted"} relative`}>
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${telegramEnabled ? "translate-x-5" : "translate-x-0.5"}`} />
          </button>
        </div>
        {telegramEnabled && (
          <div className="pt-1">
            <Label className="text-xs">Bot Token (from @BotFather)</Label>
            <Input value={telegramToken} onChange={e => setTelegramToken(e.target.value)} placeholder="1234567890:AAF…" className="mt-1 text-xs font-mono" />
          </div>
        )}
      </div>

      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={onBack}><ArrowLeft className="mr-1 w-4 h-4" />Back</Button>
        <Button onClick={() => onNext({ africasTalking: atEnabled ? atForm : null, telegram: telegramEnabled ? { token: telegramToken } : null })} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          Continue <ArrowRight className="ml-1 w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function PaymentsSetupStep({ onNext, onBack }: { onNext: (data: Record<string, unknown>) => void; onBack: () => void }) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [forms, setForms] = useState<Record<string, Record<string, string>>>({});
  const toggle = (k: string) => setEnabled(e => ({ ...e, [k]: !e[k] }));
  const setField = (provider: string, field: string, val: string) =>
    setForms(f => ({ ...f, [provider]: { ...(f[provider] ?? {}), [field]: val } }));

  const PROVIDERS = [
    { id: "paystack", label: "Paystack", desc: "Nigeria, Ghana, Kenya, South Africa", fields: [{ key: "secretKey", label: "Secret Key", ph: "sk_live_…" }] },
    { id: "stripe", label: "Stripe", desc: "Global card payments", fields: [{ key: "secretKey", label: "Secret Key", ph: "sk_live_…" }, { key: "publishableKey", label: "Publishable Key", ph: "pk_live_…" }] },
    { id: "mtn_momo", label: "MTN MoMo", desc: "West & Central Africa", fields: [{ key: "subscriptionKey", label: "Subscription Key", ph: "…" }, { key: "apiUserId", label: "API User ID", ph: "UUID" }, { key: "apiKey", label: "API Key", ph: "…" }] },
    { id: "mpesa", label: "M-Pesa (Safaricom)", desc: "Kenya, Tanzania, Uganda", fields: [{ key: "consumerKey", label: "Consumer Key", ph: "…" }, { key: "consumerSecret", label: "Consumer Secret", ph: "…" }, { key: "shortcode", label: "Shortcode", ph: "174379" }, { key: "passkey", label: "Passkey", ph: "…" }] },
  ];

  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-lg">Payment Providers</h3>
      <p className="text-sm text-muted-foreground">Enable one or more payment rails. You can add more later from the Mobile Money portal.</p>
      {PROVIDERS.map(p => (
        <div key={p.id} className="border rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <span className="font-medium text-sm">{p.label}</span>
              <span className="text-xs text-muted-foreground ml-2">{p.desc}</span>
            </div>
            <button onClick={() => toggle(p.id)} className={`w-10 h-5 rounded-full transition-colors ${enabled[p.id] ? "bg-emerald-500" : "bg-muted"} relative`}>
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${enabled[p.id] ? "translate-x-5" : "translate-x-0.5"}`} />
            </button>
          </div>
          {enabled[p.id] && (
            <div className="grid grid-cols-2 gap-2 pt-1">
              {p.fields.map(f => (
                <div key={f.key} className={p.fields.length === 1 ? "col-span-2" : ""}>
                  <Label className="text-xs">{f.label}</Label>
                  <Input value={forms[p.id]?.[f.key] ?? ""} onChange={e => setField(p.id, f.key, e.target.value)} placeholder={f.ph} className="mt-1 text-xs font-mono" type="password" />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={onBack}><ArrowLeft className="mr-1 w-4 h-4" />Back</Button>
        <Button onClick={() => onNext({ providers: Object.entries(enabled).filter(([, v]) => v).map(([k]) => ({ id: k, config: forms[k] ?? {} })) })} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          Continue <ArrowRight className="ml-1 w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function BillingModelStep({ onNext, onBack }: { onNext: (data: Record<string, unknown>) => void; onBack: () => void }) {
  const [selected, setSelected] = useState<"profit_sharing" | "subscription" | "hybrid">("profit_sharing");
  const PLANS = [
    { id: "profit_sharing", label: "Profit Sharing", tagline: "Pay as you grow", desc: "3.5% of GMV. Zero upfront — pay only when you earn.", badge: "Most Popular" },
    { id: "subscription", label: "Subscription", tagline: "Predictable monthly cost", desc: "From $49/month. Full access regardless of volume.", badge: "Best for Scale" },
    { id: "hybrid", label: "Hybrid", tagline: "Best of both worlds", desc: "$29/month base + 1.5% GMV. Lower rate, small fixed fee.", badge: "Recommended" },
  ] as const;
  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-lg">Billing Model</h3>
      <p className="text-sm text-muted-foreground">Choose how you pay for the platform. You can change this at any time.</p>
      <div className="space-y-2">
        {PLANS.map(p => (
          <div key={p.id} onClick={() => setSelected(p.id)} className={`border rounded-lg p-3 cursor-pointer transition-colors ${selected === p.id ? "border-emerald-500 bg-emerald-500/5" : "hover:border-muted-foreground/30"}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {selected === p.id ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : <Circle className="w-4 h-4 text-muted-foreground" />}
                <span className="font-medium text-sm">{p.label}</span>
                <span className="text-xs text-muted-foreground">{p.tagline}</span>
              </div>
              <Badge variant="secondary" className="text-xs">{p.badge}</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1 ml-6">{p.desc}</p>
          </div>
        ))}
      </div>
      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={onBack}><ArrowLeft className="mr-1 w-4 h-4" />Back</Button>
        <Button onClick={() => onNext({ plan: selected })} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          Continue <ArrowRight className="ml-1 w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function ReviewStep({ session, onFinish, onBack }: { session: Record<string, unknown>; onFinish: () => void; onBack: () => void }) {
  const bp = (session.businessProfile ?? {}) as Record<string, string>;
  const crm = (session.crmConfig ?? {}) as Record<string, unknown>;
  const erp = (session.erpConfig ?? {}) as Record<string, unknown>;
  const ec = (session.ecommerceConfig ?? {}) as Record<string, unknown>;
  const billing = (session.billingConfig ?? {}) as Record<string, string>;

  const items = [
    { label: "Business", value: bp.businessName ?? "—", icon: Building2 },
    { label: "CRM (Twenty)", value: crm.skipped ? "Skipped" : crm.baseUrl ? "Configured" : "—", icon: Users },
    { label: "ERP (Odoo)", value: erp.skipped ? "Skipped" : erp.baseUrl ? "Configured" : "—", icon: BarChart3 },
    { label: "eCommerce (Medusa)", value: ec.skipped ? "Skipped" : ec.baseUrl ? "Configured" : "—", icon: ShoppingBag },
    { label: "Billing", value: billing.plan ? billing.plan.replace(/_/g, " ") : "—", icon: Layers },
  ];

  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-lg">Review & Launch</h3>
      <p className="text-sm text-muted-foreground">Your configuration summary. Click Launch to activate your platform.</p>
      <div className="space-y-2">
        {items.map(({ label, value, icon: Icon }) => (
          <div key={label} className="flex items-center justify-between py-2 border-b last:border-0">
            <div className="flex items-center gap-2 text-sm">
              <Icon className="w-4 h-4 text-muted-foreground" />
              <span className="text-muted-foreground">{label}</span>
            </div>
            <span className={`text-sm font-medium ${value === "Skipped" ? "text-amber-500" : value === "—" ? "text-muted-foreground" : "text-foreground"}`}>{value}</span>
          </div>
        ))}
      </div>
      <div className="p-3 bg-emerald-500/10 rounded text-sm text-emerald-700 flex items-start gap-2">
        <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
        <span>Your platform is ready. You can update any integration at any time from the <strong>Integration Health</strong> dashboard.</span>
      </div>
      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={onBack}><ArrowLeft className="mr-1 w-4 h-4" />Back</Button>
        <Button onClick={onFinish} className="bg-emerald-600 hover:bg-emerald-700 text-white px-6">
          <Rocket className="mr-2 w-4 h-4" /> Launch Platform
        </Button>
      </div>
    </div>
  );
}

// ── Main wizard ───────────────────────────────────────────────────────────────
export default function UnifiedOnboarding() {
  const [currentStepIdx, setCurrentStepIdx] = useState(0);
  const [sessionData, setSessionData] = useState<Record<string, unknown>>({});
  const [completed, setCompleted] = useState(false);

  const initSession = trpc.provisioning.initSession.useMutation();
  const saveStep = trpc.provisioning.saveStep.useMutation();
  const { data: existingSession } = trpc.provisioning.getSession.useQuery();

  const progress = Math.round((currentStepIdx / (STEPS.length - 1)) * 100);
  const currentStep = STEPS[currentStepIdx];

  const handleNext = async (data?: Record<string, unknown>) => {
    if (data) {
      setSessionData(prev => ({ ...prev, [currentStep.id]: data }));
      await saveStep.mutateAsync({ step: currentStep.id as Parameters<typeof saveStep.mutateAsync>[0]["step"], data: data ?? {} }).catch(() => null);
    }
    if (currentStepIdx < STEPS.length - 1) setCurrentStepIdx(i => i + 1);
  };

  const handleBack = () => { if (currentStepIdx > 0) setCurrentStepIdx(i => i - 1); };

  const handleFinish = async () => {
    await saveStep.mutateAsync({ step: "review", data: sessionData }).catch(() => null);
    setCompleted(true);
    toast.success("Platform launched!", { description: "Your WhatsApp Commerce platform is now active." });
  };

  if (completed) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="w-20 h-20 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
          </div>
          <h2 className="text-2xl font-bold">Platform Active!</h2>
          <p className="text-muted-foreground">Your WhatsApp Commerce platform is fully configured. Head to the dashboard to start managing your business.</p>
          <div className="grid grid-cols-2 gap-2">
            <a href="/dashboard" className="flex items-center justify-center gap-2 p-3 border rounded-lg hover:bg-muted text-sm font-medium">
              <BarChart3 className="w-4 h-4" /> Dashboard
            </a>
            <a href="/integration-health" className="flex items-center justify-center gap-2 p-3 border rounded-lg hover:bg-muted text-sm font-medium">
              <Layers className="w-4 h-4" /> Integrations
            </a>
            <a href="/nlp-simulator" className="flex items-center justify-center gap-2 p-3 border rounded-lg hover:bg-muted text-sm font-medium">
              <MessageSquare className="w-4 h-4" /> NLP Simulator
            </a>
            <a href="/b2b-portal" className="flex items-center justify-center gap-2 p-3 border rounded-lg hover:bg-muted text-sm font-medium">
              <Package className="w-4 h-4" /> B2B Portal
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-emerald-500" />
            <span className="font-semibold text-sm">Platform Setup Wizard</span>
          </div>
          <span className="text-xs text-muted-foreground">Step {currentStepIdx + 1} of {STEPS.length}</span>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-6 py-8 space-y-6">
        {/* Progress bar */}
        <Progress value={progress} className="h-1.5" />

        {/* Step indicator */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1">
          {STEPS.map((step, idx) => {
            const Icon = step.icon;
            const isActive = idx === currentStepIdx;
            const isDone = idx < currentStepIdx;
            return (
              <div key={step.id} className="flex items-center gap-1 shrink-0">
                <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs transition-colors ${isActive ? "bg-emerald-500 text-white" : isDone ? "bg-emerald-500/20 text-emerald-600" : "text-muted-foreground"}`}>
                  {isDone ? <CheckCircle2 className="w-3 h-3" /> : <Icon className="w-3 h-3" />}
                  <span className="hidden sm:inline">{step.label}</span>
                </div>
                {idx < STEPS.length - 1 && <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />}
              </div>
            );
          })}
        </div>

        {/* Step content */}
        <div className="bg-card border rounded-xl p-6">
          {currentStep.id === "welcome" && <WelcomeStep onNext={() => handleNext()} />}
          {currentStep.id === "business_profile" && <BusinessProfileStep onNext={handleNext} onBack={handleBack} />}
          {currentStep.id === "whatsapp_setup" && <WhatsAppSetupStep onNext={handleNext} onBack={handleBack} />}
          {currentStep.id === "crm_setup" && <CrmSetupStep onNext={handleNext} onBack={handleBack} />}
          {currentStep.id === "erp_setup" && <ErpSetupStep onNext={handleNext} onBack={handleBack} />}
          {currentStep.id === "ecommerce_setup" && <EcommerceSetupStep onNext={handleNext} onBack={handleBack} />}
          {currentStep.id === "channels_setup" && <ChannelsSetupStep onNext={handleNext} onBack={handleBack} />}
          {currentStep.id === "payments_setup" && <PaymentsSetupStep onNext={handleNext} onBack={handleBack} />}
          {currentStep.id === "billing_model" && <BillingModelStep onNext={handleNext} onBack={handleBack} />}
          {currentStep.id === "review" && <ReviewStep session={sessionData} onFinish={handleFinish} onBack={handleBack} />}
        </div>
      </div>
    </div>
  );
}
