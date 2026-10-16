// === W54 capabilities (CAP-2) ===
/**
 * ussdBalances.ts — shared READ-ONLY USSD balance queries (savings/stokvel,
 * loyalty points, consumer membership status) used by BOTH USSD entry
 * paths: the Africa's Talking orchestrator (useCases.handleUssdRequest,
 * CON/END-wrapped) and the nlp.processMessage ussdMode NLP-fallback path.
 *
 * Read paths are reused from services/stokvel.ts (payout position math),
 * services/loyalty.ts (ledger balance) and services/membershipPlans.ts
 * (CAP-1 live membership) — no writes, no money movement, so the queries
 * fail open to a friendly localized line. Session language names bridge to
 * locale codes via localeFromSessionLanguage (same as buildUssdMenu).
 */
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

function fmtMajor(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

async function savingsReply(db: Db, tenantId: string, phone: string, locale: string): Promise<string> {
  const { t27 } = await import("./i18n");
  const { stokvelCircles, stokvelMembers } = await import("../../drizzle/schema");
  const memberships = await db.select().from(stokvelMembers)
    .where(and(eq(stokvelMembers.tenantId, tenantId), eq(stokvelMembers.phone, phone)))
    .catch(() => [] as any[]);
  if (!memberships.length) return t27(locale, "ussdSavingsNone");
  const { payoutPositionForCycle } = await import("./stokvel");
  const lines: string[] = [t27(locale, "ussdSavingsHeader")];
  for (const m of memberships.slice(0, 4)) { // USSD length budget
    const [circle] = await db.select().from(stokvelCircles)
      .where(eq(stokvelCircles.id, m.circleId)).limit(1).catch(() => [] as any[]);
    if (!circle) continue;
    const members = await db.select().from(stokvelMembers)
      .where(eq(stokvelMembers.circleId, circle.id)).catch(() => [] as any[]);
    const active = members.filter((x: any) => x.status === "active");
    const nextPos = payoutPositionForCycle(active.length, circle.rotationIndex);
    const nextMember = active.find((x: any) => x.rotationPosition === nextPos);
    const nextLabel = nextMember?.phone === phone ? "YOU" : (nextMember?.phone ?? "—");
    lines.push(t27(locale, "ussdSavingsLine", {
      name: circle.name,
      amount: fmtMajor(circle.contributionAmountCents, circle.currency),
      freq: circle.frequency,
      cycle: circle.currentCycle,
      next: nextLabel,
    }));
  }
  return lines.join("\n");
}

async function loyaltyReply(db: Db, tenantId: string, phone: string, locale: string): Promise<string> {
  const { t27 } = await import("./i18n");
  const { getBalance, getLoyaltyRules } = await import("./loyalty");
  const rules = await getLoyaltyRules(db, tenantId).catch(() => null);
  if (!rules || !rules.enabled) return t27(locale, "ussdLoyaltyDisabled");
  const balance = await getBalance(db, tenantId, phone).catch(() => 0);
  return t27(locale, "ussdLoyaltyBalance", { points: balance });
}

async function membershipReply(db: Db, tenantId: string, phone: string, locale: string): Promise<string> {
  const { t27 } = await import("./i18n");
  const { getMembershipStatus } = await import("./membershipPlans");
  const status = await getMembershipStatus(db, tenantId, phone).catch(() => null);
  if (!status) return t27(locale, "membershipStatusNone");
  const { membership, plan } = status;
  const benefits = plan.discountPercent > 0 && plan.pointsMultiplier > 1
    ? t27(locale, "membershipBenefitsBoth", { discount: plan.discountPercent, mult: plan.pointsMultiplier })
    : plan.discountPercent > 0
      ? t27(locale, "membershipBenefitsDiscount", { discount: plan.discountPercent })
      : t27(locale, "membershipBenefitsPoints", { mult: plan.pointsMultiplier });
  let reply = t27(locale, "membershipStatusActive", { plan: plan.name, benefits });
  if (membership.cancelAtPeriodEnd && membership.currentPeriodEnd) {
    reply += t27(locale, "membershipStatusCancelling", { date: membership.currentPeriodEnd.toISOString().slice(0, 10) });
  } else if (membership.currentPeriodEnd) {
    reply += t27(locale, "membershipStatusUntil", { date: membership.currentPeriodEnd.toISOString().slice(0, 10) });
  }
  return reply;
}

/**
 * Localized read-only balance reply for a USSD keyword. `sessionLanguage`
 * is the nlp_sessions.language NAME (e.g. "english", "yoruba", "pidgin") or
 * already a locale code — bridged via localeFromSessionLanguage.
 */
export async function buildUssdBalanceReply(
  db: Db,
  opts: { tenantId: string; phone: string; keyword: string; sessionLanguage?: string },
): Promise<string> {
  const { localeFromSessionLanguage } = await import("./i18n");
  const locale = localeFromSessionLanguage(opts.sessionLanguage ?? "en");
  const kw = opts.keyword.trim().toLowerCase();
  const phone = opts.phone.replace(/^\+/, "");
  if (/^(savings|stokvel|esusu|ajo|chama)$/.test(kw)) {
    return savingsReply(db, opts.tenantId, phone, locale);
  }
  if (/^(loyalty|points)$/.test(kw)) {
    return loyaltyReply(db, opts.tenantId, phone, locale);
  }
  // === W55 parity (PARITY-8) === customer wallet balance (read-only,
  // services/customerWallet.walletBalance — same read path as the WA/TG/SMS
  // "wallet balance" chat keyword).
  if (/^wallet$/.test(kw)) {
    const { t27 } = await import("./i18n");
    const { customerWallets } = await import("../../drizzle/schema");
    const [row] = await db.select({ currency: customerWallets.currency })
      .from(customerWallets)
      .where(and(eq(customerWallets.tenantId, opts.tenantId), eq(customerWallets.customerPhone, phone)))
      .limit(1).catch(() => [] as any[]);
    if (!row) return t27(locale, "walletBalanceNone");
    const { walletBalance } = await import("./customerWallet");
    const cents = await walletBalance(opts.tenantId, phone, db).catch(() => 0);
    return t27(locale, "walletBalanceLine", { balance: fmtMajor(cents, row.currency) });
  }
  // === END W55 parity ===
  // membership
  return membershipReply(db, opts.tenantId, phone, locale);
}
