/**
 * ProviderSettings — wave-11 tenant-facing payment provider management.
 *
 * One card per catalog adapter (paymentGateway.listProviderAdapters):
 * enabled toggle, priority number (fallback-chain order), masked secret
 * fields (replace-on-write; the masked sentinel means "keep stored value"),
 * settlement instructions for manual/custom, and a test-connection button
 * with a result chip. Below the cards: the resolved fallback-chain preview
 * ("1. Paystack (primary) → 2. Flutterwave (fallback)") and an "Add custom
 * gateway" entry point with a validated JSON config editor.
 */
import { useEffect, useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useActiveTenant } from "@/contexts/TenantContext";
import { CheckCircle2, Loader2, Plug, Plus, XCircle } from "lucide-react";
import {
  MASKED_SECRET,
  fallbackChainPreview,
  isMaskedSentinel,
  validateCustomConfig,
  type TenantProviderView,
} from "@/lib/providerChain";

const SECRET_PROVIDERS = new Set(["paystack", "flutterwave", "stripe", "monnify"]);

interface ProviderForm {
  enabled: boolean;
  priority: number;
  publicKey: string;
  secretKey: string;
  webhookSecret: string;
  callbackUrl: string;
  instructions: string;
}

const EMPTY_FORM: ProviderForm = {
  enabled: false,
  priority: 0,
  publicKey: "",
  secretKey: "",
  webhookSecret: "",
  callbackUrl: "",
  instructions: "",
};

