// === W44 deposits-subs-digital (Coder C) ===
/**
 * subscriptions.ts — subscription plans + customer auto-billing (mig 0141).
 *
 *  - subscription_plans: merchant-defined recurring plans (interval
 *    day|week|month, priceCents integer kobo) managed over tRPC.
 *  - customer_subscriptions: a buyer's live subscription with a saved W41
 *    payment token (customerPaymentTokens — never re-stubbed).
 *  - runSubscriptionBillingSweep: driven by POST /api/scheduled/
 *    subscription-billing (W42 cronAuth scope+jti). For every DUE
 *    subscription it claims the row FOR UPDATE, charges the saved token
 *    with idempotency reference sub_billing:<subId>:<period>, and on
 *    success creates the order + advances next_billing_at in the SAME
 *    transaction. On failure it increments retry_count, sends a dunning
 *    notice (category "dunning", BOTH channels via channelParity), and
 *    after MAX_SUB_RETRIES (3) failed attempts flips the subscription to
 *    past_due (persisted — no further charges until resumed).
 *  - Chat commands (BOTH channels — telegram inbound feeds the same nlp
 *    engine): "pause subscription" / "resume subscription" /
 *    "cancel subscription", claim-first status flips.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  customerSubscriptions,
  orderItems,
  orders,
  products,
  subscriptionPlans,
  tenants,
  type CustomerSubscription,
  type SubscriptionPlan,
} from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const SUBSCRIPTION_CATEGORY = "subscription_status";
export const MAX_SUB_RETRIES = 3;
export const SUB_BILLING_REF_PREFIX = "sub_billing:";

export type SubscriptionInterval = "day" | "week" | "month";

async function requireActiveTenant(db: Db, tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("./tenantGuard");
  assertTenantActive(tenant);
  return tenant;
}

export function advanceInterval(from: Date, interval: SubscriptionInterval): Date {
  const d = new Date(from.getTime());
  if (interval === "day") d.setUTCDate(d.getUTCDate() + 1);
  else if (interval === "week") d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/** Period key for the idempotency reference (UTC date of the due slot). */
export function periodKey(due: Date): string {
  return due.toISOString().slice(0, 10);
}

export function subBillingRef(subId: string, period: string): string {
  return `${SUB_BILLING_REF_PREFIX}${subId}:${period}`;
}

// ─── Plan management (tRPC callers) ──────────────────────────────────────────

export async function createSubscriptionPlan(
  db: Db,
  input: { tenantId: string; productId: string; name: string; interval: SubscriptionInterval; priceCents: number; actorId?: string },
): Promise<SubscriptionPlan> {
  await requireActiveTenant(db, input.tenantId);
  if (!["day", "week", "month"].includes(input.interval)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "interval must be day|week|month" });
  }
  if (!Number.isSafeInteger(input.priceCents) || input.priceCents <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "priceCents must be a positive integer" });
  }
  const [product] = await db.select().from(products)
    .where(and(eq(products.id, input.productId), eq(products.tenantId, input.tenantId)))
    .limit(1);
  if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "product not found" });
  const [plan] = await db.insert(subscriptionPlans).values({
    tenantId: input.tenantId,
    productId: input.productId,
    name: input.name.trim().slice(0, 160),
    interval: input.interval,
    priceCents: input.priceCents,
    status: "active",
  }).returning();
  return plan!;
}

export async function archiveSubscriptionPlan(
  db: Db,
  input: { tenantId: string; planId: string },
): Promise<SubscriptionPlan> {
  await requireActiveTenant(db, input.tenantId);
  // Claim-first archive: active → archived only.
  const [plan] = await db.update(subscriptionPlans)
    .set({ status: "archived" })
    .where(and(
      eq(subscriptionPlans.id, input.planId),
      eq(subscriptionPlans.tenantId, input.tenantId),
      eq(subscriptionPlans.status, "active"),
    ))
    .returning();
  if (!plan) throw new TRPCError({ code: "CONFLICT", message: "plan not found or already archived" });
  return plan;
}

export async function listSubscriptionPlans(db: Db, tenantId: string): Promise<SubscriptionPlan[]> {
  return db.select().from(subscriptionPlans)
    .where(eq(subscriptionPlans.tenantId, tenantId))
    .orderBy(desc(subscriptionPlans.createdAt))
    .limit(50);
}

// ─── Subscribe ───────────────────────────────────────────────────────────────

