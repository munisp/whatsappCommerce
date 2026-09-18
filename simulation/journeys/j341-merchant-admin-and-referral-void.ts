// === W44 giftcards-referrals (Coder A) ===
/**
 * J341 — Merchant tRPC surface + referral void on refund:
 *  1. giftCards.issue/disable/adjust via tRPC (tenant-scoped) — adjust writes
 *     the 'adjust' audit row + note and audit_logs entry; negative adjust is
 *     claim-first guarded (never below 0 → CONFLICT); disable is claim-first
 *     and blocks redemption.
 *  2. Referral void: referee order PAID → rewarded; a full refund through
 *     the existing orderCrud.refund path flips the event to 'voided' with an
 *     audit row (adjacent seam — refund flow untouched otherwise).
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J341",
  name: "merchant tRPC issue/disable/adjust + referral void on refund",
  feature: "W44 merchant gift card admin + referral void seam",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const gift = await import("../../server/services/giftCards");
    const refs = await import("../../server/services/referrals");
    const caller = await adminCaller();

    // ── tRPC issue ──
    const issued = await caller.giftCards.issue({ tenantId: TENANT_ID, amountCents: 120000, note: "promo giveaway" });
    assert(issued.code.startsWith("GC-") && issued.status === "active", "issued via tRPC");
    const listed = await caller.giftCards.list({ tenantId: TENANT_ID });
    assert(listed.some((c: any) => c.id === issued.id), "list shows the issued card");

    // ── tRPC adjust (+₦200, note required) → audit row ──
    const adj = await caller.giftCards.adjust({ tenantId: TENANT_ID, code: issued.code, deltaCents: 20000, note: "goodwill top-up" });
    assert(adj.balanceCents === 140000, `adjust applied (got ${adj.balanceCents})`);
    let txs = await caller.giftCards.transactions({ tenantId: TENANT_ID, giftCardId: issued.id });
    const adjustTx = txs.find((t: any) => t.type === "adjust" && t.amountCents === 20000);
    assert(adjustTx && String(adjustTx.note).includes("goodwill top-up"), "adjust audit row + note");
    const auditRows = (await world.db.execute(
      `SELECT action FROM audit_logs WHERE tenant_id = '${TENANT_ID}' AND entity_id = '${issued.id}' ORDER BY created_at DESC`,
    )) as any;
    const audits: any[] = Array.isArray(auditRows) ? auditRows : (auditRows?.rows ?? []);
    assert(audits.some((a) => a.action === "gift_card.adjusted") && audits.some((a) => a.action === "gift_card.issued"),
      `audit_logs entries written (got ${JSON.stringify(audits.map((a) => a.action))})`);

    // Negative adjust beyond balance → CONFLICT, no money moved.
    let conflicted = false;
    try {
      await caller.giftCards.adjust({ tenantId: TENANT_ID, code: issued.code, deltaCents: -99999999, note: "overdraw attempt" });
    } catch (e: any) {
      conflicted = true;
      assert(String(e?.message).includes("insufficient_funds"), "honest insufficient_funds");
    }
    assert(conflicted, "overdraw adjust refused");
    let fresh = await gift.getGiftCardByCode(TENANT_ID, issued.code);
    assert(fresh!.balanceCents === 140000, "failed adjust moved no money");

    // ── tRPC disable blocks redemption; double disable CONFLICTs ──
    await caller.giftCards.disable({ tenantId: TENANT_ID, code: issued.code });
    fresh = await gift.getGiftCardByCode(TENANT_ID, issued.code);
    assert(fresh!.status === "disabled", "disabled via tRPC");
    const redeemBlocked = await gift.redeemGiftCard(TENANT_ID, issued.code, 1000, { idempotencyKey: "redeem:j341:blocked" });
    assert(!redeemBlocked.ok && redeemBlocked.error === "gift_card_disabled", "disabled card cannot redeem");
    let doubleDisable = false;
    try {
      await caller.giftCards.disable({ tenantId: TENANT_ID, code: issued.code });
    } catch { doubleDisable = true; }
    assert(doubleDisable, "second disable CONFLICTs");

    // ── Referral void on refund ──
    await caller.referrals.setRewardCents({ tenantId: TENANT_ID, rewardCents: 25000 });
    const referrer = world.newPhone("j341r");
    const referee = world.newPhone("j341e");
    await world.grantConsent(referee);
    const codeRow = await refs.getOrCreateReferralCode(TENANT_ID, referrer);
    const attr = await refs.attributeReferral(TENANT_ID, { code: codeRow.code, refereeCustomerId: referee });
    assert(attr.ok, "attributed");

    const order = await createChatOrderViaNlp(world, referee, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: 2500 });
    await world.waitFor(async () => {
      const [ev] = await world.db.select().from(schema.referralEvents)
        .where(and(eq(schema.referralEvents.tenantId, TENANT_ID), eq(schema.referralEvents.refereeCustomerId, referee)));
      return ev?.status === "rewarded";
    }, 10000, "rewarded before refund");

    // Full refund through the EXISTING orderCrud path → event voided + audit.
    const refund = await caller.orderCrud.refund({ orderId: order.orderId, amount: 2500, reason: "customer changed mind" });
    assert(refund.ok, "refund initiated");
    await world.waitFor(async () => {
      const [ev] = await world.db.select().from(schema.referralEvents)
        .where(eq(schema.referralEvents.refereeCustomerId, referee));
      return ev?.status === "voided";
    }, 10000, "referral event voided on refund");
    const voidAudits = (await world.db.execute(
      `SELECT action FROM audit_logs WHERE tenant_id = '${TENANT_ID}' AND action = 'referral.voided'`,
    )) as any;
    const va: any[] = Array.isArray(voidAudits) ? voidAudits : (voidAudits?.rows ?? []);
    assert(va.length >= 1, "void audit row written");

    // Voided referee can never be re-attributed and rewarded silently — a new
    // attribution attempt returns a fresh event honestly (voided is excluded
    // from the partial unique), but first-order semantics now block it (the
    // refunded order was PAID before).
    const again = await refs.attributeReferral(TENANT_ID, { code: codeRow.code, refereeCustomerId: referee });
    assert(!again.ok && again.error === "referee_not_first_order", "refunded referee is not a fresh first-order referee");
  },
};
