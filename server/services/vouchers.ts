/**
 * server/services/vouchers.ts — W27 government / NGO voucher rails.
 *
 * FROZEN CONTRACTS (Wave 27 spec §Interface contracts):
 *   issueVouchers({programId, recipients, amountCents, currency})
 *   redeemVoucher(code, orderId)
 * (db is an additional first parameter, matching repo service conventions;
 *  option bags carry the rest of the frozen shape.)
 *
 * Flow: an issuer (government agency / NGO) creates a program with a budget,
 * eligibility lists (phones, product categories) and an expiry. Vouchers are
 * issued to recipients with deterministic HMAC-derived codes (no randomness),
 * then redeemed at checkout: eligibility + category restrictions are
 * validated, the voucher is claimed transactionally (status flip guarded by
 * `status='issued'` + the global unique code constraint) so double redemption
 * is impossible, and the program's redeemedCents counter is moved in the same
 * transaction. `issuerReport` produces the settlement / reconciliation view
 * (portal table + CSV export).
 *
 * ALL money is INTEGER CENTS.
 */
import crypto from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { ENV } from "../_core/env";
import { voucherPrograms, vouchers } from "../../drizzle/schema";

export type Db = any;

export class VoucherError extends Error {
  code: "NOT_FOUND" | "INELIGIBLE" | "CATEGORY" | "EXPIRED" | "REDEEMED" | "BUDGET" | "INACTIVE" | "BAD_INPUT";
  constructor(code: VoucherError["code"], message: string) {
    super(message);
    this.name = "VoucherError";
    this.code = code;
  }
}

// ── Pure helpers (unit-tested hermetically) ─────────────────────────────────

/** Deterministic voucher code: HMAC of (program, phone, sequence). */
export function voucherCode(programId: string, phone: string, seq: number): string {
  return crypto.createHmac("sha256", ENV.jwtSecret)
    .update(`voucher:${programId}:${phone}:${seq}`)
    .digest("base64url")
    .replace(/[-_]/g, "0")
    .slice(0, 16)
    .toUpperCase();
}

export function isPhoneEligible(eligiblePhones: unknown, phone: string): boolean {
  if (eligiblePhones == null) return true; // null = unrestricted
  if (!Array.isArray(eligiblePhones)) return false;
  return eligiblePhones.includes(phone);
}

/**
 * Category restriction: null/empty list = all categories allowed; otherwise
 * every purchased category must be in the eligible set.
 */
export function areCategoriesEligible(eligibleCategories: unknown, purchasedCategories: string[]): boolean {
  if (eligibleCategories == null) return true;
  if (!Array.isArray(eligibleCategories) || eligibleCategories.length === 0) return true;
  const allowed = new Set((eligibleCategories as unknown[]).map((c) => String(c).toLowerCase()));
  return purchasedCategories.every((c) => allowed.has(String(c).toLowerCase()));
}

// ── Programs ────────────────────────────────────────────────────────────────

export async function createProgram(db: Db, input: {
  tenantId: string; issuer: string; name: string; budgetCents: number; currency?: string;
  eligiblePhones?: string[] | null; eligibleCategories?: string[] | null; expiresAt?: Date | null;
}) {
  if (!Number.isInteger(input.budgetCents) || input.budgetCents <= 0) {
    throw new VoucherError("BAD_INPUT", "budgetCents must be a positive integer");
  }
  const [program] = await db.insert(voucherPrograms).values({
    tenantId: input.tenantId, issuer: input.issuer, name: input.name,
    budgetCents: input.budgetCents, currency: input.currency ?? "NGN",
    eligiblePhones: (input.eligiblePhones ?? null) as any,
    eligibleCategories: (input.eligibleCategories ?? null) as any,
    expiresAt: input.expiresAt ?? null,
  }).returning();
  return program;
}

// ── FROZEN CONTRACT: issueVouchers ──────────────────────────────────────────

/**
 * Issue one voucher per recipient. Budget-checked (issued + new ≤ budget).
 * Partially atomic per call: the whole batch runs in one transaction when the
 * driver supports it. Returns the issued voucher rows with their codes.
 */
