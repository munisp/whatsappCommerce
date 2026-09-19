/**
 * === W41 (Coder B, UC-2) — customer wallet / store credit ===
 *
 * Per-tenant per-customer store credit with an APPEND-ONLY ledger
 * (customer_wallet_entries). Money discipline:
 *   - integer cents (NGN kobo) everywhere; never negative;
 *   - debits are claim-first guarded UPDATEs (`balance_cents >= amount`)
 *     so concurrent spends can never overdraw (journeys J295/J296 race it);
 *   - every mutation is idempotent on (refId, direction) — retries are
 *     safe by construction (unique index backstop);
 *   - refund-to-wallet respects the W38 cumulative refund caps: the wallet
 *     credit inserts a `refunds` row (status 'processed', metadata.method
 *     'wallet') so it counts toward the refunded total exactly like a PSP
 *     reversal (J294).
 *
 * BINDING CONTRACTS consumed by Coder A (installment/token one-tap) and
 * Coder C (RMA refund_to_wallet): creditWallet / debitWallet / walletBalance.
 * Signatures (db is optional, defaulting to getDb()):
 *   creditWallet(tenantId, customerRef, amountCents, reason, refId, db?)
 *   debitWallet(tenantId, customerRef, amountCents, reason, refId, db?)
 *   walletBalance(tenantId, customerRef, db?)
 */
import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../db";
import { customerWallets, customerWalletEntries, orders, refunds } from "../../drizzle/schema";

export type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type DbOrTx = Pick<Db, "execute" | "select" | "insert" | "update" | "transaction">;

export type WalletCreditReason =
  | "refund_to_wallet"
  | "merchant_goodwill"
  | "overpayment"
  | "split_refund"
  | "topup"
  // === W44 giftcards-referrals (additive): referrer reward on referee PAID order ===
  | "referral_reward"
  // === W46 uc-docs (additive): UC-20 agent commission payout ===
  | "agent_commission";

export type WalletDebitReason =
  | "checkout_spend"
  | "split_contribution"
  | "installment_charge"
  // === W43 dispatch (additive): post-dispatch address-change fee ===
  | "address_change_fee"
  // === W44 deposits-subs-digital (additive): appointment remainder ===
  | "appointment_remainder"
  // === W47 stakeholders (additive): ONB-S-13 referral reward clawback on refund ===
  | "referral_clawback";

export interface WalletOpResult {
  ok: boolean;
  /** true when refId+direction already existed — no money moved twice. */
  duplicate?: boolean;
  balanceCents?: number;
  entryId?: string;
  error?: string;
}

/** Wallet identity key: customers are referenced by E.164 phone. */
function refToPhone(customerRef: string | { phone?: string | null }): string {
  const phone = typeof customerRef === "string" ? customerRef : (customerRef.phone ?? "");
  if (!phone) throw new Error("customerRef must resolve to a phone");
  return phone;
}

async function resolveDb(db?: DbOrTx): Promise<Db> {
  if (db) return db as Db;
  const real = await getDb();
  if (!real) throw new Error("customerWallet: db unavailable");
  return real;
}

/** Current balance in integer cents (0 when no wallet row exists yet). */
export async function walletBalance(
  tenantId: string,
  customerRef: string | { phone?: string | null },
  db?: DbOrTx,
): Promise<number> {
  const phone = refToPhone(customerRef);
  const d = await resolveDb(db);
  const rows = await d
    .select({ balanceCents: customerWallets.balanceCents })
    .from(customerWallets)
    .where(and(eq(customerWallets.tenantId, tenantId), eq(customerWallets.customerPhone, phone)))
    .limit(1);
  return rows[0]?.balanceCents ?? 0;
}

/**
 * Credit the wallet exactly once on (refId, 'credit'). Claim order inside one
 * tx: insert the ledger claim row first (ON CONFLICT DO NOTHING) — a retry
 * hits the unique claim and moves NO money — then upsert the balance.
 */
