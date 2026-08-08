import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import { DEFAULT_TENANT_ID, resolveTenantForHost } from "./tenantDomain";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  /**
   * Tenant resolved from the request Host header (multi-domain storefronts
   * and public tracking). Falls back to "default" when the host is unknown
   * or resolution fails. Public procedures should use this; authenticated
   * procedures keep using ctx.user.tenantId.
   */
  resolvedTenantId: string;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    // Authentication is optional for public procedures.
    user = null;
  }

  let resolvedTenantId = DEFAULT_TENANT_ID;
  try {
    resolvedTenantId = await resolveTenantForHost(opts.req.headers.host);
  } catch {
    // Never block a request on tenant resolution.
    resolvedTenantId = DEFAULT_TENANT_ID;
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
    resolvedTenantId,
  };
}
