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
});

export type AppRouter = typeof appRouter;
