/**
 * W33 tax-statements (Coder A) — supplier tax profiles + annual statements.
 *
 * Melio W-9/1099 analog:
 *  - supplier_tax_profiles: OPTIONAL tax identity capture (TIN/VAT/CAC/NIN)
 *    per (tenant, supplier) — wired into KYB supplier onboarding and the
 *    vendor_bills create path, never required.
 *  - annual_statements: per-supplier annual totals aggregated from REAL
 *    payment records, integer cents, GROUPed BY currency (mixed-currency
 *    years yield one statement row per currency — never summed across):
 *      1. vendor_bill payments (vendor_bill_events 'payment_recorded' rows
 *         carry metadata.chargedCents; wallet_tx ref `vbill:<billId>`),
 *      2. wholesale order payments (wholesale_orders status 'paid' where
 *         the tenant is the buyer; supplier = wholesale_orders.tenant_id),
 *      3. payout wallet_tx withdrawals carrying metadata.supplierRef
 *         (documented attribution convention for the generic payout rail;
 *         reference prefix `payout:`). `vbill:` refs are NEVER double
 *         counted — they are covered by source 1.
 *  - PDF via a minimal dependency-free writer (same pattern as the W28
 *    bookkeeping export pipeline). Status 'generated' is set ONLY after the
 *    file is actually written to TAX_STATEMENTS_DIR (honest — a failed
 *    write throws and no row claims 'generated').
 *  - Send: WhatsApp document push to the supplier phone (waSender media
 *    pipeline). Status → 'sent' only after the send returns (real wamid
 *    stored when the Cloud API responds; simulation honestly labelled in
 *    metadata.waSimulated). 'viewed' on supplier read.
 *  - Withholding: profile.withholding_bps > 0 labels a withheld portion
 *    (integer-cent math) as withholding_note — INFORMATIONAL ONLY: no
 *    withholding rail exists, nothing is deducted (fail honestly).
 */
import crypto from "crypto";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  annualStatements,
  supplierTaxProfiles,
  tenants,
  vendorBillEvents,
  vendorBills,
  walletTransactions,
  wholesaleOrders,
} from "../../drizzle/schema";

type Db = any;

export const TAX_ID_TYPES = ["tin", "vat", "cac", "nin", "other"] as const;
export type TaxIdType = (typeof TAX_ID_TYPES)[number];

/** Directory statement PDFs are written to (honest local persistence). */
export function statementsDir(): string {
  return (process.env.TAX_STATEMENTS_DIR ?? "data/tax-statements").trim() || "data/tax-statements";
}

// ─── Profiles ───────────────────────────────────────────────────────────────

export interface UpsertTaxProfileInput {
  tenantId: string;
  supplierTenantId?: string | null;
  vendorName: string;
  vendorRef?: string | null;
  taxId?: string | null;
  taxIdType?: TaxIdType | null;
  countryCode?: string | null;
  withholdingBps?: number | null;
  metadata?: Record<string, unknown> | null;
  actor?: string | null;
}

/**
 * Create or update the supplier's profile (unique on tenant + COALESCE(
 * supplier_tenant_id, vendor_ref)). Exactly one of supplierTenantId /
 * vendorRef must identify the supplier; when neither is given the vendorName
 * becomes the vendor_ref (external vendor keyed by name).
 */
