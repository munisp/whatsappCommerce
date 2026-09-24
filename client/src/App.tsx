import { lazy, Suspense, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, useLocation, useParams } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import PortalMagicLogin from "@/pages/portal/PortalMagicLogin";

// Route-level code splitting: every non-essential page is a lazy chunk so
// the initial bundle only carries the shell + dashboard/login. Heavy routes
// (LiveLogisticsMap/maplibre, OnboardingCopilot, admin/analytics pages) load on demand.
const Products = lazy(() => import("./pages/Products"));
const Conversations = lazy(() => import("./pages/Conversations"));
const Orders = lazy(() => import("./pages/Orders"));
const CodBoard = lazy(() => import("./pages/CodBoard"));
// === W27 delivery-loyalty-reviews (Coder E) ===
const DeliveryHub = lazy(() => import("./pages/DeliveryHub"));
const LoyaltyConfig = lazy(() => import("./pages/LoyaltyConfig"));
const ReviewsModeration = lazy(() => import("./pages/ReviewsModeration"));
// === END W27 ===
const OrderTimeline = lazy(() => import("./pages/OrderTimeline"));
const Payments = lazy(() => import("./pages/Payments"));
const TwentyCRM = lazy(() => import("./pages/TwentyCRM"));
const Crm = lazy(() => import("./pages/Crm"));
const OdooHub = lazy(() => import("./pages/OdooHub"));
const WhatsAppMenuHub = lazy(() => import("./pages/WhatsAppMenuHub"));
const IntegrationHub = lazy(() => import("./pages/IntegrationHub"));
const TemplateLibrary = lazy(() => import("./pages/TemplateLibrary"));
const CredentialWizard = lazy(() => import("./pages/CredentialWizard"));
const TemplateVersions = lazy(() => import("./pages/TemplateVersions"));
const BroadcastCampaigns = lazy(() => import("./pages/BroadcastCampaigns"));
const Journeys = lazy(() => import("./pages/Journeys"));
const Consents = lazy(() => import("./pages/Consents"));
const InventoryHub = lazy(() => import("./pages/InventoryHub"));
const TrackOrder = lazy(() => import("./pages/TrackOrder"));
const Invoices = lazy(() => import("./pages/Invoices"));
const PortalDashboard = lazy(() => import("./pages/portal/PortalDashboard"));
const PortalProducts = lazy(() => import("./pages/portal/PortalProducts"));
const PortalOrders = lazy(() => import("./pages/portal/PortalOrders"));
const PortalInvoices = lazy(() => import("./pages/portal/PortalInvoices"));
const PortalSettings = lazy(() => import("./pages/portal/PortalSettings"));
const PortalConversations = lazy(() => import("./pages/portal/PortalConversations"));
const PortalPayments = lazy(() => import("./pages/portal/PortalPayments"));
// === W27 bookkeeping ===
const PortalBookkeeping = lazy(() => import("./pages/portal/PortalBookkeeping"));
// === W28 odoo-sync (Coder A) ===
const PortalOdooSettings = lazy(() => import("./pages/portal/PortalOdooSettings"));
// === END W28 odoo-sync ===
const DeployChecklist = lazy(() => import("./pages/DeployChecklist"));
const ReconciliationSim = lazy(() => import("./pages/ReconciliationSim"));
const SsoCallback = lazy(() => import("./pages/portal/SsoCallback"));
const DisputeManagement = lazy(() => import("./pages/DisputeManagement"));
const MerchantWallet = lazy(() => import("./pages/portal/MerchantWallet"));
// === W27 savings-insurance-vouchers (Coder G) ===
const SavingsCircles = lazy(() => import("./pages/SavingsCircles"));
const InsurancePolicies = lazy(() => import("./pages/InsurancePolicies"));
const VoucherPrograms = lazy(() => import("./pages/VoucherPrograms"));
const OnboardingWizard = lazy(() => import("./pages/portal/OnboardingWizard"));
const EvidencePortal = lazy(() => import("./pages/EvidencePortal"));
const MerchantAnalytics = lazy(() => import("./pages/portal/MerchantAnalytics"));
const PortalBroadcasts = lazy(() => import("./pages/portal/PortalBroadcasts"));
const AuditLog = lazy(() => import("./pages/AuditLog"));
const TenantOnboardingWizard = lazy(() => import("./pages/TenantOnboardingWizard"));
const IntegrationsSettings = lazy(() => import("./pages/IntegrationsSettings"));
const TenantSettings = lazy(() => import("./pages/TenantSettings"));
const DiscoverNearby = lazy(() => import("./pages/DiscoverNearby"));
// === W27 storefront-i18n ===
const Shop = lazy(() => import("./pages/Shop"));
const StorefrontSettings = lazy(() => import("./pages/StorefrontSettings"));
const MerchantGeoSettings = lazy(() => import("./pages/MerchantGeoSettings"));
// === W28 medusa-storefront (Coder B) ===
const MedusaStorefrontSettings = lazy(() => import("./pages/MedusaStorefrontSettings"));
// === END W28 medusa-storefront ===
const WaTemplates = lazy(() => import("./pages/WaTemplates"));
const SupplierDirectory = lazy(() => import("./pages/SupplierDirectory"));
const ProcurementHub = lazy(() => import("./pages/ProcurementHub"));
const CreditAccounts = lazy(() => import("./pages/CreditAccounts"));
// === W27 credit ===
const CreditDashboard = lazy(() => import("./pages/CreditDashboard"));
const ManufacturerCredit = lazy(() => import("./pages/ManufacturerCredit"));
const SupplierApprovals = lazy(() => import("./pages/SupplierApprovals"));
const WhatsAppMediaPortal = lazy(() => import("./pages/WhatsAppMediaPortal"));
const SlaExtensionResponse = lazy(() => import("./pages/SlaExtensionResponse"));
const OperatorTemplates = lazy(() => import("./pages/OperatorTemplates"));
const SalesChannelsHub = lazy(() => import("./pages/SalesChannelsHub"));
const MultiChannelHub = lazy(() => import("./pages/MultiChannelHub"));
const MobileMoneyPortal = lazy(() => import("./pages/MobileMoneyPortal"));
const AnalyticsBIDashboard = lazy(() => import("./pages/AnalyticsBIDashboard"));
const CompliancePortal = lazy(() => import("./pages/CompliancePortal"));
const MedusaHub = lazy(() => import("./pages/MedusaHub"));
const IntegrationHealth = lazy(() => import("./pages/IntegrationHealth"));
const LabelStudioPipe = lazy(() => import("./pages/LabelStudioPipe"));
const HermesDashboard = lazy(() => import("./pages/HermesDashboard"));
const PhoneAuthPage = lazy(() => import("./pages/PhoneAuthPage"));
const WhatsAppProfilePage = lazy(() => import("./pages/WhatsAppProfilePage"));
const AdminPortal = lazy(() => import("./pages/AdminPortal"));
const OnboardingCopilot = lazy(() => import("./pages/OnboardingCopilot"));
// === W27 catalog-ai ===
const CatalogAIDrafts = lazy(() => import("./pages/CatalogAIDrafts"));
// === W27 Coder F: B2B wholesale marketplace + group buying ===
const WholesaleMarketplace = lazy(() => import("./pages/WholesaleMarketplace"));
const GroupDeals = lazy(() => import("./pages/GroupDeals"));
// === END W27 Coder F ===

