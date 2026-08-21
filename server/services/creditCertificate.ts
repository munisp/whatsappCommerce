/**
 * W27 credit — portable merchant credit certificate.
 *
 * Issues a signed JSON certificate (+ printable HTML rendering) summarizing
 * the merchant's credit score, score factors, transaction history and loan
 * track record, for sharing with banks / MFIs. The signature is
 * HMAC-SHA256 over the canonical JSON payload (stable key order) with
 * CREDIT_CERT_SIGNING_SECRET; verifiers recompute it offline. Every
 * download issues an immutable merchant_credit_certificates row (audit
 * trail); certificates are never mutated.
 *
 * Deterministic: payload content is fully derived from db state + the
 * explicit `now` timestamp; no unseeded randomness; money is integer cents.
 */
import { createHmac } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  merchantCreditCertificates,
  merchantLoanRepayments,
  merchantLoans,
  orders,
  tenants,
} from "../../drizzle/schema";
import { toMinorUnitsExact } from "../../shared/escrowAmounts";
import { getMerchantScore, type MerchantScoreFactors } from "./creditScore";
import type { DbHandle } from "./tradeCredit/accounts";

export interface CertificateLoanSummary {
  loanId: string;
  tier: string;
  principalCents: number;
  feeCents: number;
  status: string;
  disbursedAt: string | null;
  repaidAt: string | null;
  repaidCents: number;
}

export interface CreditCertificatePayload {
  version: 1;
  issuer: "whatsappCommerce";
  tenantId: string;
  merchantId: string;
  merchantName: string | null;
  issuedAt: string; // ISO
  score: number;
  scoreScale: { min: 0; max: 1000 };
  factors: MerchantScoreFactors;
  history: {
    windowDays: 90;
    ordersTotal: number;
    ordersDelivered: number;
    salesVolumeCents: number;
    currency: string;
  };
  loans: CertificateLoanSummary[];
  totals: {
    loansCount: number;
    loansRepaidCount: number;
    loansDefaultedCount: number;
    principalBorrowedCents: number;
    principalRepaidCents: number;
  };
}

export interface IssuedCertificate {
  certificateId: string;
  payload: CreditCertificatePayload;
  /** Canonical JSON string that was signed. */
  canonicalJson: string;
  signature: string; // hex HMAC-SHA256
  html: string;
}

function certSecret(): string {
  const s = process.env.CREDIT_CERT_SIGNING_SECRET;
  if (s && s.trim()) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("[creditCertificate] CREDIT_CERT_SIGNING_SECRET is required in production");
  }
  return "dev-credit-cert-signing-secret";
}

/** Stable stringify: object keys sorted recursively (arrays keep order). */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}

export function signPayload(payload: CreditCertificatePayload, secret?: string): {
  canonicalJson: string; signature: string;
} {
  const canonicalJson = canonicalStringify(payload);
  const signature = createHmac("sha256", secret ?? certSecret()).update(canonicalJson).digest("hex");
  return { canonicalJson, signature };
}

/** Offline verification helper (banks/MFIs recompute with the shared secret). */
export function verifyPayload(payload: CreditCertificatePayload, signature: string, secret?: string): boolean {
  return signPayload(payload, secret).signature === signature;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] as string));
}

