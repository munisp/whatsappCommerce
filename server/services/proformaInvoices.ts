// === W46 uc-docs ===
/**
 * UC-19 — proforma invoice / formal quotation.
 *
 * A proforma is a priced document rendered with the SAME layout machinery as
 * the AR invoice / statement PDFs (ucDocsPdf.linesToPdf), delivered to the
 * buyer as a chat document (WA document push / telegram sendDocument via the
 * channelParity category 'proforma_invoice'), and convertible into a real
 * storefront order.
 *
 * Doctrine:
 *  - Integer cents; items are snapshotted into the proforma row so later
 *    catalog price changes NEVER rewrite an issued quotation.
 *  - Tenant-scoped proforma_no sequence (max+1 retried on the unique index —
 *    same pattern as ar_invoices).
 *  - convert-to-order is claim-first: ONE guarded UPDATE flips
 *    status → 'converted' and stamps order_id; only the claimant creates the
 *    order row. Exactly one order per proforma, ever.
 *  - Expired/cancelled proformas refuse conversion honestly.
 */
import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { orderItems, orders, proformaInvoices } from "../../drizzle/schema";
import { linesToPdf, writeDocPdf, sendChatDocument } from "./ucDocsPdf";

type Db = any;

export class ProformaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProformaError";
    this.code = code;
  }
}

export interface ProformaItem {
  productId?: string | null;
  name: string;
  quantity: number;
  unitPriceCents: number;
}

function validateItems(items: ProformaItem[]): number {
  if (!Array.isArray(items) || items.length === 0) throw new ProformaError("invalid-items", "at least one item is required");
  let total = 0;
  for (const it of items) {
    if (!it.name || !String(it.name).trim()) throw new ProformaError("invalid-items", "each item needs a name");
    if (!Number.isInteger(it.quantity) || it.quantity <= 0) throw new ProformaError("invalid-items", "quantity must be a positive integer");
    if (!Number.isInteger(it.unitPriceCents) || it.unitPriceCents < 0) throw new ProformaError("invalid-items", "unitPriceCents must be a non-negative integer");
    total += it.quantity * it.unitPriceCents;
  }
  return total;
}

// ── Create (draft) ────────────────────────────────────────────────────────────
export interface CreateProformaInput {
  tenantId: string;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  items: ProformaItem[];
  currency?: string;
  validDays?: number;
  rfqId?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function createProforma(db: Db, input: CreateProformaInput) {
  const totalCents = validateItems(input.items);
  if (!(totalCents > 0)) throw new ProformaError("invalid-amount", "proforma total must be positive");
  const currency = (input.currency ?? "NGN").toUpperCase().slice(0, 3);
  const now = new Date();
  const validUntil = new Date(now.getTime() + Math.max(1, input.validDays ?? 14) * 86400000);
  let lastErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.transaction(async (tx: Db) => {
        const rows: any = await tx.execute(sql`
          SELECT COALESCE(MAX(proforma_no), 0) + 1 AS next_no
          FROM proforma_invoices WHERE tenant_id = ${input.tenantId}
        `);
        const r = (Array.isArray(rows) ? rows : rows?.rows ?? [])[0];
        const nextNo = Number(r?.next_no ?? 1);
        const [pf] = await tx.insert(proformaInvoices).values({
          id: crypto.randomUUID(),
          tenantId: input.tenantId,
          proformaNo: nextNo,
          customerName: input.customerName ?? null,
          customerPhone: input.customerPhone ?? null,
          customerEmail: input.customerEmail ?? null,
          items: input.items as any,
          totalCents,
          currency,
          status: "draft",
          validUntil,
          rfqId: input.rfqId ?? null,
          notes: input.notes ?? null,
          metadata: input.metadata ?? null,
          createdAt: now,
          updatedAt: now,
        }).returning();
        return pf;
      });
    } catch (err: any) {
      lastErr = err;
      if (!String(err?.message ?? "").includes("proforma_invoices_tenant_no_uniq")) throw err;
    }
  }
  throw lastErr;
}

