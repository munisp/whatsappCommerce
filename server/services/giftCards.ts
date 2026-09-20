// === W44 giftcards-referrals (Coder A) ===
/**
 * giftCards.ts — stored-value gift cards (mig 0136).
 *
 * Money doctrine (mirrors W41 customerWallet/splitPayments contracts):
 *   - integer cents everywhere; gift_cards.balance_cents has a CHECK >= 0
 *     backstop and is NEVER mutated outside a claim-first guarded UPDATE
 *     (SELECT ... FOR UPDATE + UPDATE ... WHERE balance_cents >= amount);
 *   - every money-moving leg writes a gift_card_transactions row whose
 *     idempotency_key is UNIQUE — the insert IS the exactly-once claim, so
 *     webhook replays / chat retries never double-credit or double-debit;
 *   - purchase rides the EXISTING payment-intent path: purchaseGiftCard
 *     creates a payment_intents row (metadata.kind='gift_card_purchase')
 *     through initiateWithFallback; the card itself is only CREATED (status
 *     'active', full balance) by runGiftCardPurchaseWebhookHook AFTER the
 *     pinned confirmProviderPayment has verified + completed the intent
 *     (adjacent webhook seam in server/_core/index.ts — paymentConfirm.ts
 *     stays PINNED). An unpaid purchase therefore never yields spendable
 *     value;
 *   - redeem at checkout applies alongside wallet/split (same claim-first
 *     pattern); partial redemption is allowed, insufficient funds and
 *     disabled/expired/depleted cards are honest CONFLICTs;
 *   - customer-facing notices go through channelParity sendCustomerText /
 *     notifyCustomer (categories 'gift_card' / 'payment_link') so BOTH
 *     WhatsApp and Telegram are served.
 */
import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { giftCards, giftCardTransactions, orders, paymentIntents, tenants, type GiftCard } from "../../drizzle/schema";

export type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type DbOrTx = any;

export const GIFT_CARD_CATEGORY = "gift_card";
/** Gift-card redemption refIds are namespaced per order+card (checkout spend). */
export const giftCardRedeemKey = (orderId: string, code: string) => `redeem:${orderId}:${code.toUpperCase()}`;

async function resolveDb(db?: DbOrTx): Promise<Db> {
  if (db) return db as Db;
  const real = await getDb();
  if (!real) throw new Error("giftCards: db unavailable");
  return real;
}

async function assertActive(tenantId: string, db: Db): Promise<void> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("./tenantGuard");
  assertTenantActive(tenant);
}

/** Human-readable card code: GC-XXXX-XXXX (Crockford-ish, no ambiguous chars). */
export function generateGiftCardCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i]! % alphabet.length];
  return `GC-${out.slice(0, 4)}-${out.slice(4)}`;
}

