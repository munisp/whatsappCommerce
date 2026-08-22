import { COOKIE_NAME } from "@shared/const";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, publicProcedure, router } from "./_core/trpc";
import { parse as parseCookieHeader } from "cookie";
import { verifySessionToken } from "./_core/auth";
import { revokeAllUserSessions, revokeSessionJti } from "./_core/sdk";
import { tenantRouter } from "./routers/tenant";
import { tenantConfigRouter } from "./routers/tenantConfig";
import { productRouter } from "./routers/product";
import { conversationRouter } from "./routers/conversation";
import { escalationRouter } from "./routers/escalation";
import { orderRouter } from "./routers/order";
import { paymentRouter } from "./routers/payment";
import { agentRouter } from "./routers/agent";
import { analyticsRouter } from "./routers/analytics";
import { twentyRouter } from "./routers/twenty";
import { odooRouter } from "./routers/odoo";
import { menuRouter } from "./routers/menu";
import { templateRouter } from "./routers/template";
import { templateVersionsRouter } from "./routers/templateVersions";
import { broadcastRouter } from "./routers/broadcast";
import { waTemplatesRouter } from "./routers/waTemplates";
import { ctwaRouter } from "./routers/ctwa";
import { inventoryRouter } from "./routers/inventory";
import { broadcastAbRouter } from "./routers/broadcastAb";
import { journeysRouter } from "./routers/journeys";
import { consentsRouter } from "./routers/consents";
import { onboardingRouter } from "./routers/onboarding";
import { kycRouter } from "./routers/kyc";
import { heartbeatRouter } from "./routers/heartbeat";
import { nlpRouter } from "./routers/nlp";
import { catalogBootstrapRouter } from "./routers/catalogBootstrap";
import { orderCrudRouter } from "./routers/orderCrud";
import { codRouter } from "./routers/cod";
import { promosRouter } from "./routers/promos";
import { customersRouter } from "./routers/customers";
import { crmRouter } from "./routers/crm";
import { invoiceRouter } from "./routers/invoice";
import { paymentGatewayRouter } from "./routers/paymentGateway";
import { tenantPortalRouter } from "./routers/tenantPortal";
import { tenantInviteRouter } from "./routers/tenantInvite";
import { mlOpsRouter, mlAbTestRouter, datasetSnapshotRouter } from "./routers/mlOps";
import { reconciliationRouter } from "./routers/reconciliation";
import { cogsDisputeRouter } from "./routers/cogsDispute";
import { keycloakRouter } from "./routers/keycloak";
import { phoneAuthRouter } from "./routers/phoneAuth";
import { whatsappNotificationsRouter } from "./routers/whatsappNotifications";
import { quickReplyTemplatesRouter } from "./routers/quickReplyTemplates";
import { revenueRouter } from "./routers/revenue";
import { escrowRouter, escrowDisputeRouter, walletRouter, timelineAttachmentRouter } from "./routers/escrow";
import { logisticsRouter } from "./routers/logistics";
import { trackingRouter } from "./routers/tracking";
import { meteringRouter } from "./routers/metering";
import { notificationsRouter } from "./routers/notifications";
import { slaRouter } from "./routers/sla";
import { evidencePortalRouter } from "./routers/evidencePortal";
import { receiptScanRouter } from "./routers/receiptScan";
import { onboardingProgressRouter } from "./routers/onboardingProgress";
import { slaExtensionRouter } from "./routers/slaExtension";

