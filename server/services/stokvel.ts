/**
 * server/services/stokvel.ts — W27 stokvel / group savings circles
 * (esusu / ajo / chama).
 *
 * Members contribute a fixed integer-cent amount per cycle; when every active
 * member has paid, the pooled amount is paid out to the next member in a
 * deterministic rotation order (rotationPosition assigned in join order).
 * After every member has received exactly one payout the circle completes.
 *
 * Funds flow: contributions arrive via the existing payment rails (the caller
 * attaches the payment `paymentRef`); payouts are recorded as stokvel_payouts
 * rows plus an append-only stokvel_events audit trail. escrow.ts internals
 * are NOT touched (pinned) — the per-circle ledger here (contributions in,
 * payouts out, conservation asserted in tests) mirrors the escrow hold/release
 * pattern through public table interfaces only.
 *
 * Determinism: no Math.random; rotation is pure integer arithmetic; member
 * HMAC tokens derive from JWT_SECRET (same pattern as trackingToken.ts).
 */
import crypto from "crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { ENV } from "../_core/env";
import {
  merchantWallets,
  stokvelCircles,
  stokvelContributions,
  stokvelEvents,
  stokvelMembers,
  stokvelPayouts,
  walletTransactions,
} from "../../drizzle/schema";

export type Db = any;

export const STOKVEL_FREQUENCIES = ["weekly", "monthly"] as const;
export type StokvelFrequency = (typeof STOKVEL_FREQUENCIES)[number];

/** Cycle length in ms used for missed-contribution detection. */
export const CYCLE_MS: Record<StokvelFrequency, number> = {
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

// ── Member capability tokens (tracking.ts exemplar: <memberId>.<HMAC>) ──────
export function generateMemberToken(memberId: string): string {
  const sig = crypto.createHmac("sha256", ENV.jwtSecret).update(`stokvel:${memberId}`).digest("base64url").slice(0, 24);
  return `${memberId}.${sig}`;
}

export function verifyMemberToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const memberId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", ENV.jwtSecret).update(`stokvel:${memberId}`).digest("base64url").slice(0, 24);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return memberId;
}

// ── Pure helpers (unit-tested hermetically) ─────────────────────────────────

/** Member (by rotationPosition) that receives the payout for a cycle. */
export function payoutPositionForCycle(memberCount: number, rotationIndex: number): number {
  if (memberCount <= 0) throw new Error("circle has no members");
  return ((rotationIndex % memberCount) + memberCount) % memberCount;
}

/** Total pooled for a cycle = contribution × number of PAID contributions. */
export function cyclePoolCents(paidAmountsCents: number[]): number {
  return paidAmountsCents.reduce((a, b) => a + b, 0);
}

async function logEvent(db: Db, e: {
  tenantId: string; circleId: string; actorPhone?: string | null; kind: string; detail?: unknown;
}) {
  await db.insert(stokvelEvents).values({
    tenantId: e.tenantId, circleId: e.circleId, actorPhone: e.actorPhone ?? null,
    kind: e.kind, detail: (e.detail ?? null) as any,
  });
}

// ── Circle lifecycle ────────────────────────────────────────────────────────