function ProviderCard({
  tenantId,
  adapter,
  configured,
}: {
  tenantId: string;
  adapter: { id: string; displayName: string };
  configured?: TenantProviderView;
}) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (configured) {
      setForm({
        enabled: configured.enabled,
        priority: configured.priority,
        publicKey: "",
        secretKey: configured.secretKey ? MASKED_SECRET : "",
        webhookSecret: configured.webhookSecret ? MASKED_SECRET : "",
        callbackUrl: "",
        instructions: configured.instructions ?? "",
      });
    }
  }, [configured]);

  const invalidate = () => utils.paymentGateway.getTenantProviders.invalidate({ tenantId });

  const configure = trpc.paymentGateway.configureProvider.useMutation({
    onSuccess: () => {
      toast.success(`${adapter.displayName} saved`);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const toggle = trpc.paymentGateway.toggleProvider.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const setPriority = trpc.paymentGateway.setProviderPriority.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const test = trpc.paymentGateway.testProvider.useMutation({
    onSuccess: (r) => setTestResult(r),
    onError: (e) => setTestResult({ ok: false, message: e.message }),
  });

  const needsSecret = SECRET_PROVIDERS.has(adapter.id);
  const needsInstructions = adapter.id === "manual" || adapter.id === "custom";

  const save = () => {
    configure.mutate({
      tenantId,
      provider: adapter.id,
      publicKey: form.publicKey || undefined,
      secretKey: form.secretKey && !isMaskedSentinel(form.secretKey) ? form.secretKey : undefined,
      webhookSecret:
        form.webhookSecret && !isMaskedSentinel(form.webhookSecret) ? form.webhookSecret : undefined,
      callbackUrl: form.callbackUrl || undefined,
      priority: form.priority,
      enabled: form.enabled,
      instructions: form.instructions || undefined,
    });
  };

  return (
    <Card className="border-muted">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Plug className="h-4 w-4 text-muted-foreground" />
              {adapter.displayName}
            </CardTitle>
            <CardDescription>
              {needsSecret
                ? "Hosted checkout — buyers are redirected to a secure payment page."
                : "Offline settlement — buyers receive payment instructions and reconcile via receipt."}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {configured && (
              <Badge variant="outline" className="text-muted-foreground">
                priority {configured.priority}
              </Badge>
            )}
            <Switch
              checked={form.enabled}
              onCheckedChange={(v) => {
                setForm((f) => ({ ...f, enabled: v }));
                if (configured) toggle.mutate({ tenantId, provider: adapter.id, enabled: v });
              }}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Priority (higher = tried first)</Label>
            <Input
              type="number"
              min={1}
              value={form.priority}
              onChange={(e) => setForm((f) => ({ ...f, priority: Number(e.target.value) || 0 }))}
              onBlur={() => {
                if (configured && form.priority !== configured.priority) {
                  setPriority.mutate({ tenantId, provider: adapter.id, priority: form.priority });
                }
              }}
            />
          </div>
          {needsSecret && (
            <div className="space-y-1.5">
              <Label>Public key</Label>
              <Input
                value={form.publicKey}
                placeholder="pk_live_…"
                onChange={(e) => setForm((f) => ({ ...f, publicKey: e.target.value }))}
              />
            </div>
          )}
        </div>
        {needsSecret && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Secret key</Label>
              <Input
                type="password"
                value={form.secretKey}
                placeholder="sk_live_…"
                onChange={(e) => setForm((f) => ({ ...f, secretKey: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Webhook secret</Label>
              <Input
                type="password"
                value={form.webhookSecret}
                placeholder="whsec_…"
                onChange={(e) => setForm((f) => ({ ...f, webhookSecret: e.target.value }))}
              />
            </div>
          </div>
        )}
        {needsInstructions && (
          <div className="space-y-1.5">
            <Label>Settlement instructions (sent to buyers)</Label>
            <Textarea
              rows={3}
              value={form.instructions}
              placeholder="Bank: Example Bank · Acct: 0123456789 · Quote your payment reference…"
              onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
            />
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={configure.isPending}>
            {configure.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={test.isPending || (!configured && !form.enabled)}
            onClick={() => {
              setTestResult(null);
              test.mutate({ tenantId, provider: adapter.id });
            }}
          >
            {test.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Test connection
          </Button>
          {testResult && (
            <Badge
              variant="outline"
              className={
                testResult.ok
                  ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                  : "bg-red-500/15 text-red-400 border-red-500/30"
              }
            >
              {testResult.ok ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <XCircle className="mr-1 h-3 w-3" />}
              {testResult.message}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function CustomGatewayCard({ tenantId, configured }: { tenantId: string; configured?: TenantProviderView }) {
  const utils = trpc.useUtils();
  const [raw, setRaw] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (configured?.customConfig) setRaw(JSON.stringify(configured.customConfig, null, 2));
  }, [configured]);

  const validation = useMemo(() => (raw.trim() ? validateCustomConfig(raw) : null), [raw]);
  const configure = trpc.paymentGateway.configureProvider.useMutation({
    onSuccess: () => {
      toast.success("Custom gateway saved");
      utils.paymentGateway.getTenantProviders.invalidate({ tenantId });
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card className="border-dashed border-muted">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Plus className="h-4 w-4 text-muted-foreground" />
          Add custom gateway
        </CardTitle>
        <CardDescription>
          Describe a bespoke gateway as JSON. Buyers receive the{" "}
          <code className="text-xs">instructions</code> text and reconcile via receipt. See{" "}
          <a className="underline" href="https://docs.whatsappcommerce.dev/payments/custom-gateways" target="_blank" rel="noreferrer">
            the custom-gateway docs
          </a>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          rows={6}
          className="font-mono text-xs"
          placeholder='{ "instructions": "Pay to …", "baseUrl": "https://api.my-gateway.example" }'
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setTouched(true);
          }}
        />
        {touched && validation && !validation.ok && (
          <ul className="space-y-1">
            {validation.errors.map((err, i) => (
              <li key={i} className="text-xs text-amber-400">
                {err}
              </li>
            ))}
          </ul>
        )}
        <Button
          size="sm"
          disabled={configure.isPending || !validation?.ok}
          onClick={() => {
            if (!validation?.ok || !validation.parsed) return;
            const parsed = validation.parsed;
            configure.mutate({
              tenantId,
              provider: "custom",
              enabled: true,
              priority: configured?.priority ?? 0,
              instructions: typeof parsed.instructions === "string" ? parsed.instructions : undefined,
              customConfig: parsed,
            });
          }}
        >
          {configure.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
          Save custom gateway
        </Button>
      </CardContent>
    </Card>
  );
}

export default function ProviderSettings() {
  const { activeTenantId } = useActiveTenant();
  const tenantId = activeTenantId ?? "";
  const { data, isLoading } = trpc.paymentGateway.getTenantProviders.useQuery(
    { tenantId },
    { enabled: !!tenantId },
  );

  const providers: TenantProviderView[] = useMemo(
    () =>
      (data?.providers ?? []).map((p) => ({
        provider: p.provider,
        displayName: p.displayName,
        enabled: p.enabled,
        priority: p.priority,
        secretKey: p.secretKey,
        webhookSecret: p.webhookSecret,
        instructions: p.instructions,
        customConfig: p.customConfig as Record<string, unknown> | null,
      })),
    [data],
  );
  const chainPreview = useMemo(() => fallbackChainPreview(providers), [providers]);
  const catalog = useMemo(
    () => (data?.adapters ?? []).filter((a) => a.id !== "custom"),
    [data],
  );

  if (!tenantId) {
    return (
      <DashboardLayout>
        <div className="p-6 text-sm text-muted-foreground">Select a tenant to manage payment providers.</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6 max-w-4xl">
        <div>
          <h1 className="text-xl font-semibold">Payment Providers</h1>
          <p className="text-sm text-muted-foreground">
            Configure gateways and their fallback order. If the primary provider fails at checkout,
            the next enabled provider serves automatically.
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading providers…
          </div>
        ) : (
          <>
            <Card className="border-muted bg-muted/20">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Fallback chain</CardTitle>
              </CardHeader>
              <CardContent>
                {chainPreview.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No providers enabled yet — the platform default gateway will be used until you
                    configure one below.
                  </p>
                ) : (
                  <p className="text-sm">{chainPreview.join("  →  ")}</p>
                )}
              </CardContent>
            </Card>

            <div className="space-y-4">
              {catalog.map((adapter) => (
                <ProviderCard
                  key={adapter.id}
                  tenantId={tenantId}
                  adapter={adapter}
                  configured={providers.find((p) => p.provider === adapter.id)}
                />
              ))}
              <CustomGatewayCard
                tenantId={tenantId}
                configured={providers.find((p) => p.provider === "custom")}
              />
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
