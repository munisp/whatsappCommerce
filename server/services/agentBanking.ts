// === W59 banking-pos ===
/**
 * W59 banking-pos (Feature 2) — agent banking cash-in/cash-out (CICO).
 *
 * An agent (a tenant flagged settings.agentBanking.enabled) moves cash
 * against a customer's store-credit wallet:
 *
 *   cash_in : agent float wallet −amount → customer wallet +amount
 *   cash_out: customer wallet −(amount+fee) → agent float wallet +amount,
 *             platform fee wallet +fee
 *   both    : platform fee wallet −commission → agent float wallet +commission
 *
 * MONEY DISCIPLINE (all integer cents at the boundaries; wallet balances are
 * numeric(14,2) NGN major units, converted with exact cents↔major at the
 * edges):
 *  - ONE DB transaction per CICO: ledger claim row (agent_cico_transactions,
 *    unique reference) → claim-first guarded debits → credits. Any failure
 *    rolls EVERYTHING back — no partial states.
 *  - Claim-first idempotency: reference `CICO-<clientRef>` is the unique
 *    claim; replays return the existing row with duplicate:true and move NO
 *    money.
 *  - Insufficient agent float (cash-in) or customer balance (cash-out) is
 *    FAIL-CLOSED: the guarded UPDATE matches 0 rows → throw → rollback.
 *  - Commission is platform-fee-wallet-funded, claim-first
 *    (reference `cicocomm:<reference>` on wallet_tx_wallet_ref_uniq). When
 *    the platform wallet can't cover the commission the commission leg is
 *    honestly skipped (commissionCents=0) — the customer's money never
 *    depends on platform float.
 *  - EXACT INTEGER-CENT SPLIT: commissionCents = floor(amountCents ×
 *    agent_commission_bps / 10000); the rounding remainder stays with the
 *    platform. feeCents is an explicit flat customer fee (default 0):
 *    customerDebit = amountCents + feeCents; agentCredit = amountCents;
 *    platformCredit = feeCents; platformDebit = commissionCents. Debits and
 *    credits always balance.
 *  - Low-float WA alert is FAIL-OPEN (notify doctrine): a send failure never
 *    fails the CICO.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  agentCicoTransactions,
  merchantWallets,
  tenants,
  walletTransactions,
} from "../../drizzle/schema";
import { escrowConfig } from "../../drizzle/schema";

/** Platform escrow config row (id=1), seeded on first read — same convention
 *  as routers/escrow.ts getEscrowConfig. */
async function getEscrowConfigCached(db: Db) {
  const [cfg] = await db.select().from(escrowConfig).where(eq(escrowConfig.id, 1));
  if (cfg) return cfg;
  await db.insert(escrowConfig).values({ id: 1, updatedAt: new Date() }).onConflictDoNothing();
  const [seeded] = await db.select().from(escrowConfig).where(eq(escrowConfig.id, 1));
  return seeded ?? null;
}

type Db = any;

const PLATFORM_FEE_WALLET_ID = "platform-fee-wallet";
const PLATFORM_FEE_TENANT_ID = "platform-fees";

export class CicoDuplicateError extends Error {
  constructor(readonly reference: string) {
    super(`CICO duplicate reference ${reference}`);
    this.name = "CicoDuplicateError";
  }
}

/** Agent float = the agent tenant's PSP merchant wallet (numeric major NGN). */
async function getOrCreateAgentWallet(db: Db, agentTenantId: string) {
  const [wallet] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, agentTenantId));
  if (wallet) return wallet;
  const id = crypto.randomUUID();
  await db.insert(merchantWallets).values({ id, tenantId: agentTenantId, custodyMode: "psp" }).onConflictDoNothing();
  const [created] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, agentTenantId));
  if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "agent wallet unavailable" });
  return created;
}

