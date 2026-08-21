/**
 * W27 credit — WhatsApp merchant credit flow.
 *
 * Merchant (tenant admin phone) chats with the platform number:
 *   "CREDIT" / "CREDIT SCORE"  → score + factor highlights + top offer
 *   "CREDIT OFFERS"            → offer details (amount, fee, term, pct)
 *   "CREDIT ACCEPT [amount]"   → accept an offer (amount in major units,
 *                                e.g. "CREDIT ACCEPT 50000"; omitted → max)
 *   "CREDIT STATUS"            → outstanding balance + repayment rule
 *
 * Security: only the tenant's configured admin phone (settings.adminPhone /
 * settings.whatsapp.adminPhone / settings.notifications.adminPhone — same
 * resolution as chatDispute) may run credit commands; anything else returns
 * handled=false and falls through to the normal menu/NLP pipeline.
 * Money is integer cents internally; chat amounts are major units.
 */
import { eq } from "drizzle-orm";
import { tenants } from "../../drizzle/schema";
import { getMerchantScore } from "./creditScore";
import {
  acceptLoanTx,
  getLoanOffersTx,
  listLoansTx,
  MIN_LOAN_CENTS,
} from "./tradeCredit/microLoans";
import type { DbHandle } from "./tradeCredit/accounts";

export interface CreditCommandOutcome {
  handled: boolean;
  reply?: string;
}

