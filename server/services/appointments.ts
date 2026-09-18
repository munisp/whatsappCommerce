// === W44 deposits-subs-digital (Coder C) ===
/**
 * appointments.ts — service appointments with deposit capture (mig 0140).
 *
 * Flow (BOTH channels — WhatsApp + Telegram inbound feed the same nlp.ts
 * engine; outbound routes via channelParity):
 *   1. Buyer: "services" lists bookable service products (products.
 *      serviceBookingEnabled); "book <service> at <time>" → bookAppointment
 *      validates the tenant + product, claims the slot FIRST (SELECT
 *      overlapping rows FOR UPDATE inside a txn — no double-booking), parks
 *      a service_appointments row (status booked, deposit_status pending)
 *      and initiates the deposit via the EXISTING payment-intent path
 *      (initiateWithFallback; reference appt-deposit:<appointmentId>) sent
 *      through the payment_link parity category.
 *   2. The provider webhook (paystack/flutterwave handler in
 *      server/_core/index.ts) confirms the payment via the PINNED
 *      confirmProviderPayment, then calls runAppointmentWebhookHook which
 *      flips deposit_status pending → paid claim-first and the appointment
 *      to confirmed — the customer is notified on their channel.
 *   3. Merchant "APPT COMPLETE <id8>" → completeAppointment claims the
 *      transition and collects the remainder: wallet debit first (W41
 *      customerWallet, idempotent refId appt-remainder:<id>), PSP payment
 *      link fallback (reference appt-remainder:<id>, confirmed by the same
 *      webhook hook).
 *   4. Buyer "cancel appointment" → cancelAppointment claim-first. Outside
 *      tenants.appointmentCancelWindowHours (default 24h before startsAt)
 *      the deposit is REFUNDED via the W38 executeProviderRefundByReference
 *      path; inside the window the deposit is FORFEITED (no refund call)
 *      with an audit row either way. "APPT NOSHOW <id8>" marks no_show and
 *      keeps the deposit (audit).
 *
 * Money doctrine: integer cents; claim-first FOR UPDATE on every state
 * mutation; idempotent webhook flips (a replayed webhook finds
 * deposit_status <> 'pending' and is a no-op); never-throw notification
 * sends.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  products,
  serviceAppointments,
  tenants,
  type ServiceAppointment,
} from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const APPOINTMENT_CATEGORY = "appointment";
export const APPT_DEPOSIT_REF_PREFIX = "appt-deposit:";
export const APPT_REMAINDER_REF_PREFIX = "appt-remainder:";
export const APPT_OPEN_STATUSES = ["booked", "confirmed"] as const;
export const APPT_ACTIVE_FOR_OVERLAP = ["booked", "confirmed"] as const;

// ─── Tenant / product helpers ────────────────────────────────────────────────

async function requireActiveTenant(db: Db, tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("./tenantGuard");
  assertTenantActive(tenant);
  return tenant;
}

export async function appointmentCancelWindowHours(db: Db, tenantId: string): Promise<number> {
  const [t] = await db
    .select({ hours: tenants.appointmentCancelWindowHours })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  const v = t?.hours;
  return Number.isInteger(v) && v >= 0 ? v : 24;
}

/** Deposit fraction: tenant settings.appointments.depositPct (0-100, default 50). */
export async function appointmentDepositPct(db: Db, tenantId: string): Promise<number> {
  const [t] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1).catch(() => [] as any[]);
  const v = ((t?.settings as any)?.appointments?.depositPct);
  return Number.isInteger(v) && v > 0 && v <= 100 ? v : 50;
}

export async function listServiceProducts(
  db: Db,
  tenantId: string,
): Promise<Array<{ id: string; name: string; priceCents: number; currency: string; durationMinutes: number }>> {
  const rows = await db.select({
    id: products.id,
    name: products.name,
    price: products.price,
    currency: products.currency,
    durationMinutes: products.serviceDurationMinutes,
  }).from(products)
    .where(and(
      eq(products.tenantId, tenantId),
      eq(products.serviceBookingEnabled, true),
      eq(products.status, "active"),
    ))
    .limit(20)
    .catch(() => [] as any[]);
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    priceCents: Math.round(Number(r.price) * 100),
    currency: r.currency ?? "NGN",
    durationMinutes: Number.isInteger(r.durationMinutes) && r.durationMinutes > 0 ? r.durationMinutes : 60,
  }));
}

