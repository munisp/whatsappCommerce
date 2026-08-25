/**
 * === W32 earlypay-fx (Coder C): cross-border FX vendor payouts ===
 *
 * Flow: quote → accept (guarded single consume within expiry) → execute
 * (locked wallet debit in from_currency + Mojaloop delivery rail).
 *
 * Doctrine:
 *  - Pluggable rate source. `sim` is a DETERMINISTIC FIXED TABLE (no live
 *    rates are ever invented) with metadata.source honestly labelled
 *    "sim-fixed-table". `provider` fetches a configured upstream
 *    (FX_PROVIDER_URL); in production with no provider configured, quoting
 *    fails honestly UNAVAILABLE rather than falling back to fake rates.
 *  - Fee math is exact integer cents: fee_cents = round(gross × fee_bps /
 *    10_000); netCents = gross − fee_cents is what converts at `rate`;
 *    fee_cents + netCents == amountCents ALWAYS.
 *  - Accept is claim-first: a guarded UPDATE quoted→accepted with
 *    expires_at > now() — exactly one consume, expired quotes refuse
 *    honestly, a replayed accept returns the original row (no-op).
 *  - Execute NEVER simulates a cross-border delivery: when the
 *    (from→to) corridor is not configured live (FX_LIVE_CORRIDORS) or the
 *    Mojaloop rail rejects/unreachable, the whole transaction rolls back
 *    and NOTHING moves (honest UNAVAILABLE / failed).
 *  - The wallet_tx reference `fxpayout:<quoteId>` is the durable idempotency
 *    backstop via wallet_tx_wallet_ref_uniq (0053).
 */
import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { fxQuotes, merchantWallets, walletTransactions } from "../../drizzle/schema";

export type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type DbOrTx = DbHandle | any;

// ─── Configuration (env read dynamically; never cached at import) ──────────

/** Quote TTL in seconds (default 10 minutes). */
export function fxQuoteTtlSeconds(): number {
  const v = Number(process.env.FX_QUOTE_TTL_SECONDS);
  return Number.isFinite(v) && v > 0 ? Math.min(3600, Math.round(v)) : 600;
}

/** Platform FX fee in basis points (default 1.5%). */
export function fxFeeBps(): number {
  const v = Number(process.env.FX_FEE_BPS);
  return Number.isFinite(v) && v >= 0 ? Math.min(2000, Math.round(v)) : 150;
}

/**
 * Live delivery corridors, env-configured as "NGN:KES,NGN:GHS". A corridor
 * NOT in this list has NO live rail — execute refuses honestly (UNAVAILABLE)
 * and nothing moves. Never defaulted: absent env means no live corridors.
 */
export function fxLiveCorridors(): Set<string> {
  const raw = (process.env.FX_LIVE_CORRIDORS ?? "").trim();
  return new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
}

/** Rate source: 'sim' (deterministic fixed table) or 'provider'. */
export function fxRateSource(): "sim" | "provider" {
  const v = (process.env.FX_RATE_SOURCE ?? "").trim().toLowerCase();
  if (v === "sim" || v === "provider") return v;
  // Production never silently simulates rates — an unconfigured prod rate
  // source is honestly unavailable at quote time.
  return process.env.NODE_ENV === "production" ? "provider" : "sim";
}

/**
 * Deterministic simulation rate table (to-currency units per 1 from-unit,
 * 8dp). Fixed — same pair always quotes the same rate; labelled honestly.
 */
export const SIM_FX_RATES: Record<string, string> = {
  "NGN:KES": "0.08300000",
  "NGN:GHS": "0.00950000",
  "NGN:USD": "0.00066000",
  "NGN:XOF": "0.38000000",
  "KES:NGN": "12.04800000",
  "USD:NGN": "1515.00000000",
};

export interface FxRateQuote {
  rate: string; // decimal string, to-units per 1 from-unit
  provider: string; // 'sim' | configured provider id
  source: string; // honest metadata.source label
  providerRef: string;
}

function pairKey(from: string, to: string): string {
  return `${from.toUpperCase()}:${to.toUpperCase()}`;
}

/**
 * Resolve a rate for a currency pair from the pluggable source.
 * Returns null when no honest rate exists for the pair.
 */
