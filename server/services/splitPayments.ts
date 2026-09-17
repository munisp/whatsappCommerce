/**
 * === W41 (Coder B, UC-3) — split payments / group contributions ===
 *
 * ONE order co-funded by N buyers. Each participant gets a computed share
 * and pays via PSP payment link or wallet. Money discipline:
 *   - integer cents; shares split deterministically (floor + remainder to
 *     the FIRST participant) so Σshares === target exactly;
 *   - the funding tally is claim-first: contributions mutate the session
 *     inside one tx holding SELECT ... FOR UPDATE on the session row, so
 *     concurrent payments can never double-fund or lose an update;
 *   - the order confirms ONLY when funded_cents >= target_cents
 *     (confirmSplitIfFunded is itself a claim-first status transition);
 *   - timeout (default 48h): the sweep claims open+expired sessions
 *     (guarded UPDATE) and auto-refunds every contribution — wallet credit
 *     by default, PSP reversal optional per call-site;
 *   - invites go out on BOTH channels via notifyCustomer/sendCustomerText.
 */
import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../db";
import { splitPaymentSessions, orders } from "../../drizzle/schema";
import { creditWallet, debitWallet, walletBalance, type Db, type DbOrTx } from "./customerWallet";
import { sendCustomerText } from "./channelParity";

export const SPLIT_SESSION_DEFAULT_TTL_MS = 48 * 60 * 60 * 1000; // 48h

export interface SplitParticipant {
  phone: string;
  shareCents: number;
  paidCents: number;
  /** wallet | link (PSP payment link) — last used method. */
  method?: "wallet" | "link";
  /** PSP reference for link payments (needed for optional PSP reversal). */
  reference?: string;
  /** pending | paid | refunded */
  status: "pending" | "paid" | "refunded";
}

/** Deterministic shares: floor split, remainder kobo to the first participant. */
export function computeShares(targetCents: number, phones: string[]): SplitParticipant[] {
  if (!Number.isInteger(targetCents) || targetCents <= 0) throw new Error("targetCents must be a positive integer");
  if (phones.length === 0) throw new Error("at least one participant required");
  const base = Math.floor(targetCents / phones.length);
  const remainder = targetCents - base * phones.length;
  return phones.map((phone, i) => ({
    phone,
    shareCents: base + (i === 0 ? remainder : 0),
    paidCents: 0,
    status: "pending" as const,
  }));
}

async function resolveDb(db?: DbOrTx): Promise<Db> {
  if (db) return db as Db;
  const real = await getDb();
  if (!real) throw new Error("splitPayments: db unavailable");
  return real;
}

export interface CreateSplitResult {
  sessionId: string;
  participants: SplitParticipant[];
  expiresAt: Date;
}

/**
 * Create the session and message every participant on their channel
 * (WhatsApp/Telegram parity via sendCustomerText — best-effort, never
 * blocks session creation).
 */
export async function createSplitSession(
  tenantId: string,
  orderId: string,
  targetCents: number,
  participantPhones: string[],
  opts: { ttlMs?: number; db?: Db } = {},
): Promise<CreateSplitResult> {
  const d = await resolveDb(opts.db);
  const participants = computeShares(targetCents, participantPhones);
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? SPLIT_SESSION_DEFAULT_TTL_MS));
  const [row] = await d
    .insert(splitPaymentSessions)
    .values({
      tenantId,
      orderId,
      targetCents,
      participantCount: participants.length,
      participants,
      status: "open",
      expiresAt,
    })
    .returning({ id: splitPaymentSessions.id });
  const sessionId = row!.id;
  const totalNaira = (targetCents / 100).toFixed(2);
  for (const p of participants) {
    const shareNaira = (p.shareCents / 100).toFixed(2);
    await sendCustomerText(
      tenantId,
      p.phone,
      "split_invite",
      `You've been invited to split order ${orderId}: your share is ₦${shareNaira} of ₦${totalNaira}. Reply PAY SPLIT ${sessionId} to pay from your wallet, or ask for a payment link. Expires in 48h.`,
      { notifType: "split_invite", orderId },
    ).catch((e) => console.warn("[splitPayments] invite send failed:", e?.message));
  }
  return { sessionId, participants, expiresAt };
}

