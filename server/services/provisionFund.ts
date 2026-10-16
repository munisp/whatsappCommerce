// === W57 risk-shield ===
/**
 * provisionFund.ts — Feature 4: first-loss provision fund.
 *
 * Append-only ledger (provision_fund_ledger): tenant-scoped rows plus
 * platform-level rows (tenantId NULL). All amounts integer cents, always
 * positive; direction comes from `kind`.
 *
 *   accrual         — on facility fee accrual events, divert
 *                     escrow_config.provision_fund_bps (default 250 = 2.5%)
 *                     of the fee to the fund. Post-commit seam
 *                     (accrueFromFeeEvent), idempotent key
 *                     `prov:accr:<feeRef>`, onConflictDoNothing.
 *   draw            — admin-approved write-off shortfall or approved
 *                     insurance-claim shortfall draws from the fund. The
 *                     ROUTER enforces adminProcedure + the W31 approvals
 *                     threshold gate (additive kind 'provision_draw',
 *                     mirroring 'credit_servicing'); the service performs
 *                     the claim-first balance check + audited insert.
 *   recovery_credit — post-default recoveries credit the fund
 *                     (recoveryCredit(), idempotent `prov:rec:<ref>`).
 *
 * Fail-closed money: draws REFUSE when the fund balance is insufficient
 * (guarded by a serializable balance check inside a transaction) — a
 * provision shortfall must never silently overdraw.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { escrowConfig, provisionFundLedger } from "../../drizzle/schema";
import type { DbHandle } from "./tradeCredit/accounts";

export type ProvisionKind = "accrual" | "draw" | "recovery_credit";

export class ProvisionError extends Error {
  code: "BAD_REQUEST" | "INSUFFICIENT_FUNDS" | "CONFLICT";
  constructor(code: ProvisionError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function assertIntCents(n: number, label: string): void {
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ProvisionError("BAD_REQUEST", `${label} must be a positive integer (cents)`);
  }
}

/** Configured accrual rate (bps of each fee accrual). escrow_config row. */
export async function getProvisionFundBps(db: DbHandle): Promise<number> {
  const rows = (await db
    .select({ bps: escrowConfig.provisionFundBps })
    .from(escrowConfig)
    .limit(1)
    .catch(() => [] as any[])) as unknown as { bps: number }[];
  return rows[0]?.bps ?? 250;
}

/**
 * Fund balance in integer cents: Σ accrual + Σ recovery_credit − Σ draw.
 * tenantId null ⇒ platform-level rows only.
 */
export async function getProvisionBalance(db: DbHandle, tenantId: string | null): Promise<number> {
  const tenantWhere = tenantId == null ? isNull(provisionFundLedger.tenantId) : eq(provisionFundLedger.tenantId, tenantId);
  const rows = (await db
    .select({
      accrued: sql<string>`coalesce(sum(case when ${provisionFundLedger.kind} in ('accrual','recovery_credit') then ${provisionFundLedger.amountCents} else 0 end), 0)::int`,
      drawn: sql<string>`coalesce(sum(case when ${provisionFundLedger.kind} = 'draw' then ${provisionFundLedger.amountCents} else 0 end), 0)::int`,
    })
    .from(provisionFundLedger)
    .where(tenantWhere)) as unknown as { accrued: number; drawn: number }[];
  return Number(rows[0]?.accrued ?? 0) - Number(rows[0]?.drawn ?? 0);
}

/** Ledger rows (tenant-scoped or platform-level), newest first. */
export async function listProvisionLedger(db: DbHandle, tenantId: string | null, limit = 50) {
  const tenantWhere = tenantId == null ? isNull(provisionFundLedger.tenantId) : eq(provisionFundLedger.tenantId, tenantId);
  return (await db
    .select()
    .from(provisionFundLedger)
    .where(tenantWhere)
    .orderBy(desc(provisionFundLedger.createdAt))
    .limit(Math.max(1, Math.min(limit, 200)))) as unknown as (typeof provisionFundLedger.$inferSelect)[];
}

/**
 * ACCRUAL post-commit seam: divert provision_fund_bps of a facility fee
 * accrual to the fund. Idempotent (`prov:accr:<feeRef>` unique ref —
 * replays are no-ops). NEVER throws: returns { accrued: 0 } on config or
 * insert failure (fail-open telemetry — fee accrual must never break).
 */
