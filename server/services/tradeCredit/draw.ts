/**
 * Draw on credit — the money-path heart of B2B procurement on credit.
 *
 * MONEY-PATH INVARIANT (non-negotiable): the draw is a SINGLE atomic
 * claim-first statement —
 *
 *   UPDATE credit_accounts
 *     SET outstanding_cents = outstanding_cents + $amt, updated_at = now()
 *   WHERE id = $id AND status = 'active'
 *     AND outstanding_cents + $amt <= limit_cents
 *   RETURNING *
 *
 * Postgres evaluates the guard against the row as locked by the UPDATE, so
 * concurrent draws serialize on the row lock and total outstanding can NEVER
 * exceed limit_cents. There is NO read-then-write of outstanding anywhere:
 * the pre-lookup only resolves the account id / classifies failures.
 *
 * On a successful claim the 'invoice_draw' ledger row (due_date = now +
 * termsDays) is inserted in the SAME transaction — claim and ledger write
 * commit or roll back together.
 */
import { and, eq, sql } from "drizzle-orm";
import { creditAccounts, creditLedger } from "../../../drizzle/schema";
import { getCreditAccountTx, type TxHandle } from "./accounts";

export interface DrawArgs {
  supplierTenantId: string;
  buyerTenantId: string;
  amountCents: number;
  poId: string;
  termsDays?: number;
}

export type DrawResult =
  | { ok: true; ledgerId: string; outstandingAfter: number }
  | { ok: false; reason: "over_limit" | "no_account" | "frozen" | "closed" };

export async function drawOnCreditTx(
  db: TxHandle,
  args: DrawArgs,
  now: Date = new Date(),
): Promise<DrawResult> {
  const amountCents = Math.round(args.amountCents);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    // Non-positive draws are not credit events; refuse without touching state.
    return { ok: false, reason: "over_limit" };
  }

  // Pre-lookup resolves the account id and classifies refusals. This read is
  // NOT authoritative for the limit check — the claim-first UPDATE below is.
  const account = await getCreditAccountTx(db, args.supplierTenantId, args.buyerTenantId);
  if (!account) return { ok: false, reason: "no_account" };
  if (account.status === "frozen") return { ok: false, reason: "frozen" };
  if (account.status === "closed") return { ok: false, reason: "closed" };

  const termsDays = args.termsDays ?? account.termsDays;
  const dueDate = new Date(now.getTime() + termsDays * 24 * 60 * 60 * 1000);

  return db.transaction(async (tx) => {
    // ── ATOMIC CLAIM: guard + increment in one statement ──────────────────
    const [claimed] = await tx
      .update(creditAccounts)
      .set({
        outstandingCents: sql`${creditAccounts.outstandingCents} + ${amountCents}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(creditAccounts.id, account.id),
          eq(creditAccounts.status, "active"),
          sql`${creditAccounts.outstandingCents} + ${amountCents} <= ${creditAccounts.limitCents}`,
        ),
      )
      .returning();

    if (!claimed) {
      // Zero rows ⇒ guard failed. Re-read to classify (the account was
      // active pre-lookup, so a missing row now means it was frozen/closed
      // by a concurrent writer; an over-limit guard miss is the common case).
      const fresh = await getCreditAccountTx(db, args.supplierTenantId, args.buyerTenantId);
      if (!fresh) return { ok: false, reason: "no_account" };
      if (fresh.status === "frozen") return { ok: false, reason: "frozen" };
      if (fresh.status === "closed") return { ok: false, reason: "closed" };
      return { ok: false, reason: "over_limit" };
    }

    // ── Ledger row in the SAME transaction as the claim ───────────────────
    const [entry] = await tx
      .insert(creditLedger)
      .values({
        creditAccountId: account.id,
        kind: "invoice_draw",
        amountCents,
        poId: args.poId,
        dueDate,
        ref: `draw:${args.poId}`,
      })
      .returning();

    return { ok: true, ledgerId: entry.id, outstandingAfter: claimed.outstandingCents };
  });
}
