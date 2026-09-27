// === W54 capabilities ===
/**
 * membershipPlans.ts — CAP-1 consumer membership tiers (mig 0175).
 *
 * Tenant-configurable consumer membership plans (e.g. Silver/Gold) on top of
 * existing primitives — DISTINCT from services/membership.ts (staff tenancy,
 * untouched):
 *
 *  - membership_plans: priceCents integer cents (0 = free tier), period
 *    day|week|month (billing window), benefits = discountPercent (whole %)
 *    off checkout totals + pointsMultiplier (whole integer) on loyalty earn.
 *  - customer_memberships: one LIVE membership per (tenant, customer)
 *    (partial unique customer_memberships_live_uidx) — joins are claim-first
 *    inserts relying on that index; a 23505 maps to a friendly CONFLICT.
 *  - Benefits actually apply: discount in routers/nlp.ts createChatOrder
 *    (integer cents, floor, clamped ≥ 0, AFTER promo, BEFORE loyalty
 *    redemption so the loyalty cap is computed on the discounted total) and
 *    the multiplier in services/loyalty.ts awardPointsForOrder.
 *  - Paid tiers: join creates a pending order + PSP payment link via the
 *    existing initiateWithFallback rail (idempotencyKey membership:<orderId>);
 *    activation rides the receipts.ts post-commit seam (paymentConfirm.ts
 *    untouched) — activateMembershipForOrder is idempotent per order.
 *  - Cancel reuses subscription cancel semantics: cancel-at-period-end
 *    (cancelAtPeriodEnd=true, benefits run to currentPeriodEnd); free tiers
 *    (open-ended, currentPeriodEnd null) cancel immediately.
 *  - runMembershipExpirySweep flips active → expired at period end (cron;
 *    read paths also treat a past currentPeriodEnd as inactive, so a missed
 *    sweep never grants benefits past the paid window — fail-closed money).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import {
  customerMemberships,
  membershipPlans,
  orderItems,
  orders,
  paymentIntents,
  tenants,
  type CustomerMembership,
  type MembershipPlan,
} from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const MEMBERSHIP_CATEGORY = "membership_status";
export const MEMBERSHIP_PERIODS = ["day", "week", "month"] as const;
export type MembershipPeriod = (typeof MEMBERSHIP_PERIODS)[number];

async function requireActiveTenant(db: Db, tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("./tenantGuard");
  assertTenantActive(tenant);
  return tenant;
}

export function periodEnd(from: Date, period: MembershipPeriod): Date {
  const d = new Date(from.getTime());
  if (period === "day") d.setUTCDate(d.getUTCDate() + 1);
  else if (period === "week") d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

// ─── Plan management (portal tRPC callers) ───────────────────────────────────

export async function createMembershipPlan(
  db: Db,
  input: {
    tenantId: string;
    name: string;
    description?: string | null;
    priceCents: number;
    currency?: string;
    period: MembershipPeriod;
    discountPercent?: number;
    pointsMultiplier?: number;
  },
): Promise<MembershipPlan> {
  await requireActiveTenant(db, input.tenantId);
  if (!MEMBERSHIP_PERIODS.includes(input.period)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "period must be day|week|month" });
  }
  if (!Number.isSafeInteger(input.priceCents) || input.priceCents < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "priceCents must be a non-negative integer (0 = free tier)" });
  }
  const discountPercent = Math.floor(input.discountPercent ?? 0);
  if (discountPercent < 0 || discountPercent > 100) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "discountPercent must be 0-100" });
  }
  const pointsMultiplier = Math.floor(input.pointsMultiplier ?? 1);
  if (pointsMultiplier < 1 || pointsMultiplier > 10) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "pointsMultiplier must be 1-10" });
  }
  if (discountPercent === 0 && pointsMultiplier === 1) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "a plan needs at least one benefit (discount and/or points multiplier)" });
  }
  const [plan] = await db.insert(membershipPlans).values({
    tenantId: input.tenantId,
    name: input.name.trim().slice(0, 120),
    description: input.description?.trim().slice(0, 2000) || null,
    priceCents: input.priceCents,
    currency: (input.currency ?? "NGN").slice(0, 3).toUpperCase(),
    period: input.period,
    discountPercent,
    pointsMultiplier,
    status: "active",
  }).returning();
  return plan!;
}

export async function updateMembershipPlan(
  db: Db,
  input: {
    tenantId: string;
    planId: string;
    name?: string;
    description?: string | null;
    priceCents?: number;
    period?: MembershipPeriod;
    discountPercent?: number;
    pointsMultiplier?: number;
  },
): Promise<MembershipPlan> {
  await requireActiveTenant(db, input.tenantId);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name != null) patch.name = input.name.trim().slice(0, 120);
  if (input.description !== undefined) patch.description = input.description?.trim().slice(0, 2000) || null;
  if (input.priceCents != null) {
    if (!Number.isSafeInteger(input.priceCents) || input.priceCents < 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "priceCents must be a non-negative integer" });
    }
    patch.priceCents = input.priceCents;
  }
  if (input.period != null) {
    if (!MEMBERSHIP_PERIODS.includes(input.period)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "period must be day|week|month" });
    }
    patch.period = input.period;
  }
  if (input.discountPercent != null) {
    const d = Math.floor(input.discountPercent);
    if (d < 0 || d > 100) throw new TRPCError({ code: "BAD_REQUEST", message: "discountPercent must be 0-100" });
    patch.discountPercent = d;
  }
  if (input.pointsMultiplier != null) {
    const m = Math.floor(input.pointsMultiplier);
    if (m < 1 || m > 10) throw new TRPCError({ code: "BAD_REQUEST", message: "pointsMultiplier must be 1-10" });
    patch.pointsMultiplier = m;
  }
  const [plan] = await db.update(membershipPlans)
    .set(patch)
    .where(and(
      eq(membershipPlans.id, input.planId),
      eq(membershipPlans.tenantId, input.tenantId),
      eq(membershipPlans.status, "active"),
    ))
    .returning();
  if (!plan) throw new TRPCError({ code: "NOT_FOUND", message: "plan not found (or archived)" });
  return plan;
}

/** Claim-first archive: active → archived only. Live memberships keep their benefits to period end. */
export async function archiveMembershipPlan(
  db: Db,
  input: { tenantId: string; planId: string },
): Promise<MembershipPlan> {
  await requireActiveTenant(db, input.tenantId);
  const [plan] = await db.update(membershipPlans)
    .set({ status: "archived", updatedAt: new Date() })
    .where(and(
      eq(membershipPlans.id, input.planId),
      eq(membershipPlans.tenantId, input.tenantId),
      eq(membershipPlans.status, "active"),
    ))
    .returning();
  if (!plan) throw new TRPCError({ code: "CONFLICT", message: "plan not found or already archived" });
  return plan;
}