function fmtMajor(cents: number, currency = "NGN"): string {
  const sym: Record<string, string> = { NGN: "₦", USD: "$", GHS: "GH₵", KES: "KSh " };
  return `${sym[currency] ?? `${currency} `}${(cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Same admin-phone resolution chain as services/chatDispute.ts. */
export function resolveAdminPhone(settings: Record<string, unknown> | null): string | null {
  const s = settings ?? {};
  const cand =
    (s as any)?.adminPhone ??
    (s as any)?.whatsapp?.adminPhone ??
    (s as any)?.notifications?.adminPhone;
  return typeof cand === "string" && cand.trim() ? cand.trim() : null;
}

function normPhone(p: string): string {
  return p.replace(/[^\d]/g, "").replace(/^0+/, "");
}

export function parseCreditCommand(text: string):
  | { cmd: "score" | "offers" | "status" }
  | { cmd: "accept"; amountMajor: number | null }
  | null {
  const m = text.trim().match(/^CREDIT(?:\s+(SCORE|OFFERS|STATUS|ACCEPT))?(?:\s+(\d+(?:\.\d{1,2})?))?\s*$/i);
  if (!m) return null;
  const sub = (m[1] ?? "SCORE").toUpperCase();
  if (sub === "ACCEPT") {
    return { cmd: "accept", amountMajor: m[2] ? Number(m[2]) : null };
  }
  return { cmd: sub.toLowerCase() as "score" | "offers" | "status" };
}

export async function handleCreditCommand(opts: {
  db: DbHandle;
  tenantId: string;
  waPhoneNumber: string;
  text: string;
}): Promise<CreditCommandOutcome> {
  const parsed = parseCreditCommand(opts.text);
  if (!parsed) return { handled: false };

  const [tenant] = await opts.db
    .select({ settings: tenants.settings, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, opts.tenantId))
    .limit(1);
  const adminPhone = resolveAdminPhone((tenant?.settings ?? null) as Record<string, unknown> | null);
  if (!adminPhone || normPhone(adminPhone) !== normPhone(opts.waPhoneNumber)) {
    // Not the merchant — let the normal buyer pipeline handle the text.
    return { handled: false };
  }

  const tenantId = opts.tenantId;
  const merchantId = tenantId; // first-party merchant self-service

  if (parsed.cmd === "score") {
    const { score, factors } = await getMerchantScore(tenantId, merchantId, opts.db);
    const lines = [
      `📊 *Your credit score: ${score}/1000*`,
      ``,
      `• Order volume: ${factors.orderVolume.points}/${factors.orderVolume.weight} (${factors.orderVolume.completedOrders} completed orders)`,
      `• Completion rate: ${factors.completionRate.points}/${factors.completionRate.weight}`,
      `• COD collection: ${factors.codCollectionRate.points}/${factors.codCollectionRate.weight}`,
      `• Payment success: ${factors.paymentSuccessRate.points}/${factors.paymentSuccessRate.weight}`,
      `• Refund/dispute record: ${factors.refundDisputeRate.points}/${factors.refundDisputeRate.weight}`,
      `• Tenure: ${factors.tenure.points}/${factors.tenure.weight} (${factors.tenure.days} days)`,
      ``,
      `Reply CREDIT OFFERS to see loan offers, CREDIT STATUS for your balance.`,
    ];
    return { handled: true, reply: lines.join("\n") };
  }

  if (parsed.cmd === "offers" || parsed.cmd === "accept") {
    const res = await getLoanOffersTx(opts.db, tenantId, merchantId);
    if (parsed.cmd === "offers") {
      if (res.offers.length === 0) {
        const why = res.blockedReason === "existing_loan"
          ? "you already have an active loan — reply CREDIT STATUS."
          : res.blockedReason === "score_below_minimum"
            ? `your score (${res.score}) is below the minimum 400 — keep selling to build it up!`
            : "your recent sales volume is too low for an offer yet.";
        return { handled: true, reply: `No loan offers right now: ${why}` };
      }
      const o = res.offers[0];
      return {
        handled: true,
        reply: [
          `💰 *Loan offer (tier ${o.tier})* — score ${res.score}`,
          `Up to ${fmtMajor(o.maxPrincipalCents)} working capital`,
          `Fee ${o.feePct}% · ${o.termDays}-day term · ${o.repaymentPct}% of each sale auto-repays it.`,
          ``,
          `Reply CREDIT ACCEPT for the full amount, or CREDIT ACCEPT 50000 for a smaller amount.`,
        ].join("\n"),
      };
    }
    // accept
    const offer = res.offers[0];
    if (!offer) {
      const why = res.blockedReason === "existing_loan"
        ? "You already have an active loan. Reply CREDIT STATUS to see it."
        : "No loan offer is available right now. Reply CREDIT SCORE to see why.";
      return { handled: true, reply: why };
    }
    let principalCents = offer.maxPrincipalCents;
    if (parsed.cmd === "accept" && parsed.amountMajor != null) {
      principalCents = Math.round(parsed.amountMajor * 100);
    }
    const accepted = await acceptLoanTx(opts.db, { tenantId, merchantId, principalCents });
    if (!accepted.ok) {
      if (accepted.reason === "principal_exceeds_offer") {
        return {
          handled: true,
          reply: `That amount isn't available. You can borrow between ${fmtMajor(MIN_LOAN_CENTS)} and ${fmtMajor(offer.maxPrincipalCents)}.`,
        };
      }
      return { handled: true, reply: `Loan not accepted (${accepted.reason}). Reply CREDIT OFFERS to retry.` };
    }
    return {
      handled: true,
      reply: [
        `✅ *Loan disbursed!* ${fmtMajor(accepted.loan.principalCents)} is now in your wallet.`,
        `Repayable: ${fmtMajor(accepted.loan.outstandingCents)} (incl. fee) — ${accepted.loan.repaymentPct}% of every settled sale is auto-deducted.`,
        `Due by ${accepted.loan.dueAt ? accepted.loan.dueAt.toISOString().slice(0, 10) : "—"}. Reply CREDIT STATUS anytime.`,
      ].join("\n"),
    };
  }

  // status
  const loans = await listLoansTx(opts.db, tenantId, merchantId);
  const open = loans.find((l) => l.status === "active" || l.status === "defaulted");
  if (!open) {
    const repaid = loans.filter((l) => l.status === "repaid").length;
    return {
      handled: true,
      reply: `You have no active loan.${repaid > 0 ? ` (${repaid} fully repaid — nice track record!)` : ""} Reply CREDIT OFFERS to borrow.`,
    };
  }
  return {
    handled: true,
    reply: [
      `📒 *Loan status: ${open.status.toUpperCase()}*`,
      `Outstanding: ${fmtMajor(open.outstandingCents)} of ${fmtMajor(open.principalCents + open.feeCents)}`,
      `${open.repaymentPct}% of each settled sale is auto-deducted.`,
      open.dueAt ? `Due by ${open.dueAt.toISOString().slice(0, 10)}.` : "",
    ].filter(Boolean).join("\n"),
  };
}