export async function creditWallet(
  tenantId: string,
  customerRef: string | { phone?: string | null },
  amountCents: number,
  reason: WalletCreditReason,
  refId: string,
  db?: DbOrTx,
  metadata?: Record<string, unknown>,
): Promise<WalletOpResult> {
  const phone = refToPhone(customerRef);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: "amountCents must be a positive integer" };
  }
  const d = await resolveDb(db);
  return d.transaction(async (tx) => {
    // Ensure the wallet row exists so the entry FK + upsert are trivial.
    await tx.execute(sql`
      INSERT INTO customer_wallets (tenant_id, customer_phone, balance_cents)
      VALUES (${tenantId}, ${phone}, 0)
      ON CONFLICT (tenant_id, customer_phone) DO NOTHING`);
    const claim = (await tx.execute(sql`
      INSERT INTO customer_wallet_entries
        (tenant_id, wallet_id, customer_phone, direction, amount_cents, balance_after_cents, reason, ref_id, metadata)
      SELECT ${tenantId}, w.id, ${phone}, 'credit', ${amountCents}, w.balance_cents + ${amountCents}, ${reason}, ${refId},
             ${metadata ? JSON.stringify(metadata) : null}::jsonb
      FROM customer_wallets w
      WHERE w.tenant_id = ${tenantId} AND w.customer_phone = ${phone}
      ON CONFLICT (ref_id, direction) DO NOTHING
      RETURNING id`)) as unknown as { id: string }[];
    const claimRows = Array.isArray(claim) ? claim : (claim as any).rows ?? [];
    if (claimRows.length === 0) {
      const balanceCents = await walletBalance(tenantId, phone, tx as unknown as DbOrTx);
      return { ok: true, duplicate: true, balanceCents };
    }
    const up = (await tx.execute(sql`
      UPDATE customer_wallets
      SET balance_cents = balance_cents + ${amountCents}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND customer_phone = ${phone}
      RETURNING balance_cents`)) as unknown as { balance_cents: number | string }[];
    const upRows = Array.isArray(up) ? up : (up as any).rows ?? [];
    const balanceCents = Number(upRows[0]?.balance_cents ?? 0);
    return { ok: true, balanceCents, entryId: claimRows[0]!.id };
  });
}

/**
 * Debit the wallet claim-first: ONE guarded UPDATE whose WHERE re-checks
 * solvency, so concurrent debits serialize and the balance can NEVER go
 * negative (DB CHECK constraint is the fail-closed backstop). Idempotent on
 * (refId, 'debit').
 */
export async function debitWallet(
  tenantId: string,
  customerRef: string | { phone?: string | null },
  amountCents: number,
  reason: WalletDebitReason,
  refId: string,
  db?: DbOrTx,
  metadata?: Record<string, unknown>,
): Promise<WalletOpResult> {
  const phone = refToPhone(customerRef);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: "amountCents must be a positive integer" };
  }
  const d = await resolveDb(db);
  return d.transaction(async (tx) => {
    // Idempotent retry short-circuit: the ledger claim already exists.
    const seen = (await tx.execute(sql`
      SELECT id, balance_after_cents FROM customer_wallet_entries
      WHERE ref_id = ${refId} AND direction = 'debit' LIMIT 1`)) as unknown as any[];
    const seenRows = Array.isArray(seen) ? seen : (seen as any).rows ?? [];
    if (seenRows.length > 0) {
      const balanceCents = await walletBalance(tenantId, phone, tx as unknown as DbOrTx);
      return { ok: true, duplicate: true, balanceCents, entryId: seenRows[0].id };
    }
    // Claim-first guarded debit: fails (0 rows) when funds are insufficient.
    const up = (await tx.execute(sql`
      UPDATE customer_wallets
      SET balance_cents = balance_cents - ${amountCents}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND customer_phone = ${phone} AND balance_cents >= ${amountCents}
      RETURNING id, balance_cents`)) as unknown as { id: string; balance_cents: number | string }[];
    const upRows = Array.isArray(up) ? up : (up as any).rows ?? [];
    if (upRows.length === 0) {
      const balanceCents = await walletBalance(tenantId, phone, tx as unknown as DbOrTx);
      return { ok: false, error: "insufficient_funds", balanceCents };
    }
    const balanceCents = Number(upRows[0].balance_cents);
    const entry = await tx
      .insert(customerWalletEntries)
      .values({
        tenantId,
        walletId: upRows[0].id,
        customerPhone: phone,
        direction: "debit",
        amountCents,
        balanceAfterCents: balanceCents,
        reason,
        refId,
        metadata: metadata ?? null,
      })
      .returning({ id: customerWalletEntries.id });
    return { ok: true, balanceCents, entryId: entry[0]!.id };
  });
}

