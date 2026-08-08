/**
 * WhatsApp contact auto-provisioning at webhook entry.
 *
 * Meta's webhook payload carries contacts[] (wa_id + profile.name) alongside
 * every message. We upsert the customer row via the shared customers-router
 * helper (single phone-normalization implementation) and meter new-customer
 * creations. Never throws — provisioning must not block message processing.
 */

import type { getDb } from "../db";
import { upsertCustomerByPhone } from "../routers/customers";
import { METRIC_CUSTOMERS_CREATED, recordUsage } from "./metering";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Upsert (tenantId, waPhone) as a customer, filling the display name from the
 * WhatsApp profile only when the row has none. Meters customers_created for
 * genuinely new rows. Returns the upsert result (null on failure).
 */
export async function provisionInboundContact(
  db: Db,
  tenantId: string,
  waPhone: string,
  profileName?: string,
): Promise<{ customerId: string; created: boolean } | null> {
  if (!waPhone) return null;
  try {
    const { customer, created } = await upsertCustomerByPhone(db, {
      tenantId,
      whatsappPhone: waPhone,
      name: profileName?.trim() || undefined,
      nameIfEmpty: true,
    });
    if (created) await recordUsage(db, tenantId, METRIC_CUSTOMERS_CREATED);
    return { customerId: customer.id, created };
  } catch (err: any) {
    console.warn("[waContacts] contact provisioning failed:", err?.message);
    return null;
  }
}
