import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
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

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    // Permify authorization check — verify admin has system:manage permission
    // Fails open if Permify is unavailable (graceful degradation)
    try {
      const allowed = await permifyCheck({
        entity: { type: "system", id: "global" },
        permission: "manage",
        subject: { type: "user", id: String(ctx.user.id) },
      });
      if (!allowed) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Permify: permission denied" });
      }
    } catch (err: any) {
      if (err instanceof TRPCError) throw err;
      console.warn("[adminProcedure] Permify unavailable, falling back to role check:", err?.message);
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