export interface RefundToWalletResult extends WalletOpResult {
  refundId?: string;
  cumulativeRefundedCents?: number;
}

/**
 * Refund-to-wallet seam (adjacent to the W30/W38 refund flow, NOT inside
 * paymentConfirm.ts): the buyer chose store credit instead of a PSP
 * reversal. Respects the W38 cumulative caps — the credit inserts a
 * `refunds` row (status 'processed', metadata.method='wallet') in the SAME
 * tx as the wallet credit, so it counts toward the order's refunded total
 * identically to a PSP refund. Fail-closed: anything over the cap is
 * rejected and NO money moves.
 */
export async function refundToWallet(
  tenantId: string,
  customerRef: string | { phone?: string | null },
  orderId: string,
  amountCents: number,
  actor: string,
  db?: Db,
): Promise<RefundToWalletResult> {
  const phone = refToPhone(customerRef);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: "amountCents must be a positive integer" };
  }
  const d = await resolveDb(db);
  return d.transaction(async (tx) => {
    // Lock the order row so concurrent refunds serialize on the cap check.
    const orderRows = (await tx.execute(sql`
      SELECT id, "totalAmount", "paymentStatus" FROM orders
      WHERE id = ${orderId} AND "tenantId" = ${tenantId} FOR UPDATE`)) as unknown as any[];
    const order = (Array.isArray(orderRows) ? orderRows : (orderRows as any).rows ?? [])[0];
    if (!order) return { ok: false, error: "order_not_found" };
    const orderTotalCents = Math.round(parseFloat(String(order.totalAmount)) * 100);

    // W38 PAY-1 cumulative guard (pending+approved+processed all count).
    const sumRows = (await tx.execute(sql`
      SELECT COALESCE(SUM(amount::numeric), 0)::text AS total FROM refunds
      WHERE "orderId" = ${orderId} AND "tenantId" = ${tenantId}
        AND status IN ('pending','approved','processed')`)) as unknown as any[];
    const priorCents = Math.round(parseFloat(String((Array.isArray(sumRows) ? sumRows : (sumRows as any).rows ?? [])[0]?.total ?? "0")) * 100);
    if (priorCents + amountCents > orderTotalCents) {
      return {
        ok: false,
        error: "refund_cap_exceeded",
        cumulativeRefundedCents: priorCents,
      };
    }

    const refundId = crypto.randomUUID();
    await tx.insert(refunds).values({
      id: refundId,
      orderId,
      tenantId,
      amount: (amountCents / 100).toFixed(2),
      currency: "NGN",
      reason: "refund_to_wallet",
      status: "processed",
      processedAt: new Date(),
      metadata: { method: "wallet", actor, walletRef: `refund_wallet:${refundId}` },
    });
    const credit = await creditWallet(
      tenantId, phone, amountCents, "refund_to_wallet", `refund_wallet:${refundId}`,
      tx as unknown as DbOrTx, { orderId, actor },
    );
    if (!credit.ok) throw new Error(`wallet credit failed: ${credit.error}`);

    // Full cumulative refund flips the order to refunded (W38 parity).
    if (priorCents + amountCents >= orderTotalCents) {
      await tx.update(orders).set({ paymentStatus: "refunded", updatedAt: new Date() })
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)));
    }
    return {
      ok: true,
      refundId,
      balanceCents: credit.balanceCents,
      cumulativeRefundedCents: priorCents + amountCents,
    };
  });
}

