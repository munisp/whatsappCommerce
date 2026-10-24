// === W62 findings ===
/**
 * F9 — durable transactional-email outbox (audit W61 MEDIUM #9).
 *
 * Emails were fire-and-forget: sendEmail() swallowed failures and returned
 * false, so the ban-circuit admin alert email (the ONLY notification path
 * for a banned sender number), the welcome email, and wallet-statement
 * delivery could be lost silently. This module mirrors the telegram_outbox
 * pattern:
 *
 *   1. enqueueEmail() inserts a row claim-first with a UNIQUE idempotency
 *      key (ON CONFLICT DO NOTHING) — retries/duplicates never double-send.
 *   2. A best-effort immediate send is attempted; on failure the row goes
 *      status='failed' with WA_RETRY_BACKOFF_MS (1m, 5m, 15m, 1h).
 *   3. /api/scheduled/email-send-retry → runEmailSendRetries() claims due
 *      rows with a guarded UPDATE (status transition), re-sends, and
 *      dead-letters after WA_RETRY_MAX_ATTEMPTS with a tenant-admin
 *      WhatsApp alert (fail-open telemetry; the money path is untouched).
 *
 * Fail-open throughout: email is a notification channel, so a broken email
 * subsystem must never crash callers — but failures are now DURABLE and
 * retried instead of dropped.
 */
import { and, eq, isNotNull, lt, lte } from "drizzle-orm";
import { getDb } from "../db";
import { emailOutbox, tenants } from "../../drizzle/schema";
import { WA_RETRY_BACKOFF_MS, WA_RETRY_MAX_ATTEMPTS } from "./waSender";

export interface EmailOutboxEnqueueInput {
  tenantId?: string | null;
  /** Logical dedupe key, e.g. `welcome:user@x.com` or `ban-alert:<tenant>:<phone>`. */
  idempotencyKey: string;
  kind: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface EmailRetryRunResult {
  due: number;
  retried: number;
  resent: number;
  dead: number;
  skipped: number;
}

function nextRetry(now: Date, attempts: number): Date {
  const i = Math.min(Math.max(attempts - 1, 0), WA_RETRY_BACKOFF_MS.length - 1);
  return new Date(now.getTime() + WA_RETRY_BACKOFF_MS[i]);
}

/**
 * Enqueue durably, then attempt an immediate send. Duplicate idempotency
 * keys are a no-op (returns false). Never throws.
 */
export async function enqueueEmail(input: EmailOutboxEnqueueInput): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) {
      // DB down: fall back to the legacy fire-and-forget path so
      // notifications still have a chance (fail-open telemetry).
      const { sendEmail } = await import("./email/resend");
      return sendEmail({ to: input.to, subject: input.subject, html: input.html, text: input.text });
    }
    const inserted = await db
      .insert(emailOutbox)
      .values({
        tenantId: input.tenantId ?? null,
        idempotencyKey: input.idempotencyKey.slice(0, 191),
        kind: input.kind.slice(0, 48),
        toEmail: input.to,
        subject: input.subject.slice(0, 512),
        html: input.html,
        textBody: input.text ?? null,
        status: "pending",
        attempts: 0,
      })
      .onConflictDoNothing({ target: emailOutbox.idempotencyKey })
      .returning({ id: emailOutbox.id });
    if (inserted.length === 0) return false; // duplicate — already queued/sent
    const id = inserted[0].id;
    const ok = await attemptSend(db, id);
    return ok;
  } catch (e: any) {
    console.warn("[emailOutbox] enqueue failed:", e?.message);
    return false;
  }
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Claim-first single send: guarded UPDATE pending/failed → sending, then
 * call Resend. Success → 'sent'; failure → 'failed' + backoff (or 'dead'
 * once attempts are exhausted, with a tenant-admin alert). Returns success.
 */