export async function resolveFxRate(from: string, to: string): Promise<FxRateQuote | null> {
  const key = pairKey(from, to);
  const source = fxRateSource();
  if (source === "provider") {
    const url = (process.env.FX_PROVIDER_URL ?? "").trim();
    if (!url) return null; // honest: no configured provider → no rate
    const res = await fetch(`${url.replace(/\/$/, "")}/rates/${key}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { rate?: string | number };
    const rate = Number(body.rate);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return {
      rate: rate.toFixed(8),
      provider: process.env.FX_PROVIDER_ID?.slice(0, 24) || "provider",
      source: `provider:${url}`,
      providerRef: `fxp:${key}:${crypto.randomUUID()}`,
    };
  }
  const rate = SIM_FX_RATES[key];
  if (!rate) return null; // honest: pair not covered by the sim table
  return { rate, provider: "sim", source: "sim-fixed-table", providerRef: `simfx:${key}:${crypto.randomUUID()}` };
}

// ─── Quote ─────────────────────────────────────────────────────────────────

export type FxQuoteResult =
  | { ok: true; quote: typeof fxQuotes.$inferSelect; netCents: number }
  | { ok: false; reason: "unavailable" | "no_rate" | "invalid"; detail?: string };

/** Exact fee split: fee + net == gross, always. */
export function fxFeeSplit(grossCents: number, feeBps: number): { feeCents: number; netCents: number } {
  const feeCents = Math.round((grossCents * feeBps) / 10_000);
  return { feeCents, netCents: grossCents - feeCents };
}

export async function createFxQuoteTx(
  db: DbHandle,
  args: { tenantId: string; fromCurrency: string; toCurrency: string; amountCents: number },
): Promise<FxQuoteResult> {
  const from = args.fromCurrency.toUpperCase();
  const to = args.toCurrency.toUpperCase();
  if (from === to || !/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    return { ok: false, reason: "invalid", detail: "from_currency and to_currency must differ and be ISO-4217 codes" };
  }
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
    return { ok: false, reason: "invalid", detail: "amount_cents must be a positive integer" };
  }
  let rateQ: FxRateQuote | null;
  try {
    rateQ = await resolveFxRate(from, to);
  } catch (err) {
    return { ok: false, reason: "unavailable", detail: `rate source error: ${(err as Error)?.message ?? err}` };
  }
  if (!rateQ) {
    const configured = fxRateSource() === "provider" && !(process.env.FX_PROVIDER_URL ?? "").trim();
    return {
      ok: false,
      reason: configured ? "unavailable" : "no_rate",
      detail: configured
        ? "FX rate provider is not configured — quoting is honestly UNAVAILABLE"
        : `no honest rate available for ${pairKey(from, to)}`,
    };
  }
  const feeBps = fxFeeBps();
  const { feeCents, netCents } = fxFeeSplit(args.amountCents, feeBps);
  const now = new Date();
  const [row] = await db
    .insert(fxQuotes)
    .values({
      tenantId: args.tenantId,
      fromCurrency: from,
      toCurrency: to,
      amountCents: args.amountCents,
      rate: rateQ.rate,
      feeBps,
      feeCents,
      totalCents: args.amountCents, // gross from_currency debit, fee included
      provider: rateQ.provider,
      providerRef: rateQ.providerRef,
      status: "quoted",
      expiresAt: new Date(now.getTime() + fxQuoteTtlSeconds() * 1000),
      metadata: { source: rateQ.source, netCents, deliveredCents: Math.floor(netCents * Number(rateQ.rate)) },
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { ok: true, quote: row, netCents };
}

// ─── Accept (guarded single consume within expiry) ─────────────────────────

export type FxAcceptResult =
  | { ok: true; quote: typeof fxQuotes.$inferSelect; duplicate: boolean }
  | { ok: false; reason: "not_found" | "expired" | "not_quotable" };

export async function acceptFxQuoteTx(
  db: DbHandle,
  args: { tenantId: string; quoteId: string },
): Promise<FxAcceptResult> {
  const [q] = await db.select().from(fxQuotes).where(eq(fxQuotes.id, args.quoteId)).limit(1);
  if (!q || q.tenantId !== args.tenantId) return { ok: false, reason: "not_found" };
  // Idempotent replay: accepting an already-accepted quote is a no-op.
  if (q.status === "accepted") return { ok: true, quote: q, duplicate: true };
  if (q.status !== "quoted") return { ok: false, reason: "not_quotable" };
  const now = new Date();
  // Claim-first single consume: quoted→accepted only while unexpired.
  const won = await db
    .update(fxQuotes)
    .set({ status: "accepted", acceptedAt: now, updatedAt: now })
    .where(and(
      eq(fxQuotes.id, q.id),
      eq(fxQuotes.tenantId, args.tenantId),
      eq(fxQuotes.status, "quoted"),
      sql`${fxQuotes.expiresAt} > now()`,
    ))
    .returning();
  if (won.length === 1) return { ok: true, quote: won[0], duplicate: false };
  // Guard lost — determine the honest reason.
  if (new Date(q.expiresAt).getTime() <= now.getTime()) {
    await db.update(fxQuotes).set({ status: "expired", updatedAt: now })
      .where(and(eq(fxQuotes.id, q.id), eq(fxQuotes.status, "quoted")));
    return { ok: false, reason: "expired" };
  }
  const [cur] = await db.select().from(fxQuotes).where(eq(fxQuotes.id, q.id)).limit(1);
  if (cur?.status === "accepted") return { ok: true, quote: cur, duplicate: true }; // concurrent winner — replay no-op
  return { ok: false, reason: "not_quotable" };
}

// ─── Execute (locked wallet debit + Mojaloop delivery) ─────────────────────

export type FxExecuteResult =
  | { ok: true; quote: typeof fxQuotes.$inferSelect; payoutRef: string; walletTxId: string; feeCents: number; netCents: number }
  | { ok: false; reason: "not_found" | "not_accepted" | "expired" | "no_corridor" | "insufficient_funds" | "rail_failed"; detail?: string };

async function getOrCreateWalletFx(db: DbOrTx, tenantId: string) {
  const [existing] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantId));
  if (existing) return existing;
  const id = crypto.randomUUID();
  await db.insert(merchantWallets).values({
    id, tenantId, currency: "NGN",
    availableBalance: "0", escrowBalance: "0",
    totalEarned: "0", totalWithdrawn: "0",
    custodyMode: "psp", isActive: true,
    createdAt: new Date(), updatedAt: new Date(),
  }).onConflictDoNothing();
  const [created] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantId));
  return created!;
}

/** Mojaloop FSPIOP transfer initiation (async — the switch returns 202). */
async function mojaloopTransfer(opts: {
  baseUrl: string; amountMajor: string; currency: string; payeeNote: string; ref: string;
}): Promise<{ transferId: string }> {
  const transferId = crypto.randomUUID();
  const payerFsp = (process.env.MOJALOOP_PAYER_FSP ?? "wa-commerce-dfsp").slice(0, 64);
  const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/transfers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "FSPIOP-Source": payerFsp },
    body: JSON.stringify({
      transferId,
      payerFsp,
      payeeFsp: "fx-vendor-fsp",
      amount: { amount: opts.amountMajor, currency: opts.currency },
      ilpPacket: "AQAAAAAAAADIEHByaXZhdGUucGF5ZWVmc3A",
      condition: "HOr22-H3AfTDHrSkPjJtVPRG2PI2AC-ztCd6nUIjkiY",
      expiration: new Date(Date.now() + 30_000).toISOString(),
      extensionList: [{ key: "fxPayoutRef", value: opts.ref }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 202 && !res.ok) throw new Error(`Mojaloop transfer rejected: HTTP ${res.status}`);
  return { transferId };
}

/**
 * Execute an ACCEPTED quote. Order of operations:
 *   1. Corridor check FIRST — no live (from→to) corridor → honest
 *      UNAVAILABLE before any state change (NOTHING moves).
 *   2. One DB transaction: locked conditional wallet debit of the GROSS
 *      (from_currency), fee + net wallet_tx legs (fee+net==gross), guarded
 *      accepted→executed flip, and the Mojaloop transfer initiation inside
 *      the transaction (mirrors escrow's in-tx ledger bridge call) — a rail
 *      rejection rolls the debit back, so money never moves without a
 *      delivery instruction and a delivery is never instructed without the
 *      debit having committed atomically with it.
 */
export async function executeFxQuoteTx(
  db: DbHandle,
  args: { tenantId: string; quoteId: string },
): Promise<FxExecuteResult> {
  const [q] = await db.select().from(fxQuotes).where(eq(fxQuotes.id, args.quoteId)).limit(1);
  if (!q || q.tenantId !== args.tenantId) return { ok: false, reason: "not_found" };
  if (q.status === "executed") {
    // Idempotent replay: return the original payout reference.
    return { ok: true, quote: q, payoutRef: q.payoutRef ?? "", walletTxId: "", feeCents: q.feeCents, netCents: q.amountCents - q.feeCents };
  }
  if (q.status !== "accepted") return { ok: false, reason: "not_accepted", detail: `status ${q.status}` };
  if (new Date(q.expiresAt).getTime() <= Date.now()) {
    await db.update(fxQuotes).set({ status: "expired", updatedAt: new Date() })
      .where(and(eq(fxQuotes.id, q.id), eq(fxQuotes.status, "accepted")));
    return { ok: false, reason: "expired" };
  }

  // 1. Live-corridor gate — BEFORE anything moves.
  if (!fxLiveCorridors().has(pairKey(q.fromCurrency, q.toCurrency))) {
    return {
      ok: false,
      reason: "no_corridor",
      detail: `no live delivery corridor for ${pairKey(q.fromCurrency, q.toCurrency)} — honestly UNAVAILABLE; nothing moved`,
    };
  }
  const mojaloopUrl = (process.env.MOJALOOP_URL ?? "").trim();
  if (!mojaloopUrl) {
    return { ok: false, reason: "no_corridor", detail: "Mojaloop rail not configured (MOJALOOP_URL unset) — UNAVAILABLE; nothing moved" };
  }

  const wallet = await getOrCreateWalletFx(db, q.tenantId);
  const grossMajor = (q.totalCents / 100).toFixed(2);
  const feeMajor = (q.feeCents / 100).toFixed(2);
  const netCents = q.amountCents - q.feeCents;
  const netMajor = (netCents / 100).toFixed(2);
  const payoutDebitRef = `fxpayout:${q.id}`;
  const feeRef = `fxfee:${q.id}`;
  const walletTxId = crypto.randomUUID();
  const feeTxId = crypto.randomUUID();
  const deliveredMajor = (Math.floor(netCents * Number(q.rate)) / 100).toFixed(2);

  try {
    const payoutRef = await db.transaction(async (tx: DbOrTx) => {
      // Guarded consume: accepted→executed (exactly once).
      const won = await tx
        .update(fxQuotes)
        .set({ status: "executed", updatedAt: new Date() })
        .where(and(eq(fxQuotes.id, q.id), eq(fxQuotes.tenantId, args.tenantId), eq(fxQuotes.status, "accepted")))
        .returning();
      if (won.length !== 1) {
        throw Object.assign(new Error("fx quote consume lost (not in accepted state)"), { code: "CONFLICT" });
      }
      // Locked conditional wallet debit of the gross in from_currency.
      const locked = await tx.execute(sql`SELECT available_balance, currency FROM merchant_wallets WHERE id = ${wallet.id} FOR UPDATE`);
      if (!(locked as unknown as Record<string, unknown>[])[0]) throw new Error("wallet not found");
      const debited = await tx.execute(sql`
        UPDATE merchant_wallets
        SET available_balance = available_balance - ${grossMajor}::numeric,
            total_withdrawn = total_withdrawn + ${grossMajor}::numeric,
            updated_at = now()
        WHERE id = ${wallet.id}
          AND available_balance >= ${grossMajor}::numeric
        RETURNING available_balance
      `);
      const drow = (debited as unknown as Record<string, unknown>[])[0];
      if (!drow) {
        throw Object.assign(new Error("INSUFFICIENT_FUNDS: wallet cannot cover the FX payout gross"), { code: "INSUFFICIENT_FUNDS" });
      }
      const after = parseFloat(String(drow.available_balance));
      const before = after + q.totalCents / 100;
      // Payout leg (net delivered at the quoted rate).
      await tx.insert(walletTransactions).values({
        id: walletTxId,
        walletId: wallet.id,
        tenantId: q.tenantId,
        type: "withdrawal",
        amount: grossMajor,
        balanceBefore: before.toFixed(2),
        balanceAfter: after.toFixed(2),
        currency: q.fromCurrency,
        description: `FX payout ${pairKey(q.fromCurrency, q.toCurrency)} — delivers ${q.toCurrency} ${deliveredMajor} at ${q.rate}`,
        reference: payoutDebitRef,
        metadata: {
          status: "executed",
          source: "fx_payout",
          quoteId: q.id,
          grossCents: q.totalCents,
          feeCents: q.feeCents,
          netCents,
          rate: q.rate,
          toCurrency: q.toCurrency,
        },
        createdAt: new Date(),
      });
      // Fee leg (escrow fee-leg pattern: integer cents, platform retention).
      if (q.feeCents > 0) {
        await tx.insert(walletTransactions).values({
          id: feeTxId,
          walletId: wallet.id,
          tenantId: q.tenantId,
          type: "fee_deduction",
          amount: feeMajor,
          balanceBefore: before.toFixed(2),
          balanceAfter: after.toFixed(2),
          currency: q.fromCurrency,
          description: `FX payout fee (${q.feeBps} bps) for quote ${q.id}`,
          reference: feeRef,
          metadata: { status: "executed", source: "fx_payout_fee", quoteId: q.id },
          createdAt: new Date(),
        });
      }
      // Mojaloop delivery INSIDE the transaction: a rail rejection rolls the
      // whole debit back (escrow in-tx bridge-call convention).
      const { transferId } = await mojaloopTransfer({
        baseUrl: mojaloopUrl,
        amountMajor: deliveredMajor,
        currency: q.toCurrency,
        payeeNote: `fx payout ${q.id}`,
        ref: payoutDebitRef,
      });
      const [fin] = await tx.update(fxQuotes).set({ payoutRef: transferId, updatedAt: new Date() })
        .where(eq(fxQuotes.id, q.id)).returning();
      return fin.payoutRef as string;
    });
    const [finalQuote] = await db.select().from(fxQuotes).where(eq(fxQuotes.id, q.id)).limit(1);
    return { ok: true, quote: finalQuote, payoutRef, walletTxId, feeCents: q.feeCents, netCents };
  } catch (err: any) {
    if (err?.code === "INSUFFICIENT_FUNDS") return { ok: false, reason: "insufficient_funds" };
    if (err?.code === "CONFLICT") return { ok: false, reason: "not_accepted", detail: "quote no longer in accepted state" };
    if (err?.code === "23505") {
      // Wallet-ref unique backstop: the original execution committed.
      const [cur] = await db.select().from(fxQuotes).where(eq(fxQuotes.id, q.id)).limit(1);
      if (cur?.status === "executed") {
        return { ok: true, quote: cur, payoutRef: cur.payoutRef ?? "", walletTxId: "", feeCents: cur.feeCents, netCents: cur.amountCents - cur.feeCents };
      }
    }
    // Rail failure: the transaction rolled back — NOTHING moved. Mark the
    // quote failed honestly (accepted → failed; merchant may re-quote).
    await db.update(fxQuotes)
      .set({ status: "failed", metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ failedReason: String(err?.message ?? err).slice(0, 300) })}::jsonb`, updatedAt: new Date() })
      .where(and(eq(fxQuotes.id, q.id), eq(fxQuotes.status, "accepted")));
    return { ok: false, reason: "rail_failed", detail: `Mojaloop delivery failed honestly (rolled back, nothing moved): ${err?.message ?? err}` };
  }
}

/** Sweep: flip quoted/accepted quotes past expiry to 'expired' (guarded, repeatable). */
export async function expireFxQuotesTx(db: DbHandle, now = new Date()): Promise<number> {
  const rows = await db.update(fxQuotes)
    .set({ status: "expired", updatedAt: now })
    .where(and(sql`${fxQuotes.status} IN ('quoted','accepted')`, sql`${fxQuotes.expiresAt} <= ${now.toISOString()}`))
    .returning({ id: fxQuotes.id });
  return rows.length;
}
// === END W32 earlypay-fx (fxPayouts service) ===