async function getOrCreatePlatformFeeWallet(tx: Db) {
  const [existing] = await tx.select().from(merchantWallets).where(eq(merchantWallets.id, PLATFORM_FEE_WALLET_ID));
  if (existing) return existing;
  await tx.insert(merchantWallets).values({
    id: PLATFORM_FEE_WALLET_ID, tenantId: PLATFORM_FEE_TENANT_ID, currency: "NGN",
    availableBalance: "0", escrowBalance: "0", totalEarned: "0", totalWithdrawn: "0",
    custodyMode: "psp", isActive: true, createdAt: new Date(), updatedAt: new Date(),
  }).onConflictDoNothing();
  const [created] = await tx.select().from(merchantWallets).where(eq(merchantWallets.id, PLATFORM_FEE_WALLET_ID));
  return created!;
}

/** Capability flag: settings.agentBanking.enabled on the agent tenant. */
export async function assertAgentBankingEnabled(db: Db, agentTenantId: string): Promise<void> {
  const [tenant] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, agentTenantId)).limit(1);
  const settings = (tenant?.settings ?? {}) as Record<string, any>;
  if (settings?.agentBanking?.enabled !== true) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Agent banking is not enabled for this tenant (settings.agentBanking.enabled)" });
  }
}

/** Agent commission config: floor(amountCents × bps / 10000), integer cents. */
export async function agentCommissionCents(db: Db, amountCents: number): Promise<number> {
  const cfg = await getEscrowConfigCached(db);
  const bps = Math.max(0, Number((cfg as any)?.agentCommissionBps ?? (cfg as any)?.agent_commission_bps ?? 0) || 0);
  return Math.floor((amountCents * bps) / 10_000);
}

export interface CicoInput {
  agentTenantId: string;
  customerPhone: string;
  kind: "cash_in" | "cash_out";
  amountCents: number;
  feeCents?: number;
  /** Client idempotency key; stored as `CICO-<clientRef>`. */
  clientRef: string;
}

export interface CicoResult {
  reference: string;
  status: "completed";
  kind: "cash_in" | "cash_out";
  amountCents: number;
  feeCents: number;
  commissionCents: number;
  customerBalanceCents: number;
  agentFloatCents: number;
  duplicate: boolean;
}

/**
 * Execute one CICO transaction atomically. See module header for the exact
 * split + claim ordering.
 */
