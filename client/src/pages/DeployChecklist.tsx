import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Circle, ExternalLink, Terminal, AlertTriangle, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";

type CheckItem = {
  id: string;
  category: string;
  title: string;
  description: string;
  command?: string;
  link?: string;
  required: boolean;
};

const CHECKLIST: CheckItem[] = [
  // Deployment
  { id: "publish", category: "Deployment", title: "Publish the site", description: "Click the Publish button in the Manus Management UI header to deploy to production.", required: true },
  { id: "domain", category: "Deployment", title: "Configure custom domain (optional)", description: "Go to Settings → Domains to set a custom domain for your production URL.", required: false },

  // Heartbeat / Cron
  { id: "heartbeat", category: "Scheduled Jobs", title: "Activate inventory sync cron", description: "Run this command in the sandbox terminal after publishing to start the 5-minute Odoo stock sync.", command: "manus-heartbeat create --name inventory-sync --cron \"0 */5 * * * *\" --path /api/scheduled/inventory-sync", required: true },
  { id: "heartbeat-invoice", category: "Scheduled Jobs", title: "Activate monthly invoice generation", description: "Run this command to auto-generate invoices on the 1st of each month at midnight UTC.", command: "manus-heartbeat create --name monthly-invoices --cron \"0 0 1 * *\" --path /api/scheduled/generate-invoices", required: false },
  { id: "heartbeat-ab-metrics", category: "Scheduled Jobs", title: "Activate A/B test metrics cron (ML Ops)", description: "Computes per-variant conversion rates and z-test p-values for running model A/B tests every 30 minutes.", command: "manus-heartbeat create --name ab-test-metrics --cron \"0 */30 * * * *\" --path /api/scheduled/ab-test-metrics", required: false },
  { id: "heartbeat-drift-alert", category: "Scheduled Jobs", title: "Activate drift alert cron (ML Ops)", description: "Reads drift_log.json every 6 hours and sends owner push notification when any feature PSI exceeds 0.2.", command: "manus-heartbeat create --name drift-alert --cron \"0 0 */6 * * *\" --path /api/scheduled/drift-alert", required: false },
  { id: "heartbeat-nightly-finetune", category: "Scheduled Jobs", title: "Activate nightly model fine-tune cron (ML Ops)", description: "Triggers the NLP fine-tune pipeline daily at 2 AM UTC to retrain on new conversation data.", command: "manus-heartbeat create --name nightly-finetune --cron \"0 0 2 * * *\" --path /api/scheduled/nightly-finetune", required: false },

  // Payment Gateways
  { id: "paystack-keys", category: "Payment Gateways", title: "Configure Paystack API keys", description: "Each tenant must add their Paystack public/secret keys via the Merchant Portal → Settings → Payment Gateways.", required: true },
  { id: "paystack-webhook", category: "Payment Gateways", title: "Register Paystack webhook", description: "In your Paystack dashboard, set the webhook URL to: https://your-domain.com/api/webhooks/paystack", command: "POST https://your-domain.com/api/webhooks/paystack", required: true },
  { id: "flutterwave-webhook", category: "Payment Gateways", title: "Register Flutterwave webhook", description: "In your Flutterwave dashboard, set the webhook URL to: https://your-domain.com/api/webhooks/flutterwave", required: false },
  { id: "mojaloop-config", category: "Payment Gateways", title: "Configure Mojaloop FSPIOP endpoint", description: "Set MOJALOOP_HUB_URL in Secrets (Settings → Secrets) to your Mojaloop hub base URL.", required: false },

  // WhatsApp / Meta
  { id: "meta-token", category: "WhatsApp / Meta", title: "Set Meta WhatsApp token", description: "Add WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID to Secrets for each tenant's WhatsApp Business Account.", required: true },
  { id: "meta-webhook", category: "WhatsApp / Meta", title: "Register Meta webhook", description: "In Meta Developer Console, set the webhook URL to: https://your-domain.com/api/webhooks/whatsapp and verify with WHATSAPP_VERIFY_TOKEN.", required: true },
  { id: "template-approval", category: "WhatsApp / Meta", title: "Submit message templates to Meta", description: "Go to Template Library and click 'Submit to Meta' for each template you want to use in campaigns.", required: true },

  // KYC / Verification
  { id: "kyc-service", category: "KYC / Verification", title: "Deploy KYC microservice", description: "Deploy services/kyc-verifier/ as a separate Docker container and set KYC_SERVICE_URL in Secrets.", command: "cd services/kyc-verifier && docker-compose up -d", required: false },
  { id: "kyc-service-url", category: "KYC / Verification", title: "Set KYC_SERVICE_URL secret", description: "After deploying the KYC service, add KYC_SERVICE_URL to Settings → Secrets.", required: false },

  // Middleware
  { id: "kafka", category: "Middleware", title: "Deploy Kafka event bus", description: "Deploy services/middleware/ stack and set KAFKA_BROKERS in Secrets for real-time message routing.", command: "cd services/middleware && docker-compose -f docker-compose.middleware.yml up -d", required: false },
  { id: "redis", category: "Middleware", title: "Set REDIS_URL secret", description: "Add REDIS_URL to Settings → Secrets for session caching and rate limiting.", required: false },
  { id: "odoo-url", category: "Middleware", title: "Set Odoo connection secrets", description: "Add ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD to Settings → Secrets for ERP integration.", required: false },
  { id: "twenty-token", category: "Middleware", title: "Set Twenty CRM API token", description: "Add TWENTY_API_URL and TWENTY_API_KEY to Settings → Secrets for CRM integration.", required: false },

  // Security
  { id: "admin-role", category: "Security", title: "Promote owner to admin", description: "After first login, run this SQL to give yourself admin access.", command: "UPDATE users SET role = 'admin' WHERE open_id = 'YOUR_OPEN_ID';", required: true },
  { id: "cors", category: "Security", title: "Review CORS settings", description: "Ensure ALLOWED_ORIGINS in env is set to your production domain only.", required: false },
];

