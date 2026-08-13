import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Router as WouterRouter, Switch } from "wouter";

const BASE_PATH = import.meta.env.PROD ? "/tenant-portal" : "";
import ErrorBoundary from "@/components/ErrorBoundary";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthGate } from "@ui-shared/AuthGate";
import Home from "@/pages/Home";
import PortalMagicLogin from "@/pages/portal/PortalMagicLogin";

// Tenant/merchant-facing routes only — platform-wide administration lives in
// ui/platform-admin. See ui/tenant-portal/ROUTES.md for the full triage,
// including pages flagged as likely duplicates of the canonical /portal/*
// implementations (kept reachable, not deleted, pending a decision).
const TrackOrder = lazy(() => import("@/pages/TrackOrder"));
const EvidencePortal = lazy(() => import("@/pages/EvidencePortal"));
const SlaExtensionResponse = lazy(() => import("@/pages/SlaExtensionResponse"));

const PortalDashboard = lazy(() => import("@/pages/portal/PortalDashboard"));
const SsoCallback = lazy(() => import("@/pages/portal/SsoCallback"));
const PortalProducts = lazy(() => import("@/pages/portal/PortalProducts"));
const PortalOrders = lazy(() => import("@/pages/portal/PortalOrders"));
const PortalInvoices = lazy(() => import("@/pages/portal/PortalInvoices"));
const PortalSettings = lazy(() => import("@/pages/portal/PortalSettings"));
const PortalConversations = lazy(() => import("@/pages/portal/PortalConversations"));
const PortalPayments = lazy(() => import("@/pages/portal/PortalPayments"));
const PortalWallet = lazy(() => import("@/pages/portal/PortalWallet"));
const OnboardingWizard = lazy(() => import("@/pages/portal/OnboardingWizard"));
const MerchantAnalytics = lazy(() => import("@/pages/portal/MerchantAnalytics"));
const PortalBroadcasts = lazy(() => import("@/pages/portal/PortalBroadcasts"));