import { medusaOnboardingRouter } from "./routers/medusaOnboarding";
import { odooMedusaBridgeRouter } from "./routers/odooMedusaBridge";
import { visualInventoryRouter } from "./routers/visualInventory";
import { taxonomyRouter } from "./routers/taxonomy";
import { geoRouter } from "./routers/geo";
import { labelStudioRouter } from "./routers/labelStudio";
import { viCorrectionsRouter } from "./routers/viCorrections";
import { productImagesRouter } from "./routers/productImages";
import { alertRulesRouter } from "./routers/alertRules";
import { operatorTemplatesRouter } from "./routers/operatorTemplates";
import { whatsappMediaRouter } from "./routers/whatsappMedia";
import { b2bRouter } from "./routers/b2b";
import { channelsRouter } from "./routers/channels";
import { marketplaceRouter } from "./routers/marketplace";
import { tradeCreditRouter } from "./routers/tradeCredit";
import { mobileMoneyRouter } from "./routers/mobileMoney";
import { serviceCommerceRouter } from "./routers/serviceCommerce";
import { analyticsBIRouter } from "./routers/analyticsBI";
import { complianceRouter } from "./routers/compliance";
import { copilotRouter } from "./routers/copilot";
import { medusaRouter } from "./routers/medusa";
import { webhookDlqRouter } from "./routers/webhookDlq";
import { provisioningRouter } from "./routers/provisioning";
import { fineTuneRouter } from "./routers/fineTune";
import { tenantAnalyticsRouter } from "./routers/tenantAnalytics";
import { deliveryReceiptsRouter } from "./routers/deliveryReceipts";
import { hermesRouter } from "./routers/hermes";
import { aiRouter } from "./routers/ai";
import { apisixRouter } from "./routers/apisix";
import { privacyRouter } from "./routers/privacy";
import { fraudCaseRouter } from "./routers/fraudCase";
import { reportRouter } from "./routers/report";
import { auditRouter } from "./routers/audit";
import { integrationsRouter } from "./routers/integrations";
import { procurementRouter } from "./routers/procurement";
import { creditFacilitiesRouter } from "./routers/creditFacilities";
import { manufacturerProgramsRouter } from "./routers/manufacturerPrograms";
import { creditRepayRouter } from "./routers/creditRepay";
import { onboardingCopilotRouter } from "./routers/onboardingCopilot";
import { membershipRouter } from "./routers/membership";
import { erpProvisionRouter } from "./routers/erpProvision";
import { embeddedSignupRouter } from "./routers/embeddedSignup";
import { shopifyIntegrationRouter } from "./routers/shopifyIntegration";
// === W27 bookkeeping ===
import { bookkeepingRouter } from "./routers/bookkeeping";
// === W27 savings-insurance-vouchers (Coder G) ===
import { insuranceRouter, stokvelRouter, vouchersRouter } from "./routers/savings";
export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(async ({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      // W12 session hardening: revoke the current token's jti so it cannot
      // be replayed even before its 12h expiry.
      try {
        const cookies = parseCookieHeader(ctx.req.headers.cookie ?? "");
        const token = cookies["wa_session"] ?? cookies["session"];
        const payload = token ? verifySessionToken(token) : null;
        if (payload?.jti) {
          await revokeSessionJti(
            payload.jti,
            payload.uid ?? null,
            new Date((payload.exp ?? Math.floor(Date.now() / 1000)) * 1000),
          );
        }
      } catch (err) {
        // Logout must never fail because revocation storage is unavailable.
        console.warn("[auth.logout] session revocation failed:", (err as Error)?.message);
      }
      // Bug: this only ever cleared the legacy "app_session_id" cookie
      // (COOKIE_NAME) — a holdover from the pre-Keycloak "Manus" auth system.
      // The app has authenticated via the "wa_session" cookie since the
      // Keycloak migration (see _core/oauth.ts), which this never touched —
      // so sign-out cleared a cookie nobody has, leaving the real session
      // cookie live. That's the ONLY reason startLogout()'s Keycloak
      // redirect ever looked like "sign out doesn't work": the SSO session
      // ended correctly, but this app's own cookie silently kept the user
      // signed in on the very next request. Clear both — "wa_session" for
      // every current session, COOKIE_NAME for any pre-migration holdout.
      ctx.res.clearCookie("wa_session", { ...cookieOptions, maxAge: -1 });
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
    /** W12: admin kill-switch — revoke ALL sessions for a user. */
    revokeUserSessions: adminProcedure
      .input(z.object({ userId: z.union([z.string().min(1), z.number()]) }))
      .mutation(async ({ input }) => {
        await revokeAllUserSessions(input.userId);
        return { success: true } as const;
      }),
  }),
  membership: membershipRouter,
  tenant: tenantRouter,
  tenantConfig: tenantConfigRouter,
  product: productRouter,
  conversation: conversationRouter,
  escalation: escalationRouter,
  order: orderRouter,
  payment: paymentRouter,
  agent: agentRouter,
  analytics: analyticsRouter,
  twenty: twentyRouter,
  odoo: odooRouter,
  menu: menuRouter,
  template: templateRouter,
  templateVersions: templateVersionsRouter,
  broadcast: broadcastRouter,
  waTemplates: waTemplatesRouter,
  ctwa: ctwaRouter,
  inventory: inventoryRouter,
  broadcastAb: broadcastAbRouter,
  journeys: journeysRouter,
  consents: consentsRouter,
  onboarding: onboardingRouter,
  kyc: kycRouter,
  heartbeat: heartbeatRouter,
  nlp: nlpRouter,
  catalogBootstrap: catalogBootstrapRouter,
  orderCrud: orderCrudRouter,
  cod: codRouter,
  promos: promosRouter,
  customers: customersRouter,
  crm: crmRouter,
  invoice: invoiceRouter,
  paymentGateway: paymentGatewayRouter,
  tenantPortal: tenantPortalRouter,
  tenantInvite: tenantInviteRouter,
  mlOps: mlOpsRouter,
  mlAbTest: mlAbTestRouter,
  datasetSnapshot: datasetSnapshotRouter,
  reconciliation: reconciliationRouter,
  keycloak: keycloakRouter,
  phoneAuth: phoneAuthRouter,
  whatsappNotifications: whatsappNotificationsRouter,
  quickReplyTemplates: quickReplyTemplatesRouter,
  cogsDispute: cogsDisputeRouter,
  alertRules: alertRulesRouter,
  revenue: revenueRouter,
  escrow: escrowRouter,
  escrowDispute: escrowDisputeRouter,
  wallet: walletRouter,
  logistics: logisticsRouter,
  metering: meteringRouter,
  tracking: trackingRouter,
  notifications: notificationsRouter,
  timelineAttachment: timelineAttachmentRouter,
  sla: slaRouter,
  evidencePortal: evidencePortalRouter,
  receiptScan: receiptScanRouter,
  onboardingProgress: onboardingProgressRouter,
  slaExtension: slaExtensionRouter,
  operatorTemplates: operatorTemplatesRouter,
  whatsappMedia: whatsappMediaRouter,
  b2b: b2bRouter,
  channels: channelsRouter,
  marketplace: marketplaceRouter,
  mobileMoney: mobileMoneyRouter,
  serviceCommerce: serviceCommerceRouter,
  analyticsBI: analyticsBIRouter,
  compliance: complianceRouter,
  copilot: copilotRouter,
  medusa: medusaRouter,
  webhookDlq: webhookDlqRouter,
  provisioning: provisioningRouter,
  medusaOnboarding: medusaOnboardingRouter,
  odooMedusaBridge: odooMedusaBridgeRouter,
  visualInventory: visualInventoryRouter,
  taxonomy: taxonomyRouter,
  geo: geoRouter,
  labelStudio: labelStudioRouter,
  viCorrections: viCorrectionsRouter,
  productImages: productImagesRouter,
  fineTune: fineTuneRouter,
  tenantAnalytics: tenantAnalyticsRouter,
  deliveryReceipts: deliveryReceiptsRouter,
  hermes: hermesRouter,
  infra: infraRouter,
  temporal: temporalRouter,
  orchestrator: orchestratorRouter,
  search: searchRouter,
  ai: aiRouter,
  apisix: apisixRouter,
  privacy: privacyRouter,
  fraudCase: fraudCaseRouter,
  report: reportRouter,
  audit: auditRouter,
  integrations: integrationsRouter,
  tradeCredit: tradeCreditRouter,
  creditFacilities: creditFacilitiesRouter,
  manufacturerPrograms: manufacturerProgramsRouter,
  creditRepay: creditRepayRouter,
  procurement: procurementRouter,
  onboardingCopilot: onboardingCopilotRouter,
  erpProvision: erpProvisionRouter,
  embeddedSignup: embeddedSignupRouter,
  shopifyIntegration: shopifyIntegrationRouter,
  // === W27 catalog-ai ===
  catalogAI: catalogAIRouter,
  // === W27 bookkeeping ===
  bookkeeping: bookkeepingRouter,
  // === W27 storefront-i18n ===
  storefront: storefrontRouter,
  i18n: i18nRouter,
  // === W27 credit ===
  credit: creditRouter,
  // === W27 delivery-loyalty-reviews (Coder E) ===
  deliveryAggregation: deliveryRouter,
  loyalty: loyaltyRouter,
  reviews: reviewsRouter,
  // === END W27 ===
  // === W27 B2B wholesale marketplace + group buying (Coder F) ===
  wholesale: wholesaleRouter,
  groupBuy: groupBuyRouter,
  // === END W27 Coder F ===
  // === W27 savings-insurance-vouchers (Coder G) ===
  stokvel: stokvelRouter,
  insurance: insuranceRouter,
  vouchers: vouchersRouter,
  // === W28 odoo-sync (Coder A) ===
  odooSync: odooSyncRouter,
  // === END W28 odoo-sync ===
});
export type AppRouter = typeof appRouter;
import { infraRouter } from "./routers/infra";
import { searchRouter } from "./routers/search";
import { temporalRouter } from "./routers/temporal";
import { orchestratorRouter } from "./routers/orchestrator";
// === W27 catalog-ai ===
import { catalogAIRouter } from "./routers/catalogAI";
// === W27 storefront-i18n ===
import { storefrontRouter } from "./routers/storefront";
import { i18nRouter } from "./routers/i18n";
// === W27 credit ===
import { creditRouter } from "./routers/credit";
// === W27 delivery-loyalty-reviews (Coder E) ===
import { deliveryRouter } from "./routers/delivery";
import { loyaltyRouter } from "./routers/loyalty";
import { reviewsRouter } from "./routers/reviews";
// === END W27 ===
// === W27 Coder F ===
import { wholesaleRouter } from "./routers/wholesale";
import { groupBuyRouter } from "./routers/groupBuy";
// === END W27 Coder F ===
// === W28 odoo-sync (Coder A) ===
import { odooSyncRouter } from "./routers/odooSync";
// === END W28 odoo-sync ===
