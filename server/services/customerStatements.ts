// === W46 uc-docs ===
/**
 * UC-12 — per-customer statement of account.
 *
 * Aggregates a customer's REAL activity for a period from orders + payments:
 *   - Invoiced: orders (tenantId, customerId = phone) created in the period,
 *     excluding cancelled orders. Integer cents from decimal totals.
 *   - Paid: payment_intents rows (status 'completed') whose orderId belongs
 *     to the customer's orders, completed in the period.
 *   - Outstanding = invoiced - paid (floored at 0 per currency).
 *
 * Mixed-currency activity yields one statement row per currency — never
 * summed across currencies (same doctrine as the W33 annual statements).
 *
 * The PDF is written FIRST (ucDocsPdf.linesToPdf → UC_DOCS_DIR); only then
 * does the row claim status 'generated'. Delivery is a chat document on the
 * customer's channel (WA document push / telegram sendDocument via the
 * channelParity category 'customer_statement'); status → 'sent' only after
 * the send returns.
 */
import crypto from "crypto";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { customerStatements, orders, paymentIntents } from "../../drizzle/schema";
import { linesToPdf, writeDocPdf, sendChatDocument } from "./ucDocsPdf";

type Db = any;

export class StatementError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StatementError";
    this.code = code;
  }
}

function toCents(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export interface CustomerStatementTotals {
  currency: string;
  orderCount: number;
  paymentCount: number;
  totalInvoicedCents: number;
  totalPaidCents: number;
  outstandingCents: number;
  lines: { orderNumber: string; createdAt: string; status: string; totalCents: number }[];
  payments: { reference: string | null; completedAt: string; amountCents: number }[];
}

/** Compute per-currency statement totals for one customer over a period. */
export async function computeCustomerStatement(
  db: Db,
  opts: { tenantId: string; customerPhone: string; from: Date; to: Date },
): Promise<CustomerStatementTotals[]> {
  const { tenantId, customerPhone, from, to } = opts;
  const orderRows = await db.select().from(orders)
    .where(and(
      eq(orders.tenantId, tenantId),
      eq(orders.customerId, customerPhone),
      gte(orders.createdAt, from),
      lt(orders.createdAt, to),
    ))
    .catch(() => [] as any[]);

  const byCurrency = new Map<string, CustomerStatementTotals>();
  const bucket = (currency: string) => {
    const cur = (currency ?? "NGN").toUpperCase().slice(0, 3);
    let b = byCurrency.get(cur);
    if (!b) {
      b = { currency: cur, orderCount: 0, paymentCount: 0, totalInvoicedCents: 0, totalPaidCents: 0, outstandingCents: 0, lines: [], payments: [] };
      byCurrency.set(cur, b);
    }
    return b;
  };

  const orderIds: string[] = [];
  const orderCurrency = new Map<string, string>();
  for (const o of orderRows ?? []) {
    if (o.status === "cancelled") continue;
    const cents = toCents(o.totalAmount);
    if (cents <= 0) continue;
    const b = bucket(o.currency);
    b.orderCount += 1;
    b.totalInvoicedCents += cents;
    b.lines.push({ orderNumber: o.orderNumber, createdAt: new Date(o.createdAt).toISOString(), status: o.status, totalCents: cents });
    orderIds.push(o.id);
    orderCurrency.set(o.id, (o.currency ?? "NGN").toUpperCase().slice(0, 3));
  }

  if (orderIds.length) {
    const pays = await db.select().from(paymentIntents)
      .where(and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.status, "completed"),
        inArray(paymentIntents.orderId, orderIds),
      ))
      .catch(() => [] as any[]);
    for (const p of pays ?? []) {
      const cents = toCents(p.amount);
      if (cents <= 0) continue;
      const b = bucket(orderCurrency.get(p.orderId) ?? p.currency ?? "NGN");
      b.paymentCount += 1;
      b.totalPaidCents += cents;
      b.payments.push({
        reference: p.providerPaymentId ?? null,
        completedAt: new Date(p.completedAt ?? p.updatedAt).toISOString(),
        amountCents: cents,
      });
    }
  }

  for (const b of Array.from(byCurrency.values())) {
    b.outstandingCents = Math.max(0, b.totalInvoicedCents - b.totalPaidCents);
    b.lines.sort((a, c) => a.createdAt.localeCompare(c.createdAt));
    b.payments.sort((a, c) => a.completedAt.localeCompare(c.completedAt));
  }
  return Array.from(byCurrency.values()).sort((a, b) => a.currency.localeCompare(b.currency));
}

export function statementPdfLines(t: CustomerStatementTotals, opts: { tenantId: string; customerPhone: string; customerName?: string | null; from: Date; to: Date }): string[] {
  const fmt = (c: number) => `${t.currency} ${(c / 100).toFixed(2)}`;
  const lines = [
    `Merchant:      ${opts.tenantId}`,
    `Customer:      ${opts.customerName ?? ""} (${opts.customerPhone})`.trim(),
    `Period:        ${opts.from.toISOString().slice(0, 10)} .. ${opts.to.toISOString().slice(0, 10)}`,
    `Currency:      ${t.currency}`,
    "",
    "ORDERS",
    ...t.lines.map((l) => `  ${l.createdAt.slice(0, 10)}  ${l.orderNumber.padEnd(18)} ${l.status.padEnd(12)} ${fmt(l.totalCents)}`),
    "",
    "PAYMENTS",
    ...t.payments.map((p) => `  ${p.completedAt.slice(0, 10)}  ${(p.reference ?? "-").padEnd(24)} ${fmt(p.amountCents)}`),
    "",
    `Total invoiced:  ${fmt(t.totalInvoicedCents)} across ${t.orderCount} order(s)`,
    `Total paid:      ${fmt(t.totalPaidCents)} across ${t.paymentCount} payment(s)`,
    `Outstanding:     ${fmt(t.outstandingCents)}`,
    "",
    "Generated from real order and payment records.",
  ];
  return lines;
}