// ── Render PDF (reuses the AR/statement document machinery) ──────────────────
export function proformaPdfLines(pf: any): string[] {
  const fmt = (c: number) => `${pf.currency} ${(c / 100).toFixed(2)}`;
  const items = (pf.items ?? []) as ProformaItem[];
  return [
    `Merchant:      ${pf.tenantId}`,
    `Proforma No:   PF-${String(pf.proformaNo).padStart(5, "0")}`,
    `Customer:      ${(pf.customerName ?? "")} ${pf.customerPhone ? `(${pf.customerPhone})` : ""}`.trim(),
    `Valid until:   ${pf.validUntil ? new Date(pf.validUntil).toISOString().slice(0, 10) : "-"}`,
    `Currency:      ${pf.currency}`,
    "",
    "ITEMS",
    ...items.map((it) => `  ${String(it.quantity).padStart(4)} x ${it.name.slice(0, 30).padEnd(30)} @ ${fmt(it.unitPriceCents)} = ${fmt(it.quantity * it.unitPriceCents)}`),
    "",
    `TOTAL:         ${fmt(pf.totalCents)}`,
    ...(pf.notes ? ["", `Notes: ${pf.notes}`] : []),
    "",
    "This is a PROFORMA invoice (quotation) — not a tax invoice.",
    "It confirms price and availability until the validity date above.",
  ];
}

export function renderProformaPdf(pf: any, tenantId: string): string {
  const pdf = linesToPdf({ title: `PROFORMA INVOICE PF-${String(pf.proformaNo).padStart(5, "0")}`, lines: proformaPdfLines(pf) });
  const rel = `${String(tenantId).replace(/[^A-Za-z0-9_.-]/g, "_")}/proformas/pf-${String(pf.proformaNo).padStart(5, "0")}.pdf`;
  return writeDocPdf(rel, pdf);
}

// ── Send via chat document ────────────────────────────────────────────────────
export async function sendProforma(db: Db, opts: { tenantId: string; proformaId: string; phone?: string | null }) {
  const [pf] = await db.select().from(proformaInvoices)
    .where(and(eq(proformaInvoices.id, opts.proformaId), eq(proformaInvoices.tenantId, opts.tenantId)))
    .limit(1);
  if (!pf) throw new ProformaError("not-found", "proforma not found");
  if (["cancelled", "expired", "converted"].includes(pf.status)) {
    throw new ProformaError("bad-status", `a ${pf.status} proforma cannot be sent`);
  }
  const phone = opts.phone ?? pf.customerPhone;
  if (!phone) throw new ProformaError("NO_PHONE", "no customer phone on file");

  const rel = renderProformaPdf(pf, opts.tenantId); // re-render deterministically
  const res = await sendChatDocument(opts.tenantId, phone, {
    relPath: rel,
    filename: `proforma-PF-${String(pf.proformaNo).padStart(5, "0")}.pdf`,
    caption: `Proforma invoice PF-${String(pf.proformaNo).padStart(5, "0")} from ${opts.tenantId}: ${pf.currency} ${(pf.totalCents / 100).toFixed(2)}${pf.validUntil ? `, valid until ${new Date(pf.validUntil).toISOString().slice(0, 10)}` : ""}.`,
    notifType: "proforma_invoice_send",
    category: "proforma_invoice",
  });
  const now = new Date();
  await db.update(proformaInvoices).set({
    status: pf.status === "draft" ? "sent" : pf.status,
    pdfPath: rel, sentAt: pf.sentAt ?? now, waMessageId: res.messageId, channel: res.channel, updatedAt: now,
  }).where(eq(proformaInvoices.id, pf.id));
  const [row] = await db.select().from(proformaInvoices).where(eq(proformaInvoices.id, pf.id));
  return { proforma: row, delivery: res };
}

/** Buyer accepted the quotation (chat confirm or dashboard action). */
export async function acceptProforma(db: Db, opts: { tenantId: string; proformaId: string }) {
  const upd: any = await db.execute(sql`
    UPDATE proforma_invoices
    SET status = 'accepted', updated_at = now()
    WHERE id = ${opts.proformaId} AND tenant_id = ${opts.tenantId}
      AND status IN ('draft', 'sent')
      AND (valid_until IS NULL OR valid_until > now())
    RETURNING id, status
  `);
  const row = (Array.isArray(upd) ? upd : upd?.rows ?? [])[0];
  if (!row) throw new ProformaError("bad-status", "proforma is not open for acceptance (missing, expired, or terminal)");
  const [pf] = await db.select().from(proformaInvoices).where(eq(proformaInvoices.id, opts.proformaId));
  return pf;
}