function fmtCents(cents: number, currency: string): string {
  const major = (cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sym: Record<string, string> = { NGN: "₦", USD: "$", GHS: "GH₵", KES: "KSh " };
  return `${sym[currency] ?? `${currency} `}${major}`;
}

/** Printable HTML rendering (save/print to PDF from the browser). */
export function renderCertificateHtml(payload: CreditCertificatePayload, signature: string, certificateId: string): string {
  const cur = payload.history.currency;
  const f = payload.factors;
  const factorRows = [
    ["Order volume", f.orderVolume.points, f.orderVolume.weight],
    ["Completion rate", f.completionRate.points, f.completionRate.weight],
    ["COD collection rate", f.codCollectionRate.points, f.codCollectionRate.weight],
    ["Payment success rate", f.paymentSuccessRate.points, f.paymentSuccessRate.weight],
    ["Refund/dispute record", f.refundDisputeRate.points, f.refundDisputeRate.weight],
    ["Tenure", f.tenure.points, f.tenure.weight],
    ["Trust score", f.trustScore.points, f.trustScore.weight],
  ]
    .map(([label, pts, w]) => `<tr><td>${label}</td><td>${pts} / ${w}</td></tr>`)
    .join("\n");
  const loanRows = payload.loans.length === 0
    ? `<tr><td colspan="5">No loans on record</td></tr>`
    : payload.loans.map((l) =>
        `<tr><td>${escapeHtml(l.loanId.slice(0, 8))}</td><td>${l.tier}</td>` +
        `<td>${fmtCents(l.principalCents, cur)}</td><td>${l.status}</td>` +
        `<td>${l.repaidAt ? escapeHtml(l.repaidAt.slice(0, 10)) : "—"}</td></tr>`,
      ).join("\n");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Merchant Credit Certificate</title>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;color:#111}
h1{font-size:1.4rem} table{border-collapse:collapse;width:100%;margin:1rem 0}
td,th{border:1px solid #ccc;padding:.4rem .6rem;text-align:left;font-size:.9rem}
.score{font-size:3rem;font-weight:700} .muted{color:#666;font-size:.8rem}
.sig{word-break:break-all;font-family:monospace;font-size:.7rem}
</style></head><body>
<h1>Merchant Credit Certificate</h1>
<p class="muted">Issued by whatsappCommerce · ${escapeHtml(payload.issuedAt)} · Certificate ${escapeHtml(certificateId)}</p>
<h2>${escapeHtml(payload.merchantName ?? payload.merchantId)}</h2>
<p class="score">${payload.score}<span class="muted"> / 1000</span></p>
<h3>Score factors (trailing ${payload.history.windowDays} days)</h3>
<table><tr><th>Factor</th><th>Points</th></tr>${factorRows}</table>
<h3>Transaction history</h3>
<table>
<tr><th>Orders</th><th>Delivered</th><th>Sales volume</th></tr>
<tr><td>${payload.history.ordersTotal}</td><td>${payload.history.ordersDelivered}</td>
<td>${fmtCents(payload.history.salesVolumeCents, cur)}</td></tr>
</table>
<h3>Loan track record</h3>
<table><tr><th>Loan</th><th>Tier</th><th>Principal</th><th>Status</th><th>Repaid</th></tr>${loanRows}</table>
<p>Borrowed ${payload.totals.loansCount} loan(s): ${fmtCents(payload.totals.principalBorrowedCents, cur)} principal,
${payload.totals.loansRepaidCount} repaid, ${payload.totals.loansDefaultedCount} defaulted.</p>
<h3>Verification</h3>
<p class="muted">HMAC-SHA256 signature over the canonical JSON payload (verify with the shared secret):</p>
<p class="sig">${signature}</p>
</body></html>`;
}

/** Issue (persist) a fresh certificate for the merchant. */
export async function issueCreditCertificateTx(
  db: DbHandle,
  tenantId: string,
  merchantId: string,
  opts?: { now?: Date; trustScore?: number | null },
): Promise<IssuedCertificate> {
  const now = opts?.now ?? new Date();
  const { score, factors } = await getMerchantScore(tenantId, merchantId, db, {
    now, trustScore: opts?.trustScore,
  });

  const [tenantRow, orderAgg, loanRows, repaymentAgg] = await Promise.all([
    db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, merchantId)).limit(1),
    db.select({
      total: sql<number>`count(*)::int`,
      delivered: sql<number>`count(*) filter (where ${orders.status} = 'delivered')::int`,
      volume: sql<string>`coalesce(sum(${orders.totalAmount}) filter (where ${orders.status} = 'delivered'), 0)`,
      currency: sql<string>`coalesce(max(${orders.currency}), 'NGN')`,
    }).from(orders).where(and(
      eq(orders.tenantId, merchantId),
      gte(orders.createdAt, new Date(now.getTime() - 90 * 24 * 3600 * 1000)),
    )),
    db.select().from(merchantLoans)
      .where(and(eq(merchantLoans.tenantId, tenantId), eq(merchantLoans.merchantId, merchantId)))
      .orderBy(desc(merchantLoans.createdAt)),
    db.select({
      loanId: merchantLoanRepayments.loanId,
      repaid: sql<string>`coalesce(sum(${merchantLoanRepayments.amountCents}), 0)`,
    }).from(merchantLoanRepayments)
      .where(eq(merchantLoanRepayments.tenantId, tenantId))
      .groupBy(merchantLoanRepayments.loanId),
  ]);

  const repaidByLoan = new Map(repaymentAgg.map((r) => [r.loanId, Number(r.repaid)]));
  const loans: CertificateLoanSummary[] = loanRows.map((l) => ({
    loanId: l.id,
    tier: l.tier,
    principalCents: l.principalCents,
    feeCents: l.feeCents,
    status: l.status,
    disbursedAt: l.disbursedAt ? l.disbursedAt.toISOString() : null,
    repaidAt: l.repaidAt ? l.repaidAt.toISOString() : null,
    repaidCents: repaidByLoan.get(l.id) ?? 0,
  }));

  const agg = orderAgg[0] ?? { total: 0, delivered: 0, volume: "0", currency: "NGN" };
  const payload: CreditCertificatePayload = {
    version: 1,
    issuer: "whatsappCommerce",
    tenantId,
    merchantId,
    merchantName: tenantRow[0]?.name ?? null,
    issuedAt: now.toISOString(),
    score,
    scoreScale: { min: 0, max: 1000 },
    factors,
    history: {
      windowDays: 90,
      ordersTotal: Number(agg.total),
      ordersDelivered: Number(agg.delivered),
      salesVolumeCents: toMinorUnitsExact(String(agg.volume) === "0" ? "0" : String(agg.volume)),
      currency: agg.currency || "NGN",
    },
    loans,
    totals: {
      loansCount: loans.length,
      loansRepaidCount: loans.filter((l) => l.status === "repaid").length,
      loansDefaultedCount: loans.filter((l) => l.status === "defaulted").length,
      principalBorrowedCents: loans.reduce((s, l) => s + l.principalCents, 0),
      principalRepaidCents: loans.reduce((s, l) => s + l.repaidCents, 0),
    },
  };

  const { canonicalJson, signature } = signPayload(payload);
  const [row] = await db
    .insert(merchantCreditCertificates)
    .values({ tenantId, merchantId, payload, signature })
    .returning();
  return {
    certificateId: row.id,
    payload,
    canonicalJson,
    signature,
    html: renderCertificateHtml(payload, signature, row.id),
  };
}