export function fmtNaira(cents: number, currency = "NGN"): string {
  const sym = currency === "NGN" ? "₦" : `${currency} `;
  return `${sym}${(cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
}

/** Notify the purchaser/holder on BOTH channels (WA original path + telegram). */
async function notifyHolder(tenantId: string, ref: string, text: string, extra?: Record<string, unknown>): Promise<void> {
  try {
    const { sendCustomerText } = await import("./channelParity");
    await sendCustomerText(tenantId, ref, GIFT_CARD_CATEGORY, text, { notifType: GIFT_CARD_CATEGORY, ...extra });
  } catch (e: any) {
    console.warn("[giftCards] holder notify failed:", e?.message);
  }
}

// ─── Purchase (existing payment-intent path) ─────────────────────────────────

export interface PurchaseGiftCardInput {
  amountCents: number;
  currency?: string;
  /** E.164 phone or telegram:<chatId> of the buyer (nullable — walk-in). */
  purchaserRef?: string | null;
  expiresAt?: Date | null;
  db?: Db;
}

export interface PurchaseGiftCardResult {
  giftCardId: string;
  reference: string;
  paymentUrl: string | null;
  amountCents: number;
  currency: string;
}

/**
 * Start a gift-card purchase: a payment_intents row keyed by the PSP
 * reference (metadata.kind='gift_card_purchase') + a PSP checkout link via
 * the tenant's provider fallback chain. The card materializes ONLY in the
 * webhook hook after verified payment.
 */
export async function purchaseGiftCard(tenantId: string, input: PurchaseGiftCardInput): Promise<PurchaseGiftCardResult> {
  const d = await resolveDb(input.db);
  await assertActive(tenantId, d);
  const amountCents = input.amountCents;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "amountCents must be a positive integer" });
  }
  const currency = input.currency ?? "NGN";
  const giftCardId = crypto.randomUUID();
  const code = generateGiftCardCode();
  const reference = `GC-${Date.now()}-${giftCardId.slice(0, 8).toUpperCase()}`;
  const metadata: Record<string, unknown> = {
    kind: "gift_card_purchase",
    giftCardId,
    code,
    amountCents,
    tenantId,
    purchaserCustomerId: input.purchaserRef ?? null,
    expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
  };
  await d.insert(paymentIntents).values({
    id: giftCardId, // NOT NULL id; the card id stands in (fulfilled by the hook)
    tenantId,
    orderId: giftCardId, // NOT NULL varchar(36); the card id stands in (no storefront order — AR-invoice pattern)
    customerId: String(input.purchaserRef ?? giftCardId).slice(0, 36),
    amount: (amountCents / 100).toFixed(2),
    currency,
    provider: "paystack",
    providerPaymentId: reference,
    idempotencyKey: `giftcard-purchase:${reference}`,
    metadata,
  });

  const { initiateWithFallback } = await import("./payments/initiateWithFallback");
  const outcome = await initiateWithFallback(tenantId, {
    tenantId,
    amountCents,
    currency,
    reference,
    metadata,
    customer: { phone: String(input.purchaserRef ?? "").replace(/^telegram:/i, "") },
  });
  const paymentUrl = outcome.result.authorizationUrl ?? null;
  if (input.purchaserRef && paymentUrl) {
    await notifyHolder(tenantId, input.purchaserRef,
      `🎁 Your gift card purchase (${fmtNaira(amountCents, currency)}) is ready — complete payment here: ${paymentUrl}\nThe card activates as soon as payment clears.`,
      { paymentUrl });
  }
  return { giftCardId, reference, paymentUrl, amountCents, currency };
}

/**
 * Adjacent webhook seam (wired next to the W31/W41 hooks in
 * server/_core/index.ts — paymentConfirm.ts untouched). Runs AFTER the
 * pinned confirmProviderPayment completed the intent; creates the card
 * exactly once (claim = gift_card_transactions 'purchase' row keyed
 * purchase:<reference>, UNIQUE idempotency_key). Never throws.
 */
export async function runGiftCardPurchaseWebhookHook(
  db: Db,
  args: { provider: string; reference: string },
): Promise<{ handled: boolean; giftCardId?: string; duplicate?: boolean }> {
  try {
    const rows = (await db.execute(sql`
      SELECT id, "tenantId", status, metadata FROM payment_intents
      WHERE "providerPaymentId" = ${args.reference} LIMIT 1`)) as unknown as any[];
    const intent = (Array.isArray(rows) ? rows : (rows as any).rows ?? [])[0];
    const meta = (intent?.metadata ?? null) as Record<string, unknown> | null;
    if (!intent || meta?.kind !== "gift_card_purchase") return { handled: false };
    if (intent.status !== "completed") {
      console.warn(`[giftCards] purchase hook: intent ${intent.id} not completed (status=${intent.status}) — no card issued`);
      return { handled: false };
    }
    const tenantId = intent.tenantId as string;
    const amountCents = Number(meta.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      console.warn("[giftCards] purchase hook: bad amountCents in intent metadata");
      return { handled: false };
    }
    const giftCardId = String(meta.giftCardId);
    const code = String(meta.code ?? generateGiftCardCode());
    const currency = String((await d_currency(db, tenantId)) ?? "NGN");
    const purchaser = (meta.purchaserCustomerId as string | null) ?? null;

    const created = await db.transaction(async (tx) => {
      // Claim first: the unique idempotency key is the exactly-once fence.
      const claim = (await tx.execute(sql`
        INSERT INTO gift_card_transactions (gift_card_id, tenant_id, type, amount_cents, idempotency_key, note)
        VALUES (${giftCardId}::uuid, ${tenantId}, 'purchase', ${amountCents}, ${`purchase:${args.reference}`}, ${`provider=${args.provider}`})
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id`)) as unknown as any[];
      const claimRows = Array.isArray(claim) ? claim : (claim as any).rows ?? [];
      if (claimRows.length === 0) return null; // replay — card already issued
      await tx.execute(sql`
        INSERT INTO gift_cards (id, tenant_id, code, initial_balance_cents, balance_cents, currency, purchaser_customer_id, status, expires_at)
        VALUES (${giftCardId}::uuid, ${tenantId}, ${code}, ${amountCents}, ${amountCents}, ${currency}, ${purchaser}, 'active',
                ${typeof meta.expiresAt === "string" ? meta.expiresAt : null})
        ON CONFLICT (id) DO NOTHING`);
      return giftCardId;
    });
    if (!created) return { handled: true, giftCardId, duplicate: true };

    if (purchaser) {
      await notifyHolder(tenantId, purchaser,
        `🎁 Payment received — your gift card is ACTIVE!\nCode: *${code}*\nBalance: ${fmtNaira(amountCents, currency)}\nUse it at checkout with "USE GIFT CARD ${code}". Check it anytime with "GIFT CARD BALANCE ${code}".`);
    }
    return { handled: true, giftCardId };
  } catch (e: any) {
    console.warn("[giftCards] purchase webhook hook failed:", e?.message);
    return { handled: false };
  }
}

async function d_currency(db: Db, tenantId: string): Promise<string | null> {
  const [t] = await db.select({ c: tenants.defaultCurrency }).from(tenants).where(eq(tenants.id, tenantId)).limit(1).catch(() => [] as any[]);
  return t?.c ?? null;
}

// ─── Redeem (claim-first) ────────────────────────────────────────────────────

export interface RedeemResult {
  ok: boolean;
  duplicate?: boolean;
  appliedCents?: number;
  balanceCents?: number;
  status?: string;
  error?: string;
  code?: string;
}

/**
 * Debit a gift card claim-first. Insufficient funds / disabled / expired /
 * depleted → { ok:false, error } (router maps insufficient_funds and state
 * errors to CONFLICT). Idempotent on idempotencyKey: a retry returns the
 * ORIGINAL redemption without moving money twice.
 */
export async function redeemGiftCard(
  tenantId: string,
  code: string,
  amountCents: number,
  opts: { orderId?: string | null; idempotencyKey: string; db?: DbOrTx },
): Promise<RedeemResult> {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: "amountCents must be a positive integer" };
  }
  const normalized = code.trim().toUpperCase();
  const d = await resolveDb(opts.db);
  return d.transaction(async (tx) => {
    // Idempotent retry short-circuit (claim row already exists).
    const seen = (await tx.execute(sql`
      SELECT amount_cents FROM gift_card_transactions WHERE idempotency_key = ${opts.idempotencyKey} LIMIT 1`)) as unknown as any[];
    const seenRows = Array.isArray(seen) ? seen : (seen as any).rows ?? [];
    if (seenRows.length > 0) {
      const card = await getGiftCardByCode(tenantId, normalized, tx);
      return { ok: true, duplicate: true, appliedCents: seenRows[0].amount_cents, balanceCents: card?.balanceCents ?? 0, status: card?.status, code: normalized };
    }
    const rows = (await tx.execute(sql`
      SELECT * FROM gift_cards WHERE tenant_id = ${tenantId} AND code = ${normalized} FOR UPDATE`)) as unknown as any[];
    const card = (Array.isArray(rows) ? rows : (rows as any).rows ?? [])[0];
    if (!card) return { ok: false, error: "gift_card_not_found", code: normalized };
    if (card.status === "disabled") return { ok: false, error: "gift_card_disabled", code: normalized };
    if (card.status === "depleted") return { ok: false, error: "gift_card_depleted", balanceCents: 0, code: normalized };
    if (card.expires_at && new Date(card.expires_at).getTime() <= Date.now()) {
      await tx.execute(sql`UPDATE gift_cards SET status = 'expired' WHERE id = ${card.id}`);
      return { ok: false, error: "gift_card_expired", code: normalized };
    }
    // Claim-first guarded debit — concurrent redeems serialize on the row
    // lock and the WHERE re-checks solvency. Never negative (CHECK backstop).
    const up = (await tx.execute(sql`
      UPDATE gift_cards SET balance_cents = balance_cents - ${amountCents}
      WHERE id = ${card.id} AND balance_cents >= ${amountCents}
      RETURNING balance_cents`)) as unknown as any[];
    const upRows = Array.isArray(up) ? up : (up as any).rows ?? [];
    if (upRows.length === 0) {
      return { ok: false, error: "insufficient_funds", balanceCents: card.balance_cents, code: normalized };
    }
    const balanceCents = Number(upRows[0].balance_cents);
    const nextStatus = balanceCents === 0 ? "depleted" : "redeemed_partially";
    await tx.execute(sql`UPDATE gift_cards SET status = ${nextStatus} WHERE id = ${card.id}`);
    await tx.execute(sql`
      INSERT INTO gift_card_transactions (gift_card_id, tenant_id, type, amount_cents, order_id, idempotency_key)
      VALUES (${card.id}, ${tenantId}, 'redeem', ${amountCents}, ${opts.orderId ?? null}, ${opts.idempotencyKey})`);
    return { ok: true, appliedCents: amountCents, balanceCents, status: nextStatus, code: normalized };
  });
}

export interface GiftCardCheckoutApplication {
  ok: boolean;
  error?: string;
  code?: string;
  appliedCents: number;
  remainderCents: number;
  balanceCents?: number;
  orderPaidInFull?: boolean;
  duplicate?: boolean;
}

/**
 * Redeem at checkout alongside wallet/split (same claim-first, idempotent
 * per order+code pattern): applies min(card balance, order remainder) to the
 * order; when the remainder hits ₦0 the order flips to paid through the
 * SAME status transition the split-session confirm uses, and the referral
 * reward hook fires (order PAID). The caller collects any PSP remainder via
 * the existing payment-link path.
 */
export async function applyGiftCardToOrder(
  tenantId: string,
  code: string,
  orderId: string,
  opts: { customerRef?: string | null; db?: Db } = {},
): Promise<GiftCardCheckoutApplication> {
  const d = await resolveDb(opts.db);
  await assertActive(tenantId, d);
  const [order] = await d.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId))).limit(1);
  if (!order) return { ok: false, error: "order_not_found", appliedCents: 0, remainderCents: 0 };
  const totalCents = Math.round(parseFloat(String(order.totalAmount)) * 100);
  // Remainder = total minus all prior gift-card redemptions on this order.
  const sumRows = (await d.execute(sql`
    SELECT COALESCE(SUM(amount_cents), 0)::int AS applied FROM gift_card_transactions
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND type = 'redeem'`)) as unknown as any[];
  const priorApplied = Number((Array.isArray(sumRows) ? sumRows : (sumRows as any).rows ?? [])[0]?.applied ?? 0);
  const remainderBefore = Math.max(0, totalCents - priorApplied);

  // Same card re-applied to the same order → the ORIGINAL application
  // (per-order idempotency key), never a second debit.
  const priorKeyRows = (await d.execute(sql`
    SELECT amount_cents FROM gift_card_transactions
    WHERE idempotency_key = ${giftCardRedeemKey(orderId, code)} LIMIT 1`)) as unknown as any[];
  const priorKey = (Array.isArray(priorKeyRows) ? priorKeyRows : (priorKeyRows as any).rows ?? [])[0];
  if (priorKey) {
    const cardNow = await getGiftCardByCode(tenantId, code, d);
    return {
      ok: true, duplicate: true, code: code.trim().toUpperCase(),
      appliedCents: Number(priorKey.amount_cents), remainderCents: remainderBefore,
      balanceCents: cardNow?.balanceCents ?? 0,
      orderPaidInFull: remainderBefore === 0,
    };
  }

  const card = await getGiftCardByCode(tenantId, code, d);
  if (!card) return { ok: false, error: "gift_card_not_found", appliedCents: 0, remainderCents: remainderBefore };
  const amount = Math.min(card.balanceCents, remainderBefore);
  if (amount <= 0) {
    return { ok: false, error: card.balanceCents <= 0 ? "gift_card_depleted" : "nothing_to_apply", appliedCents: 0, remainderCents: remainderBefore, balanceCents: card.balanceCents };
  }
  const res = await redeemGiftCard(tenantId, code, amount, {
    orderId,
    idempotencyKey: giftCardRedeemKey(orderId, code),
    db: d,
  });
  if (!res.ok) {
    return { ok: false, error: res.error, appliedCents: 0, remainderCents: remainderBefore, balanceCents: res.balanceCents, code: res.code };
  }
  const appliedTotal = priorApplied + (res.duplicate ? 0 : res.appliedCents!);
  const remainderCents = Math.max(0, totalCents - appliedTotal);
  let orderPaidInFull = false;
  if (remainderCents === 0 && !res.duplicate) {
    // Fully covered by gift card(s): confirm the order (split-session pattern)
    // and fire the W44 referral reward hook for the now-PAID order.
    await d.update(orders)
      .set({ status: "confirmed", paymentStatus: "completed", updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId), eq(orders.paymentStatus, "unpaid")));
    orderPaidInFull = true;
    try {
      const { rewardReferralForPaidOrder } = await import("./referrals");
      await rewardReferralForPaidOrder(d, { tenantId, orderId });
    } catch (e: any) {
      console.warn("[giftCards] referral reward hook failed:", e?.message);
    }
  }
  return {
    ok: true, code: res.code, appliedCents: res.appliedCents!, remainderCents,
    balanceCents: res.balanceCents, orderPaidInFull, duplicate: res.duplicate,
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function getGiftCardByCode(tenantId: string, code: string, db?: DbOrTx): Promise<GiftCard | null> {
  const d = await resolveDb(db);
  const [row] = await d.select().from(giftCards)
    .where(and(eq(giftCards.tenantId, tenantId), eq(giftCards.code, code.trim().toUpperCase())))
    .limit(1);
  return row ?? null;
}

export async function getGiftCardBalance(tenantId: string, code: string, db?: DbOrTx): Promise<{ balanceCents: number; status: string; currency: string; expiresAt: Date | null } | null> {
  const card = await getGiftCardByCode(tenantId, code, db);
  if (!card) return null;
  return { balanceCents: card.balanceCents, status: card.status, currency: card.currency, expiresAt: card.expiresAt };
}

export async function listGiftCards(tenantId: string, db?: DbOrTx, limit = 50): Promise<GiftCard[]> {
  const d = await resolveDb(db);
  return d.select().from(giftCards).where(eq(giftCards.tenantId, tenantId)).orderBy(desc(giftCards.createdAt)).limit(limit);
}

// ─── Merchant operations (tRPC surface) ──────────────────────────────────────

/** Merchant issue: creates an ACTIVE card directly (no payment) + audit row. */
export async function issueGiftCard(
  tenantId: string,
  input: { amountCents: number; currency?: string; customerId?: string | null; expiresAt?: Date | null; actor: string; note?: string },
  db?: Db,
): Promise<GiftCard> {
  const d = await resolveDb(db);
  await assertActive(tenantId, d);
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "amountCents must be a positive integer" });
  }
  const id = crypto.randomUUID();
  const code = generateGiftCardCode();
  const currency = input.currency ?? "NGN";
  const [card] = await d.insert(giftCards).values({
    id, tenantId, code,
    initialBalanceCents: input.amountCents,
    balanceCents: input.amountCents,
    currency,
    purchaserCustomerId: input.customerId ?? null,
    status: "active",
    expiresAt: input.expiresAt ?? null,
  }).returning();
  await d.insert(giftCardTransactions).values({
    giftCardId: id, tenantId, type: "adjust", amountCents: input.amountCents,
    idempotencyKey: `issue:${id}`,
    note: `merchant issue by ${input.actor}${input.note ? `: ${input.note}` : ""}`,
  });
  await writeGiftCardAudit(tenantId, input.actor, "gift_card.issued", id, `code=${code} amountCents=${input.amountCents}${input.note ? ` note=${input.note}` : ""}`);
  if (input.customerId) {
    await notifyHolder(tenantId, input.customerId,
      `🎁 The store issued you a gift card!\nCode: *${code}*\nBalance: ${fmtNaira(input.amountCents, currency)}\nRedeem at checkout with "USE GIFT CARD ${code}".`);
  }
  return card!;
}

/** Merchant disable: claim-first status flip; non-active cards CONFLICT. */
export async function disableGiftCard(tenantId: string, code: string, actor: string, db?: Db): Promise<GiftCard> {
  const d = await resolveDb(db);
  await assertActive(tenantId, d);
  const rows = (await d.execute(sql`
    UPDATE gift_cards SET status = 'disabled'
    WHERE tenant_id = ${tenantId} AND code = ${code.trim().toUpperCase()} AND status IN ('active','redeemed_partially')
    RETURNING *`)) as unknown as any[];
  const list = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
  if (list.length === 0) {
    const existing = await getGiftCardByCode(tenantId, code, d);
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "gift card not found" });
    throw new TRPCError({ code: "CONFLICT", message: `gift card is already ${existing.status}` });
  }
  await writeGiftCardAudit(tenantId, actor, "gift_card.disabled", list[0].id, `code=${code.trim().toUpperCase()}`);
  return list[0] as GiftCard;
}

/**
 * Merchant adjust: signed delta (integer cents) applied claim-first
 * (negative deltas are guarded so the balance can never go below 0) with an
 * append-only audit row (gift_card_transactions type='adjust' + note) and an
 * audit_logs entry. Disabled cards stay disabled (adjust never re-enables).
 */
export async function adjustGiftCard(
  tenantId: string,
  code: string,
  deltaCents: number,
  actor: string,
  note: string,
  db?: Db,
  idempotencyKey?: string,
): Promise<{ card: GiftCard; balanceCents: number }> {
  const d = await resolveDb(db);
  await assertActive(tenantId, d);
  if (!Number.isInteger(deltaCents) || deltaCents === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "deltaCents must be a non-zero integer" });
  }
  const normalized = code.trim().toUpperCase();
  // Every other money path in this file (purchase/redeem/issue) derives a
  // deterministic idempotency_key from the underlying transaction so a retry
  // replays instead of double-applying (gift_card_tx_idempotency_uidx is a
  // real unique index — see file header). A manual adjustment has no natural
  // source transaction to key off, so idempotency here is opt-in: honor a
  // caller-supplied key (a retried request should resend the SAME key), and
  // fall back to a random one — never colliding, i.e. no protection — only
  // when the caller doesn't ask for it, preserving today's default behavior.
  const key = idempotencyKey ?? `adjust:${crypto.randomUUID()}`;
  const result = await d.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT * FROM gift_cards WHERE tenant_id = ${tenantId} AND code = ${normalized} FOR UPDATE`)) as unknown as any[];
    const card = (Array.isArray(rows) ? rows : (rows as any).rows ?? [])[0];
    if (!card) throw new TRPCError({ code: "NOT_FOUND", message: "gift card not found" });
    if (idempotencyKey) {
      const existing = (await tx.execute(sql`
        SELECT amount_cents FROM gift_card_transactions WHERE idempotency_key = ${key} LIMIT 1`)) as unknown as any[];
      const existingRows = Array.isArray(existing) ? existing : (existing as any).rows ?? [];
      if (existingRows.length > 0) {
        return { cardId: card.id as string, balanceCents: Number(card.balance_cents), replay: true as const };
      }
    }
    const guard = deltaCents > 0 ? sql`true` : sql`balance_cents >= ${-deltaCents}`;
    const up = (await tx.execute(sql`
      UPDATE gift_cards SET balance_cents = balance_cents + ${deltaCents}
      WHERE id = ${card.id} AND ${guard}
      RETURNING balance_cents`)) as unknown as any[];
    const upRows = Array.isArray(up) ? up : (up as any).rows ?? [];
    if (upRows.length === 0) {
      throw new TRPCError({ code: "CONFLICT", message: `insufficient_funds: balance ${card.balance_cents} cannot absorb ${deltaCents}` });
    }
    const balanceCents = Number(upRows[0].balance_cents);
    if (card.status !== "disabled") {
      const nextStatus = balanceCents === 0 ? "depleted" : balanceCents < card.initial_balance_cents ? "redeemed_partially" : "active";
      await tx.execute(sql`UPDATE gift_cards SET status = ${nextStatus} WHERE id = ${card.id}`);
    }
    await tx.execute(sql`
      INSERT INTO gift_card_transactions (gift_card_id, tenant_id, type, amount_cents, idempotency_key, note)
      VALUES (${card.id}, ${tenantId}, 'adjust', ${deltaCents}, ${key}, ${`${note} (by ${actor})`})`);
    return { cardId: card.id as string, balanceCents, replay: false as const };
  });
  if (!result.replay) {
    await writeGiftCardAudit(tenantId, actor, "gift_card.adjusted", result.cardId, `code=${normalized} deltaCents=${deltaCents} note=${note}`);
  }
  const card = (await getGiftCardByCode(tenantId, normalized, d))!;
  return { card, balanceCents: result.balanceCents };
}

async function writeGiftCardAudit(tenantId: string, actor: string, action: string, entityId: string, summary: string): Promise<void> {
  try {
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({ tenantId, actorId: actor, action, entityType: "gift_card", entityId, summary } as any);
  } catch (e: any) {
    console.warn("[giftCards] audit write failed:", e?.message);
  }
}