export async function executeCico(db: Db, input: CicoInput): Promise<CicoResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "amountCents must be a positive integer" });
  }
  const feeCents = Math.max(0, Math.floor(input.feeCents ?? 0));
  const reference = input.clientRef.startsWith("CICO-") ? input.clientRef : `CICO-${input.clientRef}`;
  const phone = input.customerPhone.replace(/[^\d+]/g, "");
  if (!phone) throw new TRPCError({ code: "BAD_REQUEST", message: "customerPhone required" });

  // Idempotent replay short-circuit BEFORE any money movement.
  const [existing] = await db.select().from(agentCicoTransactions)
    .where(eq(agentCicoTransactions.reference, reference));
  if (existing) {
    return {
      reference,
      status: "completed",
      kind: existing.kind as "cash_in" | "cash_out",
      amountCents: existing.amountCents,
      feeCents: existing.feeCents,
      commissionCents: existing.commissionCents,
      customerBalanceCents: await customerBalanceCents(db, input.agentTenantId, phone),
      agentFloatCents: await agentFloatCents(db, input.agentTenantId),
      duplicate: true,
    };
  }

  const commissionCents = await agentCommissionCents(db, input.amountCents);
  const wallet = await getOrCreateAgentWallet(db, input.agentTenantId);
  const amountMajor = (input.amountCents / 100).toFixed(2);
  const feeMajor = (feeCents / 100).toFixed(2);

  let result: { customerBalanceCents: number; agentFloatCents: number; commissionCents: number };
  try {
    result = await db.transaction(async (tx: Db) => {
      // 1. CICO claim row — the unique reference is the idempotency backstop.
      await tx.insert(agentCicoTransactions).values({
        agentTenantId: input.agentTenantId,
        customerPhone: phone,
        kind: input.kind,
        amountCents: input.amountCents,
        feeCents,
        commissionCents,
        status: "pending",
        reference,
      });

      // 2. Fail-closed debits FIRST (guarded UPDATEs — 0 rows = rollback).
      if (input.kind === "cash_in") {
        // Agent float covers the customer's cash.
        const deb = await tx.execute(sql`
          UPDATE merchant_wallets
          SET available_balance = available_balance - ${amountMajor}::numeric, updated_at = now()
          WHERE id = ${wallet.id} AND available_balance >= ${amountMajor}::numeric
          RETURNING available_balance`);
        const debRow = (Array.isArray(deb) ? deb : (deb as any).rows ?? [])[0];
        if (!debRow) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "INSUFFICIENT_FLOAT: agent float is too low for this cash-in" });
        }
        await tx.insert(walletTransactions).values({
          id: crypto.randomUUID(),
          walletId: wallet.id,
          tenantId: input.agentTenantId,
          type: "agent_cico",
          amount: amountMajor,
          balanceBefore: (parseFloat(String(debRow.available_balance)) + input.amountCents / 100).toFixed(2),
          balanceAfter: String(debRow.available_balance),
          currency: wallet.currency,
          description: `Agent cash-in for customer …${phone.slice(-4)}`,
          reference: `cico:${reference}`,
          metadata: { cicoRef: reference, kind: "cash_in", direction: "debit" },
          createdAt: new Date(),
        });
      } else {
        // cash_out: customer wallet debited (amount + fee) claim-first.
        const debitCents = input.amountCents + feeCents;
        const seen = await tx.execute(sql`
          SELECT id FROM customer_wallet_entries WHERE ref_id = ${`cico:${reference}`} AND direction = 'debit' LIMIT 1`);
        const seenRows = Array.isArray(seen) ? seen : (seen as any).rows ?? [];
        if (seenRows.length === 0) {
          const up = await tx.execute(sql`
            UPDATE customer_wallets
            SET balance_cents = balance_cents - ${debitCents}, updated_at = now()
            WHERE tenant_id = ${input.agentTenantId} AND customer_phone = ${phone} AND balance_cents >= ${debitCents}
            RETURNING id, balance_cents`);
          const upRow = (Array.isArray(up) ? up : (up as any).rows ?? [])[0];
          if (!upRow) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "INSUFFICIENT_FUNDS: customer wallet balance is too low for this cash-out" });
          }
          await tx.execute(sql`
            INSERT INTO customer_wallet_entries
              (tenant_id, wallet_id, customer_phone, direction, amount_cents, balance_after_cents, reason, ref_id, metadata)
            VALUES (${input.agentTenantId}, ${upRow.id}, ${phone}, 'debit', ${debitCents}, ${upRow.balance_cents},
                    'checkout_spend', ${`cico:${reference}`}, ${JSON.stringify({ cicoRef: reference, kind: "cash_out" })}::jsonb)`);
        }
      }

      // 3. Credits.
      let customerBalance: number;
      if (input.kind === "cash_in") {
        // Customer wallet +amount (claim-first ledger entry).
        await tx.execute(sql`
          INSERT INTO customer_wallets (tenant_id, customer_phone, balance_cents)
          VALUES (${input.agentTenantId}, ${phone}, 0)
          ON CONFLICT (tenant_id, customer_phone) DO NOTHING`);
        const claim = await tx.execute(sql`
          INSERT INTO customer_wallet_entries
            (tenant_id, wallet_id, customer_phone, direction, amount_cents, balance_after_cents, reason, ref_id, metadata)
          SELECT ${input.agentTenantId}, w.id, ${phone}, 'credit', ${input.amountCents}, w.balance_cents + ${input.amountCents},
                 'topup', ${`cico:${reference}`}, ${JSON.stringify({ cicoRef: reference, kind: "cash_in" })}::jsonb
          FROM customer_wallets w
          WHERE w.tenant_id = ${input.agentTenantId} AND w.customer_phone = ${phone}
          ON CONFLICT (ref_id, direction) DO NOTHING
          RETURNING id`);
        const claimRows = Array.isArray(claim) ? claim : (claim as any).rows ?? [];
        if (claimRows.length > 0) {
          const up = await tx.execute(sql`
            UPDATE customer_wallets SET balance_cents = balance_cents + ${input.amountCents}, updated_at = now()
            WHERE tenant_id = ${input.agentTenantId} AND customer_phone = ${phone}
            RETURNING balance_cents`);
          customerBalance = Number((Array.isArray(up) ? up : (up as any).rows ?? [])[0]?.balance_cents ?? 0);
        } else {
          customerBalance = await customerBalanceCents(tx, input.agentTenantId, phone);
        }
      } else {
        // cash_out: agent float +amount; platform +fee (when any).
        const lock = await tx.execute(sql`SELECT available_balance FROM merchant_wallets WHERE id = ${wallet.id} FOR UPDATE`);
        const lockRow = (Array.isArray(lock) ? lock : (lock as any).rows ?? [])[0];
        const before = parseFloat(String(lockRow.available_balance));
        await tx.update(merchantWallets).set({
          availableBalance: sql`${merchantWallets.availableBalance} + ${amountMajor}::numeric`,
          updatedAt: new Date(),
        }).where(eq(merchantWallets.id, wallet.id));
        await tx.insert(walletTransactions).values({
          id: crypto.randomUUID(),
          walletId: wallet.id,
          tenantId: input.agentTenantId,
          type: "agent_cico",
          amount: amountMajor,
          balanceBefore: before.toFixed(2),
          balanceAfter: (before + input.amountCents / 100).toFixed(2),
          currency: wallet.currency,
          description: `Agent cash-out for customer …${phone.slice(-4)}`,
          reference: `cico:${reference}`,
          metadata: { cicoRef: reference, kind: "cash_out", direction: "credit" },
          createdAt: new Date(),
        });
        if (feeCents > 0) {
          const platform = await getOrCreatePlatformFeeWallet(tx);
          const plock = await tx.execute(sql`SELECT available_balance FROM merchant_wallets WHERE id = ${platform.id} FOR UPDATE`);
          const pBefore = parseFloat(String((Array.isArray(plock) ? plock : (plock as any).rows ?? [])[0].available_balance));
          await tx.update(merchantWallets).set({
            availableBalance: sql`${merchantWallets.availableBalance} + ${feeMajor}::numeric`,
            totalEarned: sql`${merchantWallets.totalEarned} + ${feeMajor}::numeric`,
            updatedAt: new Date(),
          }).where(eq(merchantWallets.id, platform.id));
          await tx.insert(walletTransactions).values({
            id: crypto.randomUUID(),
            walletId: platform.id,
            tenantId: PLATFORM_FEE_TENANT_ID,
            type: "float_income", // no fee_credit enum value (additive-only doctrine)
            amount: feeMajor,
            balanceBefore: pBefore.toFixed(2),
            balanceAfter: (pBefore + feeCents / 100).toFixed(2),
            currency: wallet.currency,
            description: `Agent cash-out customer fee (${reference})`,
            reference: `cicofee:${reference}`,
            metadata: { source: "agent_cico_fee", cicoRef: reference, agentTenantId: input.agentTenantId },
            createdAt: new Date(),
          });
        }
        customerBalance = await customerBalanceCents(tx, input.agentTenantId, phone);
      }

      // 4. Commission leg (both kinds): platform fee wallet → agent float,
      //    claim-first on `cicocomm:<reference>`; skipped honestly when the
      //    platform wallet can't cover it (customer money never depends on
      //    platform float).
      let paidCommission = 0;
      if (commissionCents > 0) {
        const platform = await getOrCreatePlatformFeeWallet(tx);
        const commMajor = (commissionCents / 100).toFixed(2);
        const pdeb = await tx.execute(sql`
          UPDATE merchant_wallets
          SET available_balance = available_balance - ${commMajor}::numeric, updated_at = now()
          WHERE id = ${platform.id} AND available_balance >= ${commMajor}::numeric
          RETURNING available_balance`);
        const pdebRow = (Array.isArray(pdeb) ? pdeb : (pdeb as any).rows ?? [])[0];
        if (pdebRow) {
          paidCommission = commissionCents;
          await tx.insert(walletTransactions).values({
            id: crypto.randomUUID(),
            walletId: platform.id,
            tenantId: PLATFORM_FEE_TENANT_ID,
            type: "fee_deduction",
            amount: commMajor,
            balanceBefore: (parseFloat(String(pdebRow.available_balance)) + commissionCents / 100).toFixed(2),
            balanceAfter: String(pdebRow.available_balance),
            currency: "NGN",
            description: `Agent CICO commission payout (${reference})`,
            reference: `cicocomm:${reference}`,
            metadata: { source: "agent_cico_commission", cicoRef: reference, agentTenantId: input.agentTenantId, direction: "debit" },
            createdAt: new Date(),
          });
          const alock = await tx.execute(sql`SELECT available_balance FROM merchant_wallets WHERE id = ${wallet.id} FOR UPDATE`);
          const aBefore = parseFloat(String((Array.isArray(alock) ? alock : (alock as any).rows ?? [])[0].available_balance));
          await tx.update(merchantWallets).set({
            availableBalance: sql`${merchantWallets.availableBalance} + ${commMajor}::numeric`,
            totalEarned: sql`${merchantWallets.totalEarned} + ${commMajor}::numeric`,
            updatedAt: new Date(),
          }).where(eq(merchantWallets.id, wallet.id));
          await tx.insert(walletTransactions).values({
            id: crypto.randomUUID(),
            walletId: wallet.id,
            tenantId: input.agentTenantId,
            type: "agent_cico",
            amount: commMajor,
            balanceBefore: aBefore.toFixed(2),
            balanceAfter: (aBefore + commissionCents / 100).toFixed(2),
            currency: wallet.currency,
            description: `Agent CICO commission (${reference})`,
            reference: `cicocomm:${reference}`,
            metadata: { cicoRef: reference, kind: input.kind, direction: "commission_credit" },
            createdAt: new Date(),
          });
        }
      }
      if (paidCommission !== commissionCents) {
        await tx.update(agentCicoTransactions).set({ commissionCents: paidCommission })
          .where(eq(agentCicoTransactions.reference, reference));
      }

      // 5. Flip the claim row to completed (same commit).
      await tx.update(agentCicoTransactions).set({ status: "completed" })
        .where(eq(agentCicoTransactions.reference, reference));

      const floatCents = await agentFloatCents(tx, input.agentTenantId);
      return { customerBalanceCents: customerBalance, agentFloatCents: floatCents, commissionCents: paidCommission };
    });
  } catch (err: any) {
    // 23505 on the CICO reference = a concurrent twin committed first —
    // translate into an idempotent replay of THAT row (no money moved here).
    if (String(err?.code) === "23505" && String(err?.message ?? "").includes("agent_cico_transactions_ref_uniq")) {
      const [row] = await db.select().from(agentCicoTransactions).where(eq(agentCicoTransactions.reference, reference));
      if (row) {
        return {
          reference, status: "completed", kind: row.kind as "cash_in" | "cash_out",
          amountCents: row.amountCents, feeCents: row.feeCents, commissionCents: row.commissionCents,
          customerBalanceCents: await customerBalanceCents(db, input.agentTenantId, phone),
          agentFloatCents: await agentFloatCents(db, input.agentTenantId),
          duplicate: true,
        };
      }
    }
    throw err;
  }

  // Fail-open low-float WA alert (notify doctrine — never fails the CICO).
  await maybeAlertLowFloat(db, input.agentTenantId, result.agentFloatCents).catch(() => {});

  return {
    reference,
    status: "completed",
    kind: input.kind,
    amountCents: input.amountCents,
    feeCents,
    commissionCents: result.commissionCents,
    customerBalanceCents: result.customerBalanceCents,
    agentFloatCents: result.agentFloatCents,
    duplicate: false,
  };
}

