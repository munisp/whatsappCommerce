// === W47 crosscutting ===
/**
 * J465 — ONB-ABU-2: referral self-dealing + velocity cap.
 *
 *   - WA referrer + TG referee resolving to the SAME phone (via
 *     telegram_identities) is rejected as cross-channel self-referral even
 *     though the customerIds differ;
 *   - distinct phones still attribute fine;
 *   - REFERRAL_MAX_REWARDS_PER_DAY caps per-referrer rewards per rolling 24h
 *     (over-cap events stay attributed, never double-rewarded).
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J465",
  name: "referral cross-channel self-deal + velocity cap",
  feature: "ONB-ABU-2 referral abuse guards",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const referrals = await import("../../server/services/referrals");

    const mkCustomer = async (id: string, phoneOrKey: string) => {
      await world.db.insert(schema.customers).values({
        id, tenantId: TENANT_ID, whatsappPhone: phoneOrKey, name: id,
      });
    };
    const mkCode = async (customerId: string, code: string) => {
      const [row] = await world.db.insert(schema.referralCodes).values({
        tenantId: TENANT_ID, customerId, code,
      }).returning();
      return row;
    };

    // ── Cross-channel self-deal rejected ──────────────────────────────────
    const sharedPhone = "2348017000465";
    await mkCustomer("c465-wa", sharedPhone); // WA identity of the same human
    await mkCustomer("c465-tg", "telegram:465001"); // TG identity of the same human
    await world.db.insert(schema.telegramIdentities).values({
      tenantId: TENANT_ID, chatId: "465001", phoneE164: `+${sharedPhone}`, linkedVia: "share_contact",
    });
    await mkCode("c465-wa", "SELF465");
    const selfDeal = await referrals.attributeReferral(TENANT_ID, {
      code: "SELF465", refereeCustomerId: "c465-tg",
    }, world.db);
    assert(selfDeal.ok === false, "cross-channel self-referral rejected");
    assert((selfDeal as any).error === "self_referral_rejected", `self_referral_rejected (got ${(selfDeal as any).error})`);

    // ── Distinct phones still attribute ───────────────────────────────────
    await mkCustomer("c465-real", "2348017000466");
    const legit = await referrals.attributeReferral(TENANT_ID, {
      code: "SELF465", refereeCustomerId: "c465-real",
    }, world.db);
    assert(legit.ok === true, "distinct-phone referral still attributes");

    // ── Velocity cap: over-cap reward attempts stay attributed ────────────
    process.env.REFERRAL_MAX_REWARDS_PER_DAY = "1";
    // Enable the referral reward program on the sim tenant (default 0 → the
    // "reward_disabled" early-return would precede the velocity check).
    const [tBefore] = await world.db.select({ reward: schema.tenants.referralRewardCents })
      .from(schema.tenants).where(eq(schema.tenants.id, TENANT_ID));
    await world.db.update(schema.tenants).set({ referralRewardCents: 500 })
      .where(eq(schema.tenants.id, TENANT_ID));
    try {
      await mkCustomer("c465-v-ref", "2348017000467");
      const codeRow = await mkCode("c465-v-ref", "VELO465");
      // One reward already landed inside the window.
      await world.db.insert(schema.referralEvents).values({
        tenantId: TENANT_ID, codeId: codeRow.id, refereeCustomerId: "c465-prev",
        status: "rewarded", rewardCents: 500,
      });
      // A paid order whose referee has an attributed event under this code.
      await mkCustomer("c465-v-buyer", "2348017000468");
      const [evt] = await world.db.insert(schema.referralEvents).values({
        tenantId: TENANT_ID, codeId: codeRow.id, refereeCustomerId: "c465-v-buyer",
        status: "attributed", rewardCents: 0,
      }).returning();
      const orderId = `ord-j465-${crypto.randomUUID().slice(0, 8)}`;
      await world.db.insert(schema.orders).values({
        id: orderId, tenantId: TENANT_ID, customerId: "c465-v-buyer",
        orderNumber: `SIM-${orderId}`, status: "confirmed",
        paymentStatus: "completed", totalAmount: "1000.00",
      } as any);
      const res = await referrals.rewardReferralForPaidOrder(world.db, { tenantId: TENANT_ID, orderId });
      assert(res.rewarded === false && res.reason === "velocity_capped", `velocity cap holds (got ${res.reason})`);
      const [after] = await world.db.select().from(schema.referralEvents).where(eq(schema.referralEvents.id, evt.id));
      assert(after.status === "attributed", "capped event stays attributed (no reward leaked)");
      assert(Number(after.rewardCents) === 0, "no reward cents credited");
    } finally {
      delete process.env.REFERRAL_MAX_REWARDS_PER_DAY;
      await world.db.update(schema.tenants).set({ referralRewardCents: tBefore?.reward ?? null })
        .where(eq(schema.tenants.id, TENANT_ID));
    }
  },
};