export async function subscribeCustomer(
  db: Db,
  input: {
    tenantId: string;
    planId: string;
    customerRef: string;
    paymentTokenId: string;
    nextBillingAt?: Date;
  },
): Promise<CustomerSubscription> {
  await requireActiveTenant(db, input.tenantId);
  const [plan] = await db.select().from(subscriptionPlans)
    .where(and(eq(subscriptionPlans.id, input.planId), eq(subscriptionPlans.tenantId, input.tenantId)))
    .limit(1);
  if (!plan || plan.status !== "active") {
    throw new TRPCError({ code: "NOT_FOUND", message: "subscription plan not found or archived" });
  }
  // Token must be the buyer's active W41 token (fail closed otherwise).
  const { customerPaymentTokens } = await import("../../drizzle/schema");
  const [token] = await db.select().from(customerPaymentTokens)
    .where(and(
      eq(customerPaymentTokens.id, input.paymentTokenId),
      eq(customerPaymentTokens.tenantId, input.tenantId),
      eq(customerPaymentTokens.status, "active"),
    ))
    .limit(1);
  if (!token) throw new TRPCError({ code: "BAD_REQUEST", message: "payment token not found or not active" });

  const now = new Date();
  const customerId = await resolveCustomerRef(db, input.tenantId, input.customerRef);
  try {
    const [sub] = await db.insert(customerSubscriptions).values({
      tenantId: input.tenantId,
      planId: input.planId,
      customerId,
      status: "active",
      nextBillingAt: input.nextBillingAt ?? now,
      paymentTokenId: input.paymentTokenId,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    }).returning();
    return sub!;
  } catch (e: any) {
    if (String(e?.message ?? "").includes("customer_subs_live_uidx")) {
      throw new TRPCError({ code: "CONFLICT", message: "You already have a live subscription to this plan." });
    }
    throw e;
  }
}

// ─── Billing sweep ───────────────────────────────────────────────────────────

export interface SubBillingSummary {
  scanned: number;
  charged: number;
  failed: number;
  pastDue: number;
  skipped: number;
  errors: string[];
}

async function notifySubCustomer(tenantId: string, customerRef: string, text: string, orderId?: string): Promise<void> {
  try {
    const { sendCustomerText } = await import("./channelParity");
    await sendCustomerText(tenantId, customerRef, "dunning", text, { notifType: "dunning", orderId });
  } catch (e: any) {
    console.warn("[subscriptions] notify failed:", e?.message);
  }
}

/**
 * Charge one due subscription claim-first. The WHOLE success leg (order
 * insert + next_billing_at advance + idempotency markers) commits in ONE
 * transaction; a failure leg only bumps retry_count / past_due.
 */