// ── Convert to order (claim-first; exactly one order per proforma) ───────────
export async function convertProformaToOrder(db: Db, opts: { tenantId: string; proformaId: string }) {
  return db.transaction(async (tx: Db) => {
    // Claim-first: flip to 'converted' only if open, unexpired and not yet
    // converted. The claimant alone proceeds to create the order.
    const upd: any = await tx.execute(sql`
      UPDATE proforma_invoices
      SET status = 'converted', converted_at = now(), updated_at = now()
      WHERE id = ${opts.proformaId} AND tenant_id = ${opts.tenantId}
        AND status IN ('draft', 'sent', 'accepted')
        AND order_id IS NULL
        AND (valid_until IS NULL OR valid_until > now())
      RETURNING *
    `);
    const pf = (Array.isArray(upd) ? upd : upd?.rows ?? [])[0];
    if (!pf) {
      const [existing] = await tx.select().from(proformaInvoices)
        .where(and(eq(proformaInvoices.id, opts.proformaId), eq(proformaInvoices.tenantId, opts.tenantId)))
        .limit(1);
      if (!existing) throw new ProformaError("not-found", "proforma not found");
      if (existing.status === "converted" && existing.orderId) {
        return { proforma: existing, orderId: existing.orderId, alreadyConverted: true };
      }
      throw new ProformaError("bad-status", `proforma cannot be converted (status=${existing.status})`);
    }

    const orderId = crypto.randomUUID();
    const orderNumber = `PF-${String(pf.proforma_no).padStart(5, "0")}`;
    const items = (pf.items ?? []) as ProformaItem[];
    const now = new Date();
    await tx.insert(orders).values({
      id: orderId,
      tenantId: opts.tenantId,
      // varchar(36): anonymous proforma conversions key on the proforma id.
      customerId: (pf.customer_phone ?? pf.id).slice(0, 36),
      orderNumber,
      status: "pending",
      totalAmount: (Number(pf.total_cents) / 100).toFixed(2),
      currency: pf.currency,
      paymentStatus: "unpaid",
      items: items.map((it) => ({ productId: it.productId ?? null, name: it.name, quantity: it.quantity, unitPrice: (it.unitPriceCents / 100).toFixed(2) })) as any,
      metadata: { proformaId: pf.id, source: "proforma_convert" },
      createdAt: now,
      updatedAt: now,
    } as any);
    // Order lines only for items bound to a real catalog product.
    for (const it of items) {
      if (!it.productId) continue;
      await tx.insert(orderItems).values({
        id: crypto.randomUUID(),
        orderId,
        productId: it.productId,
        productName: it.name,
        quantity: it.quantity,
        unitPrice: (it.unitPriceCents / 100).toFixed(2),
        currency: pf.currency,
      }).catch(() => undefined); // product may not exist locally — header stays honest
    }
    await tx.execute(sql`
      UPDATE proforma_invoices SET order_id = ${orderId}, updated_at = now() WHERE id = ${pf.id}
    `);
    return { proforma: { ...pf, order_id: orderId, status: "converted" }, orderId, orderNumber, alreadyConverted: false };
  });
}

/** Cancel an open proforma (terminal states are refused honestly). */
export async function cancelProforma(db: Db, opts: { tenantId: string; proformaId: string }) {
  const upd: any = await db.execute(sql`
    UPDATE proforma_invoices
    SET status = 'cancelled', updated_at = now()
    WHERE id = ${opts.proformaId} AND tenant_id = ${opts.tenantId}
      AND status IN ('draft', 'sent', 'accepted')
    RETURNING id
  `);
  const row = (Array.isArray(upd) ? upd : upd?.rows ?? [])[0];
  if (!row) throw new ProformaError("bad-status", "only an open proforma can be cancelled");
  return { proformaId: opts.proformaId, status: "cancelled" };
}

/** Sweep: flip open proformas past validity → expired. Returns count. */
export async function expireProformas(db: Db, now = new Date()): Promise<number> {
  const upd: any = await db.execute(sql`
    UPDATE proforma_invoices
    SET status = 'expired', updated_at = now()
    WHERE status IN ('draft', 'sent', 'accepted')
      AND valid_until IS NOT NULL AND valid_until <= ${now.toISOString()}
    RETURNING id
  `);
  return (Array.isArray(upd) ? upd : upd?.rows ?? []).length;
}
// === END W46 uc-docs ===
