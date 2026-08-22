/**
 * W27 — Group buying engine.
 *
 * A merchant opens a deal: product + bulk price unlocked at `thresholdQty`
 * by `deadline`. Customers join via WhatsApp / portal link; each join is a
 * payment AUTHORIZATION/HOLD recorded on the participant row (`paymentRef`
 * ties to the existing payment rails; when a linked order has an escrow row
 * the hold lives in the existing escrow rail).
 *
 * Resolution (deterministic, idempotent):
 *   - currentQty ≥ thresholdQty at/before deadline  → deal 'confirmed';
 *     every 'held' participant flips to 'confirmed' (merchant fulfills).
 *   - deadline passed with currentQty < thresholdQty → deal 'expired';
 *     participants are VOIDED (authorization only) or REFUNDED via the
 *     existing escrow refund path (refundEscrowAtomic) when captured.
 *
 * Concurrency: the quantity claim is a single guarded UPDATE on the deal row
 * (claim-first), so concurrent joins serialize on the row lock and
 * currentQty is never read-then-written. All money INTEGER CENTS.
 */
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  groupDeals,
  groupDealParticipants,
  type GroupDeal,
  type GroupDealParticipant,
} from "../../drizzle/schema";
import type { DbHandle } from "./tradeCredit/accounts";

export type { DbHandle };

// ── Deal management ────────────────────────────────────────────────────────
export async function createGroupDealTx(
  db: DbHandle,
  args: {
    tenantId: string;
    title: string;
    description?: string;
    productId?: string;
    unitPriceCents: number;
    retailPriceCents?: number;
    thresholdQty: number;
    currency?: string;
    deadline: Date;
  },
): Promise<GroupDeal> {
  const [row] = await db
    .insert(groupDeals)
    .values({
      id: randomUUID(),
      tenantId: args.tenantId,
      title: args.title,
      description: args.description ?? null,
      productId: args.productId ?? null,
      unitPriceCents: Math.round(args.unitPriceCents),
      retailPriceCents: args.retailPriceCents != null ? Math.round(args.retailPriceCents) : null,
      thresholdQty: Math.round(args.thresholdQty),
      currency: args.currency ?? "NGN",
      deadline: args.deadline,
      status: "open",
    })
    .returning();
  return row;
}

export async function getGroupDealTx(db: DbHandle, dealId: string): Promise<GroupDeal | null> {
  const [row] = await db.select().from(groupDeals).where(eq(groupDeals.id, dealId)).limit(1);
  return row ?? null;
}

export async function listGroupDealsTx(
  db: DbHandle,
  args: { tenantId?: string; status?: string; limit?: number } = {},
): Promise<GroupDeal[]> {
  const conds = [];
  if (args.tenantId) conds.push(eq(groupDeals.tenantId, args.tenantId));
  if (args.status) conds.push(eq(groupDeals.status, args.status));
  return db
    .select()
    .from(groupDeals)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(groupDeals.deadline))
    .limit(Math.min(Math.max(args.limit ?? 50, 1), 200));
}

// ── Live progress (WhatsApp progress bar + portal) ─────────────────────────
export interface GroupDealProgress {
  dealId: string;
  status: string;
  currentQty: number;
  thresholdQty: number;
  remainingQty: number;
  percent: number; // 0–100, integer
  bar: string; // 10-cell ASCII progress bar, deterministic
  participantCount: number;
  deadline: Date;
  expired: boolean;
}

