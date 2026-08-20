import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Router as WouterRouter, Switch, useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";

// Derived from BASE_URL (set directly from vite.config.ts's `base`, which
// only depends on the build `command`) rather than PROD/MODE — those follow
// Vite's `mode`, which a stray NODE_ENV in a loaded .env file can flip to
// "development" even during a real `vite build` (see .dockerignore).
const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");
import ErrorBoundary from "@/components/ErrorBoundary";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthGate } from "@ui-shared/AuthGate";
import Home from "@/pages/Home";
import PortalMagicLogin from "@/pages/portal/PortalMagicLogin";

// Tenant/merchant-facing routes only — platform-wide administration lives in
// ui/platform-admin. See ui/tenant-portal/ROUTES.md for the original triage;
// the "likely-duplicate pairs" it flagged as a follow-up decision have since
// been resolved (see the redirects in the route table below for which page
// won and why).
const TrackOrder = lazy(() => import("@/pages/TrackOrder"));
const EvidencePortal = lazy(() => import("@/pages/EvidencePortal"));
const SlaExtensionResponse = lazy(() => import("@/pages/SlaExtensionResponse"));

const PortalDashboard = lazy(() => import("@/pages/portal/PortalDashboard"));
const SsoCallback = lazy(() => import("@/pages/portal/SsoCallback"));
const MerchantWallet = lazy(() => import("@/pages/portal/MerchantWallet"));
const OnboardingWizard = lazy(() => import("@/pages/portal/OnboardingWizard"));
const MerchantAnalytics = lazy(() => import("@/pages/portal/MerchantAnalytics"));

const Products = lazy(() => import("@/pages/Products"));
const WhatsAppMenuHub = lazy(() => import("@/pages/WhatsAppMenuHub"));
const InventoryHub = lazy(() => import("@/pages/InventoryHub"));
const SalesChannelsHub = lazy(() => import("@/pages/SalesChannelsHub"));
const MedusaHub = lazy(() => import("@/pages/MedusaHub"));
const OdooHub = lazy(() => import("@/pages/OdooHub"));
const SupplierDirectory = lazy(() => import("@/pages/SupplierDirectory"));
const Crm = lazy(() => import("@/pages/Crm"));
const Journeys = lazy(() => import("@/pages/Journeys"));
const Consents = lazy(() => import("@/pages/Consents"));
const CodBoard = lazy(() => import("@/pages/CodBoard"));
const ManufacturerCredit = lazy(() => import("@/pages/ManufacturerCredit"));
const ProcurementHub = lazy(() => import("@/pages/ProcurementHub"));
const CreditAccounts = lazy(() => import("@/pages/CreditAccounts"));
const SupplierApprovals = lazy(() => import("@/pages/SupplierApprovals"));
const IntegrationHealth = lazy(() => import("@/pages/IntegrationHealth"));
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
const AnalyticsBIDashboard = lazy(() => import("@/pages/AnalyticsBIDashboard"));
const IntegrationHub = lazy(() => import("@/pages/IntegrationHub"));
const TwentyCRM = lazy(() => import("@/pages/TwentyCRM"));
const TenantOnboardingWizard = lazy(() => import("@/pages/TenantOnboardingWizard"));
const OnboardingCopilot = lazy(() => import("@/pages/OnboardingCopilot"));
const IntegrationsSettings = lazy(() => import("@/pages/IntegrationsSettings"));
const TenantSettings = lazy(() => import("@/pages/TenantSettings"));
const DiscoverNearby = lazy(() => import("@/pages/DiscoverNearby"));
const MerchantGeoSettings = lazy(() => import("@/pages/MerchantGeoSettings"));

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
        <Route path="/portal/wallet" component={MerchantWallet} />
        <Route
          path="/portal/setup"
          component={() => <OnboardingWizard onComplete={() => { window.location.href = `${BASE_PATH}/portal`; }} />}
        />
        <Route path="/portal/analytics" component={MerchantAnalytics} />

        {/* These /portal/* pages were a deliberately minimal, view-only MVP
            duplicating the richer pages below (which have real editing:
            CSV import, invoice send/markPaid, delivery receipts, broadcast
            A/B testing — see the tenant-portal cleanup pass). Redirect
            rather than remove outright, in case anything has them bookmarked. */}
        <Route path="/portal/products" component={() => <RouteRedirect to="/products" />} />
        <Route path="/portal/orders" component={() => <RouteRedirect to="/orders" />} />
        <Route path="/portal/invoices" component={() => <RouteRedirect to="/invoices" />} />
        <Route path="/portal/settings" component={() => <RouteRedirect to="/tenant-settings" />} />
        <Route path="/portal/conversations" component={() => <RouteRedirect to="/conversations" />} />
        <Route path="/portal/payments" component={() => <RouteRedirect to="/payments" />} />
        <Route path="/portal/broadcasts" component={() => <RouteRedirect to="/broadcast" />} />

        <Route path="/dashboard" component={() => <RouteRedirect to="/portal" />} />
        {/* TenantAnalytics.tsx has a platform-wide "pick any tenant" selector
            powered by tenant.list (adminProcedure) — it's a platform-admin
            tool that was misplaced here, not a tenant's own analytics.
            /portal/analytics (MerchantAnalytics, above) is the real one. */}
        <Route path="/tenant-analytics" component={() => <RouteRedirect to="/portal/analytics" />} />
        <Route path="/products" component={Products} />
        <Route path="/menu-builder" component={WhatsAppMenuHub} />
        <Route path="/inventory" component={InventoryHub} />
        <Route path="/product-images" component={() => <RouteRedirect to="/inventory" />} />
        <Route path="/visual-inventory" component={() => <RouteRedirect to="/inventory" />} />
        <Route path="/fmcg-taxonomy" component={() => <RouteRedirect to="/inventory" />} />
        <Route path="/marketplace" component={() => <RouteRedirect to="/sales-channels" />} />
        <Route path="/b2b" component={() => <RouteRedirect to="/sales-channels" />} />
        <Route path="/service-commerce" component={() => <RouteRedirect to="/sales-channels" />} />
        <Route path="/sales-channels" component={SalesChannelsHub} />
        <Route path="/medusa" component={MedusaHub} />
        <Route path="/medusa-onboarding" component={() => <RouteRedirect to="/medusa" />} />
        <Route path="/odoo-medusa-bridge" component={() => <RouteRedirect to="/odoo-erp" />} />
        <Route path="/suppliers" component={SupplierDirectory} />
        <Route path="/crm" component={Crm} />
        <Route path="/journeys" component={Journeys} />
        <Route path="/consents" component={Consents} />
        <Route path="/cod" component={CodBoard} />
        <Route path="/manufacturer-credit" component={ManufacturerCredit} />
        <Route path="/procurement" component={ProcurementHub} />
        <Route path="/credit-accounts" component={CreditAccounts} />
        <Route path="/supplier-approvals" component={SupplierApprovals} />
        <Route path="/integration-health" component={IntegrationHealth} />
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
        <Route path="/analytics-bi" component={AnalyticsBIDashboard} />
        <Route path="/integrations" component={IntegrationHub} />
        <Route path="/twenty-crm" component={TwentyCRM} />
        <Route path="/odoo-erp" component={OdooHub} />
        <Route path="/wa-menu-builder" component={() => <RouteRedirect to="/menu-builder" />} />
        <Route path="/onboarding-wizard" component={TenantOnboardingWizard} />
        <Route path="/onboarding-copilot" component={OnboardingCopilot} />
        <Route path="/integration-settings" component={IntegrationsSettings} />
        <Route path="/tenant-settings" component={TenantSettings} />
        <Route path="/discover" component={DiscoverNearby} />
        <Route path="/settings/discovery" component={MerchantGeoSettings} />

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

