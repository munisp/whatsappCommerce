/**
 * TelegramSetupCard — connect a business's Telegram bot from Integration Settings.
 *
 * Same shape as the Medusa / Odoo / Twenty cards: a write-only secret (shown only as "Stored: ••••1234"),
 * Save, Test connection and an Enabled switch. Two things are Telegram-specific:
 *   - "Register webhook": the SERVER tells Telegram where to deliver this business's messages, using the stored
 *     token and secret. The address is built by the server, so nothing here is typed except the bot's own token
 *     and username (both from @BotFather), and nothing secret is ever shown after saving.
 *   - a notice when the feature is switched off for the whole server, or the app's public address is not https
 *     (Telegram only delivers to https), because then registering cannot work.
 */
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { CheckCircle2, Copy, Loader2, Send, XCircle } from "lucide-react";

type Outcome = { ok: boolean; text: string };

export function TelegramSetupCard({ tenantId }: { tenantId: string }) {
  const utils = trpc.useUtils();
  const { data: config, isLoading } = trpc.tenant.getTelegramConfig.useQuery({ tenantId }, { enabled: !!tenantId });

  const [token, setToken] = useState("");
  const [username, setUsername] = useState<string | null>(null);
  const [enabledEdit, setEnabledEdit] = useState<boolean | null>(null);
  const [testOutcome, setTestOutcome] = useState<Outcome | null>(null);
  const [webhookOutcome, setWebhookOutcome] = useState<Outcome | null>(null);

  const usernameValue = username ?? config?.botUsername ?? "";
  const enabledValue = enabledEdit ?? config?.enabled ?? false;
  const dirty = token !== "" || username !== null || enabledEdit !== null;
  const hasStoredToken = Boolean(config?.botToken);

  const save = trpc.tenant.updateTelegramConfig.useMutation({
    onSuccess: () => {
      toast.success("Telegram settings saved");
      setToken("");
      setUsername(null);
      setEnabledEdit(null);
      setTestOutcome(null);
      setWebhookOutcome(null);
      utils.tenant.getTelegramConfig.invalidate({ tenantId });
    },
    onError: (e) => toast.error(e.message),
  });

  const test = trpc.tenant.testTelegramConnection.useMutation({
    onSuccess: (r) => {
      if (!r.ok) setTestOutcome({ ok: false, text: r.error ?? "Telegram did not accept the token." });
      else if (!r.matchesSaved) setTestOutcome({ ok: false, text: `This token belongs to @${r.botUsername}, not the username you saved. Check both.` });
      else setTestOutcome({ ok: true, text: `Connected to @${r.botUsername}` });
    },
    onError: (e) => setTestOutcome({ ok: false, text: e.message }),
  });

  const register = trpc.tenant.registerTelegramWebhook.useMutation({
    onSuccess: (r) => {
      if (!r.ok) setWebhookOutcome({ ok: false, text: r.error ?? "Telegram did not accept the webhook." });
      else if (r.lastErrorMessage) setWebhookOutcome({ ok: false, text: `Registered, but Telegram reports a delivery problem: ${r.lastErrorMessage}` });
      else setWebhookOutcome({ ok: true, text: `Webhook registered. Telegram has ${r.pendingUpdateCount} message${r.pendingUpdateCount === 1 ? "" : "s"} waiting.` });
    },
    onError: (e) => setWebhookOutcome({ ok: false, text: e.message }),
  });

  const busy = save.isPending || test.isPending || register.isPending;
  const canSave = !busy && dirty && usernameValue.trim().length >= 3 && (token !== "" || hasStoredToken);
  const canTest = !busy && hasStoredToken && !dirty;
  const canRegister = !busy && !dirty && Boolean(config?.configured) && Boolean(config?.serverEnabled) && Boolean(config?.webhookUrl);

  const doSave = () => {
    const payload: { tenantId: string; botUsername: string; enabled: boolean; botToken?: string } = {
      tenantId,
      botUsername: usernameValue.trim(),
      enabled: enabledValue,
    };
    // Only send the token when the operator typed one — reads are masked, and the server keeps the stored one.
    if (token) payload.botToken = token.trim();
    save.mutate(payload);
  };

  const copyUrl = async () => {
    if (!config?.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(config.webhookUrl);
      toast.success("Webhook address copied");
    } catch {
      toast.error("Could not copy. Select the address and copy it by hand.");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Send className="w-4 h-4 text-primary" />
            Telegram
            {config?.configured ? (
              <Badge variant="outline" className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">Enabled</Badge>
            ) : hasStoredToken ? (
              <Badge variant="outline" className="text-muted-foreground">Saved, not enabled</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">Not set up</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Let customers chat with this business on Telegram. Create a bot in Telegram with @BotFather (send /newbot),
            then paste its token and username here.
          </CardDescription>
        </div>
        <Switch
          checked={enabledValue}
          disabled={busy || isLoading || (!hasStoredToken && token === "")}
          onCheckedChange={(v) => setEnabledEdit(v)}
          aria-label="Enable Telegram"
        />
      </CardHeader>
      <CardContent className="space-y-4">
        {config && !config.serverEnabled && (
          <p className="text-xs rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-400 px-3 py-2">
            Telegram is switched off on this server. You can save the bot now, but the webhook cannot be registered
            until an engineer turns the feature on.
          </p>
        )}
        {config && config.serverEnabled && !config.webhookUrl && (
          <p className="text-xs rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-400 px-3 py-2">
            This app's public address is not https, and Telegram only delivers to https. The webhook cannot be registered here.
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="tg-bot-username">Bot username</Label>
            <Input
              id="tg-bot-username"
              value={usernameValue}
              placeholder="your_store_bot"
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tg-bot-token">Bot token</Label>
            <Input
              id="tg-bot-token"
              type="password"
              value={token}
              autoComplete="off"
              placeholder={config?.botToken ? `Stored: ${config.botToken} — type to replace` : "123456789:AA… (from @BotFather)"}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={doSave} disabled={!canSave}>
            {save.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Save
          </Button>
          <Button
            size="sm" variant="outline" disabled={!canTest}
            onClick={() => { setTestOutcome(null); test.mutate({ tenantId }); }}
          >
            {test.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Test connection
          </Button>
          <Button
            size="sm" variant="outline" disabled={!canRegister}
            onClick={() => { setWebhookOutcome(null); register.mutate({ tenantId }); }}
          >
            {register.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Register webhook
          </Button>
          {dirty && <span className="text-xs text-muted-foreground">Unsaved changes: save before testing or registering.</span>}
        </div>

        {testOutcome && (
          <p className={`flex items-center gap-1.5 text-xs ${testOutcome.ok ? "text-emerald-400" : "text-red-400"}`}>
            {testOutcome.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
            {testOutcome.text}
          </p>
        )}
        {webhookOutcome && (
          <p className={`flex items-center gap-1.5 text-xs ${webhookOutcome.ok ? "text-emerald-400" : "text-red-400"}`}>
            {webhookOutcome.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
            {webhookOutcome.text}
          </p>
        )}

        {config?.webhookUrl && (
          <div className="space-y-1.5">
            <Label>Webhook address (set for you when you register)</Label>
            <div className="flex items-center gap-2">
              <code className="text-xs bg-muted rounded px-2 py-1 break-all flex-1">{config.webhookUrl}</code>
              <Button size="sm" variant="outline" onClick={copyUrl} aria-label="Copy webhook address">
                <Copy className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