const CATEGORIES = Array.from(new Set(CHECKLIST.map(c => c.category)));

export default function DeployChecklist() {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);

  const toggle = (id: string) => setChecked(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const copyCmd = (cmd: string, id: string) => {
    navigator.clipboard.writeText(cmd);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const required = CHECKLIST.filter(c => c.required);
  const requiredDone = required.filter(c => checked.has(c.id)).length;
  const allDone = CHECKLIST.filter(c => checked.has(c.id)).length;
  const pct = Math.round((allDone / CHECKLIST.length) * 100);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              <Rocket className="h-6 w-6 text-emerald-400" />
              Production Deploy Checklist
            </h1>
            <p className="text-slate-400 text-sm mt-1">
              Complete these steps before going live. Required items must be done first.
            </p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold text-white">{pct}%</div>
            <div className="text-xs text-slate-400">{allDone}/{CHECKLIST.length} complete</div>
            {requiredDone < required.length && (
              <Badge className="mt-1 bg-red-600/20 text-red-400 border-red-600/30 text-xs">
                {required.length - requiredDone} required remaining
              </Badge>
            )}
            {requiredDone === required.length && (
              <Badge className="mt-1 bg-emerald-600/20 text-emerald-400 border-emerald-600/30 text-xs">
                All required done ✓
              </Badge>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
          <div className="h-full bg-emerald-500 transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>

        {CATEGORIES.map(cat => (
          <Card key={cat} className="bg-slate-800 border-slate-700">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-slate-300 uppercase tracking-wider">{cat}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {CHECKLIST.filter(c => c.category === cat).map(item => (
                <div
                  key={item.id}
                  className={cn(
                    "flex gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                    checked.has(item.id)
                      ? "bg-emerald-900/20 border-emerald-700/40"
                      : "bg-slate-700/30 border-slate-700 hover:bg-slate-700/50",
                  )}
                  onClick={() => toggle(item.id)}
                >
                  <div className="mt-0.5 flex-shrink-0">
                    {checked.has(item.id)
                      ? <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                      : <Circle className="h-5 w-5 text-slate-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={cn("text-sm font-medium", checked.has(item.id) ? "text-emerald-300 line-through" : "text-white")}>
                        {item.title}
                      </span>
                      {item.required && (
                        <Badge className="text-xs bg-red-600/20 text-red-400 border-red-600/30 py-0">Required</Badge>
                      )}
                    </div>
                    <p className="text-xs text-slate-400">{item.description}</p>
                    {item.command && (
                      <div className="mt-2 flex items-center gap-2">
                        <code className="flex-1 text-xs bg-slate-900 text-emerald-300 px-3 py-1.5 rounded font-mono truncate">
                          {item.command}
                        </code>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-slate-400 hover:text-white flex-shrink-0"
                          onClick={e => { e.stopPropagation(); copyCmd(item.command!, item.id); }}
                        >
                          <Terminal className="h-3 w-3 mr-1" />
                          {copied === item.id ? "Copied!" : "Copy"}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </DashboardLayout>
  );
}
