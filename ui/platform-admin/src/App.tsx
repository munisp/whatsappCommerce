import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Router as WouterRouter, Switch } from "wouter";
import ErrorBoundary from "@/components/ErrorBoundary";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthGate } from "@ui-shared/AuthGate";

// Platform-wide routes only — tenant/merchant-facing pages live in
// ui/tenant-portal. See ui/platform-admin/ROUTES.md for the full triage
// and known ambiguous/duplicate items.
const AdminPortal = lazy(() => import("@/pages/AdminPortal"));
const LogisticsTracker = lazy(() => import("@/pages/LogisticsTracker"));
const Tenants = lazy(() => import("@/pages/Tenants"));
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
const IntegrationHealth = lazy(() => import("@/pages/IntegrationHealth"));
const SupplierApprovals = lazy(() => import("@/pages/SupplierApprovals"));
const UnifiedOnboarding = lazy(() => import("@/pages/UnifiedOnboarding"));
const CogsDisputes = lazy(() => import("@/pages/CogsDisputes"));

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
        <Route path="/tenants/:id" component={TenantDetail} />
        <Route path="/onboarding" component={TenantOnboarding} />
        <Route path="/tenant-menus" component={TenantMenuAssignment} />
        <Route path="/unified-onboarding" component={UnifiedOnboarding} />
        <Route path="/sso-users" component={SsoUsers} />
        <Route path="/phone-auth" component={PhoneAuthPage} />
        <Route path="/whatsapp-profile" component={WhatsAppProfilePage} />
        <Route path="/alert-rules" component={AlertRules} />
        <Route path="/health" component={ServiceHealth} />
        <Route path="/setup" component={CredentialWizard} />
        <Route path="/deploy-checklist" component={DeployChecklist} />
        <Route path="/compliance" component={CompliancePortal} />
        <Route path="/infra-health" component={InfraHealth} />
        <Route path="/logistics" component={LogisticsTracker} />
        <Route path="/logistics-map" component={LiveLogisticsMap} />
        <Route path="/system-health" component={HealthStatus} />
        <Route path="/audit-logs" component={AuditLogViewer} />
        <Route path="/audit-log" component={AuditLog} />
        <Route path="/ml-ops" component={MLOpsDashboard} />
        <Route path="/reconciliation" component={ReconciliationSim} />
        <Route path="/webhook-dlq" component={WebhookDLQ} />
        <Route path="/label-studio" component={LabelStudioPipe} />
        <Route path="/scan-stats" component={ScanStatsDashboard} />
        <Route path="/hermes" component={HermesDashboard} />
        <Route path="/integration-health" component={IntegrationHealth} />
        <Route path="/supplier-approvals" component={SupplierApprovals} />
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
            <WouterRouter base={import.meta.env.PROD ? "/platform-admin" : ""}>
              <Router />
            </WouterRouter>
          </AuthGate>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
