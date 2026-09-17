/**
 * === W41 Coder A (UC-1) ===
 * Buyer installments (layaway) — a customer pays for ONE order in N parts:
 * a down payment at order confirm plus N−1 scheduled installments charged
 * off-session against a saved customer payment token.
 *
 * Reuse, not fork (per spec): the charge ledger, verify-first reconcile,
 * durable pending rows and exactly-once claim discipline mirror the W38
 * pot_charges patterns in services/payOverTime.ts, re-pointed at the buyer
 * tables (0127) and the customer-token rail (customerPaymentTokens.ts)
 * instead of merchant mandates.
 *
 * Money doctrine:
 *  - The down payment is a NORMAL payment link (paymentTransactions row
 *    keyed by downPaymentRef) settled by the PINNED paymentConfirm path —
 *    paymentConfirm.ts is untouched. The adjacent webhook hook
 *    (runBuyerCreditWebhookHook, wired next to the W31 AR hook) activates
 *    the plan and, with explicit consent captured at checkout, saves the
 *    reusable authorization as a token.
 *  - Each installment capture inserts its own paymentTransactions row
 *    (orderId-linked) BEFORE the off-session charge and settles through the
 *    SAME pinned confirmProviderPayment on success — escrow hold, stock
 *    commit and receipts all reuse the existing money path exactly once.
 *  - Durable buyer_plan_charges rows + verify-first reconcile: 'pending'
 *    charges are converged via the provider's READ-ONLY fetchStatus; a
 *    charge is NEVER blind-retried. Definitive failure → entry 'overdue'
 *    + dunning via sendCustomerText (WA/TG parity, W37).
 *  - Fulfillment gating: orderCrud updateStatus → processing/shipped calls
 *    assertOrderFulfillmentAllowed; an order with a non-terminal plan
 *    (pending_down/active/defaulted) cannot ship. paid-in-full releases it.
 *  - Integer cents everywhere; remainder rides the LAST part.
 */
import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  buyerInstallmentPlans,
  buyerPlanCharges,
  orders,
  paymentTransactions,
  tenants,
  type BuyerInstallmentPlan,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { captureException } from "./observability";

type Db = any;
type Tx = any;

export const BUYER_INSTALLMENT_CHOICES = [2, 3, 4, 6] as const;
export type BuyerInstallments = (typeof BUYER_INSTALLMENT_CHOICES)[number];
/** Days between installments (weekly cadence for layaway). */
export const BUYER_INSTALLMENT_PERIOD_DAYS = 7;
/** Days past the final due date before a plan flips to 'defaulted'. */
export const BUYER_PLAN_GRACE_DAYS = 14;

// ── Tenant config (tenants.settings.buyerInstallments; fail-closed default) ─

export interface BuyerInstallmentConfig {
  enabled: boolean;
  /** Minimum order total (integer cents) at which installments are offered. */
  minTotalCents: number;
  /** Installment choices offered to the buyer (subset of CHOICES). */
  choices: number[];
}

export const DEFAULT_BUYER_INSTALLMENT_CONFIG: BuyerInstallmentConfig = {
  enabled: false,
  minTotalCents: 0,
  choices: [...BUYER_INSTALLMENT_CHOICES],
};

export async function getBuyerInstallmentConfig(db: Db, tenantId: string): Promise<BuyerInstallmentConfig> {
  try {
    const [t] = await db.select({ settings: tenants.settings }).from(tenants)
      .where(eq(tenants.id, tenantId)).limit(1);
    const raw = ((t?.settings as Record<string, any> | null)?.buyerInstallments ?? null) as Record<string, any> | null;
    if (!raw || raw.enabled !== true) return DEFAULT_BUYER_INSTALLMENT_CONFIG;
    const minTotalCents = Number.isSafeInteger(raw.minTotalCents) && raw.minTotalCents > 0 ? raw.minTotalCents : 0;
    const choices = Array.isArray(raw.choices)
      ? raw.choices.filter((c: unknown) => (BUYER_INSTALLMENT_CHOICES as readonly number[]).includes(c as number))
      : [...BUYER_INSTALLMENT_CHOICES];
    return { enabled: true, minTotalCents, choices: choices.length ? choices : [...BUYER_INSTALLMENT_CHOICES] };
  } catch {
    return DEFAULT_BUYER_INSTALLMENT_CONFIG; // fail closed
  }
}