export async function accrueFromFeeEvent(
  db: DbHandle,
  opts: { tenantId: string; feeRef: string; feeCents: number; platformShare?: boolean },
): Promise<{ accrued: number; ref: string }> {
  const ref = `prov:accr:${opts.feeRef}`.slice(0, 128);
  try {
    if (!Number.isSafeInteger(opts.feeCents) || opts.feeCents <= 0) return { accrued: 0, ref };
    const bps = await getProvisionFundBps(db);
    if (bps <= 0) return { accrued: 0, ref };
    const amountCents = Math.round((opts.feeCents * bps) / 10_000);
    if (amountCents <= 0) return { accrued: 0, ref };
    const rows = (await db
      .insert(provisionFundLedger)
      .values({
        tenantId: opts.platformShare ? null : opts.tenantId,
        kind: "accrual",
        amountCents,
        ref,
        note: `Provision accrual ${bps}bps of fee ${opts.feeRef} (${opts.feeCents} cents)`,
      })
      .onConflictDoNothing()
      .returning({ id: provisionFundLedger.id })) as unknown as { id: string }[];
    return { accrued: rows.length > 0 ? amountCents : 0, ref };
  } catch (e: any) {
    try {
      process.stdout.write(JSON.stringify({
        level: "warn", metric: "provision_accrual_failed",
        tenantId: opts.tenantId, feeRef: opts.feeRef, error: String(e?.message ?? e).slice(0, 300),
      }) + "\n");
    } catch { /* telemetry must never break the money path */ }
    return { accrued: 0, ref };
  }
}

/**
 * DRAW: admin-approved write-off / insurance-claim shortfall. FAIL-CLOSED:
 * refuses when the fund balance is insufficient (the balance check runs
 * inside the same transaction as the insert; the unique ref keeps retries
 * idempotent). The approval gate (W31 thresholds, kind 'provision_draw')
 * lives in the ROUTER.
 */
export async function drawFromFund(
  db: DbHandle,
  opts: { tenantId: string | null; amountCents: number; ref: string; reason: string; actorId: string; now?: Date },
): Promise<{ ok: true; balanceAfter: number; duplicate: boolean }> {
  assertIntCents(opts.amountCents, "amountCents");
  if (!opts.reason?.trim()) throw new ProvisionError("BAD_REQUEST", "A non-empty reason is required for a provision draw");
  const ref = `prov:draw:${opts.ref}`.slice(0, 128);

  return await db.transaction(async (tx) => {
    const balance = await getProvisionBalance(tx as any, opts.tenantId);
    const existing = (await tx
      .select({ id: provisionFundLedger.id })
      .from(provisionFundLedger)
      .where(eq(provisionFundLedger.ref, ref))
      .limit(1)) as unknown as { id: string }[];
    if (existing[0]) return { ok: true as const, balanceAfter: balance, duplicate: true };
    if (balance < opts.amountCents) {
      throw new ProvisionError("INSUFFICIENT_FUNDS", `provision fund balance ${balance} < draw ${opts.amountCents}`);
    }
    await tx.insert(provisionFundLedger).values({
      tenantId: opts.tenantId,
      kind: "draw",
      amountCents: opts.amountCents,
      ref,
      note: `Provision draw by ${opts.actorId}: ${opts.reason.trim()}`,
    });
    return { ok: true as const, balanceAfter: balance - opts.amountCents, duplicate: false };
  });
}

/**
 * RECOVERY CREDIT: post-default recoveries credit the fund. Idempotent
 * (`prov:rec:<ref>`), integer cents, never throws into the recovery path
 * (returns credited:false on failure — fail-open telemetry).
 */
export async function recoveryCredit(
  db: DbHandle,
  opts: { tenantId: string | null; amountCents: number; ref: string; note?: string },
): Promise<{ credited: boolean; ref: string }> {
  const ref = `prov:rec:${opts.ref}`.slice(0, 128);
  try {
    assertIntCents(opts.amountCents, "amountCents");
    const rows = (await db
      .insert(provisionFundLedger)
      .values({
        tenantId: opts.tenantId,
        kind: "recovery_credit",
        amountCents: opts.amountCents,
        ref,
        note: opts.note?.slice(0, 500) ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: provisionFundLedger.id })) as unknown as { id: string }[];
    return { credited: rows.length > 0, ref };
  } catch (e: any) {
    try {
      process.stdout.write(JSON.stringify({
        level: "warn", metric: "provision_recovery_failed",
        tenantId: opts.tenantId, ref, error: String(e?.message ?? e).slice(0, 300),
      }) + "\n");
    } catch { /* fail-open */ }
    return { credited: false, ref };
  }
}
// === END W57 risk-shield ===