export async function issueVouchers(db: Db, input: {
  programId: string;
  recipients: string[];
  amountCents: number;
  currency?: string;
}) {
  const { programId, recipients, amountCents } = input;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new VoucherError("BAD_INPUT", "amountCents must be a positive integer");
  }
  if (recipients.length === 0) throw new VoucherError("BAD_INPUT", "recipients required");
  for (const phone of recipients) {
    if (!/^\+?\d{7,15}$/.test(phone)) throw new VoucherError("BAD_INPUT", `invalid recipient phone: ${phone}`);
  }

  const apply = async (tx: Db) => {
    // W30 (V3#10): lock the program row FOR UPDATE so the budget check +
    // issuedCents decrement serialize against concurrent issuances (the
    // read-then-check below raced under READ COMMITTED).
    const locked = await tx.execute(
      sql`SELECT * FROM voucher_programs WHERE id = ${programId} FOR UPDATE`,
    ).catch(() => null);
    const program = ((locked as unknown as Record<string, unknown>[])?.[0] as any)
      ?? (await tx.select().from(voucherPrograms).where(eq(voucherPrograms.id, programId)).limit(1))[0];
    if (!program) throw new VoucherError("NOT_FOUND", "program not found");
    // Normalize raw-row snake_case when the FOR UPDATE path was used.
    if (program.issued_cents != null && program.issuedCents == null) {
      program.issuedCents = Number(program.issued_cents);
      program.budgetCents = Number(program.budget_cents);
      program.tenantId = program.tenant_id;
      program.eligiblePhones = program.eligible_phones;
      program.eligibleCategories = program.eligible_categories;
      program.expiresAt = program.expires_at;
    }
    if (program.status !== "active") throw new VoucherError("INACTIVE", `program is ${program.status}`);
    const currency = input.currency ?? program.currency;
    if (currency !== program.currency) throw new VoucherError("BAD_INPUT", "currency mismatch with program");

    const eligible = recipients.filter((p) => isPhoneEligible(program.eligiblePhones, p));
    const skipped = recipients.filter((p) => !isPhoneEligible(program.eligiblePhones, p));
    const totalCents = eligible.length * amountCents;
    if (program.issuedCents + totalCents > program.budgetCents) {
      throw new VoucherError("BUDGET", "issuance exceeds program budget");
    }

    // Deterministic sequence: count of vouchers already issued in the program.
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(vouchers).where(eq(vouchers.programId, programId));
    const issued: any[] = [];
    for (let i = 0; i < eligible.length; i++) {
      const phone = eligible[i];
      const code = voucherCode(programId, phone, count + i);
      const [row] = await tx.insert(vouchers).values({
        tenantId: program.tenantId, programId, code, recipientPhone: phone,
        amountCents, currency, expiresAt: program.expiresAt,
      }).returning();
      issued.push(row);
    }
    if (issued.length > 0) {
      await tx.update(voucherPrograms).set({
        issuedCents: sql`${voucherPrograms.issuedCents} + ${totalCents}`,
        updatedAt: new Date(),
      }).where(eq(voucherPrograms.id, programId));
    }
    return { issued, skipped };
  };
  if (db.transaction) return db.transaction(apply);
  return apply(db);
}

// ── FROZEN CONTRACT: redeemVoucher ──────────────────────────────────────────

/**
 * Redeem a voucher against an order. Validates: voucher exists + issued +
 * unexpired; program active; recipient phone matches the buyer; program
 * eligibility (phones + purchased categories). The claim is transactional —
 * `UPDATE … WHERE status='issued'` returns a row for exactly one caller, so
 * concurrent/duplicate redeems throw VoucherError('REDEEMED').
 */
export async function redeemVoucher(db: Db, code: string, orderId: string, opts: {
  phone: string;
  purchasedCategories?: string[];
  now?: Date;
}) {
  const now = opts.now ?? new Date();
  const apply = async (tx: Db) => {
    const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.code, code.trim().toUpperCase())).limit(1);
    if (!voucher) throw new VoucherError("NOT_FOUND", "voucher not found");
    if (voucher.status !== "issued") throw new VoucherError("REDEEMED", `voucher already ${voucher.status}`);
    if (voucher.expiresAt && new Date(voucher.expiresAt).getTime() < now.getTime()) {
      throw new VoucherError("EXPIRED", "voucher expired");
    }
    const [program] = await tx.select().from(voucherPrograms).where(eq(voucherPrograms.id, voucher.programId)).limit(1);
    if (!program || program.status !== "active") throw new VoucherError("INACTIVE", "program is not active");
    if (voucher.recipientPhone !== opts.phone || !isPhoneEligible(program.eligiblePhones, opts.phone)) {
      throw new VoucherError("INELIGIBLE", "phone is not an eligible recipient");
    }
    if (!areCategoriesEligible(program.eligibleCategories, opts.purchasedCategories ?? [])) {
      throw new VoucherError("CATEGORY", "order contains items outside the program's eligible categories");
    }

    // Transactional claim: only the first concurrent writer flips the row.
    const [claimed] = await tx.update(vouchers).set({
      status: "redeemed", orderId, redeemedAt: now,
    }).where(and(eq(vouchers.id, voucher.id), eq(vouchers.status, "issued"))).returning();
    if (!claimed) throw new VoucherError("REDEEMED", "voucher was just redeemed");

    await tx.update(voucherPrograms).set({
      redeemedCents: sql`${voucherPrograms.redeemedCents} + ${voucher.amountCents}`,
      updatedAt: new Date(),
    }).where(eq(voucherPrograms.id, program.id));
    const [programAfter] = await tx.select().from(voucherPrograms).where(eq(voucherPrograms.id, program.id)).limit(1);
    return { voucher: claimed, program: programAfter };
  };
  if (db.transaction) return db.transaction(apply);
  return apply(db);
}

