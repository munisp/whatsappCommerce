/**
 * Back-in-stock waitlist (migration 0036, table waitlist_entries).
 *
 * Flow: a buyer hits an out-of-stock product → shortage reply offers "reply
 * NOTIFY ME" → subscribeToWaitlist records (tenantId, productId, phone)
 * (unique — re-subscribing is a no-op). When stock goes 0→>0 (product router
 * update, or an inbound Medusa/Odoo stock sync), notifyWaitlistOnRestock
 * sends ONE WhatsApp alert per unnotified entry and stamps notifiedAt, so a
 * later restock cycle can notify again only if the buyer re-subscribes.
 * "STOP" unsubscribes the phone across all products for that tenant.
 *
 * All send failures are logged, never thrown — stock updates must not fail
 * because a notification could not be delivered.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { getDb } from "../db";
import { waitlistEntries, products } from "../../drizzle/schema";
import { normalizeWaPhone, sendWhatsAppText } from "./waSender";

export type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;
/** Any handle exposing the drizzle surface used here (db or tx). */
export type WaitlistDbHandle = Pick<DbHandle, "select" | "insert" | "update" | "delete" | "execute">;

/**
 * Subscribe a phone to back-in-stock alerts for a product. Idempotent:
 * the (tenantId, productId, phone) unique index + onConflictDoNothing makes
 * re-subscribes a no-op. When the entry already existed but was already
 * notified, notifiedAt is reset so a re-subscribe after a sell-out cycle
 * re-arms the alert. Returns true when the subscription is (now) active.
 */
export async function subscribeToWaitlist(
  db: WaitlistDbHandle,
  tenantId: string,
  productId: string,
  phone: string,
): Promise<boolean> {
  const normalized = normalizeWaPhone(phone);
  if (!normalized) return false;
  const id = randomUUID();
  await db
    .insert(waitlistEntries)
    .values({ id, tenantId, productId, phone: normalized, createdAt: new Date(), notifiedAt: null })
    .onConflictDoNothing();
  // Re-arm a previously-notified entry on explicit re-subscribe.
  await db
    .update(waitlistEntries)
    .set({ notifiedAt: null })
    .where(
      and(
        eq(waitlistEntries.tenantId, tenantId),
        eq(waitlistEntries.productId, productId),
        eq(waitlistEntries.phone, normalized),
        sql`${waitlistEntries.notifiedAt} IS NOT NULL`,
      ),
    );
  return true;
}

/** Unsubscribe a phone from waitlist alerts (STOP). Returns rows removed. */
export async function unsubscribeFromWaitlist(
  db: WaitlistDbHandle,
  tenantId: string,
  phone: string,
  productId?: string,
): Promise<number> {
  const normalized = normalizeWaPhone(phone);
  if (!normalized) return 0;
  const conds = [
    eq(waitlistEntries.tenantId, tenantId),
    eq(waitlistEntries.phone, normalized),
  ];
  if (productId) conds.push(eq(waitlistEntries.productId, productId));
  const removed = await db
    .delete(waitlistEntries)
    .where(and(...conds))
    .returning({ id: waitlistEntries.id });
  return removed.length;
}

/**
 * Restock hook — call after a product's stockQuantity transitions 0→>0.
 * Notifies every UNNOTIFIED waitlisted phone exactly once (notifiedAt is
 * stamped per entry as its send is attempted, so a crash mid-fan-out can't
 * double-send on retry). Send failures are logged and swallowed.
 */
export async function notifyWaitlistOnRestock(
  db: WaitlistDbHandle,
  tenantId: string,
  productId: string,
): Promise<{ notified: number; failed: number }> {
  // Guard: only fan out when the product is actually in stock now.
  const [product] = await db
    .select({ id: products.id, name: products.name, stockQuantity: products.stockQuantity })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
    .limit(1);
  if (!product || product.stockQuantity <= 0) return { notified: 0, failed: 0 };

  const pending = await db
    .select()
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.tenantId, tenantId),
        eq(waitlistEntries.productId, productId),
        isNull(waitlistEntries.notifiedAt),
      ),
    );

  let notified = 0;
  let failed = 0;
  for (const entry of pending) {
    try {
      await sendWhatsAppText(
        tenantId,
        entry.phone,
        `🎉 Good news — *${product.name}* is back in stock! Order now before it sells out again. Reply STOP to stop these alerts.`,
        { notifType: "back_in_stock" },
      );
      notified++;
    } catch (e: unknown) {
      failed++;
      console.error(`[waitlist] notify failed for entry ${entry.id}:`, (e as Error)?.message);
    }
    // Stamp per entry regardless of send outcome: the alert was attempted;
    // retries would spam buyers whose phones reject messages.
    await db
      .update(waitlistEntries)
      .set({ notifiedAt: new Date() })
      .where(eq(waitlistEntries.id, entry.id));
  }
  return { notified, failed };
}

/**
 * Fire-and-forget wrapper for restock hooks (product update / inbound stock
 * sync). Compares previous vs new stock and triggers the fan-out only on a
 * 0→>0 transition. Never throws.
 */
export async function triggerRestockNotification(
  db: WaitlistDbHandle,
  tenantId: string,
  productId: string,
  previousStock: number | null | undefined,
  newStock: number | null | undefined,
): Promise<void> {
  try {
    if (previousStock == null || newStock == null) return;
    if (previousStock <= 0 && newStock > 0) {
      const r = await notifyWaitlistOnRestock(db, tenantId, productId);
      if (r.notified > 0) {
        console.log(`[waitlist] restock ${productId}: notified ${r.notified} buyer(s)`);
      }
    }
  } catch (e: unknown) {
    console.error("[waitlist] restock notification failed:", (e as Error)?.message);
  }
}