export async function createCircle(db: Db, input: {
  tenantId: string;
  name: string;
  contributionAmountCents: number;
  frequency: StokvelFrequency;
  currency?: string;
  members: Array<{ phone: string; name?: string }>;
  createdByPhone?: string;
}) {
  if (!input.name.trim()) throw new Error("circle name required");
  if (!Number.isInteger(input.contributionAmountCents) || input.contributionAmountCents <= 0) {
    throw new Error("contributionAmountCents must be a positive integer");
  }
  if (!STOKVEL_FREQUENCIES.includes(input.frequency)) throw new Error("invalid frequency");
  const seen = new Set<string>();
  const members = input.members.map((m) => {
    const phone = m.phone.trim();
    if (!/^\+?\d{7,15}$/.test(phone)) throw new Error(`invalid member phone: ${m.phone}`);
    if (seen.has(phone)) throw new Error(`duplicate member phone: ${phone}`);
    seen.add(phone);
    return { phone, name: m.name?.trim() || null };
  });
  if (members.length < 2) throw new Error("a circle needs at least 2 members");

  const [circle] = await db.insert(stokvelCircles).values({
    tenantId: input.tenantId,
    name: input.name.trim(),
    contributionAmountCents: input.contributionAmountCents,
    frequency: input.frequency,
    currency: input.currency ?? "NGN",
    createdByPhone: input.createdByPhone ?? null,
  }).returning();

  const rows = members.map((m, i) => ({
    tenantId: input.tenantId,
    circleId: circle.id,
    phone: m.phone,
    name: m.name,
    rotationPosition: i, // deterministic join order
  }));
  const inserted = await db.insert(stokvelMembers).values(rows).returning();
  await logEvent(db, {
    tenantId: input.tenantId, circleId: circle.id, actorPhone: input.createdByPhone,
    kind: "circle_created",
    detail: { name: circle.name, contributionAmountCents: circle.contributionAmountCents, frequency: circle.frequency, memberCount: inserted.length },
  });
  return { circle, members: inserted };
}

export async function getCircle(db: Db, tenantId: string, circleId: string) {
  const [circle] = await db.select().from(stokvelCircles)
    .where(and(eq(stokvelCircles.id, circleId), eq(stokvelCircles.tenantId, tenantId))).limit(1);
  if (!circle) return null;
  const members = await db.select().from(stokvelMembers)
    .where(eq(stokvelMembers.circleId, circleId))
    .orderBy(asc(stokvelMembers.rotationPosition));
  return { circle, members };
}

/** Open (or fetch) the pending contribution row for a member in the current cycle. */
async function ensureContributionRow(db: Db, circle: any, member: any) {
  const [existing] = await db.select().from(stokvelContributions).where(and(
    eq(stokvelContributions.circleId, circle.id),
    eq(stokvelContributions.cycle, circle.currentCycle),
    eq(stokvelContributions.memberId, member.id),
  )).limit(1);
  if (existing) return existing;
  // Unique (circleId, cycle, memberId) guards races; on conflict re-read.
  await db.insert(stokvelContributions).values({
    tenantId: circle.tenantId, circleId: circle.id, cycle: circle.currentCycle,
    memberId: member.id, phone: member.phone, amountCents: circle.contributionAmountCents,
  }).onConflictDoNothing();
  const [row] = await db.select().from(stokvelContributions).where(and(
    eq(stokvelContributions.circleId, circle.id),
    eq(stokvelContributions.cycle, circle.currentCycle),
    eq(stokvelContributions.memberId, member.id),
  )).limit(1);
  return row;
}

// ── W30 (V1#1): verified contributions + real payout wallet credits ─────────

/** Deterministic wallet owner key for a stokvel member (member phones are not tenants). */
export function stokvelWalletTenantKey(phone: string): string {
  const h = crypto.createHmac("sha256", ENV.jwtSecret).update(`stokvel-wallet:${phone}`).digest("hex").slice(0, 20);
  return `stokvel-w-${h}`; // 28 chars ≤ 36
}

/** Verify a contribution payment reference against the real payment rails. */
async function verifyContributionPayment(db: Db, opts: {
  tenantId: string; reference?: string | null; expectedAmountCents: number;
}): Promise<{ verified: boolean; via: string; detail?: string }> {
  if (!opts.reference) return { verified: false, via: "none", detail: "no-payment-ref" };
  try {
    const { hasVerifiedPayment } = await import("./payments/verifyProviderStatus");
    const r = await hasVerifiedPayment(db, {
      tenantId: opts.tenantId,
      reference: opts.reference,
      expectedAmountCents: opts.expectedAmountCents,
    });
    return { verified: r.verified, via: r.via, detail: r.detail };
  } catch (err: any) {
    console.error(`[stokvel] payment verification error for ref=${opts.reference}: ${err?.message}`);
    return { verified: false, via: "none", detail: "verification-error" };
  }
}

