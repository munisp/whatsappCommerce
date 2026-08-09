/**
 * server/services/integrations/odooB2B.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave-8 B2B sync: purchase-order lifecycle events flow through the existing
 * transactional outbox (HMAC/retry/DLQ machinery untouched) into the
 * SUPPLIER's Odoo ERP and Twenty CRM, and Odoo inbound webhooks flip local
 * purchase_orders to 'fulfilled'.
 *
 * Outbound (enqueued on the SUPPLIER tenant — the ERP/CRM being synced is
 * theirs):
 *   po.submitted            → Odoo purchase.order DRAFT, lines from po_items
 *   po.approved/po.invoiced → confirm PO + account.move vendor bill (due_date)
 *   repayment.posted        → account.payment matched to the vendor bill
 *   (any PO event)          → Twenty: supplier Company + PO Opportunity whose
 *                             stage is mapped from the PO status
 *   po.invoiced (mirror)    → buyer's Odoo as a customer invoice, ONLY when
 *                             the buyer configures integrations.odoo.b2bMirror
 *
 * Inbound (signature-verified by inbound.ts):
 *   odoo stock.picking done → raw-SQL guarded UPDATE purchase_orders →
 *   status='fulfilled' (exactly-once: only from 'approved'/'invoiced'),
 *   then the buyer is notified over WhatsApp.
 *
 * S2's tables (purchase_orders, po_items, supplier_profiles) are queried via
 * RAW SQL only — zero compile-time dependency on unmerged schema.
 */

import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { tenants, type IntegrationEvent } from "../../../drizzle/schema";
import {
  IntegrationError,
  type IntegrationConfig,
  type OdooClient,
  type TwentyClient,
} from "./clients";
import { enqueueIntegrationEvent } from "./outbox";
import { recordUsage } from "../metering";
import { sendWhatsAppText } from "../waSender";

// ── Event kinds / entities ───────────────────────────────────────────────────

export const B2B_ENTITY_PO = "purchase_order";
export const B2B_ENTITY_SUPPLIER = "supplier";
export const B2B_ENTITY_REPAYMENT = "credit_repayment";
/** Entities counted by the /health/ready odoo b2b outbox-lag probe. */
export const B2B_OUTBOX_ENTITIES: string[] = [B2B_ENTITY_PO, B2B_ENTITY_SUPPLIER, B2B_ENTITY_REPAYMENT];

/** Usage-metering metrics (wave-5 metering service). */
export const METRIC_ODOO_B2B_EVENTS = "odoo_b2b_events";

/** PO status → Twenty pipeline stage. */
export const PO_TO_TWENTY_STAGE: Record<string, string> = {
  draft: "NEW",
  submitted: "NEW",
  approved: "MEETING",
  rejected: "NEW",
  fulfilled: "CUSTOMER",
  invoiced: "PROPOSAL",
  paid: "CUSTOMER",
};

export function poStatusToTwentyStage(status: string): string {
  return PO_TO_TWENTY_STAGE[status] ?? "NEW";
}

// ── Raw-SQL access to S2 tables (no schema import) ──────────────────────────

export interface PurchaseOrderRow {
  id: string;
  poNumber: string;
  buyerTenantId: string;
  supplierTenantId: string;
  status: string;
  subtotalCents: number;
  paymentMode: string;
  creditAccountId: string | null;
  dueDate: Date | null;
}