/** Generate (idempotently regenerate) the statement(s) for one customer. */
export async function generateCustomerStatement(
  db: Db,
  opts: { tenantId: string; customerPhone: string; customerName?: string | null; from: Date; to: Date },
) {
  const { tenantId, customerPhone, from, to } = opts;
  if (!(from < to)) throw new StatementError("invalid-period", "from must be before to");
  const totals = await computeCustomerStatement(db, opts);
  if (!totals.length) {
    throw new StatementError("NO_ACTIVITY", "no orders or payments for this customer in that period");
  }
  const out: any[] = [];
  for (const t of totals) {
    const pdf = linesToPdf({
      title: "Statement of Account",
      lines: statementPdfLines(t, { ...opts, customerName: opts.customerName }),
    });
    const rel = `${String(tenantId).replace(/[^A-Za-z0-9_.-]/g, "_")}/statements/${customerPhone.replace(/[^0-9+]/g, "")}-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.${t.currency}.pdf`;
    writeDocPdf(rel, pdf); // throws honestly — no row is written first

    const [existing] = await db.select().from(customerStatements)
      .where(and(
        eq(customerStatements.tenantId, tenantId),
        eq(customerStatements.customerPhone, customerPhone),
        eq(customerStatements.periodStart, from),
        eq(customerStatements.periodEnd, to),
        eq(customerStatements.currency, t.currency),
      )).limit(1);
    const now = new Date();
    if (existing) {
      const changed = existing.totalInvoicedCents !== t.totalInvoicedCents || existing.totalPaidCents !== t.totalPaidCents || existing.orderCount !== t.orderCount;
      await db.update(customerStatements).set({
        customerName: opts.customerName ?? existing.customerName,
        orderCount: t.orderCount,
        paymentCount: t.paymentCount,
        totalInvoicedCents: t.totalInvoicedCents,
        totalPaidCents: t.totalPaidCents,
        outstandingCents: t.outstandingCents,
        pdfPath: rel,
        status: changed ? "generated" : existing.status,
        generatedAt: now,
        updatedAt: now,
      }).where(eq(customerStatements.id, existing.id));
      const [row] = await db.select().from(customerStatements).where(eq(customerStatements.id, existing.id));
      out.push({ ...row, regenerated: true });
    } else {
      const id = crypto.randomUUID();
      await db.insert(customerStatements).values({
        id, tenantId, customerPhone,
        customerName: opts.customerName ?? null,
        periodStart: from, periodEnd: to,
        currency: t.currency,
        orderCount: t.orderCount,
        paymentCount: t.paymentCount,
        totalInvoicedCents: t.totalInvoicedCents,
        totalPaidCents: t.totalPaidCents,
        outstandingCents: t.outstandingCents,
        status: "generated",
        pdfPath: rel,
        generatedAt: now, createdAt: now, updatedAt: now,
      });
      const [row] = await db.select().from(customerStatements).where(eq(customerStatements.id, id));
      out.push({ ...row, regenerated: false });
    }
  }
  return { statements: out, customerPhone };
}

/** Send a generated statement as a chat document (WA/TG). */
export async function sendCustomerStatement(
  db: Db,
  opts: { tenantId: string; statementId: string; phone?: string | null },
) {
  const [st] = await db.select().from(customerStatements)
    .where(and(eq(customerStatements.id, opts.statementId), eq(customerStatements.tenantId, opts.tenantId)))
    .limit(1);
  if (!st) throw new StatementError("not-found", "statement not found");
  if (!st.pdfPath) throw new StatementError("no-pdf", "statement PDF missing — regenerate first");
  const phone = opts.phone ?? st.customerPhone;
  if (!phone) throw new StatementError("NO_PHONE", "no customer phone on file");

  const res = await sendChatDocument(opts.tenantId, phone, {
    relPath: st.pdfPath,
    filename: `statement-${st.periodStart.toISOString().slice(0, 10)}_${st.periodEnd.toISOString().slice(0, 10)}-${st.currency}.pdf`,
    caption: `Your statement of account from ${opts.tenantId}: ${st.currency} ${(st.totalInvoicedCents / 100).toFixed(2)} invoiced, ${st.currency} ${(st.outstandingCents / 100).toFixed(2)} outstanding.`,
    notifType: "customer_statement_send",
    category: "customer_statement",
  });
  const now = new Date();
  await db.update(customerStatements).set({
    status: "sent", sentAt: now, waMessageId: res.messageId, channel: res.channel, updatedAt: now,
  }).where(eq(customerStatements.id, st.id));
  const [row] = await db.select().from(customerStatements).where(eq(customerStatements.id, st.id));
  return { statement: row, delivery: res };
}
// === END W46 uc-docs ===