/** Get-or-create the recipient member's wallet (deterministic id). */
async function ensureMemberWallet(tx: Db, phone: string, currency: string) {
  const tenantKey = stokvelWalletTenantKey(phone);
  const [existing] = await tx.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantKey)).limit(1);
  if (existing) return existing;
  const id = `stkw-${crypto.createHmac("sha256", ENV.jwtSecret).update(`stokvel-wallet-id:${phone}`).digest("hex").slice(0, 24)}`;
  await tx.insert(merchantWallets).values({
    id, tenantId: tenantKey, currency,
    availableBalance: "0", escrowBalance: "0", totalEarned: "0", totalWithdrawn: "0",
    custodyMode: "psp", isActive: true, createdAt: new Date(), updatedAt: new Date(),
  }).onConflictDoNothing();
  const [row] = await tx.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantKey)).limit(1);
  if (!row) throw new Error("member wallet could not be created");
  return row;
}

/**
 * Credit a stokvel payout to the recipient's wallet. Idempotent per
 * (wallet, reference) — wallet_tx_wallet_ref_uniq makes a retry a no-op.
 * MUST run inside a transaction; throws on failure (caller decides whether
 * to leave the payout `pending_payout`).
 */
async function creditPayoutToWallet(tx: Db, opts: {
  circleTenantId: string; circleId: string; cycle: number;
  phone: string; amountCents: number; currency: string;
}): Promise<{ walletId: string; reference: string }> {
  const wallet = await ensureMemberWallet(tx, opts.phone, opts.currency);
  const reference = `stokvelpay:${opts.circleId}:${opts.cycle}`;
  const amount = (opts.amountCents / 100).toFixed(2);
  const locked = await tx.execute(sql`SELECT available_balance FROM merchant_wallets WHERE id = ${wallet.id} FOR UPDATE`);
  const before = parseFloat(String((locked as unknown as Record<string, unknown>[])[0]?.available_balance ?? "0"));
  try {
    await tx.insert(walletTransactions).values({
      id: crypto.randomUUID(),
      walletId: wallet.id,
      tenantId: opts.circleTenantId,
      // wallet_tx_type enum has no stokvel value (additive-only schema); the
      // credit is labelled via description + reference + metadata.
      type: "float_income",
      amount,
      balanceBefore: before.toFixed(2),
      balanceAfter: (before + opts.amountCents / 100).toFixed(2),
      currency: wallet.currency,
      description: `Stokvel payout — circle ${opts.circleId} cycle ${opts.cycle}`,
      reference,
      metadata: { source: "stokvel_payout", circleId: opts.circleId, cycle: opts.cycle, phone: opts.phone },
      createdAt: new Date(),
    });
  } catch (err: any) {
    if (String(err?.code) === "23505" || /duplicate key/i.test(String(err?.message))) {
      return { walletId: wallet.id, reference }; // already credited — idempotent replay
    }
    throw err;
  }
  await tx.update(merchantWallets).set({
    availableBalance: sql`${merchantWallets.availableBalance} + ${amount}`,
    totalEarned: sql`${merchantWallets.totalEarned} + ${amount}`,
    updatedAt: new Date(),
  }).where(eq(merchantWallets.id, wallet.id));
  return { walletId: wallet.id, reference };
}

/**
 * Record a member's contribution for the current cycle. W30 (V1#1): a
 * contribution is only ever `paid` against a VERIFIED payment reference
 * (local confirmed payment record or live provider probe via
 * payments/verifyProviderStatus). Without one the row stays `pending` —
 * honestly — and the caller gets `pending: true`. Idempotent: a second call
 * for an already-paid contribution returns `alreadyPaid: true`. When the
 * last active member pays, the rotating payout + cycle advance run in the
 * SAME transaction.
 */
