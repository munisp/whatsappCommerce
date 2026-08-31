/**
 * server/services/arInvoices.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * W31 (Coder D): AR invoices with PSP payment links + reminders.
 *
 * Money doctrine:
 *  - `send` mints a PSP payment link through the tenant's provider fallback
 *    chain (initiateWithFallback — the SAME provider layer receipts/payment
 *    rails use), backed by a payment_intents row whose metadata
 *    { kind: 'ar_invoice_payment', arInvoiceId } is what the pinned
 *    paymentConfirm pipeline resolves by reference (= payment_link_ref).
 *  - A payment is recorded ONLY after verified provider status
 *    (hasVerifiedPayment — local completed intent row left by the verified
 *    webhook, or a live provider fetchStatus probe). NEVER mark an invoice
 *    paid from an unverified client callback.
 *  - Exactly-once: ar_invoice_payments.psp_reference is UNIQUE — the insert
 *    is the claim; a replayed webhook / double confirm collides and no-ops.
 *    Partial payments accumulate paid_cents with honest `partially_paid`.
 *  - Cancel invalidates the public link honestly (the hosted PSP page cannot
 *    be deleted; our public surface + recordPayment refuse cancelled
 *    invoices, and a stray verified payment on a cancelled invoice is
 *    surfaced as `invoice-cancelled`, never silently applied).
 */

import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { arInvoices, arInvoicePayments, paymentIntents } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { captureException } from "./observability";
import { initiateWithFallback, ProviderChainExhaustedError } from "./payments/initiateWithFallback";
import { toIntentProviderEnum } from "./payments/providers/providerEnum";
import { hasVerifiedPayment } from "./payments/verifyProviderStatus";

export type Db = any;

export class ArInvoiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ArInvoiceError";
    this.code = code;
  }
}

const AR_OPEN_STATUSES = ["sent", "viewed", "partially_paid", "overdue"] as const;

export const REMINDER_MAX = 3;
export const REMINDER_SPACING_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// ── Create (draft) ────────────────────────────────────────────────────────────
export interface CreateArInvoiceInput {
  tenantId: string;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  description?: string | null;
  amountCents: number;
  currency?: string;
  dueDate?: Date | null;
  metadata?: Record<string, unknown> | null;
}

export async function createArInvoice(db: Db, input: CreateArInvoiceInput) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ArInvoiceError("invalid-amount", "amountCents must be a positive integer (minor units)");
  }
  const currency = (input.currency ?? "NGN").toUpperCase().slice(0, 3);
  // Tenant-scoped invoice_no sequence: next = max+1, retried on the unique
  // index so concurrent creates can never collide permanently.
  let lastErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.transaction(async (tx: Db) => {
        const rows: any = await tx.execute(sql`
          SELECT COALESCE(MAX(invoice_no), 0) + 1 AS next_no
          FROM ar_invoices WHERE tenant_id = ${input.tenantId}
        `);
        const r = (Array.isArray(rows) ? rows : rows?.rows ?? [])[0];
        const nextNo = Number(r?.next_no ?? 1);
        const [inv] = await tx.insert(arInvoices).values({
          id: randomUUID(),
          tenantId: input.tenantId,
          customerName: input.customerName ?? null,
          customerPhone: input.customerPhone ?? null,
          customerEmail: input.customerEmail ?? null,
          invoiceNo: nextNo,
          description: input.description ?? null,
          amountCents: input.amountCents,
          paidCents: 0,
          currency,
          dueDate: input.dueDate ?? null,
          status: "draft",
          reminderCount: 0,
          metadata: input.metadata ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }).returning();
        return inv;
      });
    } catch (err: any) {
      lastErr = err;
      if (!String(err?.message ?? "").includes("ar_invoices_tenant_no_uniq")) throw err;
    }
  }
  throw lastErr;
}

// ── Send: mint PSP payment link + WA the customer ────────────────────────────
export interface SendArInvoiceResult {
  invoiceId: string;
  reference: string;
  paymentUrl: string | null;
  instructions: string | null;
  provider: string;
  waSent: boolean;
}

