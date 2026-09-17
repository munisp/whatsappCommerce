// === W45 money-intents ===
/**
 * server/services/payments/staleTransferSweep.ts — PAY-24 (W45 Coder B2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Cron sweep for STALE non-terminal Paystack transfers (merchant wallet
 * withdrawals). Before W45, verifyTransfer existed only in the initiate
 * timeout path: a withdrawal that went pending/processing/otp and whose
 * webhook never arrived sat forever with the merchant's balance debited.
 *
 * Policy:
 *   - Non-terminal rows (metadata.status pending/processing/uncertain) older
 *     than `staleMinutes` → verifyTransfer(reference):
 *       * failed / reversed / NOT FOUND → compensating credit via the
 *         claim-first finalizeWalletWithdrawal (never double-credits).
 *       * success → finalize completed (same claim-first path).
 *       * still pending/processing → leave for the next sweep.
 *       * verify itself inconclusive (network) → leave + warn (verify-before-
 *         compensate: never refund on an unknown provider state).
 *   - OTP-gated rows older than `otpStaleMinutes` → ops alert (critical
 *     capture + notifyOwner) AND auto-cancel with compensating credit: a
 *     transfer OTP no human finalized within the window will not complete.
 *
 * Driven by POST /api/scheduled/transfer-sweep (W42 cronAuth scope+jti,
 * scheduler.mjs allowlist — J178 contract).
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { walletTransactions } from "../../../drizzle/schema";
import { ENV } from "../../_core/env";
import { captureException } from "../observability";
import { verifyTransfer, PaystackTransferError } from "./paystackTransfer";
import { finalizeWalletWithdrawal } from "../../routers/escrow";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface StaleTransferSweepResult {
  scanned: number;
  verifiedFailed: number;
  compensated: number;
  completed: number;
  stillPending: number;
  verifyInconclusive: number;
  otpAutoCancelled: number;
  errors: string[];
}

export const STALE_TRANSFER_MINUTES = 30;
export const STALE_OTP_MINUTES = 60;

export async function runStaleTransferSweep(opts: {
  now?: Date;
  staleMinutes?: number;
  otpStaleMinutes?: number;
  batchSize?: number;
} = {}): Promise<StaleTransferSweepResult> {
  const result: StaleTransferSweepResult = {
    scanned: 0,
    verifiedFailed: 0,
    compensated: 0,
    completed: 0,
    stillPending: 0,
    verifyInconclusive: 0,
    otpAutoCancelled: 0,
    errors: [],
  };
  const db = await getDb();
  if (!db) {
    result.errors.push("db-unavailable");
    return result;
  }
  if (!ENV.paystackSecretKey) {
    result.errors.push("paystack-secret-unavailable");
    return result;
  }

  const now = opts.now ?? new Date();
  const staleMinutes = opts.staleMinutes ?? STALE_TRANSFER_MINUTES;
  const otpStaleMinutes = opts.otpStaleMinutes ?? STALE_OTP_MINUTES;
  const batchSize = opts.batchSize ?? 50;
  const staleCutoff = new Date(now.getTime() - staleMinutes * 60_000);
  const otpCutoff = new Date(now.getTime() - otpStaleMinutes * 60_000);

  // Stale non-terminal withdrawal rows (pending/processing/uncertain) and
  // stale OTP-gated rows — two windows, one scan.
  const rows = await db
    .select()
    .from(walletTransactions)
    .where(and(
      eq(walletTransactions.type, "withdrawal"),
      sql`${walletTransactions.createdAt} < ${staleCutoff.toISOString()}`,
      sql`${walletTransactions.metadata} ->> 'status' IN ('pending', 'processing', 'uncertain', 'otp')`,
    ))
    .limit(batchSize);

  for (const row of rows) {
    result.scanned += 1;
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const status = String(meta.status ?? "");
    const reference = row.reference ?? "";
    if (!reference) {
      result.errors.push(`wallet_tx ${row.id}: no reference`);
      continue;
    }

    // ── Stale OTP: alert + auto-cancel (compensating credit) ─────────────
    if (status === "otp") {
      if (new Date(row.createdAt as unknown as string) >= otpCutoff) {
        result.stillPending += 1; // OTP row, but still inside the grace window
        continue;
      }
      const alertMsg =
        `[PAY-24] stale OTP-gated transfer auto-cancelled: ref=${reference} tenant=${row.tenantId} ` +
        `amount=${row.amount} ${row.currency} — no human finalized the Paystack transfer OTP within ${otpStaleMinutes}m`;
      captureException(new Error(alertMsg), {
        service: "payments/staleTransferSweep",
        operation: "staleOtpAutoCancel",
        tenantId: row.tenantId,
        severity: "critical",
        extra: { reference, walletTxId: row.id },
      });
      try {
        const { notifyOwner } = await import("../../_core/notification");
        await notifyOwner({ title: "Stale OTP transfer auto-cancelled (PAY-24)", content: alertMsg });
      } catch { /* best-effort */ }
      const fin = await finalizeWalletWithdrawal(db, {
        reference,
        event: "transfer.failed",
        reason: `stale_otp_auto_cancel: no OTP finalization within ${otpStaleMinutes}m`,
      });
      if (fin.ok && fin.action === "refunded") {
        result.otpAutoCancelled += 1;
        result.compensated += 1;
      }
      continue;
    }

    // ── Stale pending/processing/uncertain: verify against the provider ──
    let verified: Awaited<ReturnType<typeof verifyTransfer>> | null = null;
    try {
      verified = await verifyTransfer(ENV.paystackSecretKey, reference);
    } catch (err: unknown) {
      // Inconclusive — NEVER compensate on an unknown provider state.
      result.verifyInconclusive += 1;
      const msg = err instanceof PaystackTransferError ? err.message : String((err as Error)?.message ?? err);
      console.warn(`[transfer-sweep] verify inconclusive for ${reference}: ${msg}`);
      continue;
    }

    const verifiedStatus = verified.found ? (verified.status ?? "") : "failed";
    if (!verified.found) result.verifiedFailed += 1;

    if (verifiedStatus === "failed" || verifiedStatus === "reversed") {
      // Definitive failure (or no such transfer at all) → compensating credit.
      const fin = await finalizeWalletWithdrawal(db, {
        reference,
        event: "transfer.failed",
        reason: verified.found
          ? `stale_sweep: provider status ${verifiedStatus}`
          : "stale_sweep: transfer not found at provider",
      });
      if (fin.ok && fin.action === "refunded") result.compensated += 1;
    } else if (verifiedStatus === "success") {
      const fin = await finalizeWalletWithdrawal(db, {
        reference,
        event: "transfer.success",
        reason: "stale_sweep: provider reports success",
      });
      if (fin.ok && fin.action === "completed") result.completed += 1;
    } else {
      // still pending/processing/otp provider-side — next sweep re-checks.
      result.stillPending += 1;
    }
  }

  if (result.scanned > 0) {
    console.log(
      `[transfer-sweep] scanned=${result.scanned} compensated=${result.compensated} completed=${result.completed} ` +
      `otpAutoCancelled=${result.otpAutoCancelled} stillPending=${result.stillPending} inconclusive=${result.verifyInconclusive}`,
    );
  }
  return result;
}