export async function recordContribution(db: Db, input: {
  tenantId: string; circleId: string; phone: string; paymentRef?: string;
}) {
  const apply = async (tx: Db) => {
    const found = await getCircle(tx, input.tenantId, input.circleId);
    if (!found) throw new Error("circle not found");
    const { circle, members } = found;
    if (circle.status !== "active") throw new Error(`circle is ${circle.status}`);
    const member = members.find((m: any) => m.phone === input.phone && m.status === "active");
    if (!member) throw new Error("not an active member of this circle");

    // Open the cycle: every active member gets a pending row on first activity,
    // so reminder + missed-contribution scans see the full outstanding set.
    for (const m of members.filter((x: any) => x.status === "active")) {
      await ensureContributionRow(tx, circle, m);
    }
    let row = await ensureContributionRow(tx, circle, member);
    if (row.status === "missed") {
      throw new Error("this cycle's contribution window was missed — contact your group admin");
    }
    if (row.status === "paid") {
      return { contribution: row, alreadyPaid: true, pending: false, payout: null, circleComplete: false };
    }

    // W30: verify the payment reference BEFORE marking anything paid.
    const paymentRef = input.paymentRef ?? row.paymentRef ?? null;
    const verification = await verifyContributionPayment(tx, {
      tenantId: circle.tenantId, reference: paymentRef, expectedAmountCents: circle.contributionAmountCents,
    });
    if (!verification.verified) {
      // Record the (unverified) reference on the pending row for audit/retry,
      // but NEVER mark paid — no verified money moved.
      if (paymentRef && paymentRef !== row.paymentRef) {
        await tx.update(stokvelContributions).set({ paymentRef })
          .where(and(eq(stokvelContributions.id, row.id), eq(stokvelContributions.status, "pending")));
        row = { ...row, paymentRef };
      }
      await logEvent(tx, {
        tenantId: circle.tenantId, circleId: circle.id, actorPhone: input.phone,
        kind: "contribution_pending",
        detail: { cycle: circle.currentCycle, amountCents: row.amountCents, paymentRef, reason: verification.detail ?? "unverified" },
      });
      return {
        contribution: row, alreadyPaid: false, pending: true, payout: null, circleComplete: false,
        verification: { via: verification.via, detail: verification.detail },
      };
    }

    const [contribution] = await tx.update(stokvelContributions).set({
      status: "paid", paidAt: new Date(), paymentRef,
    }).where(and(eq(stokvelContributions.id, row.id), eq(stokvelContributions.status, "pending"))).returning();
    if (!contribution) { // lost a race — another writer paid first
      const [again] = await tx.select().from(stokvelContributions).where(eq(stokvelContributions.id, row.id)).limit(1);
      return { contribution: again, alreadyPaid: true, pending: false, payout: null, circleComplete: false };
    }
    await logEvent(tx, {
      tenantId: circle.tenantId, circleId: circle.id, actorPhone: input.phone,
      kind: "contribution_paid",
      detail: { cycle: circle.currentCycle, amountCents: contribution.amountCents, paymentRef: contribution.paymentRef, verifiedVia: verification.via },
    });
    return await maybePayOut(tx, circle, members, contribution);
  };
  if (typeof db.transaction === "function") return db.transaction(apply);
  return apply(db);
}

/** Retry every `pending_payout` payout (wallet credit previously failed). Recon surface. */
export async function retryPendingPayouts(db: Db, opts: { tenantId: string }) {
  const pending = await db.select().from(stokvelPayouts).where(and(
    eq(stokvelPayouts.tenantId, opts.tenantId),
    eq(stokvelPayouts.status, "pending_payout"),
  ));
  const settled: any[] = [];
  const stillPending: any[] = [];
  for (const p of pending) {
    try {
      await db.transaction(async (tx: Db) => {
        await creditPayoutToWallet(tx, {
          circleTenantId: p.tenantId, circleId: p.circleId, cycle: p.cycle,
          phone: p.phone, amountCents: p.amountCents,
          currency: (await tx.select().from(stokvelCircles).where(eq(stokvelCircles.id, p.circleId)).limit(1))[0]?.currency ?? "NGN",
        });
        await tx.update(stokvelPayouts).set({ status: "paid", paidAt: new Date() })
          .where(and(eq(stokvelPayouts.id, p.id), eq(stokvelPayouts.status, "pending_payout")));
      });
      settled.push(p);
    } catch (err: any) {
      console.error(`[stokvel] payout retry failed for payout=${p.id}: ${err?.message}`);
      stillPending.push(p);
    }
  }
  return { settled, stillPending };
}

