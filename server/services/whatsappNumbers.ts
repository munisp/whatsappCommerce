// === W47 merchant ===
/**
 * whatsappNumbers.ts — shared WhatsApp phone_number_id ownership helpers.
 *
 * ONB-M-6: the honest CONFLICT pre-check previously lived inside
 * routers/tenant.ts, so onboarding.updateStep (the self-serve wizard path)
 * bypassed it and could surface a raw 23505 — or silently hijack another
 * tenant's inbound traffic. Both write paths now share this helper; the
 * migration-0123 partial unique index remains the backstop.
 */
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "../db";
import { tenants } from "../../drizzle/schema";

/** Returns the conflicting tenant id, or null when the number is free. */
export async function findWhatsAppNumberConflict(
  phoneNumberId: string,
  excludeTenantId: string,
): Promise<string | null> {
  const d = await getDb();
  if (!d) return null;
  const [row] = await d
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.whatsappPhoneNumberId, phoneNumberId), ne(tenants.id, excludeTenantId)))
    .limit(1)
    .catch(() => []);
  // W47 MERGER: post-filter defensively — test doubles whose where() ignores
  // conditions must not fabricate a self-conflict; the SQL `ne` is the real
  // filter in production.
  return row && row.id !== excludeTenantId ? row.id : null;
}
