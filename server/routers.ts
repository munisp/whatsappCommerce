import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { tenantRouter } from "./routers/tenant";
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
import { inventoryRouter } from "./routers/inventory";
import { broadcastAbRouter } from "./routers/broadcastAb";
import { onboardingRouter } from "./routers/onboarding";
import { kycRouter } from "./routers/kyc";
import { heartbeatRouter } from "./routers/heartbeat";
import { nlpRouter } from "./routers/nlp";
import { orderCrudRouter } from "./routers/orderCrud";
import { invoiceRouter } from "./routers/invoice";
import { paymentGatewayRouter } from "./routers/paymentGateway";
import { tenantPortalRouter } from "./routers/tenantPortal";
import { tenantInviteRouter } from "./routers/tenantInvite";
import { mlOpsRouter } from "./routers/mlOps";
import { reconciliationRouter } from "./routers/reconciliation";
import { cogsDisputeRouter } from "./routers/cogsDispute";
import { keycloakRouter } from "./routers/keycloak";
import { revenueRouter } from "./routers/revenue";
import { escrowRouter, escrowDisputeRouter, walletRouter, timelineAttachmentRouter } from "./routers/escrow";
import { logisticsRouter } from "./routers/logistics";
import { notificationsRouter } from "./routers/notifications";
import { slaRouter } from "./routers/sla";
import { evidencePortalRouter } from "./routers/evidencePortal";
import { receiptScanRouter } from "./routers/receiptScan";
import { onboardingProgressRouter } from "./routers/onboardingProgress";
import { slaExtensionRouter } from "./routers/slaExtension";

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
  inventory: inventoryRouter,
  broadcastAb: broadcastAbRouter,
  onboarding: onboardingRouter,
  kyc: kycRouter,
  heartbeat: heartbeatRouter,
  nlp: nlpRouter,
  orderCrud: orderCrudRouter,
  invoice: invoiceRouter,
  paymentGateway: paymentGatewayRouter,
  tenantPortal: tenantPortalRouter,
  tenantInvite: tenantInviteRouter,
  mlOps: mlOpsRouter,
  reconciliation: reconciliationRouter,
  keycloak: keycloakRouter,
  cogsDispute: cogsDisputeRouter,
  alertRules: alertRulesRouter,
  revenue: revenueRouter,
  escrow: escrowRouter,
  escrowDispute: escrowDisputeRouter,
  wallet: walletRouter,
  logistics: logisticsRouter,
  notifications: notificationsRouter,
  timelineAttachment: timelineAttachmentRouter,
  sla: slaRouter,
  evidencePortal: evidencePortalRouter,
  receiptScan: receiptScanRouter,
  onboardingProgress: onboardingProgressRouter,
  slaExtension: slaExtensionRouter,
  operatorTemplates: operatorTemplatesRouter,
  whatsappMedia: whatsappMediaRouter,
});

export type AppRouter = typeof appRouter;
import { alertRulesRouter } from "./routers/alertRules";
import { operatorTemplatesRouter } from "./routers/operatorTemplates";
import { whatsappMediaRouter } from "./routers/whatsappMedia";
