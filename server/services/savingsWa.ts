/**
 * server/services/savingsWa.ts — W27 (Coder G) WhatsApp keyword flows for
 * stokvel circles, micro-insurance and vouchers.
 *
 * Wired into handleConversationalInbound (useCases.ts, banner-marked): a
 * keyword match returns a reply; anything else falls through to the existing
 * menu / NLP pipeline unchanged.
 *
 * Commands (English, case-insensitive):
 *   stokvel                       → my circles + rotation position
 *   stokvel contribute <id>       → record this cycle's contribution
 *   insure                        → insurance add-ons available at checkout
 *   insure <productId>            → quote + bind against my latest order
 *   voucher <code>                → voucher status for this phone
 *   voucher redeem <code>         → redeem against my latest open order
 *
 * Money is displayed in major units but stored/tracked in integer cents.
 */
import { and, desc, eq, or } from "drizzle-orm";
import { orders, stokvelCircles, stokvelMembers } from "../../drizzle/schema";
import * as stokvel from "./stokvel";
import * as insurance from "./insurance";
import * as vouchers from "./vouchers";

export type Db = any;

export interface SavingsOutcome {
  handled: true;
  reply: string;
}

function fmtMajor(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

async function latestOrderForPhone(db: Db, tenantId: string, phone: string) {
  const [order] = await db.select().from(orders).where(and(
    eq(orders.tenantId, tenantId),
    or(eq(orders.customerId, phone), eq(orders.customerId, phone.replace(/^\+/, ""))),
  )).orderBy(desc(orders.createdAt)).limit(1).catch(() => []);
  return order ?? null;
}

async function stokvelStatusReply(db: Db, tenantId: string, phone: string): Promise<string> {
  const memberships = await db.select().from(stokvelMembers).where(and(
    eq(stokvelMembers.tenantId, tenantId), eq(stokvelMembers.phone, phone),
  ));
  if (memberships.length === 0) {
    return "You are not in any savings circle yet. Ask your group admin to add your phone, then reply 'stokvel' to see your circle.";
  }
  const lines: string[] = ["🤝 Your savings circles:"];
  for (const m of memberships) {
    const [circle] = await db.select().from(stokvelCircles).where(eq(stokvelCircles.id, m.circleId)).limit(1);
    if (!circle) continue;
    const members = await db.select().from(stokvelMembers).where(eq(stokvelMembers.circleId, circle.id));
    const active = members.filter((x: any) => x.status === "active");
    const nextPos = stokvel.payoutPositionForCycle(active.length, circle.rotationIndex);
    const isNext = m.rotationPosition === nextPos && circle.status === "active";
    lines.push(
      `• ${circle.name} (${circle.id.slice(0, 8)}) — ${fmtMajor(circle.contributionAmountCents, circle.currency)}/${circle.frequency}, ` +
      `cycle ${circle.currentCycle}, status ${circle.status}${isNext ? " — 🎉 YOU receive this cycle's payout" : ""}`,
    );
  }
  lines.push("Reply 'stokvel contribute <circle id prefix>' to pay this cycle's contribution.");
  return lines.join("\n");
}

async function stokvelContributeReply(db: Db, tenantId: string, phone: string, idPrefix: string, paymentRef?: string): Promise<string> {
  const memberships = await db.select().from(stokvelMembers).where(and(
    eq(stokvelMembers.tenantId, tenantId), eq(stokvelMembers.phone, phone),
  ));
  const match = memberships.find((m: any) => m.circleId.startsWith(idPrefix));
  if (!match) return `No circle matching "${idPrefix}" found for your number. Reply 'stokvel' to list your circles.`;
  try {
    const res = await stokvel.recordContribution(db, {
      tenantId, circleId: match.circleId, phone, paymentRef,
    });
    const amount = fmtMajor(res.contribution.amountCents, "NGN");
    if (res.alreadyPaid) return `✅ Your ${amount} contribution for this cycle was already recorded. Thank you!`;
    // W30 (V1#1): honest copy — a contribution only counts once its payment
    // is VERIFIED; a payout is only announced once the wallet credit landed.
    if (res.pending) {
      return (
        `⏳ Your ${amount} contribution is recorded as PENDING — it is not paid yet. ` +
        `Pay through the shop's payment link, then reply 'stokvel contribute ${match.circleId.slice(0, 8)} <payment reference>' ` +
        `so we can verify and record it.`
      );
    }
    if (res.payout) {
      if (res.payout.status === "paid") {
        return `✅ Contribution of ${amount} verified and received — the cycle is complete! ` +
          `🎉 Payout of ${fmtMajor(res.payout.amountCents, "NGN")} has been credited to ${res.payout.phone}'s wallet.` +
          (res.circleComplete ? " The circle has completed a full rotation." : "");
      }
      return `✅ Contribution of ${amount} verified and received — the cycle is complete! ` +
        `⏳ The payout of ${fmtMajor(res.payout.amountCents, "NGN")} for ${res.payout.phone} is pending wallet credit and will be retried automatically.`;
    }
    return `✅ Contribution of ${amount} verified and received. Waiting on the other members to complete this cycle.`;
  } catch (e: any) {
    return `⚠️ Could not record your contribution: ${e?.message ?? e}`;
  }
}

async function insureMenuReply(db: Db, tenantId: string): Promise<string> {
  const products = await insurance.listProducts(db, tenantId, true);
  if (products.length === 0) return "No insurance add-ons are available right now.";
  const lines = ["🛡️ Protect your order (add-on at checkout):"];
  for (const p of products) {
    lines.push(`• ${p.name} [${p.id}] — from ${fmtMajor(Math.max(p.flatPremiumCents, 0), "NGN")}, covers up to ${fmtMajor(p.coverageCents, "NGN")}`);
  }
  lines.push("Reply 'insure <product id>' to add cover to your latest order.");
  return lines.join("\n");
}

async function insureBindReply(db: Db, tenantId: string, phone: string, productId: string): Promise<string> {
  const order = await latestOrderForPhone(db, tenantId, phone);
  if (!order) return "You need an order first — place an order, then reply 'insure <product id>'.";
  const orderCents = Math.round(parseFloat(order.totalAmount) * 100);
  try {
    const quote = await insurance.quoteForOrder(db, {
      tenantId, productId, orderId: order.id, holderPhone: phone, orderAmountCents: orderCents, currency: order.currency ?? "NGN",
    });
    const { policy } = await insurance.bindQuote(db, { tenantId, quoteId: quote.id });
    return (
      `🛡️ Policy confirmed!\n` +
      `Policy ${policy.policyNumber}\n` +
      `Premium: ${fmtMajor(policy.premiumCents, policy.currency)} (added to order ${order.orderNumber})\n` +
      `Cover: up to ${fmtMajor(policy.coverageCents, policy.currency)}.\n` +
      `If your delivery fails, a claim is filed automatically and paid out once approved by the insurer.`
    );
  } catch (e: any) {
    return `⚠️ Could not add insurance: ${e?.message ?? e}`;
  }
}

async function voucherStatusReply(db: Db, tenantId: string, phone: string, code: string): Promise<string> {
  const mine = await vouchers.vouchersForPhone(db, tenantId, phone);
  const v = mine.find((x: any) => x.code === code.trim().toUpperCase());
  if (!v) return "Voucher not found for your number. Check the code and try again.";
  const exp = v.expiresAt ? `, expires ${new Date(v.expiresAt).toISOString().slice(0, 10)}` : "";
  return `🎟️ Voucher ${v.code}: ${fmtMajor(v.amountCents, v.currency)} — status ${v.status}${exp}.` +
    (v.status === "issued" ? " Reply 'voucher redeem " + v.code + "' to apply it to your latest order." : "");
}

async function voucherRedeemReply(db: Db, tenantId: string, phone: string, code: string): Promise<string> {
  const order = await latestOrderForPhone(db, tenantId, phone);
  if (!order) return "You need an open order to redeem a voucher — place an order first.";
  const items = Array.isArray(order.items) ? (order.items as any[]) : [];
  const categories = items.map((i: any) => String(i?.category ?? i?.name ?? "").trim()).filter(Boolean);
  try {
    const { voucher } = await vouchers.redeemVoucher(db, code, order.id, { phone, purchasedCategories: categories });
    return `🎟️ Voucher ${voucher.code} redeemed: ${fmtMajor(voucher.amountCents, voucher.currency)} applied to order ${order.orderNumber}.`;
  } catch (e: any) {
    return `⚠️ Voucher not redeemed: ${e?.message ?? e}`;
  }
}

/** Returns a handled outcome when the text matches a W27 keyword, else null. */
export async function handleSavingsInbound(opts: {
  db: Db; tenantId: string; phone: string; text: string;
}): Promise<SavingsOutcome | null> {
  const { db, tenantId, phone } = opts;
  const text = opts.text.trim();
  let m: RegExpMatchArray | null;

  if ((m = text.match(/^stokvel\s+contribute\s+([0-9a-f-]{4,36})(?:\s+(\S{4,128}))?$/i))) {
    return { handled: true, reply: await stokvelContributeReply(db, tenantId, phone, m[1], m[2]) };
  }
  if (/^(stokvel|savings|esusu|ajo|chama)\b/i.test(text)) {
    return { handled: true, reply: await stokvelStatusReply(db, tenantId, phone) };
  }
  if ((m = text.match(/^insure\s+([a-z0-9-]{2,64})$/i))) {
    return { handled: true, reply: await insureBindReply(db, tenantId, phone, m[1]) };
  }
  if (/^insure\b/i.test(text)) {
    return { handled: true, reply: await insureMenuReply(db, tenantId) };
  }
  if ((m = text.match(/^voucher\s+redeem\s+([A-Z0-9]{6,32})$/i))) {
    return { handled: true, reply: await voucherRedeemReply(db, tenantId, phone, m[1]) };
  }
  if ((m = text.match(/^voucher\s+([A-Z0-9]{6,32})$/i))) {
    return { handled: true, reply: await voucherStatusReply(db, tenantId, phone, m[1]) };
  }
  return null;
}