export async function setBuyerInstallmentConfig(
  db: Db,
  tenantId: string,
  cfg: { enabled: boolean; minTotalCents?: number; choices?: number[] },
): Promise<BuyerInstallmentConfig> {
  const [t] = await db.select({ settings: tenants.settings }).from(tenants)
    .where(eq(tenants.id, tenantId)).limit(1);
  if (!t) throw Object.assign(new Error("Tenant not found"), { code: "NOT_FOUND" });
  const settings = { ...((t.settings as Record<string, unknown> | null) ?? {}) };
  const minTotalCents = cfg.minTotalCents ?? 0;
  if (!Number.isSafeInteger(minTotalCents) || minTotalCents < 0) {
    throw Object.assign(new Error("minTotalCents must be a non-negative integer (cents)"), { code: "BAD_REQUEST" });
  }
  const choices = (cfg.choices ?? [...BUYER_INSTALLMENT_CHOICES])
    .filter((c) => (BUYER_INSTALLMENT_CHOICES as readonly number[]).includes(c));
  if (cfg.enabled && choices.length === 0) {
    throw Object.assign(new Error(`choices must be a subset of ${BUYER_INSTALLMENT_CHOICES.join("/")}`), { code: "BAD_REQUEST" });
  }
  settings.buyerInstallments = { enabled: cfg.enabled === true, minTotalCents, choices };
  await db.update(tenants).set({ settings, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
  return getBuyerInstallmentConfig(db, tenantId);
}

export interface BuyerEligibility {
  eligible: boolean;
  reason: "ok" | "merchant_not_opted_in" | "below_threshold";
  config: BuyerInstallmentConfig;
}

/** Eligibility: merchant opt-in (per tenant) + order-total threshold. */
export async function checkBuyerInstallmentEligibility(
  db: Db,
  tenantId: string,
  totalCents: number,
): Promise<BuyerEligibility> {
  const config = await getBuyerInstallmentConfig(db, tenantId);
  if (!config.enabled) return { eligible: false, reason: "merchant_not_opted_in", config };
  if (totalCents < config.minTotalCents) return { eligible: false, reason: "below_threshold", config };
  return { eligible: true, reason: "ok", config };
}

// ── Schedule math (pure, integer cents) ─────────────────────────────────────

export interface BuyerScheduleEntry {
  seq: number; // 2..N (part 1 is the down payment)
  dueAt: string; // ISO
  amountCents: number;
  status: "due" | "paid" | "overdue";
  paidAt: string | null;
}

/**
 * Split an order total into `installments` parts (integer cents). Part 1 is
 * the down payment charged at order confirm; parts 2..N form the schedule on
 * a weekly cadence. Per-part amounts are floored; the remainder rides the
 * LAST part so the parts always sum exactly to the total.
 */
export function computeBuyerSchedule(
  totalCents: number,
  installments: number,
  now: Date,
): { downPaymentCents: number; schedule: BuyerScheduleEntry[] } {
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
    throw Object.assign(new Error("total must be a positive integer (cents)"), { code: "BAD_REQUEST" });
  }
  if (!(BUYER_INSTALLMENT_CHOICES as readonly number[]).includes(installments)) {
    throw Object.assign(new Error(`installments must be one of ${BUYER_INSTALLMENT_CHOICES.join("/")}`), { code: "BAD_REQUEST" });
  }
  const per = Math.floor(totalCents / installments);
  const schedule: BuyerScheduleEntry[] = [];
  for (let i = 1; i < installments; i++) {
    const last = i === installments - 1;
    schedule.push({
      seq: i + 1,
      dueAt: new Date(now.getTime() + i * BUYER_INSTALLMENT_PERIOD_DAYS * 24 * 3600 * 1000).toISOString(),
      amountCents: last ? totalCents - per * (installments - 1) : per,
      status: "due",
      paidAt: null,
    });
  }
  return { downPaymentCents: per, schedule };
}

/** Deterministic exactly-once references. */
export function bipDownRef(planId: string): string {
  return `bipdown:${planId}`.slice(0, 128);
}
export function bipCaptureRef(planId: string, seq: number): string {
  return `bipcap:${planId}:${seq}`.slice(0, 128);
}
export function bipReorderRef(orderId: string): string {
  return `bipreorder:${orderId}`.slice(0, 128);
}

function naira(cents: number): string {
  return (cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Checkout offer line appended to the order summary when eligible. */
export function buildInstallmentOfferText(totalCents: number, config: BuyerInstallmentConfig, currency = "NGN"): string {
  const n = Math.max(...config.choices);
  const { downPaymentCents } = computeBuyerSchedule(totalCents, n, new Date());
  const money = currency.toUpperCase() === "NGN" ? `₦${naira(downPaymentCents)}` : `${currency} ${naira(downPaymentCents)}`;
  return `\n📅 *Pay in installments:* reply "PAY IN ${n}" to pay ${money} now and the rest in ${n - 1} weekly payments.`;
}

// ── Plan creation (checkout caller seam — NOT paymentConfirm.ts) ────────────

export interface CreateBuyerPlanResult {
  ok: true;
  planId: string;
  downPaymentCents: number;
  downPaymentRef: string;
  schedule: BuyerScheduleEntry[];
  duplicate?: boolean;
}

/**
 * Create a plan for a chat order when the buyer chose installments. Called
 * from the checkout caller (routers/nlp.ts createChatOrder seam) AFTER the
 * order row committed. One plan per order: an existing non-terminal plan for
 * the same order is returned as a duplicate (idempotent checkout replay).
 */
export async function createBuyerPlan(
  db: Db,
  opts: {
    tenantId: string;
    orderId: string;
    buyerPhone: string;
    totalCents: number;
    currency?: string;
    installments: number;
    /** Buyer pre-consented to save the card from the down payment. */
    saveCardConsent?: boolean;
    now?: Date;
  },
): Promise<CreateBuyerPlanResult> {
  const now = opts.now ?? new Date();
  const eligibility = await checkBuyerInstallmentEligibility(db, opts.tenantId, opts.totalCents);
  if (!eligibility.eligible) {
    throw Object.assign(
      new Error(eligibility.reason === "merchant_not_opted_in"
        ? "installments_not_available: this shop does not offer installment plans"
        : "installments_not_available: order total is below the installment minimum"),
      { code: "BAD_REQUEST" },
    );
  }
  if (!eligibility.config.choices.includes(opts.installments)) {
    throw Object.assign(new Error(`installments must be one of ${eligibility.config.choices.join("/")}`), { code: "BAD_REQUEST" });
  }
  const { downPaymentCents, schedule } = computeBuyerSchedule(opts.totalCents, opts.installments, now);

  const [existing] = await db.select().from(buyerInstallmentPlans)
    .where(and(
      eq(buyerInstallmentPlans.orderId, opts.orderId),
      inArray(buyerInstallmentPlans.status, ["pending_down", "active", "paid"]),
    )).limit(1);
  if (existing) {
    return {
      ok: true, planId: existing.id, downPaymentCents: existing.downPaymentCents,
      downPaymentRef: existing.downPaymentRef,
      schedule: (existing.schedule as BuyerScheduleEntry[] | null) ?? [],
      duplicate: true,
    };
  }

  const planId = crypto.randomUUID();
  await db.insert(buyerInstallmentPlans).values({
    id: planId,
    tenantId: opts.tenantId,
    orderId: opts.orderId,
    buyerPhone: opts.buyerPhone,
    totalCents: opts.totalCents,
    downPaymentCents,
    downPaymentRef: bipDownRef(planId),
    installments: opts.installments,
    schedule,
    saveCardConsent: opts.saveCardConsent === true,
    currency: opts.currency ?? "NGN",
    status: "pending_down",
    createdAt: now,
    updatedAt: now,
  });
  return { ok: true, planId, downPaymentCents, downPaymentRef: bipDownRef(planId), schedule };
}

// ── Down-payment webhook hook (adjacent seam, W31 AR-hook pattern) ─────────

/**
 * Called from the PSP webhook handlers AFTER the PINNED confirmProviderPayment
 * returned ok (wired next to runArInvoiceWebhookHook in _core/index.ts and
 * unifiedWebhook.ts). Exactly-once (claim-first status flip), never throws
 * into the webhook ack:
 *   1. If the reference is a plan's down_payment_ref: activate the plan and
 *      notify the buyer (WA/TG parity via sendCustomerText).
 *   2. If the plan was created with save-card consent AND the provider
 *      returned a reusable authorization, save it as a customer token and
 *      attach it to the plan (the schedule charges ride this token).
 */
export async function runBuyerCreditWebhookHook(
  db: Db,
  args: { provider: string; reference: string; rawPayload?: unknown },
): Promise<{ handled: boolean; planId?: string }> {
  try {
    const [plan] = await db.select().from(buyerInstallmentPlans)
      .where(eq(buyerInstallmentPlans.downPaymentRef, args.reference)).limit(1);
    if (!plan) return { handled: false };
    const now = new Date();

    // Claim-first activation: only the winner transitions pending_down→active.
    const [activated] = await db.update(buyerInstallmentPlans)
      .set({ status: "active", downPaymentPaidAt: now, updatedAt: now })
      .where(and(eq(buyerInstallmentPlans.id, plan.id), eq(buyerInstallmentPlans.status, "pending_down")))
      .returning();
    const fresh = activated ?? plan;

    // Token save-on-consent (idempotent: tokenId set only once).
    if (fresh.saveCardConsent && !fresh.tokenId) {
      const { extractReusableAuthorization, saveCustomerToken, tokenConsentPrompt } = await import("./customerPaymentTokens");
      const reusable = extractReusableAuthorization(args.provider, args.rawPayload);
      if (reusable) {
        try {
          const token = await saveCustomerToken(db, {
            tenantId: fresh.tenantId,
            buyerPhone: fresh.buyerPhone,
            provider: args.provider,
            token: reusable.token,
            displayLabel: reusable.displayLabel,
            consentText: tokenConsentPrompt(reusable.displayLabel),
          });
          await db.update(buyerInstallmentPlans)
            .set({ tokenId: token.id, updatedAt: now })
            .where(and(eq(buyerInstallmentPlans.id, fresh.id), sql`${buyerInstallmentPlans.tokenId} IS NULL`));
        } catch (err: any) {
          console.warn(`[buyerInstallments] consent token save failed for plan ${fresh.id}:`, err?.message);
        }
      } else {
        console.warn(`[buyerInstallments] plan ${fresh.id}: consent given but provider returned no reusable authorization`);
      }
    }

    if (activated) {
      const remaining = plan.totalCents - plan.downPaymentCents;
      await notifyBuyer(plan.tenantId, plan.buyerPhone,
        `✅ Down payment received (₦${naira(plan.downPaymentCents)}). Your installment plan is active — ₦${naira(remaining)} left in ${plan.installments - 1} weekly payment${plan.installments - 1 === 1 ? "" : "s"}. We'll charge your saved card on each due date.`);
    }
    return { handled: true, planId: plan.id };
  } catch (err: any) {
    console.error("[buyerInstallments] webhook hook failed:", err?.message);
    return { handled: false };
  }
}

/** WA/TG parity notification (W37): telegram-linked customers route via channelSender. */
async function notifyBuyer(tenantId: string, buyerPhone: string, text: string): Promise<boolean> {
  try {
    const { sendCustomerText } = await import("./channelParity");
    await sendCustomerText(tenantId, buyerPhone, "buyer_installments", text, { notifType: "buyer_installments" });
    return true;
  } catch (err: any) {
    console.warn("[buyerInstallments] buyer notify failed:", err?.message);
    return false;
  }
}

// ── Durable charge ledger (W38 pot_charges pattern) ─────────────────────────

async function persistBuyerCharge(
  db: Db,
  row: {
    tenantId: string;
    planId?: string | null;
    orderId?: string | null;
    tokenId?: string | null;
    provider: string;
    kind: "installment" | "reorder";
    seq?: number | null;
    reference: string;
    amountCents: number;
    currency: string;
    status: "pending" | "success" | "failed" | "settlement_failed";
    providerStatus?: string | null;
    rawResponse?: unknown;
  },
  now: Date = new Date(),
): Promise<void> {
  try {
    await db.insert(buyerPlanCharges).values({
      tenantId: row.tenantId,
      planId: row.planId ?? null,
      orderId: row.orderId ?? null,
      tokenId: row.tokenId ?? null,
      provider: row.provider,
      kind: row.kind,
      seq: row.seq ?? null,
      reference: row.reference,
      amountCents: row.amountCents,
      currency: row.currency,
      status: row.status,
      providerStatus: row.providerStatus ?? null,
      rawResponse: row.rawResponse === undefined ? null : JSON.parse(JSON.stringify(row.rawResponse)),
      createdAt: now,
      updatedAt: now,
    });
  } catch (err: any) {
    const e = err as { code?: string; message?: string };
    if (e?.code === "23505" || /buyer_plan_charges_reference_uniq|duplicate key/i.test(e?.message ?? "")) {
      if (row.status === "success") {
        try {
          await db.update(buyerPlanCharges)
            .set({ status: "success", providerStatus: row.providerStatus ?? "success", updatedAt: now })
            .where(and(eq(buyerPlanCharges.reference, row.reference), inArray(buyerPlanCharges.status, ["pending", "failed", "settlement_failed"])));
        } catch (upErr: any) {
          console.warn(`[buyerInstallments] charge success-converge failed for ${row.reference}:`, upErr?.message);
        }
      }
      return; // exactly-once by constraint
    }
    console.warn(`[buyerInstallments] charge persist failed for ${row.reference}:`, err?.message);
    if (row.status === "pending" || row.status === "settlement_failed") {
      captureException(err, {
        service: "buyerInstallments",
        operation: "persistBuyerCharge",
        tenantId: row.tenantId,
        severity: "critical",
        extra: { planId: row.planId ?? null, reference: row.reference, kind: row.kind },
      });
    }
  }
}

async function flipBuyerChargeStatus(db: Db, id: string, from: string[], to: string, providerStatus: string | null, now: Date): Promise<boolean> {
  const [flipped] = await db.update(buyerPlanCharges)
    .set({ status: to, providerStatus, updatedAt: now })
    .where(and(eq(buyerPlanCharges.id, id), inArray(buyerPlanCharges.status, from)))
    .returning();
  return !!flipped;
}

// ── Installment capture (off-session token charge) ──────────────────────────

export type BuyerCaptureOutcome =
  | { ok: true; reference: string; planPaid: boolean }
  | { ok: false; reason: "no_token" | "duplicate" | "charge_failed" | "settlement_failed" | "charge_pending"; reference?: string; error?: string };

/**
 * Settle one confirmed installment: mark the schedule entry paid IN ONE
 * locked transaction; when every entry is paid the plan flips to 'paid'
 * (fulfillment gate released) and the buyer is notified. The money itself is
 * settled through the pinned confirmProviderPayment on the
 * paymentTransactions row inserted before the charge (exactly-once).
 */
async function settleBuyerInstallmentTx(
  db: Db,
  plan: BuyerInstallmentPlan,
  entry: BuyerScheduleEntry,
  now: Date,
): Promise<{ planPaid: boolean }> {
  return db.transaction(async (tx: Tx) => {
    const [locked] = await tx.select().from(buyerInstallmentPlans)
      .where(eq(buyerInstallmentPlans.id, plan.id)).limit(1).for("update");
    if (!locked) throw new Error(`[buyerInstallments] plan ${plan.id} missing at settlement`);
    const schedule = ((locked.schedule as BuyerScheduleEntry[] | null) ?? []).map((e) =>
      e.seq === entry.seq && e.status !== "paid" ? { ...e, status: "paid" as const, paidAt: now.toISOString() } : e);
    const planPaid = locked.downPaymentPaidAt != null && schedule.every((e) => e.status === "paid");
    await tx.update(buyerInstallmentPlans)
      .set({ schedule, ...(planPaid ? { status: "paid" as const } : {}), updatedAt: now })
      .where(eq(buyerInstallmentPlans.id, locked.id));
    return { planPaid };
  });
}

/**
 * Capture ONE due installment against the plan's saved token. Exactly-once
 * by the deterministic reference (bipcap:<planId>:<seq>) claimed via the
 * paymentTransactions row + the durable buyer_plan_charges ledger. A sync
 * success settles through the PINNED confirmProviderPayment (escrow hold +
 * order bookkeeping reuse); 'pending' persists a durable row for the
 * verify-first reconciler; definitive failure marks the entry overdue and
 * duns the buyer.
 */
export async function captureBuyerInstallment(
  db: Db,
  plan: BuyerInstallmentPlan,
  entry: BuyerScheduleEntry,
  now: Date = new Date(),
): Promise<BuyerCaptureOutcome> {
  const reference = bipCaptureRef(plan.id, entry.seq);
  const amountCents = entry.amountCents;

  if (!plan.tokenId) {
    await markBuyerEntryOverdue(db, plan, entry, now);
    await notifyBuyer(plan.tenantId, plan.buyerPhone,
      `⚠️ We couldn't collect installment ${entry.seq - 1} of ${plan.installments - 1} for your order (₦${naira(amountCents)}): no saved card is linked to your plan. Reply "my cards" to manage saved cards or pay the balance in the shop chat.`);
    return { ok: false, reason: "no_token" };
  }

  // Exactly-once claim: the paymentTransactions row carrying this reference
  // is the durable claim (providerRef unique lookup in the pinned confirm
  // path). Insert first; a duplicate key / existing row means a previous
  // attempt owns the charge — go verify-first instead of re-charging.
  const [existingTx] = await db.select().from(paymentTransactions)
    .where(eq(paymentTransactions.providerRef, reference)).limit(1);
  if (existingTx) return { ok: false, reason: "duplicate", reference };
  try {
    await db.insert(paymentTransactions).values({
      id: crypto.randomUUID(),
      tenantId: plan.tenantId,
      orderId: plan.orderId,
      provider: "token",
      providerRef: reference,
      amount: (amountCents / 100).toFixed(2),
      currency: plan.currency ?? "NGN",
      status: "initiated",
      createdAt: now,
      updatedAt: now,
    });
  } catch (err: any) {
    if (err?.code === "23505" || /duplicate key/i.test(err?.message ?? "")) {
      return { ok: false, reason: "duplicate", reference };
    }
    throw err;
  }

  const { chargeCustomerToken } = await import("./customerPaymentTokens");
  const charge = await chargeCustomerToken(db, {
    tenantId: plan.tenantId,
    tokenId: plan.tokenId,
    amountCents,
    currency: plan.currency ?? "NGN",
    reference,
    metadata: { type: "buyer_installment", planId: plan.id, seq: entry.seq, orderId: plan.orderId },
  });

  if (!charge.ok || charge.status === "failed") {
    await markBuyerEntryOverdue(db, plan, entry, now);
    await persistBuyerCharge(db, {
      tenantId: plan.tenantId, planId: plan.id, orderId: plan.orderId, tokenId: plan.tokenId,
      provider: charge.provider ?? "unknown", kind: "installment", seq: entry.seq, reference,
      amountCents, currency: plan.currency ?? "NGN", status: "failed",
      providerStatus: "failed", rawResponse: { status: "failed", error: charge.error ?? "charge_failed" },
    }, now);
    await notifyBuyer(plan.tenantId, plan.buyerPhone,
      `⚠️ We couldn't charge your saved card for installment ${entry.seq - 1} of ${plan.installments - 1} (₦${naira(amountCents)} — ${charge.error ?? "charge failed"}). We'll retry on the next collection run, or update your card with "my cards".`);
    return { ok: false, reason: "charge_failed", reference, error: charge.error };
  }

  if (charge.status === "pending") {
    await persistBuyerCharge(db, {
      tenantId: plan.tenantId, planId: plan.id, orderId: plan.orderId, tokenId: plan.tokenId,
      provider: charge.provider ?? "unknown", kind: "installment", seq: entry.seq, reference,
      amountCents, currency: plan.currency ?? "NGN", status: "pending",
      providerStatus: "pending", rawResponse: { status: "pending" },
    }, now);
    return { ok: false, reason: "charge_pending", reference };
  }

  // Sync success: settle the money through the PINNED confirm path
  // (exactly-once; the PSP webhook replay is a no-op afterwards).
  try {
    const { confirmProviderPayment } = await import("./paymentConfirm");
    await confirmProviderPayment(db, {
      provider: charge.provider ?? "token",
      reference,
      amountMajor: amountCents / 100,
      currency: plan.currency ?? "NGN",
      rawPayload: { source: "buyer_installment_capture", planId: plan.id, seq: entry.seq },
    });
    const settled = await settleBuyerInstallmentTx(db, plan, entry, now);
    await persistBuyerCharge(db, {
      tenantId: plan.tenantId, planId: plan.id, orderId: plan.orderId, tokenId: plan.tokenId,
      provider: charge.provider ?? "unknown", kind: "installment", seq: entry.seq, reference,
      amountCents, currency: plan.currency ?? "NGN", status: "success",
      providerStatus: "success", rawResponse: { status: "success" },
    }, now);
    if (settled.planPaid) {
      await notifyBuyer(plan.tenantId, plan.buyerPhone,
        `🎉 Final installment received — your order is fully paid! The shop has been notified to prepare your order.`);
    } else {
      await notifyBuyer(plan.tenantId, plan.buyerPhone,
        `✅ Installment ${entry.seq - 1} of ${plan.installments - 1} received (₦${naira(amountCents)}).`);
    }
    return { ok: true, reference, planPaid: settled.planPaid };
  } catch (err: any) {
    console.error("[buyerInstallments] settlement failed after successful charge:", err?.message);
    captureException(err, {
      service: "buyerInstallments",
      operation: "captureBuyerInstallmentSettlement",
      tenantId: plan.tenantId,
      severity: "critical",
      extra: { planId: plan.id, reference, amountCents, seq: entry.seq },
    });
    await persistBuyerCharge(db, {
      tenantId: plan.tenantId, planId: plan.id, orderId: plan.orderId, tokenId: plan.tokenId,
      provider: charge.provider ?? "unknown", kind: "installment", seq: entry.seq, reference,
      amountCents, currency: plan.currency ?? "NGN", status: "settlement_failed",
      providerStatus: "success", rawResponse: { status: "success", settlement: "failed", error: err?.message ?? "unknown" },
    }, now);
    return { ok: false, reason: "settlement_failed", reference, error: err?.message };
  }
}

async function markBuyerEntryOverdue(db: Db, plan: BuyerInstallmentPlan, entry: BuyerScheduleEntry, now: Date): Promise<void> {
  const [fresh] = await db.select().from(buyerInstallmentPlans).where(eq(buyerInstallmentPlans.id, plan.id)).limit(1);
  if (!fresh) return;
  const schedule = ((fresh.schedule as BuyerScheduleEntry[] | null) ?? []).map((e) =>
    e.seq === entry.seq && e.status !== "paid" ? { ...e, status: "overdue" as const } : e);
  await db.update(buyerInstallmentPlans).set({ schedule, updatedAt: now }).where(eq(buyerInstallmentPlans.id, plan.id));
}

// ── Capture sweep (cron) ────────────────────────────────────────────────────

export interface BuyerSweepResult {
  plansScanned: number;
  captured: number;
  capturedCents: number;
  overdue: number;
  dunned: number;
  plansPaid: number;
  plansDefaulted: number;
  skippedDuplicate: number;
  pending: number;
}

/**
 * Cron sweep: capture every due/overdue installment whose due date passed,
 * then sync defaults — a plan past its final due date + grace with unpaid
 * entries flips to 'defaulted' and the buyer is dunned. Append-only and
 * safe to run repeatedly.
 */
export async function runBuyerInstallmentSweep(db: Db, opts: { now?: Date } = {}): Promise<BuyerSweepResult> {
  const now = opts.now ?? new Date();
  const result: BuyerSweepResult = {
    plansScanned: 0, captured: 0, capturedCents: 0, overdue: 0, dunned: 0,
    plansPaid: 0, plansDefaulted: 0, skippedDuplicate: 0, pending: 0,
  };
  const plans = await db.select().from(buyerInstallmentPlans)
    .where(inArray(buyerInstallmentPlans.status, ["active", "defaulted"]));
  result.plansScanned = plans.length;

  for (const plan of plans) {
    const schedule = (plan.schedule as BuyerScheduleEntry[] | null) ?? [];
    for (const entry of schedule) {
      if (entry.status === "paid") continue;
      if (new Date(entry.dueAt).getTime() > now.getTime()) continue;
      const outcome = await captureBuyerInstallment(db, plan, entry, now);
      if (outcome.ok) {
        result.captured += 1;
        result.capturedCents += entry.amountCents;
        if (outcome.planPaid) { result.plansPaid += 1; break; }
      } else if (outcome.reason === "duplicate") {
        result.skippedDuplicate += 1;
      } else if (outcome.reason === "charge_pending") {
        result.pending += 1;
      } else if (outcome.reason === "settlement_failed") {
        result.skippedDuplicate += 1; // reconciler owns it
      } else {
        result.overdue += 1;
        result.dunned += 1;
      }
    }

    // Default sync: past final dueAt + grace with anything unpaid.
    const lastDue = schedule.length ? new Date(schedule[schedule.length - 1].dueAt).getTime() : null;
    if (lastDue != null && now.getTime() > lastDue + BUYER_PLAN_GRACE_DAYS * 24 * 3600 * 1000) {
      const [fresh] = await db.select().from(buyerInstallmentPlans)
        .where(eq(buyerInstallmentPlans.id, plan.id)).limit(1);
      const freshSchedule = (fresh?.schedule as BuyerScheduleEntry[] | null) ?? [];
      const outstanding = freshSchedule.filter((e) => e.status !== "paid").reduce((a, e) => a + e.amountCents, 0);
      if (fresh?.status === "active" && outstanding > 0) {
        const [flipped] = await db.update(buyerInstallmentPlans)
          .set({ status: "defaulted", updatedAt: now })
          .where(and(eq(buyerInstallmentPlans.id, plan.id), eq(buyerInstallmentPlans.status, "active")))
          .returning();
        if (flipped) {
          await notifyBuyer(plan.tenantId, plan.buyerPhone,
            `⚠️ Your installment plan (₦${naira(outstanding)} outstanding) is now in DEFAULT. Please settle immediately — your order stays on hold until the plan is fully paid.`);
          result.plansDefaulted += 1;
        }
      }
    }
  }
  return result;
}

// ── Verify-first reconciler (W38 pattern; never a blind re-charge) ──────────

export interface ReconcileBuyerChargesResult {
  checked: number;
  settled: number;
  failed: number;
  retried: number;
  stillPending: number;
}

export type BuyerChargeStatusProbe = (args: {
  tenantId: string;
  provider: string;
  reference: string;
}) => Promise<{ status: "pending" | "success" | "failed" | "unknown"; amountCents?: number }>;

const defaultBuyerProbe: BuyerChargeStatusProbe = async ({ tenantId, provider, reference }) => {
  const { fetchTokenChargeStatus } = await import("./customerPaymentTokens");
  return fetchTokenChargeStatus(tenantId, { provider, reference });
};

/** Settle one confirmed charge row against its plan (local bookkeeping only). */
async function settleBuyerChargeRow(db: Db, plan: BuyerInstallmentPlan | null, row: any, now: Date): Promise<boolean> {
  try {
    if (row.kind === "reorder") {
      // Money bookkeeping for reorders rides the pinned confirm on the
      // paymentTransactions row — nothing plan-side to settle.
      return true;
    }
    if (!plan) return false;
    const schedule = (plan.schedule as BuyerScheduleEntry[] | null) ?? [];
    const entry = schedule.find((e) => e.seq === row.seq);
    if (!entry || entry.status === "paid") return true; // settled earlier
    await settleBuyerInstallmentTx(db, plan, entry, now);
    return true;
  } catch (err: any) {
    console.warn(`[buyerInstallments] reconcile settle failed for ${row.reference}:`, err?.message);
    return false;
  }
}

/**
 * Sweep buyer_plan_charges rows in 'pending' / 'settlement_failed' and
 * converge them via the provider's READ-ONLY fetchStatus(reference):
 *   success → settle exactly once (schedule entry flip is claim-first and
 *             the pinned confirm on the paymentTransactions row is
 *             idempotent), then flip the durable row to 'success'.
 *   failed  → flip to 'failed', mark the installment overdue + dun. A
 *             'settlement_failed' row now reporting 'failed' is money
 *             ambiguity — fail CLOSED (keep marker + CRITICAL alert).
 *   pending/unknown → leave for the next sweep.
 * Never throws into the caller.
 */
export async function reconcilePendingBuyerCharges(
  db: Db,
  opts: { limit?: number; probe?: BuyerChargeStatusProbe } = {},
  now: Date = new Date(),
): Promise<ReconcileBuyerChargesResult> {
  const probe = opts.probe ?? defaultBuyerProbe;
  const result: ReconcileBuyerChargesResult = { checked: 0, settled: 0, failed: 0, retried: 0, stillPending: 0 };
  try {
    const rows = (await db.select().from(buyerPlanCharges)
      .where(inArray(buyerPlanCharges.status, ["pending", "settlement_failed"]))
      .orderBy(asc(buyerPlanCharges.createdAt))
      .limit(Math.max(1, Math.min(opts.limit ?? 100, 500)))) as any[];

    for (const row of rows) {
      result.checked += 1;
      const wasSettlementFailed = row.status === "settlement_failed";
      try {
        const [plan] = row.planId
          ? await db.select().from(buyerInstallmentPlans).where(eq(buyerInstallmentPlans.id, row.planId)).limit(1)
          : [null];
        const verdict = await probe({ tenantId: row.tenantId, provider: row.provider, reference: row.reference });

        if (verdict.status === "success") {
          // Settle the money through the pinned confirm first (idempotent).
          try {
            const { confirmProviderPayment } = await import("./paymentConfirm");
            await confirmProviderPayment(db, {
              provider: row.provider,
              reference: row.reference,
              amountMajor: row.amountCents / 100,
              currency: row.currency ?? "NGN",
              rawPayload: { source: "buyer_charge_reconcile", planId: row.planId ?? null, seq: row.seq ?? null },
            });
          } catch (err: any) {
            console.warn(`[buyerInstallments] reconcile confirm failed for ${row.reference}:`, err?.message);
          }
          const settled = await settleBuyerChargeRow(db, plan ?? null, row, now);
          if (settled) {
            await flipBuyerChargeStatus(db, row.id, ["pending", "settlement_failed"], "success", "success", now);
            if (wasSettlementFailed) result.retried += 1;
            else result.settled += 1;
          } else {
            if (!wasSettlementFailed) {
              await flipBuyerChargeStatus(db, row.id, ["pending"], "settlement_failed", "success", now);
            }
            captureException(new Error(`reconcile: settlement refused for confirmed buyer charge ${row.reference}`), {
              service: "buyerInstallments",
              operation: "reconcilePendingBuyerCharges",
              tenantId: row.tenantId,
              severity: "critical",
              extra: { planId: row.planId ?? null, reference: row.reference, amountCents: row.amountCents, kind: row.kind },
            });
            result.stillPending += 1;
          }
        } else if (verdict.status === "failed") {
          if (wasSettlementFailed) {
            captureException(new Error(`reconcile: provider now reports failed for previously-successful buyer charge ${row.reference}`), {
              service: "buyerInstallments",
              operation: "reconcilePendingBuyerCharges",
              tenantId: row.tenantId,
              severity: "critical",
              extra: { planId: row.planId ?? null, reference: row.reference, amountCents: row.amountCents, kind: row.kind },
            });
            result.stillPending += 1;
          } else {
            const flipped = await flipBuyerChargeStatus(db, row.id, ["pending"], "failed", "failed", now);
            if (flipped && row.kind === "installment" && plan) {
              const schedule = (plan.schedule as BuyerScheduleEntry[] | null) ?? [];
              const entry = schedule.find((e) => e.seq === row.seq);
              if (entry && entry.status !== "paid") {
                await markBuyerEntryOverdue(db, plan, entry, now);
                await notifyBuyer(row.tenantId, plan.buyerPhone,
                  `⚠️ The pending charge for installment ${row.seq - 1} (₦${naira(row.amountCents)}) failed at the provider. We'll retry on the next collection run, or update your card with "my cards".`);
              }
            }
            result.failed += 1;
          }
        } else {
          result.stillPending += 1;
        }
      } catch (err: any) {
        result.stillPending += 1;
        console.warn(`[buyerInstallments] reconcile row ${row.id} failed:`, err?.message);
      }
    }
  } catch (err: any) {
    captureException(err, {
      service: "buyerInstallments",
      operation: "reconcilePendingBuyerCharges",
      severity: "error",
    });
  }
  return result;
}

/** Convenience wrappers for cron/sweep invokers (own db handle). */
export async function runBuyerInstallmentSweepGlobal(now?: Date): Promise<BuyerSweepResult> {
  const db = await getDb();
  if (!db) throw new Error("[buyerInstallments] database unavailable");
  return runBuyerInstallmentSweep(db, { now });
}
export async function reconcilePendingBuyerChargesGlobal(
  opts: { limit?: number; probe?: BuyerChargeStatusProbe; now?: Date } = {},
): Promise<ReconcileBuyerChargesResult> {
  const db = await getDb();
  if (!db) throw new Error("[buyerInstallments] database unavailable");
  return reconcilePendingBuyerCharges(db, opts, opts.now ?? new Date());
}

// ── Fulfillment gating ──────────────────────────────────────────────────────

/** Non-terminal plan statuses that hold fulfillment (COD-like exposure). */
export const FULFILLMENT_GATED_PLAN_STATUSES = ["pending_down", "active", "defaulted"] as const;

/**
 * Returns the gating plan when the order has a non-terminal installment
 * plan, else null. Used by orderCrud.updateStatus before processing/shipped.
 */
export async function getFulfillmentGatingPlan(db: Db, orderId: string): Promise<BuyerInstallmentPlan | null> {
  try {
    const [plan] = await db.select().from(buyerInstallmentPlans)
      .where(and(
        eq(buyerInstallmentPlans.orderId, orderId),
        inArray(buyerInstallmentPlans.status, [...FULFILLMENT_GATED_PLAN_STATUSES]),
      )).limit(1);
    return plan ?? null;
  } catch {
    return null; // table not migrated yet — fail open pre-0127 (no plans exist)
  }
}

/** Throws PRECONDITION_FAILED when an unpaid installment plan gates the order. */
export async function assertOrderFulfillmentAllowed(db: Db, orderId: string): Promise<void> {
  const plan = await getFulfillmentGatingPlan(db, orderId);
  if (plan) {
    const collected = plan.downPaymentCents +
      ((plan.schedule as BuyerScheduleEntry[] | null) ?? []).filter((e) => e.status === "paid").reduce((a, e) => a + e.amountCents, 0);
    throw Object.assign(
      new Error(
        `Order is on an installment plan (${plan.status}) — ₦${naira(plan.totalCents - collected)} of ₦${naira(plan.totalCents)} still outstanding. Fulfillment is released automatically when the plan is fully paid.`,
      ),
      { code: "PRECONDITION_FAILED" },
    );
  }
}

// ── One-tap reorder with a saved token (UC-6) ───────────────────────────────

export interface ReorderWithTokenResult {
  ok: boolean;
  orderId?: string;
  orderNumber?: string;
  chargedCents?: number;
  reference?: string;
  status?: "success" | "pending" | "failed";
  error?: string;
}

/**
 * One-tap reorder: clone the buyer's most recent payable order (same items,
 * current catalog prices are NOT re-floated — the honest copy states the
 * ORIGINAL total), charge their saved token off-session for the full total,
 * and settle through the pinned confirm path. The durable buyer_plan_charges
 * row (kind 'reorder') covers the pending/timeout case verify-first.
 *
 * The caller (chat intent) is responsible for the explicit one-tap confirm
 * BEFORE invoking — this function never charges without being invoked.
 */
export async function reorderWithToken(
  db: Db,
  opts: { tenantId: string; buyerPhone: string; tokenId: string; sourceOrderId: string; now?: Date },
): Promise<ReorderWithTokenResult> {
  const now = opts.now ?? new Date();
  const [src] = await db.select().from(orders)
    .where(and(eq(orders.id, opts.sourceOrderId), eq(orders.tenantId, opts.tenantId))).limit(1);
  if (!src) return { ok: false, error: "order_not_found" };
  if (src.customerId !== opts.buyerPhone) return { ok: false, error: "order_not_yours" };

  // Idempotent replay: a charge row already exists for this reorder.
  const reference = bipReorderRef(opts.sourceOrderId);
  const [existing] = await db.select().from(buyerPlanCharges)
    .where(eq(buyerPlanCharges.reference, reference)).limit(1).catch(() => []);
  if (existing) {
    return { ok: false, error: "reorder_already_charged", reference, status: existing.status === "success" ? "success" : "pending" };
  }

  const totalCents = Math.round(parseFloat(src.totalAmount) * 100);
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) return { ok: false, error: "invalid_order_total" };

  // Clone the order (unpaid — the pinned confirm flips it on charge success).
  const orderId = crypto.randomUUID();
  const orderNumber = `R-${src.orderNumber}-${now.getTime().toString(36).toUpperCase()}`;
  await db.insert(orders).values({
    id: orderId,
    tenantId: src.tenantId,
    customerId: src.customerId,
    conversationId: src.conversationId,
    orderNumber,
    status: "pending",
    totalAmount: src.totalAmount,
    currency: src.currency,
    paymentStatus: "unpaid",
    shippingAddress: src.shippingAddress,
    items: src.items,
    metadata: {
      ...((src.metadata as Record<string, unknown> | null) ?? {}),
      reorderOf: src.id,
      oneTapToken: true,
    },
    createdAt: now,
    updatedAt: now,
  });

  const { chargeCustomerToken } = await import("./customerPaymentTokens");
  const charge = await chargeCustomerToken(db, {
    tenantId: opts.tenantId,
    tokenId: opts.tokenId,
    amountCents: totalCents,
    currency: src.currency ?? "NGN",
    reference,
    metadata: { type: "one_tap_reorder", orderId, reorderOf: src.id },
  });

  if (!charge.ok || charge.status === "failed") {
    await persistBuyerCharge(db, {
      tenantId: opts.tenantId, planId: null, orderId, tokenId: opts.tokenId,
      provider: charge.provider ?? "unknown", kind: "reorder", seq: null, reference,
      amountCents: totalCents, currency: src.currency ?? "NGN", status: "failed",
      providerStatus: "failed", rawResponse: { status: "failed", error: charge.error ?? "charge_failed" },
    }, now);
    return { ok: false, orderId, orderNumber, reference, status: "failed", error: charge.error ?? "charge_failed" };
  }

  // Record the money row so the pinned confirm (sync here + PSP webhook)
  // settles the new order exactly once.
  try {
    await db.insert(paymentTransactions).values({
      id: crypto.randomUUID(),
      tenantId: opts.tenantId,
      orderId,
      provider: charge.provider ?? "token",
      providerRef: reference,
      amount: (totalCents / 100).toFixed(2),
      currency: src.currency ?? "NGN",
      status: "initiated",
      createdAt: now,
      updatedAt: now,
    });
  } catch (err: any) {
    if (err?.code !== "23505" && !/duplicate key/i.test(err?.message ?? "")) throw err;
  }

  if (charge.status === "pending") {
    await persistBuyerCharge(db, {
      tenantId: opts.tenantId, planId: null, orderId, tokenId: opts.tokenId,
      provider: charge.provider ?? "unknown", kind: "reorder", seq: null, reference,
      amountCents: totalCents, currency: src.currency ?? "NGN", status: "pending",
      providerStatus: "pending", rawResponse: { status: "pending" },
    }, now);
    return { ok: true, orderId, orderNumber, chargedCents: totalCents, reference, status: "pending" };
  }

  try {
    const { confirmProviderPayment } = await import("./paymentConfirm");
    await confirmProviderPayment(db, {
      provider: charge.provider ?? "token",
      reference,
      amountMajor: totalCents / 100,
      currency: src.currency ?? "NGN",
      rawPayload: { source: "one_tap_reorder", orderId, reorderOf: src.id },
    });
  } catch (err: any) {
    captureException(err, {
      service: "buyerInstallments",
      operation: "reorderWithTokenConfirm",
      tenantId: opts.tenantId,
      severity: "critical",
      extra: { orderId, reference, amountCents: totalCents },
    });
    await persistBuyerCharge(db, {
      tenantId: opts.tenantId, planId: null, orderId, tokenId: opts.tokenId,
      provider: charge.provider ?? "unknown", kind: "reorder", seq: null, reference,
      amountCents: totalCents, currency: src.currency ?? "NGN", status: "settlement_failed",
      providerStatus: "success", rawResponse: { status: "success", settlement: "failed" },
    }, now);
    return { ok: true, orderId, orderNumber, chargedCents: totalCents, reference, status: "pending" };
  }
  await persistBuyerCharge(db, {
    tenantId: opts.tenantId, planId: null, orderId, tokenId: opts.tokenId,
    provider: charge.provider ?? "unknown", kind: "reorder", seq: null, reference,
    amountCents: totalCents, currency: src.currency ?? "NGN", status: "success",
    providerStatus: "success", rawResponse: { status: "success" },
  }, now);
  return { ok: true, orderId, orderNumber, chargedCents: totalCents, reference, status: "success" };
}

// ── Read helpers ────────────────────────────────────────────────────────────

export async function listBuyerPlans(db: Db, tenantId: string): Promise<BuyerInstallmentPlan[]> {
  return db.select().from(buyerInstallmentPlans)
    .where(eq(buyerInstallmentPlans.tenantId, tenantId))
    .orderBy(desc(buyerInstallmentPlans.createdAt));
}

export async function getBuyerPlanForOrder(db: Db, tenantId: string, orderId: string): Promise<BuyerInstallmentPlan | null> {
  const [plan] = await db.select().from(buyerInstallmentPlans)
    .where(and(eq(buyerInstallmentPlans.orderId, orderId), eq(buyerInstallmentPlans.tenantId, tenantId))).limit(1);
  return plan ?? null;
}