// ── Settlement / reconciliation ─────────────────────────────────────────────

export interface IssuerReportRow {
  code: string;
  recipientPhone: string;
  amountCents: number;
  currency: string;
  status: string;
  orderId: string | null;
  issuedAt: string;
  redeemedAt: string | null;
}

export interface IssuerReport {
  programId: string;
  issuer: string;
  name: string;
  currency: string;
  budgetCents: number;
  issuedCents: number;
  redeemedCents: number;
  outstandingCents: number; // issued but not redeemed
  remainingBudgetCents: number;
  voucherCount: number;
  redeemedCount: number;
  rows: IssuerReportRow[];
}

export async function issuerReport(db: Db, tenantId: string, programId: string): Promise<IssuerReport> {
  const [program] = await db.select().from(voucherPrograms).where(and(
    eq(voucherPrograms.id, programId), eq(voucherPrograms.tenantId, tenantId),
  )).limit(1);
  if (!program) throw new VoucherError("NOT_FOUND", "program not found");
  const rows = await db.select().from(vouchers)
    .where(eq(vouchers.programId, programId))
    .orderBy(desc(vouchers.issuedAt));
  const reportRows: IssuerReportRow[] = rows.map((v: any) => ({
    code: v.code, recipientPhone: v.recipientPhone, amountCents: v.amountCents,
    currency: v.currency, status: v.status, orderId: v.orderId ?? null,
    issuedAt: new Date(v.issuedAt).toISOString(),
    redeemedAt: v.redeemedAt ? new Date(v.redeemedAt).toISOString() : null,
  }));
  const redeemedCount = reportRows.filter((r) => r.status === "redeemed").length;
  return {
    programId: program.id, issuer: program.issuer, name: program.name, currency: program.currency,
    budgetCents: program.budgetCents, issuedCents: program.issuedCents,
    redeemedCents: program.redeemedCents,
    outstandingCents: program.issuedCents - program.redeemedCents,
    remainingBudgetCents: program.budgetCents - program.issuedCents,
    voucherCount: reportRows.length, redeemedCount,
    rows: reportRows,
  };
}

/** CSV export of the issuer settlement report (deterministic column order). */
export function issuerReportCsv(report: IssuerReport): string {
  const header = "code,recipient_phone,amount_cents,currency,status,order_id,issued_at,redeemed_at";
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = report.rows.map((r) => [
    r.code, esc(r.recipientPhone), String(r.amountCents), r.currency, r.status,
    r.orderId ?? "", r.issuedAt, r.redeemedAt ?? "",
  ].join(","));
  return [
    `# issuer=${esc(report.issuer)} program=${esc(report.name)} budget_cents=${report.budgetCents} issued_cents=${report.issuedCents} redeemed_cents=${report.redeemedCents} outstanding_cents=${report.outstandingCents}`,
    header,
    ...lines,
  ].join("\n");
}

export async function listPrograms(db: Db, tenantId: string) {
  return db.select().from(voucherPrograms).where(eq(voucherPrograms.tenantId, tenantId))
    .orderBy(desc(voucherPrograms.createdAt));
}

/** Public, phone-scoped view: vouchers issued to a recipient. */
export async function vouchersForPhone(db: Db, tenantId: string, phone: string) {
  return db.select().from(vouchers).where(and(
    eq(vouchers.tenantId, tenantId), eq(vouchers.recipientPhone, phone),
  )).orderBy(desc(vouchers.issuedAt));
}
