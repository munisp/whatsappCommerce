// === W44 giftcards-referrals (Coder A) ===
/**
 * referrals.ts — referral codes + attribution/reward rail (mig 0137).
 *
 *   - One shareable code per customer (referral_codes.code unique per
 *     tenant); customers mint/read theirs in chat ("my referral code") on
 *     BOTH channels via the shared NLP engine.
 *   - Attribution: a referee enters the code in chat ("use referral CODE")
 *     BEFORE their first paid order — one attribution per referee, enforced
 *     by the partial unique index on (tenant_id, referee_customer_id) WHERE
 *     status <> 'voided'. Self-referral is rejected. Attribution requires
 *     the referee to have NO prior paid order (first-order semantics).
 *   - Reward: when the referee's order goes PAID (pinned
 *     confirmProviderPayment webhook — adjacent seam runReferralRewardWebhookHook
 *     in server/_core/index.ts, or the gift-card full-redemption confirm),
 *     the attributed event flips to 'rewarded' CLAIM-FIRST (guarded UPDATE)
 *     and the referrer is credited via W41 customerWallet.creditWallet with
 *     idempotent refId referral:<eventId>. tenants.referralRewardCents
 *     (integer kobo, default 0 = OFF) sizes the reward; 0 links the order
 *     but moves NO money. Referee-discount rewards are explicitly OUT OF
 *     SCOPE (documented in SPEC_W44 Coder A) — referrer-credit only.
 *   - Void: when the referee order is refunded (orderCrud refund seam), the
 *     event flips to 'voided' claim-first with an audit row. Clawing back an
 *     already-credited wallet reward is out of scope (documented); the
 *     voided event + audit row are the honest record.
 */
import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { orders, referralCodes, referralEvents, tenants, type ReferralCode, type ReferralEvent } from "../../drizzle/schema";

export type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const REFERRAL_CATEGORY = "referral";

async function resolveDb(db?: any): Promise<Db> {
  if (db) return db as Db;
  const real = await getDb();
  if (!real) throw new Error("referrals: db unavailable");
  return real;
}

async function assertActive(tenantId: string, db: Db): Promise<void> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("./tenantGuard");
  assertTenantActive(tenant);
}

function generateReferralCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i]! % alphabet.length];
  return `REF-${out}`;
}

/** Mint (or return the existing active) referral code for a customer. */
export async function getOrCreateReferralCode(tenantId: string, customerId: string, db?: any): Promise<ReferralCode> {
  const d = await resolveDb(db);
  await assertActive(tenantId, d);
  const normalized = customerId.trim();
  const [existing] = await d.select().from(referralCodes)
    .where(and(eq(referralCodes.tenantId, tenantId), eq(referralCodes.customerId, normalized), eq(referralCodes.status, "active")))
    .limit(1);
  if (existing) return existing;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    try {
      const [row] = await d.insert(referralCodes).values({ tenantId, customerId: normalized, code, status: "active" }).returning();
      return row!;
    } catch (e: any) {
      if (String(e?.message ?? "").includes("referral_codes_tenant_code_uidx")) continue; // rare collision — regenerate
      throw e;
    }
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "could not allocate a referral code" });
}

export interface AttributeResult {
  ok: boolean;
  duplicate?: boolean;
  event?: ReferralEvent;
  error?: string;
}

/**
 * Attribute a referee to a referral code. Rules:
 *   - code must exist and be active;
 *   - self-referral is rejected;
 *   - referee must have NO prior paid order (first-order attribution);
 *   - one attribution per referee — the partial unique index is the backstop;
 *     a repeat with the same/different code returns the ORIGINAL event.
 */
