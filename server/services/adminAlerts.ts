/**
 * === W40 (Coder C): tenant admin WhatsApp alerts ===
 * Shared helper for compliance/resilience alerts that must reach the
 * tenant's admin phone over WhatsApp (template-status events, broadcast
 * circuit-breaker trips). Resolution order for the admin phone matches the
 * existing convention (chatDispute.ts / creditWhatsApp.ts):
 *   settings.adminPhone → settings.whatsapp.adminPhone → settings.notifications.adminPhone
 * Never throws: an alert failure is logged, never escalated into the
 * caller's failure path.
 */

import { eq } from "drizzle-orm";
import type { getDb } from "../db";
import { tenants } from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Resolve the tenant's configured admin WhatsApp phone (null when unset). */
export async function resolveAdminPhone(db: Db, tenantId: string): Promise<string | null> {
  const [t] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  const s = (t?.settings ?? {}) as Record<string, any>;
  const cand = s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone;
  return typeof cand === "string" && cand.trim() ? cand.trim() : null;
}

/**
 * Send an ops alert to the tenant admin over WhatsApp. Returns true when a
 * send was attempted (admin phone configured); false when there is nobody to
 * alert (logged loudly — a missing admin phone must not be silent).
 */
export async function notifyTenantAdminWhatsApp(
  db: Db,
  tenantId: string,
  body: string,
): Promise<boolean> {
  try {
    const adminPhone = await resolveAdminPhone(db, tenantId);
    if (!adminPhone) {
      console.warn(`[admin-alert] tenant=${tenantId} has no adminPhone configured — alert not delivered: ${body.slice(0, 160)}`);
      return false;
    }
    const { sendWhatsAppText } = await import("./waSender");
    await sendWhatsAppText(tenantId, adminPhone, body, { notifType: "ops_alert" });
    return true;
  } catch (e: any) {
    console.error(`[admin-alert] send failed (tenant=${tenantId}):`, e?.message ?? e);
    return false;
  }
}