export async function listMembershipPlans(
  db: Db,
  tenantId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<MembershipPlan[]> {
  return db.select().from(membershipPlans)
    .where(and(
      eq(membershipPlans.tenantId, tenantId),
      ...(opts.includeArchived ? [] : [eq(membershipPlans.status, "active")]),
    ))
    .orderBy(desc(membershipPlans.createdAt))
    .limit(50);
}

/** Member roster (portal): newest first, plan name joined. */
export async function listMembershipRoster(
  db: Db,
  tenantId: string,
  opts: { planId?: string; status?: string; limit?: number } = {},
) {
  const rows = await db.select({
    membership: customerMemberships,
    planName: membershipPlans.name,
  })
    .from(customerMemberships)
    .innerJoin(membershipPlans, eq(customerMemberships.planId, membershipPlans.id))
    .where(and(
      eq(customerMemberships.tenantId, tenantId),
      ...(opts.planId ? [eq(customerMemberships.planId, opts.planId)] : []),
      ...(opts.status ? [eq(customerMemberships.status, opts.status)] : []),
    ))
    .orderBy(desc(customerMemberships.createdAt))
    .limit(Math.min(200, opts.limit ?? 50));
  return rows;
}

// ─── Benefit resolution (checkout + loyalty earn) ────────────────────────────

export interface MemberBenefits {
  membershipId: string;
  planId: string;
  planName: string;
  discountPercent: number;
  pointsMultiplier: number;
  currentPeriodEnd: Date | null;
}

/**
 * The buyer's live membership benefits, or null. Read-side expiry guard: an
 * active row whose currentPeriodEnd has passed does NOT grant benefits (the
 * sweep flips it to expired; until then this keeps money fail-closed).
 * Fail-open for telemetry: callers wrap in try/catch and skip benefits on
 * error — never block a checkout on a benefit lookup.
 */
export async function memberBenefitsFor(
  db: Db,
  tenantId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<MemberBenefits | null> {
  const rows = await db.select({
    membership: customerMemberships,
    plan: membershipPlans,
  })
    .from(customerMemberships)
    .innerJoin(membershipPlans, eq(customerMemberships.planId, membershipPlans.id))
    .where(and(
      eq(customerMemberships.tenantId, tenantId),
      eq(customerMemberships.customerId, customerId),
      eq(customerMemberships.status, "active"),
    ))
    .limit(1)
    .catch(() => []);
  const row = rows[0];
  if (!row) return null;
  if (row.membership.currentPeriodEnd && row.membership.currentPeriodEnd.getTime() <= now.getTime()) {
    return null;
  }
  return {
    membershipId: row.membership.id,
    planId: row.plan.id,
    planName: row.plan.name,
    discountPercent: row.plan.discountPercent,
    pointsMultiplier: row.plan.pointsMultiplier,
    currentPeriodEnd: row.membership.currentPeriodEnd,
  };
}

/** Member checkout discount in integer cents (floor), clamped to the base. */
export function membershipDiscountCents(baseCents: number, discountPercent: number): number {
  if (baseCents <= 0 || discountPercent <= 0) return 0;
  return Math.min(baseCents, Math.floor((baseCents * discountPercent) / 100));
}

// ─── Join ────────────────────────────────────────────────────────────────────

export interface MembershipJoinResult {
  kind: "active" | "payment_link";
  membership?: CustomerMembership;
  plan: MembershipPlan;
  orderId?: string;
  orderNumber?: string;
  paymentUrl?: string | null;
  totalCents?: number;
  currency?: string;
}

/**
 * Join a plan. Free tier (priceCents 0) activates immediately (claim-first
 * insert; the live-uidx maps to CONFLICT). Paid tier creates a pending order
 * + PSP link on the existing rail — activation rides the receipts.ts
 * post-commit seam (activateMembershipForOrder below).
 */
export async function joinMembership(
  db: Db,
  input: { tenantId: string; planId: string; customerRef: string },
): Promise<MembershipJoinResult> {
  await requireActiveTenant(db, input.tenantId);
  const customerId = input.customerRef.replace(/^\+/, "").slice(0, 36);
  const [plan] = await db.select().from(membershipPlans)
    .where(and(
      eq(membershipPlans.id, input.planId),
      eq(membershipPlans.tenantId, input.tenantId),
      eq(membershipPlans.status, "active"),
    ))
    .limit(1);
  if (!plan) throw new TRPCError({ code: "NOT_FOUND", message: "membership plan not found" });

  const existing = await memberBenefitsFor(db, input.tenantId, customerId);
  if (existing) {
    throw new TRPCError({ code: "CONFLICT", message: `You already have an active ${existing.planName} membership.` });
  }
  const now = new Date();

  if (plan.priceCents === 0) {
    // Free tier: immediate activation, open-ended (no period end).
    try {
      const [m] = await db.insert(customerMemberships).values({
        tenantId: input.tenantId,
        planId: plan.id,
        customerId,
        status: "active",
        startedAt: now,
        currentPeriodEnd: null,
        createdAt: now,
        updatedAt: now,
      }).returning();
      return { kind: "active", membership: m!, plan };
    } catch (e: any) {
      if (String(e?.code) === "23505" || /customer_memberships_live_uidx/i.test(String(e?.message))) {
        throw new TRPCError({ code: "CONFLICT", message: "You already have an active membership." });
      }
      throw e;
    }
  }

  // Paid tier: pending order + payment link (activation on payment confirm).
  const orderId = randomUUID();
  const orderNumber = `MBR-${now.getTime().toString(36).toUpperCase()}`;
  await db.insert(orders).values({
    id: orderId,
    tenantId: input.tenantId,
    customerId,
    orderNumber,
    status: "pending",
    totalAmount: (plan.priceCents / 100).toFixed(2),
    currency: plan.currency,
    paymentStatus: "unpaid",
    items: [{ planId: plan.id, name: `${plan.name} membership (${plan.period})`, qty: 1, price: plan.priceCents / 100 }],
    metadata: {
      source: "membership_join",
      membershipJoin: { planId: plan.id, planName: plan.name, period: plan.period, customerId },
    },
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(orderItems).values({
    id: randomUUID(),
    orderId,
    productId: `membership:${plan.id}`.slice(0, 36),
    productName: `${plan.name} membership (${plan.period})`.slice(0, 255),
    quantity: 1,
    unitPrice: (plan.priceCents / 100).toFixed(2),
    currency: plan.currency,
  });

  const paymentIntentId = randomUUID();
  const reference = `MBR-${now.getTime()}-${paymentIntentId.slice(0, 8).toUpperCase()}`;
  await db.insert(paymentIntents).values({
    id: paymentIntentId,
    tenantId: input.tenantId,
    orderId,
    customerId,
    amount: (plan.priceCents / 100).toFixed(2),
    currency: plan.currency,
    provider: "paystack",
    providerPaymentId: reference,
    idempotencyKey: `membership:${orderId}`,
    status: "pending",
    metadata: { kind: "membership_join", planId: plan.id },
    createdAt: now,
    updatedAt: now,
  });
  let paymentUrl: string | null = null;
  try {
    const { initiateWithFallback } = await import("./payments/initiateWithFallback");
    const { ENV } = await import("../_core/env");
    const fallback = await initiateWithFallback(input.tenantId, {
      tenantId: input.tenantId,
      amountCents: plan.priceCents,
      currency: plan.currency,
      reference,
      metadata: { payment_intent_id: paymentIntentId, tenant_id: input.tenantId, kind: "membership_join", orderId },
      customer: { phone: customerId },
      callbackUrl: `${ENV.appUrl}/orders`,
    });
    paymentUrl = fallback.result.authorizationUrl ?? null;
    await db.update(paymentIntents).set({
      status: "initiated",
      metadata: { kind: "membership_join", planId: plan.id, paymentUrl, servedProvider: fallback.providerId },
      updatedAt: new Date(),
    }).where(eq(paymentIntents.id, paymentIntentId));
  } catch (e: any) {
    await db.update(paymentIntents).set({
      status: "failed",
      failureReason: `provider_init: ${String(e?.message ?? e).slice(0, 300)}`,
      updatedAt: new Date(),
    }).where(eq(paymentIntents.id, paymentIntentId)).catch(() => {});
    console.warn("[membership] payment link failed:", e?.message);
  }
  return {
    kind: "payment_link", plan, orderId, orderNumber, paymentUrl,
    totalCents: plan.priceCents, currency: plan.currency,
  };
}

/**
 * Activate the membership for a PAID join order. Rides the receipts.ts
 * post-commit seam (only ever called after the money commit). Idempotent:
 * a membership already recorded for this order is returned as-is.
 */
export async function activateMembershipForOrder(
  db: Db,
  orderId: string,
  paymentRef?: string,
): Promise<{ activated: boolean; membership: CustomerMembership | null }> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  const joinMeta = (order?.metadata as Record<string, any> | null)?.membershipJoin;
  if (!order || !joinMeta?.planId) return { activated: false, membership: null };

  const [dup] = await db.select().from(customerMemberships)
    .where(and(
      eq(customerMemberships.tenantId, order.tenantId),
      eq(customerMemberships.orderId, orderId),
    ))
    .limit(1);
  if (dup) return { activated: false, membership: dup };

  const [plan] = await db.select().from(membershipPlans)
    .where(eq(membershipPlans.id, joinMeta.planId)).limit(1);
  if (!plan) return { activated: false, membership: null };

  const now = new Date();
  const customerId = String(joinMeta.customerId ?? order.customerId).slice(0, 36);
  try {
    const [m] = await db.insert(customerMemberships).values({
      tenantId: order.tenantId,
      planId: plan.id,
      customerId,
      status: "active",
      startedAt: now,
      currentPeriodEnd: periodEnd(now, plan.period as MembershipPeriod),
      orderId,
      paymentRef: paymentRef?.slice(0, 128) ?? null,
      createdAt: now,
      updatedAt: now,
    }).returning();
    return { activated: true, membership: m! };
  } catch (e: any) {
    if (String(e?.code) === "23505" || /customer_memberships_live_uidx/i.test(String(e?.message))) {
      // The buyer already has a live membership (e.g. joined free first) —
      // never double-activate; the paid order stays a valid payment record.
      console.warn(`[membership] activation skipped for order ${orderId}: live membership exists`);
      return { activated: false, membership: null };
    }
    throw e;
  }
}

// ─── Status / cancel (chat) ──────────────────────────────────────────────────

export async function getMembershipStatus(
  db: Db,
  tenantId: string,
  customerId: string,
): Promise<{ membership: CustomerMembership; plan: MembershipPlan } | null> {
  const rows = await db.select({ membership: customerMemberships, plan: membershipPlans })
    .from(customerMemberships)
    .innerJoin(membershipPlans, eq(customerMemberships.planId, membershipPlans.id))
    .where(and(
      eq(customerMemberships.tenantId, tenantId),
      eq(customerMemberships.customerId, customerId.replace(/^\+/, "").slice(0, 36)),
      eq(customerMemberships.status, "active"),
    ))
    .orderBy(desc(customerMemberships.createdAt))
    .limit(1)
    .catch(() => []);
  return rows[0] ?? null;
}

export interface MembershipCancelResult {
  cancelled: "immediate" | "period_end" | "none";
  plan?: MembershipPlan;
  currentPeriodEnd?: Date | null;
}

/**
 * Cancel at period end (subscription semantics): paid tiers keep benefits to
 * currentPeriodEnd, then the sweep expires the row. Free tiers (no period
 * end) cancel immediately. Claim-first flips — a lost race reports "none".
 */
export async function cancelMembership(
  db: Db,
  input: { tenantId: string; customerRef: string },
): Promise<MembershipCancelResult> {
  await requireActiveTenant(db, input.tenantId);
  const customerId = input.customerRef.replace(/^\+/, "").slice(0, 36);
  const status = await getMembershipStatus(db, input.tenantId, customerId);
  if (!status) return { cancelled: "none" };
  const { membership, plan } = status;
  const now = new Date();
  if (!membership.currentPeriodEnd) {
    const [flipped] = await db.update(customerMemberships)
      .set({ status: "cancelled", updatedAt: now })
      .where(and(eq(customerMemberships.id, membership.id), eq(customerMemberships.status, "active")))
      .returning();
    if (!flipped) return { cancelled: "none" };
    try {
      const { writeAuditLog } = await import("../routers/audit");
      await writeAuditLog({
        tenantId: input.tenantId, actorId: customerId, action: "membership.cancelled",
        entityType: "customer_membership", entityId: membership.id, summary: "active → cancelled (immediate, free tier)",
      } as any);
    } catch (e: any) {
      console.warn("[membership] audit write failed:", e?.message);
    }
    return { cancelled: "immediate", plan, currentPeriodEnd: null };
  }
  const [flipped] = await db.update(customerMemberships)
    .set({ cancelAtPeriodEnd: true, updatedAt: now })
    .where(and(eq(customerMemberships.id, membership.id), eq(customerMemberships.status, "active")))
    .returning();
  if (!flipped) return { cancelled: "none" };
  try {
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({
      tenantId: input.tenantId, actorId: customerId, action: "membership.cancel_at_period_end",
      entityType: "customer_membership", entityId: membership.id, summary: `cancel at ${membership.currentPeriodEnd.toISOString()}`,
    } as any);
  } catch (e: any) {
    console.warn("[membership] audit write failed:", e?.message);
  }
  return { cancelled: "period_end", plan, currentPeriodEnd: membership.currentPeriodEnd };
}

// ─── Expiry sweep (cron) ─────────────────────────────────────────────────────

/** Flip active memberships whose period ended → expired. Safe to re-run. */
export async function runMembershipExpirySweep(
  db: Db,
  now: Date = new Date(),
): Promise<{ scanned: number; expired: number }> {
  const due = await db.select({ id: customerMemberships.id })
    .from(customerMemberships)
    .where(and(
      eq(customerMemberships.status, "active"),
      sql`${customerMemberships.currentPeriodEnd} IS NOT NULL`,
      sql`${customerMemberships.currentPeriodEnd} <= ${now.toISOString()}`,
    ))
    .limit(500)
    .catch(() => []);
  let expired = 0;
  for (const row of due) {
    const [flipped] = await db.update(customerMemberships)
      .set({ status: "expired", updatedAt: now })
      .where(and(eq(customerMemberships.id, row.id), eq(customerMemberships.status, "active")))
      .returning();
    if (flipped) expired++;
  }
  return { scanned: due.length, expired };
}
