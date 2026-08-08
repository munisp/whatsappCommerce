/**
 * Promo / discount-code engine (runtime).
 *
 * Storage: tenants.settings.promos — an array of promo objects managed via
 * the promos router (server/routers/promos.ts):
 *   { code, type: "percent" | "fixed", value, minTotal?, expiresAt?,
 *     maxUses?, usedCount? }
 *
 * Money discipline mirrors shared/escrowAmounts.ts: ALL discount math is done
 * in integer minor units (kobo/cents) with a single rounding point, and the
 * discount is clamped so the discounted total can NEVER go negative.
 *
 * Usage counting is claim-first: applyPromo runs ONE atomic UPDATE whose
 * WHERE clause re-checks the maxUses guard, so concurrent checkouts can never
 * push usedCount past maxUses.
 */
import { eq, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import { toMinorUnitsExact, minorUnitsToString } from "../../shared/escrowAmounts";

export type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;
/** Any handle exposing the drizzle surface used here (db or tx). */
export type PromoDbHandle = Pick<DbHandle, "select" | "execute">;

export interface Promo {
  code: string;
  type: "percent" | "fixed";
  /** percent: 0–100; fixed: MAJOR units off (e.g. 500 = ₦500.00). */
  value: number;
  /** Minimum cart subtotal (MAJOR units) required to use the code. */
  minTotal?: number;
  /** ISO date string after which the code is invalid. */
  expiresAt?: string;
  maxUses?: number;
  usedCount?: number;
}

export type PromoRejectReason =
  | "not_found"
  | "expired"
  | "min_total"
  | "max_uses"
  | "invalid";

export interface PromoValidationOk {
  ok: true;
  promo: Promo;
  /** Discount in integer minor units. */
  discountMinor: number;
  /** Discount as a major-units decimal string ("500.00"). */
  discount: string;
}

export interface PromoValidationFail {
  ok: false;
  reason: PromoRejectReason;
}

export type PromoValidation = PromoValidationOk | PromoValidationFail;

/** Read + sanitize settings.promos (defensive: anything malformed is dropped). */
export function getPromosFromSettings(settings: unknown): Promo[] {
  const list = (settings as Record<string, unknown> | null)?.promos;
  if (!Array.isArray(list)) return [];
  const out: Promo[] = [];
  for (const raw of list) {
    const p = raw as Record<string, unknown>;
    if (typeof p?.code !== "string" || !p.code) continue;
    if (p.type !== "percent" && p.type !== "fixed") continue;
    const value = Number(p.value);
    if (!Number.isFinite(value) || value < 0) continue;
    out.push({
      code: p.code,
      type: p.type,
      value,
      minTotal: typeof p.minTotal === "number" && Number.isFinite(p.minTotal) ? p.minTotal : undefined,
      expiresAt: typeof p.expiresAt === "string" ? p.expiresAt : undefined,
      maxUses: typeof p.maxUses === "number" && Number.isFinite(p.maxUses) ? p.maxUses : undefined,
      usedCount: typeof p.usedCount === "number" && Number.isFinite(p.usedCount) ? p.usedCount : 0,
    });
  }
  return out;
}

/** Case-insensitive code lookup. */
export function findPromo(promos: Promo[], code: string): Promo | undefined {
  const wanted = code.trim().toLowerCase();
  return promos.find((p) => p.code.toLowerCase() === wanted);
}

/**
 * Compute the discount for a cart total, in integer minor units.
 *   percent → round(cartTotalMinor × value / 100)   (single rounding point)
 *   fixed   → toMinorUnitsExact(value)
 * Clamped to [0, cartTotalMinor] — a promo can make an order free but NEVER
 * negative.
 */
export function computeDiscountMinor(promo: Pick<Promo, "type" | "value">, cartTotalMinor: number): number {
  if (!Number.isSafeInteger(cartTotalMinor) || cartTotalMinor < 0) return 0;
  let discount: number;
  if (promo.type === "percent") {
    const pct = Math.min(Math.max(promo.value, 0), 100);
    discount = Math.round((cartTotalMinor * pct) / 100);
  } else {
    discount = toMinorUnitsExact(Math.max(promo.value, 0));
  }
  return Math.min(Math.max(discount, 0), cartTotalMinor);
}

/**
 * Read-only validation of a promo code against a cart total (MAJOR units).
 * Checks: exists (case-insensitive), not expired, minTotal met, maxUses not
 * exhausted. Does NOT increment usedCount — that is applyPromo's job, once
 * the order has actually been created.
 */
export async function validatePromo(
  db: PromoDbHandle,
  tenantId: string,
  code: string,
  cartTotal: number,
  now: Date = new Date(),
): Promise<PromoValidation> {
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const promo = findPromo(getPromosFromSettings(tenant?.settings), code);
  if (!promo) return { ok: false, reason: "not_found" };

  if (promo.expiresAt) {
    const expiry = new Date(promo.expiresAt);
    if (!Number.isNaN(expiry.getTime()) && now.getTime() > expiry.getTime()) {
      return { ok: false, reason: "expired" };
    }
  }
  if (promo.minTotal != null && cartTotal < promo.minTotal) {
    return { ok: false, reason: "min_total" };
  }
  if (promo.maxUses != null && (promo.usedCount ?? 0) >= promo.maxUses) {
    return { ok: false, reason: "max_uses" };
  }

  let cartMinor: number;
  try {
    cartMinor = toMinorUnitsExact(cartTotal);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const discountMinor = computeDiscountMinor(promo, cartMinor);
  return { ok: true, promo, discountMinor, discount: minorUnitsToString(discountMinor) };
}

/**
 * Claim-first usage increment: ONE atomic UPDATE that re-checks the maxUses
 * guard inside the WHERE clause, so racing checkouts can never overspend the
 * usage budget. Returns true when this call claimed a use.
 */
export async function applyPromo(
  db: PromoDbHandle,
  tenantId: string,
  code: string,
): Promise<boolean> {
  const normalized = code.trim().toLowerCase();
  const res: any = await db.execute(sql`
    UPDATE tenants
    SET settings = jsonb_set(
      settings,
      '{promos}',
      (
        SELECT jsonb_agg(
          CASE WHEN lower(p->>'code') = ${normalized}
            THEN p || jsonb_build_object('usedCount', COALESCE((p->>'usedCount')::int, 0) + 1)
            ELSE p
          END
        )
        FROM jsonb_array_elements(settings->'promos') AS p
      )
    ),
    "updatedAt" = now()
    WHERE id = ${tenantId}
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(settings->'promos') AS p
        WHERE lower(p->>'code') = ${normalized}
          AND (p->>'maxUses' IS NULL OR COALESCE((p->>'usedCount')::int, 0) < (p->>'maxUses')::int)
      )
    RETURNING id
  `);
  const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
  return rows.length > 0;
}

/**
 * Validate + apply in the order-creation flow. Returns the validation result;
 * when valid, a usage has been atomically claimed. When the atomic claim
 * loses a maxUses race the result is downgraded to { ok:false, "max_uses" }.
 */
export async function redeemPromo(
  db: PromoDbHandle,
  tenantId: string,
  code: string,
  cartTotal: number,
): Promise<PromoValidation> {
  const validation = await validatePromo(db, tenantId, code, cartTotal);
  if (!validation.ok) return validation;
  const claimed = await applyPromo(db, tenantId, code);
  if (!claimed) return { ok: false, reason: "max_uses" };
  return validation;
}
