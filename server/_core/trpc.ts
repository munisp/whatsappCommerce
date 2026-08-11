import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { ENV } from "./env";
import { permifyCheck } from "../permify";
import { getMembership, type MembershipRole, type TenantMembership } from "../services/membership";

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

/**
 * Multi-tenant isolation guard: non-admin callers may only touch resources
 * belonging to their OWN tenant (ctx.user.tenantId). Platform admins bypass.
 * Throws FORBIDDEN otherwise. Use in every procedure that takes a tenantId
 * (or resolves one from a fetched row) before reading/writing tenant data.
 *
 * W12 membership fallback: after the users.tenantId shortcut fails, the
 * caller's tenant_memberships (attached to the authenticated user by
 * sdk.authenticateRequest as `user.memberships`, loaded from the
 * tenant_memberships table and cached 60s) are consulted — staff who are
 * members of the tenant pass even without users.tenantId set. Behavior is
 * unchanged for admins and for users.tenantId matches, and the signature
 * stays synchronous so all existing callers behave identically.
 */
export function assertTenantAccess(
  user: {
    role: string;
    tenantId?: string | null;
    /** W12: tenant ids the user is a member of (any membership role). */
    memberships?: readonly string[] | null;
  },
  tenantId: string,
): void {
  if (user.role === "admin") return;
  if (user.tenantId && user.tenantId === tenantId) return;
  // W12 membership fallback (tenant_memberships check performed at
  // authentication time by sdk.authenticateRequest).
  if (Array.isArray(user.memberships) && user.memberships.includes(tenantId)) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "You can only access your own tenant's data",
  });
}

/**
 * W12: tenant-role procedures. Both require a logged-in user and a
 * `tenantId` string in the procedure input. Platform admins bypass.
 *   operatorProcedure — membership role owner or operator
 *   analystProcedure  — membership role owner, operator, or analyst
 * The resolved membership is exposed as ctx.membership.
 */
function tenantRoleProcedure(roles: readonly MembershipRole[], label: string) {
  return t.procedure.use(requireUser).use(
    t.middleware(async opts => {
      const { ctx, next } = opts;
      const user = ctx.user;
      // requireUser already ran, but keep the type guard explicit.
      if (!user) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
      }

      let membership: TenantMembership | null = null;
      if (user.role === "admin") {
        // Admin bypass preserved.
      } else {
        const rawInput = (await opts.getRawInput()) as { tenantId?: unknown };
        const tenantId = rawInput?.tenantId;
        if (typeof tenantId !== "string" || tenantId.length === 0) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `${label} requires a tenantId in the input`,
          });
        }
        try {
          membership = await getMembership(user.id, tenantId);
        } catch (err) {
          console.error(`[${label}] membership lookup failed:`, (err as Error)?.message);
          membership = null;
        }
        if (!membership || !roles.includes(membership.role)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `${label} requires tenant role: ${roles.join(" or ")}`,
          });
        }
      }

      return next({
        ctx: {
          ...ctx,
          user,
          membership,
        },
      });
    }),
  );
}

export const operatorProcedure = tenantRoleProcedure(["owner", "operator"], "operatorProcedure");
export const analystProcedure = tenantRoleProcedure(["owner", "operator", "analyst"], "analystProcedure");

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