// ─── Notifications (both channels via channelParity) ─────────────────────────

async function notifyCustomerBothChannels(
  tenantId: string,
  customerRef: string,
  text: string,
  opts?: { paymentUrl?: string; appointmentId?: string },
): Promise<void> {
  try {
    const { notifyCustomer } = await import("./channelParity");
    const ref = /^telegram:/i.test(customerRef)
      ? { channel: "telegram", channelScopedId: customerRef.replace(/^telegram:/i, "") }
      : { phone: customerRef.replace(/^\+/, "") };
    const category = opts?.paymentUrl ? "payment_link" : APPOINTMENT_CATEGORY;
    const payload: any = { text, notifType: APPOINTMENT_CATEGORY, orderId: opts?.appointmentId ?? undefined };
    if (opts?.paymentUrl) {
      payload.paymentUrl = opts.paymentUrl;
      payload.buttons = [{ label: "💳 Pay now", url: opts.paymentUrl }];
    }
    const routed = await notifyCustomer(tenantId, ref, category, payload);
    if (!routed.handled) {
      const phone = (ref as any).phone ?? "";
      if (phone) {
        const { sendWhatsAppText } = await import("./waSender");
        await sendWhatsAppText(tenantId, phone,
          opts?.paymentUrl ? `${text}\n💳 Pay: ${opts.paymentUrl}` : text,
          { notifType: APPOINTMENT_CATEGORY }).catch((e: any) => console.warn("[appointments] WA notify failed:", e?.message));
      }
    }
  } catch (e: any) {
    console.warn("[appointments] notify failed:", e?.message);
  }
}

async function writeAudit(
  tenantId: string,
  actorId: string,
  action: string,
  appointmentId: string,
  summary: string,
): Promise<void> {
  try {
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({
      tenantId,
      actorId,
      action,
      entityType: "service_appointment",
      entityId: appointmentId,
      summary,
    } as any);
  } catch (e: any) {
    console.warn("[appointments] audit write failed:", e?.message);
  }
}

// ─── Booking ─────────────────────────────────────────────────────────────────

/**
 * Deterministic chat time parsing. Supported:
 *   "2026-01-05 14:00" | "2026-01-05 2pm" | "2026-01-05"
 *   "tomorrow [at] 2pm|14:00" | "in <N> hours"
 * Returns null when unparseable — honest, never guesses.
 */
