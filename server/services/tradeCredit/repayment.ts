/**
 * Repayment application — buyer pays down outstanding credit.
 *
 * MONEY-PATH INVARIANT: the decrement is claim-first —
 *
 *   UPDATE credit_accounts
 *     SET outstanding_cents = outstanding_cents - $amt, updated_at = now()
 *   WHERE id = $id AND outstanding_cents >= $amt
 *   RETURNING *
 *
 * so over-repayment is refused atomically (outstanding can never go
 * negative) and partial repayments are allowed. The 'repayment' ledger row
 * and the FIFO settlement of fully-covered invoice_draw rows happen in the
 * SAME transaction as the claim.
 *
 * Settlement rule (documented, deterministic): total repayments to date are
 * compared against posted draws oldest-first (created_at); every draw whose
 * cumulative amount is fully covered by cumulative repayments is marked
 * 'settled'. A partially-covered draw stays 'posted'.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { creditAccounts, creditLedger } from "../../../drizzle/schema";
import { getCreditAccountByIdTx, type TxHandle } from "./accounts";

export interface RepaymentArgs {
  accountId: string;
  amountCents: number;
  ref: string;
}

export interface RepaymentResult {
  ok: boolean;
  outstandingAfter: number;
}

export async function applyRepaymentTx(
  db: TxHandle,
  args: RepaymentArgs,
  now: Date = new Date(),
): Promise<RepaymentResult> {
  const amountCents = Math.round(args.amountCents);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    const account = await getCreditAccountByIdTx(db, args.accountId);
    return { ok: false, outstandingAfter: account?.outstandingCents ?? 0 };
  }

  return db.transaction(async (tx) => {
    // ── ATOMIC CLAIM: refuse over-repayment inside the guard ──────────────
    const [claimed] = await tx
      .update(creditAccounts)
      .set({
        outstandingCents: sql`${creditAccounts.outstandingCents} - ${amountCents}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(creditAccounts.id, args.accountId),
          sql`${creditAccounts.outstandingCents} >= ${amountCents}`,
        ),
      )
      .returning();

    if (!claimed) {
      const account = await getCreditAccountByIdTx(db, args.accountId);
      return { ok: false, outstandingAfter: account?.outstandingCents ?? 0 };
    }

    // ── Repayment ledger row (same transaction) ───────────────────────────
    await tx.insert(creditLedger).values({
      creditAccountId: args.accountId,
      kind: "repayment",
      amountCents,
      ref: args.ref.slice(0, 128),
    });

    // ── FIFO settlement of fully-covered draws (same transaction) ─────────
    const rows = await tx
      .select({
        id: creditLedger.id,
        kind: creditLedger.kind,
        amountCents: creditLedger.amountCents,
        status: creditLedger.status,
      })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.creditAccountId, args.accountId),
          inArray(creditLedger.kind, ["invoice_draw", "repayment"]),
        ),
      )
      .orderBy(asc(creditLedger.createdAt));

    let repaidPool = 0;
    const settleIds: string[] = [];
    for (const row of rows) {
      if (row.kind === "repayment") {
        repaidPool += row.amountCents;
        continue;
      }
      // invoice_draw
      if (row.status !== "posted") continue;
      if (repaidPool >= row.amountCents) {
        repaidPool -= row.amountCents;
        settleIds.push(row.id);
      }
    }
    if (settleIds.length > 0) {
      await tx
        .update(creditLedger)
        .set({ status: "settled" })
        .where(and(inArray(creditLedger.id, settleIds), eq(creditLedger.status, "posted")));
    }

    return { ok: true, outstandingAfter: claimed.outstandingCents };
  });
}