export async function attributeReferral(
  tenantId: string,
  input: { code: string; refereeCustomerId: string; orderId?: string | null },
  db?: any,
): Promise<AttributeResult> {
  const d = await resolveDb(db);
  await assertActive(tenantId, d);
  const referee = input.refereeCustomerId.trim();
  const [codeRow] = await d.select().from(referralCodes)
    .where(and(eq(referralCodes.tenantId, tenantId), eq(referralCodes.code, input.code.trim().toUpperCase())))
    .limit(1);
  if (!codeRow) return { ok: false, error: "referral_code_not_found" };
  if (codeRow.status !== "active") return { ok: false, error: "referral_code_disabled" };
  if (codeRow.customerId === referee) return { ok: false, error: "self_referral_rejected" };

  // First-order semantics: a referee who already HAS a (paid, later maybe
  // refunded) order cannot be newly attributed — 'refunded' included so a
  // voided-then-refunded referee is not a fresh first-order referee.
  const priorPaid = await d.select({ id: orders.id }).from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, referee),
      sql`${orders.paymentStatus} IN ('completed','refunded')`))
    .limit(1);
  if (priorPaid.length > 0) return { ok: false, error: "referee_not_first_order" };

  // One attribution per referee (partial unique index backstop).
  const [existing] = await d.select().from(referralEvents)
    .where(and(eq(referralEvents.tenantId, tenantId), eq(referralEvents.refereeCustomerId, referee)))
    .limit(1);
  if (existing && existing.status !== "voided") return { ok: true, duplicate: true, event: existing };

  try {
    const [event] = await d.insert(referralEvents).values({
      tenantId,
      codeId: codeRow.id,
      refereeCustomerId: referee,
      orderId: input.orderId ?? null,
      status: "attributed",
      rewardCents: 0,
    }).returning();
    return { ok: true, event };
  } catch (e: any) {
    if (String(e?.message ?? "").includes("referral_events_referee_uidx")) {
      const [dup] = await d.select().from(referralEvents)
        .where(and(eq(referralEvents.tenantId, tenantId), eq(referralEvents.refereeCustomerId, referee)))
        .limit(1);
      return { ok: true, duplicate: true, event: dup };
    }
    throw e;
  }
}

/**
 * Reward on PAID: flip the referee's attributed event to 'rewarded'
 * claim-first and credit the referrer's wallet (W41 creditWallet, idempotent
 * refId referral:<eventId>) with tenants.referralRewardCents. Reward 0 = off:
 * the order is linked but no money moves. Exactly-once: only the claimant of
 * the attributed→rewarded transition credits.
 */
export async function rewardReferralForPaidOrder(
  db: Db,
  args: { tenantId: string; orderId: string },
): Promise<{ rewarded: boolean; rewardCents?: number; eventId?: string; reason?: string }> {
  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, args.orderId), eq(orders.tenantId, args.tenantId)))
    .limit(1);
  if (!order || order.paymentStatus !== "completed") return { rewarded: false, reason: "order_not_paid" };
  const referee = order.customerId;
  if (!referee) return { rewarded: false, reason: "no_customer" };

  const [event] = await db.select().from(referralEvents)
    .where(and(eq(referralEvents.tenantId, args.tenantId), eq(referralEvents.refereeCustomerId, referee), eq(referralEvents.status, "attributed")))
    .orderBy(desc(referralEvents.createdAt))
    .limit(1);
  if (!event) return { rewarded: false, reason: "no_attribution" };

  const [t] = await db.select({ reward: tenants.referralRewardCents }).from(tenants).where(eq(tenants.id, args.tenantId)).limit(1);
  const rewardCents = Number(t?.reward ?? 0);
  if (!Number.isInteger(rewardCents) || rewardCents <= 0) {
    // Program off: link the order honestly, no money moves.
    if (!event.orderId) {
      await db.update(referralEvents).set({ orderId: args.orderId }).where(eq(referralEvents.id, event.id));
    }
    return { rewarded: false, reason: "reward_disabled", eventId: event.id };
  }

  // Claim-first transition: only ONE concurrent caller rewards.
  const claimed = (await db.execute(sql`
    UPDATE referral_events SET status = 'rewarded', order_id = ${args.orderId}, reward_cents = ${rewardCents}
    WHERE id = ${event.id} AND status = 'attributed'
    RETURNING id`)) as unknown as any[];
  const claimRows = Array.isArray(claimed) ? claimed : (claimed as any).rows ?? [];
  if (claimRows.length === 0) return { rewarded: false, reason: "already_processed", eventId: event.id };

  const [codeRow] = await db.select().from(referralCodes).where(eq(referralCodes.id, event.codeId)).limit(1);
  if (!codeRow) return { rewarded: false, reason: "code_missing", eventId: event.id };
  const { creditWallet } = await import("./customerWallet");
  const credit = await creditWallet(args.tenantId, codeRow.customerId, rewardCents, "referral_reward", `referral:${event.id}`, db as any, {
    orderId: args.orderId, refereeCustomerId: referee,
  });
  if (!credit.ok && !credit.duplicate) {
    console.warn(`[referrals] reward credit failed for event ${event.id}: ${credit.error}`);
    return { rewarded: false, reason: credit.error ?? "credit_failed", eventId: event.id };
  }
  // Referrer notified on BOTH channels (category 'referral').
  try {
    const { sendCustomerText } = await import("./channelParity");
    const { fmtNaira } = await import("./giftCards");
    await sendCustomerText(args.tenantId, codeRow.customerId, REFERRAL_CATEGORY,
      `🎉 Your referral code ${codeRow.code} just earned you ${fmtNaira(rewardCents, order.currency)} store credit — a friend placed their first order! Wallet balance: ${fmtNaira(credit.balanceCents ?? 0, order.currency)}.`,
      { notifType: REFERRAL_CATEGORY, orderId: args.orderId });
  } catch (e: any) {
    console.warn("[referrals] referrer notify failed:", e?.message);
  }
  return { rewarded: true, rewardCents, eventId: event.id };
}

