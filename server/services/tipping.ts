// === W46 uc-money ===
/**
 * tipping.ts — UC-15: buyer tips (mig 0152: orders.tipCents).
 *
 *   1. Checkout prompt (BOTH channels — the shared nlp engine renders the
 *      order summary): when tenant settings.tipping.enabled is truthy,
 *      buildTipCheckoutPrompt appends an honest "add a tip" line to the
 *      checkout summary (wired in nlp.ts buildOrderSummary via the
 *      tipCheckoutPrompt seam).
 *   2. Buyer: "TIP 500" (or "ADD TIP 5.50") → setOrderTip claims the latest
 *      PENDING + UNPAID order FOR UPDATE, records tipCents (integer minor
 *      units) and folds it into totalAmount. Tips on paid/terminal orders
 *      are refused — the payment link amount must match the order total.
 *   3. Escrow pass-through: the tip is part of the order total BEFORE
 *      payment, so the W30 escrow hold amount IS the verified payment
 *      (incl. tip) and the release split (shared/escrowAmounts) keeps the
 *      conservation invariant fee + net == gross. Nothing in the PINNED
 *      paymentConfirm.ts changes.
 */
import { eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { orders, tenants } from "../../drizzle/schema";
import { toMinorUnitsExact, minorUnitsToString } from "../../shared/escrowAmounts";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const TIP_CATEGORY = "tip_prompt";

export interface TipSettings {
  enabled: boolean;
  /** Suggested tip amounts in minor units shown in the prompt. */
  suggestionsCents: number[];
}

/** Read tenant tipping settings (settings.tipping), defaults disabled. */
export function readTipSettings(settings: any): TipSettings {
  const t = settings?.tipping ?? null;
  const suggestions = Array.isArray(t?.suggestionsCents)
    ? t.suggestionsCents.filter((n: any) => Number.isInteger(n) && n > 0).slice(0, 3)
    : [];
  return { enabled: !!t?.enabled, suggestionsCents: suggestions };
}

/**
 * Checkout prompt line appended to the order summary on BOTH channels when
 * the tenant has tipping enabled; NULL when disabled (summary unchanged).
 */
export function buildTipCheckoutPrompt(settings: any, currency = "NGN"): string | null {
  const cfg = readTipSettings(settings);
  if (!cfg.enabled) return null;
  const sugg = cfg.suggestionsCents.length
    ? ` — e.g. ${cfg.suggestionsCents.map((c) => `TIP ${(c / 100).toLocaleString("en-NG")}`).join(", ")}`
    : "";
  return `💝 Say thanks with a tip: reply TIP <amount> before paying${sugg}. 100% of your tip goes to the store.`;
}

/** Seam used by nlp.ts checkout: tenant settings → prompt line. */
export async function tipCheckoutPrompt(db: Db, tenantId: string, currency = "NGN"): Promise<string | null> {
  const [t] = await db.select({ settings: tenants.settings }).from(tenants)
    .where(eq(tenants.id, tenantId)).limit(1).catch(() => [] as any[]);
  return buildTipCheckoutPrompt(t?.settings ?? null, currency);
}

export interface SetTipInput {
  tenantId: string;
  /** WA phone (digits) or telegram:<chatId> session key of the buyer. */
  customerRef: string;
  /** Explicit order id; default: latest pending unpaid order of the buyer. */
  orderId?: string | null;
  tipCents: number;
}

/**
 * Set/replace the tip on a pending+unpaid order. Claim-first (FOR UPDATE);
 * recomputes totalAmount = (total - oldTip) + newTip in integer minor units.
 */
export async function setOrderTip(
  db: Db,
  input: SetTipInput,
): Promise<{ orderId: string; orderNumber: string; tipCents: number; totalCents: number }> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("./tenantGuard");
  assertTenantActive(tenant);
  if (!Number.isInteger(input.tipCents) || input.tipCents < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Tip must be a non-negative whole number of kobo/cents (0 clears the tip)." });
  }

  const result = await db.transaction(async (tx) => {
    let rows: any;
    if (input.orderId) {
      rows = await tx.execute(sql`
        SELECT * FROM orders WHERE id = ${input.orderId} AND "tenantId" = ${input.tenantId} FOR UPDATE
      `);
    } else {
      rows = await tx.execute(sql`
        SELECT * FROM orders
        WHERE "tenantId" = ${input.tenantId} AND "customerId" = ${input.customerRef}
          AND status = 'pending' AND "paymentStatus" = 'unpaid'
        ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE
      `);
    }
    const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
    const o = list[0];
    if (!o) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No unpaid order waiting for payment — place an order first." });
    }
    if (o.customerId !== input.customerRef) {
      throw new TRPCError({ code: "FORBIDDEN", message: "That's not your order." });
    }
    if (o.status !== "pending" || o.paymentStatus !== "unpaid") {
      throw new TRPCError({ code: "CONFLICT", message: "Tips can only be added before payment — that order is already past checkout." });
    }
    const prevTip = Number(o.tipCents ?? 0);
    const prevTotalCents = toMinorUnitsExact(String(o.totalAmount));
    const baseCents = prevTotalCents - prevTip;
    const newTotalCents = baseCents + input.tipCents;
    await tx.update(orders).set({
      tipCents: input.tipCents,
      totalAmount: minorUnitsToString(newTotalCents),
      updatedAt: new Date(),
    }).where(eq(orders.id, o.id));
    return { orderId: o.id as string, orderNumber: o.orderNumber as string, tipCents: input.tipCents, totalCents: newTotalCents, prevTip };
  });

  // W46 merger fix (J399 hang): writeAuditLog uses getDb() — a SEPARATE
  // handle; calling it INSIDE the transaction deadlocks the PGlite
  // single-connection pool. Audit AFTER commit instead (audit loss on
  // process crash between commit and write is acceptable + logged).
  try {
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({
      tenantId: input.tenantId,
      actorId: input.customerRef,
      action: "order.tip_set",
      entityType: "order",
      entityId: result.orderId,
      summary: `order=${result.orderNumber} prevTip=${result.prevTip} newTip=${result.tipCents} total=${result.totalCents}`,
    } as any);
  } catch (e: any) {
    console.warn("[tipping] audit write failed:", e?.message);
  }
  return { orderId: result.orderId, orderNumber: result.orderNumber, tipCents: result.tipCents, totalCents: result.totalCents };
}
// === END W46 uc-money (tipping) ===
