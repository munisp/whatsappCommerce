import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { ENV } from "./env";
import { permifyCheck } from "../permify";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    // The role check is the authoritative admin gate.
    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    // Permify is defense-in-depth on top of the role check. When configured
    // (PERMIFY_URL set), a denial or — in production — any failure denies the
    // request (permifyCheck itself fails closed in production).
    if (process.env.PERMIFY_URL) {
      let allowed = false;
      try {
        allowed = await permifyCheck({
          entity: { type: "system", id: "global" },
          permission: "manage",
          subject: { type: "user", id: String(ctx.user.id) },
        });
      } catch (err: any) {
        if (ENV.isProduction) {
          console.error("[adminProcedure] Permify check failed in production — denying:", err?.message);
          throw new TRPCError({ code: "FORBIDDEN", message: "Authorization service unavailable" });
        }
        console.warn("[adminProcedure] Permify unavailable, falling back to role check (dev):", err?.message);
        allowed = true;
      }
      if (!allowed) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Permify: permission denied" });
      }
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