/** If every active member has paid the current cycle, execute the payout. */
async function maybePayOut(db: Db, circle: any, members: any[], contribution: any) {
  const active = members.filter((m) => m.status === "active");
  const paidRows = await db.select().from(stokvelContributions).where(and(
    eq(stokvelContributions.circleId, circle.id),
    eq(stokvelContributions.cycle, circle.currentCycle),
    eq(stokvelContributions.status, "paid"),
  ));
  const paidMemberIds = new Set(paidRows.map((r: any) => r.memberId));
  const allPaid = active.every((m) => paidMemberIds.has(m.id));
  if (!allPaid) return { contribution, alreadyPaid: false, payout: null, circleComplete: false };

  const position = payoutPositionForCycle(active.length, circle.rotationIndex);
  const recipient = active.find((m) => m.rotationPosition === position) ?? active[position];
  const poolCents = cyclePoolCents(paidRows.map((r: any) => r.amountCents));

  // Unique (circleId, cycle) makes the payout claim transactional — a racing
  // writer loses the insert and we return the existing payout instead.
  // W30 (V1#1): the row is claimed as `pending_payout` and only flips to
  // `paid` AFTER the recipient's wallet is verifiably credited — never
  // "paid" without money movement.
  await db.insert(stokvelPayouts).values({
    tenantId: circle.tenantId, circleId: circle.id, cycle: circle.currentCycle,
    memberId: recipient.id, phone: recipient.phone, amountCents: poolCents, status: "pending_payout",
  }).onConflictDoNothing();
  let [payout] = await db.select().from(stokvelPayouts).where(and(
    eq(stokvelPayouts.circleId, circle.id), eq(stokvelPayouts.cycle, circle.currentCycle),
  )).limit(1);

  let walletCredited = false;
  let walletError: string | null = null;
  if (payout.status !== "paid") {
    try {
      // Savepoint: a wallet-credit failure must NOT roll back the verified
      // contribution / payout claim — the payout stays pending_payout for retry.
      await (typeof db.transaction === "function" ? db.transaction(async (sp: Db) => {
        await creditPayoutToWallet(sp, {
          circleTenantId: circle.tenantId, circleId: circle.id, cycle: circle.currentCycle,
          phone: recipient.phone, amountCents: poolCents, currency: circle.currency ?? "NGN",
        });
      }) : creditPayoutToWallet(db, {
        circleTenantId: circle.tenantId, circleId: circle.id, cycle: circle.currentCycle,
        phone: recipient.phone, amountCents: poolCents, currency: circle.currency ?? "NGN",
      }));
      walletCredited = true;
      const [flipped] = await db.update(stokvelPayouts).set({ status: "paid", paidAt: new Date() })
        .where(and(eq(stokvelPayouts.id, payout.id), eq(stokvelPayouts.status, "pending_payout")))
        .returning();
      if (flipped) payout = flipped;
    } catch (err: any) {
      walletError = err?.message ?? String(err);
      console.error(`[stokvel] wallet credit failed for circle=${circle.id} cycle=${circle.currentCycle}: ${walletError}`);
    }
  } else {
    walletCredited = true;
  }

  // Single-transaction cycle advance (this whole flow runs inside the
  // recordContribution transaction).
  const nextIndex = circle.rotationIndex + 1;
  const nextCycle = circle.currentCycle + 1;
  const complete = nextIndex >= active.length; // every member received exactly one payout
  await db.update(stokvelCircles).set({
    rotationIndex: nextIndex,
    currentCycle: nextCycle,
    status: complete ? "completed" : "active",
    updatedAt: new Date(),
  }).where(eq(stokvelCircles.id, circle.id));

  await logEvent(db, {
    tenantId: circle.tenantId, circleId: circle.id, actorPhone: recipient.phone,
    kind: payout.status === "paid" ? "payout_paid" : "payout_pending",
    detail: {
      cycle: circle.currentCycle, memberId: recipient.id, phone: recipient.phone, amountCents: poolCents,
      walletCredited, ...(walletError ? { error: walletError } : {}),
    },
  });
  if (complete) {
    await logEvent(db, {
      tenantId: circle.tenantId, circleId: circle.id,
      kind: "circle_completed", detail: { cycles: circle.currentCycle },
    });
  }
  return { contribution, alreadyPaid: false, payout, circleComplete: complete };
}