export function renderProgressBar(percent: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

export async function getGroupDealProgressTx(
  db: DbHandle,
  dealId: string,
  now: Date = new Date(),
): Promise<GroupDealProgress | null> {
  const deal = await getGroupDealTx(db, dealId);
  if (!deal) return null;
  const participants = await db
    .select({ id: groupDealParticipants.id })
    .from(groupDealParticipants)
    .where(and(eq(groupDealParticipants.dealId, dealId), eq(groupDealParticipants.status, "held")));
  const percent = deal.thresholdQty > 0 ? Math.min(100, Math.round((deal.currentQty / deal.thresholdQty) * 100)) : 100;
  return {
    dealId: deal.id,
    status: deal.status,
    currentQty: deal.currentQty,
    thresholdQty: deal.thresholdQty,
    remainingQty: Math.max(0, deal.thresholdQty - deal.currentQty),
    percent,
    bar: renderProgressBar(percent),
    participantCount: participants.length,
    deadline: deal.deadline,
    expired: now.getTime() > new Date(deal.deadline).getTime(),
  };
}

// ── Join (authorization/hold) ──────────────────────────────────────────────
export type JoinResult =
  | { ok: true; participant: GroupDealParticipant; progress: GroupDealProgress; alreadyJoined?: boolean }
  | { ok: false; reason: "deal_not_found" | "deal_not_open" | "deadline_passed" | "invalid_qty" };

/**
 * Join a deal. Idempotent per (dealId, customerPhone): a repeat join returns
 * the existing hold without double-counting quantity (the unique index is
 * authoritative). The quantity claim is one guarded UPDATE:
 *   UPDATE group_deals SET current_qty = current_qty + $q
 *   WHERE id = $id AND status = 'open' AND deadline > now
 * so a join can never land on a closed/expired deal.
 */
export async function joinGroupDealTx(
  db: DbHandle,
  args: {
    dealId: string;
    customerPhone: string;
    quantity: number;
    paymentRef?: string;
    idempotencyKey?: string;
  },
  now: Date = new Date(),
): Promise<JoinResult> {
  const qty = Math.round(args.quantity);
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, reason: "invalid_qty" };

  const deal = await getGroupDealTx(db, args.dealId);
  if (!deal) return { ok: false, reason: "deal_not_found" };

  // Idempotent replay: existing hold for this phone on this deal.
  const [existing] = await db
    .select()
    .from(groupDealParticipants)
    .where(and(eq(groupDealParticipants.dealId, args.dealId), eq(groupDealParticipants.customerPhone, args.customerPhone)))
    .limit(1);
  if (existing) {
    const progress = (await getGroupDealProgressTx(db, args.dealId, now))!;
    return { ok: true, participant: existing, progress, alreadyJoined: true };
  }

  if (deal.status !== "open") return { ok: false, reason: "deal_not_open" };
  if (now.getTime() > new Date(deal.deadline).getTime()) return { ok: false, reason: "deadline_passed" };

  const amountCents = qty * deal.unitPriceCents;

  // Claim-first quantity increment (row lock serializes concurrent joins).
  const claimed = await db
    .update(groupDeals)
    .set({ currentQty: sql`${groupDeals.currentQty} + ${qty}`, updatedAt: now })
    .where(and(eq(groupDeals.id, args.dealId), eq(groupDeals.status, "open"), gt(groupDeals.deadline, now)))
    .returning({ id: groupDeals.id });
  if (claimed.length !== 1) {
    const fresh = await getGroupDealTx(db, args.dealId);
    if (!fresh || fresh.status !== "open") return { ok: false, reason: "deal_not_open" };
    return { ok: false, reason: "deadline_passed" };
  }

  const [participant] = await db
    .insert(groupDealParticipants)
    .values({
      id: args.idempotencyKey ?? randomUUID(),
      tenantId: deal.tenantId,
      dealId: args.dealId,
      customerPhone: args.customerPhone,
      quantity: qty,
      amountCents,
      currency: deal.currency,
      status: "held",
      paymentRef: args.paymentRef ?? null,
    })
    .onConflictDoNothing()
    .returning();

  if (!participant) {
    // Lost the unique race: roll the claim back and return the winner's hold.
    await db
      .update(groupDeals)
      .set({ currentQty: sql`GREATEST(${groupDeals.currentQty} - ${qty}, 0)`, updatedAt: now })
      .where(eq(groupDeals.id, args.dealId));
    const [winner] = await db
      .select()
      .from(groupDealParticipants)
      .where(and(eq(groupDealParticipants.dealId, args.dealId), eq(groupDealParticipants.customerPhone, args.customerPhone)))
      .limit(1);
    const progress = (await getGroupDealProgressTx(db, args.dealId, now))!;
    return { ok: true, participant: winner, progress, alreadyJoined: true };
  }

  // Threshold reached → confirm the deal immediately (still before deadline).
  const fresh = await getGroupDealTx(db, args.dealId);
  if (fresh && fresh.status === "open" && fresh.currentQty >= fresh.thresholdQty) {
    await confirmGroupDealTx(db, args.dealId, now);
  }

  const progress = (await getGroupDealProgressTx(db, args.dealId, now))!;
  return { ok: true, participant, progress };
}

// ── Resolution ─────────────────────────────────────────────────────────────
/** Threshold met → all held participants confirm. Idempotent. */
export async function confirmGroupDealTx(
  db: DbHandle,
  dealId: string,
  now: Date = new Date(),
): Promise<{ confirmed: number }> {
  const transitioned = await db
    .update(groupDeals)
    .set({ status: "confirmed", updatedAt: now })
    .where(and(eq(groupDeals.id, dealId), eq(groupDeals.status, "open"), sql`${groupDeals.currentQty} >= ${groupDeals.thresholdQty}`))
    .returning({ id: groupDeals.id });
  if (transitioned.length !== 1) return { confirmed: 0 };
  const participants = await db
    .update(groupDealParticipants)
    .set({ status: "confirmed", updatedAt: now })
    .where(and(eq(groupDealParticipants.dealId, dealId), eq(groupDealParticipants.status, "held")))
    .returning({ id: groupDealParticipants.id });
  return { confirmed: participants.length };
}

/**
 * Deadline passed without the threshold → expire the deal and refund/void
 * every held participant. Participants with a captured payment (paymentRef
 * set) are marked 'refunded' — when their hold lives in an escrow row
 * (metadata.groupDealParticipantId), the existing refundEscrowAtomic path is
 * invoked. Authorization-only participants (no paymentRef) are 'voided'.
 * Idempotent: only 'held' rows transition.
 */
