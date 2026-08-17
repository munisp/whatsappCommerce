/**
 * Limit revision (W13) — scorer-driven re-underwriting of a facility.
 *
 * reviseLimitsTx recomputes the deterministic limit suggestion
 * (scoring.suggestLimitTx) and applies it:
 *
 *   - UPWARD revision (newLimit > current): unchanged wave-12 behavior —
 *     applied immediately, recorded in credit_limit_history.
 *   - DOWNWARD revision (newLimit < current): also applied IMMEDIATELY
 *     (pre-W13 downward suggestions were advisory only). The new limit is
 *     never set below the outstanding balance — it clamps AT outstanding so
 *     the facility can always be repaid down without becoming inconsistent
 *     (outstanding > limit). A clamped revision is recorded with reason
 *     'limit_clamped'; a clean one with 'auto_revision'.
 *
 * Every applied revision inserts a credit_limit_history audit row in the
 * SAME transaction as the limit update.
 */
import { and, eq } from "drizzle-orm";
import { creditAccounts, creditLimitHistory } from "../../../drizzle/schema";
import { getCreditAccountByIdTx, type TxHandle } from "./accounts";
import { suggestLimitTx } from "./scoring";

export type LimitRevisionReason = "auto_revision" | "limit_clamped";

export interface ReviseLimitsResult {
  ok: boolean;
  accountId: string;
  oldLimitCents: number;
  newLimitCents: number;
  /** Suggested limit BEFORE clamping at outstanding. */
  suggestedLimitCents: number;
  score: number;
  changed: boolean;
  clampedAtOutstanding: boolean;
  reason?: LimitRevisionReason;
}

export async function reviseLimitsTx(
  db: TxHandle,
  args: { accountId: string },
  now: Date = new Date(),
): Promise<ReviseLimitsResult | null> {
  const account = await getCreditAccountByIdTx(db, args.accountId);
  if (!account) return null;
  const suggestion = await suggestLimitTx(db, account.buyerTenantId, account.supplierTenantId, now);

  const oldLimitCents = account.limitCents;
  const suggestedLimitCents = suggestion.suggestedLimitCents;
  // Downward revisions never go below outstanding — clamp AT outstanding.
  const clampedAtOutstanding = suggestedLimitCents < account.outstandingCents;
  const newLimitCents = Math.max(suggestedLimitCents, account.outstandingCents);

  const base = {
    ok: true,
    accountId: account.id,
    oldLimitCents,
    suggestedLimitCents,
    score: suggestion.score,
  } as const;

  if (newLimitCents === oldLimitCents) {
    return { ...base, newLimitCents, changed: false, clampedAtOutstanding: false };
  }

  const reason: LimitRevisionReason =
    newLimitCents < oldLimitCents && clampedAtOutstanding ? "limit_clamped" : "auto_revision";

  return db.transaction(async (tx) => {
    // Claim-first on the CURRENT limit so a concurrent revision/draw between
    // the pre-read and the update is not silently overwritten.
    const [updated] = await tx
      .update(creditAccounts)
      .set({
        limitCents: newLimitCents,
        score: suggestion.score,
        scoreReasons: suggestion.reasons,
        updatedAt: now,
      })
      .where(and(eq(creditAccounts.id, account.id), eq(creditAccounts.limitCents, oldLimitCents)))
      .returning();
    if (!updated) {
      // Concurrent writer moved the limit — report no-change (caller may retry).
      const fresh = await getCreditAccountByIdTx(tx, account.id);
      return {
        ...base,
        oldLimitCents: fresh?.limitCents ?? oldLimitCents,
        newLimitCents: fresh?.limitCents ?? oldLimitCents,
        changed: false,
        clampedAtOutstanding: false,
      };
    }
    await tx.insert(creditLimitHistory).values({
      accountId: account.id,
      oldLimitCents,
      newLimitCents,
      score: suggestion.score,
      reason,
    });
    return { ...base, newLimitCents, changed: true, clampedAtOutstanding, reason };
  });
}