const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Products = lazy(() => import("@/pages/Products"));
const MenuBuilder = lazy(() => import("@/pages/MenuBuilder"));
const InventorySync = lazy(() => import("@/pages/InventorySync"));
const ProductImageCollector = lazy(() => import("@/pages/ProductImageCollector"));
const VisualInventory = lazy(() => import("@/pages/VisualInventory"));
const FmcgTaxonomy = lazy(() => import("@/pages/FmcgTaxonomy"));
const MarketplacePortal = lazy(() => import("@/pages/MarketplacePortal"));
const B2BPortal = lazy(() => import("@/pages/B2BPortal"));
const ServiceCommercePage = lazy(() => import("@/pages/ServiceCommercePage"));
const MedusaIntegration = lazy(() => import("@/pages/MedusaIntegration"));
const MedusaOnboarding = lazy(() => import("@/pages/MedusaOnboarding"));
const OdooMedusaBridge = lazy(() => import("@/pages/OdooMedusaBridge"));
const SupplierDirectory = lazy(() => import("@/pages/SupplierDirectory"));
const ProcurementHub = lazy(() => import("@/pages/ProcurementHub"));
const CreditAccounts = lazy(() => import("@/pages/CreditAccounts"));
const Conversations = lazy(() => import("@/pages/Conversations"));
const MultiChannelHub = lazy(() => import("@/pages/MultiChannelHub"));
const BroadcastCampaigns = lazy(() => import("@/pages/BroadcastCampaigns"));
const TemplateLibrary = lazy(() => import("@/pages/TemplateLibrary"));
const WaTemplates = lazy(() => import("@/pages/WaTemplates"));
const OperatorTemplates = lazy(() => import("@/pages/OperatorTemplates"));
const TemplateVersions = lazy(() => import("@/pages/TemplateVersions"));
const WhatsAppMediaPortal = lazy(() => import("@/pages/WhatsAppMediaPortal"));
const Orders = lazy(() => import("@/pages/Orders"));
const OrderTimeline = lazy(() => import("@/pages/OrderTimeline"));
const DisputeManagement = lazy(() => import("@/pages/DisputeManagement"));
const Payments = lazy(() => import("@/pages/Payments"));
const EscrowDashboard = lazy(() => import("@/pages/EscrowDashboard"));
const RevenueDashboard = lazy(() => import("@/pages/RevenueDashboard"));
const Invoices = lazy(() => import("@/pages/Invoices"));
const MobileMoneyPortal = lazy(() => import("@/pages/MobileMoneyPortal"));
const AgentConsole = lazy(() => import("@/pages/AgentConsole"));
const AgentArchitecture = lazy(() => import("@/pages/AgentArchitecture"));
const NLPSimulator = lazy(() => import("@/pages/NLPSimulator"));
const AnalyticsBIDashboard = lazy(() => import("@/pages/AnalyticsBIDashboard"));
const TenantAnalytics = lazy(() => import("@/pages/TenantAnalytics"));
const IntegrationHub = lazy(() => import("@/pages/IntegrationHub"));
const TwentyCRM = lazy(() => import("@/pages/TwentyCRM"));
const OdooERP = lazy(() => import("@/pages/OdooERP"));
const WaMenuBuilder = lazy(() => import("@/pages/WaMenuBuilder"));
const TenantOnboardingWizard = lazy(() => import("@/pages/TenantOnboardingWizard"));
const OnboardingCopilot = lazy(() => import("@/pages/OnboardingCopilot"));
const IntegrationsSettings = lazy(() => import("@/pages/IntegrationsSettings"));
const ProviderSettings = lazy(() => import("@/pages/ProviderSettings"));
const TenantSettings = lazy(() => import("@/pages/TenantSettings"));

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
        <Route path="/track/:token" component={TrackOrder} />
        <Route path="/evidence/:token" component={EvidencePortal} />
        <Route path="/sla-extension/:token" component={SlaExtensionResponse} />

        <Route path="/portal" component={PortalDashboard} />
        {/* Magic-link login: matches the /portal/login?token=... links generated by server/routers/tenantInvite.ts */}
        <Route path="/portal/login" component={PortalMagicLogin} />
        <Route path="/portal/magic-login" component={PortalMagicLogin} />
        <Route path="/portal/sso-callback" component={SsoCallback} />
        <Route path="/portal/products" component={PortalProducts} />
        <Route path="/portal/orders" component={PortalOrders} />
        <Route path="/portal/invoices" component={PortalInvoices} />
        <Route path="/portal/settings" component={PortalSettings} />
        <Route path="/portal/conversations" component={PortalConversations} />
        <Route path="/portal/payments" component={PortalPayments} />
        <Route path="/portal/wallet" component={PortalWallet} />
        <Route
          path="/portal/setup"
          component={() => <OnboardingWizard onComplete={() => { window.location.href = `${BASE_PATH}/portal`; }} />}
        />
        <Route path="/portal/analytics" component={MerchantAnalytics} />
        <Route path="/portal/broadcasts" component={PortalBroadcasts} />

        <Route path="/dashboard" component={Dashboard} />
        <Route path="/products" component={Products} />
        <Route path="/menu-builder" component={MenuBuilder} />
        <Route path="/inventory" component={InventorySync} />
        <Route path="/product-images" component={ProductImageCollector} />
        <Route path="/visual-inventory" component={VisualInventory} />
        <Route path="/fmcg-taxonomy" component={FmcgTaxonomy} />
        <Route path="/marketplace" component={MarketplacePortal} />
        <Route path="/b2b" component={B2BPortal} />
        <Route path="/service-commerce" component={ServiceCommercePage} />
        <Route path="/medusa" component={MedusaIntegration} />
        <Route path="/medusa-onboarding" component={MedusaOnboarding} />
        <Route path="/odoo-medusa-bridge" component={OdooMedusaBridge} />
        <Route path="/suppliers" component={SupplierDirectory} />
        <Route path="/procurement" component={ProcurementHub} />
        <Route path="/credit-accounts" component={CreditAccounts} />
        <Route path="/conversations" component={Conversations} />
        <Route path="/multi-channel" component={MultiChannelHub} />
        <Route path="/broadcast" component={BroadcastCampaigns} />
        <Route path="/templates" component={TemplateLibrary} />
        <Route path="/wa-templates" component={WaTemplates} />
        <Route path="/operator-templates" component={OperatorTemplates} />
        <Route path="/template-versions" component={TemplateVersions} />
        <Route path="/whatsapp-media" component={WhatsAppMediaPortal} />
        <Route path="/orders" component={Orders} />
        <Route path="/orders/:orderNumber" component={OrderTimeline} />
        <Route path="/disputes" component={DisputeManagement} />
        <Route path="/payments" component={Payments} />
        <Route path="/escrow" component={EscrowDashboard} />
        <Route path="/revenue" component={RevenueDashboard} />
        <Route path="/invoices" component={Invoices} />
        <Route path="/mobile-money" component={MobileMoneyPortal} />
        <Route path="/agent" component={AgentConsole} />
        <Route path="/agent-architecture" component={AgentArchitecture} />
        <Route path="/nlp-simulator" component={NLPSimulator} />
        <Route path="/analytics-bi" component={AnalyticsBIDashboard} />
        <Route path="/tenant-analytics" component={TenantAnalytics} />
        <Route path="/integrations" component={IntegrationHub} />
        <Route path="/twenty-crm" component={TwentyCRM} />
        <Route path="/odoo-erp" component={OdooERP} />
        <Route path="/wa-menu-builder" component={WaMenuBuilder} />
        <Route path="/onboarding-wizard" component={TenantOnboardingWizard} />
        <Route path="/onboarding-copilot" component={OnboardingCopilot} />
        <Route path="/integration-settings" component={IntegrationsSettings} />
        <Route path="/provider-settings" component={ProviderSettings} />
        <Route path="/tenant-settings" component={TenantSettings} />

        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

// Public/token-based routes render without the auth wall: customers,
// suppliers, and dispute counterparties reach these via a shared link and
// are never expected to have a WhatsApp Commerce account. The server
// enforces access via the token itself, not session auth.
const PUBLIC_PREFIXES = ["/track/", "/evidence/", "/sla-extension/"];

function App() {
  const path =
    typeof window !== "undefined"
      ? window.location.pathname.slice(BASE_PATH.length) || "/"
      : "/";
  const isPublicPath = path === "/" || PUBLIC_PREFIXES.some(p => path.startsWith(p));

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <WouterRouter base={BASE_PATH}>
            {isPublicPath ? (
              <Router />
            ) : (
              <AuthGate allow={() => true}>
                <Router />
              </AuthGate>
            )}
          </WouterRouter>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
