import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import { timingSafeEqual } from "crypto";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { ENV } from "./env";
import { permifyCheck } from "../permify";
import { getMembership, type MembershipRole, type TenantMembership } from "../services/membership";
// === W34 otel-core ===
import { traceProcedure } from "./telemetry";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

/**
 * === W34 otel-core ===
 * Telemetry middleware applied at the BASE procedure, so every procedure
 * (public/protected/internal/admin/tenant-role) gets:
 *   - a span named `trpc.<router>.<procedure>` with tenant.id (from the
 *     AUTHENTICATED ctx.session user — never request params), user.role and
 *     error status attributes, plus tenant.id W3C baggage;
 *   - RED metrics (trpc_procedure_calls_total / trpc_procedure_duration_ms).
 * Fail-open: telemetry exceptions are swallowed + counted inside
 * traceProcedure; procedure behavior is unchanged.
 */
const telemetryMiddleware = t.middleware(async (opts) =>
  traceProcedure(
    opts.path,
    opts.ctx,
    () => opts.next(),
    (result) => (result as { ok: boolean; error?: unknown }).ok ? null : ((result as { error?: Error }).error ?? new Error("trpc error")),
  ),
);

export const router = t.router;
export const publicProcedure = t.procedure.use(telemetryMiddleware);

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

export const protectedProcedure = publicProcedure.use(requireUser); // W34: derives from publicProcedure so telemetryMiddleware wraps it

/**
 * W26 security (F8/F10): internal service-to-service procedure gate.
 *
 * Some tRPC mutations exist only so that platform-internal components (Go
 * services, the WhatsApp webhook handler, heartbeat/recon workers) can write
 * operational data. They must never be callable by arbitrary internet
 * clients. `internalProcedure` enforces a shared-secret check:
 *
 *   - In-process server-side callers (createCaller without an Express req)
 *     are trusted and pass through.
 *   - Real HTTP requests must present the shared secret via the
 *     `x-internal-api-key` header (`x-internal-token` / `x-api-key` also
 *     accepted, matching the Go services' header) compared against
 *     INTERNAL_API_KEY with a timing-safe comparison.
 *   - Fail-closed: when INTERNAL_API_KEY is unset, requests are rejected in
 *     production/staging (503); in dev/test they are allowed with a warning
 *     so local workflows keep working.
 */
function safeEqualSecret(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

export function assertInternalApiKey(ctx: Pick<TrpcContext, "req">): void {
  // In-process server-side caller (no Express request) — trusted.
  if (!ctx.req) return;
  const configured = process.env.INTERNAL_API_KEY ?? "";
  const headers = ctx.req.headers ?? {};
  const presented =
    (headers["x-internal-api-key"] as string | undefined) ??
    (headers["x-internal-token"] as string | undefined) ??
    (headers["x-api-key"] as string | undefined) ??
    "";
  if (!configured) {
    if (ENV.isProduction || process.env.NODE_ENV === "staging") {
      console.error("[internalProcedure] INTERNAL_API_KEY is not configured — refusing request (fail closed)");
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "internal-api-not-configured" });
    }
    console.warn("[internalProcedure] INTERNAL_API_KEY unset — allowing request (non-production mode)");
    return;
  }
  if (!safeEqualSecret(presented, configured)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid-internal-api-key" });
  }
}

export const internalProcedure = publicProcedure.use( // W34: telemetry-wrapped base
  t.middleware(async opts => {
    assertInternalApiKey(opts.ctx);
    return opts.next({ ctx: opts.ctx });
  }),
);

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
  return publicProcedure.use(requireUser).use( // W34: telemetry-wrapped base
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

/**
 * W30 hotfix (F7 residual): role-aware guard for money-moving mutations
 * whose tenantId is resolved from a FETCHED ROW (escrow/refund/order) rather
 * than carried in the procedure input — moneyProcedure covers the
 * input-carried case, these call sites need the same owner|operator bar.
 *
 * Semantics: platform admins bypass; a tenant_memberships row must be
 * owner|operator (analyst is NEVER enough for money movement); when no
 * membership row exists, the legacy users.tenantId / memberships shortcuts
 * pass exactly as assertTenantAccess allows (single-user legacy merchants).
 */
export async function assertMoneyAccess(
  user: {
    id: string | number;
    role: string;
    tenantId?: string | null;
    memberships?: readonly string[] | null;
  },
  tenantId: string,
): Promise<void> {
  if (user.role === "admin") return;
  let membership: TenantMembership | null = null;
  try {
    membership = await getMembership(user.id, tenantId);
  } catch (err) {
    console.error("[assertMoneyAccess] membership lookup failed:", (err as Error)?.message);
    membership = null;
  }
  if (membership) {
    if (membership.role === "owner" || membership.role === "operator") return;
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Money-moving actions require tenant role: owner or operator (you are ${membership.role})`,
    });
  }
  if (user.tenantId && user.tenantId === tenantId) return;
  if (Array.isArray(user.memberships) && user.memberships.includes(tenantId)) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "You can only access your own tenant's data",
  });
}

export const operatorProcedure = tenantRoleProcedure(["owner", "operator"], "operatorProcedure");
export const analystProcedure = tenantRoleProcedure(["owner", "operator", "analyst"], "analystProcedure");

/**
 * W30 (V2#2c): role-aware guard for money-moving mutations. Same semantics
 * as operatorProcedure (protectedProcedure + tenantId in input +
 * assertTenantAccess + membership role owner|operator; platform admins
 * bypass) under a name that makes the intent explicit at call sites:
 * withdrawals, refunds, and escrow release paths must NEVER be reachable by
 * an analyst membership. Read-only procedures keep using analystProcedure.
 */
export const moneyProcedure = tenantRoleProcedure(["owner", "operator"], "moneyProcedure");

export const adminProcedure = publicProcedure.use( // W34: telemetry-wrapped base
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
