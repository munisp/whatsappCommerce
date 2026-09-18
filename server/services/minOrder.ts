// === W46 uc-ux (Coder E): UC-27 — tenant minimum order value ===
/**
 * minOrder.ts — per-tenant minimum order value per fulfillment mode.
 *
 * tenants.minOrderCentsDelivery / minOrderCentsPickup (integer cents;
 * 0 = no minimum). The chat checkout seam (createChatOrder in routers/nlp.ts)
 * evaluates the guard BEFORE any order/payment link exists, so below-minimum
 * checkouts are blocked with an additive-cart prompt on BOTH channels — the
 * buyer adds items and reconfirms; nothing is charged.
 */

import { eq } from "drizzle-orm";
import { tenants } from "../../drizzle/schema";
import { toMinorUnitsExact } from "../../shared/escrowAmounts";

type Db = any;
export type FulfillmentMode = "pickup" | "delivery";

/** Minimum order value (integer cents) for a fulfillment mode; 0 = off. */
export async function getMinOrderCents(db: Db, tenantId: string, mode: FulfillmentMode): Promise<number> {
  const [t] = await db.select({
    delivery: tenants.minOrderCentsDelivery,
    pickup: tenants.minOrderCentsPickup,
  }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return mode === "delivery" ? Number(t?.delivery ?? 0) : Number(t?.pickup ?? 0);
}

export interface MinOrderCheck {
  ok: boolean;
  minCents: number;
  subtotalCents: number;
  shortfallCents: number;
}

/** Evaluate the guard against a cart subtotal (major units in, cents out). */
export async function checkMinOrder(
  db: Db,
  opts: { tenantId: string; fulfillment: FulfillmentMode; subtotalMajor: number },
): Promise<MinOrderCheck> {
  const minCents = await getMinOrderCents(db, opts.tenantId, opts.fulfillment);
  const subtotalCents = toMinorUnitsExact(opts.subtotalMajor);
  const shortfallCents = Math.max(0, minCents - subtotalCents);
  return { ok: shortfallCents === 0, minCents, subtotalCents, shortfallCents };
}

/** Buyer-facing block/prompt line (identical text on both channels). */
export function minOrderBlockReply(
  check: MinOrderCheck,
  currency: string,
  mode: FulfillmentMode,
): string {
  const fmt = (cents: number) => `${currency} ${(cents / 100).toFixed(2)}`;
  return (
    `🛒 The minimum for ${mode === "delivery" ? "delivery" : "pickup"} orders is ${fmt(check.minCents)} — ` +
    `your cart is ${fmt(check.subtotalCents)}. Please add ${fmt(check.shortfallCents)} more and confirm again.`
  );
}
// === END W46 uc-ux ===