export interface PoItemRow {
  productRef: string | null;
  name: string;
  qty: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

function rowsOf(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  const r = res as { rows?: Array<Record<string, unknown>> } | null;
  return r?.rows ?? [];
}

export async function loadPurchaseOrder(db: any, poId: string): Promise<PurchaseOrderRow | null> {
  const res = await db.execute(sql`
    SELECT id, po_number, buyer_tenant_id, supplier_tenant_id, status,
           subtotal_cents, payment_mode, credit_account_id, due_date
    FROM purchase_orders
    WHERE id = ${poId}
    LIMIT 1
  `);
  const r = rowsOf(res)[0];
  if (!r) return null;
  return {
    id: String(r.id),
    poNumber: String(r.po_number),
    buyerTenantId: String(r.buyer_tenant_id),
    supplierTenantId: String(r.supplier_tenant_id),
    status: String(r.status),
    subtotalCents: Number(r.subtotal_cents ?? 0),
    paymentMode: String(r.payment_mode ?? "paynow"),
    creditAccountId: r.credit_account_id ? String(r.credit_account_id) : null,
    dueDate: r.due_date ? new Date(r.due_date as string | Date) : null,
  };
}

export async function loadPoItems(db: any, poId: string): Promise<PoItemRow[]> {
  const res = await db.execute(sql`
    SELECT product_ref, name, qty, unit_price_cents, line_total_cents
    FROM po_items
    WHERE po_id = ${poId}
    ORDER BY name
  `);
  return rowsOf(res).map((r) => ({
    productRef: r.product_ref ? String(r.product_ref) : null,
    name: String(r.name ?? "Item"),
    qty: Number(r.qty ?? 1),
    unitPriceCents: Number(r.unit_price_cents ?? 0),
    lineTotalCents: Number(r.line_total_cents ?? 0),
  }));
}

/** 'YYYY-MM-DD' for Odoo date fields. */
export function toOdooDate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

// ── Enqueue (outbound) ───────────────────────────────────────────────────────

export interface EnqueueB2BInput {
  /** The tenant whose ERP/CRM is being synced — usually the SUPPLIER. */
  tenantId: string;
  entity: string;
  entityId: string;
  /** 'po.submitted' | 'po.approved' | 'po.invoiced' | 'repayment.posted' | 'supplier.upsert' */
  action: string;
  data: Record<string, unknown>;
  /** Buyer mirror: enqueue po.buyer_invoice into the BUYER's Odoo too. */
  buyerTenantId?: string | null;
}

async function tenantIntegrations(db: any, tenantId: string): Promise<Record<string, IntegrationConfig>> {
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return (((tenant?.settings as any)?.integrations ?? {}) as Record<string, IntegrationConfig>);
}

/**
 * Enqueue a B2B lifecycle event to every enabled system that mirrors it
 * (odoo + twenty). Never throws per-system — mirrors syncLocalChange. Returns
 * the enqueued event ids.
 */
export async function enqueueB2BSync(db: any, input: EnqueueB2BInput): Promise<string[]> {
  const integrations = await tenantIntegrations(db, input.tenantId);
  const ids: string[] = [];
  for (const system of ["odoo", "twenty"] as const) {
    const cfg = integrations[system];
    if (!cfg || cfg.enabled !== true || !cfg.url) continue; // only enabled systems sync
    try {
      const id = await enqueueIntegrationEvent(db, {
        tenantId: input.tenantId,
        system,
        entity: input.entity,
        entityId: input.entityId,
        action: input.action,
        data: input.data,
        origin: "platform",
      });
      if (id) ids.push(id);
      if (system === "odoo" && id) {
        // Ops metering: one odoo b2b event enqueued. recordUsage never throws.
        await recordUsage(db, input.tenantId, METRIC_ODOO_B2B_EVENTS);
      }
    } catch (err: any) {
      console.error(`[b2b-outbox] enqueue failed (${system}/${input.entity}/${input.entityId}):`, err?.message);
    }
  }

  // Optional buyer-side mirror: supplier invoices → buyer's Odoo as a
  // customer invoice when the BUYER configures integrations.odoo.b2bMirror.
  if (input.action === "po.invoiced" && input.buyerTenantId && input.buyerTenantId !== input.tenantId) {
    try {
      const buyerIntegrations = await tenantIntegrations(db, input.buyerTenantId);
      const cfg = buyerIntegrations.odoo;
      if (cfg && cfg.enabled === true && cfg.url && (cfg as any).b2bMirror === true) {
        const id = await enqueueIntegrationEvent(db, {
          tenantId: input.buyerTenantId,
          system: "odoo",
          entity: input.entity,
          entityId: input.entityId,
          action: "po.buyer_invoice",
          data: input.data,
          origin: "platform",
        });
        if (id) ids.push(id);
      }
    } catch (err: any) {
      console.error(`[b2b-outbox] buyer-mirror enqueue failed (${input.entityId}):`, err?.message);
    }
  }
  return ids;
}

// ── Delivery (called from outbox.deliverOutboxEvent via lazy import) ─────────

interface DeliverData {
  [key: string]: unknown;
}

function payloadOf(event: IntegrationEvent): { action: string; data: DeliverData } {
  const payload = (event.payload ?? {}) as { action?: string; data?: DeliverData };
  return { action: payload.action ?? "updated", data: payload.data ?? {} };
}

function linesFromData(data: DeliverData): Array<{ productRef: string | null; name: string; quantity: number; unitPrice: number }> {
  const items = Array.isArray(data.items) ? (data.items as any[]) : [];
  return items.map((i) => ({
    productRef: (i.productRef as string) ?? (i.product_ref as string) ?? null,
    name: String(i.name ?? i.productName ?? "Item"),
    quantity: Number(i.qty ?? i.quantity ?? 1),
    // unitPrice is MAJOR units for Odoo; accept either cents or major.
    unitPrice: i.unitPrice !== undefined ? Number(i.unitPrice) : Number(i.unitPriceCents ?? i.unit_price_cents ?? 0) / 100,
  }));
}

/** Odoo-side delivery for B2B entities. Throws IntegrationError on failure. */
export async function deliverOdooB2B(db: any, client: OdooClient, event: IntegrationEvent): Promise<void> {
  const { action, data } = payloadOf(event);
  const poNumber = String(data.poNumber ?? data.po_number ?? event.entityId);
  const buyerName = String(data.buyerName ?? data.buyerTenantId ?? "B2B Buyer");
  const supplierName = String(data.supplierName ?? data.supplierTenantId ?? "B2B Supplier");
  const dueDate = toOdooDate((data.dueDate as string | Date | null) ?? null);

  switch (action) {
    case "po.submitted": {
      const partner = await client.upsertPartner({
        name: buyerName,
        phone: (data.buyerPhone as string) ?? null,
        externalRef: String(data.buyerTenantId ?? event.tenantId),
      });
      await client.createPurchaseOrder({
        partnerId: partner.id,
        origin: poNumber,
        lines: linesFromData(data),
      });
      return;
    }
    case "po.approved":
    case "po.invoiced": {
      const partner = await client.upsertPartner({
        name: buyerName,
        phone: (data.buyerPhone as string) ?? null,
        externalRef: String(data.buyerTenantId ?? event.tenantId),
      });
      // Find-or-create the draft, then confirm it and raise the vendor bill
      // (with the credit due date) on the supplier's books.
      let po = await client.findPurchaseOrderByOrigin(poNumber);
      if (!po) {
        po = await client.createPurchaseOrder({
          partnerId: partner.id,
          origin: poNumber,
          lines: linesFromData(data),
        });
      }
      await client.confirmPurchaseOrder(po.id);
      if (action === "po.invoiced") {
        await client.createVendorBill({
          partnerId: partner.id,
          ref: poNumber,
          dueDate,
          lines: linesFromData(data),
        });
      }
      return;
    }
    case "repayment.posted": {
      const amountCents = Number(data.amountCents ?? data.amount_cents ?? 0);
      await client.registerBillPayment({ ref: poNumber, amount: amountCents / 100 });
      return;
    }
    case "po.buyer_invoice": {
      // Buyer-side mirror: this event is enqueued on the BUYER tenant, so the
      // resolved client is the buyer's Odoo; the supplier is the partner.
      const partner = await client.upsertPartner({
        name: supplierName,
        phone: (data.supplierPhone as string) ?? null,
        externalRef: String(data.supplierTenantId ?? event.tenantId),
      });
      await client.createCustomerInvoice({
        partnerId: partner.id,
        ref: poNumber,
        dueDate,
        lines: linesFromData(data),
      });
      return;
    }
    default:
      console.warn(`[b2b-outbox] no odoo delivery handler for action '${action}' — marking delivered`);
      return;
  }
}

/** Twenty-side delivery for B2B entities (supplier Company + PO deal). */
export async function deliverTwentyB2B(db: any, client: TwentyClient, event: IntegrationEvent): Promise<void> {
  const { action, data } = payloadOf(event);
  const supplierName = String(data.supplierName ?? data.supplierTenantId ?? event.entityId);

  if (event.entity === B2B_ENTITY_SUPPLIER || action === "supplier.upsert") {
    await client.upsertCompany({
      name: supplierName,
      domainName: (data.domainName as string) ?? null,
    });
    return;
  }

  if (event.entity === B2B_ENTITY_PO) {
    const company = await client.upsertCompany({
      name: supplierName,
      domainName: (data.domainName as string) ?? null,
    });
    const poNumber = String(data.poNumber ?? data.po_number ?? event.entityId);
    const status = String(data.status ?? action.replace(/^po\./, ""));
    const subtotalCents = Number(data.subtotalCents ?? data.subtotal_cents ?? 0);
    await client.upsertOpportunity({
      name: `PO ${poNumber}`,
      companyId: company.id || null,
      amountMicros: subtotalCents * 10_000, // cents → micros
      currencyCode: String(data.currency ?? "NGN"),
      stage: poStatusToTwentyStage(status),
    });
    return;
  }

  console.warn(`[b2b-outbox] no twenty delivery handler for ${event.entity}/${action} — marking delivered`);
}

// ── Inbound: Odoo stock.picking done → PO fulfilled (exactly-once) ──────────

function adminPhoneFromSettings(settings: unknown): string | null {
  const s = settings as any;
  const cand = s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone;
  return typeof cand === "string" && cand.trim() ? cand.trim() : null;
}

/**
 * Apply an Odoo stock.picking 'done' webhook. The guarded UPDATE is the
 * idempotency mechanism: only a PO still in 'approved'/'invoiced' transitions,
 * so a replayed webhook matches zero rows and neither re-updates nor
 * re-notifies. Scoped to the SUPPLIER tenant (the webhook's tenant).
 */
export async function applyOdooPickingDone(
  db: any,
  tenantId: string,
  action: string,
  data: Record<string, unknown>,
): Promise<string> {
  const state = String(data.state ?? action ?? "");
  if (state !== "done" && action !== "done") return "ignored";

  const poNumber = (data.origin ?? data.po_number ?? data.poNumber ?? null) as string | null;
  const poId = (data.po_id ?? data.poId ?? null) as string | null;
  if (!poNumber && !poId) return "ignored";

  const now = new Date();
  const res = await db.execute(sql`
    UPDATE purchase_orders
    SET status = 'fulfilled', updated_at = ${now}
    WHERE supplier_tenant_id = ${tenantId}
      AND ((${poId}::text IS NOT NULL AND id = ${poId}::uuid)
        OR (${poNumber}::text IS NOT NULL AND po_number = ${poNumber}))
      AND status IN ('approved', 'invoiced')
    RETURNING id, po_number, buyer_tenant_id
  `);
  const row = rowsOf(res)[0];
  if (!row) return "ignored"; // replay / unknown PO / wrong state — exactly-once guard

  // Notify the buyer (best-effort: a WhatsApp outage must not fail the webhook).
  try {
    const buyerTenantId = String(row.buyer_tenant_id);
    const [buyer] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, buyerTenantId))
      .limit(1);
    const adminPhone = adminPhoneFromSettings(buyer?.settings);
    if (adminPhone) {
      await sendWhatsAppText(
        buyerTenantId,
        adminPhone,
        `📦 Your purchase order ${String(row.po_number)} has been fulfilled by the supplier (Odoo delivery done).`,
        { notifType: "b2b_po_fulfilled" },
      );
    }
  } catch (err: any) {
    console.error(`[b2b-inbound] buyer notify failed for picking ${poNumber ?? poId}:`, err?.message);
  }
  return "updated";
}
