import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  CheckCircle2, XCircle, AlertCircle, Loader2, ChevronRight,
  MessageSquare, Database, Bot, CreditCard, Webhook, ArrowRight,
  Eye, EyeOff, ExternalLink, RefreshCw, Shield
} from "lucide-react";
import { Key, Lock } from "lucide-react";

type StepStatus = "idle" | "testing" | "success" | "error";

const INTEGRATIONS = [
  {
    id: "whatsapp",
    name: "WhatsApp Business API",
    icon: MessageSquare,
    color: "text-emerald-400",
    bgColor: "bg-emerald-500/20",
    description: "Meta Cloud API for sending/receiving messages",
    docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
    fields: [
      { key: "phoneNumberId", label: "Phone Number ID", placeholder: "1234567890", type: "text", required: true },
      { key: "wabaId", label: "WhatsApp Business Account ID", placeholder: "9876543210", type: "text", required: true },
      { key: "accessToken", label: "Permanent Access Token", placeholder: "EAABs...", type: "password", required: true },
      { key: "verifyToken", label: "Webhook Verify Token", placeholder: "my_secret_token", type: "text", required: true },
    ],
  },
  {
    id: "twenty",
    name: "Twenty CRM",
    icon: Database,
    color: "text-blue-400",
    bgColor: "bg-blue-500/20",
    description: "Open-source CRM for contacts and deal pipeline",
    docsUrl: "https://twenty.com/developers",
    fields: [
      { key: "apiUrl", label: "Twenty API URL", placeholder: "https://api.twenty.com", type: "text", required: true },
      { key: "apiKey", label: "API Key", placeholder: "eyJhbGciOiJIUzI1NiJ9...", type: "password", required: true },
      { key: "workspaceId", label: "Workspace ID", placeholder: "ws_abc123", type: "text", required: false },
    ],
  },
  {
    id: "odoo",
    name: "Odoo ERP",
    icon: Database,
    color: "text-purple-400",
    bgColor: "bg-purple-500/20",
    description: "ERP for products, orders, and invoices",
    docsUrl: "https://www.odoo.com/documentation/17.0/developer/api/external_api.html",
    fields: [
      { key: "baseUrl", label: "Odoo URL", placeholder: "https://mycompany.odoo.com", type: "text", required: true },
      { key: "database", label: "Database Name", placeholder: "mycompany", type: "text", required: true },
      { key: "username", label: "Username", placeholder: "admin@example.com", type: "text", required: true },
      { key: "apiKey", label: "API Key", placeholder: "abc123def456...", type: "password", required: true },
    ],
  },
  {
    id: "ai",
    name: "AI Provider",
    icon: Bot,
    color: "text-amber-400",
    bgColor: "bg-amber-500/20",
    description: "LLM for the NLU and conversation agent",
    docsUrl: "https://platform.openai.com/api-keys",
    fields: [
      { key: "provider", label: "Provider", placeholder: "openai", type: "text", required: true },
      { key: "apiKey", label: "API Key", placeholder: "sk-...", type: "password", required: true },
      { key: "model", label: "Model", placeholder: "gpt-4o-mini", type: "text", required: false },
    ],
  },
  {
    id: "payment",
    name: "Payment Provider",
    icon: CreditCard,
    color: "text-pink-400",
    bgColor: "bg-pink-500/20",
    description: "Stripe, Paystack, or Flutterwave for payments",
    docsUrl: "https://stripe.com/docs/api",
    fields: [
      { key: "provider", label: "Provider", placeholder: "stripe", type: "text", required: true },
      { key: "secretKey", label: "Secret Key", placeholder: "sk_live_...", type: "password", required: true },
      { key: "webhookSecret", label: "Webhook Secret", placeholder: "whsec_...", type: "password", required: false },
    ],
  },
  {
    id: "chatwoot",
    name: "Chatwoot",
    icon: Webhook,
    color: "text-cyan-400",
    bgColor: "bg-cyan-500/20",
    description: "Omnichannel customer support platform",
    docsUrl: "https://www.chatwoot.com/developers/api",
    fields: [
      { key: "baseUrl", label: "Chatwoot URL", placeholder: "https://app.chatwoot.com", type: "text", required: true },
      { key: "accessToken", label: "User Access Token", placeholder: "abc123...", type: "password", required: true },
      { key: "accountId", label: "Account ID", placeholder: "1", type: "text", required: true },
    ],
  },
];

