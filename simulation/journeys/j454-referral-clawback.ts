// === W47 stakeholders ===
/**
 * J454 — ONB-S-13: referral refund void now CLAWS BACK the granted wallet
 * reward. Referee's first paid order → referrer credited; refund → event
 * voided AND an idempotent referral-clawback debit returns the wallet to
 * its pre-reward balance; a second refund never claws back twice.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedOrder } from "./w46-uc-docs-seed";

const T = "j454-referral";
const REFERRER = "2348040000454";
const REFEREE = "2348040001454";

export const journey: Journey = {
  id: "J454",
  name: "referral refund void claws back the wallet reward (idempotent)",
  feature: "W47 stakeholders: ONB-S-13 referral clawback",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const refs = await import("../../server/services/referrals");
    const { walletBalance } = await import("../../server/services/customerWallet");

    await world.db.insert(schema.tenants).values({
      id: T, name: "J454 Referrals", slug: T, status: "active", referralRewardCents: 25000,
    }).onConflictDoNothing();
    await world.db.update(schema.tenants).set({ referralRewardCents: 25000 })
      .where(eq(schema.tenants.id, T));

    // Referrer code + referee attribution.
    const code = await refs.getOrCreateReferralCode(T, REFERRER, world.db);
    const att = await refs.attributeReferral(T, { code: code.code, refereeCustomerId: REFEREE }, world.db);
    assert(att.ok && att.event, "referee attributed");

    // Referee's first order goes PAID → referrer credited.
    const order = await seedOrder(world, T, "454a", REFEREE, { unitPrice: "4000.00", qty: 1 });
    const reward = await refs.rewardReferralForPaidOrder(world.db, { tenantId: T, orderId: order.orderId });
    assert(reward.rewarded === true && reward.rewardCents === 25000, `reward granted (got ${JSON.stringify(reward)})`);
    const balAfterReward = await walletBalance(T, REFERRER, world.db);
    assert(balAfterReward === 25000, `referrer credited 25000 (got ${balAfterReward})`);

    // Refund → void + CLAWBACK.
    const v = await refs.voidReferralOnRefund(world.db, { tenantId: T, orderId: order.orderId, actor: "j454" });
    assert(v.voided === 1, "event voided");
    const balAfterVoid = await walletBalance(T, REFERRER, world.db);
    assert(balAfterVoid === 0, `reward clawed back (balance ${balAfterVoid})`);
    const [event] = await world.db.select().from(schema.referralEvents)
      .where(eq(schema.referralEvents.id, att.event!.id));
    assert(event.status === "voided", "event status voided");

    // Clawback ledger row exists with the idempotent refId.
    const entries = await world.db.select().from(schema.customerWalletEntries)
      .where(eq(schema.customerWalletEntries.refId, `referral-clawback:${att.event!.id}`));
    assert(entries.length === 1 && entries[0].direction === "debit" && entries[0].amountCents === 25000,
      "clawback debit ledger row (referral-clawback:<eventId>)");

    // Second refund/void → no double clawback.
    const v2 = await refs.voidReferralOnRefund(world.db, { tenantId: T, orderId: order.orderId, actor: "j454" });
    assert(v2.voided === 0, "second void is a no-op");
    const bal2 = await walletBalance(T, REFERRER, world.db);
    assert(bal2 === 0, "no double clawback");

    // Audit row records the clawback outcome.
    const audits = await world.db.select().from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "referral.voided"));
    const row = audits.find((a: any) => a.entityId === att.event!.id);
    assert(row && (row.after as any)?.clawback?.clawedBack === true, "audit row records the clawback");
  },
};