export async function sendArInvoice(db: Db, tenantId: string, invoiceId: string, amountCents?: number | null): Promise<SendArInvoiceResult> {
  const [inv] = await db.select().from(arInvoices)
    .where(and(eq(arInvoices.id, invoiceId), eq(arInvoices.tenantId, tenantId))).limit(1);
  if (!inv) throw new ArInvoiceError("not-found", "AR invoice not found");
  if (inv.status === "cancelled") throw new ArInvoiceError("cancelled", "Invoice is cancelled");
  if (inv.status === "paid") throw new ArInvoiceError("already-paid", "Invoice is already paid");
  // Idempotent re-send: an OPEN (not yet partially paid) link is reused,
  // never a duplicate mint — unless the caller asks for a partial amount.
  // After a partial payment the link is RE-MINTED for the remaining balance
  // (or the explicit partial amount), so paid_cents stays honest.
  if (inv.paymentLinkRef && inv.status !== "draft" && inv.status !== "partially_paid" && amountCents == null) {
    return {
      invoiceId: inv.id,
      reference: inv.paymentLinkRef,
      paymentUrl: inv.paymentUrl ?? null,
      instructions: ((inv.metadata as any)?.instructions ?? null),
      provider: ((inv.metadata as any)?.servedProvider ?? "paystack"),
      waSent: false,
    };
  }

  const outstanding = inv.amountCents - inv.paidCents;
  if (!(outstanding > 0)) throw new ArInvoiceError("nothing-outstanding", "Invoice has no outstanding balance");
  const linkAmountCents = amountCents ?? outstanding;
  if (!Number.isInteger(linkAmountCents) || linkAmountCents <= 0 || linkAmountCents > outstanding) {
    throw new ArInvoiceError("invalid-amount", `link amount must be a positive integer ≤ outstanding (${outstanding})`);
  }

  const paymentIntentId = randomUUID();
  const reference = `AR-${Date.now()}-${paymentIntentId.slice(0, 8).toUpperCase()}`;
  const metadata: Record<string, unknown> = {
    kind: "ar_invoice_payment",
    arInvoiceId: inv.id,
    invoiceNo: inv.invoiceNo,
    tenantId,
    ...(inv.customerPhone ? { customerPhone: inv.customerPhone } : {}),
  };
  const now = new Date();

  // payment_intents row: this is what the pinned paymentConfirm webhook path
  // resolves (by providerPaymentId = reference) and marks completed after
  // signature + amount verification.
  await db.insert(paymentIntents).values({
    id: paymentIntentId,
    tenantId,
    orderId: inv.id, // NOT NULL column; the AR invoice id stands in (no storefront order)
    customerId: (inv.customerPhone ?? inv.id).slice(0, 36),
    amount: (linkAmountCents / 100).toFixed(2),
    currency: inv.currency,
    provider: "paystack",
    providerPaymentId: reference,
    idempotencyKey: `ar-invoice:${inv.id}:${reference}`,
    status: "pending",
    metadata,
    createdAt: now,
    updatedAt: now,
  });

  const customerPhone = inv.customerPhone ?? inv.id;
  let paymentUrl: string | null = null;
  let instructions: string | null = null;
  let servedProvider = "paystack";
  try {
    const fallback = await initiateWithFallback(tenantId, {
      tenantId,
      amountCents: linkAmountCents,
      currency: inv.currency,
      reference,
      metadata: {
        payment_intent_id: paymentIntentId,
        tenant_id: tenantId,
        kind: "ar_invoice_payment",
        arInvoiceId: inv.id,
      },
      customer: {
        phone: customerPhone,
        email: inv.customerEmail ?? `${String(customerPhone).replace(/\D/g, "") || "ar"}@wa-app.newfire.app`,
      },
      // The webhook confirms server-side; the payer lands on the public
      // invoice page after checkout.
      callbackUrl: `${ENV.appUrl}/pay/ar/${reference}`,
    });
    paymentUrl = fallback.result.authorizationUrl ?? null;
    instructions = fallback.result.instructions ?? null;
    servedProvider = fallback.providerId;
  } catch (err: any) {
    await db.update(paymentIntents)
      .set({ status: "failed", failureReason: `provider_init: ${String(err?.message ?? err).slice(0, 300)}`, updatedAt: new Date() })
      .where(eq(paymentIntents.id, paymentIntentId)).catch(() => {});
    captureException(err, {
      service: "arInvoices",
      operation: "providerInit",
      tenantId,
      severity: "critical",
      extra: { invoiceId, reference, outstanding },
    });
    if (err instanceof ProviderChainExhaustedError && err.attempts.length === 0) {
      throw new ArInvoiceError("provider-not-configured", "No payment provider is configured for this tenant");
    }
    throw new ArInvoiceError("provider-init-failed", `Payment provider initialization failed: ${err?.message ?? err}`);
  }

  await db.update(paymentIntents)
    .set({
      status: "initiated",
      provider: toIntentProviderEnum(servedProvider),
      metadata: { ...metadata, paymentUrl, ...(instructions ? { instructions } : {}), servedProvider },
      updatedAt: new Date(),
    })
    .where(eq(paymentIntents.id, paymentIntentId));

  await db.update(arInvoices)
    .set({
      // Re-mint after a partial payment keeps the honest partially_paid state.
      status: inv.status === "partially_paid" ? "partially_paid" : "sent",
      paymentLinkRef: reference,
      paymentUrl,
      metadata: { ...((inv.metadata as any) ?? {}), paymentUrl, ...(instructions ? { instructions } : {}), servedProvider },
      sentAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(arInvoices.id, inv.id));

  // WhatsApp the customer with the link (best-effort; never blocks the send).
  let waSent = false;
  if (inv.customerPhone && paymentUrl) {
    try {
      const { sendWhatsAppText } = await import("./waSender");
      const amountMajor = (linkAmountCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 });
      const res = await sendWhatsAppText(tenantId, inv.customerPhone,
        `Hello${inv.customerName ? ` ${inv.customerName}` : ""}, you have a new invoice #${inv.invoiceNo} ` +
        `for ${inv.currency} ${amountMajor}${inv.description ? ` (${inv.description})` : ""}. ` +
        `Pay securely here: ${paymentUrl}`,
        { notifType: "ar_invoice_send" });
      waSent = res.sent || res.simulated;
    } catch (err: any) {
      console.warn(`[ar-invoices] WA send failed for invoice ${inv.id}:`, err?.message);
    }
  }

  return { invoiceId: inv.id, reference, paymentUrl, instructions, provider: servedProvider, waSent };
}

