import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import PortalMagicLogin from "@/pages/portal/PortalMagicLogin";

// Route-level code splitting: every non-essential page is a lazy chunk so
// the initial bundle only carries the shell + dashboard/login. Heavy routes
// (LiveLogisticsMap/maplibre, OnboardingCopilot, admin/analytics pages) load on demand.
const Tenants = lazy(() => import("./pages/Tenants"));
const TenantDetail = lazy(() => import("./pages/TenantDetail"));
const Products = lazy(() => import("./pages/Products"));
const Conversations = lazy(() => import("./pages/Conversations"));
const Orders = lazy(() => import("./pages/Orders"));
const OrderTimeline = lazy(() => import("./pages/OrderTimeline"));
const Payments = lazy(() => import("./pages/Payments"));
const AgentConsole = lazy(() => import("./pages/AgentConsole"));
const ServiceHealth = lazy(() => import("./pages/ServiceHealth"));
const TwentyCRM = lazy(() => import("./pages/TwentyCRM"));
const OdooERP = lazy(() => import("./pages/OdooERP"));
const MenuBuilder = lazy(() => import("./pages/MenuBuilder"));
const IntegrationHub = lazy(() => import("./pages/IntegrationHub"));
const TemplateLibrary = lazy(() => import("./pages/TemplateLibrary"));
const TenantMenuAssignment = lazy(() => import("./pages/TenantMenuAssignment"));
const CredentialWizard = lazy(() => import("./pages/CredentialWizard"));
const TemplateVersions = lazy(() => import("./pages/TemplateVersions"));
const BroadcastCampaigns = lazy(() => import("./pages/BroadcastCampaigns"));
const InventorySync = lazy(() => import("./pages/InventorySync"));
const TenantOnboarding = lazy(() => import("./pages/TenantOnboarding"));
const AgentArchitecture = lazy(() => import("./pages/AgentArchitecture"));
const NLPSimulator = lazy(() => import("./pages/NLPSimulator"));
const TrackOrder = lazy(() => import("./pages/TrackOrder"));
const Invoices = lazy(() => import("./pages/Invoices"));
const PortalDashboard = lazy(() => import("./pages/portal/PortalDashboard"));
const PortalProducts = lazy(() => import("./pages/portal/PortalProducts"));
const PortalOrders = lazy(() => import("./pages/portal/PortalOrders"));
const PortalInvoices = lazy(() => import("./pages/portal/PortalInvoices"));
const PortalSettings = lazy(() => import("./pages/portal/PortalSettings"));
const PortalConversations = lazy(() => import("./pages/portal/PortalConversations"));
const PortalPayments = lazy(() => import("./pages/portal/PortalPayments"));
const DeployChecklist = lazy(() => import("./pages/DeployChecklist"));
const MLOpsDashboard = lazy(() => import("./pages/MLOpsDashboard"));
const ReconciliationSim = lazy(() => import("./pages/ReconciliationSim"));
const AlertRules = lazy(() => import("./pages/AlertRules"));
const SsoCallback = lazy(() => import("./pages/portal/SsoCallback"));
const CogsDisputes = lazy(() => import("./pages/CogsDisputes"));
const SsoUsers = lazy(() => import("./pages/SsoUsers"));
const RevenueDashboard = lazy(() => import("./pages/RevenueDashboard"));
const EscrowDashboard = lazy(() => import("./pages/EscrowDashboard"));
const LogisticsTracker = lazy(() => import("./pages/LogisticsTracker"));
const DisputeManagement = lazy(() => import("./pages/DisputeManagement"));
const PortalWallet = lazy(() => import("./pages/portal/PortalWallet"));
const OnboardingWizard = lazy(() => import("./pages/portal/OnboardingWizard"));
const EvidencePortal = lazy(() => import("./pages/EvidencePortal"));
const MerchantAnalytics = lazy(() => import("./pages/portal/MerchantAnalytics"));
const PortalBroadcasts = lazy(() => import("./pages/portal/PortalBroadcasts"));
const AuditLog = lazy(() => import("./pages/AuditLog"));
const WaMenuBuilder = lazy(() => import("./pages/WaMenuBuilder"));
const TenantOnboardingWizard = lazy(() => import("./pages/TenantOnboardingWizard"));
const IntegrationsSettings = lazy(() => import("./pages/IntegrationsSettings"));
const TenantSettings = lazy(() => import("./pages/TenantSettings"));
const LiveLogisticsMap = lazy(() => import("./pages/LiveLogisticsMap"));
const HealthStatus = lazy(() => import("./pages/HealthStatus"));
const AuditLogViewer = lazy(() => import("./pages/AuditLogViewer"));
const WaTemplates = lazy(() => import("./pages/WaTemplates"));
const SupplierDirectory = lazy(() => import("./pages/SupplierDirectory"));
const ProcurementHub = lazy(() => import("./pages/ProcurementHub"));
const CreditAccounts = lazy(() => import("./pages/CreditAccounts"));
const SupplierApprovals = lazy(() => import("./pages/SupplierApprovals"));
const WhatsAppMediaPortal = lazy(() => import("./pages/WhatsAppMediaPortal"));
const SlaExtensionResponse = lazy(() => import("./pages/SlaExtensionResponse"));
const OperatorTemplates = lazy(() => import("./pages/OperatorTemplates"));
const B2BPortal = lazy(() => import("./pages/B2BPortal"));
const MultiChannelHub = lazy(() => import("./pages/MultiChannelHub"));
const MarketplacePortal = lazy(() => import("./pages/MarketplacePortal"));
const MobileMoneyPortal = lazy(() => import("./pages/MobileMoneyPortal"));
const ServiceCommercePage = lazy(() => import("./pages/ServiceCommercePage"));
const AnalyticsBIDashboard = lazy(() => import("./pages/AnalyticsBIDashboard"));
const CompliancePortal = lazy(() => import("./pages/CompliancePortal"));
const MedusaIntegration = lazy(() => import("./pages/MedusaIntegration"));
const WebhookDLQ = lazy(() => import("./pages/WebhookDLQ"));
const UnifiedOnboarding = lazy(() => import("./pages/UnifiedOnboarding"));
const IntegrationHealth = lazy(() => import("./pages/IntegrationHealth"));
const VisualInventory = lazy(() => import("./pages/VisualInventory"));
const MedusaOnboarding = lazy(() => import("./pages/MedusaOnboarding"));
const OdooMedusaBridge = lazy(() => import("./pages/OdooMedusaBridge"));
const LabelStudioPipe = lazy(() => import("./pages/LabelStudioPipe"));
const FmcgTaxonomy = lazy(() => import("./pages/FmcgTaxonomy"));
const ProductImageCollector = lazy(() => import("./pages/ProductImageCollector"));
const ScanStatsDashboard = lazy(() => import("./pages/ScanStatsDashboard"));
const TenantAnalytics = lazy(() => import("./pages/TenantAnalytics"));
const HermesDashboard = lazy(() => import("./pages/HermesDashboard"));
const PhoneAuthPage = lazy(() => import("./pages/PhoneAuthPage"));
const WhatsAppProfilePage = lazy(() => import("./pages/WhatsAppProfilePage"));
const InfraHealth = lazy(() => import("./pages/InfraHealth"));
const AdminPortal = lazy(() => import("./pages/AdminPortal"));
const OnboardingCopilot = lazy(() => import("./pages/OnboardingCopilot"));

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
      <Route path="/" component={Home} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/tenants" component={Tenants} />
      <Route path="/tenants/:id" component={TenantDetail} />
      <Route path="/products" component={Products} />
      <Route path="/conversations" component={Conversations} />
      <Route path="/orders" component={Orders} />
      <Route path="/orders/:orderNumber" component={OrderTimeline} />
      <Route path="/track/:token" component={TrackOrder} />
      <Route path="/payments" component={Payments} />
      <Route path="/agent" component={AgentConsole} />
      <Route path="/health" component={ServiceHealth} />
      <Route path="/twenty-crm" component={TwentyCRM} />
      <Route path="/odoo-erp" component={OdooERP} />
      <Route path="/menu-builder" component={MenuBuilder} />
      <Route path="/integrations" component={IntegrationHub} />
      <Route path="/templates" component={TemplateLibrary} />
      <Route path="/tenant-menus" component={TenantMenuAssignment} />
      <Route path="/setup" component={CredentialWizard} />
      <Route path="/template-versions" component={TemplateVersions} />
      <Route path="/broadcast" component={BroadcastCampaigns} />
      <Route path="/inventory" component={InventorySync} />
      <Route path="/onboarding" component={TenantOnboarding} />
          <Route path="/agent-architecture" component={AgentArchitecture} />
          <Route path="/nlp-simulator" component={NLPSimulator} />
          <Route path="/invoices" component={Invoices} />
          <Route path="/portal" component={PortalDashboard} />
          {/* Magic-link login: matches the /portal/login?token=... links generated by server/routers/tenantInvite.ts */}
          <Route path="/portal/login" component={PortalMagicLogin} />
          <Route path="/portal/magic-login" component={PortalMagicLogin} />
          <Route path="/portal/products" component={PortalProducts} />
          <Route path="/portal/orders" component={PortalOrders} />
          <Route path="/portal/invoices" component={PortalInvoices} />
          <Route path="/portal/settings" component={PortalSettings} />
          <Route path="/portal/conversations" component={PortalConversations} />
          <Route path="/portal/payments" component={PortalPayments} />
          <Route path="/deploy-checklist" component={DeployChecklist} />
          <Route path="/ml-ops" component={MLOpsDashboard} />
          <Route path="/reconciliation" component={ReconciliationSim} />
          <Route path="/alert-rules" component={AlertRules} />
          <Route path="/portal/sso-callback" component={SsoCallback} />
          <Route path="/sso-users" component={SsoUsers} />
          <Route path="/cogs-disputes" component={CogsDisputes} />
          <Route path="/revenue" component={RevenueDashboard} />
          <Route path="/escrow" component={EscrowDashboard} />
          <Route path="/logistics" component={LogisticsTracker} />
          <Route path="/disputes" component={DisputeManagement} />
          <Route path="/portal/wallet" component={PortalWallet} />
          <Route path="/portal/setup" component={() => <OnboardingWizard onComplete={() => { window.location.href = "/portal"; }} />} />
          <Route path="/portal/analytics" component={MerchantAnalytics} />
          <Route path="/portal/broadcasts" component={PortalBroadcasts} />
          <Route path="/audit-log" component={AuditLog} />
          <Route path="/wa-menu-builder" component={WaMenuBuilder} />
          <Route path="/onboarding-wizard" component={TenantOnboardingWizard} />
          <Route path="/integration-settings" component={IntegrationsSettings} />
          <Route path="/tenant-settings" component={TenantSettings} />
          <Route path="/logistics-map" component={LiveLogisticsMap} />
          <Route path="/system-health" component={HealthStatus} />
          <Route path="/audit-logs" component={AuditLogViewer} />
          <Route path="/whatsapp-media" component={WhatsAppMediaPortal} />
          <Route path="/operator-templates" component={OperatorTemplates} />
          <Route path="/evidence/:token" component={EvidencePortal} />
          <Route path="/sla-extension/:token" component={SlaExtensionResponse} />
          <Route path="/b2b" component={B2BPortal} />
          <Route path="/multi-channel" component={MultiChannelHub} />
          <Route path="/marketplace" component={MarketplacePortal} />
          <Route path="/mobile-money" component={MobileMoneyPortal} />
          <Route path="/service-commerce" component={ServiceCommercePage} />
          <Route path="/analytics-bi" component={AnalyticsBIDashboard} />
          <Route path="/compliance" component={CompliancePortal} />
          <Route path="/medusa" component={MedusaIntegration} />
          <Route path="/webhook-dlq" component={WebhookDLQ} />
          <Route path="/visual-inventory" component={VisualInventory} />
          <Route path="/medusa-onboarding" component={MedusaOnboarding} />
          <Route path="/odoo-medusa-bridge" component={OdooMedusaBridge} />
          <Route path="/label-studio" component={LabelStudioPipe} />
          <Route path="/fmcg-taxonomy" component={FmcgTaxonomy} />
          <Route path="/scan-stats" component={ScanStatsDashboard} />
          <Route path="/product-images" component={ProductImageCollector} />
          <Route path="/tenant-analytics" component={TenantAnalytics} />
          <Route path="/hermes" component={HermesDashboard} />
          <Route path="/phone-auth" component={PhoneAuthPage} />
          <Route path="/whatsapp-profile" component={WhatsAppProfilePage} />
          <Route path="/infra-health" component={InfraHealth} />
          <Route path="/admin" component={AdminPortal} />
          <Route path="/integration-health" component={IntegrationHealth} />
          <Route path="/unified-onboarding" component={UnifiedOnboarding} />
          <Route path="/wa-templates" component={WaTemplates} />
          <Route path="/suppliers" component={SupplierDirectory} />
          <Route path="/procurement" component={ProcurementHub} />
          <Route path="/credit-accounts" component={CreditAccounts} />
          <Route path="/supplier-approvals" component={SupplierApprovals} />
          <Route path="/onboarding-copilot" component={OnboardingCopilot} />
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
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