async function chargeDueSubscription(
  db: Db,
  subId: string,
  now: Date,
  summary: SubBillingSummary,
): Promise<void> {
  const notices: {
    success: { tenantId: string; customerId: string; text: string; orderId: string } | null;
    failure: { tenantId: string; customerId: string; text: string } | null;
  } = { success: null, failure: null };

  await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT * FROM customer_subscriptions
      WHERE id = ${subId} FOR UPDATE`)) as any;
    const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
    const sub = list[0];
    if (!sub) { summary.skipped++; return; }
    if (sub.status !== "active" || new Date(sub.next_billing_at) > now) { summary.skipped++; return; }

    const due = new Date(sub.next_billing_at);
    const period = periodKey(due);
    const ref = subBillingRef(sub.id, period);

    const [planRows] = await Promise.all([(tx.execute(sql`
      SELECT * FROM subscription_plans WHERE id = ${sub.plan_id} LIMIT 1`)) as any]);
    const plan = (Array.isArray(planRows) ? planRows : (planRows?.rows ?? []))[0];
    if (!plan || plan.status !== "active") {
      await tx.execute(sql`UPDATE customer_subscriptions SET status = 'paused', updated_at = ${now.toISOString()} WHERE id = ${sub.id}`);
      summary.skipped++;
      return;
    }

    // Idempotency: this period was already billed (crash between charge and
    // advance is impossible — same txn — but a replayed tick with a
    // backdated clock is defended here).
    if (sub.last_billed_period === period) {
      await tx.execute(sql`
        UPDATE customer_subscriptions
        SET next_billing_at = ${advanceInterval(due, plan.interval as SubscriptionInterval).toISOString()},
            updated_at = ${now.toISOString()}
        WHERE id = ${sub.id}`);
      summary.skipped++;
      return;
    }

    if (!sub.payment_token_id) {
      await tx.execute(sql`UPDATE customer_subscriptions SET status = 'past_due', updated_at = ${now.toISOString()} WHERE id = ${sub.id}`);
      summary.pastDue++;
      notices.failure = {
        tenantId: sub.tenant_id, customerId: sub.customer_id,
        text: `⚠️ Your subscription to ${plan.name} has no saved payment method — it is now past due. Reply "my cards" to add one.`,
      };
      return;
    }

    const { chargeCustomerToken } = await import("./customerPaymentTokens");
    const charge = await chargeCustomerToken(tx, {
      tenantId: sub.tenant_id,
      tokenId: sub.payment_token_id,
      amountCents: plan.price_cents,
      currency: "NGN",
      reference: ref,
      metadata: { kind: "subscription_billing", subscriptionId: sub.id, planId: plan.id, period },
    });

    if (charge.ok && charge.status !== "failed") {
      // Success leg: order + advance + markers, SAME txn.
      const { randomUUID } = await import("node:crypto");
      const orderId = randomUUID();
      const orderNumber = `SUB-${sub.id.slice(0, 4).toUpperCase()}-${period.replace(/-/g, "")}`;
      const [prodRows] = await Promise.all([(tx.execute(sql`
        SELECT name FROM products WHERE id = ${plan.product_id} LIMIT 1`)) as any]);
      const prodName = (Array.isArray(prodRows) ? prodRows : (prodRows?.rows ?? []))[0]?.name ?? plan.name;
      await tx.insert(orders).values({
        id: orderId,
        tenantId: sub.tenant_id,
        customerId: sub.customer_id,
        orderNumber,
        status: "confirmed",
        totalAmount: (plan.price_cents / 100).toFixed(2),
        currency: "NGN",
        paymentStatus: "completed",
        metadata: { kind: "subscription_billing", subscriptionId: sub.id, planId: plan.id, period, chargeRef: charge.reference ?? ref },
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(orderItems).values({
        orderId,
        productId: plan.product_id,
        productName: `${prodName} (subscription ${period})`,
        quantity: 1,
        unitPrice: (plan.price_cents / 100).toFixed(2),
        currency: "NGN",
      });
      await tx.execute(sql`
        UPDATE customer_subscriptions
        SET next_billing_at = ${advanceInterval(due, plan.interval as SubscriptionInterval).toISOString()},
            last_billed_period = ${period}, last_charge_ref = ${charge.reference ?? ref},
            retry_count = 0, updated_at = ${now.toISOString()}
        WHERE id = ${sub.id}`);
      summary.charged++;
      const fmt = `₦${(plan.price_cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
      notices.success = {
        tenantId: sub.tenant_id, customerId: sub.customer_id, orderId,
        text: `✅ Your ${plan.name} subscription payment of ${fmt} went through (order ${orderNumber}). Next billing: ${advanceInterval(due, plan.interval as SubscriptionInterval).toUTCString()}. Reply "pause subscription" or "cancel subscription" anytime.`,
      };
      return;
    }

    // Failure leg: retry up to MAX_SUB_RETRIES, then past_due persists.
    const retries = (sub.retry_count ?? 0) + 1;
    const terminal = retries >= MAX_SUB_RETRIES;
    await tx.execute(sql`
      UPDATE customer_subscriptions
      SET retry_count = ${retries}, status = ${terminal ? "past_due" : "active"}, updated_at = ${now.toISOString()}
      WHERE id = ${sub.id}`);
    summary.failed++;
    if (terminal) summary.pastDue++;
    const fmt = `₦${(plan.price_cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
    notices.failure = {
      tenantId: sub.tenant_id, customerId: sub.customer_id,
      text: terminal
        ? `❌ We could not charge your saved card for your ${plan.name} subscription (${fmt}) after ${MAX_SUB_RETRIES} attempts — your subscription is now past due. Update your card ("my cards") and reply "resume subscription".`
        : `⚠️ We could not charge your saved card for your ${plan.name} subscription (${fmt}) — attempt ${retries}/${MAX_SUB_RETRIES}. We'll retry automatically; update your card with "my cards" if it keeps failing.`,
    };
  });

  if (notices.success) {
    const n = notices.success;
    await notifySubCustomer(n.tenantId, n.customerId, n.text, n.orderId);
  }
  if (notices.failure) {
    const n = notices.failure;
    await notifySubCustomer(n.tenantId, n.customerId, n.text);
  }
}

/** Cron entry: every due ACTIVE subscription, claim-first per row. */
export async function runSubscriptionBillingSweep(db: Db, now: Date = new Date()): Promise<SubBillingSummary> {
  const summary: SubBillingSummary = { scanned: 0, charged: 0, failed: 0, pastDue: 0, skipped: 0, errors: [] };
  const due = await db.select({ id: customerSubscriptions.id })
    .from(customerSubscriptions)
    .where(and(
      eq(customerSubscriptions.status, "active"),
      sql`${customerSubscriptions.nextBillingAt} <= ${now.toISOString()}`,
    ))
    .orderBy(asc(customerSubscriptions.nextBillingAt))
    .limit(200);
  summary.scanned = due.length;
  for (const row of due) {
    try {
      await chargeDueSubscription(db, row.id, now, summary);
    } catch (e: any) {
      summary.errors.push(`${row.id}: ${e?.message ?? e}`);
      console.error("[subscriptions] charge failed for sub", row.id, e?.message);
    }
  }
  return summary;
}