// ── Record a VERIFIED provider payment (webhook hook + manual confirm path) ──
export interface RecordArPaymentResult {
  recorded: boolean;
  reason?: string;
  invoiceId?: string;
  status?: string;
  paidCents?: number;
  outstandingCents?: number;
  via?: string;
}

export async function recordVerifiedArPayment(
  db: Db,
  opts: { reference: string; tenantId?: string },
): Promise<RecordArPaymentResult> {
  const { reference } = opts;
  if (!reference) return { recorded: false, reason: "no-reference" };

  const [inv] = await db.select().from(arInvoices)
    .where(eq(arInvoices.paymentLinkRef, reference)).limit(1);
  if (!inv) return { recorded: false, reason: "not-found" };
  if (opts.tenantId && inv.tenantId !== opts.tenantId) {
    return { recorded: false, reason: "forbidden" };
  }
  if (inv.status === "cancelled") {
    // Honest: money may have arrived at the provider on a cancelled link —
    // we do NOT apply it silently. Ops must refund/chargeback out-of-band.
    console.error(`[ar-invoices] verified payment ${reference} for CANCELLED invoice ${inv.id} — not applied`);
    captureException(new Error(`AR payment arrived for cancelled invoice ${inv.id}`), {
      service: "arInvoices",
      operation: "recordPayment",
      tenantId: inv.tenantId,
      severity: "critical",
      extra: { reference, invoiceId: inv.id },
    });
    return { recorded: false, reason: "invoice-cancelled", invoiceId: inv.id, status: inv.status };
  }
  if (inv.status === "paid") return { recorded: false, reason: "already-paid", invoiceId: inv.id, status: inv.status };

  // Verified provider status ONLY — local completed record (written by the
  // pinned confirmProviderPayment webhook path) or a live provider probe.
  // Never trust a bare client callback.
  const verified = await hasVerifiedPayment(db, { tenantId: inv.tenantId, reference });
  if (!verified.verified) {
    return { recorded: false, reason: `unverified:${verified.detail ?? "none"}`, invoiceId: inv.id, status: inv.status };
  }

  // Confirmed amount from the completed intent (already amount-verified by
  // paymentConfirm); over-payments beyond outstanding are refused honestly.
  const [intent] = await db.select().from(paymentIntents)
    .where(and(eq(paymentIntents.providerPaymentId, reference), eq(paymentIntents.tenantId, inv.tenantId)))
    .limit(1);
  const amountCents = intent ? Math.round(parseFloat(String(intent.amount)) * 100) : null;
  if (!amountCents || !(amountCents > 0)) {
    return { recorded: false, reason: "amount-unknown", invoiceId: inv.id, status: inv.status };
  }

  return db.transaction(async (tx: Db) => {
    // Exactly-once claim: unique psp_reference. A replayed webhook collides.
    const claimed = await tx.insert(arInvoicePayments).values({
      id: randomUUID(),
      invoiceId: inv.id,
      amountCents,
      pspReference: reference,
      status: "recorded",
      recordedAt: new Date(),
    }).onConflictDoNothing({ target: arInvoicePayments.pspReference }).returning();
    if (!claimed || claimed.length === 0) {
      return { recorded: false, reason: "duplicate", invoiceId: inv.id };
    }

    // Conditional accumulate: paid_cents += amount, capped honestly by status.
    const upd: any = await tx.execute(sql`
      UPDATE ar_invoices
      SET paid_cents = paid_cents + ${amountCents},
          status = CASE
            WHEN paid_cents + ${amountCents} >= amount_cents THEN 'paid'
            ELSE 'partially_paid'
          END,
          paid_at = CASE WHEN paid_cents + ${amountCents} >= amount_cents THEN now() ELSE paid_at END,
          psp_reference = ${reference},
          updated_at = now()
      WHERE id = ${inv.id}
        AND status NOT IN ('paid', 'cancelled')
      RETURNING paid_cents, amount_cents, status
    `);
    const row = (Array.isArray(upd) ? upd : upd?.rows ?? [])[0];
    if (!row) {
      // Raced to paid/cancelled — roll the claim back so a later sweep stays honest.
      throw new ArInvoiceError("race", "invoice status raced during payment recording");
    }
    const paidCents = Number(row.paid_cents);
    const outstandingCents = Number(row.amount_cents) - paidCents;
    return {
      recorded: true,
      invoiceId: inv.id,
      status: String(row.status),
      paidCents,
      outstandingCents,
      via: verified.via,
    };
  });
}

