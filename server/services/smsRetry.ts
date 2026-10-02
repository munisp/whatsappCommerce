// === W61 dataloss ===
/**
 * W61 SMS retry sweep (audit CRITICAL #3) — server/services/smsRetry.ts
 *
 * smsSender.sendSms logs every failed attempt to channel_messages
 * (channel='sms', direction='outbound', metadata.status='failed') but NOTHING
 * ever retried those rows — WA→SMS failover messages (channelParity.ts)
 * could be silently lost. This sweep closes the gap, mirroring
 * waSender.runWaSendRetries semantics on the channel_messages ledger:
 *
 *   - Selects due rows: metadata.status='failed',
 *     metadata.failureClass='retriable', retryCount < SMS_RETRY_MAX_ATTEMPTS
 *     (= WA_RETRY_MAX_ATTEMPTS), nextRetryAt elapsed.
 *   - CLAIM-FIRST: a guarded UPDATE flips metadata.status to 'retrying' with a
 *     unique claim token; only the claiming run proceeds (a concurrent sweep
 *     sees 0 rows updated and skips).
 *   - Resends via smsSender.sendSms with skipLog (the ORIGINAL row is the
 *     ledger — no duplicate channel_messages rows), idempotency keyed by the
 *     original failoverKey when present.
 *   - Success → metadata.status='sent' (row marked processed=true).
 *   - Failure → retryCount++, nextRetryAt = now + WA_RETRY_BACKOFF_MS[n],
 *     status back to 'failed'.
 *   - Exhausted → metadata.status='dead' + tenant admin WhatsApp alert
 *     (same ops path as waSender.sendDeadLetterAlert). Never silent.
 *   - Fail-open throughout: a broken sweep must never crash the cron route.
 */

import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { channelMessages } from "../../drizzle/schema";
import { WA_RETRY_BACKOFF_MS, WA_RETRY_MAX_ATTEMPTS } from "./waSender";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const SMS_RETRY_MAX_ATTEMPTS = WA_RETRY_MAX_ATTEMPTS;
export const SMS_RETRY_BACKOFF_MS = WA_RETRY_BACKOFF_MS;

export interface SmsRetryRunResult {
  due: number;
  claimed: number;
  resent: number;
  retried: number;
  dead: number;
  skipped: number;
}

interface SmsRetryMeta {
  status?: string;
  failureClass?: string;
  failReason?: string | null;
  retryCount?: number;
  nextRetryAt?: string | null;
  failoverKey?: string | null;
  claimToken?: string | null;
  provider?: string | null;
  [k: string]: unknown;
}

/** Alert the tenant admin that an SMS dead-lettered. Never throws. */
async function sendSmsDeadLetterAlert(
  db: Db,
  row: { tenantId: string | null; toAddress: string | null },
  errorSummary: string,
): Promise<void> {
  try {
    if (!row.tenantId) return;
    const { notifyTenantAdminWhatsApp } = await import("./adminAlerts");
    const delivered = await notifyTenantAdminWhatsApp(
      db,
      row.tenantId,
      `⚠️ SMS dead-lettered after ${SMS_RETRY_MAX_ATTEMPTS} attempts.\n` +
        `To: ${row.toAddress ?? "?"}\nError: ${errorSummary.slice(0, 300)}`,
    );
    if (!delivered) {
      console.error(`[smsRetry] ALERT not deliverable (tenant=${row.tenantId}): SMS dead-letter to ${row.toAddress ?? "?"} — ${errorSummary.slice(0, 200)}`);
    }
  } catch (e: any) {
    console.error("[smsRetry] dead-letter alert path failed:", e?.message);
  }
}

/**
 * Retry due failed SMS sends. Bounded (default 25 rows), claim-first,
 * exponential backoff (1m, 5m, 15m, 1h), dead-letter after 4 attempts.
 * Never throws.
 */