async function attemptSend(db: Db, id: string): Promise<boolean> {
  const now = new Date();
  const claimed = await db
    .update(emailOutbox)
    .set({ status: "sending", updatedAt: now })
    .where(and(eq(emailOutbox.id, id), eq(emailOutbox.status, "pending")))
    .returning()
    .catch(() => [] as any[]);
  let row = claimed[0];
  if (!row) {
    // retry path: rows already in 'failed' are claimed by status too
    const claimed2 = await db
      .update(emailOutbox)
      .set({ status: "sending", updatedAt: now })
      .where(and(eq(emailOutbox.id, id), eq(emailOutbox.status, "failed")))
      .returning()
      .catch(() => [] as any[]);
    row = claimed2[0];
  }
  if (!row) return false; // someone else claimed it / already sent
  const attempts = (row.attempts ?? 0) + 1;
  let ok = false;
  let errMsg = "";
  try {
    const { sendEmail } = await import("./email/resend");
    ok = await sendEmail({ to: row.toEmail, subject: row.subject, html: row.html, text: row.textBody ?? undefined });
    if (!ok) errMsg = "resend send failed (see [email] log)";
  } catch (e: any) {
    errMsg = e?.message ?? "send error";
  }
  if (ok) {
    await db.update(emailOutbox)
      .set({ status: "sent", attempts, sentAt: now, nextRetryAt: null, lastError: null, updatedAt: now })
      .where(eq(emailOutbox.id, id))
      .catch((e: any) => console.warn("[emailOutbox] sent mark failed:", e?.message));
    return true;
  }
  const dead = attempts >= WA_RETRY_MAX_ATTEMPTS;
  await db.update(emailOutbox)
    .set({
      status: dead ? "dead" : "failed",
      attempts,
      nextRetryAt: dead ? null : nextRetry(now, attempts),
      lastError: errMsg.slice(0, 2000),
      updatedAt: now,
    })
    .where(and(eq(emailOutbox.id, id), eq(emailOutbox.status, "sending")))
    .catch((e: any) => console.warn("[emailOutbox] failure mark failed:", e?.message));
  if (dead) await sendEmailDeadLetterAlert(row, errMsg);
  return false;
}

/**
 * Alert the tenant admin (WhatsApp, settings.adminPhone — same path
 * waSender/telegramSender use) that an email dead-lettered. Fail-open.
 */
async function sendEmailDeadLetterAlert(
  row: { tenantId: string | null; toEmail: string; kind: string },
  errorSummary: string,
): Promise<void> {
  try {
    if (!row.tenantId) return;
    const db = await getDb();
    if (!db) return;
    const [t] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, row.tenantId))
      .limit(1)
      .catch(() => [null as any]);
    const adminPhone = ((t?.settings as Record<string, unknown> | null)?.adminPhone as string | undefined) ?? "";
    if (!adminPhone.trim()) return;
    const { sendWhatsAppText } = await import("./waSender");
    await sendWhatsAppText(
      row.tenantId,
      adminPhone,
      `⚠️ Email dead-lettered after ${WA_RETRY_MAX_ATTEMPTS} attempts.\n` +
        `To: ${row.toEmail}\nKind: ${row.kind}\nError: ${errorSummary.slice(0, 300)}`,
      { notifType: "email_dead_letter_alert" },
    ).catch((e: any) => console.warn("[emailOutbox] dead-letter admin alert send failed:", e?.message));
  } catch (e: any) {
    console.warn("[emailOutbox] dead-letter admin alert error:", e?.message);
  }
}

/**
 * Retry sweep for /api/scheduled/email-send-retry: picks up due 'failed'
 * rows (nextRetryAt ≤ now, attempts < max) and re-sends via the claim-first
 * attemptSend path. Fail-open; never throws.
 */
export async function runEmailSendRetries(opts?: { now?: Date; limit?: number }): Promise<EmailRetryRunResult> {
  const result: EmailRetryRunResult = { due: 0, retried: 0, resent: 0, dead: 0, skipped: 0 };
  const now = opts?.now ?? new Date();
  const db = await getDb();
  if (!db) {
    console.warn("[emailOutbox] retry run: DB unavailable");
    return result;
  }
  const rows = await db
    .select()
    .from(emailOutbox)
    .where(and(
      eq(emailOutbox.status, "failed"),
      isNotNull(emailOutbox.nextRetryAt),
      lte(emailOutbox.nextRetryAt, now),
      lt(emailOutbox.attempts, WA_RETRY_MAX_ATTEMPTS),
    ))
    .limit(opts?.limit ?? 25)
    .catch((e: any) => {
      console.error("[emailOutbox] retry query failed:", e?.message);
      return [] as any[];
    });
  result.due = rows.length;
  for (const row of rows) {
    const before = row.attempts ?? 0;
    const ok = await attemptSend(db, row.id);
    result.retried++;
    if (ok) result.resent++;
    else if (before + 1 >= WA_RETRY_MAX_ATTEMPTS) result.dead++;
  }
  return result;
}
// === END W62 findings ===