export function parseAppointmentTime(text: string, now: Date = new Date()): Date | null {
  const t = text.trim().toLowerCase();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/.exec(t);
  if (iso) {
    let h = iso[4] ? parseInt(iso[4], 10) : 9;
    const min = iso[5] ? parseInt(iso[5], 10) : 0;
    if (iso[6] === "pm" && h < 12) h += 12;
    if (iso[6] === "am" && h === 12) h = 0;
    const d = new Date(Date.UTC(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10), h, min));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const tomorrow = /^tomorrow(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (tomorrow) {
    let h = parseInt(tomorrow[1], 10);
    const min = tomorrow[2] ? parseInt(tomorrow[2], 10) : 0;
    if (tomorrow[3] === "pm" && h < 12) h += 12;
    if (tomorrow[3] === "am" && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    const d = new Date(now.getTime());
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(h, min, 0, 0);
    return d;
  }
  const inHours = /^in\s+(\d{1,3})\s*(?:h|hr|hrs|hours?)$/.exec(t);
  if (inHours) return new Date(now.getTime() + parseInt(inHours[1], 10) * 3600_000);
  return null;
}

export interface BookAppointmentInput {
  tenantId: string;
  /** Buyer ref: E.164 phone (WA) or "telegram:<chatId>" session key. */
  customerRef: string;
  serviceProductId: string;
  startsAt: Date;
  channel?: string;
}

export async function bookAppointment(
  db: Db,
  input: BookAppointmentInput,
): Promise<{ appt: ServiceAppointment; serviceName: string; paymentUrl: string | null; depositCents: number; remainderCents: number }> {
  const tenant = await requireActiveTenant(db, input.tenantId);

  const [svc] = await db.select().from(products)
    .where(and(
      eq(products.id, input.serviceProductId),
      eq(products.tenantId, input.tenantId),
      eq(products.serviceBookingEnabled, true),
    ))
    .limit(1);
  if (!svc) throw new TRPCError({ code: "NOT_FOUND", message: "That service is not available for booking." });

  const now = new Date();
  if (input.startsAt.getTime() <= now.getTime()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Please pick a time in the future." });
  }
  const durationMin = Number.isInteger(svc.serviceDurationMinutes) && svc.serviceDurationMinutes > 0 ? svc.serviceDurationMinutes : 60;
  const endsAt = new Date(input.startsAt.getTime() + durationMin * 60_000);
  const priceCents = Math.round(Number(svc.price) * 100);
  const depositPct = await appointmentDepositPct(db, input.tenantId);
  const depositCents = Math.min(priceCents, Math.max(1, Math.round((priceCents * depositPct) / 100)));
  const remainderCents = priceCents - depositCents;
  const customerId = input.customerRef.replace(/^telegram:/i, "telegram:").slice(0, 36);

  // ── Claim-first overlap guard: lock the overlapping rows of this
  // (tenant, service) and refuse a double booking before inserting. ──
  const appt = await db.transaction(async (tx) => {
    const overlaps = (await tx.execute(sql`
      SELECT id FROM service_appointments
      WHERE tenant_id = ${input.tenantId}
        AND service_product_id = ${input.serviceProductId}
        AND status IN ('booked','confirmed')
        AND starts_at < ${endsAt.toISOString()}
        AND ends_at > ${input.startsAt.toISOString()}
      FOR UPDATE`)) as any;
    const overlapRows: any[] = Array.isArray(overlaps) ? overlaps : (overlaps?.rows ?? []);
    if (overlapRows.length > 0) {
      throw new TRPCError({ code: "CONFLICT", message: "That time slot is already booked — please pick another time." });
    }
    const [row] = await tx.insert(serviceAppointments).values({
      tenantId: input.tenantId,
      customerId,
      serviceProductId: input.serviceProductId,
      startsAt: input.startsAt,
      endsAt,
      depositCents,
      depositStatus: depositCents > 0 ? "pending" : "paid",
      remainderCents,
      remainderStatus: remainderCents > 0 ? "pending" : null,
      status: "booked",
      channel: input.channel ?? "whatsapp",
      createdAt: now,
      updatedAt: now,
    }).returning();
    return row!;
  });

  // ── Deposit payment intent via the EXISTING provider chain ──
  let paymentUrl: string | null = null;
  if (depositCents > 0) {
    const reference = `${APPT_DEPOSIT_REF_PREFIX}${appt.id}`;
    const { randomUUID } = await import("node:crypto");
    const paymentIntentId = randomUUID();
    try {
      const { paymentIntents } = await import("../../drizzle/schema");
      await db.insert(paymentIntents).values({
        id: paymentIntentId,
        tenantId: input.tenantId,
        orderId: appt.id, // NOT NULL column; the appointment id stands in (not a storefront order)
        customerId: customerId,
        amount: (depositCents / 100).toFixed(2),
        currency: svc.currency ?? "NGN",
        provider: "paystack",
        providerPaymentId: reference,
        idempotencyKey: `appt-deposit:${appt.id}`,
        status: "pending",
        metadata: { kind: "appointment_deposit", appointmentId: appt.id },
        createdAt: now,
        updatedAt: now,
      });
      const { initiateWithFallback } = await import("./payments/initiateWithFallback");
      const outcome = await initiateWithFallback(input.tenantId, {
        tenantId: input.tenantId,
        amountCents: depositCents,
        currency: svc.currency ?? "NGN",
        reference,
        metadata: { payment_intent_id: paymentIntentId, tenant_id: input.tenantId, kind: "appointment_deposit", appointmentId: appt.id },
        customer: { phone: customerId.replace(/^telegram:/, "") },
      });
      paymentUrl = outcome.result.authorizationUrl ?? null;
    } catch (e: any) {
      console.error("[appointments] deposit intent failed:", e?.message);
    }
    await db.update(serviceAppointments).set({ depositRef: reference, updatedAt: new Date() })
      .where(eq(serviceAppointments.id, appt.id));
  }

  await writeAudit(input.tenantId, customerId, "appointment.booked", appt.id,
    `service=${svc.name} startsAt=${input.startsAt.toISOString()} depositCents=${depositCents}`);
  void tenant; // (tenant row used by assertTenantActive above)
  return { appt: { ...appt, depositRef: depositCents > 0 ? `${APPT_DEPOSIT_REF_PREFIX}${appt.id}` : appt.depositRef }, serviceName: svc.name, paymentUrl, depositCents, remainderCents };
}

// ─── Webhook hook (deposit + remainder confirmation) ─────────────────────────

/**
 * Called from the paystack/flutterwave webhook handlers AFTER the pinned
 * confirmProviderPayment completed the intent (result.ok). Matches
 * appt-deposit:<id> / appt-remainder:<id> references; flips are claim-first
 * so a replayed webhook is a no-op. Never throws into the webhook handler.
 */
export async function runAppointmentWebhookHook(
  db: Db,
  args: { provider: string; reference: string },
): Promise<{ handled: boolean; kind?: string; appointmentId?: string }> {
  try {
    const m = /^(appt-deposit|appt-remainder):([0-9a-fA-F-]{36})$/.exec(args.reference);
    if (!m) return { handled: false };
    const kind = m[1] === "appt-deposit" ? "deposit" : "remainder";
    const appointmentId = m[2];
    const now = new Date();

    if (kind === "deposit") {
      // Claim-first: only the pending → paid flip confirms the booking.
      const flipped = await db.update(serviceAppointments)
        .set({ depositStatus: "paid", status: "confirmed", updatedAt: now })
        .where(and(
          eq(serviceAppointments.id, appointmentId),
          eq(serviceAppointments.depositStatus, "pending"),
          inArray(serviceAppointments.status, [...APPT_OPEN_STATUSES]),
        ))
        .returning();
      if (!flipped.length) return { handled: true, kind, appointmentId }; // replay
      const appt = flipped[0]!;
      const [svc] = await db.select({ name: products.name }).from(products).where(eq(products.id, appt.serviceProductId)).limit(1).catch(() => [] as any[]);
      await writeAudit(appt.tenantId, "webhook", "appointment.deposit_paid", appt.id, `ref=${args.reference} depositCents=${appt.depositCents}`);
      const fmt = `₦${(appt.depositCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
      await notifyCustomerBothChannels(appt.tenantId, appt.customerId,
        `✅ Deposit ${fmt} received — your ${svc?.name ?? "service"} appointment on ${appt.startsAt.toUTCString()} is confirmed (ref ${appt.id.slice(0, 8)}).`);
      return { handled: true, kind, appointmentId };
    }

    // remainder
    const flipped = await db.update(serviceAppointments)
      .set({ remainderStatus: "paid", updatedAt: now })
      .where(and(
        eq(serviceAppointments.id, appointmentId),
        eq(serviceAppointments.remainderStatus, "pending"),
      ))
      .returning();
    if (flipped.length) {
      const appt = flipped[0]!;
      await writeAudit(appt.tenantId, "webhook", "appointment.remainder_paid", appt.id, `ref=${args.reference} remainderCents=${appt.remainderCents}`);
      const fmt = `₦${(appt.remainderCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
      await notifyCustomerBothChannels(appt.tenantId, appt.customerId,
        `✅ Remainder ${fmt} received for your appointment (ref ${appt.id.slice(0, 8)}) — thank you!`);
    }
    return { handled: true, kind, appointmentId };
  } catch (e: any) {
    console.error("[appointments] webhook hook failed:", e?.message);
    return { handled: false };
  }
}

// ─── Cancel (deposit refund vs forfeit) ──────────────────────────────────────

export interface CancelAppointmentResult {
  appt: ServiceAppointment;
  outcome: "refunded" | "forfeited" | "no_deposit";
  refundError?: string;
}

export async function cancelAppointment(
  db: Db,
  input: { tenantId: string; appointmentId: string; customerRef?: string; actorId?: string; now?: Date },
): Promise<CancelAppointmentResult> {
  await requireActiveTenant(db, input.tenantId);
  const now = input.now ?? new Date();

  // Claim-first: lock the row, re-check state, flip to cancelled in one txn.
  const claimed = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT * FROM service_appointments
      WHERE id = ${input.appointmentId} AND tenant_id = ${input.tenantId}
      FOR UPDATE`)) as any;
    const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
    const raw = list[0];
    if (!raw) throw new TRPCError({ code: "NOT_FOUND", message: "Appointment not found." });
    if (!APPT_OPEN_STATUSES.includes(raw.status)) {
      throw new TRPCError({ code: "CONFLICT", message: `That appointment is already ${raw.status}.` });
    }
    if (input.customerRef) {
      const ref = input.customerRef.replace(/^\+/, "");
      if (raw.customer_id !== ref && raw.customer_id !== input.customerRef) {
        throw new TRPCError({ code: "FORBIDDEN", message: "That appointment belongs to a different customer." });
      }
    }
    await tx.execute(sql`
      UPDATE service_appointments SET status = 'cancelled', updated_at = ${now.toISOString()}
      WHERE id = ${raw.id} AND status IN ('booked','confirmed')`);
    return raw;
  });

  const windowHours = await appointmentCancelWindowHours(db, input.tenantId);
  const startsAt = new Date(claimed.starts_at);
  const insideWindow = now.getTime() > startsAt.getTime() - windowHours * 3600_000;
  const depositPaid = claimed.deposit_status === "paid" && (claimed.deposit_cents ?? 0) > 0;

  let outcome: CancelAppointmentResult["outcome"] = "no_deposit";
  let refundError: string | undefined;
  if (depositPaid) {
    if (insideWindow) {
      // Forfeit: refund SKIPPED, audit row records the policy decision.
      outcome = "forfeited";
      await db.update(serviceAppointments)
        .set({ depositStatus: "forfeited", updatedAt: new Date() })
        .where(and(eq(serviceAppointments.id, input.appointmentId), eq(serviceAppointments.depositStatus, "paid")));
      await writeAudit(input.tenantId, input.actorId ?? "customer", "appointment.deposit_forfeited", input.appointmentId,
        `cancelled ${Math.round((startsAt.getTime() - now.getTime()) / 3600_000)}h before start (< ${windowHours}h window) — deposit ${claimed.deposit_cents}¢ forfeited`);
    } else {
      // Refund via the W38 provider-refund path (idempotency-keyed).
      const { executeProviderRefundByReference } = await import("./payments/refunds");
      const refund = await executeProviderRefundByReference(db, {
        tenantId: input.tenantId,
        reference: claimed.deposit_ref ?? "",
        amountCents: claimed.deposit_cents,
        currency: "NGN",
        reason: "appointment cancelled outside cancel window",
        metadata: { kind: "appointment_deposit_refund", appointmentId: input.appointmentId },
      });
      if (refund.executed) {
        outcome = "refunded";
        await db.update(serviceAppointments)
          .set({ depositStatus: "refunded", updatedAt: new Date() })
          .where(and(eq(serviceAppointments.id, input.appointmentId), eq(serviceAppointments.depositStatus, "paid")));
        await writeAudit(input.tenantId, input.actorId ?? "customer", "appointment.deposit_refunded", input.appointmentId,
          `deposit ${claimed.deposit_cents}¢ refunded via ${refund.provider ?? "provider"} (${refund.refundReference ?? "ref"})`);
      } else {
        outcome = "refunded"; // deposit owed; failure surfaced honestly below
        refundError = refund.error ?? "refund_failed";
        await writeAudit(input.tenantId, input.actorId ?? "customer", "appointment.deposit_refund_failed", input.appointmentId,
          `refund of ${claimed.deposit_cents}¢ failed: ${refundError}`);
      }
    }
  } else {
    await writeAudit(input.tenantId, input.actorId ?? "customer", "appointment.cancelled", input.appointmentId,
      `cancelled before deposit payment`);
  }

  const [appt] = await db.select().from(serviceAppointments).where(eq(serviceAppointments.id, input.appointmentId)).limit(1);
  const fmt = `₦${((claimed.deposit_cents ?? 0) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
  const body =
    outcome === "refunded"
      ? `Your appointment (ref ${input.appointmentId.slice(0, 8)}) is cancelled. Your ${fmt} deposit ${refundError ? "refund is being processed" : "has been refunded"}.`
      : outcome === "forfeited"
        ? `Your appointment (ref ${input.appointmentId.slice(0, 8)}) is cancelled. Because this is within ${windowHours}h of the start time, the ${fmt} deposit is forfeited.`
        : `Your appointment (ref ${input.appointmentId.slice(0, 8)}) is cancelled.`;
  await notifyCustomerBothChannels(input.tenantId, claimed.customer_id, body, { appointmentId: input.appointmentId });
  return { appt: appt!, outcome, refundError };
}

// ─── Complete (remainder collection) + no-show ───────────────────────────────

export async function completeAppointment(
  db: Db,
  input: { tenantId: string; appointmentId: string; actorId?: string },
): Promise<{ appt: ServiceAppointment; remainder: "wallet" | "link" | "none" | "failed"; paymentUrl?: string }> {
  await requireActiveTenant(db, input.tenantId);
  const now = new Date();

  const claimed = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT * FROM service_appointments
      WHERE id = ${input.appointmentId} AND tenant_id = ${input.tenantId}
      FOR UPDATE`)) as any;
    const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
    const raw = list[0];
    if (!raw) throw new TRPCError({ code: "NOT_FOUND", message: "Appointment not found." });
    if (raw.status !== "confirmed" && raw.status !== "booked") {
      throw new TRPCError({ code: "CONFLICT", message: `That appointment is ${raw.status} — only booked/confirmed appointments can be completed.` });
    }
    await tx.execute(sql`
      UPDATE service_appointments SET status = 'completed', updated_at = ${now.toISOString()}
      WHERE id = ${raw.id} AND status IN ('booked','confirmed')`);
    return raw;
  });

  await writeAudit(input.tenantId, input.actorId ?? "merchant", "appointment.completed", input.appointmentId,
    `completed; remainderCents=${claimed.remainder_cents}`);

  let remainder: "wallet" | "link" | "none" | "failed" = "none";
  let paymentUrl: string | undefined;
  const remainderCents = claimed.remainder_cents ?? 0;
  const phone = String(claimed.customer_id).replace(/^telegram:/, "");
  if (remainderCents > 0 && claimed.remainder_status !== "paid") {
    // Wallet first (W41; idempotent refId appt-remainder:<id>).
    if (/^\d{7,15}$/.test(phone)) {
      const { debitWallet } = await import("./customerWallet");
      const debit = await debitWallet(input.tenantId, phone, remainderCents, "appointment_remainder", `appt-remainder:${input.appointmentId}`, db as any, {
        appointmentId: input.appointmentId,
      });
      if (debit.ok) {
        remainder = "wallet";
        await db.update(serviceAppointments)
          .set({ remainderStatus: "paid", remainderRef: `appt-remainder:${input.appointmentId}`, updatedAt: new Date() })
          .where(eq(serviceAppointments.id, input.appointmentId));
        await writeAudit(input.tenantId, "system", "appointment.remainder_paid", input.appointmentId, `wallet debit ${remainderCents}¢`);
      }
    }
    if (remainder === "none") {
      // PSP payment link fallback (confirmed by runAppointmentWebhookHook).
      try {
        const reference = `${APPT_REMAINDER_REF_PREFIX}${input.appointmentId}`;
        const { randomUUID } = await import("node:crypto");
        const { paymentIntents } = await import("../../drizzle/schema");
        const paymentIntentId = randomUUID();
        await db.insert(paymentIntents).values({
          id: paymentIntentId,
          tenantId: input.tenantId,
          orderId: input.appointmentId,
          customerId: phone.slice(0, 36),
          amount: (remainderCents / 100).toFixed(2),
          currency: "NGN",
          provider: "paystack",
          providerPaymentId: reference,
          idempotencyKey: `appt-remainder:${input.appointmentId}`,
          status: "pending",
          metadata: { kind: "appointment_remainder", appointmentId: input.appointmentId },
          createdAt: now,
          updatedAt: now,
        });
        const { initiateWithFallback } = await import("./payments/initiateWithFallback");
        const outcome = await initiateWithFallback(input.tenantId, {
          tenantId: input.tenantId,
          amountCents: remainderCents,
          currency: "NGN",
          reference,
          metadata: { payment_intent_id: paymentIntentId, tenant_id: input.tenantId, kind: "appointment_remainder", appointmentId: input.appointmentId },
          customer: { phone },
        });
        paymentUrl = outcome.result.authorizationUrl ?? undefined;
        if (paymentUrl) {
          remainder = "link";
          await db.update(serviceAppointments)
            .set({ remainderRef: reference, updatedAt: new Date() })
            .where(eq(serviceAppointments.id, input.appointmentId));
        }
      } catch (e: any) {
        console.warn("[appointments] remainder link failed:", e?.message);
      }
      if (remainder === "none") remainder = "failed";
    }
  }

  const [appt] = await db.select().from(serviceAppointments).where(eq(serviceAppointments.id, input.appointmentId)).limit(1);
  const fmt = `₦${(remainderCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
  const body =
    remainder === "wallet"
      ? `✅ Your appointment (ref ${input.appointmentId.slice(0, 8)}) is complete — the ${fmt} remainder was charged from your wallet. Thank you!`
      : remainder === "link"
        ? `✅ Your appointment (ref ${input.appointmentId.slice(0, 8)}) is complete. Please pay the ${fmt} remainder:`
        : `✅ Your appointment (ref ${input.appointmentId.slice(0, 8)}) is complete.`;
  await notifyCustomerBothChannels(input.tenantId, claimed.customer_id, body,
    paymentUrl ? { paymentUrl, appointmentId: input.appointmentId } : { appointmentId: input.appointmentId });
  return { appt: appt!, remainder, paymentUrl };
}

export async function markNoShow(
  db: Db,
  input: { tenantId: string; appointmentId: string; actorId?: string },
): Promise<ServiceAppointment> {
  await requireActiveTenant(db, input.tenantId);
  const now = new Date();
  const flipped = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT * FROM service_appointments
      WHERE id = ${input.appointmentId} AND tenant_id = ${input.tenantId}
      FOR UPDATE`)) as any;
    const list: any[] = Array.isArray(rows) ? rows : (rows?.rows ?? []);
    const raw = list[0];
    if (!raw) throw new TRPCError({ code: "NOT_FOUND", message: "Appointment not found." });
    if (raw.status !== "confirmed" && raw.status !== "booked") {
      throw new TRPCError({ code: "CONFLICT", message: `That appointment is ${raw.status} — cannot mark no-show.` });
    }
    const upd = await tx.execute(sql`
      UPDATE service_appointments SET status = 'no_show', updated_at = ${now.toISOString()}
      WHERE id = ${raw.id} AND status IN ('booked','confirmed')`);
    return raw;
  });
  // Deposit kept (deposit_status stays 'paid'); audit records the decision.
  await writeAudit(input.tenantId, input.actorId ?? "merchant", "appointment.no_show", input.appointmentId,
    `customer did not show; deposit ${flipped.deposit_cents}¢ kept`);
  await notifyCustomerBothChannels(input.tenantId, flipped.customer_id,
    `You missed your appointment (ref ${input.appointmentId.slice(0, 8)}). As a no-show, the deposit is kept. Please chat with us to rebook.`,
    { appointmentId: input.appointmentId });
  const [appt] = await db.select().from(serviceAppointments).where(eq(serviceAppointments.id, input.appointmentId)).limit(1);
  return appt!;
}