export async function runSmsSendRetries(
  db: Db,
  opts?: { now?: Date; limit?: number },
): Promise<SmsRetryRunResult> {
  const result: SmsRetryRunResult = { due: 0, claimed: 0, resent: 0, retried: 0, dead: 0, skipped: 0 };
  const now = opts?.now ?? new Date();
  try {
    const rows = await db
      .select()
      .from(channelMessages)
      .where(and(
        eq(channelMessages.channel, "sms"),
        eq(channelMessages.direction, "outbound"),
        sql`${channelMessages.metadata}->>'status' = 'failed'`,
        sql`coalesce(${channelMessages.metadata}->>'failureClass', 'retriable') = 'retriable'`,
        sql`coalesce((${channelMessages.metadata}->>'retryCount')::int, 0) < ${SMS_RETRY_MAX_ATTEMPTS}`,
        sql`(${channelMessages.metadata}->>'nextRetryAt') is null or (${channelMessages.metadata}->>'nextRetryAt')::timestamptz <= ${now.toISOString()}`,
      ))
      .limit(opts?.limit ?? 25)
      .catch((e: any) => {
        console.error("[smsRetry] due-row query failed:", e?.message);
        return [] as any[];
      });
    result.due = rows.length;

    for (const row of rows) {
      const meta = (row.metadata ?? {}) as SmsRetryMeta;
      // CLAIM-FIRST: flip status to 'retrying' with a unique token; skip the
      // row when another run already claimed it (0 rows updated).
      const claimToken = crypto.randomUUID();
      const claimMeta: SmsRetryMeta = { ...meta, status: "retrying", claimToken };
      const claimed = await db
        .update(channelMessages)
        .set({ metadata: claimMeta })
        .where(and(
          eq(channelMessages.id, row.id),
          sql`${channelMessages.metadata}->>'status' = 'failed'`,
        ))
        .returning({ id: channelMessages.id })
        .catch((e: any) => {
          console.warn("[smsRetry] claim update failed:", e?.message);
          return [] as any[];
        });
      if (claimed.length === 0) {
        result.skipped++;
        continue;
      }
      result.claimed++;

      const finish = async (patch: SmsRetryMeta, processed: boolean) => {
        await db
          .update(channelMessages)
          .set({ metadata: { ...meta, ...patch, claimToken: null }, processed })
          .where(eq(channelMessages.id, row.id))
          .catch((e: any) => console.warn("[smsRetry] finish update failed:", e?.message));
      };

      if (!row.tenantId || !row.toAddress || !row.body) {
        await finish({ status: "dead", failReason: "missing tenant/recipient/body — not replayable" }, true);
        result.dead++;
        continue;
      }

      const attempt = (meta.retryCount ?? 0) + 1;
      try {
        const sms = await import("./smsSender");
        const res = await sms.sendSms(row.tenantId, row.toAddress, row.body, {
          idempotencyKey: meta.failoverKey ?? `sms-retry:${row.id}`,
          skipLog: true, // the original row is the ledger
        });
        if (res.sent || res.simulated) {
          await finish({ status: res.sent ? "sent" : "simulated", retryCount: attempt, nextRetryAt: null }, true);
          result.resent++;
          continue;
        }
        throw new Error("send returned not-sent");
      } catch (e: any) {
        const errMsg = String(e?.message ?? e).slice(0, 500);
        if (attempt >= SMS_RETRY_MAX_ATTEMPTS) {
          await finish({ status: "dead", retryCount: attempt, nextRetryAt: null, failReason: errMsg }, true);
          result.dead++;
          await sendSmsDeadLetterAlert(db, row, errMsg);
        } else {
          const next = new Date(now.getTime() + SMS_RETRY_BACKOFF_MS[Math.min(attempt - 1, SMS_RETRY_BACKOFF_MS.length - 1)]);
          await finish({ status: "failed", retryCount: attempt, nextRetryAt: next.toISOString(), failReason: errMsg }, false);
          result.retried++;
        }
      }
    }
  } catch (e: any) {
    console.error("[smsRetry] sweep failed (fail-open):", e?.message);
  }
  return result;
}
// === END W61 dataloss ===