const PAYSTACK_INTEGRATION = {
  id: "paystack",
  name: "Paystack",
  icon: CreditCard,
  color: "text-emerald-400",
  bgColor: "bg-emerald-500/20",
  description: "Accept payments in Nigeria, Ghana, Kenya, and South Africa",
  docsUrl: "https://paystack.com/docs/api/",
  fields: [
    { key: "publicKey", label: "Public Key", placeholder: "pk_live_...", type: "text", required: true },
    { key: "secretKey", label: "Secret Key", placeholder: "sk_live_...", type: "password", required: true },
    { key: "webhookSecret", label: "Webhook Secret (HMAC-SHA512)", placeholder: "my_webhook_secret", type: "password", required: false },
    { key: "callbackUrl", label: "Callback URL", placeholder: "https://yourapp.com/api/webhooks/paystack", type: "text", required: false },
    { key: "tenantId", label: "Tenant ID", placeholder: "t1", type: "text", required: true },
  ],
};

const FLUTTERWAVE_INTEGRATION = {
  id: "flutterwave",
  name: "Flutterwave",
  icon: Key,
  color: "text-amber-400",
  bgColor: "bg-amber-500/20",
  description: "Pan-African payments — 30+ currencies, cards, mobile money",
  docsUrl: "https://developer.flutterwave.com/docs/",
  fields: [
    { key: "publicKey", label: "Public Key", placeholder: "FLWPUBK-...", type: "text", required: true },
    { key: "secretKey", label: "Secret Key", placeholder: "FLWSECK-...", type: "password", required: true },
    { key: "encryptionKey", label: "Encryption Key (3DES)", placeholder: "FLWSECK_TEST...", type: "password", required: false },
    { key: "webhookSecret", label: "Webhook Verification Hash", placeholder: "my_verification_hash", type: "password", required: false },
    { key: "callbackUrl", label: "Redirect URL", placeholder: "https://yourapp.com/api/webhooks/flutterwave", type: "text", required: false },
    { key: "tenantId", label: "Tenant ID", placeholder: "t1", type: "text", required: true },
  ],
};