/**
 * Adjacent webhook seam (wired next to the W31/W41 hooks in
 * server/_core/index.ts): resolves the just-confirmed payment intent by PSP
 * reference and rewards the referrer when the referee's order is PAID.
 * Never throws.
 */
export async function runReferralRewardWebhookHook(
  db: Db,
  args: { provider: string; reference: string },
): Promise<{ handled: boolean; rewarded?: boolean }> {
  try {
    // Chat-order charges resolve via payment_transactions; standalone links
    // (AR invoices, gift-card purchases) via payment_intents — check both.
    let rows = (await db.execute(sql`
      SELECT "tenantId", "orderId" FROM payment_transactions
      WHERE "providerRef" = ${args.reference} AND status IN ('completed','success') LIMIT 1`)) as unknown as any[];
    let intent = (Array.isArray(rows) ? rows : (rows as any).rows ?? [])[0];
    if (!intent) {
      rows = (await db.execute(sql`
        SELECT "tenantId", "orderId" FROM payment_intents
        WHERE "providerPaymentId" = ${args.reference} AND status = 'completed' LIMIT 1`)) as unknown as any[];
      intent = (Array.isArray(rows) ? rows : (rows as any).rows ?? [])[0];
    }
    if (!intent?.orderId) return { handled: false };
    // Non-storefront pseudo ids (AR invoices, gift-card purchases) never refer.
    if (String(intent.orderId).includes(":")) return { handled: false };
    const res = await rewardReferralForPaidOrder(db, { tenantId: intent.tenantId, orderId: intent.orderId });
    return { handled: res.rewarded, rewarded: res.rewarded };
  } catch (e: any) {
    console.warn("[referrals] reward webhook hook failed:", e?.message);
    return { handled: false };
  }
}

/**
 * Void on refund (orderCrud refund seam): any non-voided event tied to the
 * refunded order flips to 'voided' claim-first + audit row. Wallet clawback
 * of an already-credited reward is out of scope (documented).
 */
export async function voidReferralOnRefund(
  db: Db,
  args: { tenantId: string; orderId: string; actor?: string },
): Promise<{ voided: number }> {
  const rows = (await db.execute(sql`
    UPDATE referral_events SET status = 'voided'
    WHERE tenant_id = ${args.tenantId} AND order_id = ${args.orderId} AND status <> 'voided'
    RETURNING id, status`)) as unknown as any[];
  const list = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
  // NOTE: RETURNING reflects the pre-update status only in some drivers; count is authoritative.
  for (const r of list) {
    try {
      const { writeAuditLog } = await import("../routers/audit");
      await writeAuditLog({
        tenantId: args.tenantId,
        actorId: args.actor ?? "system",
        action: "referral.voided",
        entityType: "referral_event",
        entityId: r.id,
        summary: `order=${args.orderId} referee order refunded`,
      } as any);
    } catch (e: any) {
      console.warn("[referrals] audit write failed:", e?.message);
    }
  }
  return { voided: list.length };
}

/** Read-side helpers (chat + merchant surfaces). */
export async function getReferralCodeByCode(tenantId: string, code: string, db?: any): Promise<ReferralCode | null> {
  const d = await resolveDb(db);
  const [row] = await d.select().from(referralCodes)
    .where(and(eq(referralCodes.tenantId, tenantId), eq(referralCodes.code, code.trim().toUpperCase())))
    .limit(1);
  return row ?? null;
}

export async function listReferralEventsForCustomer(tenantId: string, customerId: string, db?: any): Promise<ReferralEvent[]> {
  const d = await resolveDb(db);
  const [codeRow] = await d.select().from(referralCodes)
    .where(and(eq(referralCodes.tenantId, tenantId), eq(referralCodes.customerId, customerId)))
    .limit(1);
  if (!codeRow) return [];
  return d.select().from(referralEvents)
    .where(and(eq(referralEvents.tenantId, tenantId), eq(referralEvents.codeId, codeRow.id)))
    .orderBy(desc(referralEvents.createdAt))
    .limit(50);
}