// ─── Chat lifecycle (pause / resume / cancel — BOTH channels) ────────────────

/** Resolve a chat ref (WA phone or "telegram:<chatId>") to the stored customer id (phone). */
async function resolveCustomerRef(db: Db, tenantId: string, ref: string): Promise<string> {
  const v = String(ref).trim();
  if (/^telegram:/i.test(v)) {
    const chatId = v.replace(/^telegram:/i, "");
    try {
      const { telegramIdentities } = await import("../../drizzle/schema");
      const [ident] = await db.select({ phone: telegramIdentities.phoneE164 })
        .from(telegramIdentities)
        .where(and(eq(telegramIdentities.tenantId, tenantId), eq(telegramIdentities.chatId, chatId)))
        .limit(1);
      if (ident?.phone) return ident.phone.replace(/^\+/, "").slice(0, 36);
    } catch { /* fall through to the raw chat id */ }
    return chatId.slice(0, 36);
  }
  return v.replace(/^\+/, "").slice(0, 36);
}

async function flipSubscriptionStatus(
  db: Db,
  input: { tenantId: string; customerRef: string; from: string[]; to: string; action: string },
): Promise<{ sub: CustomerSubscription | null; reply: string }> {
  const customerId = await resolveCustomerRef(db, input.tenantId, input.customerRef);
  // Resolve the buyer's LATEST live subscription (claim-first flip below).
  const candidates = await db.select().from(customerSubscriptions)
    .where(and(
      eq(customerSubscriptions.tenantId, input.tenantId),
      eq(customerSubscriptions.customerId, customerId),
      inArray(customerSubscriptions.status, input.from),
    ))
    .orderBy(desc(customerSubscriptions.createdAt))
    .limit(1);
  const sub = candidates[0];
  if (!sub) {
    return { sub: null, reply: "I couldn't find a subscription on this number that can be changed like that." };
  }
  const [flipped] = await db.update(customerSubscriptions)
    .set({ status: input.to, retryCount: input.to === "active" ? 0 : sub.retryCount, updatedAt: new Date() })
    .where(and(
      eq(customerSubscriptions.id, sub.id),
      inArray(customerSubscriptions.status, input.from),
    ))
    .returning();
  if (!flipped) {
    return { sub: null, reply: "That subscription just changed state — please try again." };
  }
  try {
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({
      tenantId: input.tenantId,
      actorId: customerId,
      action: input.action,
      entityType: "customer_subscription",
      entityId: sub.id,
      summary: `${sub.status} → ${input.to}`,
    } as any);
  } catch (e: any) {
    console.warn("[subscriptions] audit write failed:", e?.message);
  }
  return { sub: flipped, reply: "" };
}

export async function pauseSubscription(db: Db, input: { tenantId: string; customerRef: string }): Promise<string> {
  await requireActiveTenant(db, input.tenantId);
  const { sub, reply } = await flipSubscriptionStatus(db, { ...input, from: ["active", "past_due"], to: "paused", action: "subscription.paused" });
  return sub
    ? `⏸️ Your subscription is paused — no more charges until you reply "resume subscription".`
    : reply;
}

export async function resumeSubscription(db: Db, input: { tenantId: string; customerRef: string }): Promise<string> {
  await requireActiveTenant(db, input.tenantId);
  const customerId = await resolveCustomerRef(db, input.tenantId, input.customerRef);
  // Resuming schedules the next charge from NOW (immediate next tick).
  const candidates = await db.select().from(customerSubscriptions)
    .where(and(eq(customerSubscriptions.tenantId, input.tenantId), eq(customerSubscriptions.customerId, customerId), inArray(customerSubscriptions.status, ["paused", "past_due"])))
    .orderBy(desc(customerSubscriptions.createdAt)).limit(1);
  const sub = candidates[0];
  if (!sub) return "I couldn't find a paused or past-due subscription on this number.";
  const [flipped] = await db.update(customerSubscriptions)
    .set({ status: "active", nextBillingAt: new Date(), retryCount: 0, updatedAt: new Date() })
    .where(and(eq(customerSubscriptions.id, sub.id), inArray(customerSubscriptions.status, ["paused", "past_due"])))
    .returning();
  if (!flipped) return "That subscription just changed state — please try again.";
  return `▶️ Your subscription is active again — the next charge runs on the next billing tick.`;
}

export async function cancelSubscriptionChat(db: Db, input: { tenantId: string; customerRef: string }): Promise<string> {
  await requireActiveTenant(db, input.tenantId);
  const { sub, reply } = await flipSubscriptionStatus(db, { ...input, from: ["active", "paused", "past_due"], to: "cancelled", action: "subscription.cancelled" });
  return sub
    ? `🛑 Your subscription is cancelled — you won't be charged again. Thank you for being a subscriber!`
    : reply;
}