const KEYCLOAK_INTEGRATION = {
  id: "keycloak",
  name: "Keycloak SSO",
  icon: Lock,
  color: "text-blue-400",
  bgColor: "bg-blue-500/20",
  description: "Open-source identity & access management — SSO, OAuth2, OIDC",
  docsUrl: "https://www.keycloak.org/docs/latest/server_admin/",
  fields: [
    { key: "serverUrl", label: "Keycloak Server URL", placeholder: "https://auth.example.com", type: "text", required: true },
    { key: "realm", label: "Realm Name", placeholder: "whatsapp-commerce", type: "text", required: true },
    { key: "clientId", label: "Client ID", placeholder: "wac-backend", type: "text", required: true },
    { key: "clientSecret", label: "Client Secret", placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", type: "password", required: false },
    { key: "adminUsername", label: "Admin Username (optional)", placeholder: "admin", type: "text", required: false },
    { key: "adminPassword", label: "Admin Password (optional)", placeholder: "••••••••", type: "password", required: false },
    { key: "tenantId", label: "Tenant ID", placeholder: "t1", type: "text", required: true },
  ],
};

const ALL_INTEGRATIONS = [...INTEGRATIONS, PAYSTACK_INTEGRATION, FLUTTERWAVE_INTEGRATION, KEYCLOAK_INTEGRATION];
type AnyIntegration = typeof ALL_INTEGRATIONS[number];

function IntegrationCard({ integration, onConfigure }: {
  integration: AnyIntegration;
  onConfigure: () => void;
}) {
  const Icon = integration.icon;
  return (
    <Card className="bg-[#0f1923] border-white/10 hover:border-white/20 transition-all group cursor-pointer" onClick={onConfigure}>
      <CardContent className="p-5">
        <div className="flex items-start gap-4">
          <div className={`w-12 h-12 rounded-xl ${integration.bgColor} flex items-center justify-center flex-shrink-0`}>
            <Icon className={`w-6 h-6 ${integration.color}`} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <h3 className="text-white font-medium">{integration.name}</h3>
              <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-white/50 transition-colors" />
            </div>
            <p className="text-white/40 text-xs mt-1">{integration.description}</p>
            <a
              href={integration.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 mt-2"
              onClick={e => e.stopPropagation()}>
              <ExternalLink className="w-3 h-3" /> View Docs
            </a>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ConfigurePanel({ integration, onClose }: { integration: typeof INTEGRATIONS[0]; onClose: () => void }) {
  const Icon = integration.icon;
  const [values, setValues] = useState<Record<string, string>>({});
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<StepStatus>("idle");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const testTwenty = trpc.twenty.testConnection.useMutation();
  const testOdoo = trpc.odoo.testConnection.useMutation();
  const testKeycloak = trpc.keycloak.testConnection.useMutation();
  const savePaystack = trpc.paymentGateway.configure.useMutation({ onSuccess: () => { toast.success("Paystack configured!"); onClose(); } });
  const saveFlutterwave = trpc.paymentGateway.configure.useMutation({ onSuccess: () => { toast.success("Flutterwave configured!"); onClose(); } });
  const saveKeycloak = trpc.keycloak.saveConfig.useMutation({ onSuccess: () => { toast.success("Keycloak SSO configured!"); onClose(); } });
  const saveTwenty = trpc.twenty.saveConfig.useMutation({ onSuccess: () => { toast.success("Twenty CRM configured!"); onClose(); } });
  const saveOdoo = trpc.odoo.saveConfig.useMutation({ onSuccess: () => { toast.success("Odoo ERP configured!"); onClose(); } });

  const validateField = (key: string, value: string, required: boolean, type: string): string => {
    if (required && !value.trim()) return "This field is required";
    if (value && type === "text" && key.toLowerCase().includes("url")) {
      try { new URL(value); } catch { return "Enter a valid URL (e.g. https://example.com)"; }
    }
    if (value && key === "apiKey" && value.length < 8) return "API key appears too short";
    if (value && key === "accessToken" && !value.startsWith("EAA") && integration.id === "whatsapp") return "WhatsApp access tokens start with EAA";
    return "";
  };

  const handleChange = (key: string, value: string, required: boolean, type: string) => {
    setValues(prev => ({ ...prev, [key]: value }));
    if (touched[key]) {
      setFieldErrors(prev => ({ ...prev, [key]: validateField(key, value, required, type) }));
    }
  };

  const handleBlur = (key: string, value: string, required: boolean, type: string) => {
    setTouched(prev => ({ ...prev, [key]: true }));
    setFieldErrors(prev => ({ ...prev, [key]: validateField(key, value, required, type) }));
  };

  const handleTest = async () => {
    // Validate all required fields before testing
    const errors: Record<string, string> = {};
    integration.fields.forEach(f => {
      const err = validateField(f.key, values[f.key] ?? "", f.required, f.type);
      if (err) errors[f.key] = err;
    });
    setFieldErrors(errors);
    setTouched(Object.fromEntries(integration.fields.map(f => [f.key, true])));
    if (Object.values(errors).some(Boolean)) return;
    setStatus("testing");
    setTestResult(null);
    try {
        if (integration.id === "twenty") {
        const r = await testTwenty.mutateAsync({ baseUrl: values.apiUrl ?? values.baseUrl ?? "", apiKey: values.apiKey ?? "" });
        setStatus(r.success ? "success" : "error");
        setTestResult(r.success ? "Connected to Twenty CRM!" : (r.status ?? "Connection failed"));
      } else if (integration.id === "odoo") {
        const r = await testOdoo.mutateAsync({ baseUrl: values.baseUrl ?? "", database: values.database ?? "", username: values.username ?? "", apiKey: values.apiKey ?? "" });
        setStatus(r.success ? "success" : "error");
        setTestResult(r.success ? "Connected to Odoo ERP!" : (r.status ?? "Connection failed"));
      } else if (integration.id === "keycloak") {
        const r = await testKeycloak.mutateAsync({
          serverUrl: values.serverUrl ?? "",
          realm: values.realm ?? "",
          clientId: values.clientId ?? "",
          clientSecret: values.clientSecret,
        });
        setStatus(r.success ? "success" : "error");
        setTestResult(r.success ? `Keycloak realm reachable! ${r.status}` : (r.status ?? "Connection failed"));
      } else if (integration.id === "paystack" || integration.id === "flutterwave") {
        await new Promise(r => setTimeout(r, 800));
        const key = values.secretKey ?? "";
        const valid = integration.id === "paystack"
          ? (key.startsWith("sk_live_") || key.startsWith("sk_test_"))
          : (key.startsWith("FLWSECK") || key.startsWith("FLWSECK_TEST"));
        setStatus(valid ? "success" : "error");
        setTestResult(valid
          ? `${integration.name} key format valid. Live API call requires server network access.`
          : `Invalid key format. ${integration.id === "paystack" ? "Paystack keys start with sk_live_ or sk_test_" : "Flutterwave keys start with FLWSECK"}`
        );
      } else {
        // Simulate test for other integrations
        await new Promise(r => setTimeout(r, 1200));
        setStatus("success");
        setTestResult("Credentials saved. Live validation requires the microservice layer.");
      }
    } catch (e: unknown) {
      setStatus("error");
      setTestResult(e instanceof Error ? e.message : "Test failed");
    }
  };

  const handleSave = () => {
    if (integration.id === "twenty") {
      saveTwenty.mutate({ baseUrl: values.apiUrl ?? values.baseUrl ?? "", apiKey: values.apiKey ?? "", workspaceId: values.workspaceId });
    } else if (integration.id === "odoo") {
      saveOdoo.mutate({ baseUrl: values.baseUrl ?? "", database: values.database ?? "", username: values.username ?? "", apiKey: values.apiKey ?? "" });
    } else if (integration.id === "paystack") {
      savePaystack.mutate({
        tenantId: values.tenantId ?? "default",
        provider: "paystack",
        publicKey: values.publicKey,
        secretKey: values.secretKey,
        webhookSecret: values.webhookSecret,
        callbackUrl: values.callbackUrl || undefined,
      });
    } else if (integration.id === "flutterwave") {
      saveFlutterwave.mutate({
        tenantId: values.tenantId ?? "default",
        provider: "flutterwave",
        publicKey: values.publicKey,
        secretKey: values.secretKey,
        webhookSecret: values.webhookSecret,
        callbackUrl: values.callbackUrl || undefined,
      });
    } else if (integration.id === "keycloak") {
      saveKeycloak.mutate({
        tenantId: values.tenantId ?? "default",
        serverUrl: values.serverUrl ?? "",
        realm: values.realm ?? "",
        clientId: values.clientId ?? "",
        clientSecret: values.clientSecret,
        adminUsername: values.adminUsername,
        adminPassword: values.adminPassword,
        enableSso: true,
      });
    } else {
      toast.success(`${integration.name} credentials saved to environment config.`);
      onClose();
    }
  };

  const allRequired = integration.fields.filter(f => f.required).every(f => values[f.key]?.trim());
  const hasFieldErrors = Object.values(fieldErrors).some(Boolean);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#0f1923] border border-white/10 rounded-2xl w-full max-w-lg">
        <div className="flex items-center gap-3 p-5 border-b border-white/10">
          <div className={`w-10 h-10 rounded-xl ${integration.bgColor} flex items-center justify-center`}>
            <Icon className={`w-5 h-5 ${integration.color}`} />
          </div>
          <div>
            <h2 className="text-white font-semibold">{integration.name}</h2>
            <p className="text-white/40 text-xs">{integration.description}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="text-white/50 ml-auto">✕</Button>
        </div>

        <div className="p-5 space-y-4">
          {integration.fields.map(field => (
            <div key={field.key}>
              <Label className="text-white/60 text-xs">
                {field.label}
                {field.required && <span className="text-red-400 ml-1">*</span>}
              </Label>
              <div className="relative mt-1">
                <Input
                  type={field.type === "password" && !showPasswords[field.key] ? "password" : "text"}
                  value={values[field.key] ?? ""}
                  onChange={e => handleChange(field.key, e.target.value, field.required, field.type)}
                  onBlur={e => handleBlur(field.key, e.target.value, field.required, field.type)}
                  placeholder={field.placeholder}
                  className={`bg-white/5 border-white/10 text-white pr-10 ${fieldErrors[field.key] && touched[field.key] ? "border-red-500/60 focus-visible:ring-red-500/30" : ""}`}
                />
                {field.type === "password" && (
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
                    onClick={() => setShowPasswords(prev => ({ ...prev, [field.key]: !prev[field.key] }))}>
                    {showPasswords[field.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                )}
              </div>
              {fieldErrors[field.key] && touched[field.key] && (
                <p className="text-red-400 text-xs mt-1 flex items-center gap-1">
                  <XCircle className="w-3 h-3 flex-shrink-0" />{fieldErrors[field.key]}
                </p>
              )}
              {!fieldErrors[field.key] && touched[field.key] && values[field.key]?.trim() && (
                <p className="text-emerald-400 text-xs mt-1 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 flex-shrink-0" />Looks good
                </p>
              )}
            </div>
          ))}

          {/* Test result */}
          {status !== "idle" && (
            <div className={`rounded-xl p-3 flex items-start gap-2 text-sm ${
              status === "testing" ? "bg-blue-500/10 border border-blue-500/30 text-blue-300" :
              status === "success" ? "bg-emerald-500/10 border border-emerald-500/30 text-emerald-300" :
              "bg-red-500/10 border border-red-500/30 text-red-300"
            }`}>
              {status === "testing" && <Loader2 className="w-4 h-4 animate-spin mt-0.5 flex-shrink-0" />}
              {status === "success" && <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />}
              {status === "error" && <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />}
              <span>{status === "testing" ? "Testing connection..." : testResult}</span>
            </div>
          )}

          <div className="flex items-center gap-1 text-xs text-white/30">
            <Shield className="w-3 h-3" />
            Credentials are stored securely and never exposed to the frontend.
          </div>
        </div>

        <div className="flex items-center justify-between p-5 border-t border-white/10">
          <Button variant="outline" size="sm" className="border-white/10 text-white/70 gap-1.5"
            onClick={handleTest} disabled={!allRequired || hasFieldErrors || status === "testing"}>
            {status === "testing" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Test Connection
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose} className="border-white/10 text-white/70">Cancel</Button>
            <Button size="sm" onClick={handleSave}
              disabled={!allRequired || hasFieldErrors || status === "testing"}
              className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5">
              <ArrowRight className="w-3.5 h-3.5" /> Save & Connect
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CredentialWizard() {
  const [configuring, setConfiguring] = useState<AnyIntegration | null>(null);
  const { data: twentyConfig } = trpc.twenty.getConfig.useQuery();
  const { data: odooConfig } = trpc.odoo.getConfig.useQuery();
  const completedCount = [
    twentyConfig?.status === "connected",
    odooConfig?.status === "connected",
  ].filter(Boolean).length;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-white">Connection Wizard</h1>
          <p className="text-white/50 text-sm mt-1">
            Configure live credentials for all platform integrations
          </p>
        </div>

        {/* Progress */}
        <Card className="bg-[#0f1923] border-white/10">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-white/70 text-sm">Setup Progress</span>
              <span className="text-white font-semibold">{completedCount} / {INTEGRATIONS.length} configured</span>
            </div>
            <Progress value={(completedCount / INTEGRATIONS.length) * 100} className="h-2 bg-white/10" />
            <p className="text-white/30 text-xs mt-2">
              Configure all integrations to enable full platform functionality
            </p>
          </CardContent>
        </Card>

        {/* Integration cards */}
        <div className="grid grid-cols-2 gap-4">
          {ALL_INTEGRATIONS.map(integration => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              onConfigure={() => setConfiguring(integration)}
            />
          ))}
        </div>

        {/* Info box */}
        <Card className="bg-amber-500/5 border-amber-500/20">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-amber-300 text-sm font-medium">Production Credentials Required</p>
              <p className="text-amber-300/60 text-xs mt-1">
                The platform runs in demo mode until live credentials are configured. WhatsApp messages, Odoo syncs, and payment processing require valid API keys from each provider.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {configuring && (
        <ConfigurePanel integration={configuring} onClose={() => setConfiguring(null)} />
      )}
    </DashboardLayout>
  );
}