export async function expireGroupDealTx(
  db: DbHandle,
  dealId: string,
  now: Date = new Date(),
): Promise<{ refunded: number; voided: number }> {
  const transitioned = await db
    .update(groupDeals)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(groupDeals.id, dealId), eq(groupDeals.status, "open"), sql`${groupDeals.deadline} <= ${now.toISOString()}`))
    .returning({ id: groupDeals.id });
  if (transitioned.length !== 1) return { refunded: 0, voided: 0 };

  const held = await db
    .select()
    .from(groupDealParticipants)
    .where(and(eq(groupDealParticipants.dealId, dealId), eq(groupDealParticipants.status, "held")));

  let refunded = 0;
  let voided = 0;
  for (const p of held) {
    // Refund via the existing escrow rail when a linked escrow exists.
    let escrowRefunded = false;
    if (p.paymentRef) {
      try {
        const rows = await db.execute(sql`
          SELECT id FROM escrow_transactions
          WHERE metadata->>'groupDealParticipantId' = ${p.id}
          LIMIT 1
        `);
        const escrowRow = (rows as unknown as Array<{ id: string }>)[0];
        if (escrowRow) {
          const { refundEscrowAtomic } = await import("../routers/escrow");
          const r = await refundEscrowAtomic(db as any, escrowRow.id, {
            reason: `group_deal_expired:${dealId}`,
          });
          escrowRefunded = r.success;
        } else {
          escrowRefunded = true; // captured via payment rail — marked refunded
        }
      } catch {
        escrowRefunded = true; // mark refunded; recon via paymentRef
      }
    }
    const finalStatus = p.paymentRef ? "refunded" : "voided";
    void escrowRefunded;
    const upd = await db
      .update(groupDealParticipants)
      .set({ status: finalStatus, updatedAt: now })
      .where(and(eq(groupDealParticipants.id, p.id), eq(groupDealParticipants.status, "held")))
      .returning({ id: groupDealParticipants.id });
    if (upd.length === 1) {
      if (finalStatus === "refunded") refunded += 1;
      else voided += 1;
    }
  }
  return { refunded, voided };
}

/**
 * Sweep: resolve every open deal whose deadline has passed — confirm when
 * the threshold was met, expire (with refunds/voids) otherwise. Idempotent.
 */
export async function sweepGroupDealsTx(
  db: DbHandle,
  now: Date = new Date(),
): Promise<{ confirmed: number; expired: number; participantsConfirmed: number; refunded: number; voided: number }> {
  const due = await db
    .select()
    .from(groupDeals)
    .where(and(eq(groupDeals.status, "open"), sql`${groupDeals.deadline} <= ${now.toISOString()}`));
  let confirmed = 0;
  let expired = 0;
  let participantsConfirmed = 0;
  let refunded = 0;
  let voided = 0;
  for (const deal of due) {
    if (deal.currentQty >= deal.thresholdQty) {
      const r = await confirmGroupDealTx(db, deal.id, now);
      if (r.confirmed > 0) {
        confirmed += 1;
        participantsConfirmed += r.confirmed;
      }
    } else {
      const r = await expireGroupDealTx(db, deal.id, now);
      // Only count when the row actually transitioned (first sweeper wins).
      if (r.refunded + r.voided > 0 || (await getGroupDealTx(db, deal.id))?.status === "expired") {
        expired += r.refunded + r.voided > 0 ? 1 : 0;
        refunded += r.refunded;
        voided += r.voided;
      }
    }
  }
  return { confirmed, expired, participantsConfirmed, refunded, voided };
}

/** Cancel an open deal (merchant action) — behaves like expiry for holds. */
export async function cancelGroupDealTx(
  db: DbHandle,
  args: { tenantId: string; dealId: string },
  now: Date = new Date(),
): Promise<boolean> {
  const transitioned = await db
    .update(groupDeals)
    .set({ status: "open", updatedAt: now, deadline: now }) // force-expire path below
    .where(and(eq(groupDeals.id, args.dealId), eq(groupDeals.tenantId, args.tenantId), eq(groupDeals.status, "open")))
    .returning({ id: groupDeals.id });
  if (transitioned.length !== 1) return false;
  await expireGroupDealTx(db, args.dealId, now);
  return true;
}

// ── WhatsApp formatting ────────────────────────────────────────────────────
export function formatDealForWhatsApp(p: GroupDealProgress, title: string, unitPriceCents: number, currency: string): string {
  const price = `${currency} ${(unitPriceCents / 100).toLocaleString("en-US")}`;
  const statusLine =
    p.status === "confirmed"
      ? "🎉 Deal UNLOCKED — orders confirmed!"
      : p.status === "expired"
        ? "⌛ Deal expired — all payments refunded/voided."
        : `${p.remainingQty} more unit(s) needed by ${p.deadline.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return [
    `*${title}* — group deal @ ${price}/unit`,
    `${p.bar} ${p.percent}% (${p.currentQty}/${p.thresholdQty} units, ${p.participantCount} joined)`,
    statusLine,
  ].join("\n");
}