/**
 * Mark overdue pending contributions 'missed'. Deterministic: a contribution
 * is missed when `now` is past (cycle start + CYCLE_MS[frequency]). Cycle
 * start is approximated by the contribution row creation time unless an
 * explicit `cycleStartedAt` is supplied. Returns the newly-missed rows.
 */
export async function markMissedContributions(db: Db, opts: { tenantId: string; now?: Date }) {
  const now = opts.now ?? new Date();
  const pending = await db.select().from(stokvelContributions).where(and(
    eq(stokvelContributions.tenantId, opts.tenantId),
    eq(stokvelContributions.status, "pending"),
  ));
  const missed: any[] = [];
  for (const row of pending) {
    const [circle] = await db.select().from(stokvelCircles).where(eq(stokvelCircles.id, row.circleId)).limit(1);
    if (!circle || circle.status !== "active") continue;
    const window = CYCLE_MS[(circle.frequency as StokvelFrequency)] ?? CYCLE_MS.monthly;
    if (now.getTime() - new Date(row.createdAt).getTime() < window) continue;
    const [updated] = await db.update(stokvelContributions).set({ status: "missed" })
      .where(and(eq(stokvelContributions.id, row.id), eq(stokvelContributions.status, "pending")))
      .returning();
    if (updated) {
      missed.push(updated);
      await logEvent(db, {
        tenantId: row.tenantId, circleId: row.circleId, actorPhone: row.phone,
        kind: "contribution_missed", detail: { cycle: row.cycle, amountCents: row.amountCents },
      });
    }
  }
  return missed;
}

/**
 * Pending (unpaid, not yet missed) contributions due a WhatsApp reminder.
 * Bumps reminderCount + lastReminderAt so reminders are auditable and
 * rate-limitable. The caller delivers the actual WhatsApp message.
 */
export async function claimContributionReminders(db: Db, opts: { tenantId: string; maxReminders?: number }) {
  const max = opts.maxReminders ?? 3;
  const rows = await db.select().from(stokvelContributions).where(and(
    eq(stokvelContributions.tenantId, opts.tenantId),
    eq(stokvelContributions.status, "pending"),
  ));
  const due: any[] = [];
  for (const row of rows) {
    if (row.reminderCount >= max) continue;
    const [updated] = await db.update(stokvelContributions).set({
      reminderCount: sql`${stokvelContributions.reminderCount} + 1`,
      lastReminderAt: new Date(),
    }).where(eq(stokvelContributions.id, row.id)).returning();
    if (updated) due.push(updated);
  }
  return due;
}

/** Full circle statement: circle, members, contributions, payouts, events. */
export async function circleStatement(db: Db, tenantId: string, circleId: string) {
  const found = await getCircle(db, tenantId, circleId);
  if (!found) return null;
  const contributions = await db.select().from(stokvelContributions)
    .where(eq(stokvelContributions.circleId, circleId));
  const payouts = await db.select().from(stokvelPayouts)
    .where(eq(stokvelPayouts.circleId, circleId));
  const events = await db.select().from(stokvelEvents)
    .where(eq(stokvelEvents.circleId, circleId))
    .orderBy(asc(stokvelEvents.createdAt));
  return { ...found, contributions, payouts, events };
}