export async function agentFloatCents(db: Db, agentTenantId: string): Promise<number> {
  const [wallet] = await db.select({ availableBalance: merchantWallets.availableBalance })
    .from(merchantWallets).where(eq(merchantWallets.tenantId, agentTenantId));
  return Math.round(parseFloat(String(wallet?.availableBalance ?? "0")) * 100);
}

export async function customerBalanceCents(db: Db, tenantId: string, phone: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT balance_cents FROM customer_wallets WHERE tenant_id = ${tenantId} AND customer_phone = ${phone} LIMIT 1`);
  const row = (Array.isArray(res) ? res : (res as any).rows ?? [])[0];
  return Number(row?.balance_cents ?? 0);
}

export interface FloatSummary {
  agentTenantId: string;
  floatCents: number;
  thresholdCents: number;
  lowFloat: boolean;
  todayCashInCents: number;
  todayCashOutCents: number;
  todayCommissionCents: number;
  recent: Array<{ reference: string; kind: string; amountCents: number; commissionCents: number; status: string; customerPhone: string; createdAt: Date }>;
}

export async function floatSummary(db: Db, agentTenantId: string): Promise<FloatSummary> {
  const cfg = await getEscrowConfigCached(db);
  const thresholdCents = Math.max(0, Number((cfg as any)?.agentFloatAlertThresholdCents ?? (cfg as any)?.agent_float_alert_threshold_cents ?? 0) || 0);
  const floatCents = await agentFloatCents(db, agentTenantId);
  const recent = await db.select().from(agentCicoTransactions)
    .where(eq(agentCicoTransactions.agentTenantId, agentTenantId))
    .orderBy(desc(agentCicoTransactions.createdAt))
    .limit(20);
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  let todayCashInCents = 0, todayCashOutCents = 0, todayCommissionCents = 0;
  for (const r of recent) {
    if (r.status !== "completed" || r.createdAt < todayStart) continue;
    if (r.kind === "cash_in") todayCashInCents += r.amountCents;
    if (r.kind === "cash_out") todayCashOutCents += r.amountCents;
    todayCommissionCents += r.commissionCents;
  }
  return {
    agentTenantId,
    floatCents,
    thresholdCents,
    lowFloat: thresholdCents > 0 && floatCents < thresholdCents,
    todayCashInCents,
    todayCashOutCents,
    todayCommissionCents,
    recent: recent.map((r: any) => ({
      reference: r.reference, kind: r.kind, amountCents: r.amountCents,
      commissionCents: r.commissionCents, status: r.status,
      customerPhone: r.customerPhone, createdAt: r.createdAt,
    })),
  };
}

/** Fail-open low-float WA alert to the tenant admin phone (notify doctrine). */
export async function maybeAlertLowFloat(db: Db, agentTenantId: string, floatCents?: number): Promise<boolean> {
  try {
    const summary = floatCents === undefined ? await floatSummary(db, agentTenantId) : null;
    const cents = floatCents ?? summary!.floatCents;
    const thresholdCents = summary ? summary.thresholdCents : (await floatSummary(db, agentTenantId)).thresholdCents;
    if (thresholdCents <= 0 || cents >= thresholdCents) return false;
    const [tenant] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, agentTenantId)).limit(1);
    const { resolveAdminPhone } = await import("./creditWhatsApp");
    const adminPhone = resolveAdminPhone((tenant?.settings ?? null) as Record<string, unknown> | null);
    if (!adminPhone) return false;
    const { sendWhatsAppText } = await import("./waSender");
    const { t27 } = await import("./i18n");
    const fmt = (c: number) => `NGN ${(c / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
    await sendWhatsAppText(agentTenantId, adminPhone, t27("en", "agentLowFloatAlert", { float: fmt(cents), threshold: fmt(thresholdCents) }), {
      notifType: "agent_low_float",
    });
    return true;
  } catch (err: any) {
    console.warn("[agent-banking] low-float alert failed (fail-open):", err?.message);
    return false;
  }
}

export async function listCicoTransactions(db: Db, agentTenantId: string, limit = 50) {
  return db.select().from(agentCicoTransactions)
    .where(eq(agentCicoTransactions.agentTenantId, agentTenantId))
    .orderBy(desc(agentCicoTransactions.createdAt))
    .limit(Math.min(200, Math.max(1, limit)));
}