/**
 * Post-confirm webhook hook — called from the provider webhook handlers in
 * _core/index.ts (banner === W31 AR webhook hook ===) AFTER the pinned
 * confirmProviderPayment marked the intent completed. Reference IS the
 * invoice's payment_link_ref. Never throws into the webhook.
 */
export async function runArInvoiceWebhookHook(
  db: Db,
  opts: { provider: string; reference: string },
): Promise<RecordArPaymentResult> {
  try {
    const result = await recordVerifiedArPayment(db, { reference: opts.reference });
    if (!result.recorded && result.reason && !["not-found", "duplicate", "already-paid"].includes(result.reason)) {
      console.warn(`[ar-invoices] hook ref=${opts.reference} → ${result.reason}`);
    }
    return result;
  } catch (err: any) {
    console.error(`[ar-invoices] webhook hook failed for ref=${opts.reference}:`, err?.message);
    captureException(err, {
      service: "arInvoices",
      operation: "webhookHook",
      severity: "critical",
      extra: { reference: opts.reference, provider: opts.provider },
    });
    return { recorded: false, reason: `hook-error: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}

// ── Cancel (invalidates the public link honestly) ────────────────────────────
export async function cancelArInvoice(db: Db, tenantId: string, invoiceId: string) {
  const upd: any = await db.execute(sql`
    UPDATE ar_invoices
    SET status = 'cancelled', updated_at = now()
    WHERE id = ${invoiceId}
      AND tenant_id = ${tenantId}
      AND status NOT IN ('paid', 'cancelled')
    RETURNING id, status, paid_cents
  `);
  const row = (Array.isArray(upd) ? upd : upd?.rows ?? [])[0];
  if (!row) {
    const [inv] = await db.select().from(arInvoices)
      .where(and(eq(arInvoices.id, invoiceId), eq(arInvoices.tenantId, tenantId))).limit(1);
    if (!inv) throw new ArInvoiceError("not-found", "AR invoice not found");
    if (inv.status === "cancelled") return { invoiceId, status: "cancelled", alreadyCancelled: true };
    throw new ArInvoiceError("already-paid", "A paid invoice cannot be cancelled");
  }
  // Link invalidation: the hosted PSP page itself cannot be deleted, but our
  // public surface answers "expired" and recordVerifiedArPayment refuses to
  // apply money to a cancelled invoice (see above) — honest invalidation.
  return { invoiceId, status: "cancelled", alreadyCancelled: false };
}

// ── Aging buckets (list view) ────────────────────────────────────────────────
export type AgingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

export function agingBucket(dueDate: Date | null, status: string, now = new Date()): AgingBucket | null {
  if (status === "paid" || status === "cancelled" || status === "draft") return null;
  if (!dueDate) return "current";
  const days = Math.floor((now.getTime() - new Date(dueDate).getTime()) / 86400000);
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

// ── Overdue sweep + polite WA reminders (cron) ───────────────────────────────
export interface ArReminderSweepResult {
  overdueFlipped: number;
  remindersSent: number;
  skipped: number;
  errors: string[];
}

export async function runArReminderSweep(db: Db, now = new Date()): Promise<ArReminderSweepResult> {
  const result: ArReminderSweepResult = { overdueFlipped: 0, remindersSent: 0, skipped: 0, errors: [] };

  // 1. Flip sent/viewed/partially_paid invoices past due_date → overdue.
  const flipped: any = await db.execute(sql`
    UPDATE ar_invoices
    SET status = 'overdue', updated_at = now()
    WHERE due_date IS NOT NULL
      AND due_date < ${now.toISOString()}
      AND status IN ('sent', 'viewed', 'partially_paid')
    RETURNING id
  `);
  result.overdueFlipped = (Array.isArray(flipped) ? flipped : flipped?.rows ?? []).length;

  // 2. Claim-before-send reminders: max REMINDER_MAX, spacing 3d, dedupe via
  //    last_reminder_at — the conditional UPDATE is the claim, so concurrent
  //    sweeps never double-send.
  const spacingAgo = new Date(now.getTime() - REMINDER_SPACING_MS).toISOString();
  const claimed: any = await db.execute(sql`
    UPDATE ar_invoices
    SET reminder_count = reminder_count + 1, last_reminder_at = now(), updated_at = now()
    WHERE status IN ('sent', 'viewed', 'partially_paid', 'overdue')
      AND due_date IS NOT NULL
      AND due_date < ${now.toISOString()}
      AND reminder_count < ${REMINDER_MAX}
      AND (last_reminder_at IS NULL OR last_reminder_at <= ${spacingAgo})
    RETURNING id, tenant_id, customer_name, customer_phone, invoice_no,
              amount_cents, paid_cents, currency, payment_url, reminder_count
  `);
  const rows: any[] = Array.isArray(claimed) ? claimed : claimed?.rows ?? [];

  for (const r of rows) {
    try {
      if (!r.customer_phone || !r.payment_url) { result.skipped++; continue; }
      const { sendWhatsAppText } = await import("./waSender");
      const outstanding = (Number(r.amount_cents) - Number(r.paid_cents)) / 100;
      const n = Number(r.reminder_count);
      await sendWhatsAppText(r.tenant_id, r.customer_phone,
        `Friendly reminder${r.customer_name ? ` ${r.customer_name}` : ""}: invoice #${r.invoice_no} ` +
        `has ${String(r.currency).toUpperCase()} ${outstanding.toLocaleString("en-NG", { minimumFractionDigits: 2 })} outstanding. ` +
        `You can pay here: ${r.payment_url}${n >= REMINDER_MAX ? " (final reminder)" : ""}`,
        { notifType: "ar_invoice_reminder" });
      result.remindersSent++;
    } catch (err: any) {
      console.error(`[ar-invoices] reminder send failed for ${r.id}:`, err?.message);
      result.errors.push(String(r.id));
    }
  }
  return result;
}
