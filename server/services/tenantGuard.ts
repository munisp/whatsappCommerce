/**
 * === W40 tenancy (Coder A, TEN-1) ===
 * Shared tenant-lifecycle guard. Tenants in a terminal/inactive lifecycle
 * state ('suspended' | 'churned') must not receive traffic or act on the
 * platform:
 *   - tRPC: authenticated calls from a user whose home tenant is inactive
 *     are rejected fail-closed with 403 tenant_suspended (wired in
 *     server/_core/trpc.ts requireUser).
 *   - WhatsApp webhook dispatcher: inbound messages for an inactive tenant
 *     are dropped with a structured log line (no processing, no reply).
 *   - Telegram webhook (W37 path): fails closed with a bare 404 (same
 *     no-configuration-oracle doctrine as unknown tenants).
 *   - Cron/service paths that iterate tenants "as tenant" skip inactive
 *     tenants where a guard exists (wa-quality refresh, webhook-retry NLP).
 *
 * Fail-closed semantics: a KNOWN inactive status always blocks. A tenant
 * id that has no row passes the tRPC gate (legacy single-tenant "default"
 * and mocked-DB test environments have no tenants row) — the webhook
 * dispatchers only guard tenants they actually resolved from the table,
 * which is the same population.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { tenants, type Tenant } from "../../drizzle/schema";

export const TENANT_SUSPENDED_CODE = "tenant_suspended";

/** Inactive lifecycle states that block all tenant activity. */
export function isTenantInactive(status: string | null | undefined): boolean {
  return status === "suspended" || status === "churned";
}

/** Throw 403 tenant_suspended when the tenant row is in an inactive state. */
export function assertTenantActive(tenant: Pick<Tenant, "id" | "status">): void {
  if (isTenantInactive(tenant.status)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${TENANT_SUSPENDED_CODE}: tenant ${tenant.id} is ${tenant.status}`,
    });
  }
}

/**
 * Resolve a tenant's lifecycle status by id. Returns null when the tenant
 * row does not exist (or the lookup fails — callers decide their own
 * failure doctrine).
 */
export async function getTenantStatus(db: any, tenantId: string): Promise<string | null> {
  const [row] = await db
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => []);
  return row?.status ?? null;
}

/**
 * tRPC-context gate: reject authenticated users whose HOME tenant
 * (user.tenantId) is suspended/churned. Users without a home tenant
 * (platform admins, legacy accounts) and users whose tenant has no row
 * (legacy "default") pass — the gate binds only where a real tenant row
 * asserts an inactive lifecycle state.
 */
export async function assertUserTenantActive(
  db: any,
  user: { tenantId?: string | null },
): Promise<void> {
  const tenantId = user.tenantId;
  if (!tenantId) return;
  const status = await getTenantStatus(db, tenantId);
  if (status !== null && isTenantInactive(status)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${TENANT_SUSPENDED_CODE}: tenant ${tenantId} is ${status}`,
    });
  }
}

/** Structured log line for dropped webhook traffic (grep-friendly JSON). */
export function logSuspendedTenantDrop(channel: "whatsapp" | "telegram", fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({
    event: "tenant_suspended_drop",
    channel,
    droppedAt: new Date().toISOString(),
    ...fields,
  }));
}