const ONBOARDING_PATH = "/onboarding-wizard";

// Generic client-side redirect for retired routes — /dashboard
// (client/src/pages/Dashboard.tsx showed a platform-wide "Active Tenants"
// stat plus two charts hardcoded to static demo arrays, never real for any
// tenant) and the /portal/* pages that duplicated a richer page elsewhere
// (see the route table above for which page replaced which).
function RouteRedirect({ to }: { to: string }) {
  const [, navigate] = useLocation();
  useEffect(() => { navigate(to, { replace: true }); }, [to, navigate]);
  return null;
}

// A freshly-registered user has no tenant yet (users.tenantId is null until
// onboarding.start creates one for them). Left alone, every tenant-scoped
// page here would just silently show empty/wrong data instead of routing
// them to the one flow that actually creates their tenant. Platform admins
// are tenant-less by design, so they're exempt.
function OnboardingGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [location, navigate] = useLocation();
  const needsOnboarding = !!user && user.role !== "admin" && !user.tenantId;

  useEffect(() => {
    if (needsOnboarding && location !== ONBOARDING_PATH) {
      navigate(ONBOARDING_PATH);
    }
  }, [needsOnboarding, location, navigate]);

  if (needsOnboarding && location !== ONBOARDING_PATH) return null;
  return <>{children}</>;
}

// Must run INSIDE <WouterRouter> and use its useLocation() (not a plain
// window.location.pathname read) so this re-evaluates on every client-side
// navigation. A plain read only reflects the path at App()'s own mount —
// clicking a button that calls navigate() (e.g. Home's "Go to Dashboard")
// never re-renders App() itself, so a stale read would keep showing
// whichever branch matched the ORIGINAL page (e.g. "/", public) even after
// wouter has silently swapped the visible route to something protected,
// skipping AuthGate/OnboardingGate entirely.
function AppRoutes() {
  const [location] = useLocation();
  const isPublicPath = location === "/" || PUBLIC_PREFIXES.some(p => location.startsWith(p));

  return isPublicPath ? (
    <Router />
  ) : (
    <AuthGate allow={() => true}>
      <OnboardingGate>
        <Router />
      </OnboardingGate>
    </AuthGate>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <WouterRouter base={BASE_PATH}>
            <AppRoutes />
          </WouterRouter>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
