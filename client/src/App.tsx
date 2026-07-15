import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import Tenants from "./pages/Tenants";
import TenantDetail from "./pages/TenantDetail";
import Products from "./pages/Products";
import Conversations from "./pages/Conversations";
import Orders from "./pages/Orders";
import OrderTimeline from "./pages/OrderTimeline";
import Payments from "./pages/Payments";
import AgentConsole from "./pages/AgentConsole";
import ServiceHealth from "./pages/ServiceHealth";
import TwentyCRM from "./pages/TwentyCRM";
import OdooERP from "./pages/OdooERP";
import MenuBuilder from "./pages/MenuBuilder";
import IntegrationHub from "./pages/IntegrationHub";
import TemplateLibrary from "./pages/TemplateLibrary";
import TenantMenuAssignment from "./pages/TenantMenuAssignment";
import CredentialWizard from "./pages/CredentialWizard";
import TemplateVersions from "./pages/TemplateVersions";
import BroadcastCampaigns from "./pages/BroadcastCampaigns";
import InventorySync from "./pages/InventorySync";
import TenantOnboarding from "./pages/TenantOnboarding";
import AgentArchitecture from "./pages/AgentArchitecture";
import NLPSimulator from "./pages/NLPSimulator";
import Invoices from "./pages/Invoices";
import PortalMagicLogin from "@/pages/portal/PortalMagicLogin";
import PortalDashboard from "./pages/portal/PortalDashboard";
import PortalProducts from "./pages/portal/PortalProducts";
import PortalOrders from "./pages/portal/PortalOrders";
import PortalInvoices from "./pages/portal/PortalInvoices";
import PortalSettings from "./pages/portal/PortalSettings";
import PortalConversations from "./pages/portal/PortalConversations";
import PortalPayments from "./pages/portal/PortalPayments";
import DeployChecklist from "./pages/DeployChecklist";
import MLOpsDashboard from "./pages/MLOpsDashboard";
import ReconciliationSim from "./pages/ReconciliationSim";
import AlertRules from "./pages/AlertRules";
import SsoCallback from "./pages/portal/SsoCallback";
import CogsDisputes from "./pages/CogsDisputes";
import SsoUsers from "./pages/SsoUsers";
import RevenueDashboard from "./pages/RevenueDashboard";
import EscrowDashboard from "./pages/EscrowDashboard";
import LogisticsTracker from "./pages/LogisticsTracker";
import DisputeManagement from "./pages/DisputeManagement";
import PortalWallet from "./pages/portal/PortalWallet";
import OnboardingWizard from "./pages/portal/OnboardingWizard";
import EvidencePortal from "./pages/EvidencePortal";
import MerchantAnalytics from "./pages/portal/MerchantAnalytics";
import PortalBroadcasts from "./pages/portal/PortalBroadcasts";
import AuditLog from "./pages/AuditLog";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/tenants" component={Tenants} />
      <Route path="/tenants/:id" component={TenantDetail} />
      <Route path="/products" component={Products} />
      <Route path="/conversations" component={Conversations} />
      <Route path="/orders" component={Orders} />
      <Route path="/orders/:orderNumber" component={OrderTimeline} />
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
          <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
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
import WhatsAppMediaPortal from "./pages/WhatsAppMediaPortal";
import SlaExtensionResponse from "./pages/SlaExtensionResponse";
import OperatorTemplates from "./pages/OperatorTemplates";
import B2BPortal from "./pages/B2BPortal";
import MultiChannelHub from "./pages/MultiChannelHub";
import MarketplacePortal from "./pages/MarketplacePortal";
import MobileMoneyPortal from "./pages/MobileMoneyPortal";
import ServiceCommercePage from "./pages/ServiceCommercePage";
import AnalyticsBIDashboard from "./pages/AnalyticsBIDashboard";
import CompliancePortal from "./pages/CompliancePortal";
import MedusaIntegration from "./pages/MedusaIntegration";
import WebhookDLQ from "./pages/WebhookDLQ";
import UnifiedOnboarding from "./pages/UnifiedOnboarding";
import IntegrationHealth from "./pages/IntegrationHealth";
import VisualInventory from "./pages/VisualInventory";
import MedusaOnboarding from "./pages/MedusaOnboarding";
import OdooMedusaBridge from "./pages/OdooMedusaBridge";
import LabelStudioPipe from "./pages/LabelStudioPipe";
import FmcgTaxonomy from "./pages/FmcgTaxonomy";
import ScanStatsDashboard from "./pages/ScanStatsDashboard";