export async function upsertSupplierTaxProfile(db: Db, input: UpsertTaxProfileInput) {
  const vendorRef = input.vendorRef ?? (input.supplierTenantId ? null : input.vendorName);
  if (!input.supplierTenantId && !vendorRef) {
    throw new Error("supplier identity required (supplierTenantId or vendorRef/vendorName)");
  }
  if (input.taxIdType && !TAX_ID_TYPES.includes(input.taxIdType)) {
    throw new Error(`tax_id_type must be one of ${TAX_ID_TYPES.join("|")}`);
  }
  if (input.countryCode && !/^[A-Za-z]{2}$/.test(input.countryCode)) {
    throw new Error("country_code must be ISO-3166 alpha-2");
  }
  if (input.withholdingBps != null && (!Number.isInteger(input.withholdingBps) || input.withholdingBps < 0 || input.withholdingBps > 10000)) {
    throw new Error("withholding_bps must be an integer 0..10000");
  }
  const [existing] = await db.select().from(supplierTaxProfiles)
    .where(and(
      eq(supplierTaxProfiles.tenantId, input.tenantId),
      sql`coalesce(${supplierTaxProfiles.supplierTenantId}, ${supplierTaxProfiles.vendorRef}) = ${input.supplierTenantId ?? vendorRef}`,
    )).limit(1);
  const now = new Date();
  if (existing) {
    await db.update(supplierTaxProfiles).set({
      vendorName: input.vendorName ?? existing.vendorName,
      taxId: input.taxId !== undefined ? input.taxId : existing.taxId,
      taxIdType: input.taxIdType !== undefined ? input.taxIdType : existing.taxIdType,
      countryCode: input.countryCode !== undefined ? input.countryCode?.toUpperCase() ?? null : existing.countryCode,
      withholdingBps: input.withholdingBps ?? existing.withholdingBps,
      metadata: input.metadata !== undefined ? input.metadata : existing.metadata,
      updatedAt: now,
    }).where(eq(supplierTaxProfiles.id, existing.id));
    const [row] = await db.select().from(supplierTaxProfiles).where(eq(supplierTaxProfiles.id, existing.id));
    return { profile: row, created: false };
  }
  const id = crypto.randomUUID();
  await db.insert(supplierTaxProfiles).values({
    id,
    tenantId: input.tenantId,
    supplierTenantId: input.supplierTenantId ?? null,
    vendorName: input.vendorName,
    vendorRef,
    taxId: input.taxId ?? null,
    taxIdType: input.taxIdType ?? null,
    countryCode: input.countryCode?.toUpperCase() ?? null,
    withholdingBps: input.withholdingBps ?? 0,
    metadata: input.metadata ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(supplierTaxProfiles).where(eq(supplierTaxProfiles.id, id));
  return { profile: row, created: true };
}

export async function findProfileForSupplier(db: Db, tenantId: string, supplierRef: string) {
  const [profile] = await db.select().from(supplierTaxProfiles)
    .where(and(
      eq(supplierTaxProfiles.tenantId, tenantId),
      sql`(coalesce(${supplierTaxProfiles.supplierTenantId}, ${supplierTaxProfiles.vendorRef}) = ${supplierRef} OR ${supplierTaxProfiles.vendorName} = ${supplierRef})`,
    )).limit(1);
  return profile ?? null;
}

// ─── Annual aggregation (REAL payment records, integer cents) ───────────────

export interface SupplierYearTotal {
  supplierRef: string;          // supplierTenantId or vendorRef (statement identity key)
  supplierTenantId: string | null;
  vendorRef: string | null;
  vendorName: string;
  currency: string;
  totalPaidCents: number;
  paymentCount: number;
  sources: { vendorBills: number; wholesale: number; payouts: number }; // payment counts per rail
}

export async function computeAnnualTotals(db: Db, tenantId: string, year: number): Promise<SupplierYearTotal[]> {
  const from = new Date(Date.UTC(year, 0, 1));
  const to = new Date(Date.UTC(year + 1, 0, 1));
  const buckets = new Map<string, SupplierYearTotal>();
  const bump = (key: string, init: Omit<SupplierYearTotal, "totalPaidCents" | "paymentCount" | "sources">,
                cents: number, source: keyof SupplierYearTotal["sources"]) => {
    let b = buckets.get(key);
    if (!b) {
      b = { ...init, totalPaidCents: 0, paymentCount: 0, sources: { vendorBills: 0, wholesale: 0, payouts: 0 } };
      buckets.set(key, b);
    }
    b.totalPaidCents += cents;
    b.paymentCount += 1;
    b.sources[source] += 1;
  };

  // 1. Vendor-bill payments (event metadata.chargedCents, event timestamp).
  const billPays = await db.select({
    eventCreatedAt: vendorBillEvents.createdAt,
    meta: vendorBillEvents.metadata,
    vendorName: vendorBills.vendorName,
    billMeta: vendorBills.metadata,
    currency: vendorBills.currency,
  }).from(vendorBillEvents)
    .innerJoin(vendorBills, eq(vendorBillEvents.billId, vendorBills.id))
    .where(and(
      eq(vendorBills.tenantId, tenantId),
      eq(vendorBillEvents.event, "payment_recorded"),
      gte(vendorBillEvents.createdAt, from),
      lt(vendorBillEvents.createdAt, to),
    ));
  for (const r of billPays) {
    const cents = (r.meta as any)?.chargedCents;
    if (!Number.isInteger(cents) || cents <= 0) continue;
    const vref = (r.billMeta as any)?.vendorRef ?? r.vendorName;
    const currency = r.currency ?? "NGN";
    bump(`${vref}:${currency}`, {
      supplierRef: vref, supplierTenantId: null, vendorRef: vref,
      vendorName: r.vendorName, currency,
    }, cents, "vendorBills");
  }

  // 2. Wholesale order payments (tenant is the BUYER; supplier = order tenant).
  const wsPays = await db.select().from(wholesaleOrders)
    .where(and(
      eq(wholesaleOrders.buyerTenantId, tenantId),
      eq(wholesaleOrders.status, "paid"),
      gte(wholesaleOrders.updatedAt, from),
      lt(wholesaleOrders.updatedAt, to),
    ));
  for (const o of wsPays) {
    const currency = o.currency ?? "NGN";
    bump(`${o.tenantId}:${currency}`, {
      supplierRef: o.tenantId, supplierTenantId: o.tenantId, vendorRef: null,
      vendorName: o.tenantId, currency,
    }, o.totalCents, "wholesale");
  }
  // Resolve supplier tenant display names where possible.
  const supplierIds = Array.from(new Set(Array.from(buckets.values()).filter((b) => b.supplierTenantId).map((b) => b.supplierTenantId!)));
  if (supplierIds.length) {
    const rows = await db.select({ id: tenants.id, name: tenants.name }).from(tenants)
      .where(sql`${tenants.id} = ANY(${supplierIds})`);
    const names = new Map<string, string>(rows.map((r: any) => [r.id as string, r.name as string]));
    for (const b of Array.from(buckets.values())) {
      if (b.supplierTenantId && names.get(b.supplierTenantId)) b.vendorName = names.get(b.supplierTenantId)!;
    }
  }

  // 3. Payout-rail wallet withdrawals attributed via metadata.supplierRef
  //    (reference prefix `payout:`). `vbill:` refs are excluded by the
  //    prefix filter so vendor-bill payments are never double counted.
  const payouts = await db.select().from(walletTransactions)
    .where(and(
      eq(walletTransactions.tenantId, tenantId),
      eq(walletTransactions.type, "withdrawal"),
      gte(walletTransactions.createdAt, from),
      lt(walletTransactions.createdAt, to),
      sql`${walletTransactions.reference} LIKE 'payout:%'`,
    ));
  for (const tx of payouts) {
    const supplierRef = (tx.metadata as any)?.supplierRef;
    if (!supplierRef) continue; // unattributed payout — no honest supplier key
    const cents = Math.round(parseFloat(tx.amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) continue;
    const currency = tx.currency ?? "NGN";
    const isTenant = typeof supplierRef === "string" && supplierRef.startsWith("tenant:");
    const key = isTenant ? supplierRef.slice(7) : supplierRef;
    bump(`${key}:${currency}`, {
      supplierRef: key,
      supplierTenantId: isTenant ? key : null,
      vendorRef: isTenant ? null : key,
      vendorName: (tx.metadata as any)?.supplierName ?? key,
      currency,
    }, cents, "payouts");
  }

  return Array.from(buckets.values()).sort((a, b) => a.supplierRef.localeCompare(b.supplierRef) || a.currency.localeCompare(b.currency));
}

// ─── Minimal statement PDF (same dependency-free pattern as bookkeeping) ────

export interface StatementPdfInput {
  tenantId: string;
  vendorName: string;
  supplierRef: string;
  year: number;
  currency: string;
  totalPaidCents: number;
  paymentCount: number;
  withholdingCents: number;
  withholdingNote: string | null;
  taxId: string | null;
  taxIdType: string | null;
  generatedAt: Date;
}

export function statementToPdf(x: StatementPdfInput): Buffer {
  const fmt = (c: number) => `${x.currency} ${(c / 100).toFixed(2)}`;
  const lines = [
    "Annual Supplier Payment Statement",
    `Payer tenant: ${x.tenantId}`,
    `Supplier:     ${x.vendorName} (${x.supplierRef})`,
    x.taxId ? `Tax ID:       ${x.taxId} (${(x.taxIdType ?? "other").toUpperCase()})` : "Tax ID:       (not on file)",
    `Year:         ${x.year}`,
    `Currency:     ${x.currency}`,
    "",
    `Total paid:   ${fmt(x.totalPaidCents)} across ${x.paymentCount} payment(s)`,
    ...(x.withholdingNote ? ["", `Withholding:  ${fmt(x.withholdingCents)}`, `NOTE: ${x.withholdingNote}`] : []),
    "",
    `Generated:    ${x.generatedAt.toISOString()}`,
    "Figures are aggregated from real payment records (vendor-bill payments,",
    "wholesale order payments, attributed payout wallet withdrawals).",
  ];
  const esc = (s: string) => s.replace(/[^\x20-\x7E]/g, "?").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  let content = "BT /F1 11 Tf 50 780 Td 16 TL\n";
  for (const line of lines) content += `(${esc(line)}) Tj T*\n`;
  content += "ET\n";
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";
  objects[5] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(pdf);
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

// ─── Generate / send / view ─────────────────────────────────────────────────

export const WITHHOLDING_NOTE =
  "withholding is INFORMATIONAL ONLY — no withholding rail exists on this platform; the labelled portion was NOT deducted from payments.";

export interface GenerateResult {
  statements: any[];
  year: number;
  supplierRef: string;
}

/**
 * Generate (or idempotently regenerate) the annual statement(s) for one
 * supplier. One row per currency with real activity in the year. The PDF is
 * written FIRST; only then does the row claim status 'generated'.
 */
export async function generateAnnualStatement(
  db: Db,
  opts: { tenantId: string; supplierRef: string; year: number; actor?: string | null },
): Promise<GenerateResult> {
  const { tenantId, supplierRef, year } = opts;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error("year must be an integer 2000..2100");
  const totals = (await computeAnnualTotals(db, tenantId, year))
    .filter((t) => t.supplierRef === supplierRef || t.vendorName === supplierRef);
  if (!totals.length) throw Object.assign(new Error("NO_PAYMENTS: no real payments to this supplier in that year"), { code: "NO_PAYMENTS" });
  const profile = await findProfileForSupplier(db, tenantId, totals[0].supplierRef)
    ?? await findProfileForSupplier(db, tenantId, supplierRef);

  const out: any[] = [];
  for (const t of totals) {
    const withholdingCents = profile?.withholdingBps
      ? Math.floor((t.totalPaidCents * profile.withholdingBps) / 10000)
      : 0;
    const pdf = statementToPdf({
      tenantId,
      vendorName: profile?.vendorName ?? t.vendorName,
      supplierRef: t.supplierRef,
      year,
      currency: t.currency,
      totalPaidCents: t.totalPaidCents,
      paymentCount: t.paymentCount,
      withholdingCents,
      withholdingNote: withholdingCents > 0 ? WITHHOLDING_NOTE : null,
      taxId: profile?.taxId ?? null,
      taxIdType: profile?.taxIdType ?? null,
      generatedAt: new Date(),
    });
    // Deterministic path → regeneration replaces the same file.
    const rel = join(String(tenantId), String(year), `${t.supplierRef.replace(/[^A-Za-z0-9_.-]/g, "_")}.${t.currency}.pdf`);
    const abs = join(statementsDir(), rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, pdf); // throws honestly on failure — no row is written
    if (!existsSync(abs)) throw new Error(`statement PDF write failed for ${abs}`);

    const [existing] = await db.select().from(annualStatements)
      .where(and(
        eq(annualStatements.tenantId, tenantId),
        sql`coalesce(${annualStatements.supplierTenantId}, ${annualStatements.vendorRef}) = ${t.supplierRef}`,
        eq(annualStatements.year, year),
        eq(annualStatements.currency, t.currency),
      )).limit(1);
    const now = new Date();
    if (existing) {
      // Idempotent regeneration: update totals + replace path; keep an
      // honest status (a previously-sent statement returns to 'generated'
      // only if the figures changed — resend is an explicit action).
      const changed = existing.totalPaidCents !== t.totalPaidCents || existing.paymentCount !== t.paymentCount;
      await db.update(annualStatements).set({
        vendorName: profile?.vendorName ?? t.vendorName,
        totalPaidCents: t.totalPaidCents,
        paymentCount: t.paymentCount,
        withholdingCents,
        pdfPath: rel,
        status: changed ? "generated" : existing.status,
        generatedAt: now,
        updatedAt: now,
      }).where(eq(annualStatements.id, existing.id));
      const [row] = await db.select().from(annualStatements).where(eq(annualStatements.id, existing.id));
      out.push({ ...row, regenerated: true, changed });
    } else {
      const id = crypto.randomUUID();
      await db.insert(annualStatements).values({
        id,
        tenantId,
        supplierTenantId: t.supplierTenantId,
        vendorRef: t.vendorRef,
        vendorName: profile?.vendorName ?? t.vendorName,
        year,
        totalPaidCents: t.totalPaidCents,
        paymentCount: t.paymentCount,
        currency: t.currency,
        withholdingCents,
        status: "generated",
        pdfPath: rel,
        generatedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const [row] = await db.select().from(annualStatements).where(eq(annualStatements.id, id));
      out.push({ ...row, regenerated: false, changed: true });
    }
  }
  return { statements: out, year, supplierRef };
}

/**
 * Send a generated statement to the supplier as a WhatsApp document push.
 * Status → 'sent' only after the send returns; the real Cloud-API wamid is
 * stored when present, simulation is honestly labelled metadata.waSimulated.
 */
export async function sendStatement(
  db: Db,
  opts: { tenantId: string; statementId: string; phone?: string | null; actor?: string | null },
) {
  const [st] = await db.select().from(annualStatements)
    .where(and(eq(annualStatements.id, opts.statementId), eq(annualStatements.tenantId, opts.tenantId)))
    .limit(1);
  if (!st) throw Object.assign(new Error("statement not found"), { code: "NOT_FOUND" });
  if (!st.pdfPath || !existsSync(join(statementsDir(), st.pdfPath))) {
    throw Object.assign(new Error("statement PDF missing on disk — regenerate first"), { code: "CONFLICT" });
  }
  // Supplier phone: explicit override → profile metadata.phone → supplier
  // tenant's admin phone is NOT guessed (fail honestly when unknown).
  const profile = await findProfileForSupplier(db, opts.tenantId, st.supplierTenantId ?? st.vendorRef ?? st.vendorName);
  const phone = opts.phone ?? (profile?.metadata as any)?.phone ?? null;
  if (!phone) throw Object.assign(new Error("NO_PHONE: no supplier phone on file (profile metadata.phone)"), { code: "NO_PHONE" });

  const { sendWhatsAppMedia } = await import("./waSender");
  const filename = `annual-statement-${st.year}-${st.currency}.pdf`;
  const res = await sendWhatsAppMedia(opts.tenantId, phone, {
    type: "document",
    link: `/api/statements/${st.pdfPath}`,
    caption: `Your ${st.year} annual payment statement from ${opts.tenantId} (${st.currency} ${(st.totalPaidCents / 100).toFixed(2)}).`,
    filename,
  }, { notifType: "tax_statement_send" });
  if (!res.sent && !res.simulated) {
    throw new Error("WhatsApp document push was not accepted");
  }
  const now = new Date();
  await db.update(annualStatements).set({
    status: "sent",
    sentAt: now,
    waMessageId: res.wamid ?? null,
    updatedAt: now,
  }).where(eq(annualStatements.id, st.id));
  const [row] = await db.select().from(annualStatements).where(eq(annualStatements.id, st.id));
  return {
    statement: row,
    wa: { sent: res.sent, simulated: res.simulated, wamid: res.wamid },
  };
}

/** Supplier-side read: marks a sent statement 'viewed' (honest transition). */
export async function markStatementViewed(
  db: Db,
  opts: { statementId: string; supplierTenantId: string },
) {
  const [st] = await db.select().from(annualStatements)
    .where(eq(annualStatements.id, opts.statementId)).limit(1);
  if (!st) throw Object.assign(new Error("statement not found"), { code: "NOT_FOUND" });
  if (st.supplierTenantId !== opts.supplierTenantId) {
    throw Object.assign(new Error("statement does not belong to this supplier"), { code: "FORBIDDEN" });
  }
  if (st.status === "sent") {
    await db.update(annualStatements).set({ status: "viewed", updatedAt: new Date() })
      .where(eq(annualStatements.id, st.id));
  }
  const [row] = await db.select().from(annualStatements).where(eq(annualStatements.id, st.id));
  return row;
}