/**
 * Audited merchant goodwill adjustment: admin grants store credit. The audit
 * trail IS the append-only ledger row (actor + note in metadata) — the
 * ledger has no mutation path, so the grant can never be silently edited.
 */
export async function merchantGoodwillCredit(
  tenantId: string,
  customerRef: string | { phone?: string | null },
  amountCents: number,
  actor: string,
  note: string,
  db?: DbOrTx,
): Promise<WalletOpResult> {
  const refId = `goodwill:${crypto.randomUUID()}`;
  return creditWallet(tenantId, customerRef, amountCents, "merchant_goodwill", refId, db, { actor, note });
}

/**
 * Overpayment auto-credit: when a PAY charge settles above the order total
 * (see paymentConfirm underpayment/overpayment handling — adjacent seam,
 * callers pass the exact overpaid delta), the excess becomes store credit
 * instead of being stranded. Idempotent per (orderId, payment reference).
 */
export async function creditOverpayment(
  tenantId: string,
  customerRef: string | { phone?: string | null },
  orderId: string,
  overpaidCents: number,
  paymentReference: string,
  db?: DbOrTx,
): Promise<WalletOpResult> {
  return creditWallet(
    tenantId, customerRef, overpaidCents, "overpayment",
    `overpay:${orderId}:${paymentReference}`, db, { orderId },
  );
}

export interface WalletCheckoutApplication {
  appliedCents: number;
  remainderCents: number;
  balanceCents: number;
}

/**
 * Spend at checkout, wallet-first, partial allowed: drains up to
 * `orderTotalCents` from the wallet and returns the PSP remainder. The
 * caller then collects `remainderCents` via the normal PSP link (adjacent
 * seam in the checkout caller — paymentConfirm.ts untouched). Idempotent
 * per order.
 */
export async function applyWalletAtCheckout(
  tenantId: string,
  customerRef: string | { phone?: string | null },
  orderId: string,
  orderTotalCents: number,
  db?: DbOrTx,
): Promise<WalletCheckoutApplication> {
  const d = await resolveDb(db);
  const phone = refToPhone(customerRef);
  // Idempotent per order: a retry returns the ORIGINAL application instead
  // of double-charging the PSP remainder.
  const prior = await d
    .select({ amountCents: customerWalletEntries.amountCents })
    .from(customerWalletEntries)
    .where(and(
      eq(customerWalletEntries.tenantId, tenantId),
      eq(customerWalletEntries.refId, `checkout:${orderId}`),
      eq(customerWalletEntries.direction, "debit"),
    ))
    .limit(1);
  if (prior.length > 0) {
    const applied = prior[0]!.amountCents;
    return {
      appliedCents: applied,
      remainderCents: Math.round(orderTotalCents) - applied,
      balanceCents: await walletBalance(tenantId, phone, db),
    };
  }
  const balance = await walletBalance(tenantId, phone, db);
  const appliedCents = Math.min(balance, Math.max(0, Math.round(orderTotalCents)));
  if (appliedCents > 0) {
    const debit = await debitWallet(
      tenantId, customerRef, appliedCents, "checkout_spend", `checkout:${orderId}`, db, { orderId },
    );
    if (!debit.ok && !debit.duplicate) {
      // Lost a race for the balance — fail closed: no wallet application,
      // full remainder goes to PSP. Never negative by construction.
      return { appliedCents: 0, remainderCents: Math.round(orderTotalCents), balanceCents: debit.balanceCents ?? balance };
    }
    return {
      appliedCents,
      remainderCents: Math.round(orderTotalCents) - appliedCents,
      balanceCents: debit.balanceCents ?? balance - appliedCents,
    };
  }
  return { appliedCents: 0, remainderCents: Math.round(orderTotalCents), balanceCents: balance };
}