export interface ContributeResult {
  ok: boolean;
  error?: string;
  fundedCents?: number;
  targetCents?: number;
  fullyFunded?: boolean;
  walletBalanceCents?: number;
}

/**
 * Record one participant's contribution. Claim-first: the session row is
 * locked FOR UPDATE inside the tx; the wallet debit (when method='wallet')
 * is itself claim-first and can never overdraw. Link (PSP) contributions
 * pass the provider reference after the PSP webhook verified the charge —
 * this service never trusts unverified client claims.
 */
export async function contributeSplit(
  sessionId: string,
  phone: string,
  amountCents: number,
  method: "wallet" | "link",
  reference?: string,
  db?: Db,
): Promise<ContributeResult> {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: "amountCents must be a positive integer" };
  }
  const d = await resolveDb(db);
  return d.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT * FROM split_payment_sessions WHERE id = ${sessionId} FOR UPDATE`)) as unknown as any[];
    const session = (Array.isArray(rows) ? rows : (rows as any).rows ?? [])[0];
    if (!session) return { ok: false, error: "session_not_found" };
    if (session.status !== "open") return { ok: false, error: `session_${session.status}` };
    if (new Date(session.expires_at).getTime() <= Date.now()) return { ok: false, error: "session_expired" };

    const participants = session.participants as SplitParticipant[];
    const p = participants.find((x) => x.phone === phone);
    if (!p) return { ok: false, error: "not_a_participant" };
    const dueCents = p.shareCents - p.paidCents;
    if (amountCents > dueCents) return { ok: false, error: "exceeds_share", fundedCents: session.funded_cents };

    let walletBalanceCents: number | undefined;
    if (method === "wallet") {
      const debit = await debitWallet(
        session.tenant_id, phone, amountCents, "split_contribution",
        `split:${sessionId}:${phone}:${p.paidCents + amountCents}`,
        tx as unknown as DbOrTx, { sessionId },
      );
      if (!debit.ok) return { ok: false, error: debit.error, walletBalanceCents: debit.balanceCents };
      walletBalanceCents = debit.balanceCents;
    }

    p.paidCents += amountCents;
    p.method = method;
    if (reference) p.reference = reference;
    if (p.paidCents >= p.shareCents) p.status = "paid";
    const fundedCents = participants.reduce((s, x) => s + x.paidCents, 0);
    const fullyFunded = fundedCents >= session.target_cents;
    await tx
      .update(splitPaymentSessions)
      .set({ participants, fundedCents, status: fullyFunded ? "funded" : "open", updatedAt: new Date() })
      .where(eq(splitPaymentSessions.id, sessionId));
    return { ok: true, fundedCents, targetCents: session.target_cents, fullyFunded, walletBalanceCents };
  });
}

/**
 * Confirm the order once fully funded. Claim-first status transition —
 * only ONE concurrent caller flips funded→confirmed and releases the order.
 */
export async function confirmSplitIfFunded(sessionId: string, db?: Db): Promise<{ confirmed: boolean; orderId?: string; error?: string }> {
  const d = await resolveDb(db);
  return d.transaction(async (tx) => {
    const claimed = (await tx.execute(sql`
      UPDATE split_payment_sessions
      SET status = 'confirmed', updated_at = now()
      WHERE id = ${sessionId} AND status = 'funded' AND funded_cents >= target_cents
      RETURNING order_id, tenant_id`)) as unknown as any[];
    const rows = Array.isArray(claimed) ? claimed : (claimed as any).rows ?? [];
    if (rows.length === 0) return { confirmed: false, error: "not_fully_funded" };
    const { order_id: orderId, tenant_id: tenantId } = rows[0];
    await tx
      .update(orders)
      .set({ status: "confirmed", paymentStatus: "completed", updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)));
    return { confirmed: true, orderId };
  });
}

export interface SplitRefundSweepResult {
  sessionsRefunded: number;
  creditsIssued: number;
  pspReversalsRequested: number;
}

/**
 * Timeout sweep: claims open+expired sessions (guarded UPDATE open→refunding
 * so concurrent sweeps can't double-refund) and auto-refunds every
 * contribution — WALLET CREDIT is the default rail (always available);
 * PSP reversal is optional (opts.pspRefund) and only attempted for
 * link-method contributions with a verified reference. Fail-closed: a PSP
 * reversal failure falls back to wallet credit, money is never stranded.
 */
export async function sweepExpiredSplitSessions(
  opts: {
    now?: Date;
    db?: Db;
    pspRefund?: (args: { tenantId: string; reference: string; amountCents: number }) => Promise<boolean>;
  } = {},
): Promise<SplitRefundSweepResult> {
  const d = await resolveDb(opts.db);
  const now = opts.now ?? new Date();
  const claimed = (await d.execute(sql`
    UPDATE split_payment_sessions
    SET status = 'refunding', updated_at = now()
    WHERE status = 'open' AND expires_at <= ${now.toISOString()}
    RETURNING *`)) as unknown as any[];
  const sessions = (Array.isArray(claimed) ? claimed : (claimed as any).rows ?? []) as any[];
  let creditsIssued = 0;
  let pspReversalsRequested = 0;
  for (const s of sessions) {
    const participants = s.participants as SplitParticipant[];
    for (const p of participants) {
      if (p.paidCents <= 0 || p.status === "refunded") continue;
      let refunded = false;
      if (opts.pspRefund && p.method === "link" && p.reference) {
        pspReversalsRequested++;
        try {
          refunded = await opts.pspRefund({ tenantId: s.tenant_id, reference: p.reference, amountCents: p.paidCents });
        } catch (e: any) {
          console.warn("[splitPayments] psp reversal failed, falling back to wallet:", e?.message);
        }
      }
      if (!refunded) {
        const credit = await creditWallet(
          s.tenant_id, p.phone, p.paidCents, "split_refund",
          `splitrefund:${s.id}:${p.phone}`, d, { sessionId: s.id, orderId: s.order_id },
        );
        if (!credit.ok) throw new Error(`split refund credit failed for ${p.phone}: ${credit.error}`);
        creditsIssued++;
      }
      p.status = "refunded";
    }
    await d
      .update(splitPaymentSessions)
      .set({ participants, status: "refunded", updatedAt: new Date() })
      .where(eq(splitPaymentSessions.id, s.id));
    await d
      .update(orders)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(orders.id, s.order_id), eq(orders.tenantId, s.tenant_id)));
    // Notify every contributor on their channel (WA/TG parity).
    for (const p of participants) {
      if (p.paidCents <= 0) continue;
      await sendCustomerText(
        s.tenant_id, p.phone, "split_refund",
        `The split payment for order ${s.order_id} timed out before it was fully funded — your ₦${(p.paidCents / 100).toFixed(2)} has been refunded to your wallet.`,
        { notifType: "split_refund", orderId: s.order_id },
      ).catch((e) => console.warn("[splitPayments] refund notice failed:", e?.message));
    }
  }
  return { sessionsRefunded: sessions.length, creditsIssued, pspReversalsRequested };
}

/** Read-side helper for chat intents ("split status"). */
export async function getSplitSession(sessionId: string, db?: DbOrTx) {
  const d = await resolveDb(db);
  const [row] = await d.select().from(splitPaymentSessions).where(eq(splitPaymentSessions.id, sessionId)).limit(1);
  return row ?? null;
}

export { walletBalance };
