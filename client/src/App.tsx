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
