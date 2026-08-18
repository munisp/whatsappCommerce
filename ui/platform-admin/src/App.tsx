import { lazy, Suspense, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Router as WouterRouter, Switch, useLocation } from "wouter";
import ErrorBoundary from "@/components/ErrorBoundary";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthGate } from "@ui-shared/AuthGate";

// Derived from BASE_URL (set directly from vite.config.ts's `base`, which
// only depends on the build `command`) rather than PROD/MODE — those follow
// Vite's `mode`, which a stray NODE_ENV in a loaded .env file can flip to
// "development" even during a real `vite build` (see .dockerignore).
const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");

// Platform-wide routes only — tenant/merchant-facing pages live in
// ui/tenant-portal. See ui/platform-admin/ROUTES.md for the full triage
// and known ambiguous/duplicate items.
const AdminPortal = lazy(() => import("@/pages/AdminPortal"));
const AgentConsole = lazy(() => import("@/pages/AgentConsole"));
const AgentArchitecture = lazy(() => import("@/pages/AgentArchitecture"));
const NLPSimulator = lazy(() => import("@/pages/NLPSimulator"));
const LogisticsTracker = lazy(() => import("@/pages/LogisticsTracker"));
const Tenants = lazy(() => import("@/pages/Tenants"));
const TenantAnalytics = lazy(() => import("@/pages/TenantAnalytics"));
const TenantDetail = lazy(() => import("@/pages/TenantDetail"));
const TenantOnboarding = lazy(() => import("@/pages/TenantOnboarding"));
const TenantMenuAssignment = lazy(() => import("@/pages/TenantMenuAssignment"));
const SsoUsers = lazy(() => import("@/pages/SsoUsers"));
const PhoneAuthPage = lazy(() => import("@/pages/PhoneAuthPage"));
const WhatsAppProfilePage = lazy(() => import("@/pages/WhatsAppProfilePage"));
const AlertRules = lazy(() => import("@/pages/AlertRules"));
const ServiceHealth = lazy(() => import("@/pages/ServiceHealth"));
const CredentialWizard = lazy(() => import("@/pages/CredentialWizard"));
const DeployChecklist = lazy(() => import("@/pages/DeployChecklist"));
const CompliancePortal = lazy(() => import("@/pages/CompliancePortal"));
const Compliance = lazy(() => import("@/pages/Compliance"));
const KybReview = lazy(() => import("@/pages/KybReview"));
const InfraHealth = lazy(() => import("@/pages/InfraHealth"));
const LiveLogisticsMap = lazy(() => import("@/pages/LiveLogisticsMap"));
const HealthStatus = lazy(() => import("@/pages/HealthStatus"));
const AuditLogViewer = lazy(() => import("@/pages/AuditLogViewer"));
const AuditLog = lazy(() => import("@/pages/AuditLog"));
const MLOpsDashboard = lazy(() => import("@/pages/MLOpsDashboard"));
const ReconciliationSim = lazy(() => import("@/pages/ReconciliationSim"));
const WebhookDLQ = lazy(() => import("@/pages/WebhookDLQ"));
const LabelStudioPipe = lazy(() => import("@/pages/LabelStudioPipe"));
const ScanStatsDashboard = lazy(() => import("@/pages/ScanStatsDashboard"));
const HermesDashboard = lazy(() => import("@/pages/HermesDashboard"));
const CogsDisputes = lazy(() => import("@/pages/CogsDisputes"));

// UnifiedOnboarding (generic multi-service provisioning wizard) and
// TenantOnboarding/"/onboarding" (KYC-driven admin onboarding) were two
// parallel, real onboarding flows with no nav item pointing at the loser —
// TenantOnboarding is the one that stays live. Redirect rather than delete
// outright, in case anything has the old path bookmarked.
function RouteRedirect({ to }: { to: string }) {
  const [, navigate] = useLocation();
  useEffect(() => { navigate(to, { replace: true }); }, [to, navigate]);
  return null;
}

function RouteFallback() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]" aria-label="Loading page">
      <Loader2 className="w-8 h-8 animate-spin text-primary" />
    </div>
  );
}

function Router() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Switch>
        <Route path="/" component={AdminPortal} />
        <Route path="/tenants" component={Tenants} />
        <Route path="/tenant-analytics" component={TenantAnalytics} />
        <Route path="/tenants/:id" component={TenantDetail} />
        <Route path="/onboarding" component={TenantOnboarding} />
        <Route path="/tenant-menus" component={TenantMenuAssignment} />
        <Route path="/unified-onboarding" component={() => <RouteRedirect to="/onboarding" />} />
        <Route path="/sso-users" component={SsoUsers} />
        <Route path="/phone-auth" component={PhoneAuthPage} />
        <Route path="/whatsapp-profile" component={WhatsAppProfilePage} />
        <Route path="/alert-rules" component={AlertRules} />
        <Route path="/health" component={ServiceHealth} />
        <Route path="/setup" component={CredentialWizard} />
        <Route path="/deploy-checklist" component={DeployChecklist} />
        <Route path="/compliance" component={CompliancePortal} />
        <Route path="/soc2" component={Compliance} />
        <Route path="/kyb-review" component={KybReview} />
        <Route path="/infra-health" component={InfraHealth} />
        <Route path="/logistics" component={LogisticsTracker} />
        <Route path="/logistics-map" component={LiveLogisticsMap} />
        <Route path="/system-health" component={HealthStatus} />
        <Route path="/audit-logs" component={AuditLogViewer} />
        <Route path="/audit-log" component={AuditLog} />
        <Route path="/agent" component={AgentConsole} />
        <Route path="/agent-architecture" component={AgentArchitecture} />
        <Route path="/nlp-simulator" component={NLPSimulator} />
        <Route path="/ml-ops" component={MLOpsDashboard} />
        <Route path="/reconciliation" component={ReconciliationSim} />
        <Route path="/webhook-dlq" component={WebhookDLQ} />
        <Route path="/label-studio" component={LabelStudioPipe} />
        <Route path="/scan-stats" component={ScanStatsDashboard} />
        <Route path="/hermes" component={HermesDashboard} />
        <Route path="/cogs-disputes" component={CogsDisputes} />
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <AuthGate
            allow={user => user.role === "admin"}
            deniedTitle="Platform admins only"
            deniedMessage="This application is restricted to platform administrators. If you manage a business on WhatsApp Commerce, use the Merchant Portal instead."
          >
            <WouterRouter base={BASE_PATH}>
              <Router />
            </WouterRouter>
          </AuthGate>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