// Client-side redirect for retired routes, now folded into a consolidated
// hub page (see WhatsAppMenuHub/InventoryHub/SalesChannelsHub/MedusaHub/
// OdooHub) — kept as a redirect rather than deleted outright in case
// anything has the old path bookmarked.
function RouteRedirect({ to }: { to: string }) {
  const [, navigate] = useLocation();
  useEffect(() => { navigate(to, { replace: true }); }, [to, navigate]);
  return null;
}

// QA follow-up: ui/platform-admin's own ROUTES.md documents a deliberate
// split of this monolith's admin-only routes into that dedicated app (one
// blanket role==="admin" AuthGate instead of this app's per-page guards),
// but never redirected the originals here — so every admin page below kept
// answering at its old, less-consistently-guarded legacy path too. This is
// the follow-up .qa/defects.md already flagged ("hiding them from the
// merchant nav is a follow-up"): finish the migration by redirecting each
// route ui/platform-admin/ROUTES.md classified as admin-only, rather than
// leaving two live copies. Routes intentionally left alone: pages already
// confirmed tenant self-service this session (/phone-auth,
// /whatsapp-profile, /compliance, /deploy-checklist, /audit-log, /setup —
// the last is genuinely per-tenant integration credentials, not a platform
// tool, despite the ambiguous placement ROUTES.md itself flagged).
function AdminRouteRedirect({ to }: { to: string }) {
  return <RouteRedirect to={`/platform-admin${to}`} />;
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
      <Route path="/" component={Home} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/tenants" component={() => <AdminRouteRedirect to="/tenants" />} />
      <Route path="/tenants/:id" component={() => {
        const { id } = useParams<{ id: string }>();
        return <AdminRouteRedirect to={`/tenants/${id}`} />;
      }} />
      <Route path="/products" component={Products} />
      <Route path="/conversations" component={Conversations} />
      <Route path="/orders" component={Orders} />
      <Route path="/cod" component={CodBoard} />
      {/* === W27 delivery-loyalty-reviews (Coder E) === */}
      <Route path="/delivery" component={DeliveryHub} />
      <Route path="/loyalty" component={LoyaltyConfig} />
      <Route path="/reviews" component={ReviewsModeration} />
      {/* === END W27 === */}
      <Route path="/orders/:orderNumber" component={OrderTimeline} />
      <Route path="/track/:token" component={TrackOrder} />
      <Route path="/payments" component={Payments} />
      <Route path="/health" component={() => <AdminRouteRedirect to="/health" />} />
      <Route path="/twenty-crm" component={TwentyCRM} />
      <Route path="/crm" component={Crm} />
      <Route path="/odoo-erp" component={OdooHub} />
      <Route path="/menu-builder" component={WhatsAppMenuHub} />
      <Route path="/integrations" component={IntegrationHub} />
      <Route path="/templates" component={TemplateLibrary} />
      <Route path="/tenant-menus" component={() => <AdminRouteRedirect to="/tenant-menus" />} />
      <Route path="/setup" component={CredentialWizard} />
      <Route path="/template-versions" component={TemplateVersions} />
      <Route path="/broadcast" component={BroadcastCampaigns} />
      <Route path="/journeys" component={Journeys} />
      <Route path="/consents" component={Consents} />
      <Route path="/inventory" component={InventoryHub} />
      <Route path="/onboarding" component={() => <AdminRouteRedirect to="/onboarding" />} />
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
          {/* === W27 bookkeeping === */}
          <Route path="/portal/bookkeeping" component={PortalBookkeeping} />
          {/* === W28 odoo-sync (Coder A) === */}
          <Route path="/portal/odoo" component={PortalOdooSettings} />
          {/* === END W28 odoo-sync === */}
          <Route path="/deploy-checklist" component={DeployChecklist} />
          <Route path="/ml-ops" component={() => <AdminRouteRedirect to="/ml-ops" />} />
          <Route path="/reconciliation" component={ReconciliationSim} />
          <Route path="/alert-rules" component={() => <AdminRouteRedirect to="/alert-rules" />} />
          <Route path="/portal/sso-callback" component={SsoCallback} />
          <Route path="/sso-users" component={() => <AdminRouteRedirect to="/sso-users" />} />
          <Route path="/cogs-disputes" component={() => <AdminRouteRedirect to="/cogs-disputes" />} />
          <Route path="/revenue" component={() => <AdminRouteRedirect to="/revenue" />} />
          <Route path="/escrow" component={() => <AdminRouteRedirect to="/escrow" />} />
          <Route path="/logistics" component={() => <AdminRouteRedirect to="/logistics" />} />
          <Route path="/disputes" component={DisputeManagement} />
          <Route path="/portal/wallet" component={MerchantWallet} />
          <Route path="/portal/setup" component={() => <OnboardingWizard onComplete={() => { window.location.href = "/portal"; }} />} />
          <Route path="/portal/analytics" component={MerchantAnalytics} />
          <Route path="/portal/broadcasts" component={PortalBroadcasts} />
          <Route path="/audit-log" component={AuditLog} />
          <Route path="/wa-menu-builder" component={() => <RouteRedirect to="/menu-builder" />} />
          <Route path="/onboarding-wizard" component={TenantOnboardingWizard} />
          <Route path="/integration-settings" component={IntegrationsSettings} />
          <Route path="/tenant-settings" component={TenantSettings} />
        <Route path="/discover" component={DiscoverNearby} />
        {/* === W27 storefront-i18n === */}
        <Route path="/shop/:slug" component={Shop} />
        <Route path="/settings/storefront" component={StorefrontSettings} />
        <Route path="/settings/discovery" component={MerchantGeoSettings} />
        {/* === W28 medusa-storefront (Coder B) === */}
        <Route path="/settings/medusa-storefront" component={MedusaStorefrontSettings} />
        {/* === END W28 medusa-storefront === */}
          <Route path="/logistics-map" component={() => <AdminRouteRedirect to="/logistics-map" />} />
          <Route path="/system-health" component={() => <AdminRouteRedirect to="/system-health" />} />
          <Route path="/audit-logs" component={() => <AdminRouteRedirect to="/audit-logs" />} />
          {/* === W27 savings-insurance-vouchers (Coder G) === */}
          <Route path="/savings-circles" component={SavingsCircles} />
          <Route path="/insurance" component={InsurancePolicies} />
          <Route path="/vouchers" component={VoucherPrograms} />
          <Route path="/whatsapp-media" component={WhatsAppMediaPortal} />
          <Route path="/operator-templates" component={OperatorTemplates} />
          <Route path="/evidence/:token" component={EvidencePortal} />
          <Route path="/sla-extension/:token" component={SlaExtensionResponse} />
          <Route path="/b2b" component={() => <RouteRedirect to="/sales-channels" />} />
          <Route path="/multi-channel" component={MultiChannelHub} />
          <Route path="/marketplace" component={() => <RouteRedirect to="/sales-channels" />} />
          <Route path="/sales-channels" component={SalesChannelsHub} />
          <Route path="/mobile-money" component={MobileMoneyPortal} />
          <Route path="/service-commerce" component={() => <RouteRedirect to="/sales-channels" />} />
          <Route path="/analytics-bi" component={AnalyticsBIDashboard} />
          <Route path="/compliance" component={CompliancePortal} />
          <Route path="/soc2" component={() => <AdminRouteRedirect to="/soc2" />} />
          <Route path="/medusa" component={MedusaHub} />
          <Route path="/webhook-dlq" component={() => <AdminRouteRedirect to="/webhook-dlq" />} />
          <Route path="/visual-inventory" component={() => <RouteRedirect to="/inventory" />} />
          <Route path="/medusa-onboarding" component={() => <RouteRedirect to="/medusa" />} />
          <Route path="/odoo-medusa-bridge" component={() => <RouteRedirect to="/odoo-erp" />} />
          <Route path="/label-studio" component={LabelStudioPipe} />
          <Route path="/fmcg-taxonomy" component={() => <RouteRedirect to="/inventory" />} />
          <Route path="/scan-stats" component={() => <AdminRouteRedirect to="/scan-stats" />} />
          <Route path="/product-images" component={() => <RouteRedirect to="/inventory" />} />
          <Route path="/tenant-analytics" component={() => <AdminRouteRedirect to="/tenant-analytics" />} />
          <Route path="/hermes" component={HermesDashboard} />
          <Route path="/phone-auth" component={PhoneAuthPage} />
          <Route path="/whatsapp-profile" component={WhatsAppProfilePage} />
          <Route path="/infra-health" component={() => <AdminRouteRedirect to="/infra-health" />} />
          <Route path="/admin" component={AdminPortal} />
          <Route path="/integration-health" component={IntegrationHealth} />
          <Route path="/unified-onboarding" component={() => <RouteRedirect to="/onboarding" />} />
          <Route path="/wa-templates" component={WaTemplates} />
          <Route path="/suppliers" component={SupplierDirectory} />
          <Route path="/procurement" component={ProcurementHub} />
          <Route path="/credit-accounts" component={CreditAccounts} />
          {/* === W27 credit === */}
          <Route path="/credit" component={CreditDashboard} />
          <Route path="/manufacturer-credit" component={ManufacturerCredit} />
          <Route path="/supplier-approvals" component={SupplierApprovals} />
          <Route path="/onboarding-copilot" component={OnboardingCopilot} />
          {/* === W27 catalog-ai === */}
          <Route path="/catalog-ai-drafts" component={CatalogAIDrafts} />
          {/* === W27 Coder F === */}
          <Route path="/wholesale" component={WholesaleMarketplace} />
          <Route path="/group-deals" component={GroupDeals} />
          {/* === END W27 Coder F === */}
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
