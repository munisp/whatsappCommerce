import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { tenantRouter } from "./routers/tenant";
import { tenantConfigRouter } from "./routers/tenantConfig";
import { productRouter } from "./routers/product";
import { conversationRouter } from "./routers/conversation";
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
import { onboardingRouter } from "./routers/onboarding";
import { kycRouter } from "./routers/kyc";
import { heartbeatRouter } from "./routers/heartbeat";
import { nlpRouter } from "./routers/nlp";
import { orderCrudRouter } from "./routers/orderCrud";
import { promosRouter } from "./routers/promos";
import { customersRouter } from "./routers/customers";
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
import { creditRepayRouter } from "./routers/creditRepay";
export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  tenant: tenantRouter,
  tenantConfig: tenantConfigRouter,
  product: productRouter,
  conversation: conversationRouter,
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
  onboarding: onboardingRouter,
  kyc: kycRouter,
  heartbeat: heartbeatRouter,
  nlp: nlpRouter,
  orderCrud: orderCrudRouter,
  promos: promosRouter,
  customers: customersRouter,
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
  medusa: medusaRouter,
  webhookDlq: webhookDlqRouter,
  provisioning: provisioningRouter,
  medusaOnboarding: medusaOnboardingRouter,
  odooMedusaBridge: odooMedusaBridgeRouter,
  visualInventory: visualInventoryRouter,
  taxonomy: taxonomyRouter,
  labelStudio: labelStudioRouter,
  viCorrections: viCorrectionsRouter,
  productImages: productImagesRouter,
  fineTune: fineTuneRouter,
  tenantAnalytics: tenantAnalyticsRouter,
  deliveryReceipts: deliveryReceiptsRouter,
  hermes: hermesRouter,
  infra: infraRouter,
  temporal: temporalRouter,
  search: searchRouter,
  ai: aiRouter,
  apisix: apisixRouter,
  privacy: privacyRouter,
  fraudCase: fraudCaseRouter,
  report: reportRouter,
  audit: auditRouter,
  integrations: integrationsRouter,
  tradeCredit: tradeCreditRouter,
  creditRepay: creditRepayRouter,
  procurement: procurementRouter,
});
export type AppRouter = typeof appRouter;
import { infraRouter } from "./routers/infra";
import { searchRouter } from "./routers/search";
import { temporalRouter } from "./routers/temporal";
