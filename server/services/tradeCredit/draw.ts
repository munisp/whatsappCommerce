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
import { reportEvent } from "../compliance/bureau";

export interface DrawArgs {
  supplierTenantId: string;
  buyerTenantId: string;
  amountCents: number;
  poId: string;
  termsDays?: number;
  /**
   * W13 tenure-gate override: an explicit supplier decision (recorded
   * upstream) may bypass the first-draw account-age requirement.
   */
  tenureOverride?: boolean;
}

export type DrawResult =
  | {
      ok: true;
      ledgerId: string;
      outstandingAfter: number;
      /**
       * A1-04/F-01: the insert lost the race against a concurrent draw with
       * the same ref (unique index credit_ledger_draw_ref_uniq, 0053) or a
       * crash-retry found the draw already persisted. No second draw row,
       * no second outstanding increment — this is an idempotent replay of
       * the original draw.
       */
      alreadyDrawn?: true;
    }
  | {
      ok: false;
      // Kept byte-compatible with the pre-W13 union: procurement/poFlow.ts
      // (owned by the procurement wave) assigns draw.reason into its own
      // ApprovePoResult union, so new W13 refusals map onto 'frozen' with the
      // precise cause carried in `blockedBy`.
      reason: "over_limit" | "no_account" | "frozen" | "closed";
      /** W13 precision: 'suspended' (credit control plane) | 'tenure' (first-draw age gate). */
      blockedBy?: "suspended" | "tenure";
    };

/** W13: days a facility must be aged before its FIRST draw (env override). */
export function tenureGateDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CREDIT_TENURE_GATE_DAYS;
  if (raw === undefined || raw === "") return 7;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7;
}

const TENURE_DAY_MS = 24 * 60 * 60 * 1000;

/** SQLSTATE 23505 on credit_ledger_draw_ref_uniq (0053) — mirrors repayment.ts. */
function isDrawRefUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e?.code !== "23505") return false;
  const hay = `${e.constraint ?? ""} ${e.message ?? ""}`;
  return hay.includes("credit_ledger_draw_ref_uniq");
}

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
  if (account.suspended === true) return { ok: false, reason: "frozen", blockedBy: "suspended" };

  // ── W13 tenure gate: the FIRST draw on a facility requires the account to
  // be aged ≥ CREDIT_TENURE_GATE_DAYS (default 7), unless the supplier
  // explicitly overrode. "First draw" = no invoice_draw ledger rows yet.
  const gateDays = tenureGateDays();
  if (gateDays > 0 && args.tenureOverride !== true) {
    const ageMs = now.getTime() - new Date(account.createdAt).getTime();
    if (ageMs < gateDays * TENURE_DAY_MS) {
      const priorDraws = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(and(eq(creditLedger.creditAccountId, account.id), eq(creditLedger.kind, "invoice_draw")))
        .limit(1);
      if (priorDraws.length === 0) return { ok: false, reason: "frozen", blockedBy: "tenure" };
    }
  }

  const termsDays = args.termsDays ?? account.termsDays;
  const dueDate = new Date(now.getTime() + termsDays * 24 * 60 * 60 * 1000);

  let result: DrawResult;
  try {
  result = await db.transaction(async (tx): Promise<DrawResult> => {
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
      // MUST go through `tx`: the transaction holds the row lock (and, with
      // small pools, the only connection) — querying via `db` here deadlocks
      // against the open transaction.
      const fresh = await getCreditAccountTx(tx, args.supplierTenantId, args.buyerTenantId);
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
  } catch (err: any) {
    // A1-04/F-01: a concurrent approval (or a crash-retry after the original
    // draw committed) with the SAME ref lost the insert race — the unique
    // index credit_ledger_draw_ref_uniq (0053) rejected our draw row and the
    // transaction rolled back (no outstanding increment, no ledger row).
    // Translate to an idempotent already-drawn success returning the
    // existing row, mirroring the W14.1 repayment pattern.
    if (isDrawRefUniqueViolation(err)) {
      const ref = `draw:${args.poId}`.slice(0, 128);
      const [existing] = await db
        .select()
        .from(creditLedger)
        .where(and(eq(creditLedger.creditAccountId, account.id), eq(creditLedger.ref, ref)))
        .limit(1);
      const fresh = await getCreditAccountTx(db, args.supplierTenantId, args.buyerTenantId);
      if (existing) {
        return {
          ok: true,
          ledgerId: existing.id,
          outstandingAfter: fresh?.outstandingCents ?? account.outstandingCents,
          alreadyDrawn: true,
        };
      }
      // Index fired but the row is not visible (winner rolled back) — let the
      // caller classify as a transient failure instead of inventing a draw.
      return { ok: false, reason: "over_limit" };
    }
    throw err;
  }

  // W14: bureau 'disbursement' event on a successful draw. Fire-and-forget:
  // reportEvent never throws and skips non-consented accounts internally.
  // Runs AFTER the money-path transaction commits — bureau reporting can
  // never block or roll back a draw.
  if (result.ok && !result.alreadyDrawn) {
    await reportEvent(db, {
      accountId: account.id,
      eventType: "disbursement",
      payload: {
        amountCents,
        currency: "NGN",
        ledgerId: result.ledgerId,
        poId: args.poId,
        dueDate: dueDate.toISOString(),
        outstandingAfter: result.outstandingAfter,
        occurredAt: now.toISOString(),
      },
    });
  }
  return result;
}
